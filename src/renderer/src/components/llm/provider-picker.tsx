import { useEffect, useRef, useState } from "react";
import { Check, Cloud, Cpu, KeyRound, Monitor, Network, Terminal, type LucideIcon } from "lucide-react";
import type {
  DeepPartial,
  LlmProvider,
  OpenDexConfig,
  PublicConfig,
  SecretName,
} from "../../../../main/config/schema";
import {
  LLM_PROVIDERS,
  getProviderMeta,
  type LlmProviderMeta,
} from "../../../../main/config/llm-providers";
import { SecretField, SelectField, TextField } from "../ui/fields";

/** Per-provider glyph — conveys the kind at a glance (on-device / key / cloud). */
const PROVIDER_ICON: Record<LlmProvider, LucideIcon> = {
  dani: Terminal,
  apple: Cpu,
  openai: KeyRound,
  anthropic: KeyRound,
  xai: KeyRound,
  gateway: Network,
  opendex: Cloud,
  ollama: Monitor,
  opencode: Network,
  kilo: Network,
};

const CUSTOM = "__custom__";

/** First curated model for a provider, or "" when it has none (apple/opendex). */
export function defaultModelFor(id: LlmProvider): string {
  return getProviderMeta(id)?.models[0]?.id ?? "";
}

interface AppleState {
  loading: boolean;
  available: boolean;
  reason?: string;
}

/** Whether the configured provider has everything it needs to actually run —
 *  used to gate the onboarding "Continue" button. */
export function isProviderReady(
  data: PublicConfig,
  provider: LlmProvider | null,
  apple: { available: boolean },
  ollama?: { available: boolean },
): boolean {
  if (!provider) return false;
  const meta = getProviderMeta(provider);
  if (!meta || meta.comingSoon) return false;
  if (meta.auth === "none") {
    if (provider === "apple") return apple.available;
    if (provider === "ollama") return ollama?.available ?? false;
    return true;
  }
  if (meta.auth === "account") return false;
  // oauth: always ready to try (tokens are checked at runtime, not in config)
  if (meta.auth === "oauth") return Boolean(data.config.llm.model);
  // key auth: needs the secret present and a model chosen.
  return Boolean(meta.secretName && data.secrets[meta.secretName] && data.config.llm.model);
}

