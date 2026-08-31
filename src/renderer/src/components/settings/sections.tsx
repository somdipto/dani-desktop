import { useState, useRef, useEffect, type ComponentType } from "react";
import {
  User,
  Mic,
  Palette,
  Blocks,
  Cpu,
  AudioLines,
  AudioWaveform,
  MessageSquare,
  ShieldCheck,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import type { PublicConfig } from "../../../../main/config/schema";
import { acceleratorFromKeyEvent } from "../../../../main/hotkeys";
import type {
  DeepPartial,
  OpenDexConfig,
  SecretName,
} from "../../../../main/config/schema";
import {
  SecretField,
  SegmentedControl,
  SelectField,
  TextArea,
  TextField,
} from "../ui/fields";
import { useSystemVoices } from "@/lib/use-system-voices";
import {
  REALTIME_MODELS,
  getRealtimeModelMeta,
} from "../../../../main/config/realtime-models";
import { ThemePicker } from "@/components/themes/theme-picker";
import { SKILL_METAS } from "@skills/metas";
import {
  ProviderPicker,
  defaultModelFor,
  useAppleAvailability,
  useOllamaAvailability,
} from "@/components/llm/provider-picker";

export interface SectionProps {
  data: PublicConfig;
  setConfig: (patch: DeepPartial<OpenDexConfig>) => void;
  setSecret: (name: SecretName, value: string) => void;
  resetConfig: () => Promise<void>;
}

// A labelled control with an inline toggle/segmented control on the right.
function ToggleRow({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium text-foreground/90">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      {children}
    </div>
  );
}

function AssistantSection({ data, setConfig }: SectionProps) {
  const { config } = data;
  return (
    <>
      <TextField
        label="Name"
        hint="How the assistant refers to itself."
        value={config.assistant.name}
        onChange={(v) => setConfig({ assistant: { name: v } })}
      />
      <SelectField
        label="How it should address you"
        hint="Controls honorifics. Choose neutral to avoid “sir” / “ma’am” entirely."
        value={config.assistant.userGender}
        options={[
          { value: "unspecified", label: "Neutral — no honorific" },
          { value: "male", label: "“Sir”" },
          { value: "female", label: "“Ma’am”" },
        ]}
        onChange={(v) => setConfig({ assistant: { userGender: v } })}
      />
      <TextField
        label="Wake word"
        hint="Used by the Web Speech wake mode."
        value={config.assistant.wakeWord}
        onChange={(v) => setConfig({ assistant: { wakeWord: v } })}
      />
      <TextArea
        label="Personality (custom system prompt)"
        hint="Replaces the built-in persona. The spoken-output rules (short replies, no markdown, etc.) and your address preference are always kept. Leave blank for the default."
        value={config.assistant.persona}
        placeholder="e.g. You are Dex, a warm, concise, no-nonsense assistant who keeps things casual and gets to the point."
        onChange={(v) => setConfig({ assistant: { persona: v } })}
      />
    </>
  );
}

function VoiceModeSection({ data, setConfig, setSecret }: SectionProps) {
  const { config, secrets } = data;
  const modelMeta = getRealtimeModelMeta(config.realtime.model);
  return (
    <>
      <SegmentedControl
        value={config.voice.mode}
        options={[
          { value: "pipeline", label: "Pipeline" },
          { value: "realtime", label: "Realtime voice" },
        ]}
        onChange={(v) => setConfig({ voice: { mode: v } })}
      />
      <div className="text-xs text-muted-foreground">
        {config.voice.mode === "pipeline"
          ? "Separate wake word, transcription, language model, and voice — with free, offline options for each."
          : "One speech-to-speech model handles listening, thinking, and speaking. Most natural voice and fastest turns; needs a Vercel AI Gateway key. Sessions are capped at twenty-five minutes and reconnect on the wake word. Screen control still runs through your language model."}
      </div>
      {config.voice.mode === "realtime" && (
        <>
          <SecretField
            label="Vercel AI Gateway key"
            hint="Realtime sessions connect through the gateway. Same key as the gateway LLM provider."
            present={secrets.AI_GATEWAY_API_KEY}
            onSave={(v) => setSecret("AI_GATEWAY_API_KEY", v)}
          />
          <SelectField
            label="Realtime model"
            value={config.realtime.model}
            options={REALTIME_MODELS.map((m) => ({ value: m.id, label: m.label }))}
            hint={modelMeta?.blurb}
            onChange={(v) => {
              const meta = getRealtimeModelMeta(v);
              setConfig({
                realtime: {
                  ...config.realtime,
                  model: v,
                  // Reset to the new model's first voice ("" = model default).
                  voice: meta?.voices[0]?.id ?? "",
                },
              });
            }}
          />
          {modelMeta && modelMeta.voices.length > 0 && (
            <SelectField
              label="Voice"
              value={config.realtime.voice}
              options={modelMeta.voices.map((v) => ({ value: v.id, label: v.label }))}
              onChange={(v) => setConfig({ realtime: { ...config.realtime, voice: v } })}
            />
          )}
          <SelectField
            label="Hang up after silence"
            hint="How long a session stays connected with nobody talking before it drops back to the wake word. Sessions bill by the minute — shorter saves money."
            value={String(config.realtime.idleDisconnectSec)}
            options={[
              { value: "10", label: "10 seconds" },
              { value: "30", label: "30 seconds" },
              { value: "60", label: "1 minute" },
              { value: "180", label: "3 minutes" },
            ]}
            onChange={(v) =>
              setConfig({ realtime: { ...config.realtime, idleDisconnectSec: Number(v) } })
            }
          />
        </>
      )}
    </>
  );
}

function VoiceInputSection({ data, setConfig, setSecret }: SectionProps) {
  const { config, secrets } = data;
  const realtimeActive = config.voice.mode === "realtime";
  return (
    <>
      <SelectField
        label="How to start listening"
        hint={
          realtimeActive
            ? "In realtime voice mode this is what connects a session."
            : "Push-to-talk and Vosk work without any paid key."
        }
        value={config.voiceInput.wakeMode}
        options={[
          { value: "manual", label: "Push to talk (click / ⌥⌘Space)" },
          { value: "vosk", label: "Wake word (Vosk — free, offline)" },
          { value: "webspeech", label: "Wake word (Web Speech — browser)" },
        ]}
        onChange={(v) => setConfig({ voiceInput: { ...config.voiceInput, wakeMode: v } })}
      />
      {/* Transcription is the realtime model's job in realtime mode — these
          pipeline-only controls hide rather than sit disabled. */}
      {!realtimeActive && (
        <>
          <SelectField
            label="Transcription (speech-to-text)"
            hint="Whisper-local and Vosk-local are free and offline (one-time model download)."
            value={config.voiceInput.sttProvider}
            options={[
              { value: "whisper-local", label: "Local Whisper (free, offline)" },
              { value: "vosk-local", label: "Local Vosk (free, offline, fast)" },
              { value: "openai", label: "OpenAI Whisper (cloud)" },
              { value: "webspeech", label: "Web Speech (browser)" },
            ]}
            onChange={(v) => setConfig({ voiceInput: { ...config.voiceInput, sttProvider: v } })}
          />
          {config.voiceInput.sttProvider === "openai" && (
            <SecretField
              label="OpenAI API key"
              hint="Used in the main process to transcribe captured audio."
              present={secrets.OPENAI_API_KEY}
              onSave={(v) => setSecret("OPENAI_API_KEY", v)}
            />
          )}
          {config.voiceInput.sttProvider === "whisper-local" && (
            <SelectField
              label="Whisper model"
              hint="Bigger = more accurate but larger download + slower on CPU."
              value={config.voiceInput.whisperModel}
              options={[
                { value: "Xenova/whisper-tiny.en", label: "tiny.en (~75MB)" },
                { value: "Xenova/whisper-base.en", label: "base.en (~145MB)" },
                { value: "Xenova/whisper-small.en", label: "small.en (~480MB)" },
              ]}
              onChange={(v) =>
                setConfig({ voiceInput: { ...config.voiceInput, whisperModel: v } })
              }
            />
          )}
        </>
      )}
    </>
  );
}

function AppearanceSection({ data, setConfig }: SectionProps) {
  const { config } = data;
  return (
    <>
      <ThemePicker
        value={config.appearance.theme}
        onChange={(id) => setConfig({ appearance: { theme: id } })}
      />
      <ToggleRow
        title="Tool activity hints"
        description="Show what the assistant is doing (each tool it calls) in the floating overlay as it works."
      >
        <SegmentedControl
          value={config.appearance.showToolActivity ? "on" : "off"}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onChange={(v) => setConfig({ appearance: { showToolActivity: v === "on" } })}
        />
      </ToggleRow>
      <HotkeyField
        label="Talk hotkey"
        hint="Hold-style global shortcut to start listening (push-to-talk)."
        value={config.hotkeys.talk}
        onChange={(accelerator) => setConfig({ hotkeys: { talk: accelerator } })}
      />
      <HotkeyField
        label="Summon hotkey"
        hint="Global shortcut to show / hide OpenDex from anywhere (Spotlight-style)."
        value={config.hotkeys.summon}
        onChange={(accelerator) => setConfig({ hotkeys: { summon: accelerator } })}
      />
      <HotkeyField
        label="Stop hotkey"
        hint="Abort the current command even if another app is focused."
        value={config.hotkeys.interrupt}
        onChange={(accelerator) => setConfig({ hotkeys: { interrupt: accelerator } })}
      />
    </>
  );
}
function HotkeyField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (accelerator: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const capturingRef = useRef(false);

  useEffect(() => {
    if (capturing) btnRef.current?.focus();
  }, [capturing]);

  const startCapture = () => {
    capturingRef.current = true;
    window.opendex.suspendHotkeys();
    setCapturing(true);
  };

  const endCapture = () => {
    if (!capturingRef.current) return;
    capturingRef.current = false;
    setCapturing(false);
    window.opendex.resumeHotkeys();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!capturingRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const accelerator = acceleratorFromKeyEvent(e.nativeEvent);
    if (!accelerator) return;
    onChange(accelerator);
    endCapture();
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium text-foreground/90">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <button
        ref={btnRef}
        type="button"
        onClick={startCapture}
        onBlur={endCapture}
        onKeyDown={onKeyDown}
        className="min-w-[160px] rounded-md border border-input bg-dex-surface/60 px-3 py-1.5 text-center font-mono text-xs text-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {capturing ? "Press a key combination\u2026" : value || "Click to set"}
      </button>
    </div>
  );
}


/** Free models available on OpenCode Zen. */
const OPENCODE_FREE_MODELS = [
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
const KILO_FREE_MODELS = [
  { id: "kilo-auto/free", label: "Auto-route to best free model" },
  { id: "stepfun/step-3.7-flash:free", label: "StepFun Step 3.7 Flash" },
  { id: "poolside/laguna-s-2.1:free", label: "Poolside Laguna S 2.1" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "NVIDIA Nemotron 3 Ultra" },
  { id: "tencent/hy3:free", label: "Tencent HY3" },
];

/** Default model for each brain mode. */
const BRAIN_DEFAULTS: Record<string, string> = {
  opencode: "opencode/deepseek-v4-flash-free",
  kilo: "kilo-auto/free",
  anthropic: "claude-sonnet-4-20250514",
  grok: "grok-3",
  codex: "gpt-5",
};

function BrainSection({ data, setConfig, setSecret }: SectionProps) {
  const { config, secrets } = data;
  const brain = config.brain;
  const freeModels = brain === "opencode" ? OPENCODE_FREE_MODELS : brain === "kilo" ? KILO_FREE_MODELS : [];
  const currentModel = config.llm.model || BRAIN_DEFAULTS[brain] || "";

  return (
    <>
      <SelectField
        label="Brain"
        hint="Which AI powers the conversation. OpenCode and Kilo have free models."
        value={brain}
        options={[
          { value: "opencode", label: "OpenCode (8 free models)" },
          { value: "kilo", label: "Kilo Code (5 free models)" },
          { value: "anthropic", label: "Anthropic Claude (paid)" },
          { value: "grok", label: "xAI Grok (paid)" },
          { value: "codex", label: "OpenAI GPT-5 (paid)" },
        ]}
        onChange={(v) => setConfig({ brain: v, llm: { ...config.llm, model: BRAIN_DEFAULTS[v] || "" } })}
      />

      {/* Free model picker for OpenCode */}
      {brain === "opencode" && (
        <>
          <div className="text-xs text-green-500 rounded-md bg-green-500/10 px-3 py-2">
            8 free models — no API key needed. Routes through opencode.ai/zen/v1.
          </div>
          <SelectField
            label="Free model"
            hint="Pick a free model. DeepSeek V4 Flash is recommended for coding."
            value={currentModel}
            options={OPENCODE_FREE_MODELS.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(v) => setConfig({ llm: { ...config.llm, model: v } })}
          />
        </>
      )}

      {/* Free model picker for Kilo */}
      {brain === "kilo" && (
        <>
          <div className="text-xs text-green-500 rounded-md bg-green-500/10 px-3 py-2">
            5 free models — auto-routes to best available. No key needed for free tier.
          </div>
          <SelectField
            label="Free model"
            hint="Auto-route picks the best free model. Or choose a specific one."
            value={currentModel}
            options={KILO_FREE_MODELS.map((m) => ({ value: m.id, label: m.label }))}
            onChange={(v) => setConfig({ llm: { ...config.llm, model: v } })}
          />
          <SecretField
            label="Kilo API Key (optional)"
            hint="Optional: your own key for higher rate limits and paid models."
            present={secrets.KILO_API_KEY}
            onSave={(v) => setSecret("KILO_API_KEY", v)}
          />
        </>
      )}

      {/* Paid brains */}
      {brain === "anthropic" && (
        <>
          <SecretField
            label="Anthropic API Key"
            hint="Get your key at console.anthropic.com."
            present={secrets.ANTHROPIC_API_KEY}
            onSave={(v) => setSecret("ANTHROPIC_API_KEY", v)}
          />
          <SelectField
            label="Model"
            value={currentModel}
            options={[
              { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4 (recommended)" },
              { value: "claude-opus-4-20250514", label: "Claude Opus 4 (most capable)" },
            ]}
            onChange={(v) => setConfig({ llm: { ...config.llm, model: v } })}
          />
        </>
      )}

      {brain === "grok" && (
        <>
          <SecretField
            label="xAI API Key"
            hint="Get your key at console.x.ai."
            present={secrets.XAI_API_KEY}
            onSave={(v) => setSecret("XAI_API_KEY", v)}
          />
          <SelectField
            label="Model"
            value={currentModel}
            options={[
              { value: "grok-3", label: "Grok 3 (most capable)" },
              { value: "grok-3-mini", label: "Grok 3 Mini (fast)" },
            ]}
            onChange={(v) => setConfig({ llm: { ...config.llm, model: v } })}
          />
        </>
      )}

      {brain === "codex" && (
        <>
          <SecretField
            label="OpenAI API Key"
            hint="Get your key at platform.openai.com."
            present={secrets.OPENAI_API_KEY}
            onSave={(v) => setSecret("OPENAI_API_KEY", v)}
          />
          <SelectField
            label="Model"
            value={currentModel}
            options={[
              { value: "gpt-5", label: "GPT-5" },
              { value: "gpt-4.1", label: "GPT-4.1" },
            ]}
            onChange={(v) => setConfig({ llm: { ...config.llm, model: v } })}
          />
        </>
      )}
    </>
  );
}

function HardnessSection({ data, setConfig }: SectionProps) {
  const { config } = data;
  return (
    <>
      <SelectField
        label="Hardness"
        hint="How much the agent does without asking. Chill = read-only. Normal = read+write with confirmation. Hard = full tools with confirmation. Unhinged = autonomous."
        value={config.hardness}
        options={[
          { value: "chill", label: "Chill — read only, never ask" },
          { value: "normal", label: "Normal — read+write, ask first" },
          { value: "hard", label: "Hard — full tools, ask first" },
          { value: "unhinged", label: "Unhinged — autonomous, never ask" },
        ]}
        onChange={(v) => setConfig({ hardness: v })}
      />
      <div className="text-xs text-muted-foreground rounded-md bg-muted/50 px-3 py-2">
        {config.hardness === "chill" && "Read-only tools (grep, find, ls, read). No file writes, no execution."}
        {config.hardness === "normal" && "Read + write tools. The agent asks before modifying any files."}
        {config.hardness === "hard" && "Full tool access including code execution. The agent asks before destructive commands."}
        {config.hardness === "unhinged" && "Full autonomous access. Never asks permission. Speed over caution."}
      </div>
    </>
  );
}

function SkillsSection({ data, setConfig }: SectionProps) {
  const { config } = data;
  return (
    <>
      {SKILL_METAS.map((skill) => {
        const enabled = skill.optIn
          ? config.skills.enabled[skill.id] === true
          : config.skills.enabled[skill.id] !== false;
        const permission = config.skills.permissions[skill.id] ?? "ask";
        return (
          <div key={skill.id} className="flex flex-col gap-2">
            <ToggleRow title={skill.label} description={skill.description}>
              <SegmentedControl
                value={enabled ? "on" : "off"}
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
                onChange={(v) =>
                  setConfig({
                    skills: {
                      ...config.skills,
                      enabled: { ...config.skills.enabled, [skill.id]: v === "on" },
                    },
                  })
                }
              />
            </ToggleRow>
            {enabled && skill.sensitive && (
              <SelectField
                label="Permission"
                value={permission}
                options={[
                  { value: "ask", label: "Ask each time" },
                  { value: "always", label: "Always allow" },
                  { value: "never", label: "Never allow" },
                ]}
                onChange={(v) =>
                  setConfig({
                    skills: {
                      ...config.skills,
                      permissions: { ...config.skills.permissions, [skill.id]: v },
                    },
                  })
                }
              />
            )}
            {enabled && skill.id === "computer" && (
              <ToggleRow
                title="Animate cursor"
                description="Move the pointer smoothly so you can follow along. Turn off for the fastest actions (instant jumps)."
              >
                <SegmentedControl
                  value={config.computer.animateCursor ? "on" : "off"}
                  options={[
                    { value: "on", label: "On" },
                    { value: "off", label: "Off" },
                  ]}
                  onChange={(v) =>
                    setConfig({ computer: { animateCursor: v === "on" } })
                  }
                />
              </ToggleRow>
            )}
          </div>
        );
      })}
    </>
  );
}

function ModelSection({ data, setConfig, setSecret }: SectionProps) {
  const { config, secrets } = data;
  const apple = useAppleAvailability();
  const ollama = useOllamaAvailability();
  return (
    <>
      <ProviderPicker
        data={data}
        selected={config.llm.provider}
        ollama={ollama}
        onSelect={(id) =>
          // Keep the current model only if switching back to the same provider;
          // otherwise reset to that provider's default id.
          setConfig({
            llm: id === config.llm.provider ? { provider: id } : { provider: id, model: defaultModelFor(id) },
          })
        }
        setConfig={setConfig}
        setSecret={setSecret}
        apple={apple}
      />
      <SecretField
        label="Tavily API key (web search)"
        hint="Optional — enables the web-search tool."
        present={secrets.TAVILY_API_KEY}
        onSave={(v) => setSecret("TAVILY_API_KEY", v)}
      />
    </>
  );
}

function TtsSection({ data, setConfig, setSecret }: SectionProps) {
  const { config, secrets } = data;
  const voices = useSystemVoices();
  return (
    <>
      <SegmentedControl
        value={config.tts.engine}
        options={[
          { value: "elevenlabs", label: "ElevenLabs" },
          { value: "system", label: "System voice" },
        ]}
        onChange={(v) => setConfig({ tts: { engine: v } })}
      />
      {config.tts.engine === "elevenlabs" ? (
        <>
          <SecretField
            label="ElevenLabs API key"
            present={secrets.ELEVENLABS_API_KEY}
            onSave={(v) => setSecret("ELEVENLABS_API_KEY", v)}
          />
          <TextField
            label="Voice ID"
            hint="From your ElevenLabs voice library."
            value={config.tts.elevenLabs.voiceId}
            onChange={(v) =>
              setConfig({ tts: { elevenLabs: { ...config.tts.elevenLabs, voiceId: v } } })
            }
          />
          <TextField
            label="Model"
            value={config.tts.elevenLabs.modelId}
            onChange={(v) =>
              setConfig({ tts: { elevenLabs: { ...config.tts.elevenLabs, modelId: v } } })
            }
          />
        </>
      ) : (
        <SelectField
          label="System voice"
          hint={voices.length ? undefined : "Loading available voices…"}
          value={config.tts.system.voiceURI ?? ""}
          options={[
            { value: "", label: "Default" },
            ...voices.map((v) => ({ value: v.voiceURI, label: v.label })),
          ]}
          onChange={(v) =>
            setConfig({ tts: { system: { ...config.tts.system, voiceURI: v || null } } })
          }
        />
      )}
    </>
  );
}

function GreetingSection({ data, setConfig }: SectionProps) {
  const { config } = data;
  return (
    <>
      <SelectField
        label="Proactive greeting"
        hint="What the assistant says the first time you wake it."
        value={config.greeting.mode}
        options={[
          { value: "example", label: "Example briefing (demo)" },
          { value: "custom", label: "Custom prompt" },
          { value: "none", label: "None — just listen" },
        ]}
        onChange={(v) => setConfig({ greeting: { ...config.greeting, mode: v } })}
      />
      {config.greeting.mode === "custom" && (
        <TextArea
          label="Custom greeting prompt"
          hint="Instructions for the spoken greeting. Include any data you want it to reference."
          value={config.greeting.customPrompt}
          placeholder="e.g. Greet me, summarise my calendar for today, and suggest what to focus on…"
          onChange={(v) => setConfig({ greeting: { ...config.greeting, customPrompt: v } })}
        />
      )}
    </>
  );
}

function PrivacySection({ data, setConfig }: SectionProps) {
  const { config } = data;
  return (
    <>
      <ToggleRow
        title="Anonymous usage data"
        description={
          <>
            Helps improve OpenDex. Never sends voice, transcripts, prompts, API
            keys, opened URLs, or file paths.{" "}
            <a
              href="https://github.com/wassgha/opendex/blob/main/PRIVACY.md"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-foreground"
            >
              Learn more
            </a>
          </>
        }
      >
        <SegmentedControl
          value={config.analytics.enabled ? "on" : "off"}
          options={[
            { value: "on", label: "On" },
            { value: "off", label: "Off" },
          ]}
          onChange={(v) => setConfig({ analytics: { enabled: v === "on" } })}
        />
      </ToggleRow>
      <div className="text-xs text-muted-foreground">
        {data.encryptionAvailable
          ? "API keys are encrypted with your OS keychain."
          : "Warning: OS keychain unavailable — API keys are stored obfuscated, not encrypted."}
      </div>
    </>
  );
}

function ResetSection({ data, resetConfig }: SectionProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const onReset = async () => {
    setBusy(true);
    try {
      await resetConfig();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <div className="text-sm text-muted-foreground">
        Restore every setting to its defaults and re-run first-time onboarding.
        This clears your assistant name, theme, voice, model, and skill choices
        {data.encryptionAvailable
          ? ", and removes any API keys saved in the app"
          : ""}
        . This can’t be undone.
      </div>
      {confirming ? (
        <div className="flex items-center gap-2">
          <Button variant="destructive" onClick={onReset} disabled={busy}>
            {busy ? "Resetting…" : "Yes, reset everything"}
          </Button>
          <Button
            variant="outline"
            onClick={() => setConfirming(false)}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="destructive" onClick={() => setConfirming(true)}>
            Reset to defaults
          </Button>
        </div>
      )}
    </>
  );
}

export interface SettingsSection {
  id: string;
  label: string;
  Icon: LucideIcon;
  Component: ComponentType<SectionProps>;
  /** Hide this section for the current config (e.g. TTS in realtime mode). */
  hidden?: (data: PublicConfig) => boolean;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: "assistant", label: "Assistant", Icon: User, Component: AssistantSection },
  { id: "brain", label: "Brain", Icon: Cpu, Component: BrainSection },
  { id: "hardness", label: "Hardness", Icon: ShieldCheck, Component: HardnessSection },
  { id: "voice-mode", label: "Voice mode", Icon: AudioWaveform, Component: VoiceModeSection },
  { id: "voice-input", label: "Voice input", Icon: Mic, Component: VoiceInputSection },
  { id: "appearance", label: "Appearance", Icon: Palette, Component: AppearanceSection },
  { id: "skills", label: "Skills & tools", Icon: Blocks, Component: SkillsSection },
  { id: "model", label: "Language model", Icon: Cpu, Component: ModelSection },
  {
    id: "tts",
    label: "Voice (TTS)",
    Icon: AudioLines,
    Component: TtsSection,
    // The realtime model speaks with its own voice — the TTS engine is unused.
    hidden: (data) => data.config.voice.mode === "realtime",
  },
  { id: "greeting", label: "Greeting", Icon: MessageSquare, Component: GreetingSection },
  { id: "privacy", label: "Privacy", Icon: ShieldCheck, Component: PrivacySection },
  { id: "reset", label: "Reset", Icon: RotateCcw, Component: ResetSection },
];
