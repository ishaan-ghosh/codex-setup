import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicSymlink, atomicWrite, sha256, stableJson } from "./atomic.mjs";
import {
	createManagedRollbackDelta,
	mergeManaged,
	parseConfig,
	removeManaged,
	restoreDisplacedValues,
	restoreManagedRollbackDelta,
	serializeConfig,
	validateDisplacedValues,
	validateManagedContainers,
	validateManagedPaths,
	validateManagedRollbackDelta,
} from "./config.mjs";
import { loadRelease, TARGET_ROOTS } from "./release.mjs";
import { ToolchainInstaller, validateToolchainIdentity } from "./toolchain-installer.mjs";
import { assertManagedTarget, assertNoSymlinkAncestors, assertNoSymlinkComponents, assertSafeRoot, inside } from "./safety.mjs";

const STATE_SCHEMA = 6;
const TRANSACTION_SCHEMA = 6;
const LEGACY_SCHEMA = 3;
const SNAPSHOT_SCHEMA = 4;
const CONFIG_MIGRATION_SCHEMA = 5;
const SUPPORTED_SCHEMAS = new Set([LEGACY_SCHEMA, SNAPSHOT_SCHEMA, CONFIG_MIGRATION_SCHEMA, STATE_SCHEMA]);
const MODES = new Set([0o600, 0o644, 0o755]);
const validPosixMode = (value) => Number.isInteger(value) && value >= 0 && value <= 0o777;
const RESOURCE_KINDS = new Set(["file", "json-merge", "toml-merge"]);
const MIGRATABLE_LAUNCHER_KEY = "local_bin:codex";
const MAX_LINK_BYTES = 4096;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const LOCK_SCHEMA = 1;
const LOCK_TOKEN = /^[0-9a-f]{32}$/;

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
	} catch {
		throw new Error(`${label} is invalid JSON`);
	}
}

function resourceKey(value) {
	return `${value.targetRoot ?? "codex_home"}:${value.target}`;
}

function emptyObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function sameIdentity(actual, expected) {
	return !expected || (actual?.dev === expected.dev && actual?.ino === expected.ino);
}

function sameSnapshot(actual, expected) {
	return stableJson(actual) === stableJson(expected);
}

function validateLockOwner(owner) {
	if (!owner || typeof owner !== "object" || Array.isArray(owner)
		|| stableJson(Object.keys(owner).sort()) !== stableJson(["createdAt", "pid", "schema", "token"])) {
		throw new Error("lifecycle lock owner metadata is invalid");
	}
	if (owner.schema !== LOCK_SCHEMA || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
		|| !LOCK_TOKEN.test(owner.token ?? "") || typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))) {
		throw new Error("lifecycle lock owner metadata is invalid");
	}
	return owner;
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		if (error.code === "EPERM") return true;
		throw error;
	}
}

function validateSymlinkSnapshot(snapshot, label) {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || snapshot.type !== "symlink") {
		throw new Error(`${label} is not a symlink snapshot`);
	}
	if (typeof snapshot.linkBase64 !== "string" || snapshot.linkBase64.length === 0) throw new Error(`${label} contains invalid link bytes`);
	const bytes = Buffer.from(snapshot.linkBase64, "base64");
	if (bytes.length === 0 || bytes.length > MAX_LINK_BYTES || bytes.toString("base64") !== snapshot.linkBase64
		|| snapshot.byteLength !== bytes.length || !HEX_SHA256.test(snapshot.sha256 ?? "") || sha256(bytes) !== snapshot.sha256) {
		throw new Error(`${label} contains invalid integrity metadata`);
	}
	const keys = Object.keys(snapshot).sort();
	if (stableJson(keys) !== stableJson(["byteLength", "linkBase64", "sha256", "type"])) throw new Error(`${label} contains unsupported fields`);
	return snapshot;
}

function validateFileSnapshot(snapshot, label) {
	if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !new Set(["missing", "file", "symlink"]).has(snapshot.type)) {
		throw new Error(`${label} has an unsupported snapshot type`);
	}
	if (snapshot.type === "missing") {
		if (Object.keys(snapshot).length !== 1) throw new Error(`${label} has inconsistent missing-resource metadata`);
	} else if (snapshot.type === "file") {
		if (!HEX_SHA256.test(snapshot.sha256 ?? "") || !validPosixMode(snapshot.mode)) throw new Error(`${label} has invalid file metadata`);
		if (stableJson(Object.keys(snapshot).sort()) !== stableJson(["mode", "sha256", "type"])) throw new Error(`${label} contains unsupported fields`);
	} else {
		validateSymlinkSnapshot(snapshot, label);
	}
	return snapshot;
}

function symlinkSnapshot(linkBytes) {
	if (!Buffer.isBuffer(linkBytes) || linkBytes.length === 0 || linkBytes.length > MAX_LINK_BYTES || linkBytes.includes(0)) {
		throw new Error("launcher symlink target bytes are invalid or exceed the supported size");
	}
	return { type: "symlink", linkBase64: linkBytes.toString("base64"), byteLength: linkBytes.length, sha256: sha256(linkBytes) };
}

function symlinkBytes(snapshot) {
	validateSymlinkSnapshot(snapshot, "launcher symlink snapshot");
	return Buffer.from(snapshot.linkBase64, "base64");
}

function fileSnapshot(contents, mode) {
	return contents === null ? { type: "missing" } : { type: "file", sha256: sha256(contents), mode };
}

function profileFileToMergeTransition(artifact, previous) {
	return previous?.kind === "file"
		&& artifact.kind === "toml-merge"
		&& (artifact.targetRoot ?? "codex_home") === "codex_home"
		&& /^[A-Za-z0-9][A-Za-z0-9-]*\.config\.toml$/.test(artifact.target)
		&& artifact.source === `payload/profiles/${artifact.target}`
		&& previous.source === artifact.source;
}

function validateResource(resource, schema) {
	const targetRoot = resource.targetRoot ?? "codex_home";
	if (!TARGET_ROOTS.has(targetRoot)) throw new Error("managed state contains an unsupported target root");
	assertManagedTarget(resource.target);
	if (!RESOURCE_KINDS.has(resource.kind)) throw new Error("managed state contains an unsupported resource kind");
	if (!MODES.has(resource.mode)) throw new Error("managed state contains an unsupported resource mode");
	if (typeof resource.created !== "boolean") throw new Error("managed state contains invalid creation metadata");
	if (resource.kind === "file") {
		if (!HEX_SHA256.test(resource.installedSha256 ?? "")) throw new Error("managed state contains an invalid checksum");
		if (resource.managedPaths !== undefined) throw new Error("managed state contains paths for a non-merge resource");
		if (Object.hasOwn(resource, "managedContainers")) throw new Error("managed state contains containers for a non-merge resource");
		if (Object.hasOwn(resource, "displacedValues")) throw new Error("managed state contains displaced config values for a non-merge resource");
	} else {
		if (Object.hasOwn(resource, "installedSha256")) throw new Error("managed state contains a whole-file checksum for a merge resource");
		validateManagedPaths(resource.managedPaths, "managed state config paths");
		if (schema >= STATE_SCHEMA) {
			if (!Object.hasOwn(resource, "managedContainers")) throw new Error(`schema-${schema} managed state is missing config container metadata`);
			validateManagedContainers(resource.managedContainers, resource.managedPaths, "managed state config containers");
		} else if (Object.hasOwn(resource, "managedContainers")) {
			throw new Error(`schema-${schema} managed state contains schema-6 config container metadata`);
		}
		const hasDisplacedValues = Object.hasOwn(resource, "displacedValues");
		if (schema >= CONFIG_MIGRATION_SCHEMA) {
			if (!hasDisplacedValues || !Array.isArray(resource.displacedValues)) {
				throw new Error(`schema-${schema} managed state is missing displaced config metadata`);
			}
			if (resource.displacedValues.length) {
				if (resource.created) throw new Error("managed state contains displaced config values for a created resource");
				validateDisplacedValues(resource.displacedValues, resource.managedPaths, "managed state displaced config values");
			}
		} else if (hasDisplacedValues) {
			throw new Error(`schema-${schema} managed state contains schema-5 config migration metadata`);
		}
	}
	if (schema === LEGACY_SCHEMA) {
		if (Object.hasOwn(resource, "displacedSymlink")) throw new Error("schema-3 managed state contains schema-4 launcher metadata");
	} else if (Object.hasOwn(resource, "displacedSymlink")) {
		if (resourceKey(resource) !== MIGRATABLE_LAUNCHER_KEY || resource.kind !== "file" || resource.created !== false) {
			throw new Error("managed state contains misplaced launcher migration metadata");
		}
		validateSymlinkSnapshot(resource.displacedSymlink, "managed state launcher snapshot");
	}
}

