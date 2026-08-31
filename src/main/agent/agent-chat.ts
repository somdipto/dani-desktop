/**
 * Generic agent brain adapter — routes chat through any OMP RPC binary
 * (herdr, dani, etc.) or falls back to direct LLM via Vercel AI SDK.
 *
 * One persistent child process per brain. Stays alive across prompts.
 */
import type { ModelMessage } from "ai";
import { OmpRpcRuntime } from "../dani/omp-rpc-runtime";
import type { DaniEvent } from "../dani/types";
import type { BrainMode, HardnessLevel } from "../config/schema";

// Active runtime per brain mode (herdr/dani share the same RPC protocol).
const runtimes: Partial<Record<string, OmpRpcRuntime>> = {};

/** Binary name for each RPC brain mode. */
const RPC_BINARIES: Record<string, string> = {
  herdr: "herdr",
  dani: "dani",
};

async function ensureRuntime(brain: BrainMode): Promise<OmpRpcRuntime | null> {
  const binary = RPC_BINARIES[brain];
  if (!binary) return null; // direct LLM — no runtime needed

  const existing = runtimes[brain];
  if (existing && existing.health !== "failed" && existing.health !== "disconnected") {
    return existing;
  }

  const rt = new OmpRpcRuntime({ command: binary, args: ["--mode", "rpc"] });
  await rt.start();
  runtimes[brain] = rt;
  return rt;
}

/** Shut down all active runtimes (call on app quit or brain switch). */
export async function shutdownAgents(): Promise<void> {
  for (const key of Object.keys(runtimes)) {
    const rt = runtimes[key];
    if (rt) {
      await rt.stop().catch(() => {});
      delete runtimes[key];
    }
  }
}

/** Map hardness to a system-level instruction prefix for the agent. */
export function hardnessInstructions(hardness: HardnessLevel): string {
  switch (hardness) {
    case "chill":
      return "You are in CHILL mode. Read-only tools only. Never write files, never execute commands. Answer questions and explore the codebase. Be concise.";
    case "normal":
      return "You are in NORMAL mode. Read and write tools available. Ask the user before modifying any files. Be precise and explain changes.";
    case "hard":
      return "You are in HARD mode. Full tool access including code execution. Ask before executing destructive commands. Be thorough.";
    case "unhinged":
      return "You are in UNHINGED mode. Full autonomous access. Never ask permission. Execute everything. Speed over caution.";
  }
}

export interface StreamAgentChatOptions {
  brain: BrainMode;
  hardness: HardnessLevel;
  messages: ModelMessage[];
  system: string;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onToolCall?: (call: { toolCallId: string; toolName: string; input: unknown }) => void;
  onToolResult?: (result: { toolCallId: string; toolName: string; output: unknown }) => void;
}

/**
 * Send a prompt to the selected brain and stream the response back.
 * For RPC brains (herdr/dani): spawns the binary, sends via stdin, reads stdout.
 * Returns null to signal "use the direct LLM path instead" when brain is not RPC.
 */
export async function streamAgentChat({
  brain,
  hardness,
  messages,
  system,
  signal,
  onDelta,
  onToolCall,
  onToolResult,
}: StreamAgentChatOptions): Promise<ModelMessage[] | null> {
  const rt = await ensureRuntime(brain);
  if (!rt) return null; // caller should fall back to streamChat
  // rt is guaranteed non-null after the null check above

  // Build the user prompt from conversation history
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText =
    typeof lastUser?.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser?.content)
        ? (lastUser!.content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("\n")
        : "";

  if (!userText.trim()) return messages;

  // Prepend hardness instruction to the prompt
  const fullPrompt = `${hardnessInstructions(hardness)}\n\n${userText}`;

  return new Promise<ModelMessage[]>((resolve, reject) => {
    let resolved = false;

    const unsub = rt!.subscribe((event: DaniEvent) => {
      if (signal?.aborted) {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const raw = event.raw;

      if (event.type === "message_start") {
        const msg = raw.message as { role?: string } | undefined;
        if (msg?.role === "assistant") {
          // New assistant message starting
        }
      }

      if (event.type === "message_end") {
        const msg = raw.message as {
          role?: string;
          content?: Array<{ type: string; text?: string }>;
        } | undefined;
        if (msg?.role === "assistant" && !resolved) {
          const text = (msg.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
          if (text) onDelta(text);
          resolved = true;
          cleanup();
          resolve([
            ...messages,
            { role: "assistant", content: text || "(no response)" },
          ]);
        }
      }

      if (event.type === "tool_call" && onToolCall) {
        const tc = raw as { toolCallId?: string; toolName?: string; name?: string; input?: unknown };
        onToolCall({
          toolCallId: tc.toolCallId ?? `agent-${Date.now()}`,
          toolName: tc.toolName ?? tc.name ?? "unknown",
          input: tc.input ?? {},
        });
      }

      if (event.type === "tool_result" && onToolResult) {
        const tr = raw as { toolCallId?: string; toolName?: string; name?: string; output?: unknown };
        onToolResult({
          toolCallId: tr.toolCallId ?? `agent-${Date.now()}`,
          toolName: tr.toolName ?? tr.name ?? "unknown",
          output: tr.output ?? "",
        });
      }
    });

    function cleanup() {
      unsub();
      if (signal) signal.removeEventListener("abort", onAbort);
    }

    function onAbort() {
      cleanup();
      rt!.abort().catch(() => {});
      reject(new DOMException("Aborted", "AbortError"));
    }

    if (signal) signal.addEventListener("abort", onAbort);

    rt!.prompt({ text: fullPrompt }).catch((err) => {
      cleanup();
      reject(err);
    });

    // 60s safety timeout
    const timeout = setTimeout(() => {
      if (!resolved) {
        cleanup();
        rt!.abort().catch(() => {});
        reject(new Error(`Agent ${brain} response timeout (60s)`));
      }
    }, 60_000);

    const origResolve = resolve;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve = ((val: any) => { clearTimeout(timeout); origResolve(val); }) as typeof resolve;
  });
}
