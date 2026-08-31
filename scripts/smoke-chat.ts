// Standalone smoke test for the main-process agent — runs streamChat without
// Electron and prints the streamed deltas. Usage: `pnpm smoke:chat [briefing]`
import { config as loadEnv } from "dotenv";
import { streamChat } from "../src/main/agent/chat";
import { buildSystemPrompt } from "../src/main/agent/system-prompt";
import { DEFAULT_CONFIG } from "../src/main/config/schema";

loadEnv();

async function main() {
  const briefing = process.argv.includes("briefing");
  const messages = briefing
    ? [{ role: "user" as const, content: "Give me my briefing." }]
    : [{ role: "user" as const, content: "Say hello in one short sentence." }];

  const system = buildSystemPrompt({ config: DEFAULT_CONFIG, briefing });

  // resolveModel needs Electron's app.getPath() at module scope for store.ts.
  // Outside Electron, app is undefined — store.ts falls back to ~/.opendex/.
  // For the smoke test, we construct the model directly per provider.
  const provider = process.env.OPENDEX_PROVIDER ?? DEFAULT_CONFIG.llm.provider;
  const modelId = process.env.OPENDEX_MODEL ?? DEFAULT_CONFIG.llm.model;

  let model: any;
  switch (provider) {
    case "gateway": {
      if (!process.env.AI_GATEWAY_API_KEY) {
        console.error("[smoke] FAIL: AI_GATEWAY_API_KEY not set — cannot test gateway provider");
        process.exit(1);
      }
      model = modelId; // bare string → AI SDK gateway
      break;
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      model = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId);
      break;
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId);
      break;
    }
    case "ollama": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      model = createOpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "ollama" })(modelId);
      break;
    }
    default:
      console.error(`[smoke] FAIL: unsupported provider "${provider}" in smoke test`);
      process.exit(1);
  }

  let chars = 0;
  process.stdout.write(`\n[smoke] mode=${briefing ? "briefing" : "chat"} provider=${provider} model=${modelId}\n---\n`);
  await streamChat({
    messages,
    system,
    model,
    briefing,
    onDelta: (delta) => {
      process.stdout.write(delta);
      chars += delta.length;
    },
  });
  process.stdout.write(`\n---\n[smoke] received ${chars} chars\n`);
  if (chars === 0) {
    console.error("[smoke] FAIL: no output");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke] error", err);
  process.exit(1);
});
