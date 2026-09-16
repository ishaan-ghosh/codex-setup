import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { codexNativeSpec, ToolchainInstaller, toolchainReleaseId } from "../../lib/toolchain-installer.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const nativePlatform = {
	"darwin-arm64": "darwin-arm64",
	"linux-x64": "linux-x64",
}[`${process.platform}-${process.arch}`];

if (!nativePlatform) throw new Error(`unsupported test platform: ${process.platform}-${process.arch}`);

async function testTempDirectory(prefix) {
	const tempRoot = await fs.realpath(os.tmpdir());
	return fs.mkdtemp(path.join(tempRoot, prefix));
}

test("Codex native package mapping is exact for supported platforms", () => {
	assert.deepEqual(codexNativeSpec("darwin-arm64"), {
		package: "@openai/codex-darwin-arm64",
		target: "aarch64-apple-darwin",
		packageRoot: "app/node_modules/@openai/codex-darwin-arm64",
		executable: "app/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
	});
	assert.deepEqual(codexNativeSpec("linux-x64"), {
		package: "@openai/codex-linux-x64",
		target: "x86_64-unknown-linux-musl",
		packageRoot: "app/node_modules/@openai/codex-linux-x64",
		executable: "app/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
	});
	assert.throws(() => codexNativeSpec("linux-arm64"), /unavailable/);
});

test("POSIX bootstrap pins the exact Node artifacts from component-lock", async () => {
	const lock = JSON.parse(await fs.readFile(path.join(repoRoot, "component-lock.json")));
	const bootstrap = await fs.readFile(path.join(repoRoot, "bin", "bootstrap"), "utf8");
	assert.match(bootstrap, new RegExp(`NODE_VERSION=${lock.components.node.version.replaceAll(".", "\\.")}`));
	assert.match(bootstrap, new RegExp(`BASE_URL=${lock.components.node.base_url.replaceAll("/", "\\/")}`));
	for (const [platform, artifact] of Object.entries(lock.components.node.artifacts)) {
		const prefix = platform === "darwin-arm64" ? "DARWIN_ARM64" : "LINUX_X64";
		assert.match(bootstrap, new RegExp(`${prefix}_FILE=${artifact.file.replaceAll(".", "\\.")}`));
		assert.match(bootstrap, new RegExp(`${prefix}_SHA256=${artifact.sha256}`));
	}
	assert.doesNotMatch(bootstrap, /curl[^\n]*\|\s*(?:sh|bash)|sudo|--with-deps/);
	assert.doesNotMatch(bootstrap, /RELEASE_ID=/);
});

test("toolchain dry-run validates locks without network or filesystem writes", async (t) => {
	const root = await testTempDirectory("codex-toolchain-dry-");
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const dataHome = path.join(root, "data");
	const lines = [];
	const installer = new ToolchainInstaller({
		repoRoot,
		dataHome,
		dryRun: true,
		output: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
		downloadImpl: async () => { throw new Error("network must not be used"); },
		execImpl: async () => { throw new Error("commands must not execute"); },
	});
	await installer.install();
	await assert.rejects(() => fs.stat(dataHome), { code: "ENOENT" });
	assert.ok(lines.some((line) => line.includes("download and verify")));
	assert.ok(lines.some((line) => line.includes("pinned Chromium")));
});


test("a package-lock-only change selects a distinct toolchain release path", async (t) => {
	const root = await testTempDirectory("codex-toolchain-id-");
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	await fs.mkdir(path.join(repo, "toolchain"), { recursive: true });
	await Promise.all([
		fs.copyFile(path.join(repoRoot, "component-lock.json"), path.join(repo, "component-lock.json")),
		fs.copyFile(path.join(repoRoot, "toolchain/package.json"), path.join(repo, "toolchain/package.json")),
		fs.copyFile(path.join(repoRoot, "toolchain/package-lock.json"), path.join(repo, "toolchain/package-lock.json")),
	]);
	const firstLines = [];
	const first = new ToolchainInstaller({
		repoRoot: repo,
		dataHome: path.join(root, "data"),
		dryRun: true,
		output: { log: (line) => firstLines.push(line), error: () => {} },
	});
	const firstLocks = await first.locks();
	const firstId = toolchainReleaseId({
		nodeVersion: firstLocks.node.version,
		platform: firstLocks.platform,
		componentLockSha256: firstLocks.componentLockSha256,
		packageLockSha256: firstLocks.packageLockSha256,
	});
	await first.install();

	await fs.appendFile(path.join(repo, "toolchain/package-lock.json"), "\n");
	const secondLines = [];
	const second = new ToolchainInstaller({
		repoRoot: repo,
		dataHome: path.join(root, "data"),
		dryRun: true,
		output: { log: (line) => secondLines.push(line), error: () => {} },
	});
	const secondLocks = await second.locks();
	const secondId = toolchainReleaseId({
		nodeVersion: secondLocks.node.version,
		platform: secondLocks.platform,
		componentLockSha256: secondLocks.componentLockSha256,
		packageLockSha256: secondLocks.packageLockSha256,
	});
	await second.install();

	assert.equal(firstLocks.componentLockSha256, secondLocks.componentLockSha256);
	assert.notEqual(firstLocks.packageLockSha256, secondLocks.packageLockSha256);
	assert.notEqual(firstId, secondId);
	assert.ok(firstLines.some((line) => line.includes(`stage Node.js ${firstId},`)));
	assert.ok(secondLines.some((line) => line.includes(`stage Node.js ${secondId},`)));
});


