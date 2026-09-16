import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { SUPERPOWERS, doctor, extractSelectedSkills, installFromArchive, uninstall } from "../../components/superpowers/index.mjs";

const root = `superpowers-${SUPERPOWERS.commit}`;
const enabled = [...SUPERPOWERS.enabled];
const denied = [...SUPERPOWERS.disabled];
const deferred = [...SUPERPOWERS.deferred];

function octal(value, size) {
	return `${value.toString(8).padStart(size - 1, "0")}\0`;
}

function entry(name, body = Buffer.alloc(0), type = "0", link = "") {
	const header = Buffer.alloc(512);
	Buffer.from(name).copy(header, 0, 0, 100);
	Buffer.from(octal(type === "5" ? 0o755 : 0o644, 8)).copy(header, 100);
	Buffer.from(octal(0, 8)).copy(header, 108);
	Buffer.from(octal(0, 8)).copy(header, 116);
	Buffer.from(octal(type === "0" ? body.length : 0, 12)).copy(header, 124);
	Buffer.from(octal(0, 12)).copy(header, 136);
	header.fill(0x20, 148, 156);
	header[156] = type.charCodeAt(0);
	Buffer.from(link).copy(header, 157, 0, 100);
	Buffer.from("ustar\0").copy(header, 257);
	Buffer.from("00").copy(header, 263);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	Buffer.from(octal(checksum, 8)).copy(header, 148);
	const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
	body.copy(padded);
	return Buffer.concat([header, padded]);
}

function archive(extra = []) {
	const records = [entry(`${root}/`, Buffer.alloc(0), "5"), entry(`${root}/LICENSE`, Buffer.from("Superpowers test license\n"))];
	for (const skill of [...enabled, ...denied, ...deferred]) {
		records.push(entry(`${root}/skills/${skill}/`, Buffer.alloc(0), "5"));
		records.push(entry(`${root}/skills/${skill}/SKILL.md`, Buffer.from(`---\nname: ${skill}\ndescription: test\n---\n${skill}\n`)));
	}
	return gzipSync(Buffer.concat([...records, ...extra, Buffer.alloc(1024)]));
}

async function fixture(bytes = archive()) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-superpowers-test-"));
	const archivePath = path.join(dir, "fixture.tar.gz");
	await fs.writeFile(archivePath, bytes, { mode: 0o600 });
	return { dir, archivePath, codexHome: path.join(dir, "codex"), skillsRoot: path.join(dir, "home", ".agents", "skills") };
}

function sha(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

async function cleanup(dir) { await fs.rm(dir, { recursive: true, force: true }); }

test("installs only the allowlist with namespaced names and preserves license", async () => {
	const bytes = archive([entry(`${root}/skills/brainstorming/scripts/server.cjs`, Buffer.from("web server")), entry(`${root}/skills/brainstorming/visual-companion.md`, Buffer.from("companion"))]);
	const f = await fixture(bytes);
	try {
		await installFromArchive({ codexHome: f.codexHome, skillsRoot: f.skillsRoot, archivePath: f.archivePath, expectedArchiveSha256: sha(bytes) });
		const names = (await fs.readdir(f.skillsRoot)).sort();
		assert.deepEqual(names, [...enabled.map((name) => `superpowers-${name}`), "superpowers-LICENSE"].sort());
		for (const name of enabled) {
			const skill = await fs.readFile(path.join(f.skillsRoot, `superpowers-${name}`, "SKILL.md"), "utf8");
			assert.match(skill, new RegExp(`^name: superpowers-${name}$`, "m"));
		}
		for (const name of [...denied, ...deferred]) assert.equal(await fs.stat(path.join(f.skillsRoot, `superpowers-${name}`)).catch(() => null), null);
		assert.equal(await fs.stat(path.join(f.skillsRoot, "superpowers-brainstorming/scripts/server.cjs")).catch(() => null), null);
		assert.equal(await fs.stat(path.join(f.skillsRoot, "superpowers-brainstorming/visual-companion.md")).catch(() => null), null);
		assert.equal(await fs.readFile(path.join(f.skillsRoot, "superpowers-LICENSE"), "utf8"), "Superpowers test license\n");
	} finally { await cleanup(f.dir); }
});

test("rejects checksum failures before writing", async () => {
	const bytes = archive();
	const f = await fixture(bytes);
	try {
		await assert.rejects(installFromArchive({ codexHome: f.codexHome, skillsRoot: f.skillsRoot, archivePath: f.archivePath, expectedArchiveSha256: "0".repeat(64) }), /checksum mismatch/);
		assert.equal(await fs.stat(f.codexHome).catch(() => null), null);
	} finally { await cleanup(f.dir); }
});

test("rejects traversal and selected symlink entries", async () => {
	const traversal = archive([entry(`${root}/skills/brainstorming/../escape`, Buffer.from("bad"))]);
	assert.throws(() => extractSelectedSkills(traversal), /unsafe path/);
	const symlink = archive([entry(`${root}/skills/brainstorming/evil`, Buffer.alloc(0), "2", "../../escape")]);
	assert.throws(() => extractSelectedSkills(symlink), /contains a link/);
});

test("is idempotent, reports deferred workflows, and uninstalls only owned files", async () => {
	const bytes = archive();
	const f = await fixture(bytes);
	try {
		const first = await installFromArchive({ codexHome: f.codexHome, skillsRoot: f.skillsRoot, archivePath: f.archivePath, expectedArchiveSha256: sha(bytes) });
		assert.equal(first.changed, true);
		const second = await installFromArchive({ codexHome: f.codexHome, skillsRoot: f.skillsRoot, archivePath: f.archivePath, expectedArchiveSha256: sha(bytes) });
		assert.equal(second.changed, false);
		const report = await doctor({ codexHome: f.codexHome, skillsRoot: f.skillsRoot });
		assert.equal(report.ok, true);
		assert.deepEqual(report.deferred.map((item) => item.name), deferred);
		assert.ok(report.deferred.every((item) => item.enabled === false && item.status === "adaptation-required"));
		const userFile = path.join(f.skillsRoot, "superpowers-brainstorming", "user-notes.txt");
		await fs.writeFile(userFile, "keep me\n");
		const removed = await uninstall({ codexHome: f.codexHome, skillsRoot: f.skillsRoot });
		assert.equal(removed.changed, true);
		assert.equal(await fs.readFile(userFile, "utf8"), "keep me\n");
		assert.equal(await fs.stat(path.join(f.codexHome, ".codex-setup", "components", "superpowers.json")).catch(() => null), null);
	} finally { await cleanup(f.dir); }
});
