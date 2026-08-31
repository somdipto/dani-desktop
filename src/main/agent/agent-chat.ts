/**
 * Brain adapter — maps brain mode to the correct LLM provider and model.
 *
 * Each brain is an LLM provider accessed via Vercel AI SDK:
 * - opencode: OpenCode free model (opencode.ai/zen/v1)
 * - kilo: Kilo Code gateway (api.kilo.ai/api/gateway)
 * - anthropic: Anthropic direct (api.anthropic.com)
 * - grok: xAI Grok (api.x.ai)
 * - codex: OpenAI GPT-5 (api.openai.com)
 */
import type { OpenDexConfig, BrainMode } from "../config/schema";

/** Default model for each brain mode. */
export const BRAIN_DEFAULTS: Record<BrainMode, { provider: OpenDexConfig["llm"]["provider"]; model: string }> = {
  opencode: { provider: "opencode", model: "anthropic/claude-sonnet-4-6" },
  kilo: { provider: "opencode", model: "anthropic/claude-sonnet-4-6" }, // uses resolveModel's kilo path
  anthropic: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  grok: { provider: "xai", model: "grok-3" },
  codex: { provider: "openai", model: "gpt-5" },
};

/** Get the LLM provider and model for a given brain mode. */
export function brainToProvider(brain: BrainMode): { provider: OpenDexConfig["llm"]["provider"]; model: string } {
  return BRAIN_DEFAULTS[brain];
}

/** Map brain mode to the provider key used by resolveModel. */
export function resolveProvider(brain: BrainMode): OpenDexConfig["llm"]["provider"] {
  switch (brain) {
    case "opencode": return "opencode";
    case "kilo": return "kilo";
    case "anthropic": return "anthropic";
    case "grok": return "xai";
    case "codex": return "openai";
  }
}

/** Default model id for a brain. */
export function defaultModel(brain: BrainMode): string {
  return BRAIN_DEFAULTS[brain].model;
}
