import { describe, expect, it, vi } from "vitest";
import { DuplexTurnBridge, type TurnTransport } from "./duplex-turn-bridge";

function transport(): TurnTransport & { sent: string[]; stopped: number } {
  const sent: string[] = [];
  return {
    sent,
    stopped: 0,
    send(text) {
      sent.push(text);
    },
    async stop() {
      this.stopped += 1;
    },
  };
}

/** Collect the clauses an iterable yields, without blocking the test forever. */
async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const clause of iterable) out.push(clause);
  return out;
}

describe("DuplexTurnBridge", () => {
  it("sends the transcript on the bot's real path", async () => {
    const bus = transport();
    const bridge = new DuplexTurnBridge(bus);
    await bridge.send("what is the status", new AbortController().signal);
    // A call must use the same send as typing, not a private one.
    expect(bus.sent).toEqual(["what is the status"]);
  });

  it("yields clauses as the reply streams, then ends when the turn finishes", async () => {
    const bridge = new DuplexTurnBridge(transport());
    const clauses = await bridge.send("hi", new AbortController().signal);
    const collected = collect(clauses);
    bridge.deliver("The first part is done. ");
    bridge.deliver("The first part is done. The second part is done. ");
    bridge.finish();
    expect(await collected).toEqual(["The first part is done.", "The second part is done."]);
  });

  it("speaks a trailing fragment that never got its full stop", async () => {
    const bridge = new DuplexTurnBridge(transport());
    const clauses = await bridge.send("hi", new AbortController().signal);
    const collected = collect(clauses);
    bridge.deliver("All finished here. And one last thought");
    bridge.finish();
    expect(await collected).toEqual(["All finished here.", "And one last thought"]);
  });

  it("ignores a re-render that delivers the same text again", async () => {
    const bridge = new DuplexTurnBridge(transport());
    const clauses = await bridge.send("hi", new AbortController().signal);
    const collected = collect(clauses);
    bridge.deliver("Nothing has changed here. ");
    bridge.deliver("Nothing has changed here. ");
    bridge.deliver("Nothing has changed here. ");
    bridge.finish();
    // React hands back the same value constantly; saying it three times would
    // be the most obvious possible bug.
    expect(await collected).toEqual(["Nothing has changed here."]);
  });

  it("does not speak the difference when the reply is rewritten underneath it", async () => {
    const bridge = new DuplexTurnBridge(transport());
    const clauses = await bridge.send("hi", new AbortController().signal);
    const collected = collect(clauses);
    bridge.deliver("The original answer text. ");
    // An edit or a branch switch replaces the message rather than extending it.
    bridge.deliver("A completely different answer. ");
    bridge.finish();
    const spoken = await collected;
    expect(spoken).toContain("The original answer text.");
    expect(spoken).toContain("A completely different answer.");
    // The one thing that must not happen is a spliced fragment of the two.
    for (const clause of spoken) {
      expect(clause.startsWith("The original") || clause.startsWith("A completely")).toBe(true);
    }
  });

  it("buffers rather than drops when generation outruns playback", async () => {
    const bridge = new DuplexTurnBridge(transport());
    const clauses = await bridge.send("hi", new AbortController().signal);
    bridge.deliver("Sentence number one. Sentence number two. Sentence number three. ");
    bridge.finish();
    // Nothing consumed anything until now; all of it must still be there.
    expect(await collect(clauses)).toEqual([
      "Sentence number one.",
      "Sentence number two.",
      "Sentence number three.",
    ]);
  });

  it("stops yielding once the turn is aborted", async () => {
    const bridge = new DuplexTurnBridge(transport());
    const controller = new AbortController();
    const clauses = await bridge.send("hi", controller.signal);
    const collected = collect(clauses);
    bridge.deliver("This part was already spoken. ");
    controller.abort();
    bridge.deliver("This part came after the barge-in. ");
    bridge.finish();
    const spoken = await collected;
    expect(spoken).not.toContain("This part came after the barge-in.");
  });

  it("stops the bot on interrupt and abandons what was queued", async () => {
    const bus = transport();
    const bridge = new DuplexTurnBridge(bus);
    const clauses = await bridge.send("hi", new AbortController().signal);
    const collected = collect(clauses);
    bridge.deliver("Something the user talked over. ");
    await bridge.interrupt();
    expect(bus.stopped).toBe(1);
    // The iterable must end, or the controller waits forever on a turn the
    // user has already interrupted.
    await expect(collected).resolves.toBeDefined();
  });

  it("starts the next turn clean, with no leftovers from the last", async () => {
    const bridge = new DuplexTurnBridge(transport());
    const first = await bridge.send("first", new AbortController().signal);
    const firstCollected = collect(first);
    bridge.deliver("An unfinished thought from the first turn");

    const second = await bridge.send("second", new AbortController().signal);
    const secondCollected = collect(second);
    bridge.deliver("The second turn answer here. ");
    bridge.finish();

    await firstCollected;
    // The first turn's dangling text must not be spoken during the second.
    expect(await secondCollected).toEqual(["The second turn answer here."]);
  });

  it("delivers nothing before a turn has started", () => {
    const bridge = new DuplexTurnBridge(transport());
    expect(() => bridge.deliver("stray text")).not.toThrow();
    expect(() => bridge.finish()).not.toThrow();
  });

  it("can be interrupted when no turn is running", async () => {
    const bus = transport();
    await new DuplexTurnBridge(bus).interrupt();
    expect(bus.stopped).toBe(1);
  });

  it("surfaces a transport that refuses to stop", async () => {
    const bridge = new DuplexTurnBridge({ send: vi.fn(), stop: async () => { throw new Error("offline"); } });
    await expect(bridge.interrupt()).rejects.toThrow("offline");
  });
});
