#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const configPath = join(scriptDir, "rustdex-coding-agent-release.json");

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sha512(value) {
	return createHash("sha512").update(value).digest("hex");
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: repoRoot,
		encoding: options.encoding ?? "utf8",
		stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
	});
}

function runNpm(args, options = {}) {
	if (process.platform !== "win32") return run("npm", args, options);
	const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	if (!existsSync(npmCli)) throw new Error("Unable to locate npm CLI beside Node.js");
	return run(process.execPath, [npmCli, ...args], options);
}

function parseArgs(argv) {
	const parsed = { output: null, modelDataArchive: null, skipBuild: false };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--output") parsed.output = argv[++index];
		else if (argument === "--model-data-archive") parsed.modelDataArchive = argv[++index];
		else if (argument === "--skip-build") parsed.skipBuild = true;
		else throw new Error(`Unknown argument: ${argument}`);
	}
	if (!parsed.output) throw new Error("--output is required");
	return parsed;
}

function readConfig() {
	const configBytes = readFileSync(configPath);
	const config = JSON.parse(configBytes.toString("utf8"));
	if (
		config.schema !== "rustdex.coding-agent-release.v1" ||
		typeof config.packageName !== "string" ||
		typeof config.packageVersion !== "string" ||
		!config.upstreamBaseCommit?.match(/^[0-9a-f]{40}$/u) ||
		!config.upstreamModelData?.archiveSha256?.match(/^[0-9a-f]{64}$/u)
	) {
		throw new Error("Rustdex release config is invalid");
	}
	return { config, configSha256: sha256(configBytes) };
}

async function acquireModelDataArchive(config, suppliedPath, temporaryRoot) {
	const archivePath = suppliedPath ? resolve(suppliedPath) : join(temporaryRoot, "upstream-model-data.tar.gz");
	if (!suppliedPath) {
		const response = await fetch(config.upstreamModelData.archiveUrl, { redirect: "follow" });
		if (!response.ok) throw new Error(`Unable to fetch upstream model data: HTTP ${response.status}`);
		writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
	}
	const archiveBytes = readFileSync(archivePath);
	if (sha256(archiveBytes) !== config.upstreamModelData.archiveSha256) {
		throw new Error("Upstream model-data archive hash differs from the release config");
	}
	return archivePath;
}

function hydrateModelData(config, archivePath, temporaryRoot) {
	const extractedRoot = join(temporaryRoot, "upstream-source");
	mkdirSync(extractedRoot);
	run("tar", ["-xzf", archivePath, "-C", extractedRoot]);
	const source = join(
		extractedRoot,
		config.upstreamModelData.archiveRoot,
		"packages",
		"ai",
		"src",
		"providers",
		"data",
	);
	if (!existsSync(join(source, ".manifest.json"))) throw new Error("Pinned upstream archive has no model-data manifest");
	const destination = join(repoRoot, "packages", "ai", "src", "providers", "data");
	rmSync(destination, { force: true, recursive: true });
	cpSync(source, destination, { recursive: true });
}

function assertSourceIdentity(config) {
	const head = run("git", ["rev-parse", "HEAD"]).trim();
	const trackedStatus = run("git", ["status", "--porcelain", "--untracked-files=no"]).trim();
	if (trackedStatus) throw new Error("Tracked worktree must be clean before building a release");
	try {
		run("git", ["merge-base", "--is-ancestor", config.upstreamBaseCommit, head]);
	} catch {
		throw new Error("Release commit does not descend from the pinned upstream base");
	}
	return head;
}

export function applyReleaseIdentity(packageJson, shrinkwrap, config, forkCommit, configSha256) {
	const transformedPackage = {
		...packageJson,
		name: config.packageName,
		version: config.packageVersion,
		rustdexFork: {
			upstreamCommit: config.upstreamBaseCommit,
			forkCommit,
			dispatchGuardAbi: config.dispatchGuardAbi,
			releaseConfigSha256: configSha256,
		},
		main: config.entrypoints.main,
		exports: {
			...packageJson.exports,
			".": {
				types: config.entrypoints.rootTypes,
				import: config.entrypoints.rootImport,
			},
		},
		repository: {
			type: "git",
			url: "git+https://github.com/dream2333/pi.git",
			directory: "packages/coding-agent",
		},
	};
	const transformedShrinkwrap = {
		...shrinkwrap,
		name: config.packageName,
		version: config.packageVersion,
		packages: {
			...shrinkwrap.packages,
			"": {
				...shrinkwrap.packages[""],
				name: config.packageName,
				version: config.packageVersion,
			},
		},
	};
	return { packageJson: transformedPackage, shrinkwrap: transformedShrinkwrap };
}