test("toolchain implementation uses the unified release-local layout", async () => {
	const source = await fs.readFile(path.join(repoRoot, "lib/toolchain-installer.mjs"), "utf8");
	assert.match(source, /path\.join\(this\.root, "releases"\)/);
	assert.match(source, /path\.join\(staging, "node"\)/);
	assert.match(source, /path\.join\(staging, "app"\)/);
	assert.match(source, /PLAYWRIGHT_BROWSERS_PATH: stagingBrowsers/);
});


test("bootstrap ignores existing stubs and executes only the freshly archive-verified runtime", async (t) => {
	const root = await testTempDirectory("codex-bootstrap-transient-");
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const home = path.join(root, "home");
	const dataHome = path.join(root, "data");
	const fakeBin = path.join(root, "bin");
	const existing = path.join(dataHome, "toolchains", "releases", "existing", "node", "bin");
	const existingMarker = path.join(root, "existing-executed");
	const transientMarker = path.join(root, "transient-argv");
	await fs.mkdir(existing, { recursive: true });
	await fs.mkdir(fakeBin);
	await fs.writeFile(path.join(existing, "node"), `#!/bin/sh
: > "${existingMarker}"
exit 0
`, { mode: 0o755 });
	await fs.symlink("releases/existing", path.join(dataHome, "toolchains", "current"), "dir");
	await fs.writeFile(path.join(fakeBin, "fresh-node"), `#!/bin/sh
printf '%s\\n' "$@" > "${transientMarker}"
exit 0
`, { mode: 0o755 });

	await fs.writeFile(path.join(fakeBin, "curl"), `#!/bin/sh
out=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then shift; out=$1; fi
  shift
done
: > "$out"
`, { mode: 0o755 });
	const lock = JSON.parse(await fs.readFile(path.join(repoRoot, "component-lock.json")));
	const artifact = lock.components.node.artifacts[nativePlatform];
	const expected = artifact.sha256;
	const archiveRoot = artifact.file.replace(/\.tar\.gz$/, "");
	await fs.writeFile(path.join(fakeBin, "sha256sum"), `#!/bin/sh
printf '%s  %s\\n' "${expected}" "$1"
`, { mode: 0o755 });
	await fs.writeFile(path.join(fakeBin, "tar"), `#!/bin/sh
if [ "$1" = "-tzf" ]; then
  printf '%s\\n' '${archiveRoot}/bin/node'
  exit 0
fi
destination=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then shift; destination=$1; fi
  shift
done
mkdir -p "$destination/bin"
cp "${path.join(fakeBin, "fresh-node")}" "$destination/bin/node"
chmod 755 "$destination/bin/node"
`, { mode: 0o755 });

	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(path.join(repoRoot, "bin", "bootstrap"), ["--skip-browser"], {
		encoding: "utf8",
		env: { ...process.env, HOME: home, CODEX_SETUP_DATA_HOME: dataHome, PATH: `${fakeBin}:${process.env.PATH}` },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, new RegExp(`Downloading pinned bootstrap Node\\.js .* for ${nativePlatform}`));
	assert.match(await fs.readFile(transientMarker, "utf8"), /scripts\/codex-setup\.mjs/);
	await assert.rejects(() => fs.stat(existingMarker), { code: "ENOENT" });
});

const nativeCodexFixture = nativePlatform === "darwin-arm64"
	? {
		platform: "darwin-arm64",
		package: "@openai/codex-darwin-arm64",
		target: "aarch64-apple-darwin",
	}
	: {
		platform: "linux-x64",
		package: "@openai/codex-linux-x64",
		target: "x86_64-unknown-linux-musl",
	};

function nativeExecutable(fixture = nativeCodexFixture) {
	return `app/node_modules/${fixture.package}/vendor/${fixture.target}/bin/codex`;
}

async function fakeInstallHarness(t, { installNative = true, versionOutput = "codex-cli 0.154.0\n" } = {}) {
	const root = await testTempDirectory("codex-toolchain-optional-");
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const repo = path.join(root, "repo");
	const dataHome = path.join(root, "data");
	const archive = Buffer.from("synthetic-node-archive");
	await fs.mkdir(path.join(repo, "toolchain"), { recursive: true });
	const componentLock = JSON.parse(await fs.readFile(path.join(repoRoot, "component-lock.json")));
	componentLock.components.node.artifacts[nativeCodexFixture.platform] = {
		file: "synthetic-node.tar.gz",
		sha256: crypto.createHash("sha256").update(archive).digest("hex"),
	};
	await Promise.all([
		fs.writeFile(path.join(repo, "component-lock.json"), JSON.stringify(componentLock)),
		fs.copyFile(path.join(repoRoot, "toolchain/package.json"), path.join(repo, "toolchain/package.json")),
		fs.copyFile(path.join(repoRoot, "toolchain/package-lock.json"), path.join(repo, "toolchain/package-lock.json")),
	]);
	const calls = [];
	const writeFixture = async (release, relative, contents, mode = 0o644) => {
		const destination = path.join(release, ...relative.split("/"));
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, contents, { mode });
	};
	const execImpl = async (command, args, options = {}) => {
		calls.push({ command, args: [...args], options });
		if (command === "tar" && args[0] === "-tzf") return { stdout: "node-v22.22.0/bin/node\n" };
		if (command === "tar" && args[0] === "-xzf") {
			const release = args[args.indexOf("-C") + 1];
			await writeFixture(release, "bin/node", "synthetic node", 0o755);
			await writeFixture(release, "lib/node_modules/npm/bin/npm-cli.js", "synthetic npm");
			return { stdout: "" };
		}
		if (args[0]?.endsWith("npm-cli.js") && args[1] === "ci") {
			const release = path.dirname(options.cwd);
			await writeFixture(release, "app/node_modules/@openai/codex/bin/codex.js", "synthetic codex launcher", 0o755);
			await writeFixture(release, "app/node_modules/@playwright/mcp/cli.js", "synthetic mcp", 0o755);
			if (installNative) {
				await writeFixture(release, `app/node_modules/${nativeCodexFixture.package}/package.json`, JSON.stringify({
					name: "@openai/codex",
					version: `0.154.0-${nativeCodexFixture.platform}`,
				}));
				await writeFixture(release, nativeExecutable(), "synthetic native codex", 0o755);
			}
			return { stdout: "" };
		}
		if (args[0]?.endsWith("/node_modules/@openai/codex/bin/codex.js") && args[1] === "--version") {
			return { stdout: versionOutput };
		}
		throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
	};
	const installer = new ToolchainInstaller({
		repoRoot: repo,
		dataHome,
		environment: {
			PATH: process.env.PATH,
			HOME: path.join(root, "host-home"),
			npm_config_omit: "optional",
			NPM_CONFIG_USERCONFIG: path.join(root, "hostile-user-npmrc"),
			NPM_CONFIG_GLOBALCONFIG: path.join(root, "hostile-global-npmrc"),
		},
		downloadImpl: async (_url, destination) => fs.writeFile(destination, archive),
		execImpl,
	});
	return { calls, dataHome, installer };
}

