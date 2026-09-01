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
	try {
		const { runtime, model } = await createRuntime(loopback.baseUrl);
		const message = await runtime.completeSimple(
			model,
			{ messages: [{ role: "user", content: "reply", timestamp: 1 }] },
			{ maxRetries: 0, maxTokens: 128 },
		);
		assert.equal(message.model, MODEL);
		assert.equal(message.responseModel, MODEL);
		assert.equal(message.stopReason, "stop");
		assert.equal(message.usage.input, 4);
		assert.equal(message.usage.output, 2);
	} finally {
		await loopback.close();
	}
});

test("installed root bundle drains usage after model drift and never executes the requested tool", async () => {
	const loopback = await listen((response) => {
		const common = {
			id: "chatcmpl-drift",
			object: "chat.completion.chunk",
			created: 1,
		};
		writeSse(response, {
			...common,
			model: MODEL,
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
			model: "unexpected-fallback-model",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		});
		writeSse(response, {
			...common,
			model: "unexpected-fallback-model",
			choices: [],
			usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
		});
		response.end("data: [DONE]\n\n");
	});
	let executions = 0;
	try {
		const { cwd, agentDir, runtime, model } = await createRuntime(loopback.baseUrl);
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
		const settingsManager = SettingsManager.inMemory({
			retry: {
				enabled: false,
				maxRetries: 0,
				baseDelayMs: 1,
				provider: { maxRetries: 0 },
			},
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: runtime,
			model,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			noTools: "all",
			tools: ["danger"],
			customTools: [danger],
		});
		try {
			await session.prompt("call danger");
			assert.equal(executions, 0);
			const assistant = session.messages.findLast((message) => message.role === "assistant");
			assert.ok(assistant);
			assert.equal(assistant.model, MODEL);
			assert.equal(assistant.responseModel, MODEL);
			assert.equal(assistant.stopReason, "error");
			assert.match(assistant.errorMessage ?? "", /response model changed within the stream/u);
			assert.equal(assistant.usage.input, 11);
			assert.equal(assistant.usage.output, 7);
		} finally {
			session.dispose();
		}
	} finally {
		await loopback.close();
	}
});
