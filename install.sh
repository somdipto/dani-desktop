#!/bin/sh
# Dani Bot - first-run install: one command from nothing to a running app.
#
#   curl -fsSL https://raw.githubusercontent.com/somdipto/dani-desktop/main/install.sh | sh
#
# Idempotent: re-running reuses the existing checkout, dependencies and build
# cache, and completes whatever an interrupted run left unfinished.
#   --check   verify prerequisites only, change nothing (CI uses this).
set -eu

REPO_URL="https://github.com/somdipto/dani-desktop"
BRANCH="main"
DEST="${DANI_INSTALL_DIR:-dani-desktop}"
DATA_DIR="${DANI_DATA_DIR:-${HOME:-/tmp}/.danibot}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install failed: %s\n' "$1" >&2
  printf 'what to do: %s\n' "$2" >&2
  printf 'logs: the failing step printed its own output above. After first launch, app logs are in ~/Library/Logs/Dani Bot (macOS) or ~/.config/Dani Bot/logs (Linux) - About > App logs in the app opens that folder.\n' >&2
  exit 1
}

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

check_prereqs() {
  command -v git >/dev/null 2>&1 || fail "git is not installed" "install git (macOS: xcode-select --install; Ubuntu: sudo apt install git; Windows: https://git-scm.com) and re-run this command"
  command -v node >/dev/null 2>&1 || fail "Node.js is not installed" "install Node 24 or newer from https://nodejs.org and re-run this command"
  [ "$(node_major)" -ge 24 ] || fail "Node $(node -v 2>/dev/null || echo '?') is too old" "install Node 24 or newer from https://nodejs.org and re-run this command"
  if ! command -v pnpm >/dev/null 2>&1; then
    # Node 24 ships corepack; enabling it provides pnpm without a global npm install.
    if command -v corepack >/dev/null 2>&1; then
      corepack enable >/dev/null 2>&1 || true
      corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
    fi
  fi
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is not installed" "run: npm install -g pnpm   (or: corepack enable) and re-run this command"
  say "prerequisites ok: git $(git --version | awk '{print $3}'), node $(node -v), pnpm $(pnpm --version)"
}

in_checkout() {
  [ -f package.json ] && grep -q '"name": "dani-desktop"' package.json 2>/dev/null
}

prepare_checkout() {
  if in_checkout; then
    say "using the current checkout ($(pwd))"
    return
  fi
  if [ -d "$DEST/.git" ]; then
    say "reusing existing checkout at $DEST (idempotent re-run)"
    cd "$DEST"
    git fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" --quiet 2>/dev/null && git merge --ff-only "origin/$BRANCH" --quiet 2>/dev/null \
      || say "note: checkout is not fast-forwardable; continuing with what is here"
  else
    say "cloning $REPO_URL ($BRANCH) into $DEST"
    git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$DEST" \
      || fail "git clone did not complete" "check your network connection and re-run the same command - it resumes where it stopped"
    cd "$DEST"
  fi
}

build_and_package() {
  pnpm install || fail "dependency install did not complete" "re-run the same command - pnpm resumes from its cache; if a registry error persists, check your network"
  case "$(uname -s)" in
    Darwin)
      pnpm package:mac || fail "the macOS package build did not complete" "re-run the same command; Swift/Xcode command line tools are required (xcode-select --install)"
      ;;
    Linux)
      pnpm package:linux || fail "the Linux package build did not complete" "re-run the same command; see docs/linux-desktop.md for Ubuntu prerequisites"
      ;;
    *)
      fail "this platform is not supported by install.sh" "on Windows use the PowerShell command from the README (install.ps1)"
      ;;
  esac
}

success_check() {
  artifacts=""
  case "$(uname -s)" in
    Darwin) artifacts=$(ls release/*.dmg release/*.zip 2>/dev/null || true) ;;
    Linux)  artifacts=$(ls release/*.deb release/*.AppImage 2>/dev/null || true) ;;
  esac
  [ -n "$artifacts" ] || fail "the build finished but no installer artifact appeared in release/" "run pnpm package:mac or pnpm package:linux by hand and read its output; nothing was installed"
  say ""
  say "SUCCESS - Dani Bot packaged. Verified artifact(s):"
  printf '%s\n' "$artifacts" | sed 's/^/  /'
  say ""
  case "$(uname -s)" in
    Darwin) say "next: open the .dmg and drag Dani Bot to Applications, then launch it." ;;
    Linux)  say "next: sudo apt install ./<file>.deb   (or chmod +x the .AppImage and run it)" ;;
  esac
  case "$(uname -s)" in
    Darwin) say "first launch opens the setup wizard; app data lives in $DATA_DIR, app logs in ~/Library/Logs/Dani Bot (About > App logs)." ;;
    Linux)  say "first launch opens the setup wizard; app data lives in $DATA_DIR, app logs in ~/.config/Dani Bot/logs (About > App logs)." ;;
  esac
}

check_prereqs
[ "$CHECK_ONLY" -eq 1 ] && exit 0
prepare_checkout
build_and_package
success_check
