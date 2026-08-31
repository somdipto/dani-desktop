# Migration plan

Surgical. No rewrite. Uncommitted fork work stays. Rollback = feature-flag the old `streamChat` path until Phase 4 acceptance passes.

Flag: `config.brain = "opendex" | "dani"` (default `"dani"` once RPC handshake works; `"opendex"` is the rollback).

## Keep (untouched unless listed)

- Window model, notch, overlay, tray, hide-not-close
- Preload/IPC security pattern
- STT engines, sentence TTS
- `screen-capture.ts`, nut.js skill internals (wrapped, not deleted)
- Config store encryption
- Recent hardening (mergeConfig, caps, timeouts, openExternal whitelist)

## Modify

| Module | Change |
|---|---|
| `src/main/index.ts` | Spawn/supervise DANI; IPC for runtime events; PTT hold/release |
| `src/main/ipc/channels.ts` | Add dani event/command channels; keep chat channels until cutover |
| `src/preload/index.ts` + `opendex.d.ts` | Expose `dani.prompt` / events; do not expose RPC |
| `src/renderer/src/lib/dex/use-dex.ts` | Thinking branch → DaniRuntime instead of `opendex.chat()` when flag on |
| `src/renderer/.../provider-picker.tsx` | Drive DANI login/models, not OpenDex secrets |
| `src/main/agent/permissions.ts` | Intent approval, not per-click CU |

## Replace (after replacement works)

- `streamChat` critical path
- `resolve-model.ts` as user-facing provider
- OpenCode Zen provider entry
- Realtime as default voice mode

## New modules

```
src/main/dani/
  types.ts              # DaniRuntime, DaniEvent, health
  process-manager.ts    # spawn dani --mode rpc, backoff
  rpc-client.ts         # NDJSON frames, correlation ids
  omp-rpc-runtime.ts    # DaniRuntime impl
  events.ts             # RPC → canonical events
  host-tools.ts         # set_host_tools + dispatch

src/main/computer/
  types.ts              # ComputerUseProvider
  nut-provider.ts       # wrap existing skill
  cua-provider.ts       # later

src/main/mission/
  store.ts              # JSON file, tiny Mission record
```

Ponytail: no extra factories. One runtime impl. One CU impl until Cua ships.

## Tests required after each phase

There is almost no suite today. Add **small node tests** next to the new modules (no Electron) plus existing `pnpm typecheck`. Do not invent a giant harness.

---

### Phase 3 — DANI runtime adapter

**Do:** spawn `dani --mode rpc`, NDJSON client, health, start/stop/prompt/abort, stderr capture.

**Verify:** node test: start → `get_state` → abort → stop. Kill child → health `failed`. Malformed line ignored, not crash.

**Rollback:** module unused; app behavior unchanged.

**Blocked if:** `dani` not on PATH in packaged app — ship path config + look up `/usr/local/bin/dani`.

---

### Phase 4 — Voice transcript → DANI

**Do:** when `brain=dani`, `useDex` sends STT/text to `DaniRuntime.prompt` instead of `chat()`. Keep STT/TTS. Inject a short spoken-output system append via DANI `--append-system-prompt` or first prompt prefix.

**Verify:** typed “What files are in my Downloads folder?” returns text from DANI. Spoken path uses same function.

**Rollback:** `brain=opendex`.

---

### Phase 5 — Streaming + UI state

**Do:** normalize RPC events → `idle/listening/thinking/working/needs_user/done/error`. Stream assistant text into existing sentence buffer/TTS. Abort maps to `DaniRuntime.abort()`.

**Verify:** deltas speak; Stop hotkey aborts; reconnect after DANI crash shows error, not hang.

---

### Phase 6 — ComputerUseProvider (nut.js first)

**Do:** extract nut.js + screen-capture behind `ComputerUseProvider`. Register host tools on DANI. Cua research happens here (read current Cua Electron/TCC docs) — **do not guess**. Cua impl only after that evidence.

**Verify:** unit/smoke: screenshot, click, type (existing skill behavior). Host-tool round trip: DANI calls `computer.screenshot`, desktop returns image/text.

---

### Phase 7 — Observe → act → observe loop

**Do:** host tools for observe/listWindows/openApp if missing from nut wrapper. Prompt DANI to verify resulting state. No per-click approval.

**Verify:** gauntlet task 1 (Notes) and task 4 (desktop file) manually.

---

### Phase 8 — Auth via DANI

**Do:** Settings model picker calls `get_login_providers` / `login` / `set_model`. Open browser for OAuth via existing `safeOpenExternal`. Remove OpenDex LLM secret fields from product path. Keep TTS/STT secrets.

**Verify:** enumerate providers; one login; models list; restart still authenticated; renderer never logs secrets.

---

### Phase 9 — Approval broker

**Do:** map DANI tool approval / desktop policy → existing permission window. Intent-level (delete/send/pay), not click.

**Verify:** delete-file gauntlet (task 5) prompts once.

---

### Phase 10 — Mission JSON

**Do:** on each prompt, create/update `Mission` in userData. Notch shows goal + status. Survive app restart.

**Verify:** restart mid-mission → status still `working` or `done`.

---

### Phase 11 — AgentSession id

**Do:** store `runtimeSessionId` from `get_state`. Do not build A2A.

---

### Phase 12 — Cleanup

**Do:** only after Phases 4–8 work: delete unused `streamChat` path, Zen OpenCode provider, dead IPC. Keep nut.js until Cua is default. Keep realtime code isolated (not deleted until unused).

---

## Talk gesture (parallel, small)

1. Change PTT from toggle to **keydown listen / keyup submit** for the registered accelerator.
2. Fn hold = later native tap. Do not block Phases 3–5 on Fn.

## Gauntlet (after Phase 7)

1. Open Notes, type `Dani test successful`
2. Open System Settings
3. Safari search OpenAI
4. Create `~/Desktop/dani-test.txt` with `hello world`
5. Delete that file (approval)
6. Interrupt: “Stop. Don't submit anything.”

## Out of scope (YAGNI)

- Multi-harness discovery (OpenCode/Claude/Kilo/Codex as brains)
- Clicky / OpenMausBot as dependencies
- Full A2A mesh
- Kubernetes-grade supervision
- Replacing themes
- Cua before docs prove TCC-safe embedding

## Commit slices (when committing)

Do not one-shot. Suggested:

1. `docs: architecture current/target/migration`
2. `feat: Dani RPC process adapter`
3. `feat: route voice/text prompts to DANI`
4. `feat: normalize DANI events for notch/TTS`
5. `feat: ComputerUseProvider host tools`
6. `feat: DANI login/models in Settings`
7. `refactor: remove OpenDex agent loop from critical path`
