#!/usr/bin/env tsx
/**
 * Smoke test: DANI computer tool via OMP RPC.
 * Sends "take a screenshot" and checks that the computer tool fires.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const DANI_CMD = "/usr/local/bin/dani";
const MODEL = "clawhud/grok-4.5";
const CONFIG = join(import.meta.dirname ?? ".", "..", "dani-computer.yml");

console.log("Config:", CONFIG, "exists:", existsSync(CONFIG));

const child = spawn(DANI_CMD, [
  "--mode", "rpc",
  "--no-session",
  "--allow-home",
  "--model", MODEL,
  "--tools", "computer",
  "--config", CONFIG,
], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env },
});

let buf = "";
const events: string[] = [];
let ready = false;

child.stdout.on("data", (chunk: Buffer) => {
  buf += chunk.toString();
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      events.push(msg.type);
      if (msg.type === "ready") {
        ready = true;
        console.log("[READY] protocolVersion:", msg.protocolVersion);
        // Send a prompt asking for screenshot
        const req = JSON.stringify({
          id: "req_1",
          type: "prompt",
          message: "Take a screenshot of the entire screen using the computer tool and describe what you see.",
        });
        console.log("[SEND] Prompt sent");
        child.stdin.write(req + "\n");
      } else if (msg.type === "tool_call" || msg.type === "tool_use") {
        console.log("[TOOL]", msg.toolName ?? msg.name ?? msg.raw?.toolName ?? "unknown",
          JSON.stringify(msg.input ?? msg.raw?.input ?? {}).slice(0, 200));
      } else if (msg.type === "message_end") {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text") {
              console.log("[RESPONSE]", block.text?.slice(0, 500));
            }
          }
        }
      } else if (msg.type === "error") {
        console.log("[ERROR]", msg.message ?? msg.error ?? JSON.stringify(msg).slice(0, 300));
      } else {
        console.log("[" + msg.type + "]", JSON.stringify(msg).slice(0, 200));
      }
    } catch {
      console.log("[RAW]", line.slice(0, 200));
    }
  }
});

child.stderr.on("data", (chunk: Buffer) => {
  const s = chunk.toString().trim();
  if (s) console.error("[STDERR]", s.slice(0, 200));
});

// Kill after 90s
setTimeout(() => {
  console.log("\n[DONE] Event types:", [...new Set(events)].join(", "));
  child.kill("SIGTERM");
  process.exit(0);
}, 90_000);
