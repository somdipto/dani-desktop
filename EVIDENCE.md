# DANI Desktop — Evidence Report

> **Honest status. Per the spec's SUCCESS CRITERION, this report does not say
> "implementation complete." It says PASS / FAIL per criterion and the
> reliability count. If it's 0/10, it says 0/10.**

## Environment constraint (read first)

This DANI Desktop repository was built in a **Linux sandbox** that has:

- ✅ `git` 2.47
- ❌ `swift` / `swiftc` (no Swift toolchain)
- ❌ `xcodebuild` (no Xcode)
- ❌ macOS (no AppKit, no `SFSpeechRecognizer`, no `CGEventTap`, no `NSWorkspace`)
- ❌ `omp` / `dani` (no OMP binary, no model provider configured)
- ❌ microphone (no hardware)
- ❌ Accessibility permission system (no macOS privacy framework)

Therefore: **every runtime criterion below is "REQUIRES MACOS VERIFICATION."**
Code is written; nothing was compiled, run, or self-verified here. The
user must run `make build`, `swift test`, and the gauntlet on a real Mac
with OMP installed.

What WAS verified here:
- The OMP RPC protocol is researched from the actual OMP repo
  ([`can1357/oh-my-pi` `docs/rpc.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md)),
  not assumed. Ready frame, prompt-ack-vs-completion semantics, `agent_end`
  `isTerminal != false`, `message_update` `text_delta`, `extension_ui_request`
  `confirm` — all from the docs.
- The decoder contract is pinned by 30+ unit tests
  (`Tests/DaniTests/OmpEventDecoderTests.swift`), covering every event type
  in the OMP docs + tolerance (unknown types, missing fields, malformed JSON).
  These tests are **written**, not **executed** (no swift in this sandbox).
- The git history is 12 atomic commits, each matching the spec's repo-rules
  example commit messages (`chore: fork…`, `refactor: rename…`,
  `feat: add OMP RPC runtime`, `feat: route text prompts through OMP`,
  `feat: route Fn transcription through OMP`, `feat: surface OMP execution
  states`, `test: add OMP runtime smoke test`, `test: add voice + computer
  gauntlet`).
- The module layout matches the spec's target structure exactly
  (`Sources/{DaniApp,Input,Speech,Runtime,UI,Permissions}/`).
- No code was ported from the failed `dani-desktop/OpenDex` prototype; Scribe
  is the sole base.

## Criterion-by-criterion

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Build | **REQUIRES MACOS VERIFICATION** | `Package.swift` (name: Dani, targets Dani + DaniApp + DaniTests, no deps); `Makefile` (APP_NAME=Dani); `Info.plist` (bundle com.dani.desktop, executable DaniApp); `Dani.entitlements` (audio-input only). `swift build` not run here (no swift). Run `make build` on a Mac to verify. |
| 2 | Fn detection | **REQUIRES MACOS VERIFICATION (code preserved from Scribe)** | `Sources/Input/FnKeyMonitor.swift` is Scribe's `KeyMonitor` renamed, unchanged behavior — `CGEventTap` on `flagsChanged` + `.maskSecondaryFn`, `onFnDown`/`onFnUp` callbacks, suppresses the Fn press/release. Scribe's Fn detection is a known-working baseline (the spec: "Prove Fn → speech → transcript works BEFORE editing architecture" — that proof happens on the user's Mac, not in this Linux sandbox). |
| 3 | Speech capture | **REQUIRES MACOS VERIFICATION (code preserved from Scribe)** | `Sources/Input/VoiceCapture.swift` (Scribe's `MicrophoneRouter`, renamed) — CoreAudio device enumeration + `resolvedDeviceID()` + the `.auto`/`.systemDefault`/`.specific(uid)` preference. `Sources/Speech/SpeechTranscriber.swift` (Scribe's `AppleSpeechSession`, renamed) — `AVAudioEngine` + `SFSpeechAudioBufferRecognitionRequest`, audio tap, RMS level, `onPartial`/`onTerminated`. |
| 4 | STT | **REQUIRES MACOS VERIFICATION (code preserved from Scribe)** | Same `SpeechTranscriber`. The trailing-buffer (0.5s after Fn up) + the 2s fallback-timer for `isFinal` that never comes are Scribe's. The transcript is delivered to `handleTermination(.final(text))` → `deliverFinal(text)`. |
| 5 | OMP startup | **REQUIRES MACOS VERIFICATION** | `Sources/Runtime/OmpBinaryDiscovery.swift` searches `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.bun/bin`, then `$PATH` for `dani` then `omp`; persists the resolved path. `Sources/Runtime/OmpRpcProcess.swift` spawns `<binary> --mode rpc`, pipes stdio, line-buffers stdout, waits for the `ready` frame (10s timeout) via a `CheckedContinuation` the first-frame handler resumes. `Sources/Runtime/OmpRpcRuntime.start()` orchestrates discovery + spawn. Not run here — no OMP, no macOS. Run `swift test --filter OmpRpcRuntimeSmokeTests` on a Mac with OMP. |
| 6 | OMP streaming | **REQUIRES MACOS VERIFICATION (decoder unit tests written, not run)** | `Sources/Runtime/OmpEventDecoder.swift` maps OMP JSON → `DaniRunEvent` (ready, prompt ack, prompt_result, agent_start, message_update text_delta, tool_execution_start/end, agent_end terminal + non-terminal, extension_ui_request confirm). `Sources/Runtime/OmpRpcRuntime.readerLoop()` iterates `OmpRpcProcess.stream` and dispatches. `OmpEventDecoderTests.swift` has 30+ cases pinning the contract. The tests are **written**, not **executed** (no swift here). |
| 7 | OMP tool execution | **REQUIRES MACOS VERIFICATION** — handled by OMP, not DANI Desktop | The desktop sends `{"type":"prompt","message":"Open Notes and type …"}`. OMP decides to use the `computer` tool, executes it, emits `tool_execution_start computer` / `tool_execution_end computer`. The desktop maps those to `DaniRunEvent.toolStarted("computer")` / `.toolFinished` → `DaniState.working` → overlay "Working…". Per spec: "If OMP computer use proves inadequate AFTER benchmarking, then we can consider another computer backend. Not before." This is the first benchmark. |
| 8 | Notes execution | **REQUIRES MACOS VERIFICATION** | Depends on OMP computer-use (criterion 7). The desktop's role: send the prompt and watch. The actual Notes-app open + typing is OMP's responsibility. |
| 9 | Verified final state | **REQUIRES MACOS VERIFICATION** | `Tests/DaniTests/ComputerGauntletTests.testOpensNotesAndTypes` verifies `NSWorkspace.runningApplications` contains `com.apple.Notes` after the run — **actual state**, not OMP's claim (per spec). Verifying the typed text inside Notes needs Automation permission (AppleScript) — left as a manual step in `Tests/DaniTests/GAUNTLET.md`. The test skips by default (`DANI_GAUNTLET=1` to enable) because it opens Notes on the host. |
| 10 | Reliability (10-run gauntlet) | **0 / 10 verified** | The gauntlet requires a Mac + OMP + mic + a human. I built the scaffolding: `GAUNTLET.md` (the 12-step MVP acceptance task × 10 runs procedure), `VoiceGauntletTests.swift` (layer 2), `ComputerGauntletTests.swift` (layer 3). I cannot run it here. The user runs `DANI_GAUNTLET=1 swift test --filter Gauntlet` and records the count honestly. |

## What a real Mac verification would look like

On a Mac with OMP installed:

```bash
git clone <dani-desktop> && cd dani-desktop
make build                           # criterion 1
swift test                           # decoder unit tests pass (criterion 6)
swift test --filter OmpRpcRuntimeSmokeTests   # criteria 5, 6 live (skips if no OMP)
make run                             # launches Dani.app
# In the menu bar: Dani → Developer Prompt… (Cmd-D)
#   Type "Reply exactly DANI_OK", Send. Repeat 10×.   ← Milestone 1 (criteria 5, 6)
# In the menu bar: Dani → Settings… (Cmd-,) if needed.
# Hold Fn, say "Reply exactly DANI_VOICE_OK", release.   ← criterion 2, 3, 4
DANI_GAUNTLET=1 swift test --filter VoiceGauntletTests    # criterion (voice)
# Hold Fn, say "Open Notes and type hello from Dani", release. ×10.   ← MVP acceptance
DANI_GAUNTLET=1 swift test --filter ComputerGauntletTests # criteria 7, 8, 9
# Record X / 10.
```

## What was NOT done (honest gaps)

- **No compilation.** `swift build` was never run (no swift here). There may
  be compile errors the user must fix on their Mac — likely candidates:
  Swift 6 strict-concurrency warnings around the `Pipe.readabilityHandler`
  closures in `OmpRpcProcess` (captured `var lineBuffer` mutation), the
  `Mutex` API surface (verify it's `os.Mutex` on macOS 14; if not, switch to
  `OSAllocatedUnfairLock` like Scribe's `AppleSpeechSession`), and
  definite-assignment edge cases in `AppDelegate.submitPrompt`. These are
  routine fixes; the architecture is sound.
- **No runtime verification.** Zero of the 10 criteria were verified by
  execution. The code is written against the OMP RPC docs and Scribe's
  known-working primitives, but "it compiles" / "the server is up" is never
  sufficient evidence of completion — the user must run the gauntlet.
- **The OMP RPC event-shape for `tool_execution_start`** is not explicitly
  documented in `docs/rpc.md` (the doc lists the event name but not the
  payload fields). The decoder tolerates `toolName` / `name` / `tool` fields
  and falls back to `"tool"` — so even if OMP's actual field is different,
  the decoder won't crash (it'll show a generic "tool" label). The user may
  refine the field name after a live run.
- **Login / model picker UI** in Settings is deferred (spec: "eventually").
  Settings has the executable picker (the spec's primary requirement) +
  a status line; provider/model display from `get_state` /
  `get_available_models` / `set_model` is a post-MVP TODO documented in
  `Sources/UI/Settings.swift`.
- **Approvals UI** is plumbed (`DaniRunEvent.needsApproval`, the runtime's
  `approve(requestId:approved:)`, `OmpEventDecoder` mapping
  `extension_ui_request confirm`), but the native "Approve / Cancel" buttons
  aren't wired into the overlay for MVP — the overlay just shows the
  approval prompt text. Per spec: "Initially use OMP's existing approval
  behavior if possible. Later expose approval requests in the native UI."
- **TTS** is deferred (spec: "Do not prioritize TTS. DANI can initially
  complete silently with: Done ✓").

## Bottom line

The architecture, wiring, and tests are in place. **The build and the 10-run
gauntlet require a Mac.** Until they pass there, this is **not
production-ready** — and per the spec, it must not be called that.

```
Build:                    REQUIRES MACOS VERIFICATION
Fn detection:             REQUIRES MACOS VERIFICATION (Scribe baseline)
Speech capture:           REQUIRES MACOS VERIFICATION (Scribe baseline)
STT:                      REQUIRES MACOS VERIFICATION (Scribe baseline)
OMP startup:              REQUIRES MACOS VERIFICATION
OMP streaming:            REQUIRES MACOS VERIFICATION (decoder tests written, not run)
OMP tool execution:       REQUIRES MACOS VERIFICATION (OMP's responsibility)
Notes execution:          REQUIRES MACOS VERIFICATION (OMP computer-use)
Verified final state:     REQUIRES MACOS VERIFICATION (ComputerGauntletTests checks actual state)
Reliability:              0 / 10 verified (gauntlet requires Mac + OMP + mic + human)
```
