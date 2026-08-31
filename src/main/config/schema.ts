// Shared config types + defaults. Imported by the main process (store) and,
// for types only, by the preload/renderer through the IPC layer.

export type TtsEngine = "elevenlabs" | "system";
export type GreetingMode = "example" | "custom" | "none";
/** How the assistant addresses the user. Drives honorifics ("sir"/"ma'am") and
 *  is "unspecified" by default so we never presume a gender. */
export type UserGender = "male" | "female" | "unspecified";
export type WakeMode = "webspeech" | "manual" | "vosk";
/** Window layout: the full themed experience, or a slim top-pinned bar. */
export type WindowMode = "full" | "notch";
export type SttProvider = "webspeech" | "openai" | "whisper-local" | "vosk-local";
/** How the voice session runs: `pipeline` = wake → STT → LLM → TTS (separate
 *  engines, free/local options); `realtime` = one speech-to-speech model over a
 *  WebSocket (most natural voice, needs a gateway key). */
export type VoiceMode = "pipeline" | "realtime";
/** Which backend hosts the realtime session. `gateway` is the Vercel AI Gateway
 *  (one key, OpenAI + xAI realtime models); `openai` is reserved for a direct
 *  BYOK connection (not implemented yet). */
export type RealtimeProvider = "gateway" | "openai";
/** Which provider routes chat completions. `apple` is free + on-device (macOS);
 *  `openai`/`anthropic`/`xai` are bring-your-own-key; `gateway` is the Vercel AI
 *  Gateway (one key, any provider); `opendex` is our hosted subscription
 *  (reserved — not implemented yet). */
export type LlmProvider = "apple" | "openai" | "anthropic" | "xai" | "gateway" | "opendex" | "ollama" | "opencode";
/** How a provider authenticates: `none` (local), `key` (user-pasted secret),
 *  `account` (a session we manage — reserved for the OpenDex subscription), or
 *  `oauth` (browser/device-code flow, e.g. xAI Grok). */
export type ProviderAuth = "none" | "key" | "account" | "oauth";
export type SecretName =
  | "AI_GATEWAY_API_KEY"
  | "ELEVENLABS_API_KEY"
  | "TAVILY_API_KEY"
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "XAI_API_KEY"
  | "XAI_OAUTH_ACCESS_TOKEN"
  | "OPENCODE_API_KEY";

export interface OpenDexConfig {
  version: 1;
  assistant: {
    /** Spoken persona name, used in the system prompt. */
    name: string;
    /** Word that triggers active listening. */
    wakeWord: string;
    /** How the assistant addresses the user (honorifics). */
    userGender: UserGender;
    /** Custom persona/system prompt. Empty = built-in persona. The fixed
     *  spoken-output rules are always appended regardless. */
    persona: string;
  };
  llm: {
    /** Which provider routes chat completions. */
    provider: LlmProvider;
    /** Model id, interpreted per-provider: slash form for the gateway
     *  ("anthropic/claude-sonnet-4-6"), bare id for direct providers
     *  ("gpt-5"), ignored for apple (single on-device model). */
    model: string;
  };
  tts: {
    engine: TtsEngine;
    elevenLabs: { voiceId: string; modelId: string };
    system: { voiceURI: string | null; rate: number; pitch: number };
  };
  greeting: {
    /** example = bundled demo briefing · custom = user prompt · none = no proactive greeting */
    mode: GreetingMode;
    customPrompt: string;
  };
  voice: {
    /** pipeline = today's wake→STT→LLM→TTS flow · realtime = speech-to-speech session */
    mode: VoiceMode;
  };
  realtime: {
    /** Which backend hosts the realtime session (v1 ships gateway only). */
    provider: RealtimeProvider;
    /** Gateway slash-form model id, e.g. "openai/gpt-realtime-2". */
    model: string;
    /** Provider voice id the model speaks with, e.g. "marin". */
    voice: string;
    /** Seconds of user inactivity before the session disconnects back to
     *  passive wake. Must stay under the gateway's 300s idle kill. */
    idleDisconnectSec: number;
  };
  voiceInput: {
    /** How active listening is triggered. In realtime mode this still gates
     *  when a session connects; `sttProvider` is unused there (the realtime
     *  model transcribes). */
    wakeMode: WakeMode;
    /** Which engine transcribes the captured command (pipeline mode). */
    sttProvider: SttProvider;
    /** transformers.js Whisper model id (local STT). */
    whisperModel: string;
  };
  appearance: {
    /** Voice-visualization theme id (used from the themes phase onward). */
    theme: string;
    /** Show transient banners for each tool the agent calls. */
    showToolActivity: boolean;
  };
  hotkeys: {
    /** Global accelerator that summons / hides the main window (Spotlight-style). */
    summon: string;
    /** Global push-to-talk. */
    talk: string;
    /** Global emergency stop. */
    interrupt: string;
  };
  skills: {
    /** Per-skill enablement; a skill is on unless explicitly false. */
    enabled: Record<string, boolean>;
    /** Standing permission decision per skill: ask each time / always / never. */
    permissions: Record<string, SkillPermission>;
  };
  computer: {
    /** Animate cursor moves (watchable) vs teleport instantly (fastest). */
    animateCursor: boolean;
  };
  analytics: {
    /** Send anonymous usage events (no voice, prompts, keys, URLs, or paths). */
    enabled: boolean;
  };
  onboarding: { completed: boolean };
}

