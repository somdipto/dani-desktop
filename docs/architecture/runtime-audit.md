# DANI Desktop — Runtime Audit

Generated: 2026-09-01 (updated)
Repository: github.com/somdipto/dani-desktop (OpenDex fork)
Branch: `main` (uncommitted)

---

## 1. Current Request Flow (OMP Path)

```
Renderer (use-dex.ts)
  │
  ├─ Text: submitText(text) → runCommand(text)
  │
  └─ Voice: pushToTalk() → startMode("command") → STT → runCommand(transcript)
        │
        ▼
runCommand(userText)
  │
  ├─ messagesRef.current.push({ role: "user", content: userText })
  ├─ setStatus("thinking")
  │
  ▼
window.opendex.chat({ messages, onDelta, onToolCall, onToolResult })
  │
  ▼
Preload bridge (preload/index.ts)
  │
  ├─ ipcRenderer.send(IPC.chatStart, { requestId, messages, mode })
  │
  ▼
Main process (index.ts) — chatStart handler
  │
  ├─ buildSystemPrompt({config, briefing, skillPrompts})
  ├─ streamDaniChat({ messages, system, onDelta, ... })
  │
  ▼
dani-chat.ts — ensureRuntime() spawns DANI RPC
  │
  ├─ DANI spawned: dani --mode rpc --no-session --allow-home --model <cfg.llm.model>
  │     --tools computer --config <app-path>/dani-computer.yml
  ├─ DaniRpcClient: JSON-line over stdin/stdout
  │
  ▼
OmpRpcRuntime.prompt(message)
  │
  ▼
DANI (Bun process) — full agent loop
  │
  ├─ System prompt (DANI's own, not desktop's)
  ├─ Tools (DANI's built-in: computer, etc.)
  ├─ Model resolution (DANI's provider system)
  │
  ▼
DANI events (JSON-line stdout)
  │
  ├─ agent_start/turn_start → normalizeRpcFrame() → thinking
  ├─ message_start → thinking
  ├─ tool_call/tool_use → working
  ├─ message_end(role=assistant) → done
  ├─ turn_end/agent_end → idle
  ├─ error → error
  │
  ▼
streamDaniChat callbacks → IPC.chatDelta → renderer → transcript + TTS
```

**VERDICT: OMP/DANI is the ONLY execution path. Vercel AI SDK is removed from the critical path.**

---

## 2. Voice Flow

```
User holds ⌥⌘ (push-to-talk)
  │
  ▼
globalShortcut.register("CommandOrControl+Alt") → IPC.pushToTalk
  │
  ▼
Preload → use-dex.ts pushToTalk()
  │
  ├─ Toggle: first press → startMode("command") → active_listening
  │           second press → submit liveCaption
  │
  ├─ Hold-to-talk (uiohook-napi):
  │     keydown via globalShortcut → start recording
  │     keyup via uiohook-napi → submit liveCaption
  │
  ▼
startMode("command")
  │
  ├─ stopRecognition()
  ├─ stopWakeEngine()
  ├─ setStatus("active_listening")
  │
  └─ if voiceMode === "pipeline":
        │
        ▼
      ensureSttEngine() → Whisper/Vosk/WebSpeech STT
        │
        ▼
      mic capture → STT transcription
        │
        ▼
      runCommand(transcript)
        │
        ▼
      [OMP path: streamDaniChat() → DANI RPC]
        │
        ▼
      TTS → speak response
        │
        ▼
      startMode("follow_up") or startMode("wake")
```

**VERDICT: Voice converges with text at `runCommand()` — same OMP path.**

---

## 3. Provider Flow

```
config.llm = { provider: "dani", model: "clawhud/grok-4.5" }
  │
  ▼
ensureRuntime() in dani-chat.ts
  │
  ├─ Spawns: dani --mode rpc --no-session --allow-home --model <model>
  │     --tools computer --config dani-computer.yml
  │
  ▼
DANI handles provider resolution internally
  │
  ├─ DANI reads ~/.config/dani/dani.jsonc for provider keys
  ├─ DANI reads ~/.dani/agent/models.yml for model definitions
  ├─ DANI selects the appropriate API endpoint
  │
  ▼
Model API (HTTP/WebSocket via DANI)
```

**VERDICT: Desktop does NOT resolve providers. DANI owns provider selection entirely. The desktop's `LlmProvider` type and `LLM_PROVIDERS` metadata exist only for the UI picker.**

---

## 4. Computer-Use Flow

```
DANI agent loop (Bun process)
  │
  ▼
DANI decides to use computer tool
  │
  ▼
DANI's built-in computer tool (@dani/pi-natives Rust crate)
  │
  ├─ screen-capture: macOS Quartz WindowServer (native resolution)
  ├─ input: macOS Accessibility API (native click/type/scroll)
  ├─ Runs in Bun worker process
  │
  ▼
Screenshot returned to DANI model → model decides next action
  │
  ▼
DANI emits tool_call/tool_use events → streamDaniChat → renderer activity banner
```

**VERDICT: Computer-use is DANI's native tool. Desktop has NO computer-use code. NutJS was removed.**

---

## 5. Architecture After Cleanup

### What the Desktop Owns
- **Voice state machine** (`use-dex.ts`) — wake/STT/TTS/barge-in/push-to-talk
- **Window management** — main, notch, overlay, permission popup
- **UI** — settings, theme, transcript, tool activity banners
- **OMP RPC lifecycle** — spawn DANI, send prompts, receive events
- **Permission gate** — popup window for sensitive tool approval
- **IPC bridge** — preload, channels, session state relay