test("toolchain install strips ambient npm config, includes optional Codex, and performs bounded identity check", async (t) => {
	const { calls, installer } = await fakeInstallHarness(t);
	const identity = await installer.install({ skipBrowser: true });
	assert.ok(identity.executables[nativeExecutable()]);
	const npmCall = calls.find(({ args }) => args[0]?.endsWith("npm-cli.js"));
	assert.ok(npmCall);
	assert.ok(npmCall.args.includes("--include=optional"));
	assert.ok(npmCall.args.some((argument) => argument.includes("/.npmrc-user")));
	assert.ok(npmCall.args.some((argument) => argument.includes("/.npmrc-global")));
	assert.deepEqual(Object.keys(npmCall.options.env).filter((name) => name.toLowerCase().startsWith("npm_config_")), []);
	const versionCall = calls.find(({ args }) => args[1] === "--version");
	assert.ok(versionCall);
	assert.equal(versionCall.options.timeout, 15_000);
	assert.equal(versionCall.options.killSignal, "SIGKILL");
});

test("toolchain install does not promote a native Codex with the wrong version identity", async (t) => {
	const { dataHome, installer } = await fakeInstallHarness(t, { versionOutput: "codex-cli 0.153.0\n" });
	await assert.rejects(() => installer.install({ skipBrowser: true }), /Codex version identity check failed/);
	await assert.rejects(() => fs.lstat(path.join(dataHome, "toolchains", "current")), { code: "ENOENT" });
	const releases = await fs.readdir(path.join(dataHome, "toolchains", "releases"));
	assert.deepEqual(releases, []);
});

