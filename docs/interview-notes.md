# Interview notes — Dani Bot (month 1)

Date:
Person (first name only):
OS: macOS / Windows / Ubuntu
Install used: packaged desktop / `pnpm dev:desktop` / GitHub release (not a live hosted instance)
Where shown: this machine / next stop (same desktop app)

## Setup
- Could they install the **desktop app** on this OS? What blocked them?
- Engine used (Claude / Codex / ACP / pi / other):
- Approval mode (must be Ask for computer-use):

## This computer
- Works on = This computer?
- Did the 16:10 pane show the host screen or “Show this screen”?
- Did Allow / Deny appear **in chat** after a computer tool (not on the computer icon)?
- CUA granted? (macOS Screen Recording + Accessibility / Linux local-control enable)

## Browser (Webcmd only)
Do not test Dani’s generic click-loop as the success path.
- Installed `@agentrhq/webcmd`? `webcmd doctor` green?
- Did the agent `webcmd list -f json` and reuse a site command when one existed?
- Unfamiliar site: profile + session, then `browser run` as **one** Playwright program?
- Auth: handoff `action_required` + `verify_command` (no typed passwords)?

## Phone
- QR started with `danibot://pair`?
- Companion rebuild installed? Scan opened Dani Bot?

## Quote / blocker
One sentence they would tell a friend. One blocker.
