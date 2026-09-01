/**
 * Maps raw DANI/OMP RPC events to canonical product states.
 *
 * The renderer never sees raw RPC frames. It sees these states:
 *   idle | thinking | working | needs_user | done | error
 */
import type { DaniEvent } from "./types";

export type ProductState =
  | "idle"
  | "thinking"
  | "working"
  | "needs_user"
  | "done"
  | "error";

export type ProductEvent =
  | { state: ProductState; detail?: string }
  | { state: "working"; toolName: string; toolInput?: unknown };

/**
 * Normalize a raw DANI event into a product event.
 * Returns null if the event doesn't change the product state.
 */
export function normalizeEvent(event: DaniEvent): ProductEvent | null {
  switch (event.type) {
    // DANI is starting to process — user input received
    case "agent_start":
    case "turn_start":
      return { state: "thinking" };

    // DANI is generating a message
    case "message_start":
      return { state: "thinking" };

    // DANI finished generating — back to idle
    case "message_end":
      return { state: "done" };

    // DANI turn/agent complete
    case "turn_end":
    case "agent_end":
      return { state: "idle" };

    // Tool execution — DANI is acting on the world
    case "tool_call":
    case "tool_use": {
      const name = String(
        event.raw.toolName ?? event.raw.name ?? event.raw.tool_name ?? "tool",
      );
      return { state: "working", toolName: name, toolInput: event.raw.input };
    }

    // Tool finished — back to thinking (DANI may continue)
    case "tool_result":
    case "tool_output":
      return { state: "thinking" };

    // Permission / approval needed
    case "approval_required":
    case "permission_required":
    case "needs_approval":
      return { state: "needs_user" };

    // Error
    case "error":
      return {
        state: "error",
        detail: String(event.raw.message ?? event.raw.error ?? "Unknown error"),
      };

    default:
      return null;
  }
}
