import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyReleaseIdentity, packageContentsIdentity } from "./build-rustdex-coding-agent-release.mjs";

const config = {
	packageName: "@dream2333/pi-coding-agent",
	packageVersion: "0.84.3-rustdex.4",
	upstreamBaseCommit: "4e494929998d6bc4fccf75e0a233f727db4b70ee",
	dispatchGuardAbi: "model-dispatch-interceptor.v1",
	responseModelObservationAbi: "openai-completions-response-model.v1",
	entrypoints: {
		main: "./dist/bundle/index.js",
		rootImport: "./dist/bundle/index.js",
		rootTypes: "./dist/index.d.ts",
	},
};

test("release identity binds the fork commit and bundled SDK entry", () => {
	const result = applyReleaseIdentity(
		{
			name: "@earendil-works/pi-coding-agent",
			version: "0.84.3",
			main: "./dist/index.js",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
		},
		{
			name: "@earendil-works/pi-coding-agent",
			version: "0.84.3",
			packages: { "": { name: "@earendil-works/pi-coding-agent", version: "0.84.3" } },
		},
		config,
		"a".repeat(40),
		"b".repeat(64),
	);
	assert.equal(result.packageJson.name, config.packageName);
	assert.equal(result.packageJson.version, config.packageVersion);
	assert.equal(result.packageJson.main, config.entrypoints.main);
	assert.equal(result.packageJson.exports["."].import, config.entrypoints.rootImport);
	assert.equal(result.packageJson.rustdexFork.forkCommit, "a".repeat(40));
	assert.equal(
		result.packageJson.rustdexFork.responseModelObservationAbi,
		config.responseModelObservationAbi,
	);
	assert.equal(result.shrinkwrap.packages[""].name, config.packageName);
	assert.equal(result.shrinkwrap.packages[""].version, config.packageVersion);
});

test("package contents identity is path ordered and byte exact", () => {
	const first = mkdtempSync(join(tmpdir(), "pi-rustdex-identity-first-"));
	const second = mkdtempSync(join(tmpdir(), "pi-rustdex-identity-second-"));
	try {
		mkdirSync(join(first, "nested"));
		writeFileSync(join(first, "nested", "b.txt"), "second\n");
		writeFileSync(join(first, "a.txt"), "first\n");
		writeFileSync(join(second, "a.txt"), "first\n");
		mkdirSync(join(second, "nested"));
		writeFileSync(join(second, "nested", "b.txt"), "second\n");
		assert.deepEqual(packageContentsIdentity(first), packageContentsIdentity(second));
		writeFileSync(join(second, "nested", "b.txt"), "changed\n");
		assert.notEqual(packageContentsIdentity(first).sha256, packageContentsIdentity(second).sha256);
	} finally {
		rmSync(first, { force: true, recursive: true });
		rmSync(second, { force: true, recursive: true });
	}
});
