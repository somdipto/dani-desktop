import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
// Electron is only available inside the Electron runtime.
// Outside it (e.g. smoke tests), app/safeStorage are undefined — guarded by lazy paths.
let app: any; let safeStorage: any;
try { ({ app, safeStorage } = require("electron")); } catch {}
import type { XaiOAuthTokens } from "../auth/xai-oauth";

import {
  DEFAULT_CONFIG,
  SECRET_NAMES,
  mergeConfig,
  type DeepPartial,
  type OpenDexConfig,
  type PublicConfig,
  type SecretName,
  type SecretsPresence,
} from "./schema";

// Hand-rolled config store (no external dep). Non-secret prefs live in
// config.json; secrets live in secrets.json encrypted with the OS keychain via
// safeStorage. Secret *values* are never exposed to the renderer — only their
// presence — and are pushed into process.env so the agent/TTS code reads them
// exactly as before.

let configPath = "";
let secretsPath = "";
let cachedConfig: OpenDexConfig | null = null;
let cachedSecrets: Record<string, string> = {};

function ensurePaths() {
  if (configPath) return;
  const dir = app.getPath("userData");
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, "config.json");
  secretsPath = join(dir, "secrets.json");
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function loadConfigFile(): OpenDexConfig {
  ensurePaths();
  if (!existsSync(configPath)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as DeepPartial<OpenDexConfig>;
    // Merge over defaults so new fields added in later versions are filled in.
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch (err) {
    console.error("[opendex config] failed to read config.json, using defaults", err);
    return structuredClone(DEFAULT_CONFIG);
  }
}

function loadSecretsFile(): Record<string, string> {
  ensurePaths();
  if (!existsSync(secretsPath)) return {};
  try {
    const stored = JSON.parse(readFileSync(secretsPath, "utf8")) as {
      enc: boolean;
      values: Record<string, string>;
    };
    const out: Record<string, string> = {};
    for (const [name, blob] of Object.entries(stored.values)) {
      if (stored.enc && encryptionAvailable()) {
        try {
          out[name] = safeStorage.decryptString(Buffer.from(blob, "base64"));
        } catch (err) {
          console.error(`[opendex config] failed to decrypt ${name}`, err);
        }
      } else {
        // Stored obfuscated-only (no keychain): base64 round-trip.
        out[name] = Buffer.from(blob, "base64").toString("utf8");
      }
    }
    return out;
  } catch (err) {
    console.error("[opendex config] failed to read secrets.json", err);
    return {};
  }
}

function persistSecrets() {
  ensurePaths();
  const enc = encryptionAvailable();
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(cachedSecrets)) {
    if (!value) continue;
    if (enc) {
      values[name] = safeStorage.encryptString(value).toString("base64");
    } else {
      values[name] = Buffer.from(value, "utf8").toString("base64");
    }
  }
  try {
    writeFileSync(secretsPath, JSON.stringify({ enc, values }, null, 2), "utf8");
  } catch (err) {
    console.error("[opendex config] failed to write secrets.json", err);
  }
}

function persistConfig() {
  ensurePaths();
  try {
    writeFileSync(configPath, JSON.stringify(cachedConfig, null, 2), "utf8");
  } catch (err) {
    console.error("[opendex config] failed to write config.json", err);
  }
}

/** Push config-derived values into process.env so agent/TTS read them as before.
 *  Existing env (from a dev .env) is kept as a fallback when a secret is unset. */
function applyToEnv() {
  if (!cachedConfig) return;
  process.env.OPENDEX_MODEL = cachedConfig.llm.model;
  process.env.ELEVENLABS_VOICE_ID = cachedConfig.tts.elevenLabs.voiceId;
  process.env.ELEVENLABS_MODEL_ID = cachedConfig.tts.elevenLabs.modelId;
  for (const name of SECRET_NAMES) {
    const value = cachedSecrets[name];
    if (value) process.env[name] = value;
  }
}

export function initConfig() {
  cachedConfig = loadConfigFile();
  cachedSecrets = loadSecretsFile();
  applyToEnv();
}

export function getConfig(): OpenDexConfig {
  if (!cachedConfig) initConfig();
  return cachedConfig!;
}

function hasSecret(name: SecretName): boolean {
  return Boolean(cachedSecrets[name] || process.env[name]);
}

function secretsPresence(): SecretsPresence {
  return {
    AI_GATEWAY_API_KEY: hasSecret("AI_GATEWAY_API_KEY"),
    ELEVENLABS_API_KEY: hasSecret("ELEVENLABS_API_KEY"),
    TAVILY_API_KEY: hasSecret("TAVILY_API_KEY"),
    OPENAI_API_KEY: hasSecret("OPENAI_API_KEY"),
    ANTHROPIC_API_KEY: hasSecret("ANTHROPIC_API_KEY"),
    XAI_API_KEY: hasSecret("XAI_API_KEY"),
    XAI_OAUTH_ACCESS_TOKEN: hasSecret("XAI_OAUTH_ACCESS_TOKEN"),
    OPENCODE_API_KEY: hasSecret("OPENCODE_API_KEY"),
    KILO_API_KEY: hasSecret("KILO_API_KEY"),
  };
}

