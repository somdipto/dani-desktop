# DANI Desktop Acceptance Gauntlet

The spec defines exactly ONE end-to-end acceptance task and a reliability bar:
10 / 10 consecutive successful runs on the development Mac. This file is the
manual procedure. The Swift scaffolding in `VoiceGauntletTests.swift` and
`ComputerGauntletTests.swift` covers the OMP-side programmatically (skip by
default, enable via `DANI_GAUNTLET=1`); the Fn + mic side is human-driven and
documented here.

## Prerequisites

- macOS 14+ (Tahoe recommended for Apple Intelligence STT).
- OMP installed (`omp --mode rpc` works) and a provider+model configured, OR
  the DANI CLI wrapper (`dani --mode rpc`).
- DANI Desktop built and running (`make run` from the repo root).
- Accessibility granted (System Settings → Privacy & Security →
  Accessibility → Dani ON).
- Microphone + Speech Recognition granted (System Settings → Privacy &
  Security → Microphone / Speech Recognition → Dani ON).
- A quiet room and a working mic (check the menubar Microphone submenu).

## Three test layers (per spec)

1. **Runtime smoke** — automated, `swift test --filter OmpRpcRuntimeSmokeTests`.
   Prompts `Reply exactly DANI_RUNTIME_OK` and verifies ready → prompt ack →
   text → `agent_end` (terminal). Skips when OMP isn't installed.

2. **Voice gauntlet** — manual Fn + mic. Hold Fn, say the phrase, release.
   Verify the overlay shows `Understanding… → Working… → Done ✓` and OMP's
   response. The OMP-side is exercised programmatically in
   `VoiceGauntletTests.testVoicePromptReachesOMP`; the Fn side is below.

3. **Computer gauntlet** — OMP computer-use. Prompt OMP to open Notes and
   type. Verify the actual resulting application state, not just OMP's
   claim of success.

---

## MVP acceptance task (run 10 times)

> User holds Fn. Says: **"Open Notes and type hello from Dani"**. Releases Fn.

Required (per spec):

1. Fn down detected (`[fn] down` in Console)
2. recording begins (`[audio] recording`)
3. Fn up detected (`[fn] up`)
4. recording finalizes
5. transcript produced (`[stt] "open notes and type hello from dani"`)
6. transcript sent to OMP (`[omp] prompt sent (voice)`)
7. OMP agent starts (`[omp] agent_start`)
8. OMP computer tool executes (`[omp] tool_execution_start computer`)
9. Notes opens
10. exact text "hello from Dani" appears in Notes
11. OMP completes (`[omp] agent_end`)
12. desktop shows Done (`[dani] done`, overlay shows `Done ✓`)

**Pass criterion**: all 12 steps complete, end-to-end, with no manual
intervention. Run 10 times; record the count. Report `X / 10` honestly.

### How to run one iteration

1. Open Notes (or don't — part of the test is that OMP opens it). Focus any
   app with a text field if you want to see the typed text land somewhere
   other than a fresh Notes window.
2. Press and **hold** the Fn key on the DANI Mac.
3. Say, clearly: *"Open Notes and type hello from Dani"*.
4. **Release** Fn.
5. Watch the DANI overlay: `Understanding…` → `Working…` → `Done ✓`.
6. Verify Notes is open (Dock, Cmd-Tab, or `osascript -e 'tell application
   "System Events" to get name of every process whose background only is
   false' | tr ',' '\n' | grep -i notes`).
7. Verify the text "hello from Dani" is present in the frontmost Notes
   document.
8. Open Console.app, filter process = `Dani`, and confirm the trace shows
   the 12 steps above in order with no `[dani] failed` line.
9. Record PASS or FAIL for this iteration. If FAIL, note the first step
   that didn't complete.

### Reliability

After 10 iterations, report:

```
Reliability: X / 10 successful end-to-end runs
```

If X < 10, the spec is explicit: **do not call it production-ready**. Stop
and fix the failing layer; do not stack new features on top of a broken
layer.

---

## Voice gauntlet (layer 2, isolated)

If the full MVP task fails, isolate the voice layer first:

1. Hold Fn. Say: *"Reply exactly DANI_VOICE_OK"*. Release Fn.
2. The overlay should show `Understanding… → Done ✓`.
3. Console should show `[stt] "reply exactly dani voice ok"` then
   `[omp] prompt sent (voice)` then `[omp] agent_end`.
4. The OMP response text should contain `DANI_VOICE_OK`.

This isolates Fn→record→transcribe→OMP→respond without computer-use. If
this fails, the breakage is in the voice path (Fn detection, STT, or the
runtime). If only the full MVP task fails, the breakage is in OMP
computer-use — which is OMP's responsibility, not DANI Desktop's.

## Computer gauntlet (layer 3, isolated)

To verify OMP computer-use independently of voice:

1. Open the Developer Prompt panel (menu bar → Dani → Developer Prompt…, or
   Cmd-D).
2. Type: `Open Notes and type DANI COMPUTER OK`. Press Send.
3. Verify Notes opens and the text "DANI COMPUTER OK" is typed.
4. Verify actual state (Notes running + text present), not just the panel
   showing `Done ✓`.

This exercises `Swift UI → OmpRpcRuntime → OMP → model → computer tool →
macOS` directly, bypassing Fn/STT. If this fails but the voice gauntlet
passes, the issue is OMP's computer tool — fix in OMP, not DANI Desktop.
