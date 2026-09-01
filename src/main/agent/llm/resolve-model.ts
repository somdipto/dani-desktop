/** Result of probing whether the Apple on-device model can be used right now. */
export interface AppleAvailability {
  available: boolean;
  /** Human-readable reason when unavailable (OS too old, Intelligence off, …). */
  reason?: string;
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
