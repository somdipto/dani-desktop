import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { normalizeRpcFrame } from "./events";
import type { DaniEvent, DaniHealth, DaniRuntimeOptions } from "./types";

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
};

export class DaniRpcClient {
  health: DaniHealth = "disconnected";
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private stderr = "";
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private listeners = new Set<(e: DaniEvent) => void>();
  private ready: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: DaniRuntimeOptions = {}) {}

  getStderr(): string {
    return this.stderr;
  }

  subscribe(listener: (event: DaniEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("DANI RPC already started");
    this.health = "starting";
    const command = this.opts.command ?? "dani";
    const args = this.opts.args ?? ["--mode", "rpc", "--no-session"];
    const child = spawn(command, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const readyTimeout = this.opts.readyTimeoutMs ?? 20_000;
    const { promise: readyPromise, resolve, reject } = Promise.withResolvers<void>();
    this.ready = { resolve, reject };
    this.readyTimer = setTimeout(() => {
      reject(new Error(`DANI RPC ready timed out after ${readyTimeout}ms`));
    }, readyTimeout);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-65_536);
    });
    child.on("error", (err) => {
      this.fail(err);
    });
    child.on("exit", (code, signal) => {
      const err = new Error(`DANI RPC exited (code=${code} signal=${signal})`);
      this.fail(err);
    });

    try {
      await readyPromise;
      this.health = "ready";
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.clearReady(new Error("DANI RPC stopped"));
    this.rejectAll(new Error("DANI RPC stopped"));
    if (!child || child.exitCode !== null || child.signalCode) {
      this.health = "disconnected";
      return;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000);
    await promise;
    this.health = "disconnected";
  }

  send(type: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.child || this.health !== "ready") {
      return Promise.reject(new Error(`DANI RPC not ready (${this.health})`));
    }
    const id = `req_${this.nextId++}`;
    const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
    this.pending.set(id, { resolve, reject });
    this.child.stdin.write(JSON.stringify({ id, type, ...extra }) + "\n", (err) => {
      if (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
    return promise;
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.onFrame(frame);
    }
  }

  private onFrame(frame: Record<string, unknown>) {
    if (frame.type === "ready") {
      this.health = "ready";
      if (this.ready) {
        this.ready.resolve();
        this.clearReady();
      }
      return;
    }
    if (frame.type === "response") {
      const id = typeof frame.id === "string" ? frame.id : "";
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (frame.success === false) {
        pending.reject(new Error(typeof frame.error === "string" ? frame.error : "RPC error"));
        return;
      }
      pending.resolve(frame);
      return;
    }
    const event = normalizeRpcFrame(frame);
    if (event) for (const listener of this.listeners) listener(event);
  }

  private fail(err: Error) {
    if (!this.child) return;
    this.health = "failed";
    this.clearReady(err);
    this.rejectAll(err);
    this.child = null;
  }

  private clearReady(err?: Error) {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (err) this.ready?.reject(err);
    this.ready = null;
  }

  private rejectAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