test("toolchain install cannot certify an npm result missing the native Codex dependency", async (t) => {
	const { dataHome, installer } = await fakeInstallHarness(t, { installNative: false });
	await assert.rejects(() => installer.install({ skipBrowser: true }), /Codex native package file is missing or invalid/);
	await assert.rejects(() => fs.lstat(path.join(dataHome, "toolchains", "current")), { code: "ENOENT" });
	const releases = await fs.readdir(path.join(dataHome, "toolchains", "releases"));
	assert.deepEqual(releases, []);
});

test("receipt validation rejects missing and tampered native Codex executables", async (t) => {
	const root = await testTempDirectory("codex-toolchain-integrity-");
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const dataHome = path.join(root, "data");
	const releaseId = `synthetic-${nativeCodexFixture.platform}`;
	const release = path.join(dataHome, "toolchains", "releases", releaseId);
	const nativePath = nativeExecutable();
	const files = {
		"node/bin/node": "node-runtime",
		"node/lib/node_modules/npm/bin/npm-cli.js": "npm-cli",
		"app/node_modules/@openai/codex/bin/codex.js": "codex-cli",
		"app/node_modules/@playwright/mcp/cli.js": "mcp-cli",
		[nativePath]: "native-codex",
	};
	for (const [relative, contents] of Object.entries(files)) {
		const destination = path.join(release, ...relative.split("/"));
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, contents, { mode: relative === "node/bin/node" || relative === nativePath ? 0o755 : 0o644 });
	}
	await fs.writeFile(path.join(release, "app", "node_modules", nativeCodexFixture.package, "package.json"), JSON.stringify({
		name: "@openai/codex",
		version: `0.154.0-${nativeCodexFixture.platform}`,
	}));
	const packageLock = await fs.readFile(path.join(repoRoot, "toolchain/package-lock.json"));
	await fs.writeFile(path.join(release, "app", "package-lock.json"), packageLock);
	const executables = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([relative, contents]) => [
		relative,
		crypto.createHash("sha256").update(contents).digest("hex"),
	]));
	const identity = {
		releaseId,
		platform: nativeCodexFixture.platform,
		nodeVersion: "22.22.0",
		componentLockSha256: crypto.createHash("sha256").update("component").digest("hex"),
		packageLockSha256: crypto.createHash("sha256").update(packageLock).digest("hex"),
		browserInstalled: false,
		executables,
	};
	await fs.writeFile(path.join(release, "install-receipt.json"), `${JSON.stringify({ schema: 2, ...identity }, null, 2)}\n`);
	const installer = new ToolchainInstaller({ repoRoot, dataHome });
	assert.deepEqual(await installer.releaseIdentity(release), identity);
	const omittedIdentity = structuredClone(identity);
	delete omittedIdentity.executables[nativePath];
	await fs.writeFile(path.join(release, "install-receipt.json"), `${JSON.stringify({ schema: 2, ...omittedIdentity }, null, 2)}\n`);
	await assert.rejects(() => installer.releaseIdentity(release), /toolchain receipt omits required executable/);
	await fs.writeFile(path.join(release, "install-receipt.json"), `${JSON.stringify({ schema: 2, ...identity }, null, 2)}\n`);
	const nativeAbsolute = path.join(release, ...nativePath.split("/"));
	await fs.rm(nativeAbsolute);
	await assert.rejects(() => installer.releaseIdentity(release), /Codex native package file is missing or invalid/);
	await fs.writeFile(nativeAbsolute, files[nativePath], { mode: 0o755 });
	await fs.writeFile(nativeAbsolute, "tampered native Codex", { mode: 0o755 });
	await assert.rejects(() => installer.releaseIdentity(release), /executable checksum inventory mismatch/);
});
