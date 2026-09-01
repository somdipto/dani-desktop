import { OmpRpcRuntime } from "../src/main/dani/omp-rpc-runtime";

async function main() {
  const modelArg = process.argv[2]; // e.g. "lvapi/mimo-v2.5"
  const args = ["--mode", "rpc", "--no-session", "--allow-home"];
  if (modelArg) args.push("--model", modelArg);

  const runtime = new OmpRpcRuntime({
    command: process.env.DANI_BIN ?? "dani",
    cwd: process.env.HOME,
    args,
    readyTimeoutMs: 90_000,
  });

  process.stdout.write(`[smoke-prompt] starting (model=${modelArg ?? "default"})...\n`);
  await runtime.start();
  if (runtime.health !== "ready") throw new Error(`expected ready, got ${runtime.health}`);
  process.stdout.write("[smoke-prompt] runtime ready\n");

  // Get available models
  try {
    const models = await runtime.getAvailableModels();
    const modelList = models as Record<string, unknown>;
    if (modelList && typeof modelList === "object") {
      const providers = Object.keys(modelList);
      process.stdout.write(`[smoke-prompt] providers: ${providers.join(", ")}\n`);
      for (const p of providers.slice(0, 5)) {
        const providerModels = modelList[p];
        if (providerModels && typeof providerModels === "object") {
          const mNames = Object.keys(providerModels as Record<string, unknown>);
          process.stdout.write(`  ${p}: ${mNames.slice(0, 5).join(", ")}${mNames.length > 5 ? "..." : ""}\n`);
        }
      }
    }
  } catch (e) {
    process.stdout.write(`[smoke-prompt] getAvailableModels failed: ${e}\n`);
  }

  let gotAssistant = false;
  let responseText = "";
  let errorInfo = "";
  const unsub = runtime.subscribe((event) => {
    if (event.type === "message_end") {
      const raw = event.raw as Record<string, unknown> | undefined;
      const msg = raw?.message as Record<string, unknown> | undefined;
      if (msg?.role === "assistant") {
        gotAssistant = true;
        const content = msg.content;
        if (Array.isArray(content)) {
          responseText = content
            .filter((c): c is { type: string; text: string } =>
              typeof c === "object" && c !== null && "type" in c && (c as Record<string, unknown>).type === "text")
            .map((c) => c.text)
            .join("");
        }
        const stopReason = msg.stopReason;
        if (stopReason === "error") {
          errorInfo = String(msg.errorMessage ?? "unknown error");
        }
        process.stdout.write(`[smoke-prompt] stopReason=${stopReason} model=${msg.model}\n`);
      }
    }
  });

  process.stdout.write("[smoke-prompt] sending prompt...\n");
  const t0 = Date.now();
  await runtime.prompt({ text: "Reply with exactly: DANI_RUNTIME_OK" });

  const timeoutMs = 60_000;
  while (!gotAssistant && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }

  unsub();
  const elapsed = Date.now() - t0;

  if (errorInfo) {
    process.stdout.write(`[smoke-prompt] ERROR (${elapsed}ms): ${errorInfo}\n`);
  } else {
    process.stdout.write(`[smoke-prompt] response (${elapsed}ms): ${responseText.slice(0, 300)}\n`);
    if (responseText.includes("DANI_RUNTIME_OK")) {
      process.stdout.write("[smoke-prompt] PASS\n");
    } else {
      process.stdout.write(`[smoke-prompt] WARN — got: ${responseText.slice(0, 200)}\n`);
    }
  }

  await runtime.abort();
  await runtime.stop();
  process.stdout.write("[smoke-prompt] done\n");
}

main().catch((err) => { console.error("[smoke-prompt] FAIL", err); process.exit(1); });
