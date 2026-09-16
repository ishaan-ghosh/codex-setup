import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export const SUPERPOWERS = Object.freeze({
	version: "6.3.0",
	commit: "b36e0829c6d0140e93cfef2ca599b1b07d4a7797",
	archiveUrl: "https://github.com/obra/superpowers/archive/b36e0829c6d0140e93cfef2ca599b1b07d4a7797.tar.gz",
	archiveSha256: "7c3ae7db406f8d92cf55329aa9e9a41e53f6cef00bdb68e1325713be97ef5d7c",
	license: "MIT",
	enabled: Object.freeze([
		"brainstorming",
		"writing-plans",
		"verification-before-completion",
		"dispatching-parallel-agents",
		"receiving-code-review",
	]),
	deferred: Object.freeze([
		"subagent-driven-development",
		"using-git-worktrees",
		"executing-plans",
		"finishing-a-development-branch",
	]),
	disabled: Object.freeze([
		"test-driven-development",
		"systematic-debugging",
		"requesting-code-review",
		"writing-skills",
		"using-superpowers",
	]),
});

const COMPONENT = "superpowers";
const STATE_SCHEMA = 1;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DISABLED_RESOURCES = new Set([
	"brainstorming/scripts/frame-template.html",
	"brainstorming/scripts/helper.js",
	"brainstorming/scripts/server.cjs",
	"brainstorming/scripts/start-server.sh",
	"brainstorming/scripts/stop-server.sh",
	"brainstorming/visual-companion.md",
]);

function digest(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function absolute(candidate, label) {
	if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
	return path.resolve(candidate);
}

async function assertNoSymlinkComponents(candidate, label, { allowMissing = true } = {}) {
	const target = absolute(candidate, label);
	const parsed = path.parse(target);
	let current = parsed.root;
	for (const component of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`${label} contains a symbolic-link component: ${current}`);
		} catch (error) {
			if (error.code === "ENOENT" && allowMissing) continue;
			throw error;
		}
	}
	return target;
}

async function classify(filePath) {
	try {
		const info = await fs.lstat(filePath);
		if (info.isSymbolicLink()) return "symlink";
		if (info.isFile()) return "file";
		if (info.isDirectory()) return "directory";
		return "special";
	} catch (error) {
		if (error.code === "ENOENT") return "missing";
		throw error;
	}
}

function safeArchivePath(value) {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
		throw new Error(`archive contains an unsafe path: ${JSON.stringify(value)}`);
	}
	const parts = value.split("/");
	if (parts.at(-1) === "") parts.pop();
	if (parts.some((part) => part === ".." || part === "." || part.length === 0)) throw new Error(`archive contains an unsafe path: ${value}`);
	return parts.join("/");
}

function field(header, start, length) {
	return header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
}

function octal(header, start, length, label) {
	const raw = field(header, start, length).trim().replace(/\0/g, "");
	if (!raw) return 0;
	if (!/^[0-7]+$/.test(raw)) throw new Error(`archive has an invalid ${label}`);
	return Number.parseInt(raw, 8);
}

function parsePax(bytes) {
	const values = {};
	let offset = 0;
	while (offset < bytes.length) {
		const end = bytes.indexOf(0x20, offset);
		if (end < 0) throw new Error("archive has malformed PAX metadata");
		const length = Number.parseInt(bytes.subarray(offset, end).toString("ascii"), 10);
		if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) throw new Error("archive has malformed PAX metadata");
		const record = bytes.subarray(offset, offset + length).toString("utf8");
		const equals = record.indexOf("=");
		if (equals < 0 || !record.endsWith("\n")) throw new Error("archive has malformed PAX metadata");
		values[record.slice(end - offset + 1, equals)] = record.slice(equals + 1, -1);
		offset += length;
	}
	return values;
}

function verifyTarChecksum(header) {
	const expected = octal(header, 148, 8, "checksum");
	let actual = 0;
	for (let index = 0; index < 512; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index];
	if (actual !== expected) throw new Error("archive header checksum mismatch");
}