function listFiles(root, current = root) {
	const files = [];
	for (const entry of readdirSync(current, { withFileTypes: true })) {
		const path = join(current, entry.name);
		if (entry.isDirectory()) files.push(...listFiles(root, path));
		else if (entry.isFile()) files.push(path);
		else throw new Error(`Release package contains unsupported entry: ${relative(root, path)}`);
	}
	return files;
}

export function packageContentsIdentity(packageRoot) {
	const records = listFiles(packageRoot)
		.map((path) => {
			const bytes = readFileSync(path);
			const packagePath = relative(packageRoot, path).replaceAll("\\", "/");
			return `${packagePath}\0${statSync(path).size}\0${sha256(bytes)}\n`;
		})
		.sort();
	return {
		algorithm: "sha256-canonical-files-v1",
		sha256: sha256(records.join("")),
		entryCount: records.length,
	};
}

function stageReleasePackage(config, configSha256, forkCommit, temporaryRoot) {
	const sourcePackRoot = join(temporaryRoot, "source-pack");
	mkdirSync(sourcePackRoot);
	runNpm(["pack", join(repoRoot, "packages", "coding-agent"), "--ignore-scripts", "--pack-destination", sourcePackRoot], {
		stdio: "inherit",
	});
	const sourceTarballs = readdirSync(sourcePackRoot).filter((entry) => entry.endsWith(".tgz"));
	if (sourceTarballs.length !== 1) throw new Error("Expected exactly one source package tarball");
	const stageRoot = join(temporaryRoot, "stage");
	mkdirSync(stageRoot);
	run("tar", ["-xzf", join(sourcePackRoot, sourceTarballs[0]), "-C", stageRoot]);
	const packageRoot = join(stageRoot, "package");
	const packageJsonPath = join(packageRoot, "package.json");
	const shrinkwrapPath = join(packageRoot, "npm-shrinkwrap.json");
	const transformed = applyReleaseIdentity(
		JSON.parse(readFileSync(packageJsonPath, "utf8")),
		JSON.parse(readFileSync(shrinkwrapPath, "utf8")),
		config,
		forkCommit,
		configSha256,
	);
	writeFileSync(packageJsonPath, `${JSON.stringify(transformed.packageJson, null, "\t")}\n`);
	writeFileSync(shrinkwrapPath, `${JSON.stringify(transformed.shrinkwrap, null, "\t")}\n`);
	cpSync(join(repoRoot, config.licenseSourcePath), join(packageRoot, "LICENSE"));
	return packageRoot;
}

function packRelease(packageRoot, outputRoot, temporaryRoot) {
	mkdirSync(outputRoot, { recursive: true });
	const before = new Set(readdirSync(outputRoot));
	runNpm(["pack", packageRoot, "--ignore-scripts", "--pack-destination", outputRoot], { stdio: "inherit" });
	const created = readdirSync(outputRoot).filter((entry) => entry.endsWith(".tgz") && !before.has(entry));
	if (created.length !== 1) throw new Error("Expected exactly one release package tarball");
	const tarballPath = join(outputRoot, created[0]);
	const verifyRoot = join(temporaryRoot, "verify");
	mkdirSync(verifyRoot);
	run("tar", ["-xzf", tarballPath, "-C", verifyRoot]);
	return { tarballPath, packageRoot: join(verifyRoot, "package") };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const { config, configSha256 } = readConfig();
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-rustdex-release-"));
	try {
		const forkCommit = assertSourceIdentity(config);
		if (!args.skipBuild) {
			const archivePath = await acquireModelDataArchive(config, args.modelDataArchive, temporaryRoot);
			hydrateModelData(config, archivePath, temporaryRoot);
			runNpm(["run", "clean"], { stdio: "inherit" });
			runNpm(["run", "build:offline"], { stdio: "inherit" });
		}
		const packageRoot = stageReleasePackage(config, configSha256, forkCommit, temporaryRoot);
		if (!existsSync(join(packageRoot, "dist", "bundle", "index.js"))) {
			throw new Error("Bundled SDK root entry is missing");
		}
		const packed = packRelease(packageRoot, resolve(args.output), temporaryRoot);
		const tarballBytes = readFileSync(packed.tarballPath);
		const identity = packageContentsIdentity(packed.packageRoot);
		process.stdout.write(
			`${JSON.stringify(
				{
					schema: "rustdex.coding-agent-release-receipt.v1",
					forkCommit,
					configSha256,
					fileName: basename(packed.tarballPath),
					bytes: tarballBytes.length,
					sha256: sha256(tarballBytes),
					sha512: sha512(tarballBytes),
					npmIntegrity: `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`,
					packageContents: identity,
				},
				null,
				2,
			)}\n`,
		);
	} finally {
		rmSync(temporaryRoot, { force: true, recursive: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}
