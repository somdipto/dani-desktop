# DANI Desktop

HOLD FN → SPEAK → RELEASE FN → TRANSCRIBE → OMP → EXECUTE → DONE.

DANI Desktop is a native macOS peripheral for [OMP (Oh My Pi)][omp]. The
desktop app hears (Fn + voice), shows (overlay + menu bar), approves, and
hosts one persistent OMP process. **It is not the agent.** OMP owns
understanding, reasoning, planning, tools, context, and computer-use.

```
                    HUMAN
                      │
                      ▼
                HOLD FN + VOICE
                      │
                      ▼
               Native macOS App
               Swift / SwiftUI
                      │
                      ▼
                    STT
                      │
                      ▼
                 DANI / OMP
                   RPC mode
                      │
          ┌───────────┼───────────┐
          │           │           │
        models      tools       sessions
          │           │
          │           ▼
          │       computer
          │           │
          ▼           ▼
       provider      macOS
```

This repository is a fork of [Scribe][scribe] (commit `3a40e3a`). Scribe's
native primitives — Fn detection via `CGEventTap`, Apple Speech STT,
microphone routing, the floating overlay, the menu-bar accessory lifecycle,
permissions — are kept. Scribe's local polish pipeline (llama.cpp) and
clipboard-paste destination are gone; the transcript now routes to OMP.

The previous `dani-desktop/OpenDex` repo is a failed prototype and is NOT
the architectural base. Scribe is.

[omp]: https://github.com/can1357/oh-my-pi
[scribe]: https://github.com/xiangst0816/scribe

---

## Architecture (one engineer, ~10 minutes)

```
Sources/
├── DaniApp/                  executable; app entry + AppDelegate orchestrator
│   ├── AppDelegate.swift     the single DaniState state machine + wiring
│   └── main.swift            NSApplication.run()
│
├── Input/
│   ├── FnKeyMonitor.swift    CGEventTap → onFnDown / onFnUp (Scribe's, unchanged)
│   └── VoiceCapture.swift    CoreAudio input-device routing (Scribe's, renamed)
│
├── Speech/
│   └── SpeechTranscriber.swift  SFSpeechRecognizer session (Scribe's, renamed)
│
├── Runtime/                  the ONLY layer that understands OMP protocol details
│   ├── DaniRuntime.swift       protocol + DaniRun + DaniRunEvent + DaniState
│   ├── OmpEventDecoder.swift   parsed JSON frame → DaniRunEvent (pure)
│   ├── OmpBinaryDiscovery.swift find dani/omp in PATH, persist the choice
│   ├── OmpRpcProcess.swift     actor: spawn `omp --mode rpc`, stdio, ready wait
│   └── OmpRpcRuntime.swift     DaniRuntime impl; one persistent process
│
├── UI/
│   ├── DaniOverlay.swift       floating pill (Scribe's, + showState)
│   ├── DaniStatus.swift        DaniState → presentation (label / spinner / done)
│   ├── Settings.swift          executable picker + runtime status
│   ├── DaniDevPanel.swift      Milestone 1 dev text-prompt panel
│   └── Localized.swift         menu / alert / state strings (en + zh + ja + ko)
│
└── Permissions/
    └── PermissionManager.swift mic + speech + accessibility gate
```

The library target `Dani` spans `Sources/` (excluding `Sources/DaniApp/`) so
the subdirs are organizational, not separate SwiftPM modules. One `import Dani`
in the executable is the whole import surface. The `DaniApp` executable target
depends on `Dani`.

### Why so few modules?

The spec: "Do NOT create dozens of directories unless actually necessary." A
single library + a thin executable keeps the import graph flat and the whole
app understandable in ~10 minutes. Scribe's two-target pattern (library for
`@testable import` + executable shim) is preserved.

### Why OMP, not a model SDK in the app?

The spec: "DANI Desktop does NOT implement OpenAI SDK / Anthropic SDK / Grok
SDK / OpenCode SDK / Kilo SDK. OMP already handles model providers." The
desktop sends a prompt; OMP picks the model, calls the provider, runs tools,
manages context. The desktop watches lifecycle events.

---

## The OMP RPC contract

[Source of truth: `docs/rpc.md` in the OMP repo.][omp-rpc]

- **Binary**: `omp --mode rpc` (or the `dani` CLI wrapper). MVP stays on
  protocol v1 (no `negotiate_protocol`); v2 chunk reassembly only matters
  for frames above 1 MiB, which DANI prompts and text deltas never hit.
- **Framing**: newline-delimited JSON over stdio. The first stdout frame is
  `{"type":"ready","protocolVersion":1,...}`. DANI waits for it before
  sending commands (10s startup timeout).
- **Prompt**: `{"id":"…","type":"prompt","message":"…"}` — acknowledged
  immediately with `{"type":"response","command":"prompt","success":true,
  "data":{"agentInvoked":true|false}}`.
- **Completion**: `agent_end` with `isTerminal != false`. The field is
  optional — absent means terminal (backward-compat). `agentInvoked: false`
  on the ack (or a later `prompt_result`) means a local-only prompt (slash
  command) — the run is already done. **Prompt acknowledgment is NOT
  completion.**
- **Events**: `agent_start`, `message_update` (with
  `assistantMessageEvent.type == "text_delta"` → `.delta`), `tool_execution_start/end`,
  `agent_end`, plus `extension_ui_request` method `confirm` for approvals.