function validateState(state) {
	if (!state || typeof state !== "object" || !SUPPORTED_SCHEMAS.has(state.schema) || typeof state.version !== "string" || !Array.isArray(state.resources)) {
		throw new Error("managed state is missing or has an unsupported schema");
	}
	validateToolchainIdentity(state.toolchain, "managed state toolchain identity");
	const keys = new Set();
	for (const resource of state.resources) {
		validateResource(resource, state.schema);
		const key = resourceKey(resource);
		if (keys.has(key)) throw new Error(`managed state contains duplicate resource: ${key}`);
		keys.add(key);
	}
	return state;
}

function validateTransactionEnvelope(transaction, current) {
	if (!new Set(["install", "adopt", "update", "uninstall"]).has(transaction.action)) throw new Error("rollback transaction has an invalid action");
	const previous = transaction.previousState;
	if (previous !== null) validateState(previous);
	if (transaction.action === "install" || transaction.action === "adopt") {
		if (previous !== null || transaction.fromVersion !== null || typeof transaction.toVersion !== "string") {
			throw new Error("rollback transaction has inconsistent initial-install version metadata");
		}
	} else {
		if (!previous || transaction.fromVersion !== previous.version) throw new Error("rollback transaction previous state and version disagree");
		if (transaction.action === "uninstall") {
			if (transaction.toVersion !== null) throw new Error("rollback uninstall transaction has an invalid target version");
		} else if (typeof transaction.toVersion !== "string") {
			throw new Error("rollback update transaction has an invalid target version");
		}
	}
	if (current) {
		if (transaction.action === "uninstall" || current.version !== transaction.toVersion) {
			throw new Error("active state and rollback transaction version disagree");
		}
	} else if (transaction.action !== "uninstall" || !previous) {
		throw new Error("no active managed state matches this rollback");
	}
	if (transaction.action === "uninstall") {
		if (transaction.schema < previous.schema) throw new Error("rollback transaction schema is older than its previous state");
	} else if (transaction.schema !== current.schema) {
		throw new Error("rollback transaction schema does not match its active state");
	}
}

function validateTransactionResourceSet(transaction, current) {
	const currentByKey = new Map((current?.resources ?? []).map((resource) => [resourceKey(resource), resource]));
	const previousByKey = new Map((transaction.previousState?.resources ?? []).map((resource) => [resourceKey(resource), resource]));
	const expected = new Set();
	if (transaction.action === "install" || transaction.action === "adopt") {
		for (const key of currentByKey.keys()) expected.add(key);
	} else if (transaction.action === "uninstall") {
		for (const key of previousByKey.keys()) expected.add(key);
	} else {
		for (const key of currentByKey.keys()) expected.add(key);
		for (const key of previousByKey.keys()) expected.add(key);
	}

	const actual = new Set();
	for (const record of transaction.resources) {
		const targetRoot = record?.targetRoot ?? "codex_home";
		if (!TARGET_ROOTS.has(targetRoot)) throw new Error("rollback transaction contains an unsupported target root");
		assertManagedTarget(record?.target);
		const key = resourceKey(record);
		if (actual.has(key)) throw new Error("rollback transaction contains a duplicate resource");
		actual.add(key);
		const currentKind = currentByKey.get(key)?.kind;
		const previousKind = previousByKey.get(key)?.kind;
		const recordKind = currentKind ?? previousKind;
		if (record.kind !== recordKind) throw new Error("rollback transaction resource kind does not match its action state");
		if (currentKind && previousKind && currentKind !== previousKind) {
			if (transaction.schema < STATE_SCHEMA || transaction.action !== "update"
				|| previousKind !== "file" || currentKind !== "toml-merge"
				|| record.previousKind !== previousKind
				|| !profileFileToMergeTransition(currentByKey.get(key), previousByKey.get(key))) {
				throw new Error("rollback transaction contains an unsupported resource kind transition");
			}
		} else if (Object.hasOwn(record, "previousKind")) {
			throw new Error("rollback transaction contains misplaced resource kind transition metadata");
		}
	}
	if (actual.size !== expected.size || [...actual].some((key) => !expected.has(key))) {
		throw new Error("rollback transaction resource set does not match its states");
	}
}

