// Local full-duplex speech: whisper.cpp for hearing, Kokoro for speaking.
//
// Both engines are batch programs. whisper.cpp reads a finished audio file and
// Kokoro returns a finished clip, so neither streams by itself. The upstream
// real-time example works around exactly this by running transcription over a
// window of audio and using voice activity to decide when a window is worth
// transcribing (see whisper.cpp examples/stream, `--step 0` sliding-window
// mode). This is the same technique, moved to where the microphone actually
// is: the renderer captures and decides, the server only runs inference.
//
// That split is what makes the call duplex rather than turn-taking. Capture
// never closes, not even while audio is playing, so speech during playback is
// noticed locally and cancels synthesis and the turn without waiting for any
// round trip. The one thing that must never happen in a voice call is the user
// talking to something that has stopped listening.
import { pcm16FromFloat32 } from "./assemblyai-transcription";
import type { StreamingStt, StreamingTts } from "./duplex-voice";
import { wavFromPcm16, WHISPER_SAMPLE_RATE } from "./wav";

/** Root-mean-square level of one frame, the cheap loudness measure the
 * upstream example's voice activity threshold is also expressed against. */
export function frameLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

export type SegmentEvent = "speech-start" | "speech-end";

export interface SegmenterOptions {
  /** Level above which a frame counts as speech rather than room noise. */
  threshold?: number;
  /** Silence needed to call an utterance finished. */
  silenceMs?: number;
  /** Speech shorter than this is a cough, a door, a keyboard. */
  minSpeechMs?: number;
  /** Hard stop so one long monologue cannot grow the buffer without end. */
  maxUtteranceMs?: number;
}

/**
 * Decides where one utterance ends, from frame levels alone.
 *
 * Separated from audio plumbing on purpose: endpointing is the part with real
 * behaviour to get wrong, and it is worth being able to test it against exact
 * timings instead of against a microphone.
 *
 * The defaults are deliberately not symmetric. Speech is confirmed quickly so a
 * barge-in feels immediate, while silence has to persist before an utterance is
 * declared over, because people pause mid-sentence and cutting them off is far
 * more annoying than waiting an extra fifth of a second.
 */
export class SpeechSegmenter {
  private readonly threshold: number;
  private readonly silenceMs: number;
  private readonly minSpeechMs: number;
  private readonly maxUtteranceMs: number;
  private speaking = false;
  private startedAt = 0;
  private silentSince = 0;

  constructor(options: SegmenterOptions = {}) {
    this.threshold = options.threshold ?? 0.025;
    this.silenceMs = options.silenceMs ?? 650;
    this.minSpeechMs = options.minSpeechMs ?? 150;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 30_000;
  }

  get active(): boolean {
    return this.speaking;
  }

  /** Feed one frame's level and the time it was captured. */
  push(level: number, nowMs: number): SegmentEvent | null {
    const loud = level > this.threshold;
    if (!this.speaking) {
      if (!loud) return null;
      this.speaking = true;
      this.startedAt = nowMs;
      this.silentSince = 0;
      return "speech-start";
    }

    // Whisper's own models are trained on windows of about thirty seconds, and
    // an unbounded buffer is a memory leak with a human cause. Cut the
    // utterance and let the next frame start a new one.
    if (nowMs - this.startedAt >= this.maxUtteranceMs) return this.end();

    if (loud) {
      this.silentSince = 0;
      return null;
    }
    if (this.silentSince === 0) this.silentSince = nowMs;
    if (nowMs - this.silentSince < this.silenceMs) return null;
    // Too short to be speech: drop it silently rather than transcribe a cough.
    if (this.silentSince - this.startedAt < this.minSpeechMs) {
      this.reset();
      return null;
    }
    return this.end();
  }

  private end(): SegmentEvent {
    this.reset();
    return "speech-end";
  }

  private reset(): void {
    this.speaking = false;
    this.startedAt = 0;
    this.silentSince = 0;
  }
}

/** Transcribe one finished utterance. Injected so the adapter can be tested
 * without a server, and so a different local engine can replace it. */
export type TranscribeWav = (wav: ArrayBuffer, signal: AbortSignal) => Promise<string>;

