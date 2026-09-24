import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spec 080 R1 + design contract: the README's one-command install lines are
// tested verbatim against install.sh / install.ps1 - docs and scripts cannot
// drift. Also exercises install.sh --check against stub toolchains so the
// prerequisite gate's behavior (not just its text) is pinned.

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const installSh = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const installPs1 = readFileSync(new URL("../install.ps1", import.meta.url), "utf8");

const SH_COMMAND = "curl -fsSL https://raw.githubusercontent.com/somdipto/dani-desktop/main/install.sh | sh";
const PS_COMMAND = "irm https://raw.githubusercontent.com/somdipto/dani-desktop/main/install.ps1 | iex";

function stubBin(entries) {
  const dir = mkdtempSync(join(tmpdir(), "dani-install-stub-"));
  for (const [name, body] of Object.entries(entries)) {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  return dir;
}

function runCheck(env) {
  try {
    const out = execFileSync("/bin/sh", ["install.sh", "--check"], { cwd: new URL("..", import.meta.url).pathname, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

// install.sh is the macOS/Linux installer and these cases execute it with sh.
// Windows runners have no sh and use install.ps1 instead, so they are skipped
// there (skipped, not faked).
const posixIt = it.skipIf(process.platform === "win32");

describe("spec 080 one-command install", () => {
  it("failure and success text names the real app log locations, never a logs dir under the data dir", () => {
    // The desktop app writes logs to the Electron logs path (pinned in
    // electron/main.mjs: ~/Library/Logs/Dani Bot on macOS, appData/Dani
    // Bot/logs elsewhere). Nothing writes ~/.danibot/logs - the scripts must
    // not send users to a directory that never exists.
    expect(installSh).not.toContain("$DATA_DIR/logs");
    expect(installPs1).not.toContain("$DataDir\\logs");
    expect(installSh).toContain("Library/Logs/Dani Bot");
    expect(installSh).toContain(".config/Dani Bot/logs");
    expect(installPs1).toContain("APPDATA\\Dani Bot\\logs");
  });

  it("documents exactly one command per platform at the top of Quick start", () => {
    expect(readme).toContain(SH_COMMAND);
    expect(readme).toContain(PS_COMMAND);
    const quickStart = readme.indexOf("## Quick start");
    const shAt = readme.indexOf(SH_COMMAND);
    const psAt = readme.indexOf(PS_COMMAND);
    const manualAt = readme.indexOf("**Or step by step, from source:**");
    expect(quickStart).toBeGreaterThanOrEqual(0);
    expect(shAt).toBeGreaterThan(quickStart);
    expect(psAt).toBeGreaterThan(quickStart);
    expect(manualAt).toBeGreaterThan(shAt);
  });

  it("README commands resolve to scripts that exist and match their embedded URLs", () => {
    for (const file of ["install.sh", "install.ps1"]) {
      expect(existsSync(new URL(`../${file}`, import.meta.url))).toBe(true);
    }
    // The scripts publish the same raw-URL branch the README points at, so a
    // branch rename breaks this test instead of the install command.
    expect(installSh).toContain('BRANCH="main"');
    expect(installPs1).toContain('$Branch = "main"');
    expect(installSh).toContain("raw.githubusercontent.com/somdipto/dani-desktop/main/install.sh");
    expect(installPs1).toContain("raw.githubusercontent.com/somdipto/dani-desktop/main/install.ps1");
  });

  posixIt("install.sh is valid sh syntax and install.ps1 carries the same contract markers", () => {
    execFileSync("sh", ["-n", "install.sh"], { cwd: new URL("..", import.meta.url).pathname });
    for (const marker of ["SUCCESS - Dani Bot packaged", "install failed:", "what to do:", "idempotent"]) {
      expect(installSh).toContain(marker);
      expect(installPs1).toContain(marker);
    }
  });

  posixIt("--check accepts a complete toolchain and prints what it found", () => {
    const bin = stubBin({
      git: "#!/bin/sh\necho 'git version 2.46.0'\n",
      node: "#!/bin/sh\nif [ \"$1\" = \"-p\" ]; then echo 24; else echo v24.8.0; fi\n",
      pnpm: "#!/bin/sh\necho 10.0.0\n",
    });
    const result = runCheck({ PATH: `${bin}:/usr/bin:/bin`, HOME: "/tmp/install-test-home" });
    expect(result.code).toBe(0);
    expect(result.out).toContain("prerequisites ok");
  });

  posixIt("--check refuses Node older than 24 with an actionable reason", () => {
    const bin = stubBin({
      git: "#!/bin/sh\necho 'git version 2.46.0'\n",
      node: "#!/bin/sh\nif [ \"$1\" = \"-p\" ]; then echo 22; else echo v22.1.0; fi\n",
      pnpm: "#!/bin/sh\necho 10.0.0\n",
    });
    const result = runCheck({ PATH: `${bin}:/usr/bin:/bin`, HOME: "/tmp/install-test-home" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("too old");
    expect(result.out).toContain("Node 24");
  });

  posixIt("--check reports every missing prerequisite instead of a bare crash", () => {
    const result = runCheck({ PATH: "/nonexistent", HOME: "/tmp/install-test-home" });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/git is not installed|Node\.js is not installed/);
    expect(result.out).toContain("what to do:");
  });
});
