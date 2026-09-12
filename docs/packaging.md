# Packaging Dani Desktop

Agents: this is the only packaging playbook. Do not invent extra steps.

Repo: `https://github.com/somdipto/dani-desktop.git`  
App window name: **Dani Bot**. Package name: **dani-desktop**.  
Node **24+**, **pnpm** (`packageManager` in `package.json`).

This machine cannot cross-build. Each OS builds only its own installer.

## Run locally as a desktop app (any agent)

Do **not** demo a live hosted instance. On the person's OS:

```sh
corepack enable
pnpm install
pnpm dev:server    # 127.0.0.1:8799
pnpm dev           # 127.0.0.1:5199 — keep running
pnpm dev:desktop   # Electron window — show this
```

All three stay running. The product is the Electron window, not the browser
tab. Computer-use = This computer (CUA). Browser eval = [`docs/browser-webcmd.md`](browser-webcmd.md).

For an installer to leave behind, use the table below on **that same OS**.

## Prefer GitHub Actions (after the first version)

Do **not** rebuild on every git push.

1. Put Mac signing secrets on the repo (see `docs/releasing.md`) if you want signed macOS.
2. **Actions → Prepare next release** (patch) → merge the PR.
   Or bump `package.json` `version` on `main`.
3. **Release** builds Mac + Windows + Ubuntu and opens a draft on this repo.
4. Publish the draft. Installed apps update from `latest.yml` / `latest-mac.yml` / `latest-linux.yml`.

Windows and Linux CI need no signing secrets. Mac CI needs `MAC_CERT_*` and `APPLE_API_KEY_*` or the mac job fails.

## First build on a friend's computer

Clone the **same commit** on each machine. Do not mix SHAs under one version.

```sh
git clone https://github.com/somdipto/dani-desktop.git
cd dani-desktop
corepack enable
pnpm install --frozen-lockfile
```

| Host | Command | Give back from `release/` |
|---|---|---|
| **macOS** + Xcode | `pnpm package:mac` | versioned `.dmg` + `.zip` + `.blockmap` + `latest-mac.yml`. Also copy arm64 dmg → `DaniBot.dmg`, x64 dmg → `DaniBot-intel.dmg`. |
| **Windows x64** | `pnpm package:win` | `DaniBot-<ver>-setup.exe` + `.blockmap` + `latest.yml`. Copy setup exe → `DaniBot-setup.exe`. |
| **Ubuntu 24.04 x86_64** | `pnpm package:linux` | versioned `.deb` + `.AppImage` + `SHA256SUMS-ubuntu-x64.txt` + `latest-linux.yml`. Copy to `DaniBot-amd64.deb` and `DaniBot.AppImage`. |

Check before sending:

- `release/*/resources/ui/index.html` (or Mac `Dani Bot.app/Contents/Resources/ui/index.html`) contains `<title>Dani Bot</title>`
- `app-update.yml` has `owner: somdipto` and `repo: dani-desktop`
- `package.json` version matches the filenames

Upload **all** of those files to **one** GitHub release tag `v<version>` on `somdipto/dani-desktop`. Missing `latest.yml` means Windows installs never auto-update.

Friend interviews after they install: copy [`docs/interview-notes.md`](interview-notes.md) per person. Browser eval: [`docs/browser-webcmd.md`](browser-webcmd.md).

## Agent success criteria

- [ ] Built only on the matching OS
- [ ] Same git SHA as the other platforms for this version
- [ ] Updater yml files included
- [ ] No extra dependencies added
- [ ] Showed the Electron desktop window on the host OS
- [ ] Did not use a live hosted instance
- [ ] Did not claim it works without running the package command
