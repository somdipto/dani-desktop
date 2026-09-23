import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaniKernelRepository } from "./repository.ts";
import { ProactiveTriggerEvaluator } from "./proactive-triggers.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const open = () => { const root = mkdtempSync(join(tmpdir(), "dani-trigger-")); roots.push(root); const repository = new DaniKernelRepository(join(root, "kernel.sqlite")); return { root, repository, evaluator: new ProactiveTriggerEvaluator(repository) }; };
// The scheduling assertions below drive simulated clocks, but the repository
// validates expiry against the real one, so a fixed date here is a time bomb:
// this suite began failing the moment wall-clock time passed it. The horizon
// is relative so a valid proposal stays valid on every future run. The
// deliberately expired case further down keeps its fixed past date, which
// cannot rot.
const VALID_EXPIRY_HORIZON_MS = 24 * 60 * 60 * 1000;
const input = (key = "daily:1") => ({ ownerId: "owner", botId: "bot", threadId: "thread", triggerKey: key, triggerKind: "daily-brief", reason: "Your daily brief is ready", objective: "Review the day", occurredAt: "2026-09-21T22:00:00Z", expiresAt: new Date(Date.now() + VALID_EXPIRY_HORIZON_MS).toISOString(), evidenceReferences: ["calendar:1"] });

describe("serving proactive trigger evaluator", () => {
  it("normalizes schedule, routine and in-app sources with exact provenance", () => {
    const { repository, evaluator } = open(); const at = new Date("2026-09-21T22:01:00Z");
    evaluator.fireSchedule(input("s"), at); evaluator.fireRoutine(input("r"), at); evaluator.fireInAppEvent(input("i"), at);
    expect(new Set(repository.listProactiveProposals("owner").map(item => item.triggerSource))).toEqual(new Set(["schedule", "routine", "in-app-event"]));
    expect(repository.listProactiveProposals("owner").every(item => item.reason === "Your daily brief is ready")).toBe(true); repository.close();
  });

  it("queues through quiet hours and releases once with the original reason after restart", () => {
    const { root, repository, evaluator } = open();
    repository.setProactivePreferences({ ownerId: "owner", botId: "bot", autonomy: "suggest-only", quietHours: { timezone: "UTC", start: "22:00", end: "07:00" }, proposalLimit: 5, proposalWindowMs: 3_600_000 });
    const first = evaluator.fireSchedule(input(), new Date("2026-09-21T23:00:00Z"));
    expect(first).toMatchObject({ state: "queued", duplicate: false, notBefore: "2026-09-22T07:00:00.000Z" }); repository.close();
    const restarted = new DaniKernelRepository(join(root, "kernel.sqlite")); const recovered = new ProactiveTriggerEvaluator(restarted);
    expect(recovered.fireSchedule(input(), new Date("2026-09-21T23:30:00Z"))).toMatchObject({ state: "queued", duplicate: true });
    expect(recovered.releaseDue(new Date("2026-09-22T07:00:00Z"))).toMatchObject([{ state: "proposed" }]);
    expect(recovered.releaseDue(new Date("2026-09-22T08:00:00Z"))).toEqual([]);
    expect(restarted.listProactiveProposals("owner")).toMatchObject([{ reason: "Your daily brief is ready", triggerSource: "schedule" }]); restarted.close();
  });

  it("queues rate-capped triggers until the rolling window opens and releases once", () => {
    const { root, repository, evaluator } = open();
    repository.setProactivePreferences({ ownerId: "owner", botId: "bot", autonomy: "suggest-only", proposalLimit: 1, proposalWindowMs: 3_600_000 });
    const firstAt = new Date("2026-09-21T22:01:00Z");
    expect(evaluator.fireSchedule(input("first"), firstAt)).toMatchObject({ state: "proposed" });
    expect(evaluator.fireSchedule(input("rate-limited"), new Date("2026-09-21T22:02:00Z"))).toMatchObject({
      state: "queued", duplicate: false, notBefore: "2026-09-21T23:01:00.001Z",
    });
    repository.close();
    const restarted = new DaniKernelRepository(join(root, "kernel.sqlite"));
    const recovered = new ProactiveTriggerEvaluator(restarted);
    expect(recovered.releaseDue(new Date("2026-09-21T23:00:59Z"))).toEqual([]);
    expect(recovered.releaseDue(new Date("2026-09-21T23:01:00.001Z"))).toMatchObject([{ state: "proposed" }]);
    expect(recovered.releaseDue(new Date("2026-09-21T23:02:00Z"))).toEqual([]);
    expect(restarted.listProactiveProposals("owner").map(proposal => proposal.triggerKey)).toEqual(["first", "rate-limited"]);
    restarted.close();
  });

  it("fails closed for invalid quiet hours, expiry and autonomy off", () => {
    const { repository, evaluator } = open();
    repository.setProactivePreferences({ ownerId: "owner", botId: "bot", autonomy: "suggest-only", quietHours: { timezone: "Mars/Base", start: "22:00", end: "07:00" }, proposalLimit: 5, proposalWindowMs: 3_600_000 });
    expect(evaluator.fireInAppEvent(input("invalid"), new Date("2026-09-21T22:01:00Z"))).toMatchObject({ state: "suppressed", reason: "invalid-quiet-hours:invalid-timezone" });
    expect(evaluator.fireRoutine({ ...input("expired"), expiresAt: "2026-09-21T22:00:30Z" }, new Date("2026-09-21T22:01:00Z"))).toMatchObject({ state: "suppressed", reason: "expired" });
    repository.setProactivePreferences({ ownerId: "owner", botId: "off", autonomy: "off", proposalLimit: 5, proposalWindowMs: 3_600_000 });
    expect(evaluator.fireSchedule({ ...input("off"), botId: "off" }, new Date("2026-09-21T22:01:00Z"))).toMatchObject({ state: "suppressed", reason: "autonomy-off" }); repository.close();
  });

  it("deduplicates a release crash after proposal persist but before queue receipt", () => {
    const { repository, evaluator } = open(); const value = input("crash");
    repository.createProactiveProposal({ ...value, triggerSource: "schedule", createdAt: "2026-09-22T07:00:00Z" });
    repository.db.prepare(`INSERT INTO kernel_proactive_queue(id,owner_id,bot_id,trigger_key,proposal_json,not_before,state,created_at,updated_at) VALUES('q','owner','bot','crash',?,'2026-09-22T07:00:00Z','queued','2026-09-21T23:00:00Z','2026-09-21T23:00:00Z')`).run(JSON.stringify({ ...value, triggerSource: "schedule" }));
    expect(evaluator.releaseDue(new Date("2026-09-22T07:01:00Z"))).toMatchObject([{ state: "proposed", duplicate: true }]);
    expect(repository.listProactiveProposals("owner")).toHaveLength(1); repository.close();
  });
});
