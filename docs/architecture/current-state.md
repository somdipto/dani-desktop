# Current state — OpenDex fork

Evidence from this repo on `main` (`3e89834` / v1.1.14) plus **uncommitted local work**. Do not `git reset`.

## Runtime architecture today

OpenDex is a **voice-first Electron app that is also the brain**.

```
mic (renderer)
  → STT (WASM / Web Speech / OpenAI)
  → IPC chatStart
  → main: resolveModel() + streamChat()  [Vercel AI SDK, MAX_STEPS=40]
  → skills (clock, weather, web-search, open, computer/nut.js)
  → text deltas IPC
  → TTS (system or ElevenLabs)
  → themes / notch / overlay
```

Two brains already exist in-process:

| Path | Owner | Notes |
|---|---|---|
| Pipeline | `src/main/agent/chat.ts` | `streamText` + tools. Default product path. |
| Realtime | `src/main/agent/realtime/session-host.ts` | WebSocket speech-to-speech. Computer-use only via `run_task` delegation back into pipeline. |

There is **no DANI/OMP process**. There is **no Cua Driver**. Computer use is nut.js + Electron `desktopCapturer`.

## Process model (keep)

- **Main** (`src/main/`): agent, TTS, secrets, IPC, windows, tray, hotkeys.
- **Preload**: typed `window.opendex`. Secrets never cross.
- **Renderer**: `useDex` state machine, themes, STT engines.
- Windows: hidden persistent main, overlay HUD, notch, settings, permission popup.
- `close` → `hide()`. Quit via tray / ⌘Q.

## What this fork already changed (uncommitted)

Preserve unless it conflicts with DANI:

- Recursive `mergeConfig` (was clobbering nested config).
- Factory-reset env secret wipe + writeFileSync try/catch.
- ElevenLabs stream timeout, 25MB STT cap, 5k TTS cap.
- Weather/web-search fetch try/catch.
- WebSocket 15s connect timeout.
- `http(s)`-only `shell.openExternal`.
- Factory-reset confirmation token.
- xAI OAuth device-code (`src/main/auth/xai-oauth.ts`).
- Updated Grok model IDs; realtime endpoint `wss://api.x.ai/v1/realtime`.
- PTT hotkey currently `Alt+Command+Space` (toggle, not hold).
- **OpenCode as an LLM provider hitting `opencode.ai/zen/v1`** — wrong layer for DANI. Isolate/remove after DANI RPC is on the critical path. Do not expand it.

## Valuable code to keep

| Area | Where | Why |
|---|---|---|
| Notch / overlay / tray / hide-not-close | `src/main/index.ts`, `NotchApp`, `OverlayApp` | Product shell |
| Session relay | `SessionState` IPC | Notch is view-only |
| STT engines | `lib/dex/engines/*` | Local Whisper / Vosk |
| Sentence TTS | `sentence-buffer.ts`, `speech-engine.ts` | Speak results without a chatbot UI |
| Permission popup | `permissions.ts` + `#permission` window | Host-tool approvals later |
| IPC contract | `src/main/ipc/channels.ts` | Typed, preload-bridged |
| Computer capture | `screen-capture.ts` | Retina crop, stable frames, coord map |
| Config store | `store.ts` | Encrypted secrets in main |
| Themes | `components/themes/` | Keep chrome; stop treating chat as the product |

## Redundant / replace on the critical path

| Thing | Why it goes |
|---|---|
| `streamChat` as the product brain | Second agent loop. DANI CLI owns reasoning. |
| `resolve-model.ts` + `llm-providers.ts` as user auth | Duplicate of OMP login/models. |
| OpenCode Zen BYOK provider | Cloud proxy, not local DANI. |
| Realtime S2S as default | Optional later. DANI is text-in after STT. |
| nut.js as *primary* CU architecture | Keep as first `ComputerUseProvider` impl until Cua is proven. |
| Per-click permission on every computer tool | Intent-level approval, not input-event approval. |

## Voice / hotkey reality

`DexStatus`: idle → listening_wake → active_listening → thinking → speaking.

PTT is **press-to-toggle**, gated on `wakeMode === "manual"`. Product wants **HOLD Fn → speak → release**.

Electron `globalShortcut` **cannot bind Fn**. Fn requires a CGEvent/IOHID tap in the trusted app process (TCC stays on OpenDex.app).

## Computer use today

`src/skills/computer/`: `captureScreen`, `click`, `moveMouse`, `drag`, `typeText`, `pressKeys`, `scroll`, `wait`.

- Screenshot-first, JPEG ≤1280px, last-2-image prune.
- Accessibility preflight via `systemPreferences.isTrustedAccessibilityClient`.
- Opt-in + `sensitive: true` → permission popup per command (session grant for the rest of that turn).
- Blind x/y on screenshot coords. No AX tree, no window list, no open-app.

## Tests

No unit/e2e suite. Smoke only: `pnpm smoke:chat`, `smoke:realtime`, `smoke:stt`. Typecheck: `pnpm typecheck`.

## DANI CLI on this machine (not wired)

| Fact | Value |
|---|---|
| Binary | `/usr/local/bin/dani` → `.../daxxxx/dani-fork/packages/coding-agent/src/cli.ts` |
| Version | `dani v18.0.6` (same as `omp`) |
| RPC | `dani --mode rpc` — NDJSON stdin/stdout |
| Contract | `dani-fork/.../modes/rpc/rpc-types.ts` |
| Client | `rpc-client.ts` (`start/stop/prompt/steer/abort/setCustomTools/getLoginProviders/login/...`) |
| Host tools | `set_host_tools` → `host_tool_call` → host `host_tool_result` |

Do **not** confuse with `/Users/dan/Desktop/x/dani-cli` (old OpenCode-shaped tree, ~2 months stale).

## Risky areas

1. Uncommitted fork delta on `main`. Any rewrite must not wipe it.
2. `use-dex.ts` (~1800 lines) owns voice + chat + realtime. Touch only the “thinking” branch.
3. Packaging: spawn `dani` as a sibling binary; do not bundle the whole dani-fork into Electron.
4. TCC: Screen Recording / Accessibility must stay attributed to OpenDex.app, not Terminal.
5. Renderer currently drives `window.opendex.chat()` — that is the seam to replace.

## Integration points (do not invent new ones)

```
useDex.submitText / STT result
  → window.opendex.chat()          [preload]
  → IPC.chatStart                  [main]
  → streamChat + resolveModel      [REPLACE with DaniRuntime.prompt]
  → onDelta / onToolCall           [KEEP shape, new source]
```

Host tools later attach at main, not renderer.