- **Abort**: `{"type":"abort"}`. **Approve**: `{"type":"extension_ui_response","id":reqId,"confirmed":true}`
  (or `cancelled:true`).
- **Graceful stop**: close stdin → OMP exits 0.

`OmpEventDecoder` is the only file that knows these names. Everything
upstream (`OmpRpcRuntime`, `AppDelegate`, UI) sees clean Swift `DaniRunEvent`s.
OMP JSON never escapes `Sources/Runtime/`.

[omp-rpc]: https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md

---

## State machine (one authoritative state)

`daniState: DaniState` is the single state. No parallel booleans
(`isRecording` / `isProcessing` / `isAgentBusy` / `isWaiting` / `isSpeaking` /
`hasFinished` are all forbidden).

```
idle         --Fn down-->          listening
listening    --Fn up + 0.5s trail-->transcribing
transcribing --transcript ready--> thinking (prompt sent)
thinking     --tool exec-->        working
working      --tool done-->        thinking
*            --approval-->         needsUser
*            --agent_end terminal-->done
*            --failure-->          error
done         --1.5s-->             idle
error        --2.5s-->             idle
listening/transcribing --cancel-->idle
```

All transitions go through `transition(to:detail:)`. The recording session,
the trailing-buffer timer, and the OMP run Task are RESOURCE HANDLES (not
state) — `currentSession`, `trailingWork`, `runTask`.

---

## Build & run

```bash
make run        # swift build -c release + build Dani.app + open it
make build      # build without opening
make install    # install to /Applications/Dani.app
swift test      # decoder unit tests (always) + runtime smoke (skips without OMP)
```

Requirements: macOS 14+, Xcode 16 (Swift 6). OMP installed (`omp --mode rpc`
works) OR the DANI CLI wrapper. Accessibility + Microphone + Speech
Recognition granted.

### First run

1. `make run`.
2. Menu bar → Dani icon → grant Accessibility (the app retries the event tap
   on focus).
3. Menu bar → Dani → Developer Prompt… (Cmd-D). Type `Reply exactly DANI_OK`,
   press Send. You should see `DANI_OK` stream back. **This is Milestone 1. Do
   not touch voice until 10 consecutive prompts work.**
4. Menu bar → Dani → Settings… (Cmd-,) if auto-discovery didn't find OMP —
   pick the binary. The runtime restarts.
5. Hold Fn, speak, release. The overlay shows `Understanding… → Working… →
   Done ✓`. **This is Milestone 2.**

---

## Testing (three layers)

1. **Runtime smoke** — `swift test --filter OmpRpcRuntimeSmokeTests`. Launches
   OMP, prompts `Reply exactly DANI_RUNTIME_OK`, verifies ready → ack → text →
   `agent_end` (terminal). Skips without OMP.
2. **Decoder unit tests** — `swift test --filter OmpEventDecoderTests`. Pure,
   no OMP, run in CI. Pin the wire-format contract.
3. **Voice + computer gauntlets** — manual; see
   [`Tests/DaniTests/GAUNTLET.md`](Tests/DaniTests/GAUNTLET.md). The Swift
   scaffolding (`VoiceGauntletTests`, `ComputerGauntletTests`) exercises the
   OMP-side programmatically; enable with `DANI_GAUNTLET=1`. The Fn + mic side
   is human-driven.

The MVP acceptance task is one end-to-end run: hold Fn, say "Open Notes and
type hello from Dani", release. **10 / 10 consecutive successes** is the bar.
Below 10/10 is not production-ready — say so honestly.

---

## Logging

`[fn]` `[audio]` `[stt]` `[omp]` `[dani]` tags via `NSLog`. Open Console.app,
filter process = `Dani`. A failed run shows exactly where it stopped:

```
[fn] down
[audio] recording
[fn] up
[stt] transcribing
[stt] "open notes and type hello from dani"
[omp] prompt sent (voice)
[omp] agent_start
[omp] tool_execution_start computer
[omp] tool_execution_end computer
[omp] agent_end (24 chars)
[dani] done
```

No secrets are logged.

---

## What was kept from Scribe; what was dropped

**Kept** (native primitives, unchanged or renamed): `FnKeyMonitor`
(`CGEventTap` + `.maskSecondaryFn`, Fn down/up lifecycle), `SpeechTranscriber`
(`SFSpeechRecognizer` session, partial + final callbacks, trailing buffer),
`VoiceCapture` (CoreAudio device routing), `DaniOverlay` (borderless `NSPanel`,
waveform, spinner, transcript pill, menu-bar animation), permissions flow,
menu-bar accessory lifecycle.

**Dropped** (Scribe-specific, DANI doesn't need): the entire `Refinement/*`
local polish pipeline (llama.cpp + Gemma), `TextInjector` (clipboard +
Cmd+V paste), `PolishEval` harness, Sparkle auto-update, the llama binary
target, the polish Settings UI, Scribe's marketing site (`web/`), the Sparkle
appcast scripts, translated READMEs, `CHANGELOG.md`, `CLAUDE.md`.

**Replaced**: Scribe's `transcript → polish → paste` with DANI's
`transcript → DaniRuntime.prompt() → OMP → events → overlay`.

---

## North star

The whole MVP must remain explainable as:

```
FN DOWN → RECORD → FN UP → TRANSCRIBE → OMP → EXECUTE → DONE
```

If the architecture can't be explained this simply after implementation, it
has been overengineered.

See [`EVIDENCE.md`](EVIDENCE.md) for the honest build/runtime status.
