// Bridging one voice turn onto the app's real message path.
//
// A call must not invent its own way of talking to a bot. The same send, the
// same thread, the same durable turn as typing into the composer, or a spoken
// conversation would quietly diverge from the written one: different history,
// different approvals, different evidence.
//
// The reply arrives as React state that grows as tokens stream in, while the
// duplex controller wants an async iterable of clauses it can await one at a
// time. This is the adapter between the two, and it is deliberately the only
// part of the call that knows that. The component owns the subscription and
// feeds text in; this owns turning that into speech-shaped pieces.
import { ClauseStream } from "./clause-stream";
import type { DuplexTurn } from "./duplex-voice";

export interface TurnTransport {
  /** Send the transcript on the bot's real thread, exactly as typing would. */
  send(text: string): void;
  /** Stop the bot mid-answer, for a barge-in. */
  stop(): Promise<void>;
}

/**
 * One turn's worth of streamed clauses.
 *
 * Buffers rather than drops. The controller awaits playback of each clause, so
 * generation will usually outrun the speaker; anything not yet spoken has to
 * wait its turn rather than be skipped, or the reply develops holes.
 */
class ClauseQueue {
  private readonly queue: string[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  push(clauses: readonly string[]): void {
    if (this.closed || clauses.length === 0) return;
    this.queue.push(...clauses);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }

  async *drain(signal: AbortSignal): AsyncGenerator<string> {
    const abort = () => this.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        if (signal.aborted) return;
        const next = this.queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (this.closed) return;
        await new Promise<void>((resolve) => {
          this.waiting = resolve;
        });
      }
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

export class DuplexTurnBridge implements DuplexTurn {
  private clauses = new ClauseStream();
  private queue: ClauseQueue | null = null;
  /** Reply text already turned into clauses, to compute what is new. */
  private consumed = "";

  constructor(private readonly transport: TurnTransport) {}

  async send(text: string, signal: AbortSignal): Promise<AsyncIterable<string>> {
    this.reset();
    const queue = new ClauseQueue();
    this.queue = queue;
    this.transport.send(text);
    return queue.drain(signal);
  }

  /**
   * Feed the reply as it stands now.
   *
   * Takes the whole text rather than a delta because that is what a React
   * subscription actually has, and because a re-render can legitimately hand
   * back the same text twice. Only what is genuinely new is spoken.
   */
  deliver(replyText: string): void {
    if (!this.queue) return;
    // A reply that no longer extends what was already spoken has been rewritten
    // underneath us, by an edit or a branch switch. Speaking the difference
    // would be nonsense, so start again from what is now there and keep only
    // the part that has not been heard.
    if (!replyText.startsWith(this.consumed)) {
      this.consumed = "";
      this.clauses = new ClauseStream();
    }
    const fresh = replyText.slice(this.consumed.length);
    if (!fresh) return;
    this.consumed = replyText;
    this.queue.push(this.clauses.push(fresh));
  }

  /** No more text is coming: speak the tail and end the iterable. */
  finish(): void {
    if (!this.queue) return;
    this.queue.push(this.clauses.flush());
    this.queue.close();
    this.queue = null;
  }

  async interrupt(): Promise<void> {
    // Close first. The controller has already stopped playback, and anything
    // still queued belongs to an answer the user has talked over.
    this.queue?.close();
    this.queue = null;
    await this.transport.stop();
  }

  private reset(): void {
    this.queue?.close();
    this.queue = null;
    this.clauses = new ClauseStream();
    this.consumed = "";
  }
}
