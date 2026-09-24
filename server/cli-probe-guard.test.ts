// Unit tests for the /api/cli-test executable guard: the fixed allowlist of
// discovered adapters, custom-path explicit selection, canonicalization
// (symlinks/traversal), and the endpoint's dependence on the existing
// request-auth owner-token mutation guard.
import type { IncomingMessage } from "node:http";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCliProbeAllowlist,
  canonicalCliTarget,
  classifyCliProbe,
  cliProbeHead,
} from "./cli-probe-guard.ts";
import { resetPathCacheForTests } from "./env-path.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";

let dir: string;
let savedPath: string | undefined;

beforeEach(() => {
  // Canonical paths are realpaths: on macOS the temp dir lives under the
  // /var -> /private/var symlink, so compare against the resolved directory.
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-probe-guard-")));
  savedPath = process.env.PATH;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  resetPathCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

/** Put `name` on PATH as an executable script; returns its absolute path. */
function fakeCliOnPath(name: string, body = `#!/bin/sh\necho hi\n`): string {
  // Windows PATH lookup only finds names with a PATHEXT extension.
  const p = join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(p, process.platform === "win32" ? "@echo hi\r\n" : body, { mode: 0o755 });
  chmodSync(p, 0o755);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  resetPathCacheForTests();
  return p;
}

describe("cliProbeHead", () => {
  it("takes the executable word; fixed wrapper args stay out of the decision", () => {
    expect(cliProbeHead('"/opt/my tools/cli" --flag x')).toBe("/opt/my tools/cli");
    expect(cliProbeHead("claude")).toBe("claude");
    expect(cliProbeHead("")).toBe("");
  });
});

describe("buildCliProbeAllowlist", () => {
  it("contains every built-in driver's default CLI name", () => {
    const allow = buildCliProbeAllowlist();
    // bare names probe through PATH exactly like a real turn does
    for (const name of ["claude", "codex", "grok"]) expect(allow.has(name), name).toBe(true);
  });

  it("contains the canonical path of a discovered driver-default binary", () => {
    const installed = fakeCliOnPath("codex");
    const allow = buildCliProbeAllowlist();
    expect(allow.has(resolve(installed))).toBe(true);
  });
});

describe("classifyCliProbe", () => {
  it("allowlists a known adapter name with no explicit flag", () => {
    expect(classifyCliProbe("claude", false)).toEqual({ kind: "allowlisted" });
  });

  it("allowlists a discovered adapter by absolute path, even through a symlink", () => {
    const installed = fakeCliOnPath("codex");
    expect(classifyCliProbe(installed, false)).toEqual({ kind: "allowlisted" });
    const link = join(dir, "codex-alias");
    symlinkSync(installed, link);
    // the symlink resolves to the allowlisted file: same binary, same lane
    expect(classifyCliProbe(link, false)).toEqual({ kind: "allowlisted" });
  });

  it("rejects an arbitrary executable for a caller without explicit selection", () => {
    const other = fakeCliOnPath("not-a-known-cli");
    const verdict = classifyCliProbe(other, false);
    expect(verdict.kind).toBe("rejected");
    if (verdict.kind === "rejected") {
      expect(verdict.status).toBe(403);
      expect(verdict.reason).toContain("explicit user selection");
    }
  });

  it("lets an explicitly user-selected custom path through to the probe", () => {
    const other = fakeCliOnPath("not-a-known-cli");
    const verdict = classifyCliProbe(other, true);
    expect(verdict.kind).toBe("custom");
    if (verdict.kind === "custom") expect(verdict.canonical).toBe(resolve(other));
  });

  it("a symlink to a non-allowlisted binary does not inherit allowlisting", () => {
    const target = fakeCliOnPath("some-wrapper");
    const link = join(dir, "wrapper-alias");
    symlinkSync(target, link);
    const verdict = classifyCliProbe(link, false);
    expect(verdict.kind).toBe("rejected");
  });

  it("rejects traversal in the executable", () => {
    for (const cli of ["/usr/bin/../bin/evil", "../bin/evil", "/opt/..\\bin\\evil"]) {
      const verdict = classifyCliProbe(cli, true);
      expect(verdict.kind, cli).toBe("rejected");
      if (verdict.kind === "rejected") {
        expect(verdict.status).toBe(400);
        expect(verdict.reason).toContain("..");
      }
    }
  });

  it("rejects empty input and control characters", () => {
    expect(classifyCliProbe("", false).kind).toBe("rejected");
    expect(classifyCliProbe("   ", false).kind).toBe("rejected");
    expect(classifyCliProbe("/bin/evil\n--version", true).kind).toBe("rejected");
    expect(classifyCliProbe("/bin/e\0vil", true).kind).toBe("rejected");
  });

  it("never treats a fixed wrapper arg as the executable", () => {
    // head is the node binary here, not an adapter: custom lane either way
    const verdict = classifyCliProbe(`${process.execPath} ${join(dir, "x.mjs")} fixed`, false);
    expect(verdict.kind).toBe("rejected");
  });
});

describe("canonicalCliTarget", () => {
  it("resolves symlinks and PATH lookups, null when unresolvable", () => {
    const installed = fakeCliOnPath("codex");
    expect(canonicalCliTarget(installed)).toBe(resolve(installed));
    expect(canonicalCliTarget("codex")).toBe(resolve(installed));
    const link = join(dir, "canon-alias");
    symlinkSync(installed, link);
    expect(canonicalCliTarget(link)).toBe(resolve(installed));
    expect(canonicalCliTarget("definitely-not-installed-xyz")).toBeNull();
  });
});

describe("cli-test owner-token dependence (existing request-auth guard)", () => {
  const OWNER_TOKEN = "per-launch-owner-token";
  let sessions: SessionRegistry;

  beforeEach(() => {
    sessions = new SessionRegistry({ file: join(dir, "sessions.json") });
  });

  function gate(headers: Record<string, string>, method = "POST") {
    const req = { headers, method } as unknown as IncomingMessage;
    return resolveRequestAuth(req, {
      sessions,
      cookieName: "test_session_cookie",
      streamPath: "/api/events",
      url: new URL("http://127.0.0.1:8799/api/cli-test"),
      loopbackMutationToken: OWNER_TOKEN,
    });
  }

  it("denies an untrusted loopback caller without the owner token", () => {
    const result = gate({ host: "127.0.0.1:8799", "content-type": "application/json" });
    expect(result.auth).toBeNull();
    expect(result.status).toBe(403);
  });

  it("admits the desktop app presenting the per-launch owner token", () => {
    const result = gate({
      host: "127.0.0.1:8799",
      "content-type": "application/json",
      "x-danibot-desktop-owner": OWNER_TOKEN,
    });
    expect(result.auth).not.toBeNull();
    expect(result.auth?.kind).toBe("loopback");
  });

  it("rejects a wrong token", () => {
    const result = gate({
      host: "127.0.0.1:8799",
      "content-type": "application/json",
      "x-danibot-desktop-owner": "wrong",
    });
    expect(result.auth).toBeNull();
    expect(result.status).toBe(403);
  });
});
