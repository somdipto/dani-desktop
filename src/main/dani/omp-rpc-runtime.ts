import { DaniRpcClient } from "./rpc-client";
import type { DaniEvent, DaniHealth, DaniRuntime, DaniRuntimeOptions } from "./types";

export class OmpRpcRuntime implements DaniRuntime {
  private readonly client: DaniRpcClient;

  constructor(opts: DaniRuntimeOptions = {}) {
    this.client = new DaniRpcClient(opts);
  }

  get health(): DaniHealth {
    return this.client.health;
  }

  start(): Promise<void> {
    return this.client.start();
  }

  stop(): Promise<void> {
    return this.client.stop();
  }

  subscribe(listener: (event: DaniEvent) => void): () => void {
    return this.client.subscribe(listener);
  }

  async prompt(input: { text: string }): Promise<void> {
    await this.client.send("prompt", { message: input.text });
  }

  async steer(input: { text: string }): Promise<void> {
    await this.client.send("steer", { message: input.text });
  }

  async abort(): Promise<void> {
    await this.client.send("abort");
  }

  async getState(): Promise<Record<string, unknown>> {
    const res = await this.client.send("get_state");
    return (res.data as Record<string, unknown>) ?? {};
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.client.send("get_available_models");
    return res.data;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.client.send("set_model", { provider, modelId });
  }

  async getLoginProviders(): Promise<unknown> {
    const res = await this.client.send("get_login_providers");
    return res.data;
  }

  async login(providerId: string): Promise<void> {
    await this.client.send("login", { providerId });
  }
}
