/**
 * DANI brain adapter — routes chat through DANI CLI via OMP RPC.
 *
 * Manages a persistent DANI process across prompts. The runtime stays alive
 * until the app quits or the user switches back to "openai" brain mode.
 */
import type { ModelMessage } from "ai";
import { OmpRpcRuntime } from "../dani/omp-rpc-runtime";
import type { DaniEvent } from "../dani/types";

let runtime: OmpRpcRuntime | null = null;

async function ensureRuntime(): Promise<OmpRpcRuntime> {
  if (runtime && runtime.health !== "failed" && runtime.health !== "disconnected") {
    return runtime;
  }
  runtime = new OmpRpcRuntime();
  await runtime.start();
  return runtime;
}

/** Shut down the DANI runtime (call on app quit or brain switch). */
export async function shutdownDani(): Promise<void> {
  if (runtime) {
    await runtime.stop();
    runtime = null;
  }
}

export interface StreamDaniChatOptions {
  messages: ModelMessage[];
  system: string;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  onToolCall?: (call: { toolCallId: string; toolName: string; input: unknown }) => void;
  onToolResult?: (result: { toolCallId: string; toolName: string; output: unknown }) => void;
}

/**
 * Send a prompt to DANI and stream the response back through the same
 * callbacks as `streamChat`, so the renderer pipeline works unchanged.
 *
 * DANI returns complete messages (not deltas), so we emit the full text
 * as a single delta when message_end arrives. Tool calls are surfaced
 * as they appear in DANI events.
 */
export async function streamDaniChat({
  messages,
  system,
  signal,
  onDelta,
  onToolCall,
  onToolResult,
}: StreamDaniChatOptions): Promise<ModelMessage[]> {
  const rt = await ensureRuntime();

  // Build the user prompt from the conversation history.
  // DANI maintains its own context, so we only send the latest user message.
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

  if (!userText.trim()) {
    return messages;
  }

  return new Promise<ModelMessage[]>((resolve, reject) => {
    let resolved = false;
    let assistantText = "";
    const unsub = rt.subscribe((event: DaniEvent) => {
      if (signal?.aborted) {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const raw = event.raw;

      if (event.type === "message_start") {
        const msg = raw.message as { role?: string } | undefined;
        if (msg?.role === "assistant") {
          assistantText = "";
        }
      }

      if (event.type === "message_end") {
        const msg = raw.message as {
          role?: string;
          content?: Array<{ type: string; text?: string }>;
        } | undefined;
        if (msg?.role === "assistant" && !resolved) {
          // Extract text from content blocks
          const text = (msg.content ?? [])
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
          if (text) {
            onDelta(text);
            assistantText = text;
          }
          resolved = true;
          cleanup();
          resolve([
            ...messages,
            {
              role: "assistant",
              content: text || assistantText,
            },
          ]);
        }
      }

      // Surface tool events if DANI exposes them
      if (event.type === "tool_call" && onToolCall) {
        const tc = raw as {
          toolCallId?: string;
          toolName?: string;
          name?: string;
          input?: unknown;
        };
        onToolCall({
          toolCallId: tc.toolCallId ?? `dani-${Date.now()}`,
          toolName: tc.toolName ?? tc.name ?? "unknown",
          input: tc.input ?? {},
        });
      }

      if (event.type === "tool_result" && onToolResult) {
        const tr = raw as {
          toolCallId?: string;
          toolName?: string;
          name?: string;
          output?: unknown;
        };
        onToolResult({
          toolCallId: tr.toolCallId ?? `dani-${Date.now()}`,
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
      rt.abort().catch(() => {});
      reject(new DOMException("Aborted", "AbortError"));
    }

    if (signal) signal.addEventListener("abort", onAbort);

    // Prepend system prompt as a system message if DANI doesn't already have it
    // DANI handles system prompts internally via its own config, so we just
    // send the user message.
    rt.prompt({ text: userText }).catch((err) => {
      cleanup();
      reject(err);
    });

    // Safety timeout — if DANI doesn't respond in 60s, reject
    const timeout = setTimeout(() => {
      if (!resolved) {
        cleanup();
        rt.abort().catch(() => {});
        reject(new Error("DANI response timeout (60s)"));
      }
    }, 60_000);

    // Clear timeout on resolution
    const origResolve = resolve;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolve = ((val: any) => {
      clearTimeout(timeout);
      origResolve(val);
    }) as typeof resolve;
  });
}