function validateMergeRollbackMetadata(transaction, current, record, key) {
	validateManagedRollbackDelta(record.managedDelta);
	const currentResource = current?.resources.find((resource) => resourceKey(resource) === key);
	const previousResource = transaction.previousState?.resources.find((resource) => resourceKey(resource) === key);
	const currentPaths = new Set((currentResource?.managedPaths ?? []).map((entry) => stableJson(entry.path)));
	const previousPaths = new Set((previousResource?.managedPaths ?? []).map((entry) => stableJson(entry.path)));
	const requiredDisplacedTransitions = record.managedDelta.flatMap((entry) => {
		if (!entry.before.present || !entry.after.present || stableJson(entry.before.value) === stableJson(entry.after.value)) return [];
		if (transaction.action === "install" || transaction.action === "adopt") {
			return [{ path: entry.path, value: entry.before.value }];
		}
		if (transaction.action === "uninstall") return [{ path: entry.path, value: entry.after.value }];
		const pathKey = stableJson(entry.path);
		return previousPaths.has(pathKey) && !currentPaths.has(pathKey)
			? [{ path: entry.path, value: entry.after.value }]
			: [];
	});
	if (transaction.schema < CONFIG_MIGRATION_SCHEMA) {
		if (Object.hasOwn(record, "displacedValues")) {
			throw new Error(`schema-${transaction.schema} transaction contains schema-5 config migration metadata`);
		}
		if (requiredDisplacedTransitions.length) {
			throw new Error("legacy rollback transaction contains displacement-shaped config delta");
		}
	}
	if (transaction.schema >= CONFIG_MIGRATION_SCHEMA) {
		if (!Object.hasOwn(record, "displacedValues") || !Array.isArray(record.displacedValues)) {
			throw new Error(`schema-${transaction.schema} rollback transaction is missing displaced config metadata`);
		}
		const expectedResource = transaction.action === "install" || transaction.action === "adopt" ? currentResource : previousResource;
		const expectedDisplacedValues = expectedResource?.displacedValues ?? [];
		if (stableJson(record.displacedValues) !== stableJson(expectedDisplacedValues)) {
			throw new Error("rollback displaced managed config metadata does not match its action state");
		}
		const hasDisplacedValue = (values, candidate) => values.some((entry) =>
			stableJson(entry.path) === stableJson(candidate.path)
			&& stableJson(entry.value) === stableJson(candidate.value));
		if (requiredDisplacedTransitions.some((entry) => !hasDisplacedValue(record.displacedValues, entry))) {
			throw new Error("rollback transaction omits required displaced config metadata");
		}
		if (transaction.action === "update") {
			if ((currentResource?.displacedValues ?? []).some((entry) => !hasDisplacedValue(record.displacedValues, entry))) {
				throw new Error("rollback transaction omits carried displaced config metadata");
			}
			if (record.displacedValues.some((entry) => currentPaths.has(stableJson(entry.path))
				&& !hasDisplacedValue(currentResource?.displacedValues ?? [], entry))) {
				throw new Error("rollback active state omits carried displaced config metadata");
			}
		}
	}
	if (record.displacedValues?.length) {
		const primaryManagedPaths = [];
		const secondaryManagedPaths = [];
		const secondaryDisplacedValues = [];
		const managedStateValue = (resource, displaced) => resource?.managedPaths?.find(
			(entry) => stableJson(entry.path) === stableJson(displaced.path),
		)?.value;
		for (const displaced of record.displacedValues) {
			const delta = record.managedDelta.find((entry) => stableJson(entry.path) === stableJson(displaced.path));
			const beforeMatches = delta?.before.present && stableJson(delta.before.value) === stableJson(displaced.value);
			const afterMatches = delta?.after.present && stableJson(delta.after.value) === stableJson(displaced.value);
			const carried = currentResource?.displacedValues?.some((entry) => stableJson(entry.path) === stableJson(displaced.path)
				&& stableJson(entry.value) === stableJson(displaced.value));
			let primaryManaged;
			let secondaryManaged;
			if (transaction.action === "install" || transaction.action === "adopt") {
				if (!beforeMatches || !delta.after.present
					|| stableJson(managedStateValue(currentResource, displaced)) !== stableJson(delta.after.value)) {
					throw new Error("rollback displaced managed config metadata is inconsistent with its action states");
				}
				primaryManaged = delta.after.value;
			} else if (transaction.action === "uninstall") {
				if (!afterMatches || !delta.before.present
					|| stableJson(managedStateValue(previousResource, displaced)) !== stableJson(delta.before.value)) {
					throw new Error("rollback displaced managed config metadata is inconsistent with its action states");
				}
				primaryManaged = delta.before.value;
			} else if (carried) {
				if (!delta.before.present || !delta.after.present
					|| stableJson(managedStateValue(previousResource, displaced)) !== stableJson(delta.before.value)
					|| stableJson(managedStateValue(currentResource, displaced)) !== stableJson(delta.after.value)) {
					throw new Error("rollback displaced managed config metadata is inconsistent with its action states");
				}
				primaryManaged = delta.before.value;
				secondaryManaged = delta.after.value;
			} else {
				if (!afterMatches || !delta.before.present
					|| stableJson(managedStateValue(previousResource, displaced)) !== stableJson(delta.before.value)) {
					throw new Error("rollback displaced managed config metadata is inconsistent with its action states");
				}
				primaryManaged = delta.before.value;
			}
			primaryManagedPaths.push({ path: displaced.path, value: primaryManaged });
			if (secondaryManaged !== undefined) {
				secondaryManagedPaths.push({ path: displaced.path, value: secondaryManaged });
				secondaryDisplacedValues.push(displaced);
			}
		}
		validateDisplacedValues(record.displacedValues, primaryManagedPaths, "rollback displaced managed config values");
		if (secondaryDisplacedValues.length) {
			validateDisplacedValues(secondaryDisplacedValues, secondaryManagedPaths, "rollback next managed config values");
		}
	}
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
		this.lockDir = path.join(this.stateDir, "lifecycle.lock");
		this.lockOwnerPath = path.join(this.lockDir, "owner.json");
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

	async preflightRoots() {
		await assertSafeRoot(this.codexHome, "CODEX_HOME");
		await assertSafeRoot(this.userHome, "user home");
		await assertSafeRoot(this.localBin, "local bin");
		await assertSafeRoot(this.dataHome, "codex-setup data directory");
		await assertNoSymlinkComponents(this.stateDir, "lifecycle state path");
	}

	async acquireLifecycleLock() {
		await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
		await assertNoSymlinkComponents(this.stateDir, "lifecycle state path", { allowMissing: false });
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const token = crypto.randomBytes(16).toString("hex");
			const owner = { schema: LOCK_SCHEMA, pid: process.pid, token, createdAt: new Date().toISOString() };
			const pendingDir = path.join(this.stateDir, `.lifecycle-lock-pending-${token}`);
			const pendingOwner = path.join(pendingDir, "owner.json");
			await fs.mkdir(pendingDir, { mode: 0o700 });
			try {
				await atomicWrite(pendingOwner, stableJson(owner), 0o600);
				await fs.rename(pendingDir, this.lockDir);
				const info = await fs.lstat(this.lockDir);
				return { token, identity: { dev: info.dev, ino: info.ino } };
			} catch (error) {
				await fs.unlink(pendingOwner).catch(() => {});
				await fs.rmdir(pendingDir).catch(() => {});
				if (!new Set(["EEXIST", "ENOTEMPTY"]).has(error.code)) throw error;
			}

			await assertNoSymlinkComponents(this.lockOwnerPath, "lifecycle lock", { allowMissing: false });
			const ownerInfo = await fs.lstat(this.lockOwnerPath);
			if (!ownerInfo.isFile() || (ownerInfo.mode & 0o777) !== 0o600) throw new Error("lifecycle lock owner metadata is invalid");
			const existingOwner = validateLockOwner(await readJson(this.lockOwnerPath, "lifecycle lock owner"));
			if (processIsAlive(existingOwner.pid)) throw new Error("another lifecycle operation is already in progress");
			throw new Error("stale lifecycle lock requires manual inspection and cleanup");
		}
		throw new Error("could not acquire lifecycle lock");
	}

	async releaseLifecycleLock(lock) {
		await assertNoSymlinkComponents(this.lockOwnerPath, "lifecycle lock", { allowMissing: false });
		const lockInfo = await fs.lstat(this.lockDir);
		if (lockInfo.dev !== lock.identity.dev || lockInfo.ino !== lock.identity.ino) throw new Error("lifecycle lock identity changed");
		const owner = validateLockOwner(await readJson(this.lockOwnerPath, "lifecycle lock owner"));
		if (owner.token !== lock.token || owner.pid !== process.pid) throw new Error("lifecycle lock ownership changed");
		await fs.unlink(this.lockOwnerPath);
		await fs.rmdir(this.lockDir);
	}

	async withLifecycleLock(callback) {
		const lock = await this.acquireLifecycleLock();
		let result;
		let failure;
		try {
			result = await callback();
		} catch (error) {
			failure = error;
		}
		let releaseFailure;
		try {
			await this.releaseLifecycleLock(lock);
		} catch (error) {
			releaseFailure = error;
		}
		if (failure) {
			if (releaseFailure) throw new Error(`${failure.message}; lifecycle lock release failed: ${releaseFailure.message}`);
			throw failure;
		}
		if (releaseFailure) throw releaseFailure;
		return result;
	}

	async captureExpectedState(expectedState) {
		const live = await this.inspectFileLeaf(this.statePath, "managed state");
		if (expectedState === null) {
			if (live.snapshot.type !== "missing") throw new Error("managed state changed before transaction start");
			return live;
		}
		if (live.snapshot.type !== "file") throw new Error("managed state changed before transaction start");
		let parsed;
		try {
			parsed = JSON.parse(live.bytes);
		} catch {
			throw new Error("managed state is invalid JSON");
		}
		validateState(parsed);
		if (stableJson(parsed) !== stableJson(expectedState)) throw new Error("managed state changed before transaction start");
		return live;
	}

	async restoreStateAfterFailure(stateBefore, intendedSnapshot, intendedIdentity = null) {
		const live = await this.inspectFileLeaf(this.statePath, "managed state restoration");
		if (sameSnapshot(live.snapshot, stateBefore.snapshot) && sameIdentity(live.identity, stateBefore.identity)) return;
		if (!sameSnapshot(live.snapshot, intendedSnapshot) || !sameIdentity(live.identity, intendedIdentity)) {
			throw new Error("managed state changed during failure recovery");
		}
		await this.writeFileOutcome(this.statePath, stateBefore.snapshot, stateBefore.bytes, stateBefore.snapshot.mode);
	}

	async inspectFileLeaf(destination, label) {
		await assertNoSymlinkAncestors(destination, label);
		let info;
		try {
			info = await fs.lstat(destination);
		} catch (error) {
			if (error.code === "ENOENT") return { snapshot: { type: "missing" }, bytes: null, identity: null };
			throw error;
		}
		if (info.isSymbolicLink()) {
			const linkBytes = await fs.readlink(destination, { encoding: "buffer" });
			return { snapshot: symlinkSnapshot(linkBytes), bytes: null, identity: { dev: info.dev, ino: info.ino } };
		}
		if (!info.isFile()) return { snapshot: { type: info.isDirectory() ? "directory" : "special" }, bytes: null, identity: { dev: info.dev, ino: info.ino } };
		let handle;
		try {
			handle = await fs.open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
			const opened = await handle.stat();
			if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error(`${label} changed while being inspected`);
			const bytes = await handle.readFile();
			return { snapshot: fileSnapshot(bytes, opened.mode & 0o777), bytes, identity: { dev: opened.dev, ino: opened.ino } };
		} finally {
			if (handle) await handle.close().catch(() => {});
		}
	}

	async assertPreparedLeaf(item, label) {
		const current = await this.inspectFileLeaf(item.destination, label);
		if (stableJson(current.snapshot) !== stableJson(item.beforeSnapshot)) throw new Error(`${label} changed after preparation`);
		if (item.beforeIdentity && (current.identity?.dev !== item.beforeIdentity.dev || current.identity?.ino !== item.beforeIdentity.ino)) {
			throw new Error(`${label} identity changed after preparation`);
		}
	}

	async writeFileOutcome(destination, snapshot, bytes, mode) {
		if (snapshot.type === "missing") await fs.unlink(destination);
		else if (snapshot.type === "symlink") await atomicSymlink(destination, symlinkBytes(snapshot));
		else await atomicWrite(destination, bytes, mode ?? snapshot.mode);
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

	async prepareResource(artifact, previous, { adopt = false, migrateCodexLauncher = false, migrateManagedConfig = false } = {}) {
		const destination = this.resourcePath(artifact);
		const inspected = await this.inspectFileLeaf(destination, `managed target ${artifact.target}`);
		const eligibleLauncher = resourceKey(artifact) === MIGRATABLE_LAUNCHER_KEY && artifact.kind === "file";
		const transitioningProfile = profileFileToMergeTransition(artifact, previous);
		if (inspected.snapshot.type === "symlink") {
			if (previous) throw new Error(`managed resource drifted: ${artifact.target}`);
			if (!eligibleLauncher) throw new Error(`managed target ${resourceKey(artifact)} is a symbolic link; only local_bin:codex supports explicit migration`);
			if (!migrateCodexLauncher) throw new Error(`managed target ${resourceKey(artifact)} is a symbolic link; rerun install with --migrate-codex-launcher to preserve and replace it`);
		}
		if (!new Set(["missing", "file", "symlink"]).has(inspected.snapshot.type)) throw new Error(`managed target must be absent or a regular file: ${artifact.target}`);
		const before = inspected.bytes;
		const beforeMode = inspected.snapshot.type === "file" ? inspected.snapshot.mode : null;
		if (previous) {
			if (inspected.snapshot.type !== "file") throw new Error(`managed resource is missing: ${artifact.target}`);
			if (beforeMode !== previous.mode) throw new Error(`managed resource mode drifted: ${artifact.target}`);
			if (previous.kind === "file" && sha256(before) !== previous.installedSha256) {
				throw new Error(`managed resource drifted: ${artifact.target}`);
			}
			if (artifact.kind !== previous.kind && !transitioningProfile) throw new Error(`resource kind changed across releases: ${artifact.target}`);
		} else if (before && artifact.kind === "file" && !adopt) {
			throw new Error(`unmanaged file blocks install: ${artifact.target}; use adopt only if it exactly matches the release`);
		}

		if (artifact.kind === "file") {
			if (adopt && before && sha256(before) !== artifact.sha256) throw new Error(`cannot adopt non-matching file: ${artifact.target}`);
			const displacedSymlink = previous?.displacedSymlink ?? (inspected.snapshot.type === "symlink" ? inspected.snapshot : undefined);
			return {
				artifact, destination, before, beforeMode, beforeSnapshot: inspected.snapshot, beforeIdentity: inspected.identity,
				after: artifact.contents, afterSnapshot: fileSnapshot(artifact.contents, artifact.mode),
				managedPaths: undefined, created: previous?.created ?? inspected.snapshot.type === "missing", displacedSymlink,
			};
		}

		if (inspected.snapshot.type === "symlink") throw new Error(`managed configuration target cannot be a symbolic link: ${artifact.target}`);
		const fragment = parseConfig(artifact.kind, artifact.contents.toString("utf8"), `config fragment ${artifact.source}`);
		const current = before ? parseConfig(artifact.kind, before.toString("utf8"), `existing config ${artifact.target}`) : {};
		const previousOwnership = transitioningProfile
			? mergeManaged({}, current)
			: { paths: previous?.managedPaths ?? [], managedContainers: previous?.managedContainers ?? [] };
		const previousManagedPaths = previousOwnership.paths;
		let base = previous ? removeManaged(current, previousManagedPaths, previousOwnership.managedContainers) : current;
		let merged;
		let displacedValues = [];
		let rollbackDisplacedValues = [];
		if (previous) {
			const nextPaths = mergeManaged({}, fragment).paths;
			const nextKeys = new Set(nextPaths.map((entry) => stableJson(entry.path)));
			const previousDisplaced = previous.displacedValues ?? [];
			const removedDisplaced = previousDisplaced.filter((entry) => !nextKeys.has(stableJson(entry.path)));
			displacedValues = previousDisplaced.filter((entry) => nextKeys.has(stableJson(entry.path)));
			base = restoreDisplacedValues(base, removedDisplaced, previousManagedPaths);
			merged = mergeManaged(base, fragment, { allowEqual: true });
			rollbackDisplacedValues = previousDisplaced;
		} else {
			merged = mergeManaged(base, fragment, { allowEqual: true, migrateConflicts: migrateManagedConfig });
			displacedValues = merged.displacedValues;
			rollbackDisplacedValues = displacedValues;
		}
		const after = Buffer.from(serializeConfig(artifact.kind, merged.value));
		return {
			artifact, destination, before, beforeMode, beforeSnapshot: inspected.snapshot, beforeIdentity: inspected.identity,
			after, afterSnapshot: fileSnapshot(after, artifact.mode),
			managedPaths: merged.paths,
			managedContainers: merged.managedContainers,
			managedDelta: createManagedRollbackDelta(current, merged.value, previousManagedPaths, merged.paths, { displacedValues: rollbackDisplacedValues }),
			displacedValues,
			transactionDisplacedValues: rollbackDisplacedValues,
			migratedConfigPaths: previous ? [] : displacedValues.map((entry) => entry.path),
			created: transitioningProfile ? true : previous?.created ?? before === null,
			...(transitioningProfile ? { transitionFromKind: previous.kind } : {}),
		};
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
			const inspected = await this.inspectFileLeaf(destination, `managed target ${old.target}`);
			if (inspected.snapshot.type !== "file") throw new Error(`managed resource is missing or invalid: ${old.target}`);
			const before = inspected.bytes;
			const beforeMode = inspected.snapshot.mode;
			if (beforeMode !== old.mode) throw new Error(`managed resource mode drifted: ${old.target}`);
			let after = null;
			let afterSnapshot = { type: "missing" };
			let managedDelta;
			if (old.kind === "file") {
				if (sha256(before) !== old.installedSha256) throw new Error(`managed resource drifted: ${old.target}`);
				if (old.displacedSymlink) afterSnapshot = old.displacedSymlink;
			} else {
				const current = parseConfig(old.kind, before.toString("utf8"), `existing config ${old.target}`);
				let stripped = removeManaged(current, old.managedPaths ?? [], old.managedContainers ?? []);
				stripped = restoreDisplacedValues(stripped, old.displacedValues ?? [], old.managedPaths ?? []);
				if (!(old.created && emptyObject(stripped))) {
					after = Buffer.from(serializeConfig(old.kind, stripped));
					afterSnapshot = fileSnapshot(after, old.mode);
				}
				managedDelta = createManagedRollbackDelta(current, stripped, old.managedPaths ?? [], [], { displacedValues: old.displacedValues ?? [] });
			}
			resources.push({
				artifact: { targetRoot: old.targetRoot, target: old.target, kind: old.kind, mode: old.mode },
				destination, before, beforeMode, beforeSnapshot: inspected.snapshot, beforeIdentity: inspected.identity,
				after, afterSnapshot, removed: true, created: old.created, managedDelta, displacedSymlink: old.displacedSymlink,
				transactionDisplacedValues: old.displacedValues ?? [],
			});
		}
		return resources;
	}

	async commitTransaction(action, release, prepared, previousState, options = {}) {
		if (this.dryRun) return this.commitTransactionLocked(action, release, prepared, previousState, options);
		return this.withLifecycleLock(async () => {
			const stateBefore = await this.captureExpectedState(previousState);
			return this.commitTransactionLocked(action, release, prepared, previousState, { ...options, stateBefore });
		});
	}

	async commitTransactionLocked(action, release, prepared, previousState, {
		deactivate = false, currentToolchain, previousToolchain, stateBefore = null,
	} = {}) {
		validateToolchainIdentity(currentToolchain, "transaction current toolchain");
		validateToolchainIdentity(previousToolchain, "transaction previous toolchain");
		await this.toolchain.validateReleaseIdentity(previousToolchain);
		const id = `${timestamp()}-${crypto.randomBytes(5).toString("hex")}`;
		const backupDir = path.join(this.backupsDir, id);
		const backupRecords = [];
		const written = [];
		let intendedStateSnapshot = null;
		let intendedStateIdentity = null;
		if (this.dryRun) {
			for (const item of prepared) {
				if (item.beforeSnapshot.type === "symlink") this.output.log(`[dry-run] migrate existing launcher symlink ${resourceKey(item.artifact)}`);
				else this.output.log(`[dry-run] ${item.removed ? "remove" : item.beforeSnapshot.type !== "missing" ? "replace" : "create"} ${resourceKey(item.artifact)}`);
				for (const migratedPath of item.migratedConfigPaths ?? []) {
					this.output.log(`[dry-run] migrate managed config path ${resourceKey(item.artifact)}:${migratedPath.join(".")}`);
				}
			}
			this.output.log(`[dry-run] ${action} release ${release.version}`);
			return null;
		}
		const activeToolchain = await this.toolchain.currentIdentity({ matchCheckout: false });
		if (stableJson(activeToolchain) !== stableJson(currentToolchain)) {
			throw new Error("active toolchain pointer changed after transaction preparation");
		}
		await assertNoSymlinkComponents(backupDir, "transaction backup path");
		await fs.mkdir(this.backupsDir, { recursive: true, mode: 0o700 });
		await assertNoSymlinkComponents(this.backupsDir, "transaction backups path", { allowMissing: false });
		await fs.mkdir(backupDir, { recursive: false, mode: 0o700 });
		try {
			for (const [index, item] of prepared.entries()) {
				if (item.transitionFromKind) {
					const backup = `${String(index).padStart(4, "0")}.bak`;
					await atomicWrite(path.join(backupDir, backup), item.before, 0o600);
					backupRecords.push({
						targetRoot: item.artifact.targetRoot ?? "codex_home",
						target: item.artifact.target,
						kind: item.artifact.kind,
						previousKind: item.transitionFromKind,
						beforeSnapshot: item.beforeSnapshot,
						afterPresent: item.after !== null,
						afterMode: item.after === null ? null : item.artifact.mode,
						created: item.created,
						backup,
						displacedValues: item.transactionDisplacedValues ?? [],
						managedDelta: item.managedDelta,
					});
					continue;
				}
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
						displacedValues: item.transactionDisplacedValues ?? [],
						managedDelta: item.managedDelta,
					});
					continue;
				}
				let backup = null;
				if (item.beforeSnapshot.type === "file") {
					backup = `${String(index).padStart(4, "0")}.bak`;
					await atomicWrite(path.join(backupDir, backup), item.before, 0o600);
				}
				backupRecords.push({
					targetRoot: item.artifact.targetRoot ?? "codex_home",
					target: item.artifact.target,
					kind: "file",
					beforeSnapshot: item.beforeSnapshot,
					afterSnapshot: item.afterSnapshot,
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
				await this.assertPreparedLeaf(item, `managed target ${item.artifact.target}`);
				try {
					await this.writeFileOutcome(item.destination, item.afterSnapshot, item.after, item.artifact.mode);
				} catch (writeError) {
					try {
						const live = await this.inspectFileLeaf(item.destination, `managed target ${item.artifact.target}`);
						const unchanged = stableJson(live.snapshot) === stableJson(item.beforeSnapshot)
							&& (!item.beforeIdentity || (live.identity?.dev === item.beforeIdentity.dev && live.identity?.ino === item.beforeIdentity.ino));
						if (!unchanged) {
							written.push(item);
							if (stableJson(live.snapshot) === stableJson(item.afterSnapshot)) item.appliedIdentity = live.identity;
							else item.appliedUncertain = true;
						}
					} catch {
						item.appliedUncertain = true;
						written.push(item);
					}
					throw writeError;
				}
				written.push(item);
				const applied = await this.inspectFileLeaf(item.destination, `managed target ${item.artifact.target}`);
				if (stableJson(applied.snapshot) !== stableJson(item.afterSnapshot)) {
					item.appliedUncertain = true;
					throw new Error(`managed target ${item.artifact.target} changed after replacement`);
				}
				item.appliedIdentity = applied.identity;
			}
			if (deactivate) {
				intendedStateSnapshot = { type: "missing" };
				await fs.rename(this.statePath, path.join(this.stateDir, `state.uninstalled-${id}.json`));
			} else {
				const active = prepared.filter((item) => !item.removed).map((item) => ({
					targetRoot: item.artifact.targetRoot ?? "codex_home",
					target: item.artifact.target,
					kind: item.artifact.kind,
					mode: item.artifact.mode,
					source: item.artifact.source,
					sourceSha256: item.artifact.sha256,
						...(item.artifact.kind === "file" ? { installedSha256: sha256(item.after) } : {
							managedPaths: item.managedPaths,
							managedContainers: item.managedContainers,
							displacedValues: item.displacedValues ?? [],
					}),
					created: item.created,
					...(item.displacedSymlink ? { displacedSymlink: item.displacedSymlink } : {}),
				}));
				const nextState = {
					schema: STATE_SCHEMA, version: release.version, platform: release.platform,
					toolchain: currentToolchain,
					releaseManifestSha256: release.manifestSha256,
					installedAt: new Date().toISOString(), lastTransaction: id, resources: active,
				};
				const nextStateBytes = Buffer.from(stableJson(nextState));
				intendedStateSnapshot = fileSnapshot(nextStateBytes, 0o600);
				await atomicWrite(this.statePath, nextStateBytes, 0o600);
				intendedStateIdentity = (await this.inspectFileLeaf(this.statePath, "managed state")).identity;
			}
		} catch (error) {
			let restorationFailed = false;
			for (const item of [...written].reverse()) {
				try {
					if (item.appliedUncertain) throw new Error("written outcome could not be authenticated");
					await this.assertPreparedLeaf({
						destination: item.destination,
						beforeSnapshot: item.afterSnapshot,
						beforeIdentity: item.appliedIdentity,
					}, `restoration target ${item.artifact.target}`);
					await this.writeFileOutcome(item.destination, item.beforeSnapshot, item.before, item.beforeMode);
				} catch {
					restorationFailed = true;
				}
			}
			try {
				if (!stateBefore) throw new Error("managed state was not authenticated before transaction start");
				await this.restoreStateAfterFailure(stateBefore, intendedStateSnapshot, intendedStateIdentity);
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
		if (options.adopt && options.migrateCodexLauncher) throw new Error("--migrate-codex-launcher is valid only with install, not adopt");
		await this.preflightRoots();
		if (options.adopt && options.migrateManagedConfig) throw new Error("--migrate-managed-config is valid only with install, not adopt");
		const current = await this.state({ optional: true });
		if (current) throw new Error(`codex-setup ${current.version} is already installed; use update`);
		const release = await this.release(options);
		const toolchains = await this.coupledToolchains();
		const prepared = await this.prepareRelease(release, null, options);
		await this.commitTransaction(options.adopt ? "adopt" : "install", release, prepared, null, toolchains);
	}

	async update(options = {}) {
		await this.preflightRoots();
		if (this.dryRun) return this.updateLocked(options);
		return this.withLifecycleLock(() => this.updateLocked(options));
	}

	async updateLocked(options = {}) {
		const current = await this.state();
		const stateBefore = await this.captureExpectedState(current);
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
		await this.commitTransactionLocked("update", release, prepared, current, { ...toolchains, stateBefore });
		return 0;
	}

	async doctor() {
		await this.preflightRoots();
		const issues = [];
		const current = await this.state({ optional: true });
		if (!current) issues.push("not installed: managed state is absent; no completed installation is available to verify");
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
					const inspected = await this.inspectFileLeaf(destination, `managed target ${resource.target}`);
					if (inspected.snapshot.type !== "file") throw new Error("managed resource is not a regular file");
					if (inspected.snapshot.mode !== resource.mode) {
						issues.push(`mode drift: ${resourceKey(resource)}`);
						continue;
					}
					const contents = inspected.bytes;
					if (resource.kind === "file") {
						if (sha256(contents) !== resource.installedSha256) issues.push(`drift: ${resourceKey(resource)}`);
					} else {
						const parsed = parseConfig(resource.kind, contents.toString("utf8"), "managed config");
							removeManaged(parsed, resource.managedPaths ?? [], resource.managedContainers ?? []);
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

	async validatePreviousStateLineage(transaction) {
		const previous = transaction.previousState;
		if (!previous) return;
		const predecessorId = previous.lastTransaction;
		if (typeof predecessorId !== "string" || !/^[0-9TZ]+-[0-9a-f]{10}$/.test(predecessorId)
			|| predecessorId === transaction.id) {
			throw new Error("rollback previous state has an invalid predecessor transaction");
		}
		const predecessorPath = path.join(this.backupsDir, predecessorId, "transaction.json");
		await assertNoSymlinkComponents(predecessorPath, "rollback predecessor transaction", { allowMissing: false });
		const predecessor = await readJson(predecessorPath, "rollback predecessor transaction");
		if (!predecessor || !SUPPORTED_SCHEMAS.has(predecessor.schema)
			|| predecessor.id !== predecessorId || !Array.isArray(predecessor.resources)) {
			throw new Error("rollback predecessor transaction is invalid");
		}
		validateToolchainIdentity(predecessor.fromToolchain, "rollback predecessor toolchain");
		validateToolchainIdentity(predecessor.toToolchain, "rollback predecessor current toolchain");
		validateTransactionEnvelope(predecessor, previous);
		validateTransactionResourceSet(predecessor, previous);
		if (stableJson(previous.toolchain) !== stableJson(predecessor.toToolchain)) {
			throw new Error("rollback previous state and predecessor toolchain identity disagree");
		}
		if (predecessor.previousState
			&& stableJson(predecessor.previousState.toolchain) !== stableJson(predecessor.fromToolchain)) {
			throw new Error("rollback predecessor state and toolchain identity disagree");
		}
		for (const record of predecessor.resources) {
			if (record.kind === "file") continue;
			validateMergeRollbackMetadata(predecessor, previous, record, resourceKey(record));
		}
	}

	async rollback(options = {}) {
		await this.preflightRoots();
		if (this.dryRun) return this.rollbackLocked(options);
		return this.withLifecycleLock(() => this.rollbackLocked(options));
	}

	async rollbackLocked(options = {}) {
		const current = await this.state({ optional: true });
		const stateBefore = await this.captureExpectedState(current);
		const id = options.transaction ?? current?.lastTransaction;
		if (!id || !/^[0-9TZ]+-[0-9a-f]{10}$/.test(id)) throw new Error("rollback transaction id is invalid");
		const transactionDir = path.join(this.backupsDir, id);
		const transactionPath = path.join(transactionDir, "transaction.json");
		await assertNoSymlinkComponents(transactionPath, "rollback transaction", { allowMissing: false });
		const transaction = await readJson(transactionPath, "rollback transaction");
		if (!transaction || !SUPPORTED_SCHEMAS.has(transaction.schema) || transaction.id !== id || !Array.isArray(transaction.resources)) {
			throw new Error("rollback transaction is invalid");
		}
		validateToolchainIdentity(transaction.fromToolchain, "rollback previous toolchain");
		validateToolchainIdentity(transaction.toToolchain, "rollback current toolchain");
		if (current && current.lastTransaction !== id) throw new Error("only the active release transaction can be rolled back");
		validateTransactionEnvelope(transaction, current);
		validateTransactionResourceSet(transaction, current);
		if (transaction.previousState && stableJson(transaction.previousState.toolchain) !== stableJson(transaction.fromToolchain)) {
			throw new Error("rollback previous state and toolchain identity disagree");
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
			const recordTargetRoot = record.targetRoot ?? "codex_home";
			if (!TARGET_ROOTS.has(recordTargetRoot)) throw new Error("rollback transaction contains an unsupported target root");
			assertManagedTarget(record.target);
			if (!RESOURCE_KINDS.has(record.kind)) throw new Error("rollback transaction contains an unsupported resource kind");
			const key = resourceKey(record);
			if (seenTargets.has(key)) throw new Error("rollback transaction contains a duplicate resource");
			seenTargets.add(key);
			const destination = this.resourcePath(record);
			if (Object.hasOwn(record, "previousKind")) {
				if (transaction.schema < STATE_SCHEMA || transaction.action !== "update"
					|| record.previousKind !== "file" || record.kind !== "toml-merge") {
					throw new Error("rollback transaction contains an unsupported resource kind transition");
				}
				const beforeSnapshot = validateFileSnapshot(record.beforeSnapshot, "rollback transition previous snapshot");
				if (beforeSnapshot.type !== "file" || record.afterPresent !== true || !MODES.has(record.afterMode)
					|| typeof record.created !== "boolean" || !/^\d{4}\.bak$/.test(record.backup ?? "")) {
					throw new Error("rollback transaction contains invalid resource kind transition metadata");
				}
				const previousResource = transaction.previousState.resources.find((resource) => resourceKey(resource) === key);
				const currentResource = current.resources.find((resource) => resourceKey(resource) === key);
				if (beforeSnapshot.sha256 !== previousResource.installedSha256 || beforeSnapshot.mode !== previousResource.mode
					|| record.afterMode !== currentResource.mode || record.created !== currentResource.created) {
					throw new Error("rollback resource kind transition metadata does not match its states");
				}
				if (seenBackups.has(record.backup)) throw new Error("rollback transaction reuses a backup file");
				seenBackups.add(record.backup);
				validateMergeRollbackMetadata(transaction, current, record, key);
				const live = await this.inspectFileLeaf(destination, `rollback target ${record.target}`);
				if (live.snapshot.type !== "file" || live.snapshot.mode !== record.afterMode) {
					throw new Error(`refusing rollback because resource drifted: ${record.target}`);
				}
				const currentValue = parseConfig(record.kind, live.bytes.toString("utf8"), `current rollback config ${record.target}`);
					const restoredValue = restoreManagedRollbackDelta(currentValue, record.managedDelta, {
						managedContainers: currentResource.managedContainers ?? [],
						managedPaths: currentResource.managedPaths ?? [],
					});
				const backupPath = path.join(transactionDir, record.backup);
				if (path.dirname(backupPath) !== transactionDir) throw new Error("rollback backup path escapes its transaction");
				await assertNoSymlinkComponents(backupPath, "rollback backup", { allowMissing: false });
				const restoredBytes = await fs.readFile(backupPath);
				if (sha256(restoredBytes) !== beforeSnapshot.sha256) throw new Error(`rollback backup checksum mismatch: ${record.target}`);
				const backupValue = parseConfig(record.kind, restoredBytes.toString("utf8"), `rollback backup config ${record.target}`);
				if (stableJson(restoredValue) !== stableJson(backupValue)) {
					throw new Error(`refusing rollback because profile gained unmanaged values after representation transition: ${record.target}`);
				}
				snapshots.push({
					record, destination, currentSnapshot: live.snapshot, currentBytes: live.bytes, currentMode: live.snapshot.mode,
					currentIdentity: live.identity, restoredSnapshot: beforeSnapshot, restoredBytes,
				});
				continue;
			}
			if (record.kind === "file") {
				if (Object.hasOwn(record, "displacedValues")) throw new Error("rollback transaction contains displaced config values for a non-merge resource");
				let beforeSnapshot;
				let afterSnapshot;
				if (transaction.schema === LEGACY_SCHEMA) {
					if (Object.hasOwn(record, "beforeSnapshot") || Object.hasOwn(record, "afterSnapshot")) throw new Error("schema-3 transaction contains schema-4 snapshots");
					const beforeDigestValid = record.beforeSha256 === null || HEX_SHA256.test(record.beforeSha256 ?? "");
					const afterDigestValid = record.afterSha256 === null || HEX_SHA256.test(record.afterSha256 ?? "");
					if (!beforeDigestValid || !afterDigestValid) throw new Error("rollback transaction contains an invalid resource checksum");
					if (record.beforeSha256 === null ? record.beforeMode !== null : !validPosixMode(record.beforeMode)) {
						throw new Error("rollback transaction has invalid previous mode metadata");
					}
					if (record.afterSha256 === null ? record.afterMode !== null : !MODES.has(record.afterMode)) {
						throw new Error("rollback transaction has invalid installed mode metadata");
					}
					beforeSnapshot = record.beforeSha256 === null ? { type: "missing" } : { type: "file", sha256: record.beforeSha256, mode: record.beforeMode };
					afterSnapshot = record.afterSha256 === null ? { type: "missing" } : { type: "file", sha256: record.afterSha256, mode: record.afterMode };
					validateFileSnapshot(beforeSnapshot, "rollback previous snapshot");
					validateFileSnapshot(afterSnapshot, "rollback installed snapshot");
				} else {
					if (["beforeSha256", "afterSha256", "beforeMode", "afterMode"].some((field) => Object.hasOwn(record, field))) {
						throw new Error(`schema-${transaction.schema} transaction contains legacy file metadata`);
					}
					beforeSnapshot = validateFileSnapshot(record.beforeSnapshot, "rollback previous snapshot");
					afterSnapshot = validateFileSnapshot(record.afterSnapshot, "rollback installed snapshot");
					if ((beforeSnapshot.type === "symlink" || afterSnapshot.type === "symlink") && key !== MIGRATABLE_LAUNCHER_KEY) {
						throw new Error("rollback transaction contains misplaced launcher migration metadata");
					}
					if (afterSnapshot.type === "file" && !MODES.has(afterSnapshot.mode)) throw new Error("rollback transaction has invalid installed mode metadata");
					if ((beforeSnapshot.type === "symlink" || afterSnapshot.type === "symlink")
						&& !((beforeSnapshot.type === "symlink" && afterSnapshot.type === "file")
							|| (beforeSnapshot.type === "file" && afterSnapshot.type === "symlink"))) {
						throw new Error("rollback transaction contains an invalid launcher snapshot transition");
					}
				}
				if (beforeSnapshot.type === "file") {
					if (!/^\d{4}\.bak$/.test(record.backup ?? "")) throw new Error("rollback transaction has invalid backup metadata");
					if (seenBackups.has(record.backup)) throw new Error("rollback transaction reuses a backup file");
					seenBackups.add(record.backup);
				} else if (record.backup !== null) {
					throw new Error("rollback transaction has inconsistent absent-resource metadata");
				}
				const live = await this.inspectFileLeaf(destination, `rollback target ${record.target}`);
				if (stableJson(live.snapshot) !== stableJson(afterSnapshot)) throw new Error(`refusing rollback because resource drifted: ${record.target}`);
				let restoredBytes = null;
				if (record.backup) {
					const backupPath = path.join(transactionDir, record.backup);
					if (path.dirname(backupPath) !== transactionDir) throw new Error("rollback backup path escapes its transaction");
					await assertNoSymlinkComponents(backupPath, "rollback backup", { allowMissing: false });
					restoredBytes = await fs.readFile(backupPath);
					if (sha256(restoredBytes) !== beforeSnapshot.sha256) throw new Error(`rollback backup checksum mismatch: ${record.target}`);
				}
				snapshots.push({ record, destination, currentSnapshot: live.snapshot, currentBytes: live.bytes, currentIdentity: live.identity, restoredSnapshot: beforeSnapshot, restoredBytes });
				continue;
			}

			if (transaction.schema === LEGACY_SCHEMA && (Object.hasOwn(record, "beforeSnapshot") || Object.hasOwn(record, "afterSnapshot"))) {
				throw new Error("schema-3 merge-resource record contains schema-4 snapshots");
			}
			if (Object.hasOwn(record, "backup") || Object.hasOwn(record, "beforeSha256") || Object.hasOwn(record, "afterSha256") || Object.hasOwn(record, "beforeSnapshot") || Object.hasOwn(record, "afterSnapshot")) {
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
			validateMergeRollbackMetadata(transaction, current, record, key);
			const live = await this.inspectFileLeaf(destination, `rollback target ${record.target}`);
			if (!new Set(["missing", "file"]).has(live.snapshot.type)) throw new Error(`refusing rollback because resource drifted: ${record.target}`);
			const bytes = live.bytes;
			const currentMode = live.snapshot.type === "file" ? live.snapshot.mode : null;
			if ((bytes !== null) !== record.afterPresent) throw new Error(`refusing rollback because resource presence drifted: ${record.target}`);
			if (currentMode !== record.afterMode) throw new Error(`refusing rollback because resource mode drifted: ${record.target}`);
			const currentValue = bytes ? parseConfig(record.kind, bytes.toString("utf8"), `current rollback config ${record.target}`) : {};
				const currentResource = current?.resources.find((resource) => resourceKey(resource) === key);
				const restoredValue = restoreManagedRollbackDelta(currentValue, record.managedDelta, {
					managedContainers: currentResource?.managedContainers ?? [],
					managedPaths: currentResource?.managedPaths ?? [],
				});
			let restored = null;
			let restoredMode = record.beforeMode;
			if (record.beforePresent || !emptyObject(restoredValue)) {
				restored = Buffer.from(serializeConfig(record.kind, restoredValue));
				restoredMode = record.beforeMode ?? currentMode ?? record.afterMode;
			}
			const restoredSnapshot = fileSnapshot(restored, restoredMode);
			snapshots.push({
				record, destination, currentBytes: bytes, currentMode, restoredBytes: restored,
				restoredSnapshot, currentSnapshot: live.snapshot, currentIdentity: live.identity,
			});
		}
		await this.validatePreviousStateLineage(transaction);
		if (this.dryRun) { this.output.log(`[dry-run] rollback transaction ${id}`); return; }

		if (current) await atomicWrite(path.join(this.stateDir, `state.rolled-back-${id}.json`), stableJson(current), 0o600);
		let pointerSwitched = false;
		const changed = [];
		const restoredStateBytes = transaction.previousState ? Buffer.from(stableJson(transaction.previousState)) : null;
		const intendedStateSnapshot = fileSnapshot(restoredStateBytes, 0o600);
		let intendedStateIdentity = null;
		try {
			await this.toolchain.switchToIdentity(transaction.fromToolchain);
			pointerSwitched = true;
			for (const item of snapshots) {
				await this.assertPreparedLeaf({ destination: item.destination, beforeSnapshot: item.currentSnapshot, beforeIdentity: item.currentIdentity }, `rollback target ${item.record.target}`);
				const outcomeBytes = item.restoredBytes;
				const outcomeMode = item.restoredSnapshot.mode;
				try {
					await this.writeFileOutcome(item.destination, item.restoredSnapshot, outcomeBytes, outcomeMode);
				} catch (writeError) {
					try {
						const live = await this.inspectFileLeaf(item.destination, `rollback target ${item.record.target}`);
						const unchanged = stableJson(live.snapshot) === stableJson(item.currentSnapshot)
							&& (!item.currentIdentity || (live.identity?.dev === item.currentIdentity.dev && live.identity?.ino === item.currentIdentity.ino));
						if (!unchanged) {
							changed.push(item);
							if (stableJson(live.snapshot) === stableJson(item.restoredSnapshot)) item.appliedIdentity = live.identity;
							else item.appliedUncertain = true;
						}
					} catch {
						item.appliedUncertain = true;
						changed.push(item);
					}
					throw writeError;
				}
				changed.push(item);
				const applied = await this.inspectFileLeaf(item.destination, `rollback target ${item.record.target}`);
				if (stableJson(applied.snapshot) !== stableJson(item.restoredSnapshot)) {
					item.appliedUncertain = true;
					throw new Error(`rollback target ${item.record.target} changed after replacement`);
				}
				item.appliedIdentity = applied.identity;
			}
			if (transaction.previousState) await atomicWrite(this.statePath, restoredStateBytes, 0o600);
			else await fs.rm(this.statePath, { force: true });
			intendedStateIdentity = (await this.inspectFileLeaf(this.statePath, "managed state")).identity;
		} catch (error) {
			let restorationFailed = false;
			for (const item of [...changed].reverse()) {
				try {
					if (item.appliedUncertain) throw new Error("written outcome could not be authenticated");
					await this.assertPreparedLeaf({
						destination: item.destination,
						beforeSnapshot: item.restoredSnapshot,
						beforeIdentity: item.appliedIdentity,
					}, `rollback restoration target ${item.record.target}`);
					await this.writeFileOutcome(item.destination, item.currentSnapshot, item.currentBytes, item.currentMode ?? item.currentSnapshot.mode);
				} catch {
					restorationFailed = true;
				}
			}
			await this.restoreStateAfterFailure(stateBefore, intendedStateSnapshot, intendedStateIdentity).catch(() => { restorationFailed = true; });
			if (pointerSwitched) {
				await this.toolchain.switchToIdentity(transaction.toToolchain).catch(() => { restorationFailed = true; });
			}
			throw new Error(`rollback failed${restorationFailed ? " and restoration was incomplete" : " and was restored"}: ${error.message}`);
		}
		this.output.log(`rollback complete: ${id}`);
	}

	async uninstall() {
		await this.preflightRoots();
		if (this.dryRun) return this.uninstallLocked();
		return this.withLifecycleLock(() => this.uninstallLocked());
	}

	async uninstallLocked() {
		const current = await this.state();
		const stateBefore = await this.captureExpectedState(current);
		const toolchains = await this.coupledToolchains(current);
		const prepared = [];
		for (const resource of current.resources) {
			const destination = this.resourcePath(resource);
			const inspected = await this.inspectFileLeaf(destination, `managed target ${resource.target}`);
			if (inspected.snapshot.type !== "file") throw new Error(`managed resource is missing or invalid: ${resource.target}`);
			const before = inspected.bytes;
			const beforeMode = inspected.snapshot.mode;
			if (beforeMode !== resource.mode) throw new Error(`managed resource mode drifted: ${resource.target}`);
			let after = null;
			let afterSnapshot = { type: "missing" };
			let managedDelta;
			if (resource.kind === "file") {
				if (sha256(before) !== resource.installedSha256) throw new Error(`managed resource drifted: ${resource.target}`);
				if (resource.displacedSymlink) afterSnapshot = resource.displacedSymlink;
			} else {
				const value = parseConfig(resource.kind, before.toString("utf8"), `existing config ${resource.target}`);
					let stripped = removeManaged(value, resource.managedPaths ?? [], resource.managedContainers ?? []);
				stripped = restoreDisplacedValues(stripped, resource.displacedValues ?? [], resource.managedPaths ?? []);
				if (!(resource.created && emptyObject(stripped))) {
					after = Buffer.from(serializeConfig(resource.kind, stripped));
					afterSnapshot = fileSnapshot(after, resource.mode);
				}
				managedDelta = createManagedRollbackDelta(value, stripped, resource.managedPaths ?? [], [], { displacedValues: resource.displacedValues ?? [] });
			}
			prepared.push({
				artifact: { targetRoot: resource.targetRoot, target: resource.target, kind: resource.kind, mode: resource.mode },
				destination, before, beforeMode, beforeSnapshot: inspected.snapshot, beforeIdentity: inspected.identity,
				after, afterSnapshot, removed: true, created: resource.created, managedDelta, displacedSymlink: resource.displacedSymlink,
				transactionDisplacedValues: resource.displacedValues ?? [],
			});
		}
		await this.commitTransactionLocked("uninstall", {
			version: current.version, platform: current.platform,
			manifestSha256: current.releaseManifestSha256,
		}, prepared, current, { ...toolchains, deactivate: true, stateBefore });
		this.output.log(`uninstalled managed release ${current.version}; backups retained in ${this.backupsDir}`);
	}
}