/** POST a recorded utterance to Dani's local whisper endpoint. */
export const transcribeViaServer: TranscribeWav = async (wav, signal) => {
  const response = await fetch("/api/live-call/local/transcribe", {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: wav,
    signal,
  });
  const body = (await response.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!response.ok) throw new Error(body?.error || `Local transcription failed (${response.status})`);
  return (body?.text ?? "").trim();
};

/** Synthesize one clause. Injected for the same reasons as `TranscribeWav`. */
export type SynthesizeText = (text: string, signal: AbortSignal) => Promise<ArrayBuffer>;

/** POST one clause to Dani's local Kokoro endpoint and take back WAV bytes. */
export const synthesizeViaServer: SynthesizeText = async (text, signal) => {
  const response = await fetch("/api/live-call/local/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `Local speech synthesis failed (${response.status})`);
  }
  return await response.arrayBuffer();
};

/** Frames buffered before speech is confirmed, so the first phoneme survives.
 * Voice activity is detected from audio that has already been spoken; without
 * a little history the transcript reliably loses the start of the first word. */
const PREROLL_FRAMES = 8;

/**
 * Microphone to text, one utterance at a time.
 *
 * Reports `final` transcripts only. The controller's own voice activity
 * detector also submits on silence, and it ignores a repeat of what was just
 * submitted, so the two agreeing costs nothing and neither can strand an
 * utterance the other missed.
 */
export class LocalStreamingStt implements StreamingStt {
  private context: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private readonly pending: ArrayBuffer[] = [];
  private readonly preroll: ArrayBuffer[] = [];
  private inFlight: AbortController | null = null;

  constructor(
    private readonly transcribe: TranscribeWav = transcribeViaServer,
    private readonly options: SegmenterOptions = {},
  ) {}

  async start(
    stream: MediaStream,
    onText: (text: string, final: boolean) => void,
    signal: AbortSignal,
  ): Promise<void> {
    await this.stop();
    const context = new AudioContext();
    this.context = context;
    if (context.state === "suspended") await context.resume();
    const segmenter = new SpeechSegmenter(this.options);
    const source = context.createMediaStreamSource(stream);
    // Frame size follows the repository's existing capture path; at 16 kHz it
    // is a quarter second, small enough for responsive endpointing.
    const processor = context.createScriptProcessor(4096, 1, 1);
    this.source = source;
    this.processor = processor;

    processor.onaudioprocess = (event) => {
      if (signal.aborted) return;
      const frame = event.inputBuffer.getChannelData(0);
      const pcm = pcm16FromFloat32(frame, context.sampleRate, WHISPER_SAMPLE_RATE);
      const wasSpeaking = segmenter.active;
      const change = segmenter.push(frameLevel(frame), event.playbackTime * 1000);

      if (change === "speech-start") {
        this.pending.length = 0;
        this.pending.push(...this.preroll, pcm);
        this.preroll.length = 0;
        return;
      }
      if (segmenter.active || (wasSpeaking && change === "speech-end")) this.pending.push(pcm);
      else {
        this.preroll.push(pcm);
        if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      }
      if (change === "speech-end") void this.flush(onText, signal);
    };

    source.connect(processor);
    // A ScriptProcessorNode only runs while it is connected to a destination.
    // Routing it through a muted gain keeps it running without the microphone
    // being played back out of the speakers, which would be an echo loop.
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(context.destination);
  }