/** Parse gzip tar bytes without invoking a shell or following archive links. */
export function extractSelectedSkills(archiveBytes) {
	const compressed = Buffer.isBuffer(archiveBytes) ? archiveBytes : Buffer.from(archiveBytes);
	let tar;
	try { tar = gunzipSync(compressed); } catch (error) { throw new Error(`Superpowers archive is not valid gzip: ${error.message}`); }
	const entries = [];
	let offset = 0;
	let globalPax = {};
	let localPax = null;
	let root = null;
	const selectedPrefix = new Set(SUPERPOWERS.enabled.map((name) => `skills/${name}`));
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		verifyTarChecksum(header);
		const rawName = field(header, 0, 100);
		const prefix = field(header, 345, 155);
		const name = safeArchivePath(prefix ? `${prefix}/${rawName}` : rawName);
		const type = String.fromCharCode(header[156] || 0);
		const declaredSize = octal(header, 124, 12, "size");
		const dataStart = offset + 512;
		const dataEnd = dataStart + declaredSize;
		if (dataEnd > tar.length) throw new Error("archive entry extends beyond end of archive");
		const data = tar.subarray(dataStart, dataEnd);
		offset = dataStart + Math.ceil(declaredSize / 512) * 512;
		if (type === "g") { globalPax = { ...globalPax, ...parsePax(data) }; continue; }
		if (type === "x") { localPax = parsePax(data); continue; }
		const pax = { ...globalPax, ...(localPax ?? {}) };
		localPax = null;
		const effectiveName = safeArchivePath(pax.path ?? name);
		const effectiveSize = pax.size === undefined ? declaredSize : Number(pax.size);
		if (!Number.isSafeInteger(effectiveSize) || effectiveSize < 0 || effectiveSize !== declaredSize) throw new Error("archive PAX size does not match entry size");
		const parts = effectiveName.split("/");
		if (!root) root = parts[0];
		if (parts[0] !== root) throw new Error("archive contains multiple top-level roots");
		if (type === "1" || type === "2") {
			if (parts[1] === "skills" && selectedPrefix.has(parts.slice(1, 3).join("/"))) throw new Error(`archive selected skill contains a link: ${effectiveName}`);
			continue;
		}
		if (type !== "0" && type !== "5" && type !== "\0") throw new Error(`archive contains unsupported entry type ${JSON.stringify(type)}: ${effectiveName}`);
		if (parts[1] !== "skills" || !selectedPrefix.has(parts.slice(1, 3).join("/"))) continue;
		const skill = parts[2];
		const relative = parts.slice(3).join("/");
		if (!relative && type === "0") throw new Error(`selected skill root is a file: ${effectiveName}`);
		if (relative && !DISABLED_RESOURCES.has(`${skill}/${relative}`)) entries.push({ skill, relative, type: type === "5" ? "directory" : "file", mode: octal(header, 100, 8, "mode") & 0o777, data: Buffer.from(data) });
	}
	if (!root || !root.startsWith("superpowers-")) throw new Error("archive has an unexpected repository root");
	const found = new Set(entries.filter((entry) => entry.type === "file" && entry.relative === "SKILL.md").map((entry) => entry.skill));
	for (const skill of SUPERPOWERS.enabled) if (!found.has(skill)) throw new Error(`archive is missing selected skill: ${skill}`);
	return { root, entries };
}

function namespaceSkill(skill) {
	if (!SKILL_NAME.test(skill)) throw new Error(`invalid skill name: ${skill}`);
	return `superpowers-${skill}`;
}

function namespacedSkillBytes(entry) {
	if (entry.relative !== "SKILL.md") return entry.data;
	const text = entry.data.toString("utf8");
	const match = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
	if (!match) throw new Error(`selected skill has no frontmatter: ${entry.skill}`);
	const nameLine = new RegExp(`^name\\s*:[^\\r\\n]*$`, "m");
	if (!nameLine.test(match[2])) throw new Error(`selected skill frontmatter has no name: ${entry.skill}`);
	const rewritten = match[2].replace(nameLine, `name: ${namespaceSkill(entry.skill)}`);
	return Buffer.from(`${match[1]}${rewritten}${match[3]}${text.slice(match[0].length)}`);
}

function statePath(codexHome) { return path.join(codexHome, ".codex-setup", "components", `${COMPONENT}.json`); }
function defaultSkillsRoot() {
	const home = process.env.HOME;
	if (typeof home !== "string" || !path.isAbsolute(home)) throw new Error("HOME must be an absolute path");
	return path.join(home, ".agents", "skills");
}

async function resolveSkillsRoot(candidate) {
	return assertNoSymlinkComponents(candidate ?? defaultSkillsRoot(), "personal skills root");
}

function licenseTarget(skillsRoot) { return path.join(skillsRoot, "superpowers-LICENSE"); }

async function readState(filePath) {
	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
		if (!parsed || parsed.schema !== STATE_SCHEMA || parsed.component !== COMPONENT || !Array.isArray(parsed.resources)) throw new Error("state has an unsupported schema");
		return parsed;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		if (error.message.startsWith("state has")) throw error;
		throw new Error(`Superpowers state is invalid: ${error.message}`);
	}
}

