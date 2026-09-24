import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGED_OPENCODE_PROMPT_TIMEOUT_MS, managedRuntimeReadiness, parseManagedRuntimeManifest, safeManagedRuntimeRelativePath, safeManagedRuntimeSymlinkTarget } from "./managed-runtime.ts";
const valid = {
  manifestVersion: 1, name: "hermes-runtime-payload", target: "linux-x64", version: "0.21.4",
  upstreamCommit: "d337b736aa1e8ebecfab043842d13e4a2d2f48a3", archiveSha256: "b".repeat(64),
  archiveSize: 86_596_540, unpackedSize: 250_270_424, format: "tar.gz", executableRelPath: "bin/hermes-acp",
  probe: { argv: ["probe/run-probe.sh"], protocol: "acp-jsonrpc-stdio: initialize", expectedVersion: "0.21.4", expectedAgentName: "hermes-agent" },
  noticeRelPath: "NOTICE", sbomRelPath: "SBOM.cdx.json", degradations: ["no-pillow-heif"],
};
describe("managed runtime manifest", () => {
  it("accepts the real manifest-v1 payload contract", () => {
    const fixture = process.env.HERMES_MANIFEST_FIXTURE;
    const manifest = fixture ? JSON.parse(readFileSync(fixture, "utf8")) : valid;
    expect(parseManagedRuntimeManifest(manifest)).toMatchObject({ manifestVersion: 1, name: "hermes-runtime-payload", target: "linux-x64" });
  });
  it("rejects missing integrity, provenance, probe, and legal metadata fields", () => {
    for (const field of ["upstreamCommit", "archiveSha256", "archiveSize", "unpackedSize", "probe", "noticeRelPath", "sbomRelPath"]) {
      const payload = { ...valid } as Record<string, unknown>; delete payload[field];
      expect(() => parseManagedRuntimeManifest(payload), field).toThrow();
    }
  });
  it("requires an explicit runtime-specific ACP agent name", () => {
    expect(() => parseManagedRuntimeManifest({ ...valid, probe: { ...valid.probe, expectedAgentName: undefined } })).toThrow();
    expect(parseManagedRuntimeManifest({ ...valid, name: "opencode-runtime-payload", probe: { ...valid.probe, expectedAgentName: "OpenCode" } })).toMatchObject({ probe: { expectedAgentName: "OpenCode" } });
  });
  it("rejects unsafe payload paths", () => {
    for (const path of ["../hermes", "bin/../hermes", "/bin/hermes", "C:\\hermes.exe", "bin//hermes"]) expect(() => safeManagedRuntimeRelativePath(path), path).toThrow();
    expect(safeManagedRuntimeRelativePath("bin/hermes")).toBe("bin/hermes");
  });
  it("allows contained relative symlinks and rejects absolute or escaping targets", () => {
    expect(safeManagedRuntimeSymlinkTarget("/payload", "/payload/runtime/bin/python", "python3.11")).toBe(resolve("/payload/runtime/bin/python3.11")); // native path: D:\\payload\\... on Windows
    expect(safeManagedRuntimeSymlinkTarget("/payload", "/payload/terminfo/x/xterm", "../../share/terminfo/x/xterm")).toBe(resolve("/payload/share/terminfo/x/xterm"));
    for (const target of ["/usr/bin/python", "C:\\Python\\python.exe", "../../../../outside"]) {
      expect(() => safeManagedRuntimeSymlinkTarget("/payload", "/payload/runtime/bin/python", target), target).toThrow();
    }
  });
  it("requires both runtimes and the model route before task-ready", () => {
    expect(managedRuntimeReadiness({ hermes: true, opencode: false, modelRoute: "ready" })).toMatchObject({ runtime: { state: "error", hermes: true, opencode: false }, taskReady: false });
    expect(managedRuntimeReadiness({ hermes: true, opencode: true, modelRoute: "checking" })).toMatchObject({ runtime: { state: "ready" }, modelRoute: { state: "checking" }, taskReady: false });
    expect(managedRuntimeReadiness({ hermes: true, opencode: true, modelRoute: "ready" })).toMatchObject({ runtime: { state: "ready" }, modelRoute: { state: "ready" }, taskReady: true });
  });
  it("allows the free route enough time for a real model turn", () => {
    expect(MANAGED_OPENCODE_PROMPT_TIMEOUT_MS).toBe(300_000);
  });
  it("requires explicit degradation entries for mac-x64", () => {
    expect(() => parseManagedRuntimeManifest({ ...valid, target: "darwin-x64", degradations: [] })).toThrow();
    expect(parseManagedRuntimeManifest({ ...valid, target: "darwin-x64", degradations: ["host probe pending"] })).toBeTruthy();
  });
});
