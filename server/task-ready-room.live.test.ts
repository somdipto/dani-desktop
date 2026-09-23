// P-01 (master issue #21, spec 110): room persistence through the real
// task-ready reload path.
//
// This boots the real harness server on a fresh data dir, runs the real
// managed-runtime bootstrap from the staged, hash-pinned Hermes and OpenCode
// payloads, and sends a room message to the seeded starter bot over the live
// OpenCode free route. Nothing in the chain is faked: the event bus, the
// provider registry, the room orchestrator and the Hermes ACP turn are all
// production code. It guards fcc51d1: with a bare registry.load() in the
// task-ready handler, Hermes finishes the turn (ACP end_turn) but the reply is
// never saved and the room stays busy, so this test times out.
//
// Gap, stated plainly: it needs network access and the staged payloads
// (scripts/build-*-payload.sh + scripts/stage-*-payload.sh), so it only runs
// when DANI_LIVE_MANAGED_RUNTIME=1. It is skipped, not faked, otherwise.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const OWNER_TOKEN = `live-owner-capability-${"0".repeat(21)}`;
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const TARGET = `${process.platform === "darwin" ? "mac" : process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const STAGED = join(ROOT, "dist-native", "managed-runtimes");
const staged = ["hermes", "opencode"].every((kind) =>
  existsSync(join(STAGED, "archives", `${kind}-runtime-payload-${TARGET}.tar.gz`))
  && existsSync(join(STAGED, "manifests", `${kind}-${TARGET}.manifest.json`)));
const enabled = process.env.DANI_LIVE_MANAGED_RUNTIME === "1" && staged;

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "x-danibot-desktop-owner": OWNER_TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

describe.skipIf(!enabled)("task-ready reload keeps room replies flowing (live managed runtimes)", () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "dani-task-ready-"));
    const resources = join(home, "resources", "managed-runtimes");
    mkdirSync(resources, { recursive: true });
    symlinkSync(join(STAGED, "archives"), join(resources, "archives"));
    symlinkSync(join(STAGED, "manifests"), join(resources, "manifests"));
    symlinkSync(join(ROOT, "scripts", "opencode-bridge"), join(resources, "opencode-bridge"));
    const staticDir = join(home, "static");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>task-ready</title>");
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(port),
        OMB_WEBHOOK_PORT: String(port + 1),
        OMB_STATIC_DIR: staticDir,
        DANI_OWNER_TOKEN: OWNER_TOKEN,
        DANI_RESOURCES_PATH: join(home, "resources"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
      try { if ((await fetch(`${base}/api/health`)).status === 200) break; } catch { /* starting */ }
      if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 60_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  }, 60_000);

  it("bootstraps, seeds the starter, and saves its room reply with the room released", async () => {
    // A fresh data dir has no activated runtime and no starter bot.
    expect((await api("GET", "/api/runtime/bootstrap")).body.readiness.taskReady).toBe(false);
    expect((await api("GET", "/api/bots?messages=0")).body.bots).toHaveLength(0);

    expect((await api("POST", "/api/runtime/bootstrap", {})).status).toBe(202);
    await expect.poll(async () => (await api("GET", "/api/runtime/bootstrap")).body,
      { timeout: 240_000, interval: 1_000 }).toMatchObject({ state: "ready", readiness: { taskReady: true } });

    // The task-ready handler seeded the starter on the managed route.
    const bots = (await api("GET", "/api/bots?messages=0")).body.bots;
    expect(bots).toHaveLength(1);
    const starter = bots[0];
    expect(starter.modelSelection.instanceId).toBeTruthy();
    expect(starter.modelSelection.model).toBeTruthy();

    const room = (await api("POST", "/api/groups", {
      name: "Task-ready room",
      memberIds: [starter.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: starter.id } },
    })).body.group;
    const sent = await api("POST", `/api/groups/${room.id}/messages`, {
      text: "Reply with one short sentence confirming you can hear this room.",
      sendId: "task_ready_room_0000001",
    });
    expect(sent.status).toBe(202);

    // end_turn -> save reply -> release turn. Before fcc51d1 the reply never
    // arrived and the room stayed working.
    await expect.poll(async () => {
      const state = (await api("GET", "/api/bots?messages=30")).body;
      const current = state.groups.find((g: { id: string }) => g.id === room.id);
      const reply = current?.messages.find((m: { kind: string; role?: string; from?: { id?: string } }) =>
        m.kind === "text" && m.role === "bot");
      const bot = state.bots.find((b: { id: string }) => b.id === starter.id);
      return { replied: Boolean(reply?.text?.trim()), roomWorking: current?.working, botBusy: bot?.busy };
    }, { timeout: 180_000, interval: 1_000 }).toEqual({ replied: true, roomWorking: false, botBusy: false });
  }, 480_000);
});
