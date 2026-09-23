import { describe, expect, it } from "vitest";
import { ClauseStream } from "./clause-stream";

/** Push text one character at a time, the worst case a model can produce. */
function drip(stream: ClauseStream, text: string): string[] {
  const out: string[] = [];
  for (const character of text) out.push(...stream.push(character));
  return out;
}

describe("ClauseStream", () => {
  it("releases a sentence as soon as it is complete", () => {
    const stream = new ClauseStream();
    expect(stream.push("Sure, I can help with that. ")).toEqual(["Sure, I can help with that."]);
  });

  it("holds an unfinished sentence back", () => {
    const stream = new ClauseStream();
    expect(stream.push("Sure, I can help")).toEqual([]);
    expect(stream.pending).toBe("Sure, I can help");
  });

  it("gives the same clauses however the text was chunked", () => {
    const text = "First point here. Second point here. Third point here. ";
    const whole = new ClauseStream().push(text);
    const perCharacter = drip(new ClauseStream(), text);
    // Chunk boundaries from the model are meaningless and must never be heard.
    expect(perCharacter).toEqual(whole);
    expect(whole).toEqual(["First point here.", "Second point here.", "Third point here."]);
  });

  it("does not split a decimal, an abbreviation or an ellipsis", () => {
    const stream = new ClauseStream();
    const text = "The total came to 3.5 million in Q4 for Dr. Smith... ";
    // None of "3.5", "Dr." or the ellipsis ends a sentence, so nothing may be
    // released early. Splitting there would speak "three point" as its own
    // clip and leave "five million" stranded in the next one.
    expect(stream.push(text)).toEqual([]);
    expect(stream.flush()).toEqual([text.trim()]);
  });

  it("releases the sentence once a real one follows the abbreviation", () => {
    const stream = new ClauseStream();
    expect(stream.push("We met with Dr. Smith about the report. Then we left. ")).toEqual([
      "We met with Dr. Smith about the report.",
      "Then we left.",
    ]);
  });

  it("keeps a closing quote or bracket with the sentence it belongs to", () => {
    const stream = new ClauseStream();
    expect(stream.push('She said "this is the one." ')).toEqual(['She said "this is the one."']);
  });

  it("does not break on a clause mark while the clause is still short", () => {
    const stream = new ClauseStream();
    // "Well, " is not worth its own clip: it would be spoken as a lurch.
    expect(stream.push("Well, it depends on ")).toEqual([]);
  });

  it("breaks on a clause mark once there is enough to speak", () => {
    const stream = new ClauseStream();
    const long = "There are quite a few different ways that we could approach this particular problem, ";
    expect(long.trim().length).toBeGreaterThanOrEqual(60);
    expect(stream.push(long)).toEqual([long.trim()]);
  });

  it("stays audible when a model never punctuates at all", () => {
    const stream = new ClauseStream();
    const rambling = "word ".repeat(120); // 600 characters, no punctuation
    const clauses = stream.push(rambling);
    expect(clauses.length).toBeGreaterThan(0);
    for (const clause of clauses) expect(clause.length).toBeLessThanOrEqual(320);
    // Broken at a word boundary, not through the middle of a word.
    for (const clause of clauses) expect(clause.endsWith("word")).toBe(true);
  });

  it("loses no text across a whole reply", () => {
    const text =
      "Here is the first thing. Here is the second thing, which runs on a little longer than the first one did. " +
      "And finally a third.";
    const stream = new ClauseStream();
    const spoken = [...drip(stream, text), ...stream.flush()];
    expect(spoken.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("flushes a trailing fragment so the last words are still spoken", () => {
    const stream = new ClauseStream();
    stream.push("That is all finished now. And one more thing");
    expect(stream.flush()).toEqual(["And one more thing"]);
  });

  it("flushes nothing when everything has already been spoken", () => {
    const stream = new ClauseStream();
    stream.push("That is all finished now. ");
    expect(stream.flush()).toEqual([]);
  });

  it("ignores empty pushes and whitespace-only replies", () => {
    const stream = new ClauseStream();
    expect(stream.push("")).toEqual([]);
    expect(stream.push("   \n  ")).toEqual([]);
    expect(stream.flush()).toEqual([]);
  });

  it("can be reused for the next turn after a flush", () => {
    const stream = new ClauseStream();
    stream.push("First turn text");
    expect(stream.flush()).toEqual(["First turn text"]);
    expect(stream.push("Second turn text here. ")).toEqual(["Second turn text here."]);
  });
});
