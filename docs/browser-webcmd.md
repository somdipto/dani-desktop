# Browser — Webcmd

Operator note for month-1 interviews and the 30-day report. Not a product destination in Dani Bot yet. Run Webcmd on the **same desktop machine** as Dani Bot — not a live remote browser.

## Install

Node 20.6+. Then:

```
npm install -g @agentrhq/webcmd
webcmd skills add
webcmd doctor
```

Do **not** add `@agentrhq/webcmd` to Dani Bot `package.json` here. Wiring it as the desktop Browser destination is a later task.

## Decision order

1. `webcmd list` (prefer `webcmd list -f json`)
2. Existing compiled command: `webcmd <site> <command>`
3. Else: session + tiny live-browser surface

Do not treat Dani’s generic click-loop as the success path.

## Live surface

Only these verbs:

- `tabs`
- `bind --page`
- `snapshot` (`act` | `tree` | `read`)
- `run`

Unfamiliar site: profile + session, then `browser run` as **one** Playwright program.

Auth: handoff `action_required` + `verify_command`. Do not type passwords into the agent.

If `webcmd doctor` is red, record it as a blocker. Do not invent extra Dani click tools.

## Strategies

PUBLIC, COOKIE, INTERCEPT, UI, LOCAL.

## Source

- https://github.com/agentrhq/webcmd
- https://webcmd.dev/docs/concepts
