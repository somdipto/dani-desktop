import type { DaniEvent } from "./types";

export function normalizeRpcFrame(frame: Record<string, unknown>): DaniEvent | null {
  const type = frame.type;
  if (typeof type !== "string") return null;
  if (type === "response" || type === "ready") return null;
  return { type, raw: frame };
}
