# Dani Desktop agent notes

Package name: `dani-desktop`. App UI name: Dani Bot.
Repo: https://github.com/somdipto/dani-desktop

## Packaging / installers

Follow [`docs/packaging.md`](docs/packaging.md). Do not rebuild on every push.
First friend-machine build: that file’s table. Later versions: GitHub **Release** after a version bump (`docs/releasing.md`).

## Server / conversation changes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

More specific `AGENTS.md` files override this note within their directories.
