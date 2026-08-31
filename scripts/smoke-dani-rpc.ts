import { OmpRpcRuntime } from "../src/main/dani/omp-rpc-runtime";

async function main() {
  const runtime = new OmpRpcRuntime({
    command: process.env.DANI_BIN ?? "dani",
    cwd: process.env.HOME,
    args: ["--mode", "rpc", "--no-session", "--allow-home"],
    readyTimeoutMs: 25_000,
  });

  process.stdout.write("[smoke-dani] starting\n");
  await runtime.start();
  if (runtime.health !== "ready") {
    throw new Error(`expected ready, got ${runtime.health}`);
  }

  const state = await runtime.getState();
  process.stdout.write(`[smoke-dani] get_state keys=${Object.keys(state).join(",")}\n`);
  if (Object.keys(state).length === 0) throw new Error("empty get_state");

  await runtime.abort();
  await runtime.stop();
  process.stdout.write("[smoke-dani] ok\n");
}

main().catch((err) => {
  console.error("[smoke-dani] FAIL", err);
  process.exit(1);
});