export type SkillPermission = "ask" | "always" | "never";

export interface SecretsPresence {
  AI_GATEWAY_API_KEY: boolean;
  ELEVENLABS_API_KEY: boolean;
  TAVILY_API_KEY: boolean;
  OPENAI_API_KEY: boolean;
  ANTHROPIC_API_KEY: boolean;
  XAI_API_KEY: boolean;
  XAI_OAUTH_ACCESS_TOKEN: boolean;
  OPENCODE_API_KEY: boolean;
}

/** What the renderer receives — config plus which secrets are set (never the values). */
export interface PublicConfig {
  config: OpenDexConfig;
  secrets: SecretsPresence;
  /** Whether OS-level secret encryption is available (false → secrets stored obfuscated only). */
  encryptionAvailable: boolean;
}

export const DEFAULT_CONFIG: OpenDexConfig = {
  version: 1,
  assistant: { name: "Dex", wakeWord: "dex", userGender: "unspecified", persona: "" },
  llm: { provider: "ollama", model: "qwen2.5:32b" },
  tts: {
    engine: "system",
    elevenLabs: { voiceId: "JBFqnCBsd6RMkjVDRZzb", modelId: "eleven_turbo_v2_5" },
    system: { voiceURI: null, rate: 1, pitch: 1 },
  },
  greeting: { mode: "none", customPrompt: "" },
  voice: { mode: "pipeline" },
  realtime: {
    provider: "gateway",
    model: "openai/gpt-realtime-2",
    voice: "marin",
    idleDisconnectSec: 10,
  },
  voiceInput: {
    wakeMode: "manual",
    sttProvider: "whisper-local",
    whisperModel: "Xenova/whisper-base.en",
  },
  appearance: { theme: "editorial", showToolActivity: true },
  hotkeys: {
    summon: "Alt+Space",
    talk: "CommandOrControl+Alt+Space",
    interrupt: "CommandOrControl+Escape",
  },
  skills: {
    enabled: { open: true, computer: false },
    permissions: { open: "ask", computer: "ask" },
  },
  computer: { animateCursor: true },
  analytics: { enabled: true },
  onboarding: { completed: false },
};

export const SECRET_NAMES: SecretName[] = [
  "AI_GATEWAY_API_KEY",
  "ELEVENLABS_API_KEY",
  "TAVILY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "XAI_API_KEY",
  "XAI_OAUTH_ACCESS_TOKEN",
  "OPENCODE_API_KEY",
];

/** Deep-merge a partial patch into a config. Nested objects are merged
 *  recursively so partial updates don't clobber sibling fields. */
export function mergeConfig(
  base: OpenDexConfig,
  patch: DeepPartial<OpenDexConfig>,
): OpenDexConfig {
  function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const out = { ...target };
    for (const key of Object.keys(source)) {
      const val = source[key];
      if (val && typeof val === "object" && !Array.isArray(val)) {
        out[key] = deepMerge(
          (out[key] as Record<string, unknown>) ?? {},
          val as Record<string, unknown>,
        );
      } else if (val !== undefined) {
        out[key] = val;
      }
    }
    return out;
  }
  return deepMerge(
    structuredClone(base) as unknown as Record<string, unknown>,
    patch as unknown as Record<string, unknown>,
  ) as unknown as OpenDexConfig;
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? Partial<T[P]> : T[P];
};
