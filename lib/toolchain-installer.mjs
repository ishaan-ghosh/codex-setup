import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { atomicWrite, sha256, stableJson } from "./atomic.mjs";
import { assertNoSymlinkComponents, assertSafeRoot, classify } from "./safety.mjs";

const execFile = promisify(execFileCallback);
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const CODEX_VERSION_TIMEOUT_MS = 15_000;

const CODEX_NATIVE_BY_PLATFORM = Object.freeze({
	"darwin-arm64": Object.freeze({ package: "@openai/codex-darwin-arm64", target: "aarch64-apple-darwin" }),
	"linux-x64": Object.freeze({ package: "@openai/codex-linux-x64", target: "x86_64-unknown-linux-musl" }),
});

export function codexNativeSpec(platform) {
	const selected = CODEX_NATIVE_BY_PLATFORM[platform];
	if (!selected) throw new Error(`Codex native package is unavailable for ${platform}`);
	return {
		...selected,
		packageRoot: `app/node_modules/${selected.package}`,
		executable: `app/node_modules/${selected.package}/vendor/${selected.target}/bin/codex`,
	};
}

function nativeCodexLock(packageLock, platform, codexVersion) {
	const spec = codexNativeSpec(platform);
	const codexLocked = packageLock?.packages?.["node_modules/@openai/codex"];
	const expectedVersion = `${codexVersion}-${platform}`;
	const expectedAlias = `npm:@openai/codex@${expectedVersion}`;
	const nativeLocked = packageLock?.packages?.[`node_modules/${spec.package}`];
	if (codexLocked?.optionalDependencies?.[spec.package] !== expectedAlias
		|| nativeLocked?.name !== "@openai/codex"
		|| nativeLocked?.version !== expectedVersion
		|| typeof nativeLocked?.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(nativeLocked.integrity)
		|| nativeLocked?.optional !== true) {
		throw new Error(`Codex native package lock identity is invalid for ${platform}`);
	}
	return { ...spec, version: expectedVersion };
}

function npmInstallEnvironment(environment) {
	return Object.fromEntries(Object.entries(environment).filter(([name]) => !name.toLowerCase().startsWith("npm_config_")));
}

export function toolchainReleaseId({ nodeVersion, platform, componentLockSha256, packageLockSha256, browserInstalled = true }) {
	if (typeof nodeVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nodeVersion)
		|| typeof platform !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(platform)
		|| !/^[0-9a-f]{64}$/.test(componentLockSha256 ?? "")
		|| !/^[0-9a-f]{64}$/.test(packageLockSha256 ?? "")) {
		throw new Error("cannot derive a toolchain release id from invalid lock identity");
	}
	const base = `${nodeVersion}-${platform}-c${componentLockSha256.slice(0, 12)}-p${packageLockSha256.slice(0, 12)}`;
	return browserInstalled ? base : `${base}-no-browser`;
}

function runtimePlatform() {
	if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
	if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
	throw new Error(`toolchain is unavailable for ${process.platform}-${process.arch}`);
}

