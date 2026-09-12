# Dani Desktop agent notes

Package name: `dani-desktop`. App UI name: Dani Bot.
Repo: https://github.com/somdipto/dani-desktop

## Local desktop app (any agent)

Dani Bot is an Electron **desktop** app. Show it on the machine in front of
the person (macOS, Windows, or Ubuntu). Do **not** demo a live hosted
instance, the user's production data, or a Cloud Box.

Needs **Node 24+**, **pnpm** (`packageManager` in `package.json`), and at
least one logged-in agent CLI (`claude`, `codex`, or `grok`).

```sh
git clone https://github.com/somdipto/dani-desktop.git && cd dani-desktop
corepack enable
pnpm install
pnpm dev:server    # harness → 127.0.0.1:8799
pnpm dev           # UI → 127.0.0.1:5199 (keep running)
pnpm dev:desktop   # Electron window — this is the app
```

The tab on port 5199 is not the product. The Electron window is.
Works on = **This computer**. Approval mode **Ask**. Computer-use is CUA on
this host. Browser eval is Webcmd on this machine
([`docs/browser-webcmd.md`](docs/browser-webcmd.md)), not Dani's generic
click-loop.

Installer instead of dev: [`docs/packaging.md`](docs/packaging.md) on that
same OS. Do not cross-build. Do not rebuild on every git push.

## Packaging / installers

Follow [`docs/packaging.md`](docs/packaging.md). Do not rebuild on every push.
First friend-machine build: that file’s table. Later versions: GitHub **Release** after a version bump (`docs/releasing.md`).

## Server / conversation changes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.


## Specs

New product work starts as a spec in [`docs/superpowers/specs/`](docs/superpowers/specs/).
Implement from that spec. Do not start from a vibe prompt.

## Month 1

Friend interviews: [`docs/interview-notes.md`](docs/interview-notes.md).
30-day GitHub release body: [`docs/month-one-report.md`](docs/month-one-report.md).
Browser eval: [`docs/browser-webcmd.md`](docs/browser-webcmd.md).
Keep Cloud Box / Local VM out of the Computer panel.
Next product slice: [`docs/superpowers/specs/2026-09-06-webcmd-browser-destination.md`](docs/superpowers/specs/2026-09-06-webcmd-browser-destination.md).

More specific `AGENTS.md` files override this note within their directories.
