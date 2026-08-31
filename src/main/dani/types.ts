export type DaniHealth =
  | "starting"
  | "ready"
  | "degraded"
  | "disconnected"
  | "restarting"
  | "failed";

export type DaniEvent = {
  type: string;
  raw: Record<string, unknown>;
};

export type DaniRuntimeOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
};

export interface DaniRuntime {
  readonly health: DaniHealth;
  start(): Promise<void>;
  stop(): Promise<void>;
  prompt(input: { text: string }): Promise<void>;
  steer(input: { text: string }): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<Record<string, unknown>>;
  getAvailableModels(): Promise<unknown>;
  setModel(provider: string, modelId: string): Promise<void>;
  getLoginProviders(): Promise<unknown>;
  login(providerId: string): Promise<void>;
  subscribe(listener: (event: DaniEvent) => void): () => void;
}
