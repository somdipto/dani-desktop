import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { getOAuthTokens } from "../../config/store";
import { isTokenValid, refreshAccessToken } from "../../auth/xai-oauth";
import type { LanguageModel } from "ai";
import type { OpenDexConfig } from "../../config/schema";

/** Result of probing whether the Apple on-device model can be used right now. */
export interface AppleAvailability {
  available: boolean;
  /** Human-readable reason when unavailable (OS too old, Intelligence off, …). */
  reason?: string;
}

/**
 * Maps the configured provider to a concrete AI SDK model. Returns either a
 * `LanguageModel` instance (direct providers, apple) or a bare model-id string
 * (the gateway path, resolved by the SDK's global Vercel AI Gateway provider).
 *
 * Throws a user-facing error for providers that can't run — the chat handler
 * surfaces the message as a spoken apology.
 */
export async function resolveModel(config: OpenDexConfig): Promise<LanguageModel> {
  const { provider, model } = config.llm;
  switch (provider) {
    case "openai":
      if (!process.env.OPENAI_API_KEY) throw new Error("no OpenAI API key is set");
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(model);
    case "ollama": {
      // Ollama exposes an OpenAI-compatible API at localhost:11434.
      const ollama = createOpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" });
      return ollama(model);
    }
    case "anthropic":
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("no Anthropic API key is set");
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(model);
    case "xai": {
      // Check for OAuth tokens first, fall back to API key
      const oauthTokens = getOAuthTokens("xai");
      let apiKey: string;
      
      if (oauthTokens?.access_token) {
        // Check if token is still valid, refresh if needed
        if (!isTokenValid(oauthTokens) && oauthTokens.refresh_token) {
          try {
            const refreshed = await refreshAccessToken(oauthTokens.refresh_token);
            // Update stored tokens
            const { setOAuthTokens } = await import("../../config/store");
            setOAuthTokens("xai", refreshed);
            apiKey = refreshed.access_token;
          } catch {
            throw new Error("xAI OAuth token expired and refresh failed — please reconnect in Settings");
          }
        } else {
          apiKey = oauthTokens.access_token;
        }
      } else if (process.env.XAI_API_KEY) {
        apiKey = process.env.XAI_API_KEY;
      } else {
        throw new Error("no xAI authentication — connect your xAI account in Settings or set XAI_API_KEY");
      }
      
      return createXai({ apiKey })(model);
    }
    case "apple": {
      // Native (Swift/Rust), macOS-only — dynamic-imported so non-darwin builds
      // never load the binary, and the chunk is only pulled when selected.
      const { appleAI, appleAISDK } = await import("@meridius-labs/apple-on-device-ai");
      const { available, reason } = await appleAISDK.checkAvailability();
      if (!available) throw new Error(reason || "Apple Intelligence is unavailable");
      return appleAI("apple-on-device");
    }
    case "opencode": {
      if (!process.env.OPENCODE_API_KEY) throw new Error("no OpenCode API key is set");
      const opencode = createOpenAI({
        baseURL: "https://opencode.ai/zen/v1",
        apiKey: process.env.OPENCODE_API_KEY,
      });
      return opencode(model);
    }
    case "gateway":
    default:
      // A bare model id routes through the SDK's global AI Gateway provider,
      // which reads AI_GATEWAY_API_KEY from the environment.
      if (!process.env.AI_GATEWAY_API_KEY) throw new Error("no AI Gateway key — set AI_GATEWAY_API_KEY");
      return model;
  }
}

/** Probe Apple on-device availability for the UI (provider picker gate). Never
 *  throws — a missing binary / unsupported platform resolves to unavailable. */
export async function checkAppleAvailability(): Promise<AppleAvailability> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    return { available: false, reason: "Apple Intelligence requires Apple Silicon (M1 or later)" };
  }
  try {
    const { appleAISDK } = await import("@meridius-labs/apple-on-device-ai");
    return await appleAISDK.checkAvailability();
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : "Apple Intelligence is unavailable",
    };
  }
}

/** Probe whether Ollama is running locally and has models loaded. */
export async function checkOllamaAvailability(): Promise<AppleAvailability> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { available: false, reason: `Ollama returned ${res.status}` };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    if (!data.models?.length) return { available: false, reason: "Ollama is running but no models installed. Run: ollama pull llama3.1" };
    return { available: true };
  } catch {
    return { available: false, reason: "Ollama not running. Install: brew install ollama && ollama serve" };
  }
}