async function writeAtomic(filePath, bytes, mode = 0o644) {
	const parent = path.dirname(filePath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const temporary = path.join(parent, `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
	try {
		await fs.writeFile(temporary, bytes, { flag: "wx", mode });
		await fs.chmod(temporary, mode);
		await fs.rename(temporary, filePath);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}

async function readArchive(archivePath, expectedSha256) {
	const candidate = await assertNoSymlinkComponents(archivePath, "archive path", { allowMissing: false });
	if (await classify(candidate) !== "file") throw new Error("archive path must be a regular file");
	const bytes = await fs.readFile(candidate);
	const actual = digest(bytes);
	if (actual !== expectedSha256) throw new Error(`Superpowers archive checksum mismatch: expected ${expectedSha256}, got ${actual}`);
	return bytes;
}

export async function downloadArchive({ fetchImpl = fetch, url = SUPERPOWERS.archiveUrl } = {}) {
	const response = await fetchImpl(url, { redirect: "follow" });
	if (!response.ok) throw new Error(`Superpowers archive download failed: HTTP ${response.status}`);
	const finalUrl = new URL(response.url || url);
	if (finalUrl.protocol !== "https:") throw new Error("Superpowers archive redirected to a non-HTTPS URL");
	const declared = Number(response.headers?.get?.("content-length") ?? 0);
	if (declared > MAX_ARCHIVE_BYTES) throw new Error("Superpowers archive exceeds size limit");
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Superpowers archive exceeds size limit");
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-superpowers-"));
	const archivePath = path.join(directory, "superpowers.tar.gz");
	await fs.writeFile(archivePath, bytes, { mode: 0o600 });
	return { archivePath, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
}

function resourcesFromExtracted(extracted, licenseBytes) {
	const resources = [];
	for (const entry of extracted.entries) {
		if (entry.type !== "file") continue;
		const target = path.posix.join(namespaceSkill(entry.skill), entry.relative);
		const bytes = namespacedSkillBytes(entry);
		resources.push({ target, source: `${extracted.root}/skills/${entry.skill}/${entry.relative}`, sourceSha256: digest(entry.data), bytes, mode: entry.mode || 0o644 });
	}
	resources.push({ target: "superpowers-LICENSE", source: `${extracted.root}/LICENSE`, sourceSha256: digest(licenseBytes), bytes: licenseBytes, mode: 0o644 });
	return resources.sort((left, right) => left.target.localeCompare(right.target));
}

function targetPath(skillsRoot, target) {
	if (!target || target.includes("..") || target.includes("\\") || path.posix.isAbsolute(target)) throw new Error(`invalid managed target: ${target}`);
	return path.join(skillsRoot, target);
}

async function verifyResource(resource, skillsRoot) {
	const destination = targetPath(skillsRoot, resource.target);
	await assertNoSymlinkComponents(destination, `managed target ${resource.target}`, { allowMissing: false });
	if (await classify(destination) !== "file") throw new Error(`managed resource is not a regular file: ${resource.target}`);
	const bytes = await fs.readFile(destination);
	if (digest(bytes) !== resource.installedSha256) throw new Error(`managed resource drifted: ${resource.target}`);
}

async function prepareTargets(resources, skillsRoot, previous) {
	const previousByTarget = new Map((previous?.resources ?? []).map((item) => [item.target, item]));
	for (const resource of resources) {
		const destination = targetPath(skillsRoot, resource.target);
		await assertNoSymlinkComponents(destination, `managed target ${resource.target}`);
		const kind = await classify(destination);
		const old = previousByTarget.get(resource.target);
		if (old) {
			await verifyResource(old, skillsRoot);
		} else if (kind !== "missing") {
			throw new Error(`unmanaged file blocks install: ${resource.target}`);
		}
	}
}

function buildState(resources, archiveSha256) {
	return {
		schema: STATE_SCHEMA,
		component: COMPONENT,
		version: SUPERPOWERS.version,
		commit: SUPERPOWERS.commit,
		archiveSha256,
		license: SUPERPOWERS.license,
		installedAt: new Date().toISOString(),
		deferred: [...SUPERPOWERS.deferred],
		disabled: [...SUPERPOWERS.disabled],
		resources: resources.map((resource) => ({ target: resource.target, source: resource.source, sourceSha256: resource.sourceSha256, installedSha256: digest(resource.bytes), mode: resource.mode })),
	};
}

export async function installFromArchive({ codexHome, skillsRoot, archivePath, expectedArchiveSha256 = SUPERPOWERS.archiveSha256 } = {}) {
	const home = await assertNoSymlinkComponents(codexHome, "CODEX_HOME");
	const personalSkills = await resolveSkillsRoot(skillsRoot);
	const bytes = await readArchive(archivePath, expectedArchiveSha256);
	const extracted = extractSelectedSkills(bytes);
	const licenseEntry = await (async () => {
		// Re-read only the preserved license through the parser by locating it in a
		// second pass; no archive path is ever handed to an extraction utility.
		const tar = gunzipSync(bytes);
		let offset = 0;
		while (offset + 512 <= tar.length) {
			const header = tar.subarray(offset, offset + 512);
			if (header.every((byte) => byte === 0)) break;
			const size = octal(header, 124, 12, "size");
			const name = safeArchivePath(`${field(header, 345, 155) ? `${field(header, 345, 155)}/` : ""}${field(header, 0, 100)}`);
			const start = offset + 512;
			offset = start + Math.ceil(size / 512) * 512;
			if (name === `${extracted.root}/LICENSE` && (header[156] === 0 || header[156] === 48)) return Buffer.from(tar.subarray(start, start + size));
		}
		return null;
	})();
	if (!licenseEntry) throw new Error("archive is missing its LICENSE file");
	const resources = resourcesFromExtracted(extracted, licenseEntry);
	const stateFile = statePath(home);
	await assertNoSymlinkComponents(stateFile, "Superpowers component state");
	const previous = await readState(stateFile);
	if (previous) {
		if (previous.archiveSha256 !== expectedArchiveSha256) throw new Error("existing Superpowers state uses a different archive checksum");
		for (const resource of previous.resources) await verifyResource(resource, personalSkills);
		return { changed: false, state: previous, resources: previous.resources.map((item) => item.target) };
	}
	await prepareTargets(resources, personalSkills, null);
	const written = [];
	try {
		for (const resource of resources) {
			const destination = targetPath(personalSkills, resource.target);
			await writeAtomic(destination, resource.bytes, resource.mode);
			written.push({ destination, resource });
		}
		const state = buildState(resources, expectedArchiveSha256);
		await writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
		return { changed: true, state, resources: resources.map((item) => item.target) };
	} catch (error) {
		for (const { destination } of written.reverse()) await fs.rm(destination, { force: true }).catch(() => {});
		throw error;
	}
}

export async function install({ codexHome, skillsRoot, archivePath } = {}) {
	let downloaded;
	try {
		if (!archivePath) downloaded = await downloadArchive();
		return await installFromArchive({ codexHome, skillsRoot, archivePath: archivePath ?? downloaded.archivePath });
	} finally {
		await downloaded?.cleanup?.();
	}
}

export async function uninstall({ codexHome, skillsRoot } = {}) {
	const home = await assertNoSymlinkComponents(codexHome, "CODEX_HOME");
	const personalSkills = await resolveSkillsRoot(skillsRoot);
	const file = statePath(home);
	await assertNoSymlinkComponents(file, "Superpowers component state");
	const state = await readState(file);
	if (!state) return { changed: false, removed: [] };
	for (const resource of state.resources) await verifyResource(resource, personalSkills);
	for (const resource of state.resources) await fs.unlink(targetPath(personalSkills, resource.target));
	for (const resource of [...state.resources].sort((left, right) => right.target.length - left.target.length)) {
		let directory = path.dirname(targetPath(personalSkills, resource.target));
		while (directory.startsWith(personalSkills) && directory !== personalSkills) {
			if (await classify(directory) !== "directory") break;
			try { await fs.rmdir(directory); } catch (error) { if (error.code === "ENOTEMPTY") break; throw error; }
			directory = path.dirname(directory);
		}
	}
	await fs.unlink(file);
	return { changed: true, removed: state.resources.map((resource) => resource.target) };
}

export async function doctor({ codexHome, skillsRoot } = {}) {
	const result = { ok: true, component: COMPONENT, version: SUPERPOWERS.version, enabled: [...SUPERPOWERS.enabled], deferred: SUPERPOWERS.deferred.map((name) => ({ name, status: "adaptation-required", enabled: false })), disabled: [...SUPERPOWERS.disabled], issues: [] };
	try {
		const home = await assertNoSymlinkComponents(codexHome, "CODEX_HOME");
		const personalSkills = await resolveSkillsRoot(skillsRoot);
		const stateFile = statePath(home);
		await assertNoSymlinkComponents(stateFile, "Superpowers component state");
		const state = await readState(stateFile);
		if (!state) result.issues.push("not installed: component state is absent");
		else {
			for (const resource of state.resources) {
				try { await verifyResource(resource, personalSkills); } catch (error) { result.issues.push(error.message); }
			}
		}
	} catch (error) { result.issues.push(error.message); }
	result.ok = result.issues.length === 0;
	return result;
}

export const paths = Object.freeze({ state: statePath, license: licenseTarget });
