# Dani Bot - first-run install: one command from nothing to a running app.
#
#   irm https://raw.githubusercontent.com/somdipto/dani-desktop/main/install.ps1 | iex
#
# Idempotent: re-running reuses the existing checkout, dependencies and build
# cache, and completes whatever an interrupted run left unfinished.
#   -CheckOnly   verify prerequisites only, change nothing (CI uses this).
param([switch]$CheckOnly)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/somdipto/dani-desktop"
$Branch = "main"
$Dest = if ($env:DANI_INSTALL_DIR) { $env:DANI_INSTALL_DIR } else { "dani-desktop" }
$DataDir = if ($env:DANI_DATA_DIR) { $env:DANI_DATA_DIR } else { Join-Path $HOME ".danibot" }

function Fail([string]$what, [string]$todo) {
  Write-Host "install failed: $what" -ForegroundColor Red
  Write-Host "what to do: $todo"
  Write-Host "logs: the failing step printed its own output above. After first launch, app logs are in `$env:APPDATA\Dani Bot\logs - About > App logs in the app opens that folder."
  exit 1
}

function Check-Prereqs {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is not installed" "install git from https://git-scm.com and re-run this command" }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js is not installed" "install Node 24 or newer from https://nodejs.org and re-run this command" }
  $major = [int](node -p "process.versions.node.split('.')[0]")
  if ($major -lt 24) { Fail "Node $(node -v) is too old" "install Node 24 or newer from https://nodejs.org and re-run this command" }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
      try { corepack enable; corepack prepare pnpm@latest --activate } catch { }
    }
  }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Fail "pnpm is not installed" "run: npm install -g pnpm   (or: corepack enable) and re-run this command" }
  Write-Host "prerequisites ok: git $(git --version), node $(node -v), pnpm $(pnpm --version)"
}

Check-Prereqs
if ($CheckOnly) { exit 0 }

$inCheckout = (Test-Path package.json) -and (Select-String -Path package.json -Pattern '"name": "dani-desktop"' -Quiet)
if ($inCheckout) {
  Write-Host "using the current checkout ($(Get-Location))"
} elseif (Test-Path "$Dest\.git") {
  Write-Host "reusing existing checkout at $Dest (idempotent re-run)"
  Set-Location $Dest
  git fetch origin "+refs/heads/${Branch}:refs/remotes/origin/${Branch}" --quiet 2>$null; git merge --ff-only "origin/$Branch" --quiet 2>$null
  if ($LASTEXITCODE -ne 0) { Write-Host "note: checkout is not fast-forwardable; continuing with what is here" }
} else {
  Write-Host "cloning $RepoUrl ($Branch) into $Dest"
  git clone --branch $Branch --single-branch $RepoUrl $Dest
  if ($LASTEXITCODE -ne 0) { Fail "git clone did not complete" "check your network connection and re-run the same command - it resumes where it stopped" }
  Set-Location $Dest
}

pnpm install
if ($LASTEXITCODE -ne 0) { Fail "dependency install did not complete" "re-run the same command - pnpm resumes from its cache; if a registry error persists, check your network" }
pnpm package:win
if ($LASTEXITCODE -ne 0) { Fail "the Windows package build did not complete" "re-run the same command" }

$artifacts = Get-ChildItem release\*.exe, release\*.zip -ErrorAction SilentlyContinue
if (-not $artifacts) { Fail "the build finished but no installer artifact appeared in release\" "run pnpm package:win by hand and read its output; nothing was installed" }
Write-Host ""
Write-Host "SUCCESS - Dani Bot packaged. Verified artifact(s):" -ForegroundColor Green
$artifacts | ForEach-Object { Write-Host "  $($_.FullName)" }
Write-Host ""
Write-Host "next: run the installer (.exe), then launch Dani Bot."
Write-Host "first launch opens the setup wizard; app data lives in $DataDir, app logs in `$env:APPDATA\Dani Bot\logs (About > App logs)."
