import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, readFileIfPresent, sha256, stableJson } from "./atomic.mjs";
import {
	createManagedRollbackDelta,
	mergeManaged,
	parseConfig,
	removeManaged,
	restoreManagedRollbackDelta,
	serializeConfig,
	validateManagedPaths,
	validateManagedRollbackDelta,
} from "./config.mjs";
import { loadRelease, TARGET_ROOTS } from "./release.mjs";
import { ToolchainInstaller, validateToolchainIdentity } from "./toolchain-installer.mjs";
import { assertManagedTarget, assertNoSymlinkComponents, assertSafeRoot, inside } from "./safety.mjs";

const STATE_SCHEMA = 3;
const TRANSACTION_SCHEMA = 3;
const MODES = new Set([0o600, 0o644, 0o755]);
const validPosixMode = (value) => Number.isInteger(value) && value >= 0 && value <= 0o777;
const RESOURCE_KINDS = new Set(["file", "json-merge", "toml-merge"]);

function timestamp() {
	return new Date().toISOString().replaceAll(":", "").replaceAll("-", "").replace(/\.\d{3}Z$/, "Z");
}

async function readJson(filePath, label) {
	let bytes;
	try {
		bytes = await fs.readFile(filePath);
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
	try {
		return JSON.parse(bytes);
	} catch (error) {
		throw new Error(`${label} is invalid JSON: ${error.message}`);
	}
}

function resourceKey(value) {
	return `${value.targetRoot ?? "codex_home"}:${value.target}`;
}

function emptyObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function validateState(state) {
	if (!state || typeof state !== "object" || state.schema !== STATE_SCHEMA || typeof state.version !== "string" || !Array.isArray(state.resources)) {
		throw new Error("managed state is missing or has an unsupported schema");
	}
	validateToolchainIdentity(state.toolchain, "managed state toolchain identity");
	const keys = new Set();
	for (const resource of state.resources) {
		resource.targetRoot ??= "codex_home";
		if (!TARGET_ROOTS.has(resource.targetRoot)) throw new Error("managed state contains an unsupported target root");
		assertManagedTarget(resource.target);
		if (!RESOURCE_KINDS.has(resource.kind)) throw new Error("managed state contains an unsupported resource kind");
		if (!MODES.has(resource.mode)) throw new Error("managed state contains an unsupported resource mode");
		if (resource.kind === "file") {
			if (!/^[0-9a-f]{64}$/.test(resource.installedSha256 ?? "")) throw new Error("managed state contains an invalid checksum");
			if (resource.managedPaths !== undefined) throw new Error("managed state contains paths for a non-merge resource");
		} else {
			if (Object.hasOwn(resource, "installedSha256")) throw new Error("managed state contains a whole-file checksum for a merge resource");
			validateManagedPaths(resource.managedPaths, "managed state config paths");
		}
		const key = resourceKey(resource);
		if (keys.has(key)) throw new Error(`managed state contains duplicate resource: ${key}`);
		keys.add(key);
	}
	return state;
}

export class Lifecycle {
	constructor({ repoRoot, codexHome, dataHome, userHome, localBin, dryRun = false, output = console, toolchain }) {
		this.repoRoot = repoRoot;
		this.codexHome = codexHome;
		this.dataHome = dataHome;
		this.userHome = userHome ?? path.dirname(codexHome);
		this.localBin = localBin ?? path.join(this.userHome, ".local", "bin");
		this.dryRun = dryRun;
		this.output = output;
		this.toolchain = toolchain ?? new ToolchainInstaller({ repoRoot, dataHome, dryRun, output });
		this.stateDir = path.join(codexHome, ".codex-setup");
		this.statePath = path.join(this.stateDir, "state.json");
		this.backupsDir = path.join(this.stateDir, "backups");
	}

	rootFor(targetRoot) {
		if (targetRoot === "codex_home") return this.codexHome;
		if (targetRoot === "user_home") return this.userHome;
		if (targetRoot === "local_bin") return this.localBin;
		throw new Error(`unsupported target root: ${targetRoot}`);
	}

	resourcePath(resource) {
		return inside(this.rootFor(resource.targetRoot ?? "codex_home"), resource.target);
	}

	async preflightRoots({ write = false } = {}) {
		await assertSafeRoot(this.codexHome, "CODEX_HOME");
		await assertSafeRoot(this.userHome, "user home");
		await assertSafeRoot(this.localBin, "local bin");
		await assertSafeRoot(this.dataHome, "codex-setup data directory");
		await assertNoSymlinkComponents(this.stateDir, "lifecycle state path");
		if (write && !this.dryRun) {
			await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
			await assertNoSymlinkComponents(this.stateDir, "lifecycle state path", { allowMissing: false });
		}
	}

	async state({ optional = false } = {}) {
		const value = await readJson(this.statePath, "managed state");
		if (!value && optional) return null;
		return validateState(value);
	}

	async release(options = {}) {
		return loadRelease(options.release ? path.resolve(options.release) : path.join(this.repoRoot, "release.json"), this.repoRoot);
	}

	async coupledToolchains(previousState = null) {
		const currentToolchain = await this.toolchain.currentIdentity();
		const previousToolchain = previousState?.toolchain ?? currentToolchain;
		await this.toolchain.validateReleaseIdentity(previousToolchain);
		return { currentToolchain, previousToolchain };
	}

	async prepareResource(artifact, previous, { adopt = false } = {}) {
		const destination = this.resourcePath(artifact);
		await assertNoSymlinkComponents(destination, `managed target ${artifact.target}`);
		const kind = await this.pathKind(destination);
		if (!new Set(["missing", "file"]).has(kind)) throw new Error(`managed target must be absent or a regular file: ${artifact.target}`);
		const before = await readFileIfPresent(destination);
		const beforeMode = before ? (await fs.lstat(destination)).mode & 0o777 : null;
		if (previous) {
			if (!before) throw new Error(`managed resource is missing: ${artifact.target}`);
			if (beforeMode !== previous.mode) throw new Error(`managed resource mode drifted: ${artifact.target}`);
			if (artifact.kind === "file" && sha256(before) !== previous.installedSha256) {
				throw new Error(`managed resource drifted: ${artifact.target}`);
			}
			if (artifact.kind !== previous.kind) throw new Error(`resource kind changed across releases: ${artifact.target}`);
		} else if (before && artifact.kind === "file" && !adopt) {
			throw new Error(`unmanaged file blocks install: ${artifact.target}; use adopt only if it exactly matches the release`);
		}

		if (artifact.kind === "file") {
			if (adopt && before && sha256(before) !== artifact.sha256) throw new Error(`cannot adopt non-matching file: ${artifact.target}`);
			return {
				artifact, destination, before, beforeMode, after: artifact.contents,
				managedPaths: undefined, created: previous?.created ?? before === null,
			};
		}

		const fragment = parseConfig(artifact.kind, artifact.contents.toString("utf8"), `config fragment ${artifact.source}`);
		const current = before ? parseConfig(artifact.kind, before.toString("utf8"), `existing config ${artifact.target}`) : {};
		const base = previous?.managedPaths ? removeManaged(current, previous.managedPaths) : current;
		const merged = mergeManaged(base, fragment, { allowEqual: true });
		return {
			artifact, destination, before, beforeMode,
			after: Buffer.from(serializeConfig(artifact.kind, merged.value)),
			managedPaths: merged.paths,
			managedDelta: createManagedRollbackDelta(current, merged.value, previous?.managedPaths ?? [], merged.paths),
			created: previous?.created ?? before === null,
		};
	}

	async pathKind(candidate) {
		try {
			const info = await fs.lstat(candidate);
			if (info.isSymbolicLink()) return "symlink";
			if (info.isFile()) return "file";
			if (info.isDirectory()) return "directory";
			return "special";
		} catch (error) {
			if (error.code === "ENOENT") return "missing";
			throw error;
		}
	}

	async prepareRelease(release, state, options = {}) {
		const previousByTarget = new Map((state?.resources ?? []).map((entry) => [resourceKey(entry), entry]));
		const resources = [];
		for (const artifact of release.artifacts) {
			resources.push(await this.prepareResource(artifact, previousByTarget.get(resourceKey(artifact)), options));
		}
		for (const old of previousByTarget.values()) {
			if (release.artifacts.some((artifact) => resourceKey(artifact) === resourceKey(old))) continue;
			const destination = this.resourcePath(old);
			await assertNoSymlinkComponents(destination, `managed target ${old.target}`, { allowMissing: false });
			const before = await fs.readFile(destination);
			const beforeMode = (await fs.lstat(destination)).mode & 0o777;
			if (beforeMode !== old.mode) throw new Error(`managed resource mode drifted: ${old.target}`);
			let after = null;
			let managedDelta;
			if (old.kind === "file") {
				if (sha256(before) !== old.installedSha256) throw new Error(`managed resource drifted: ${old.target}`);
			} else {
				const current = parseConfig(old.kind, before.toString("utf8"), `existing config ${old.target}`);
				const stripped = removeManaged(current, old.managedPaths ?? []);
				if (!(old.created && emptyObject(stripped))) after = Buffer.from(serializeConfig(old.kind, stripped));
				managedDelta = createManagedRollbackDelta(current, stripped, old.managedPaths ?? [], []);
			}
			resources.push({
				artifact: { targetRoot: old.targetRoot, target: old.target, kind: old.kind, mode: old.mode },
				destination, before, beforeMode, after, removed: true, created: old.created, managedDelta,
			});
		}
		return resources;
	}

	async commitTransaction(action, release, prepared, previousState, { deactivate = false, currentToolchain, previousToolchain } = {}) {
		validateToolchainIdentity(currentToolchain, "transaction current toolchain");
		validateToolchainIdentity(previousToolchain, "transaction previous toolchain");
		await this.toolchain.validateReleaseIdentity(previousToolchain);
		const id = `${timestamp()}-${crypto.randomBytes(5).toString("hex")}`;
		const backupDir = path.join(this.backupsDir, id);
		const backupRecords = [];
		const written = [];
		if (this.dryRun) {
			for (const item of prepared) this.output.log(`[dry-run] ${item.removed ? "remove" : item.before ? "replace" : "create"} ${resourceKey(item.artifact)}`);
			this.output.log(`[dry-run] ${action} release ${release.version}`);
			return null;
		}
		await assertNoSymlinkComponents(backupDir, "transaction backup path");
		await fs.mkdir(this.backupsDir, { recursive: true, mode: 0o700 });
		await assertNoSymlinkComponents(this.backupsDir, "transaction backups path", { allowMissing: false });
		await fs.mkdir(backupDir, { recursive: false, mode: 0o700 });
		try {
			for (const [index, item] of prepared.entries()) {
				if (item.artifact.kind !== "file") {
					backupRecords.push({
						targetRoot: item.artifact.targetRoot ?? "codex_home",
						target: item.artifact.target,
						kind: item.artifact.kind,
						beforePresent: item.before !== null,
						afterPresent: item.after !== null,
						beforeMode: item.beforeMode,
						afterMode: item.after === null ? null : item.artifact.mode,
						created: item.created,
						managedDelta: item.managedDelta,
					});
					continue;
				}
				let backup = null;
				if (item.before !== null) {
					backup = `${String(index).padStart(4, "0")}.bak`;
					await atomicWrite(path.join(backupDir, backup), item.before, 0o600);
				}
				backupRecords.push({
					targetRoot: item.artifact.targetRoot ?? "codex_home",
					target: item.artifact.target,
					kind: "file",
					beforeSha256: item.before === null ? null : sha256(item.before),
					afterSha256: item.after === null ? null : sha256(item.after),
					beforeMode: item.beforeMode,
					afterMode: item.after === null ? null : item.artifact.mode,
					backup,
				});
			}
			await atomicWrite(path.join(backupDir, "transaction.json"), stableJson({
				schema: TRANSACTION_SCHEMA, id, action,
				fromToolchain: previousToolchain,
				toToolchain: currentToolchain,
				fromVersion: previousState?.version ?? null,
				toVersion: deactivate ? null : release.version,
				previousState: previousState ?? null,
				resources: backupRecords,
			}), 0o600);
			for (const item of prepared) {
				if (item.after === null) await fs.unlink(item.destination);
				else await atomicWrite(item.destination, item.after, item.artifact.mode);
				written.push(item);
			}
			if (deactivate) {
				await fs.rename(this.statePath, path.join(this.stateDir, `state.uninstalled-${id}.json`));
			} else {
				const active = prepared.filter((item) => !item.removed).map((item) => ({
					targetRoot: item.artifact.targetRoot ?? "codex_home",
					target: item.artifact.target,
					kind: item.artifact.kind,
					mode: item.artifact.mode,
					source: item.artifact.source,
					sourceSha256: item.artifact.sha256,
					...(item.artifact.kind === "file" ? { installedSha256: sha256(item.after) } : { managedPaths: item.managedPaths }),
					created: item.created,
				}));
				const nextState = {
					schema: STATE_SCHEMA, version: release.version, platform: release.platform,
					toolchain: currentToolchain,
					releaseManifestSha256: release.manifestSha256,
					installedAt: new Date().toISOString(), lastTransaction: id, resources: active,
				};
				await atomicWrite(this.statePath, stableJson(nextState), 0o600);
			}
		} catch (error) {
			let restorationFailed = false;
			for (const item of [...written].reverse()) {
				try {
					if (item.before === null) await fs.rm(item.destination, { force: true });
					else await atomicWrite(item.destination, item.before, item.beforeMode ?? item.artifact.mode);
				} catch {
					restorationFailed = true;
				}
			}
			try {
				if (previousState) await atomicWrite(this.statePath, stableJson(previousState), 0o600);
				else await fs.rm(this.statePath, { force: true });
			} catch {
				restorationFailed = true;
			}
			try {
				await this.toolchain.switchToIdentity(previousToolchain);
			} catch {
				restorationFailed = true;
			}
			throw new Error(`${action} failed${restorationFailed ? " and rollback was incomplete" : " and was rolled back"}: ${error.message}`);
		}
		this.output.log(`${action} complete: ${release.version} (${id})`);
		return id;
	}

	async install(options = {}) {
		await this.preflightRoots({ write: true });
		const current = await this.state({ optional: true });
		if (current) throw new Error(`codex-setup ${current.version} is already installed; use update`);
		const release = await this.release(options);
		const toolchains = await this.coupledToolchains();
		const prepared = await this.prepareRelease(release, null, options);
		await this.commitTransaction(options.adopt ? "adopt" : "install", release, prepared, null, toolchains);
	}

	async update(options = {}) {
		await this.preflightRoots({ write: true });
		const current = await this.state();
		let release;
		let toolchains;
		let prepared;
		try {
			release = await this.release(options);
			toolchains = await this.coupledToolchains(current);
			if (current.version === release.version && current.releaseManifestSha256 === release.manifestSha256
				&& stableJson(current.toolchain) === stableJson(toolchains.currentToolchain)) {
				this.output.log(`already at exact release ${current.version}`);
				return 0;
			}
			prepared = await this.prepareRelease(release, current);
		} catch (error) {
			if (this.dryRun) throw error;
			try {
				await this.toolchain.switchToIdentity(current.toolchain);
			} catch (restorationError) {
				throw new Error(`update failed and previous toolchain restoration failed: ${error.message}; ${restorationError.message}`);
			}
			throw error;
		}
		await this.commitTransaction("update", release, prepared, current, toolchains);
		return 0;
	}

	async doctor() {
		await this.preflightRoots();
		const issues = [];
		const current = await this.state({ optional: true });
		if (!current) issues.push("not installed: managed state is absent");
		else {
			try {
				const actualToolchain = await this.toolchain.currentIdentity({ matchCheckout: false });
				if (stableJson(actualToolchain) !== stableJson(current.toolchain)) issues.push("active toolchain differs from managed release state");
			} catch {
				issues.push("active toolchain is missing, drifted, or does not match this checkout");
			}
			for (const resource of current.resources) {
				const destination = this.resourcePath(resource);
				try {
					await assertNoSymlinkComponents(destination, `managed target ${resource.target}`, { allowMissing: false });
					const info = await fs.lstat(destination);
					if ((info.mode & 0o777) !== resource.mode) {
						issues.push(`mode drift: ${resourceKey(resource)}`);
						continue;
					}
					const contents = await fs.readFile(destination);
					if (resource.kind === "file") {
						if (sha256(contents) !== resource.installedSha256) issues.push(`drift: ${resourceKey(resource)}`);
					} else {
						const parsed = parseConfig(resource.kind, contents.toString("utf8"), "managed config");
						removeManaged(parsed, resource.managedPaths ?? []);
					}
				} catch {
					issues.push(`invalid, missing, or drifted managed resource: ${resourceKey(resource)}`);
				}
			}
		}
		if (issues.length) {
			for (const issue of issues) this.output.error(`doctor: ${issue}`);
			return 1;
		}
		this.output.log(`healthy: exact managed release ${current.version}; ${current.resources.length} resources and toolchain verified`);
		return 0;
	}

	async rollback(options = {}) {
		await this.preflightRoots({ write: true });
		const current = await this.state({ optional: true });
		const id = options.transaction ?? current?.lastTransaction;
		if (!id || !/^[0-9TZ]+-[0-9a-f]{10}$/.test(id)) throw new Error("rollback transaction id is invalid");
		const transactionDir = path.join(this.backupsDir, id);
		const transactionPath = path.join(transactionDir, "transaction.json");
		await assertNoSymlinkComponents(transactionPath, "rollback transaction", { allowMissing: false });
		const transaction = await readJson(transactionPath, "rollback transaction");
		if (!transaction || transaction.schema !== TRANSACTION_SCHEMA || transaction.id !== id || !Array.isArray(transaction.resources)) {
			throw new Error("rollback transaction is invalid");
		}
		validateToolchainIdentity(transaction.fromToolchain, "rollback previous toolchain");
		validateToolchainIdentity(transaction.toToolchain, "rollback current toolchain");
		if (current && current.lastTransaction !== id) throw new Error("only the active release transaction can be rolled back");
		if (!current && transaction.action !== "uninstall") throw new Error("no active managed state matches this rollback");
		if (transaction.previousState) {
			validateState(transaction.previousState);
			if (stableJson(transaction.previousState.toolchain) !== stableJson(transaction.fromToolchain)) {
				throw new Error("rollback previous state and toolchain identity disagree");
			}
		}
		if (current && stableJson(current.toolchain) !== stableJson(transaction.toToolchain)) {
			throw new Error("active state and rollback toolchain identity disagree");
		}
		const activeToolchain = await this.toolchain.currentIdentity({ matchCheckout: false });
		if (stableJson(activeToolchain) !== stableJson(transaction.toToolchain)) {
			throw new Error("active toolchain pointer does not match the rollback transaction");
		}
		await this.toolchain.validateReleaseIdentity(transaction.fromToolchain);

		const snapshots = [];
		const seenTargets = new Set();
		const seenBackups = new Set();
		for (const record of transaction.resources) {
			record.targetRoot ??= "codex_home";
			if (!TARGET_ROOTS.has(record.targetRoot)) throw new Error("rollback transaction contains an unsupported target root");
			assertManagedTarget(record.target);
			if (!RESOURCE_KINDS.has(record.kind)) throw new Error("rollback transaction contains an unsupported resource kind");
			const key = resourceKey(record);
			if (seenTargets.has(key)) throw new Error("rollback transaction contains a duplicate resource");
			seenTargets.add(key);
			const destination = this.resourcePath(record);
			await assertNoSymlinkComponents(destination, `rollback target ${record.target}`);
			const bytes = await readFileIfPresent(destination);
			const currentMode = bytes !== null ? (await fs.lstat(destination)).mode & 0o777 : null;
			let restored = null;
			let restoredMode = record.beforeMode;
			if (record.kind === "file") {
				const beforeDigestValid = record.beforeSha256 === null || /^[0-9a-f]{64}$/.test(record.beforeSha256 ?? "");
				const afterDigestValid = record.afterSha256 === null || /^[0-9a-f]{64}$/.test(record.afterSha256 ?? "");
				if (!beforeDigestValid || !afterDigestValid) throw new Error("rollback transaction contains an invalid resource checksum");
				if (record.beforeSha256 === null) {
					if (record.backup !== null || record.beforeMode !== null) throw new Error("rollback transaction has inconsistent absent-resource metadata");
				} else if (!/^\d{4}\.bak$/.test(record.backup ?? "") || !validPosixMode(record.beforeMode)) {
					throw new Error("rollback transaction has invalid backup metadata");
				} else if (seenBackups.has(record.backup)) {
					throw new Error("rollback transaction reuses a backup file");
				} else {
					seenBackups.add(record.backup);
				}
				if (record.afterSha256 === null ? record.afterMode !== null : !MODES.has(record.afterMode)) {
					throw new Error("rollback transaction has invalid installed mode metadata");
				}
				if ((bytes === null ? null : sha256(bytes)) !== record.afterSha256) throw new Error(`refusing rollback because resource drifted: ${record.target}`);
				if (currentMode !== record.afterMode) throw new Error(`refusing rollback because resource mode drifted: ${record.target}`);
				if (record.backup) {
					const backupPath = path.join(transactionDir, record.backup);
					if (path.dirname(backupPath) !== transactionDir) throw new Error("rollback backup path escapes its transaction");
					await assertNoSymlinkComponents(backupPath, "rollback backup", { allowMissing: false });
					restored = await fs.readFile(backupPath);
					if (sha256(restored) !== record.beforeSha256) throw new Error(`rollback backup checksum mismatch: ${record.target}`);
				}
			} else {
				if (Object.hasOwn(record, "backup") || Object.hasOwn(record, "beforeSha256") || Object.hasOwn(record, "afterSha256")) {
					throw new Error("rollback merge-resource record contains forbidden byte-backup metadata");
				}
				if (typeof record.beforePresent !== "boolean" || typeof record.afterPresent !== "boolean" || typeof record.created !== "boolean") {
					throw new Error("rollback transaction has invalid merge-resource presence metadata");
				}
				if (record.beforePresent !== (record.beforeMode !== null) || (record.beforePresent && !validPosixMode(record.beforeMode))) {
					throw new Error("rollback transaction has invalid merge-resource previous mode metadata");
				}
				if (record.afterPresent !== (record.afterMode !== null) || (record.afterPresent && !MODES.has(record.afterMode))) {
					throw new Error("rollback transaction has invalid merge-resource installed mode metadata");
				}
				validateManagedRollbackDelta(record.managedDelta);
				if ((bytes !== null) !== record.afterPresent) throw new Error(`refusing rollback because resource presence drifted: ${record.target}`);
				if (currentMode !== record.afterMode) throw new Error(`refusing rollback because resource mode drifted: ${record.target}`);
				const currentValue = bytes ? parseConfig(record.kind, bytes.toString("utf8"), `current rollback config ${record.target}`) : {};
				const restoredValue = restoreManagedRollbackDelta(currentValue, record.managedDelta);
				if (record.beforePresent || !emptyObject(restoredValue)) {
					restored = Buffer.from(serializeConfig(record.kind, restoredValue));
					restoredMode = record.beforeMode ?? currentMode ?? record.afterMode;
				}
			}
			snapshots.push({ record, destination, bytes, currentMode, restored, restoredMode });
		}
		if (this.dryRun) { this.output.log(`[dry-run] rollback transaction ${id}`); return; }

		if (current) await atomicWrite(path.join(this.stateDir, `state.rolled-back-${id}.json`), stableJson(current), 0o600);
		let pointerSwitched = false;
		const changed = [];
		try {
			await this.toolchain.switchToIdentity(transaction.fromToolchain);
			pointerSwitched = true;
			for (const item of snapshots) {
				await assertNoSymlinkComponents(item.destination, `rollback target ${item.record.target}`);
				if (item.restored === null) await fs.unlink(item.destination);
				else await atomicWrite(item.destination, item.restored, item.restoredMode);
				changed.push(item);
			}
			if (transaction.previousState) await atomicWrite(this.statePath, stableJson(transaction.previousState), 0o600);
			else await fs.rm(this.statePath, { force: true });
		} catch (error) {
			let restorationFailed = false;
			for (const item of [...changed].reverse()) {
				try {
					await assertNoSymlinkComponents(item.destination, `rollback restoration target ${item.record.target}`);
					if (item.bytes === null) await fs.rm(item.destination, { force: true });
					else await atomicWrite(item.destination, item.bytes, item.currentMode);
				} catch {
					restorationFailed = true;
				}
			}
			if (current) await atomicWrite(this.statePath, stableJson(current), 0o600).catch(() => { restorationFailed = true; });
			if (pointerSwitched) {
				await this.toolchain.switchToIdentity(transaction.toToolchain).catch(() => { restorationFailed = true; });
			}
			throw new Error(`rollback failed${restorationFailed ? " and restoration was incomplete" : " and was restored"}: ${error.message}`);
		}
		this.output.log(`rollback complete: ${id}`);
	}

	async uninstall() {
		await this.preflightRoots({ write: true });
		const current = await this.state();
		const toolchains = await this.coupledToolchains(current);
		const prepared = [];
		for (const resource of current.resources) {
			const destination = this.resourcePath(resource);
			await assertNoSymlinkComponents(destination, `managed target ${resource.target}`, { allowMissing: false });
			const before = await fs.readFile(destination);
			const beforeMode = (await fs.lstat(destination)).mode & 0o777;
			if (beforeMode !== resource.mode) throw new Error(`managed resource mode drifted: ${resource.target}`);
			let after = null;
			let managedDelta;
			if (resource.kind === "file") {
				if (sha256(before) !== resource.installedSha256) throw new Error(`managed resource drifted: ${resource.target}`);
			} else {
				const value = parseConfig(resource.kind, before.toString("utf8"), `existing config ${resource.target}`);
				const stripped = removeManaged(value, resource.managedPaths ?? []);
				if (!(resource.created && emptyObject(stripped))) after = Buffer.from(serializeConfig(resource.kind, stripped));
				managedDelta = createManagedRollbackDelta(value, stripped, resource.managedPaths ?? [], []);
			}
			prepared.push({
				artifact: { targetRoot: resource.targetRoot, target: resource.target, kind: resource.kind, mode: resource.mode },
				destination, before, beforeMode, after, removed: true, created: resource.created, managedDelta,
			});
		}
		await this.commitTransaction("uninstall", {
			version: current.version, platform: current.platform,
			manifestSha256: current.releaseManifestSha256,
		}, prepared, current, { ...toolchains, deactivate: true });
		this.output.log(`uninstalled managed release ${current.version}; backups retained in ${this.backupsDir}`);
	}
}
