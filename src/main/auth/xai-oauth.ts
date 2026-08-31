/**
 * xAI Grok OAuth integration.
 *
 * Two authentication paths:
 * 1. Import existing grok CLI session from ~/.grok/auth.json
 * 2. Fresh Device Code flow (RFC 8628) via auth.x.ai
 *
 * Tokens are stored in OpenDex's encrypted secrets.json via safeStorage.
 */

import { shell } from "electron";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

// ── xAI OAuth endpoints (from OIDC discovery) ──────────────────────────
const AUTH_BASE = "https://auth.x.ai";
const DEVICE_AUTH_URL = `${AUTH_BASE}/oauth2/device/code`;
const TOKEN_URL = `${AUTH_BASE}/oauth2/token`;

// Default scopes for API access (matching grok CLI defaults)
const SCOPES = "openid offline_access api:access";

// Grok CLI client ID (public client, no secret required)
// This is the well-known client ID used by the official grok CLI.
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

// ── Types ──────────────────────────────────────────────────────────────

export interface XaiOAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: string; // ISO timestamp
  email?: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export interface OAuthStatus {
  connected: boolean;
  email?: string;
  expiresAt?: string;
  expired?: boolean;
}

// ── Grok CLI credential import ─────────────────────────────────────────

/**
 * Try to import existing credentials from the grok CLI's auth.json.
 * Returns null if not found or expired beyond refresh.
 */
export function importGrokCredentials(): XaiOAuthTokens | null {
  const authPath = join(homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const raw = readFileSync(authPath, "utf-8");
    const authStore = JSON.parse(raw);

    // auth.json is keyed by "{issuer}::{client_id}"
    for (const [, entry] of Object.entries(authStore)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;

      // Must have a key (access token) and be from auth.x.ai
      const key = e.key as string | undefined;
      if (!key) continue;

      const expiresAt = e.expires_at as string | undefined;
      const refreshToken = e.refresh_token as string | undefined;
      const email = e.email as string | undefined;

      // Check if token is still valid (with 5min buffer)
      if (expiresAt) {
        const expiry = new Date(expiresAt).getTime();
        const now = Date.now();
        const FIVE_MIN = 5 * 60 * 1000;

        if (expiry - now < -FIVE_MIN && !refreshToken) {
          // Token expired and no refresh token — skip
          continue;
        }
      }

      return {
        access_token: key,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        email,
      };
    }
  } catch {
    // Parse error, file not readable, etc.
  }

  return null;
}

// ── Device Code Flow ───────────────────────────────────────────────────

/**
 * Initiate the Device Code flow.
 * Returns the device code response (user_code, verification_uri, etc.)
 * and a poller function that resolves with tokens when auth completes.
 */
export async function startDeviceCodeFlow(): Promise<{
  deviceInfo: DeviceCodeResponse;
  waitForAuth: () => Promise<XaiOAuthTokens>;
}> {
  const body = new URLSearchParams({
    client_id: GROK_CLIENT_ID,
    scope: SCOPES,
  });

  const resp = await fetch(DEVICE_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Device code request failed (${resp.status}): ${text}`);
  }

  const deviceInfo = (await resp.json()) as DeviceCodeResponse;

  // Poll for completion
  const waitForAuth = (): Promise<XaiOAuthTokens> =>
    pollForToken(deviceInfo.device_code, deviceInfo.interval, deviceInfo.expires_in);

  return { deviceInfo, waitForAuth };
}

/**
 * Poll the token endpoint until the user completes auth or the code expires.
 */
async function pollForToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<XaiOAuthTokens> {
  const deadline = Date.now() + expiresIn * 1000;
  // Initial delay per RFC 8628
  await sleep(interval * 1000);

  while (Date.now() < deadline) {
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: GROK_CLIENT_ID,
    });

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const data = (await resp.json()) as Record<string, unknown>;

    if (resp.ok && "access_token" in data) {
      const tokenData = data as unknown as TokenResponse;
      return {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
      };
    }

    // "authorization_pending" = user hasn't completed yet, keep polling
    // "slow_down" = increase interval
    // "expired_token" = code expired, give up
    // "access_denied" = user denied
    const error = data.error as string | undefined;
    if (error === "expired_token") {
      throw new Error("Device code expired — please try again.");
    }
    if (error === "access_denied") {
      throw new Error("Authentication was denied.");
    }

    const sleepMs =
      error === "slow_down" ? (interval + 5) * 1000 : interval * 1000;
    await sleep(sleepMs);
  }

  throw new Error("Device code expired — please try again.");
}

// ── Token Refresh ──────────────────────────────────────────────────────

/**
 * Refresh an expired access token using the refresh_token.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<XaiOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: GROK_CLIENT_ID,
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as TokenResponse;

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

// ── Token Validation ───────────────────────────────────────────────────

/**
 * Check if the stored token is still valid (not expired).
 * Returns true if usable, false if refresh is needed.
 */
export function isTokenValid(tokens: XaiOAuthTokens): boolean {
  if (!tokens.expires_at) return true; // No expiry = treat as valid
  // 5-minute buffer before actual expiry
  return new Date(tokens.expires_at).getTime() > Date.now() + 5 * 60 * 1000;
}

/**
 * Get the current OAuth status for the renderer.
 */
export function getOAuthStatus(tokens: XaiOAuthTokens | null): OAuthStatus {
  if (!tokens?.access_token) {
    return { connected: false };
  }

  return {
    connected: true,
    email: tokens.email,
    expiresAt: tokens.expires_at,
    expired: !isTokenValid(tokens),
  };
}

// ── Open the xAI auth page in browser ──────────────────────────────────

/**
 * Open the xAI login page in the default browser.
 * This is a convenience for the Device Code flow — user goes to
 * verification_uri, enters the code, and approves.
 */
export async function openAuthPage(url: string): Promise<void> {
  await shell.openExternal(url);
}

// ── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