async function download(url, destination, redirects = 0) {
	if (redirects > 5) throw new Error("too many redirects while downloading Node.js");
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))) {
		throw new Error(`refusing non-HTTPS toolchain URL: ${url}`);
	}
	const client = parsed.protocol === "https:" ? https : http;
	const response = await new Promise((resolve, reject) => {
		const request = client.get(parsed, { headers: { "user-agent": "codex-setup/1" } }, resolve);
		request.on("error", reject);
	});
	if (new Set([301, 302, 303, 307, 308]).has(response.statusCode)) {
		response.resume();
		if (!response.headers.location) throw new Error("toolchain redirect omitted Location");
		return download(new URL(response.headers.location, parsed).toString(), destination, redirects + 1);
	}
	if (response.statusCode !== 200) {
		response.resume();
		throw new Error(`toolchain download returned HTTP ${response.statusCode}`);
	}
	const declared = Number(response.headers["content-length"] ?? 0);
	if (declared > MAX_DOWNLOAD_BYTES) {
		response.destroy();
		throw new Error("toolchain archive exceeds size limit");
	}
	const handle = await fs.open(destination, "wx", 0o600);
	let received = 0;
	try {
		for await (const chunk of response) {
			received += chunk.length;
			if (received > MAX_DOWNLOAD_BYTES) throw new Error("toolchain archive exceeds size limit");
			await handle.write(chunk);
		}
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function validateLocks(componentLock, packageJson, packageLock, platform) {
	if (!componentLock || componentLock.schema !== 1) throw new Error("component-lock.json schema must be exactly 1");
	const node = componentLock.components?.node;
	const artifact = node?.artifacts?.[platform];
	if (!node || typeof node.version !== "string" || !artifact || typeof artifact.file !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
		throw new Error(`component lock has no valid Node.js artifact for ${platform}`);
	}
	if (!/^https:\/\//.test(node.base_url ?? "")) throw new Error("Node.js base URL must use HTTPS");
	if (artifact.file.includes("/") || artifact.file.includes("..")) throw new Error("Node.js artifact filename is unsafe");
	if (packageLock?.lockfileVersion !== 3 || packageLock?.packages?.[""]?.name !== packageJson.name) throw new Error("toolchain package lock contract is invalid");
	for (const name of ["codex", "playwright_mcp"]) {
		const component = componentLock.components?.[name];
		if (!component || packageJson.dependencies?.[component.package] !== component.version) throw new Error(`${name} package version is not pinned consistently`);
		const locked = packageLock.packages?.[`node_modules/${component.package}`];
		if (locked?.version !== component.version || locked?.integrity !== component.integrity) throw new Error(`${name} package lock identity does not match component-lock.json`);
	}
	if (componentLock.components.playwright_mcp.browser !== "chromium") throw new Error("only the pinned Chromium browser is supported");
	const codexVersion = componentLock.components.codex.version;
	const nativeCodex = nativeCodexLock(packageLock, platform, codexVersion);
	return { node, artifact, codexVersion, nativeCodex };
}


const BASE_REQUIRED_EXECUTABLES = [
	"node/bin/node",
	"node/lib/node_modules/npm/bin/npm-cli.js",
	"app/node_modules/@openai/codex/bin/codex.js",
	"app/node_modules/@playwright/mcp/cli.js",
];

function requiredExecutables(platform) {
	return [...BASE_REQUIRED_EXECUTABLES, codexNativeSpec(platform).executable];
}

export function validateToolchainIdentity(identity, label = "toolchain identity") {
	if (!identity || typeof identity !== "object"
		|| typeof identity.releaseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(identity.releaseId)
		|| typeof identity.platform !== "string" || typeof identity.nodeVersion !== "string"
		|| !/^[0-9a-f]{64}$/.test(identity.componentLockSha256 ?? "")
		|| !/^[0-9a-f]{64}$/.test(identity.packageLockSha256 ?? "")
		|| typeof identity.browserInstalled !== "boolean"
		|| !identity.executables || typeof identity.executables !== "object" || Array.isArray(identity.executables)) {
		throw new Error(`${label} is invalid`);
	}
	for (const [relative, digest] of Object.entries(identity.executables)) {
		if (!relative || path.posix.isAbsolute(relative)
			|| relative.split("/").some((part) => !part || part === "." || part === "..")
			|| !/^[0-9a-f]{64}$/.test(digest)) {
			throw new Error(`${label} contains an invalid executable checksum`);
		}
	}
	for (const required of BASE_REQUIRED_EXECUTABLES) {
		if (!identity.executables[required]) throw new Error(`${label} omits required executable ${required}`);
	}
	return identity;
}

function receiptIdentity(receipt) {
	if (receipt?.schema !== 2) throw new Error("toolchain receipt schema is unsupported");
	const identity = validateToolchainIdentity({
		releaseId: receipt.releaseId,
		platform: receipt.platform,
		nodeVersion: receipt.nodeVersion,
		componentLockSha256: receipt.componentLockSha256,
		packageLockSha256: receipt.packageLockSha256,
		browserInstalled: receipt.browserInstalled,
		executables: receipt.executables,
	});
	for (const required of requiredExecutables(identity.platform)) {
		if (!identity.executables[required]) throw new Error(`toolchain receipt omits required executable ${required}`);
	}
	return identity;
}

function identitiesEqual(left, right) {
	return stableJson(validateToolchainIdentity(left)) === stableJson(validateToolchainIdentity(right));
}

async function validateNativeCodexPackage(releaseDir, nativeCodex) {
	const packageJsonPath = path.join(releaseDir, ...nativeCodex.packageRoot.split("/"), "package.json");
	const executablePath = path.join(releaseDir, ...nativeCodex.executable.split("/"));
	for (const candidate of [packageJsonPath, executablePath]) {
		await assertNoSymlinkComponents(candidate, "Codex native package");
		if ((await classify(candidate)) !== "file") throw new Error(`Codex native package file is missing or invalid: ${candidate}`);
	}
	let packageJson;
	try {
		packageJson = JSON.parse(await fs.readFile(packageJsonPath));
	} catch (error) {
		throw new Error(`Codex native package metadata is invalid: ${error.message}`);
	}
	if (packageJson.name !== "@openai/codex" || packageJson.version !== nativeCodex.version) {
		throw new Error(`Codex native package identity does not match ${nativeCodex.package}@${nativeCodex.version}`);
	}
	const executable = await fs.lstat(executablePath);
	if (!executable.isFile() || (executable.mode & 0o111) === 0) {
		throw new Error(`Codex native executable is not an executable regular file: ${nativeCodex.executable}`);
	}
}

async function executableHashes(releaseDir, platform, browserInstalled) {
	const selected = new Set(requiredExecutables(platform));
	const roots = ["node/bin", "app/node_modules/@openai", "app/node_modules/@playwright"];
	if (browserInstalled) roots.push("browsers");
	const visit = async (relative) => {
		let entries;
		try {
			entries = await fs.readdir(path.join(releaseDir, ...relative.split("/")), { withFileTypes: true });
		} catch (error) {
			if (error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			const child = path.posix.join(relative, entry.name);
			if (entry.isDirectory()) await visit(child);
			else if (entry.isFile()) {
				const mode = (await fs.lstat(path.join(releaseDir, ...child.split("/")))).mode & 0o777;
				if ((mode & 0o111) !== 0) selected.add(child);
			}
		}
	};
	for (const root of roots) await visit(root);
	const result = {};
	for (const relative of [...selected].sort()) {
		const absolute = path.join(releaseDir, ...relative.split("/"));
		await assertNoSymlinkComponents(absolute, `toolchain executable ${relative}`, { allowMissing: false });
		if (!(await fs.lstat(absolute)).isFile()) throw new Error(`toolchain executable is not a regular file: ${relative}`);
		result[relative] = sha256(await fs.readFile(absolute));
	}
	return result;
}

export class ToolchainInstaller {
	constructor({ repoRoot, dataHome, dryRun = false, output = console, downloadImpl = download, execImpl = execFile, environment = process.env }) {
		this.repoRoot = repoRoot;
		this.dataHome = dataHome;
		this.root = path.join(dataHome, "toolchains");
		this.dryRun = dryRun;
		this.output = output;
		this.download = downloadImpl;
		this.exec = execImpl;
		this.environment = environment;
	}

	async locks() {
		const platform = runtimePlatform();
		const componentLockPath = path.join(this.repoRoot, "component-lock.json");
		const packagePath = path.join(this.repoRoot, "toolchain", "package.json");
		const packageLockPath = path.join(this.repoRoot, "toolchain", "package-lock.json");
		for (const candidate of [componentLockPath, packagePath, packageLockPath]) {
			await assertNoSymlinkComponents(candidate, "toolchain lock input", { allowMissing: false });
		}
		const [componentBytes, packageBytes, packageLockBytes] = await Promise.all([
			fs.readFile(componentLockPath), fs.readFile(packagePath), fs.readFile(packageLockPath),
		]);
		let componentLock;
		let packageJson;
		let packageLock;
		try {
			componentLock = JSON.parse(componentBytes);
			packageJson = JSON.parse(packageBytes);
			packageLock = JSON.parse(packageLockBytes);
		} catch (error) {
			throw new Error(`toolchain lock input is invalid JSON: ${error.message}`);
		}
		const { node, artifact, codexVersion, nativeCodex } = validateLocks(componentLock, packageJson, packageLock, platform);
		return {
			platform, componentBytes, packageBytes, packageLockBytes, node, artifact, codexVersion, nativeCodex,
			componentLockSha256: sha256(componentBytes),
			packageLockSha256: sha256(packageLockBytes),
		};
	}

	async releaseIdentity(finalDir) {
		await assertNoSymlinkComponents(finalDir, "versioned toolchain path", { allowMissing: false });
		let receipt;
		try {
			receipt = JSON.parse(await fs.readFile(path.join(finalDir, "install-receipt.json")));
		} catch (error) {
			throw new Error(`versioned toolchain has no valid receipt: ${finalDir}: ${error.message}`);
		}
		const identity = receiptIdentity(receipt);
		if (identity.releaseId !== path.basename(finalDir)) throw new Error("toolchain receipt release id does not match its directory");
		const installedPackageLock = await fs.readFile(path.join(finalDir, "app", "package-lock.json")).catch(() => null);
		if (!installedPackageLock || sha256(installedPackageLock) !== identity.packageLockSha256) {
			throw new Error("toolchain installed package lock checksum mismatch");
		}
		let parsedPackageLock;
		try {
			parsedPackageLock = JSON.parse(installedPackageLock);
		} catch (error) {
			throw new Error(`toolchain installed package lock is invalid JSON: ${error.message}`);
		}
		const codexVersion = parsedPackageLock.packages?.["node_modules/@openai/codex"]?.version;
		if (typeof codexVersion !== "string") throw new Error("toolchain installed package lock omits Codex");
		const nativeCodex = nativeCodexLock(parsedPackageLock, identity.platform, codexVersion);
		await validateNativeCodexPackage(finalDir, nativeCodex);
		const actualExecutables = await executableHashes(finalDir, identity.platform, identity.browserInstalled);
		if (stableJson(actualExecutables) !== stableJson(identity.executables)) {
			throw new Error("toolchain executable checksum inventory mismatch");
		}
		if (identity.browserInstalled) {
			const browsers = await fs.readdir(path.join(finalDir, "browsers")).catch(() => []);
			if (browsers.length === 0) throw new Error("toolchain receipt claims a browser but none is installed");
		}
		return identity;
	}

	async currentIdentity({ matchCheckout = true, requireBrowser = false } = {}) {
		await assertSafeRoot(this.dataHome, "codex-setup data directory");
		await assertNoSymlinkComponents(this.root, "toolchain root");
		const current = path.join(this.root, "current");
		if ((await classify(current)) !== "symlink") {
			throw new Error("managed toolchain current pointer is missing or invalid; run ./bin/bootstrap");
		}
		const link = await fs.readlink(current);
		if (!/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(link)) throw new Error("toolchain current pointer is unsafe");
		const identity = await this.releaseIdentity(path.join(this.root, ...link.split("/")));
		if (requireBrowser && !identity.browserInstalled) {
			throw new Error("managed toolchain has no pinned browser; rerun ./bin/bootstrap without --skip-browser");
		}
		if (matchCheckout) {
			const locks = await this.locks();
			const baseReleaseId = toolchainReleaseId({
				nodeVersion: locks.node.version,
				platform: locks.platform,
				componentLockSha256: locks.componentLockSha256,
				packageLockSha256: locks.packageLockSha256,
			});
			if (identity.platform !== locks.platform
				|| identity.nodeVersion !== locks.node.version
				|| identity.componentLockSha256 !== locks.componentLockSha256
				|| identity.packageLockSha256 !== locks.packageLockSha256
				|| !new Set([baseReleaseId, toolchainReleaseId({ ...locks, nodeVersion: locks.node.version, browserInstalled: false })]).has(identity.releaseId)) {
				throw new Error("managed toolchain does not match this checkout; run ./bin/bootstrap");
			}
		}
		return identity;
	}

	async validateReleaseIdentity(identity) {
		validateToolchainIdentity(identity);
		const actual = await this.releaseIdentity(path.join(this.root, "releases", identity.releaseId));
		if (!identitiesEqual(actual, identity)) {
			throw new Error(`toolchain release no longer matches recorded identity: ${identity.releaseId}`);
		}
		return actual;
	}

	async switchToIdentity(identity) {
		await this.validateReleaseIdentity(identity);
		const releases = path.join(this.root, "releases");
		await this.switchCurrent({
			releases,
			finalDir: path.join(releases, identity.releaseId),
			releaseId: identity.releaseId,
		});
		return identity;
	}

	async install({ skipBrowser = false } = {}) {
		await assertSafeRoot(this.dataHome, "codex-setup data directory");
		await assertNoSymlinkComponents(this.root, "toolchain root");
		const locks = await this.locks();
		const { platform, componentBytes, packageBytes, packageLockBytes, node, artifact, codexVersion, nativeCodex } = locks;
		const baseReleaseId = toolchainReleaseId({
			nodeVersion: node.version,
			platform,
			componentLockSha256: locks.componentLockSha256,
			packageLockSha256: locks.packageLockSha256,
		});
		const releases = path.join(this.root, "releases");
		let releaseId = baseReleaseId;
		if (skipBrowser && (await classify(path.join(releases, baseReleaseId))) === "missing") releaseId = toolchainReleaseId({
			nodeVersion: node.version,
			platform,
			componentLockSha256: locks.componentLockSha256,
			packageLockSha256: locks.packageLockSha256,
			browserInstalled: false,
		});
		const finalDir = path.join(releases, releaseId);
		const nodeDir = path.join(finalDir, "node");
		const appDir = path.join(finalDir, "app");
		const current = path.join(this.root, "current");
		if (this.dryRun) {
			this.output.log(`[dry-run] download and verify ${node.base_url}/${artifact.file}`);
			this.output.log(`[dry-run] stage Node.js ${releaseId}, npm ci --ignore-scripts --include=optional, verify Codex ${codexVersion}${skipBrowser ? "" : ", and pinned Chromium"}`);
			this.output.log(`[dry-run] atomically switch ${current}`);
			return;
		}
		await fs.mkdir(releases, { recursive: true, mode: 0o700 });
		await assertNoSymlinkComponents(releases, "toolchain releases path", { allowMissing: false });
		await assertNoSymlinkComponents(finalDir, "versioned toolchain path");
		const finalKind = await classify(finalDir);
		if (finalKind !== "missing" && finalKind !== "directory") throw new Error(`versioned toolchain path is not a directory: ${finalDir}`);
		if (finalKind !== "missing") {
			const identity = await this.releaseIdentity(finalDir);
			if (identity.componentLockSha256 !== locks.componentLockSha256
				|| identity.packageLockSha256 !== locks.packageLockSha256
				|| identity.nodeVersion !== node.version
				|| identity.platform !== platform
				|| (!skipBrowser && !identity.browserInstalled)) {
				throw new Error(`existing versioned toolchain does not match the exact lock: ${finalDir}`);
			}
			await this.switchCurrent({ releases, finalDir, releaseId });
			this.output.log(`toolchain already installed and selected: ${releaseId}`);
			return identity;
		}
		const nonce = crypto.randomBytes(8).toString("hex");
		const archive = path.join(this.root, `.download-${nonce}.tar.gz`);
		const staging = path.join(releases, `.${releaseId}.staging-${nonce}`);
		const stagingNode = path.join(staging, "node");
		const stagingApp = path.join(staging, "app");
		const stagingBrowsers = path.join(staging, "browsers");
		let finalCreated = false;
		await fs.mkdir(staging, { mode: 0o700 });
		try {
			await this.download(`${node.base_url}/${artifact.file}`, archive);
			const downloaded = await fs.readFile(archive);
			if (sha256(downloaded) !== artifact.sha256) throw new Error(`Node.js archive checksum mismatch for ${artifact.file}`);
			const listing = await this.exec("tar", ["-tzf", archive], { maxBuffer: 16 * 1024 * 1024 });
			for (const member of listing.stdout.split("\n").filter(Boolean)) {
				const normalized = member.replace(/\/$/, "");
				if (normalized.startsWith("/") || normalized.includes("\\") || normalized.split("/").includes("..")) {
					throw new Error(`unsafe archive member: ${member}`);
				}
			}
			await fs.mkdir(stagingNode);
			await fs.mkdir(stagingApp);
			await fs.mkdir(stagingBrowsers);
			await this.exec("tar", ["-xzf", archive, "--strip-components=1", "-C", stagingNode]);
			const stagedNode = path.join(stagingNode, "bin", "node");
			if ((await classify(stagedNode)) !== "file") throw new Error("extracted Node.js runtime is missing node/bin/node");
			await fs.writeFile(path.join(stagingApp, "package.json"), packageBytes, { mode: 0o600, flag: "wx" });
			await fs.writeFile(path.join(stagingApp, "package-lock.json"), packageLockBytes, { mode: 0o600, flag: "wx" });
			const npmUserConfig = path.join(staging, ".npmrc-user");
			const npmGlobalConfig = path.join(staging, ".npmrc-global");
			await fs.writeFile(npmUserConfig, "", { mode: 0o600, flag: "wx" });
			await fs.writeFile(npmGlobalConfig, "", { mode: 0o600, flag: "wx" });
			const npmCli = path.join(stagingNode, "lib", "node_modules", "npm", "bin", "npm-cli.js");
			if ((await classify(npmCli)) !== "file") throw new Error("extracted Node.js runtime is missing the pinned npm CLI");
			await this.exec(stagedNode, [npmCli, "ci", "--ignore-scripts", "--include=optional", `--userconfig=${npmUserConfig}`, `--globalconfig=${npmGlobalConfig}`], {
				cwd: stagingApp,
				env: npmInstallEnvironment(this.environment),
				maxBuffer: 16 * 1024 * 1024,
			});
			await validateNativeCodexPackage(staging, nativeCodex);
			const codexCli = path.join(stagingApp, "node_modules", "@openai", "codex", "bin", "codex.js");
			const version = await this.exec(stagedNode, [codexCli, "--version"], {
				cwd: stagingApp,
				env: npmInstallEnvironment(this.environment),
				timeout: CODEX_VERSION_TIMEOUT_MS,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
			});
			if (version.stdout.trim() !== `codex-cli ${codexVersion}`) {
				throw new Error(`Codex version identity check failed: expected codex-cli ${codexVersion}`);
			}
			if (!skipBrowser) {
				const playwrightCli = path.join(stagingApp, "node_modules", "playwright", "cli.js");
				if ((await classify(playwrightCli)) !== "file") throw new Error("pinned Playwright CLI was not installed");
				await this.exec(stagedNode, [playwrightCli, "install", "chromium"], {
					cwd: stagingApp,
					env: { ...this.environment, PLAYWRIGHT_BROWSERS_PATH: stagingBrowsers },
					maxBuffer: 16 * 1024 * 1024,
				});
			}
			const identity = {
				releaseId,
				platform,
				nodeVersion: node.version,
				componentLockSha256: locks.componentLockSha256,
				packageLockSha256: locks.packageLockSha256,
				browserInstalled: !skipBrowser,
				executables: await executableHashes(staging, platform, !skipBrowser),
			};
			await atomicWrite(path.join(staging, "install-receipt.json"), stableJson({
				schema: 2,
				...identity,
				nodeArchiveSha256: artifact.sha256,
				installedAt: new Date().toISOString(),
			}), 0o600);
			await fs.rename(staging, finalDir);
			finalCreated = true;
			await this.switchCurrent({ releases, finalDir, releaseId });
		} catch (error) {
			await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
			if (finalCreated) await fs.rm(finalDir, { recursive: true, force: true }).catch(() => {});
			throw error;
		} finally {
			await fs.rm(archive, { force: true }).catch(() => {});
		}
		this.output.log(`toolchain installed: Node.js ${node.version} for ${platform}${skipBrowser ? " (browser skipped)" : " with pinned Chromium"}`);
		return this.currentIdentity();
	}

	async switchCurrent({ releases, finalDir, releaseId }) {
		const current = path.join(this.root, "current");
		let previous = null;
		const currentKind = await classify(current);
		if (currentKind !== "missing") {
			if (currentKind !== "symlink") throw new Error(`toolchain current pointer is not a symbolic link: ${current}`);
			const link = await fs.readlink(current);
			if (!/^releases\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(link)) throw new Error("toolchain current pointer is unsafe");
			const resolved = path.resolve(this.root, link);
			previous = path.basename(resolved);
			if (resolved === finalDir) return;
		}
		const nonce = crypto.randomBytes(8).toString("hex");
		const temporaryLink = path.join(this.root, `.current-${nonce}`);
		await fs.symlink(path.relative(this.root, finalDir), temporaryLink, "dir");
		await fs.rename(temporaryLink, current);
		try {
			await atomicWrite(path.join(this.root, "toolchain-state.json"), stableJson({
				schema: 1,
				current: releaseId,
				previous,
				playwrightBrowsersPath: path.join(finalDir, "browsers"),
				updatedAt: new Date().toISOString(),
			}), 0o600);
		} catch (error) {
			if (previous) {
				const restore = path.join(this.root, `.current-restore-${nonce}`);
				await fs.symlink(path.join("releases", previous), restore, "dir");
				await fs.rename(restore, current);
			} else {
				await fs.unlink(current).catch(() => {});
			}
			throw error;
		}
	}
}
