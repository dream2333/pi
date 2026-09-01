import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@dream2333/pi-coding-agent";
import { Type } from "typebox";

const PACKAGE_NAME = "@dream2333/pi-coding-agent";
const PACKAGE_VERSION = "0.84.3-rustdex.4";
const RESPONSE_MODEL_ABI = "openai-completions-response-model.v1";
const PROVIDER = "rustdex-loopback";
const MODEL = "qualification-model";

const packageEntryUrl = import.meta.resolve(PACKAGE_NAME);
const packageEntryPath = fileURLToPath(packageEntryUrl);
const packageRoot = resolve(dirname(packageEntryPath), "../..");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));

assert.match(packageEntryUrl, /node_modules\/@dream2333\/pi-coding-agent\/dist\/bundle\/index\.js$/u);
assert.equal(packageJson.name, PACKAGE_NAME);
assert.equal(packageJson.version, PACKAGE_VERSION);
assert.equal(packageJson.exports?.["."]?.import, "./dist/bundle/index.js");
assert.equal(packageJson.rustdexFork?.responseModelObservationAbi, RESPONSE_MODEL_ABI);

const temporaryRoots = [];

test.afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function writeSse(response, chunk) {
	response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

async function listen(handler) {
	const server = createServer(async (request, response) => {
		try {
			for await (const _chunk of request) {
				// Drain the request before replying so the loopback transport follows
				// the same request lifecycle as an OpenAI-compatible provider.
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			handler(response);
		} catch (error) {
			response.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	});
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("loopback server has no TCP address");
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: async () => {
			await new Promise((resolveClose, rejectClose) => {
				server.close((error) => (error ? rejectClose(error) : resolveClose()));
			});
		},
	};
}

async function createRuntime(baseUrl) {
	const root = await mkdtemp(join(tmpdir(), "pi-rustdex-response-model-consumer-"));
	temporaryRoots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	const authPath = join(agentDir, "auth.json");
	const modelsPath = join(agentDir, "models.json");
	await Promise.all([
		writeFile(authPath, `${JSON.stringify({
			[PROVIDER]: { type: "api_key", key: "loopback-only" },
		})}\n`, "utf8"),
		writeFile(modelsPath, `${JSON.stringify({
			providers: {
				[PROVIDER]: {
					baseUrl,
					api: "openai-completions",
					compat: {
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						supportsUsageInStreaming: true,
						supportsStrictMode: false,
						maxTokensField: "max_completion_tokens",
					},
					models: [{
						id: MODEL,
						name: MODEL,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 4_096,
					}],
				},
			},
		})}\n`, "utf8"),
	]);
	const runtime = await ModelRuntime.create({
		authPath,
		modelsPath,
		modelsStore: {
			async read() { return undefined; },
			async write() {},
			async delete() {},
		},
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const model = runtime.getModel(PROVIDER, MODEL);
	assert.ok(model, "loopback model must resolve from the installed bundle");
	return { root, cwd, agentDir, runtime, model };
}

async function createResourceLoader(cwd, agentDir) {
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	return resourceLoader;
}

function createNoRetrySettings() {
	return SettingsManager.inMemory({
		retry: {
			enabled: false,
			maxRetries: 0,
			baseDelayMs: 1,
			provider: { maxRetries: 0 },
		},
	});
}

function createExactDispatchInterceptor(expectedModel, dispatchId, onAfter) {
	let beforeCalls = 0;
	let afterCalls = 0;
	let permittedOptions;
	return {
		interceptor: {
			before: (input) => {
				beforeCalls += 1;
				if (
					beforeCalls !== 1
					|| input.model !== expectedModel
					|| input.options.maxRetries !== 0
				) {
					return { allow: false, code: "unexpected-dispatch-identity" };
				}
				permittedOptions = input.options;
				return { allow: true, dispatchId, options: input.options };
			},
			after: (input) => {
				afterCalls += 1;
				assert.equal(input.dispatchId, dispatchId);
				assert.equal(input.model, expectedModel);
				assert.equal(input.options, permittedOptions);
				onAfter(input.message);
				if (input.message.responseModel !== expectedModel.id) {
					return { allow: false, code: "response-model-drift" };
				}
				return { allow: true };
			},
		},
		beforeCalls: () => beforeCalls,
		afterCalls: () => afterCalls,
	};
}

test("installed root bundle preserves a same-name streamed response model", async () => {
	const loopback = await listen((response) => {
		const common = {
			id: "chatcmpl-same",
			object: "chat.completion.chunk",
			created: 1,
			model: MODEL,
		};
		writeSse(response, {
			...common,
			choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
		});
		writeSse(response, {
			...common,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		});
		writeSse(response, {
			...common,
			choices: [],
			usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
		});
		response.end("data: [DONE]\n\n");
	});
	let afterMessage;
	try {
		const { cwd, agentDir, runtime, model } = await createRuntime(loopback.baseUrl);
		const dispatch = createExactDispatchInterceptor(model, "dispatch-same-name", (message) => {
			afterMessage = message;
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model,
			resourceLoader: await createResourceLoader(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: createNoRetrySettings(),
			modelDispatchInterceptor: dispatch.interceptor,
			noTools: "all",
		});
		try {
			await session.prompt("reply");
			assert.equal(dispatch.beforeCalls(), 1);
			assert.equal(dispatch.afterCalls(), 1);
			assert.ok(afterMessage);
			assert.equal(afterMessage.model, MODEL);
			assert.equal(afterMessage.responseModel, MODEL);
			assert.equal(afterMessage.stopReason, "stop");
			assert.equal(afterMessage.usage.input, 4);
			assert.equal(afterMessage.usage.output, 2);
		} finally {
			session.dispose();
		}
	} finally {
		await loopback.close();
	}
});

test("installed root bundle rejects a stable response-model mismatch before tool execution", async () => {
	const loopback = await listen((response) => {
		const common = {
			id: "chatcmpl-drift",
			object: "chat.completion.chunk",
			created: 1,
			model: "unexpected-fallback-model",
		};
		writeSse(response, {
			...common,
			choices: [{
				index: 0,
				delta: {
					role: "assistant",
					tool_calls: [{
						index: 0,
						id: "call-danger",
						type: "function",
						function: { name: "danger", arguments: "{}" },
					}],
				},
				finish_reason: null,
			}],
		});
		writeSse(response, {
			...common,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		});
		writeSse(response, {
			...common,
			choices: [],
			usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
		});
		response.end("data: [DONE]\n\n");
	});
	let executions = 0;
	let afterMessage;
	let afterObservedBeforeToolExecution = false;
	try {
		const { cwd, agentDir, runtime, model } = await createRuntime(loopback.baseUrl);
		const dispatch = createExactDispatchInterceptor(model, "dispatch-drift", (message) => {
			afterMessage = message;
			afterObservedBeforeToolExecution = executions === 0;
		});
		const danger = defineTool({
			name: "danger",
			label: "Danger",
			description: "Must not execute after response-model drift",
			parameters: Type.Object({}, { additionalProperties: false }),
			execute: async () => {
				executions += 1;
				return { content: [{ type: "text", text: "executed" }], details: {} };
			},
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model,
			resourceLoader: await createResourceLoader(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: createNoRetrySettings(),
			modelDispatchInterceptor: dispatch.interceptor,
			noTools: "all",
			tools: ["danger"],
			customTools: [danger],
		});
		try {
			await session.prompt("call danger");
			assert.equal(dispatch.beforeCalls(), 1);
			assert.equal(dispatch.afterCalls(), 1);
			assert.equal(afterObservedBeforeToolExecution, true);
			assert.equal(executions, 0);
			assert.ok(afterMessage);
			assert.equal(afterMessage.model, MODEL);
			assert.equal(afterMessage.responseModel, "unexpected-fallback-model");
			assert.equal(afterMessage.stopReason, "toolUse");
			assert.equal(afterMessage.usage.input, 11);
			assert.equal(afterMessage.usage.output, 7);
			assert.equal(
				afterMessage.content.some((block) => block.type === "toolCall" && block.name === "danger"),
				true,
			);
			const assistant = session.messages.findLast((message) => message.role === "assistant");
			assert.ok(assistant);
			assert.equal(assistant.model, MODEL);
			assert.equal(assistant.responseModel, "unexpected-fallback-model");
			assert.equal(assistant.stopReason, "aborted");
			assert.match(assistant.errorMessage ?? "", /Model dispatch rejected: response-model-drift/u);
			assert.equal(assistant.usage.input, 11);
			assert.equal(assistant.usage.output, 7);
		} finally {
			session.dispose();
		}
	} finally {
		await loopback.close();
	}
});