  private async flush(onText: (text: string, final: boolean) => void, signal: AbortSignal): Promise<void> {
    const chunks = this.pending.splice(0, this.pending.length);
    if (chunks.length === 0 || signal.aborted) return;
    // One transcription at a time. Whisper is heavy and the server already
    // limits concurrent processes; queueing here keeps utterances in order.
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const stopWithSession = () => controller.abort();
    signal.addEventListener("abort", stopWithSession, { once: true });
    try {
      const text = await this.transcribe(wavFromPcm16(chunks, WHISPER_SAMPLE_RATE), controller.signal);
      if (!controller.signal.aborted && text) onText(text, true);
    } catch {
      // A failed utterance must not end the call. The next one is a fresh
      // attempt, and the caller already sees the state machine's own errors.
    } finally {
      signal.removeEventListener("abort", stopWithSession);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  async stop(): Promise<void> {
    this.inFlight?.abort();
    this.inFlight = null;
    this.pending.length = 0;
    this.preroll.length = 0;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = null;
    }
    this.source?.disconnect();
    this.source = null;
    const context = this.context;
    this.context = null;
    if (context) await context.close().catch(() => {});
  }
}

/**
 * One clause of synthesized speech at a time.
 *
 * `speak` resolves when the clip has finished playing, which is what gives the
 * controller its backpressure: synthesis of the next clause cannot outrun the
 * speaker. `stop` cuts the current clip immediately, because a barge-in that
 * politely waits for the sentence to end is not a barge-in.
 */
export class LocalStreamingTts implements StreamingTts {
  private context: AudioContext | null = null;
  private playing: AudioBufferSourceNode | null = null;
  /** Settles the clip currently being awaited, however it ends. */
  private finishPlaying: (() => void) | null = null;
  /** Abandons the clause in flight, synthesis included. */
  private cancelSpeaking: (() => void) | null = null;

  constructor(private readonly synthesize: SynthesizeText = synthesizeViaServer) {}

  private audio(): AudioContext {
    this.context ??= new AudioContext();
    return this.context;
  }

  async speak(text: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !text.trim()) return;
    // Most of a clause's life is spent waiting for synthesis, not playing:
    // generating a sentence locally takes seconds. A barge-in during that
    // window has nothing playing to cut, so without its own handle `stop`
    // would let the request finish and then speak over the person who
    // interrupted. This aborts the request too, and makes `stop` mean the same
    // thing whenever it is called.
    const own = new AbortController();
    this.cancelSpeaking?.();
    this.cancelSpeaking = () => own.abort();
    const linkCaller = () => own.abort();
    signal.addEventListener("abort", linkCaller, { once: true });
    try {
      await this.speakUntil(text, own.signal);
    } catch (error) {
      // Being interrupted is the feature, not a failure. Synthesis in flight
      // rejects when its request is aborted, and reporting that upwards would
      // put the call into an error state every time someone talked over it.
      if (!own.signal.aborted) throw error;
    } finally {
      signal.removeEventListener("abort", linkCaller);
      if (this.cancelSpeaking && own.signal.aborted === false) this.cancelSpeaking = null;
    }
  }

  private async speakUntil(text: string, signal: AbortSignal): Promise<void> {
    const wav = await this.synthesize(text, signal);
    if (signal.aborted) return;
    const context = this.audio();
    if (context.state === "suspended") await context.resume();
    // decodeAudioData detaches the buffer it is given, so the caller's copy
    // must not be reused afterwards; nothing here does.
    const buffer = await context.decodeAudioData(wav);
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      const finish = () => {
        node.onended = null;
        signal.removeEventListener("abort", cancel);
        if (this.playing === node) this.playing = null;
        if (this.finishPlaying === finish) this.finishPlaying = null;
        resolve();
      };
      const cancel = () => {
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
        finish();
      };
      node.onended = finish;
      signal.addEventListener("abort", cancel, { once: true });
      this.playing = node;
      // Held so `stop` can settle this clip too. Playback also stalls with no
      // `onended` at all when the page is hidden and the audio context is
      // suspended, and a clip that can never resolve would wedge the turn.
      this.finishPlaying = finish;
      node.start();
    });
  }

  stop(): void {
    // Abort first: the clause may still be synthesizing, in which case there
    // is no node yet and this is the only thing that stops it being spoken.
    this.cancelSpeaking?.();
    this.cancelSpeaking = null;
    const node = this.playing;
    const finish = this.finishPlaying;
    this.playing = null;
    this.finishPlaying = null;
    if (!node) return;
    node.onended = null;
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
    // Settle the awaiting `speak` by hand. Clearing `onended` above is what
    // stops the clip reporting its own end, so without this the caller waits
    // on a promise nothing will ever resolve — and the controller awaits every
    // clip, so one barge-in would end the call's ability to speak again.
    finish?.();
  }
}