### What DANI Owns
- **Agent loop** — system prompt, tool orchestration, multi-step reasoning
- **Provider resolution** — API keys, model selection, endpoint routing
- **Computer use** — screen capture, input injection (native Rust)
- **Tool execution** — all built-in tools (computer, web, files, etc.)
- **Model inference** — direct API calls to providers

### Shared Contract
- **IPC channels** (`channels.ts`) — typed message definitions
- **DANI RPC protocol** — JSON-line stdin/stdout (ready, prompt, events, response)
- **ProductState** — `idle|thinking|working|needs_user|done|error` (normalized from DANI events)

---

## 6. Critical Files Map

```
src/main/
├── index.ts                    ← Main process, IPC handlers, window management
├── dani/
│   ├── types.ts                ← DaniRuntime interface, DaniEvent, ProductState
│   ├── events.ts               ← normalizeRpcFrame() — DANI events → ProductState
│   ├── rpc-client.ts           ← DaniRpcClient (JSON-line over stdin/stdout)
│   └── omp-rpc-runtime.ts      ← OmpRpcRuntime (implements DaniRuntime)
├── agent/
│   ├── chat.ts                 ← ChatMessage type only (ModelMessage re-export)
│   ├── dani-chat.ts            ← streamDaniChat() — THE execution path
│   ├── system-prompt.ts        ← System prompt builder (used by index.ts + realtime)
│   └── llm/
│       └── resolve-model.ts    ← checkAppleAvailability/checkOllamaAvailability only
├── config/
│   ├── schema.ts               ← LlmProvider, OpenDexConfig (DANI is default)
│   ├── store.ts                ← Config persistence
│   └── llm-providers.ts        ← Provider metadata for UI picker
├── ipc/
│   └── channels.ts             ← IPC channel definitions
└── skills/
    └── registry.ts             ← buildToolSet() — clock, weather, web-search, open

src/preload/
└── index.ts                    ← IPC bridge (chat, pushToTalk, pushToTalkRelease, etc.)

src/renderer/src/
├── main.tsx                    ← Entry point, hash-based routing
├── App.tsx                     ← Main app, theme selection
├── lib/dex/
│   ├── use-dex.ts              ← Voice state machine
│   └── speech-engine.ts        ← TTS engines
└── components/
    ├── compact-bar.tsx         ← Notch bar UI
    ├── status-bar.tsx          ← StatusDot, StatusPill
    └── settings/sections.tsx   ← Provider/model settings UI
```

---

## 7. Removed Code (This Session)

| File/Dependency | What | Why |
|----------------|------|-----|
| `src/skills/computer/` | NutJS computer skill | DANI's native tool replaces it |
| `@nut-tree-fork/nut-js` | Native input injection | DANI handles input natively |
| `src/main/agent/agent-chat.ts` | Brain→Provider mapping | DANI owns provider resolution |
| `src/main/agent/chat.ts` | `streamChat()` + `StreamChatOptions` | Vercel AI SDK path removed |
| `src/main/agent/llm/resolve-model.ts` | `resolveModel()` + AI SDK adapters | DANI resolves models |
| `scripts/smoke-chat.ts` | Old smoke test | Tested removed Vercel AI SDK path |
| `@ai-sdk/anthropic` | Anthropic AI SDK adapter | DANI handles Anthropic |
| `@ai-sdk/openai` | OpenAI AI SDK adapter | DANI handles OpenAI |
| `@ai-sdk/xai` | xAI AI SDK adapter | DANI handles xAI |

---

## 8. Remaining Dead Code (Low Priority)

| File | Status | Action |
|------|--------|--------|
| `src/main/config/llm-providers.ts` | Used by renderer UI picker | KEEP — UI needs provider labels |
| `src/main/auth/brain-auth.ts` | Auth helpers | KEEP — may be needed for DANI auth flow |
| `src/main/agent/realtime/` | Realtime voice mode (speech-to-speech) | KEEP — separate feature, not dead |
| `@ai-sdk/gateway` | Used by realtime code | KEEP — realtime needs it |

---

## 9. Build & Install

```bash
# Typecheck
pnpm typecheck

# Build
./node_modules/.bin/electron-vite build --config electron.vite.config.ts

# Create asar + install
node -e "
const asar = require('./node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar');
asar.createPackage('out', 'app.asar').then(() => {
  const fs = require('fs');
  const s = fs.statSync('app.asar');
  console.log('Created app.asar:', (s.size / 1024 / 1024).toFixed(1), 'MB');
}).catch(e => console.error(e));
"
pkill -f "OpenDex" 2>/dev/null; sleep 2
cp app.asar /Applications/OpenDex.app/Contents/Resources/app.asar
open /Applications/OpenDex.app
```

---

## 10. Key Decisions

1. **OMP is the harness, not the providers** — Desktop should not contain `if provider == anthropic → create model`. DANI owns provider resolution.
2. **`streamDaniChat()` is the single execution path** — Text and voice converge at `runCommand()` → IPC → `streamDaniChat()` → `OmpRpcRuntime.prompt()`.
3. **DANI handles system prompts and tools internally** — Desktop does not pass system prompts or tool definitions to DANI.
4. **NutJS removed** — DANI's native `@dani/pi-natives` Rust crate provides desktop automation. No JS input injection in the desktop.
5. **Hold-to-talk via uiohook-napi** — `globalShortcut` for keydown (start recording), `uiohook-napi` for keyup (submit on release).
6. **ProductState normalization** — DANI events are normalized to `idle|thinking|working|needs_user|done|error` via `normalizeRpcFrame()`.
