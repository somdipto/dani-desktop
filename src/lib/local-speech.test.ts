import { describe, expect, it, vi } from "vitest";
import {
  frameLevel,
  LocalStreamingTts,
  SpeechSegmenter,
  type SegmentEvent,
} from "./local-speech";

/** Feed a level for `ms` milliseconds in 20ms frames, collecting the events. */
function feed(
  segmenter: SpeechSegmenter,
  clock: { now: number },
  level: number,
  ms: number,
  frameMs = 20,
): SegmentEvent[] {
  const events: SegmentEvent[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += frameMs) {
    clock.now += frameMs;
    const event = segmenter.push(level, clock.now);
    if (event) events.push(event);
  }
  return events;
}

const LOUD = 0.2;
const QUIET = 0.001;

describe("frameLevel", () => {
  it("is zero for silence and rises with amplitude", () => {
    expect(frameLevel(new Float32Array([0, 0, 0, 0]))).toBe(0);
    expect(frameLevel(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(frameLevel(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5, 6);
  });

  it("is zero for an empty frame rather than NaN", () => {
    // A NaN level would compare false against every threshold and silently
    // disable endpointing altogether.
    expect(frameLevel(new Float32Array(0))).toBe(0);
  });
});

describe("SpeechSegmenter", () => {
  it("reports speech starting on the first loud frame", () => {
    const clock = { now: 0 };
    const segmenter = new SpeechSegmenter();
    expect(feed(segmenter, clock, LOUD, 20)).toEqual(["speech-start"]);
    expect(segmenter.active).toBe(true);
  });

  it("ends an utterance only after silence persists", () => {
    const clock = { now: 0 };
    const segmenter = new SpeechSegmenter({ silenceMs: 650 });
    feed(segmenter, clock, LOUD, 1_000);
    // A pause mid-sentence must not end the turn; cutting someone off is worse
    // than waiting.
    expect(feed(segmenter, clock, QUIET, 400)).toEqual([]);
    expect(segmenter.active).toBe(true);
    expect(feed(segmenter, clock, QUIET, 400)).toEqual(["speech-end"]);
    expect(segmenter.active).toBe(false);
  });

  it("treats a pause followed by more speech as one utterance", () => {
    const clock = { now: 0 };
    const segmenter = new SpeechSegmenter({ silenceMs: 650 });
    feed(segmenter, clock, LOUD, 500);
    feed(segmenter, clock, QUIET, 300);
    feed(segmenter, clock, LOUD, 500);
    expect(feed(segmenter, clock, QUIET, 400)).toEqual([]);
    expect(feed(segmenter, clock, QUIET, 400)).toEqual(["speech-end"]);
  });

  it("discards a burst too short to be speech", () => {
    const clock = { now: 0 };
    const segmenter = new SpeechSegmenter({ minSpeechMs: 150, silenceMs: 200 });
    feed(segmenter, clock, LOUD, 60); // a cough, a key press, a door
    const events = feed(segmenter, clock, QUIET, 400);
    // No speech-end, so nothing is sent to be transcribed.
    expect(events).toEqual([]);
    expect(segmenter.active).toBe(false);
  });

  it("can start a fresh utterance after a discarded burst", () => {
    const clock = { now: 0 };
    const segmenter = new SpeechSegmenter({ minSpeechMs: 150, silenceMs: 200 });
    feed(segmenter, clock, LOUD, 60);
    feed(segmenter, clock, QUIET, 400);
    expect(feed(segmenter, clock, LOUD, 20)).toEqual(["speech-start"]);
  });

  it("chops an utterance that never stops, so the buffer cannot grow forever", () => {
    const clock = { now: 0 };
    const segmenter = new SpeechSegmenter({ maxUtteranceMs: 1_000 });
    const events = feed(segmenter, clock, LOUD, 3_000);
    // Someone who talks without pausing still gets transcribed, in bounded
    // pieces, rather than filling memory until the call dies. Each cut is
    // immediately followed by a new segment because they are still speaking.
    expect(events.filter((event) => event === "speech-end").length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toBe("speech-start");
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]).toBe(index % 2 === 1 ? "speech-end" : "speech-start");
    }
  });

  it("honours a raised threshold so a noisy room is not constant speech", () => {
    const clock = { now: 0 };
    const segmenter = new SpeechSegmenter({ threshold: 0.3 });
    expect(feed(segmenter, clock, LOUD, 200)).toEqual([]);
    expect(feed(segmenter, clock, 0.4, 20)).toEqual(["speech-start"]);
  });

  it("handles two utterances in a row independently", () => {
    const clock = { now: 0 };
    const segmenter = new SpeechSegmenter({ silenceMs: 200 });
    feed(segmenter, clock, LOUD, 400);
    expect(feed(segmenter, clock, QUIET, 300)).toEqual(["speech-end"]);
    expect(feed(segmenter, clock, LOUD, 400)).toEqual(["speech-start"]);
    expect(feed(segmenter, clock, QUIET, 300)).toEqual(["speech-end"]);
  });
});

describe("LocalStreamingTts", () => {
  it("says nothing for blank text and never calls the engine", async () => {
    const synthesize = vi.fn();
    const tts = new LocalStreamingTts(synthesize);
    await tts.speak("   ", new AbortController().signal);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("does not synthesize a clause whose turn was already abandoned", async () => {
    const synthesize = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await new LocalStreamingTts(synthesize).speak("hello", controller.signal);
    // Barge-in aborts the turn; work queued behind it must not still be spoken.
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("stops cleanly when nothing is playing", () => {
    expect(() => new LocalStreamingTts(vi.fn()).stop()).not.toThrow();
  });

  it("surfaces a synthesis failure to the caller", async () => {
    const tts = new LocalStreamingTts(async () => {
      throw new Error("Local speech synthesis failed");
    });
    await expect(tts.speak("hello", new AbortController().signal)).rejects.toThrow(/synthesis failed/);
  });
});
