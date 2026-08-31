# Implementation status

| Component | Status | Notes |
|---|---|---|
| Forensics / current-state | COMPLETE | `docs/architecture/current-state.md` |
| Target architecture | COMPLETE | `docs/architecture/target-state.md` |
| Migration plan | COMPLETE | `docs/architecture/migration-plan.md` |
| DaniRuntime + OMP RPC adapter | PARTIAL | `src/main/dani/*` — start/stop/prompt/get_state. Not wired to UI. |
| Voice → DANI | NOT STARTED | Phase 4 |
| Event normalizer → notch/TTS | NOT STARTED | Phase 5 |
| ComputerUseProvider | NOT STARTED | Phase 6 — nut.js wrap first |
| Cua Driver | NOT STARTED | Blocked on TCC embedding research |
| Observe/act/verify loop | NOT STARTED | Phase 7 |
| Auth via DANI | NOT STARTED | Phase 8 |
| Approval broker | NOT STARTED | Phase 9 |
| Mission JSON | NOT STARTED | Phase 10 |
| AgentSession identity | NOT STARTED | Phase 11 |
| Remove OpenDex brain | NOT STARTED | After Phase 4–8 work |
| HOLD Fn | NOT STARTED | Electron cannot bind Fn; hold-to-talk on accelerator first |
| Clicky | N/A | Explicitly out |
| OpenMausBot as runtime | N/A | Explicitly out |
