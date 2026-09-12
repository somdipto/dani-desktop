# Webcmd as desktop Browser destination

> Status: SPEC
> Created: 2026-09-06

## Goal

Make the Computer panel **Browser** destination use Webcmd (`agentrhq/webcmd`): compiled site commands first, tiny live-browser surface (`tabs` / `bind` / `snapshot` / `run`) second. Interview method is already in `docs/browser-webcmd.md`. This spec is the product wiring.

## Success criteria

- [ ] `webcmd list` then existing `webcmd <site> <command>` when a command exists.
- [ ] Unfamiliar site: one `browser run` Playwright program, not one MCP tool per click.
- [ ] Auth handoff is `action_required` + `verify_command`; no typed passwords.
- [ ] Works on picker stays `local` / `browser` / `off`. No Cloud Box / Local VM.
- [ ] Isolated fixture verification per `docs/verification/README.md` before claiming it works.

## Out of scope

- Adding `@agentrhq/webcmd` until this spec is implemented.
- Wrapping every Playwright API as MCP tools.
- Changing Computer panel destinations besides Browser behavior.
- Filling interviews or publishing the 30-day GitHub release.

## Constraints

- Must work with: existing Electron Computer panel Browser tab, Ask approval mode.
- Must NOT require: extra click-loop tools in Dani Bot.
- Time budget: one slice after month-1 interviews exist.

## Open questions

1. Global CLI vs bundled binary vs `npx` inside the desktop app.
2. Whether the embedded Chromium tab remains the watch surface while Webcmd drives Playwright.