export function useAppleAvailability(): AppleState {
  const [state, setState] = useState<AppleState>({ loading: true, available: false });
  useEffect(() => {
    if (window.opendex.platform !== "darwin" || window.opendex.arch !== "arm64") {
      setState({ loading: false, available: false, reason: "Apple Intelligence requires Apple Silicon (M1 or later)" });
      return;
    }
    let active = true;
    window.opendex
      .appleAvailability()
      .then((r) => active && setState({ loading: false, ...r }))
      .catch(
        () =>
          active &&
          setState({ loading: false, available: false, reason: "Apple Intelligence is unavailable" }),
      );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

export function useOllamaAvailability(): AppleState {
  const [state, setState] = useState<AppleState>({ loading: true, available: false });
  useEffect(() => {
    let active = true;
    window.opendex
      .ollamaAvailability()
      .then((r) => active && setState({ loading: false, ...r }))
      .catch(
        () =>
          active &&
          setState({ loading: false, available: false, reason: "Ollama is not running" }),
      );
    return () => {
      active = false;
    };
  }, []);
  return state;
}

/**
 * The language-model provider chooser, shared by onboarding and Settings. The
 * caller owns which provider is "selected" (so onboarding can start with none
 * chosen — no default). Selecting a provider writes `llm.provider` and resets
 * `llm.model` to that provider's default.
 */
export function ProviderPicker({
  data,
  selected,
  onSelect,
  setConfig,
  setSecret,
  apple,
  ollama,
}: {
  data: PublicConfig;
  selected: LlmProvider | null;
  onSelect: (id: LlmProvider) => void;
  setConfig: (patch: DeepPartial<OpenDexConfig>) => void;
  setSecret: (name: SecretName, value: string) => void;
  apple: AppleState;
  ollama: AppleState;
}) {
  const isMac = window.opendex.platform === "darwin";
  // Hide Apple entirely off-Mac; show it disabled-with-reason on Macs.
  const providers = LLM_PROVIDERS.filter((p) => !(p.id === "apple" && !isMac));
  const meta = selected ? getProviderMeta(selected) : undefined;

  // When the user picks a configurable provider, reveal its model/key section.
  // Only scroll on an actual change (not on mount — so opening Settings, where a
  // provider is already selected, doesn't jump; also StrictMode-safe). `nearest`
  // nudges just the scroll container, never outer ancestors/the sidebar.
  const configRef = useRef<HTMLDivElement>(null);
  const prevSelected = useRef(selected);
  useEffect(() => {
    if (prevSelected.current === selected) return;
    prevSelected.current = selected;
    if (!selected || getProviderMeta(selected)?.comingSoon) return;
    const id = requestAnimationFrame(() =>
      configRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
    );
    return () => cancelAnimationFrame(id);
  }, [selected]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            meta={p}
            selected={selected === p.id}
            apple={apple}
            ollama={ollama}
            onSelect={() => onSelect(p.id)}
          />
        ))}
      </div>
      {meta && !meta.comingSoon && (
        <div ref={configRef} className="scroll-mb-24">
          <ProviderConfig data={data} meta={meta} setConfig={setConfig} setSecret={setSecret} apple={apple} ollama={ollama} />
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  meta,
  selected,
  apple,
  ollama,
  onSelect,
}: {
  meta: LlmProviderMeta;
  selected: boolean;
  apple: AppleState;
  ollama: AppleState;
  onSelect: () => void;
}) {
  const Icon = PROVIDER_ICON[meta.id];
  const appleUnavailable = meta.id === "apple" && !apple.loading && !apple.available;
  const ollamaUnavailable = meta.id === "ollama" && !ollama.loading && !ollama.available;
  const disabled = meta.comingSoon || appleUnavailable || ollamaUnavailable;

  // Short, tag-style chip on the right (the full reason goes in the body, in
  // sentence case, so it never shouts or overflows the chip).
  const chip = meta.comingSoon
    ? "Coming soon"
    : meta.id === "apple"
      ? apple.loading
        ? "Checking…"
        : apple.available
          ? "Free"
          : "Unavailable"
      : meta.id === "ollama"
        ? ollama.loading
          ? "Checking…"
          : ollama.available
            ? "Free"
            : "Unavailable"
        : meta.id === "gateway"
          ? "Advanced"
          : undefined;

  const body = appleUnavailable && apple.reason
    ? apple.reason
    : ollamaUnavailable && ollama.reason
      ? ollama.reason
      : meta.blurb;

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
      className={`group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition ${selected
          ? "border-ring bg-secondary ring-1 ring-ring/40"
          : disabled
            ? "border-input bg-card/40"
            : "border-input bg-card/40 hover:border-ring/60 hover:bg-card/70"
        } ${disabled ? "cursor-not-allowed opacity-55" : ""}`}
    >
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg border transition ${selected
            ? "border-ring/50 bg-background text-foreground"
            : disabled
              ? "border-border bg-background/60 text-muted-foreground"
              : "border-border bg-background/60 text-muted-foreground group-hover:text-foreground/80"
          }`}
      >
        <Icon className="size-4" />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground/90">{meta.label}</span>
          {chip && (
            <span className="shrink-0 rounded-full border border-border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {chip}
            </span>
          )}
        </span>
        <span className="text-xs leading-snug text-muted-foreground">{body}</span>
      </span>

      {selected && (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

function ProviderConfig({
  data,
  meta,
  setConfig,
  setSecret,
  apple,
  ollama,
}: {
  data: PublicConfig;
  meta: LlmProviderMeta;
  setConfig: (patch: DeepPartial<OpenDexConfig>) => void;
  setSecret: (name: SecretName, value: string) => void;
  apple: AppleState;
  ollama: AppleState;
}) {
  const model = data.config.llm.model;
  const knownModel = meta.models.some((m) => m.id === model);
  const [custom, setCustom] = useState(meta.models.length > 0 && !knownModel);
  useEffect(() => {
    setCustom(meta.models.length > 0 && !knownModel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id, knownModel]);

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-3">
      {meta.id === "apple" && (
        <p className="text-xs text-muted-foreground">
          {apple.available
            ? meta.note
            : apple.reason ?? "Apple Intelligence is unavailable on this device."}
        </p>
      )}
      {meta.id === "ollama" && !ollama.available && (
        <p className="text-xs text-muted-foreground">
          {ollama.reason ?? "Ollama is not running."}
        </p>
      )}
      {meta.models.length > 0 && (
        <>
          <SelectField
            label="Model"
            value={custom ? CUSTOM : model}
            options={[
              ...meta.models.map((m) => ({ value: m.id, label: m.label })),
              { value: CUSTOM, label: "Custom\u2026" },
            ]}
            onChange={(v) => {
              if (v === CUSTOM) {
                setCustom(true);
              } else {
                setCustom(false);
                setConfig({ llm: { provider: meta.id, model: v } });
              }
            }}
          />
          {custom && (
            <TextField
              label="Custom model id"
              hint={
                meta.id === "gateway"
                  ? "Provider/model form, e.g. anthropic/claude-sonnet-4-6."
                  : "Exact model id for this provider."
              }
              value={model}
              onChange={(v) => setConfig({ llm: { provider: meta.id, model: v } })}
            />
          )}
        </>
      )}

      {meta.auth === "key" && meta.secretName && (
        <SecretField
          label={`${meta.label} API key`}
          hint={
            meta.keyUrl ? (
              <>
                Required to think and reply.{" "}
                <a href={meta.keyUrl} target="_blank" rel="noreferrer" className="underline hover:text-foreground">
                  Get a key \u2192
                </a>
              </>
            ) : (
              "Required to think and reply."
            )
          }
          present={data.secrets[meta.secretName]}
          onSave={(v) => setSecret(meta.secretName!, v)}
        />
      )}

      {meta.auth === "oauth" && (
        <OAuthConnectButton providerId={meta.id} providerLabel={meta.label} />
      )}
    </div>
  );
}

// ── OAuth Connect Button ───────────────────────────────────────────────

function OAuthConnectButton({ providerId, providerLabel }: { providerId: string; providerLabel: string }) {
  const [status, setStatus] = useState<{ connected: boolean; email?: string; expired?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);

  useEffect(() => {
    window.opendex.xaiOAuthStatus().then(setStatus);
    
    // Listen for OAuth status updates (when auth completes in browser)
    const unsub = window.opendex.onXaiOAuthStatus((newStatus) => {
      setStatus(newStatus);
      setUserCode(null); // Clear code when connected
    });
    return unsub;
  }, []);

  const handleConnect = async () => {
    setLoading(true);
    try {
      const result = await window.opendex.xaiOAuthStart();
      setUserCode(result.userCode);
      setVerificationUri(result.verificationUri);
      // Auto-copy code to clipboard for easy paste
      navigator.clipboard.writeText(result.userCode).catch(() => {});
    } catch (err) {
      console.error("OAuth start failed:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    await window.opendex.xaiOAuthDisconnect();
    setStatus({ connected: false });
    setUserCode(null);
  };

  // Connected state
  if (status?.connected) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 p-3">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <div className="flex-1">
            <div className="text-sm font-medium text-green-700 dark:text-green-400">
              Connected{status.email ? ` as ${status.email}` : ""}
            </div>
            {status.expired && (
              <div className="text-xs text-yellow-600 dark:text-yellow-400">
                Token expired — will refresh on next use
              </div>
            )}
          </div>
          <button 
            onClick={handleDisconnect} 
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Disconnect
          </button>
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          <div className="font-medium">Unlocked with xAI auth:</div>
          <div>✓ LLM — Grok models (reasoning + fast)</div>
          <div>✓ Voice — Realtime speech-to-speech</div>
          <div>✓ STT — Whisper transcription</div>
          <div className="pl-4 text-muted-foreground/70">
            TTS uses system speech or ElevenLabs (configure in Voice settings)
          </div>
        </div>
      </div>
    );
  }

  // Waiting for user to enter code
  if (userCode) {
    const handleCopyCode = () => {
      navigator.clipboard.writeText(userCode);
    };
    return (
      <div className="rounded-lg border border-border bg-muted/50 p-3 space-y-2">
        <div className="text-sm font-medium">Step 2: Enter this code</div>
        <div className="flex items-center gap-2">
          <div className="font-mono text-xl font-bold text-foreground bg-background px-3 py-2 rounded border flex-1 text-center select-all cursor-text">
            {userCode}
          </div>
          <button
            onClick={handleCopyCode}
            className="px-3 py-2 rounded border bg-muted hover:bg-muted/80 text-sm font-medium transition-colors"
            title="Copy code"
          >
            📋
          </button>
        </div>
        <div className="text-xs text-muted-foreground">
          A browser tab opened at{" "}
          <a href={verificationUri || "#"} target="_blank" rel="noreferrer" className="underline">
            {verificationUri}
          </a>
          . Enter the code there to complete sign-in.
        </div>
        <div className="text-xs text-muted-foreground">
          Waiting for authentication... (this updates automatically)
        </div>
      </div>
    );
  }

  // Not connected — show connect button
  return (
    <div className="space-y-2">
      <button
        onClick={handleConnect}
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
      >
        {loading ? (
          <>
            <span className="animate-spin">⏳</span> Starting authentication...
          </>
        ) : (
          <>
            🔐 Connect {providerLabel} Account
          </>
        )}
      </button>
      <div className="text-xs text-muted-foreground text-center">
        Sign in with your {providerLabel} subscription to unlock:
        <span className="font-medium"> LLM + Voice + STT</span>
      </div>
      <div className="text-xs text-muted-foreground/70 text-center">
        Or use <span className="font-medium">Ollama</span> for free local LLM + STT
      </div>
    </div>
  );
}
