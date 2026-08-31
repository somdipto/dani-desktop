// Mints the short-lived realtime connection token via the Vercel AI Gateway
// or directly via xAI OAuth. Runs in MAIN only — keys/tokens live in
// process.env or the encrypted store and never reach the renderer.
import { gateway } from "@ai-sdk/gateway";
import { getOAuthTokens } from "../../config/store";
import { isTokenValid, refreshAccessToken } from "../../auth/xai-oauth";

export interface RealtimeToken {
  token: string;
  url: string;
}

/** Get the xAI OAuth access token, refreshing if needed. */
async function getXaiAccessToken(): Promise<string> {
  const tokens = getOAuthTokens("xai");
  if (!tokens?.access_token) {
    throw new Error(
      "No xAI authentication found. Please connect your xAI account in Settings under Language model.",
    );
  }

  // Check if token needs refresh
  if (!isTokenValid(tokens) && tokens.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token);
      const { setOAuthTokens } = await import("../../config/store");
      setOAuthTokens("xai", refreshed);
      return refreshed.access_token;
    } catch {
      throw new Error(
        "xAI authentication expired and refresh failed. Please reconnect in Settings.",
      );
    }
  }

  return tokens.access_token;
}

/** Mint a connection token for one realtime session. Throws a user-facing
 *  reason (spoken by the renderer) when authentication is missing. */
export async function mintRealtimeToken(model: string): Promise<RealtimeToken> {
  // xAI models: need API key (OAuth tokens don't work for voice WebSocket)
  if (model.startsWith("xai/")) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "xAI realtime voice requires an API key (not OAuth). Get one at console.x.ai, then add XAI_API_KEY to your environment.",
      );
    }
    const modelId = model.replace("xai/", "");
    return {
      token: apiKey,
      url: `wss://api.x.ai/v1/realtime?model=${modelId}`,
    };
  }

  // Local offline voice: handled by the pipeline, not WebSocket
  if (model === "local") {
    throw new Error(
      "Offline voice uses the pipeline mode (Whisper STT + local LLM + system TTS). Enable it in Settings → Voice mode → Pipeline.",
    );
  }

  // All other models: use Vercel AI Gateway
  if (!process.env.AI_GATEWAY_API_KEY) {
    throw new Error(
      "I need a Vercel AI Gateway key for realtime voice. Please add one in Settings under Voice mode, or use an xAI model with your xAI account.",
    );
  }
  const { token, url } = await gateway.experimental_realtime.getToken({ model });
  return { token, url };
}
