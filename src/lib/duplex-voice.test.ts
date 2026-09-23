import { describe, expect, it, vi } from "vitest";
import { DuplexVoiceController, reconnectWithBackoff } from "./duplex-voice";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Poll until `done`, or fail loudly at the deadline rather than assert early. */
const until = async (done: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for the duplex turn to finish");
    await flush();
  }
};

describe("Duplex voice", () => {
  it("streams a turn with playback backpressure", async () => {
    let transcript: (t: string, f: boolean) => void = () => {};
    const order: string[] = [];
    const c = new DuplexVoiceController(
      { start: async (_s, on) => { transcript = on; }, stop: async () => {} },
      { speak: async (text) => { order.push(`start:${text}`); await flush(); order.push(`end:${text}`); }, stop: vi.fn() },
      { start: async () => {}, stop: () => {} },
      { send: async () => ({ async *[Symbol.asyncIterator]() { yield "one"; yield "two"; } }), interrupt: vi.fn(async () => {}) },
    );
    await c.start({} as MediaStream);
    transcript("hi", true);
    // Wait for the turn to finish, not for a fixed number of milliseconds.
    // A flat 10ms sleep failed roughly a third of the time on an idle machine,
    // because the assertion needs two chained macrotasks and 10ms is not a
    // promise that they have run. The ordering it checks was always correct;
    // the budget was the bug, and a test that fails at random teaches people to
    // ignore it — which is the worst thing a voice test can do.
    await until(() => order.length === 4);
    expect(order).toEqual(["start:one", "end:one", "start:two", "end:two"]);
    expect(c.state).toBe("listening");
  });

  it("aborts generation and prevents post-barge playback", async () => {
    let transcript: (t: string, f: boolean) => void = () => {};
    let release!: () => void;
    const interrupt = vi.fn(async () => {});
    const speak = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
    const c = new DuplexVoiceController(
      { start: async (_s, on) => { transcript = on; }, stop: async () => {} },
      { speak, stop: vi.fn(() => release?.()) },
      { start: async () => {}, stop: () => {} },
      { send: async () => ({ async *[Symbol.asyncIterator]() { yield "first"; yield "must not play"; } }), interrupt },
    );
    await c.start({} as MediaStream);
    transcript("hi", true);
    await flush();
    await c.bargeIn();
    await flush();
    expect(interrupt).toHaveBeenCalledOnce();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(c.state).toBe("listening");
  });

  it("deduplicates STT final and VAD silence for the same utterance", async () => {
    let transcript: (t: string, f: boolean) => void = () => {};
    let silence = () => {};
    const send = vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} }));
    const c = new DuplexVoiceController(
      { start: async (_s, on) => { transcript = on; }, stop: async () => {} },
      { speak: async () => {}, stop: () => {} },
      { start: async (_s, _speech, quiet) => { silence = quiet; }, stop: () => {} },
      { send, interrupt: async () => {} },
    );
    await c.start({} as MediaStream);
    transcript("same words", false);
    silence();
    transcript("same words", true);
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reconnects with bounded exponential backoff", async () => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const connect = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const promise = reconnectWithBackoff(connect, signal, { baseMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await promise;
    expect(connect).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
