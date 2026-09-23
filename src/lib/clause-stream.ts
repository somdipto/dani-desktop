// Turning a reply that arrives token by token into clauses worth speaking.
//
// Synthesis is per clip, so nothing can be heard until some text is complete.
// Waiting for the whole reply would make every answer start late by however
// long the model takes to finish, which in a spoken conversation is the
// difference between a call and a voicemail. Waiting for too little is worse:
// synthesizing two or three words at a time makes the voice lurch, because
// each clip carries its own intonation and ends with a small pause.
//
// So text is released at the first boundary a listener would also hear: the
// end of a sentence, or a clause break once enough has accumulated to be worth
// speaking on its own.
//
// The character bounds match the batch splitter the server already uses for
// text-to-speech, so a spoken reply is chunked about the same way whether it
// was streamed or synthesized in one go.

import { clauseBoundary, sentenceBoundary } from "../../shared/speech-boundaries";

const MIN_CHARS = 12;
const MAX_CHARS = 320;

/** Enough of a clause to be worth its own clip once a break appears. */
const CLAUSE_MIN_CHARS = 60;

/**
 * Accumulates streamed text and releases speakable clauses.
 *
 * Deliberately not a generator: the caller pushes whatever arrived, whenever it
 * arrived, and takes back zero or more clauses. Chunk boundaries from the model
 * mean nothing here and are never treated as breaks.
 */
export class ClauseStream {
  private buffer = "";

  /** Add streamed text; returns any clauses that are now complete. */
  push(text: string): string[] {
    if (!text) return [];
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const clause = this.take();
      if (clause === null) break;
      out.push(clause);
    }
    return out;
  }

  /** Release whatever is left, at the end of a turn. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }

  /** Anything held back, without consuming it. */
  get pending(): string {
    return this.buffer.trim();
  }

  /** Index just past the end of the first usable break, or -1. */
  private breakAt(): number {
    // A sentence end is always preferred, and the shared rule is what keeps a
    // decimal, an ellipsis or "Dr." from being mistaken for one. A break that
    // would leave too little to say is skipped rather than taken, which glues
    // a short sentence onto the next exactly as the batch splitter does.
    const sentence = sentenceBoundary();
    for (let match = sentence.exec(this.buffer); match; match = sentence.exec(this.buffer)) {
      const end = match.index + match[1]!.length + (match[2]?.length ?? 0);
      if (this.buffer.slice(0, end).trim().length >= MIN_CHARS) return end;
    }

    // No sentence yet. Once enough has accumulated to be worth its own clip, a
    // comma or semicolon is a good enough place to breathe.
    const clause = clauseBoundary();
    for (let match = clause.exec(this.buffer); match; match = clause.exec(this.buffer)) {
      const end = match.index + match[1]!.length;
      if (this.buffer.slice(0, end).trim().length >= CLAUSE_MIN_CHARS) return end;
    }
    return -1;
  }

  private take(): string | null {
    if (this.buffer.trim().length === 0) return null;

    let end = this.breakAt();
    if (end === -1) {
      // A model that never punctuates must still be audible, so fall back to
      // the last word boundary before the ceiling. Never mid-word.
      if (this.buffer.length < MAX_CHARS) return null;
      const window = this.buffer.slice(0, MAX_CHARS);
      const lastSpace = window.lastIndexOf(" ");
      end = lastSpace > MIN_CHARS ? lastSpace : MAX_CHARS;
    }

    const clause = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end);
    return clause || null;
  }
}
