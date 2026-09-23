import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, PhoneOff } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { endCall } from "@/lib/call";
import {
  DuplexVoiceController,
  EnergyVad,
  openEchoCancelledMicrophone,
  type DuplexVoiceState,
} from "@/lib/duplex-voice";
import { DuplexTurnBridge } from "@/lib/duplex-turn-bridge";
import { LocalStreamingStt, LocalStreamingTts } from "@/lib/local-speech";
import { HttpVoiceTurnBridge } from "@/lib/voice-turn-bridge";
import { DaniAvatar } from "./Avatar";

/**
 * A full-duplex call that never leaves the machine.
 *
 * Everything the user says is transcribed by the local speech runtime and
 * everything the bot says is synthesized by it, so no audio is sent anywhere.
 * The turn itself still goes through the same message and interrupt routes as
 * typed chat, which is what keeps a spoken conversation and a written one the
 * same conversation.
 *
 * Duplex here is literal: the microphone is never closed, not even while the
 * bot is talking. Speaking over it cancels synthesis and the turn together.
 */
export function LocalDuplexCallView({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const messages = visibleMessages(bot);
  const [state, setState] = useState<DuplexVoiceState>("connecting");
  const [note, setNote] = useState<string | null>(null);
  const controllerRef = useRef<DuplexVoiceController | null>(null);
  const bridgeRef = useRef<DuplexTurnBridge | null>(null);
  const microphoneRef = useRef<MediaStream | null>(null);
  /** Messages that existed before the call, which must not be spoken. */
  const known = useRef(new Set(messages.map((message) => message.id)));
  const busyWas = useRef(Boolean(bot.busy));

  const hangup = useCallback(() => endCall(bot.id), [bot.id]);

  useEffect(() => {
    let cancelled = false;
    const transport = new HttpVoiceTurnBridge(bot.id, bot.threadId);
    const bridge = new DuplexTurnBridge({
      // The call owns no message path of its own. `dispatch` keeps the app's
      // optimistic transcript in step; the bridge's transport is what actually
      // reaches the bot, on the same route typing uses.
      send: (text) => {
        dispatch({ type: "send", botId: bot.id, text, threadId: bot.threadId });
      },
      stop: () => transport.interrupt({ callId: bot.threadId, generation: 0 }),
    });
    const controller = new DuplexVoiceController(
      new LocalStreamingStt(),
      new LocalStreamingTts(),
      new EnergyVad(),
      bridge,
      (next) => {
        if (!cancelled) setState(next);
      },
    );
    bridgeRef.current = bridge;
    controllerRef.current = controller;

    void (async () => {
      try {
        const microphone = await openEchoCancelledMicrophone();
        if (cancelled) {
          for (const track of microphone.getTracks()) track.stop();
          return;
        }
        microphoneRef.current = microphone;
        await controller.start(microphone);
      } catch (error) {
        if (cancelled) return;
        setState("error");
        setNote(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Dani needs permission to use the microphone for a call."
            : error instanceof Error
              ? error.message
              : "The call could not be started.",
        );
      }
    })();

    return () => {
      cancelled = true;
      controllerRef.current = null;
      bridgeRef.current = null;
      void controller.stop();
      const microphone = microphoneRef.current;
      microphoneRef.current = null;
      for (const track of microphone?.getTracks() ?? []) track.stop();
    };
  }, [bot.id, bot.threadId, dispatch]);

  // Feed the reply to the bridge as it streams. The component owns this
  // subscription because only it can see React state; the bridge owns what to
  // do with the text.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const reply = [...messages]
      .reverse()
      .find((message) => message.role === "bot" && message.kind === "text" && !known.current.has(message.id));
    if (reply?.text) bridge.deliver(reply.text);

    // The turn is over when the bot stops working. Anything still held back is
    // spoken now rather than stranded, and the clause iterable ends so the
    // controller returns to listening.
    const busy = Boolean(bot.busy);
    if (busyWas.current && !busy) {
      bridge.finish();
      if (reply) known.current.add(reply.id);
    }
    busyWas.current = busy;
  }, [messages, bot.busy]);

  const caption: Record<DuplexVoiceState, string> = {
    idle: "Ready",
    connecting: "Starting the call…",
    listening: "Listening",
    thinking: "Thinking…",
    speaking: "Speaking",
    reconnecting: "Reconnecting…",
    stopped: "Call ended",
    error: note ?? "Something went wrong",
  };

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-app/95">
      <DaniAvatar color="green" state={state === "speaking" ? "happy" : "idle"} size={96} />
      <div className="flex flex-col items-center gap-1.5">
        <div className="text-[18px] font-semibold text-ink">{bot.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary" aria-live="polite">
          {(state === "connecting" || state === "thinking" || state === "reconnecting") && (
            <Loader2 size={14} className="animate-spin" />
          )}
          {caption[state]}
        </div>
        {state !== "error" && (
          <div className="mt-1 text-[12px] text-ink-secondary/70">
            Speech stays on this computer. Just talk over Dani to interrupt.
          </div>
        )}
      </div>
      <button
        onClick={hangup}
        className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white"
      >
        <PhoneOff size={16} /> End call
      </button>
    </div>
  );
}
