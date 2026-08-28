import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, expect, test } from "vitest";

import { AuthStorage } from "../src/core/auth-storage.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const temporaryRoots: string[] = [];

function model(): Model<Api> {
  return {
    id: "qualification-model",
    name: "Qualification Model",
    api: "openai-completions",
    provider: "qualification-provider",
    baseUrl: "https://qualification.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "qualification-provider",
    model: "qualification-model",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 23,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

function providerStream() {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const empty = message([], "pending");
    const complete = message([{ type: "text", text: "stable trace" }], "stop");
    stream.push({ type: "start", partial: empty });
    stream.push({ type: "text_start", contentIndex: 0, partial: empty });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "stable trace", partial: complete });
    stream.push({ type: "text_end", contentIndex: 0, content: "stable trace", partial: complete });
    stream.push({ type: "done", reason: "stop", message: complete });
  });
  return stream;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "timestamp")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stable(entry)]));
  }
  return value;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("no-interceptor SDK trace is byte-stable across upstream and fork", async () => {
  const outputPath = process.env.RUSTDEX_TRACE_OUTPUT;
  if (!outputPath) throw new Error("RUSTDEX_TRACE_OUTPUT is required");
  const root = mkdtempSync(join(tmpdir(), "pi-qualification-trace-"));
  temporaryRoots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const selectedModel = model();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  await authStorage.modify(selectedModel.provider, async () => ({ type: "api_key", key: "qualification-key" }));
  const registry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
  let providerCalls = 0;
  let providerOptions: SimpleStreamOptions | undefined;
  let providerContext: unknown;
  registry.registerProvider(selectedModel.provider, {
    api: selectedModel.api,
    streamSimple: (_model, context, options) => {
      providerCalls += 1;
      providerOptions = options;
      providerContext = context;
      return providerStream();
    },
  });

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 2_000, provider: { maxRetries: 0 } },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: selectedModel,
    modelRuntime: getModelRuntime(registry),
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  try {
    const stream = await session.agent.streamFunction(selectedModel, {
      systemPrompt: "stable-system",
      messages: [{ role: "user", content: "stable-user", timestamp: 1 }],
    });
    const events: unknown[] = [];
    for await (const event of stream) events.push(stable(event));
    const result = stable(await stream.result());
    expect(providerCalls).toBe(1);
    const trace = stable({
      events,
      providerCalls,
      providerContext,
      providerOptions: {
        maxTokens: providerOptions?.maxTokens ?? null,
        temperature: providerOptions?.temperature ?? null,
        timeoutMs: providerOptions?.timeoutMs ?? null,
        websocketConnectTimeoutMs: providerOptions?.websocketConnectTimeoutMs ?? null,
      },
      result,
    });
    writeFileSync(outputPath, `${JSON.stringify(trace, null, 2)}\n`);
  } finally {
    session.dispose();
  }
});
