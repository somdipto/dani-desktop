/**
 * Brain adapter — maps brain mode to the correct LLM provider and model.
 *
 * Each brain is an LLM provider accessed via Vercel AI SDK:
 * - opencode: OpenCode Zen free models (opencode.ai/zen/v1)
 * - kilo: Kilo Code free models (api.kilo.ai/api/gateway)
 * - anthropic: Anthropic direct (api.anthropic.com) — paid
 * - grok: xAI Grok (api.x.ai) — paid
 * - codex: OpenAI GPT-5 (api.openai.com) — paid
 */
import type { OpenDexConfig, BrainMode } from "../config/schema";

/** Available free models per brain. */
export interface FreeModel {
  id: string;
  label: string;
}

/** Free models available on OpenCode Zen. */
export const OPENCODE_FREE_MODELS: FreeModel[] = [
  { id: "opencode/big-pickle", label: "Big Pickle — general coding" },
  { id: "opencode/mimo-v2.5-free", label: "MiMo V2.5 — reasoning" },
  { id: "opencode/minimax-m2.5-free", label: "MiniMax M2.5 — coding, long context" },
  { id: "opencode/nemotron-3-ultra-free", label: "Nemotron 3 Ultra — NVIDIA" },
  { id: "opencode/nemotron-3.5-lightning-free", label: "Nemotron 3.5 Lightning — fast" },
  { id: "opencode/deepseek-v4-flash-free", label: "DeepSeek V4 Flash — reasoning" },
  { id: "opencode/ling-3.0-flash-fin-free", label: "Ling 3.0 Flash — finance" },
  { id: "opencode/muse-spark-1.2-contributor-free", label: "Muse Spark 1.2 — creative" },
];

/** Free models available on Kilo Code. */
export const KILO_FREE_MODELS: FreeModel[] = [
  { id: "kilo-auto/free", label: "Auto-route to best free model" },
  { id: "stepfun/step-3.7-flash:free", label: "StepFun Step 3.7 Flash" },
  { id: "poolside/laguna-s-2.1:free", label: "Poolside Laguna S 2.1" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "NVIDIA Nemotron 3 Ultra" },
  { id: "tencent/hy3:free", label: "Tencent HY3" },
];

/** Default free model for each brain. */
export const BRAIN_DEFAULTS: Record<BrainMode, { provider: OpenDexConfig["llm"]["provider"]; model: string }> = {
  opencode: { provider: "opencode", model: "opencode/deepseek-v4-flash-free" },
  kilo: { provider: "kilo", model: "kilo-auto/free" },
  anthropic: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  grok: { provider: "xai", model: "grok-3" },
  codex: { provider: "openai", model: "gpt-5" },
};

/** Get free models for a brain, or empty array for paid-only brains. */
export function getFreeModels(brain: BrainMode): FreeModel[] {
  switch (brain) {
    case "opencode": return OPENCODE_FREE_MODELS;
    case "kilo": return KILO_FREE_MODELS;
    default: return [];
  }
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