export function getPublicConfig(): PublicConfig {
  return {
    config: getConfig(),
    secrets: secretsPresence(),
    encryptionAvailable: encryptionAvailable(),
  };
}

export function updateConfig(patch: DeepPartial<OpenDexConfig>): PublicConfig {
  cachedConfig = mergeConfig(getConfig(), patch);
  persistConfig();
  applyToEnv();
  return getPublicConfig();
}

export function setSecret(name: SecretName, value: string): PublicConfig {
  if (value.trim()) {
    cachedSecrets[name] = value.trim();
  } else {
    delete cachedSecrets[name];
    delete process.env[name];
  }
  persistSecrets();
  applyToEnv();
  return getPublicConfig();
}

export function completeOnboarding(): PublicConfig {
  return updateConfig({ onboarding: { completed: true } });
}

/** Factory reset: delete persisted prefs + secrets and fall back to defaults.
 *  Since onboarding.completed reverts to its default (false), the app re-runs
 *  onboarding. Secrets still present in a dev .env remain as a fallback (they're
 *  only cleared from the encrypted store, not from process.env). */
export function resetConfig(): PublicConfig {
  ensurePaths();
  for (const path of [configPath, secretsPath]) {
    try {
      if (existsSync(path)) rmSync(path);
    } catch (err) {
      console.error(`[opendex config] failed to delete ${path}`, err);
    }
  }
  cachedSecrets = {};
  cachedConfig = structuredClone(DEFAULT_CONFIG);
  // Clear secrets from process.env so they don't survive a factory reset
  for (const name of SECRET_NAMES) {
    delete process.env[name];
  }
  applyToEnv();
  return getPublicConfig();
}

// ── OAuth token storage ────────────────────────────────────────────────
// OAuth tokens are stored in a separate JSON file, encrypted via safeStorage.


let oauthTokensPath: string | null = null;
function getOAuthTokensPath(): string {
  if (!oauthTokensPath && app) oauthTokensPath = join(app.getPath("userData"), "oauth-tokens.json");
  if (!oauthTokensPath) oauthTokensPath = join(homedir(), ".opendex", "oauth-tokens.json");
  return oauthTokensPath;
}
let cachedOAuthTokens: Record<string, XaiOAuthTokens> = {};

function loadOAuthTokens(): void {
  try {
    if (existsSync(getOAuthTokensPath())) {
      const raw = readFileSync(getOAuthTokensPath(), "utf-8");
      cachedOAuthTokens = JSON.parse(raw);
    }
  } catch {
    cachedOAuthTokens = {};
  }
  
  // Auto-import from grok CLI if we don't have xAI tokens yet
  if (!cachedOAuthTokens.xai) {
    try {
      const authPath = join(homedir(), ".grok", "auth.json");
      if (existsSync(authPath)) {
        const raw = readFileSync(authPath, "utf-8");
        const authStore = JSON.parse(raw);
        for (const [, entry] of Object.entries(authStore)) {
          if (!entry || typeof entry !== "object") continue;
          const e = entry as Record<string, unknown>;
          const key = e.key as string | undefined;
          if (!key) continue;
          const expiresAt = e.expires_at as string | undefined;
          const refreshToken = e.refresh_token as string | undefined;
          const email = e.email as string | undefined;
          cachedOAuthTokens.xai = {
            access_token: key,
            refresh_token: refreshToken,
            expires_at: expiresAt,
            email,
          };
          persistOAuthTokens();
          break;
        }
      }
    } catch {
      // Ignore import errors
    }
  }
}

function persistOAuthTokens(): void {
  try {
    mkdirSync(dirname(getOAuthTokensPath()), { recursive: true });
    writeFileSync(getOAuthTokensPath(), JSON.stringify(cachedOAuthTokens, null, 2));
  } catch (err) {
    console.error(`[opendex config] failed to persist OAuth tokens`, err);
  }
}

export function getOAuthTokens(provider: string): XaiOAuthTokens | null {
  if (!Object.keys(cachedOAuthTokens).length) loadOAuthTokens();
  return cachedOAuthTokens[provider] ?? null;
}

export function setOAuthTokens(provider: string, tokens: XaiOAuthTokens): void {
  cachedOAuthTokens[provider] = tokens;
  persistOAuthTokens();
}

export function clearOAuthTokens(provider: string): void {
  delete cachedOAuthTokens[provider];
  persistOAuthTokens();
}
