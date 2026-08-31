/**
 * Brain authentication helpers.
 *
 * Each brain needs an API key (or OAuth token for Grok).
 * These helpers validate keys and provide connection status.
 */
import { getOAuthTokens } from "../config/store";
import { isTokenValid } from "./xai-oauth";

export type BrainAuthStatus = "connected" | "missing_key" | "expired" | "invalid";

/** Check if a brain has valid authentication. */
export function getBrainAuthStatus(
  brain: string,
  secrets: Record<string, boolean>,
): BrainAuthStatus {
  switch (brain) {
    case "opencode":
      // OpenCode free tier — key optional (free model works without key)
      return secrets.OPENCODE_API_KEY ? "connected" : "connected"; // free tier always works
    case "kilo":
      return secrets.KILO_API_KEY ? "connected" : "missing_key";
    case "anthropic":
      return secrets.ANTHROPIC_API_KEY ? "connected" : "missing_key";
    case "grok": {
      const tokens = getOAuthTokens("xai");
      if (tokens?.access_token && isTokenValid(tokens)) return "connected";
      if (tokens?.access_token) return "expired";
      return secrets.XAI_API_KEY ? "connected" : "missing_key";
    }
    case "codex":
      return secrets.OPENAI_API_KEY ? "connected" : "missing_key";
    default:
      return "missing_key";
  }
}

/** Human-readable status label for a brain. */
export function brainStatusLabel(status: BrainAuthStatus): string {
  switch (status) {
    case "connected": return "Connected";
    case "missing_key": return "API key needed";
    case "expired": return "Token expired — reconnect";
    case "invalid": return "Invalid key";
  }
}
