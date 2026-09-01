import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { defineTool } from "../src/core/extensions/index.ts";
import { type CreateAgentSessionOptions, createAgentSession, type ModelDispatchInterceptor } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

const tempDirs: string[] = [];

function createModel(): Model<Api> {
	return {
		id: "dispatch-model",
		name: "Dispatch Model",
		api: "openai-completions",
		provider: "dispatch-provider",
		baseUrl: "https://dispatch.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createMessage(
	stopReason: Exclude<AssistantMessage["stopReason"], "pending"> = "stop",
	content: AssistantMessage["content"] = [{ type: "text", text: "ok" }],
	usage = 0,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "dispatch-provider",
		model: "dispatch-model",
		usage: {
			input: usage,
			output: usage,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage * 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
		...(stopReason === "error" ? { errorMessage: "overloaded_error" } : {}),
	};
}

function createResponse(message: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
			return;
		}
		if (message.stopReason === "pending") throw new Error("Test response must be terminal");
		stream.push({ type: "done", reason: message.stopReason, message });
	});
	return stream;
}

async function createHarness(options: {
	interceptor?: ModelDispatchInterceptor;
	response: (call: number) => AssistantMessage;
	customTools?: CreateAgentSessionOptions["customTools"];
	tools?: string[];
	retry?: { enabled: boolean; maxRetries: number; baseDelayMs: number };
}) {
	const root = mkdtempSync(join(tmpdir(), "pi-dispatch-interceptor-"));
	tempDirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });

	const model = createModel();
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "test-api-key" }));
	const modelRegistry = await createModelRegistry(authStorage, join(agentDir, "models.json"));
	let providerCalls = 0;
	let providerOptions: SimpleStreamOptions | undefined;
	modelRegistry.registerProvider(model.provider, {
		api: model.api,
		streamSimple: (_model, _context, requestOptions) => {
			providerCalls++;
			providerOptions = requestOptions;
			return createResponse(options.response(providerCalls));
		},
	});

	const settingsManager = SettingsManager.inMemory({
		retry: {
			...(options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1 }),
			provider: { maxRetries: 0 },
		},
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime: getModelRuntime(modelRegistry),
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		modelDispatchInterceptor: options.interceptor,
		customTools: options.customTools,
		tools: options.tools,
		noTools: options.tools ? undefined : "all",
	});
	return {
		model,
		session,
		providerCalls: () => providerCalls,
		providerOptions: () => providerOptions,
	};
}

afterEach(() => {
	for (const root of tempDirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("createAgentSession modelDispatchInterceptor", () => {
	it("preserves the upstream stream path when no interceptor is supplied", async () => {
		const harness = await createHarness({ response: () => createMessage() });
		try {
			const stream = await harness.session.agent.streamFunction(harness.model, { messages: [] });
			const events = [];
			for await (const event of stream) events.push(event.type);

			expect(events).toEqual(["done"]);
			expect((await stream.result()).stopReason).toBe("stop");
			expect(harness.providerCalls()).toBe(1);
		} finally {
			harness.session.dispose();
		}
	});

	it("rejects before dispatch without calling the provider or recording usage", async () => {
		const harness = await createHarness({
			response: () => createMessage(),
			interceptor: {
				before: () => ({ allow: false, code: "budget-exhausted" }),
				after: () => ({ allow: true }),
			},
		});
		try {
			const stream = await harness.session.agent.streamFunction(harness.model, { messages: [] });
			const result = await stream.result();

			expect(harness.providerCalls()).toBe(0);
			expect(result.stopReason).toBe("aborted");
			expect(result.errorMessage).toBe("Model dispatch rejected: budget-exhausted");
			expect(result.usage.totalTokens).toBe(0);
			expect(result.content).toEqual([]);
		} finally {
			harness.session.dispose();
		}
	});

	it("fails closed when before returns a malformed runtime value", async () => {
		const harness = await createHarness({
			response: () => createMessage(),
			interceptor: {
				before: () => null as never,
				after: () => ({ allow: true }),
			},
		});
		try {
			const stream = await harness.session.agent.streamFunction(harness.model, { messages: [] });
			const result = await stream.result();

			expect(harness.providerCalls()).toBe(0);
			expect(result.stopReason).toBe("aborted");
			expect(result.errorMessage).toBe("Model dispatch rejected: invalid-interceptor-result");
		} finally {
			harness.session.dispose();
		}
	});

	it("allows before to narrow provider options and reports the complete response to after", async () => {
		let afterUsage = -1;
		let afterDispatchId = "";
		let afterResponseModel: string | undefined;
		const harness = await createHarness({
			response: () => ({ ...createMessage("stop", undefined, 7), responseModel: "dispatch-model" }),
			interceptor: {
				before: ({ options }) => ({
					allow: true,
					dispatchId: "dispatch-1",
					options: { ...options, maxTokens: 17 },
				}),
				after: ({ dispatchId, message }) => {
					afterDispatchId = dispatchId;
					afterUsage = message.usage.totalTokens;
					afterResponseModel = message.responseModel;
					return { allow: true };
				},
			},
		});
		try {
			const stream = await harness.session.agent.streamFunction(harness.model, { messages: [] });
			expect((await stream.result()).stopReason).toBe("stop");
			expect(harness.providerOptions()?.maxTokens).toBe(17);
			expect(afterDispatchId).toBe("dispatch-1");
			expect(afterUsage).toBe(14);
			expect(afterResponseModel).toBe("dispatch-model");
		} finally {
			harness.session.dispose();
		}
	});

	it("turns an after rejection into an abort before requested tools execute", async () => {
		let toolCalls = 0;
		const danger = defineTool({
			name: "danger",
			label: "Danger",
			description: "Must not run when the response is rejected",
			parameters: Type.Object({}),
			execute: async () => {
				toolCalls++;
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
		});
		const harness = await createHarness({
			response: () =>
				createMessage("toolUse", [{ type: "toolCall", id: "call-1", name: "danger", arguments: {} }], 5),
			customTools: [danger],
			tools: ["danger"],
			interceptor: {
				before: ({ options }) => ({ allow: true, dispatchId: "dispatch-tool", options }),
				after: () => ({ allow: false, code: "response-model-drift" }),
			},
		});
		try {
			await harness.session.prompt("run danger");

			expect(toolCalls).toBe(0);
			expect(harness.providerCalls()).toBe(1);
			const last = harness.session.messages.at(-1);
			expect(last?.role).toBe("assistant");
			if (last?.role === "assistant") {
				expect(last.stopReason).toBe("aborted");
				expect(last.usage.totalTokens).toBe(10);
			}
		} finally {
			harness.session.dispose();
		}
	});

	it("intercepts every same-model logical retry independently", async () => {
		const dispatchIds: string[] = [];
		const harness = await createHarness({
			response: (call) => (call === 1 ? createMessage("error", []) : createMessage()),
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
			interceptor: {
				before: ({ options }) => {
					const dispatchId = `dispatch-${dispatchIds.length + 1}`;
					dispatchIds.push(dispatchId);
					return { allow: true, dispatchId, options };
				},
				after: () => ({ allow: true }),
			},
		});
		try {
			await harness.session.prompt("retry once");

			expect(harness.providerCalls()).toBe(2);
			expect(dispatchIds).toEqual(["dispatch-1", "dispatch-2"]);
		} finally {
			harness.session.dispose();
		}
	});
});
