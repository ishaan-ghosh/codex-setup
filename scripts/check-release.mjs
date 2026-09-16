#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease } from "./release-manifest.mjs";
import { SUPERPOWERS } from "../components/superpowers/index.mjs";
import { sha256 } from "../lib/atomic.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function json(relative) {
	return JSON.parse(await fs.readFile(path.join(repoRoot, relative), "utf8"));
}

async function validateSkills() {
	const root = path.join(repoRoot, "payload", "skills");
	const files = [];
	async function walk(directory) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const candidate = path.join(directory, entry.name);
			if (entry.isDirectory()) await walk(candidate);
			else if (entry.isFile() && entry.name === "SKILL.md") files.push(candidate);
		}
	}
	await walk(root);
	assert.ok(files.length >= 1, "payload must ship at least one skill");
	for (const file of files) {
		const text = await fs.readFile(file, "utf8");
		const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		assert.ok(frontmatter, "skill has no closed frontmatter: " + path.relative(repoRoot, file));
		assert.match(frontmatter[1], /^name\s*:\s*[^\s#]+/m, "skill has no name: " + path.relative(repoRoot, file));
		assert.match(frontmatter[1], /^description\s*:\s*.+/m, "skill has no description: " + path.relative(repoRoot, file));
	}
	return files.length;
}

const skillCount = await validateSkills();
const expected = await buildRelease(repoRoot);
const actual = await json("release.json");
assert.deepEqual(actual, expected, "release.json is stale; run npm run generate:release");
const rootPackage = await json("package.json");
assert.equal(actual.version, rootPackage.version, "release version differs from package.json");

const componentLock = await json("component-lock.json");
const superpowers = componentLock.components.superpowers;
assert.equal(SUPERPOWERS.version, superpowers.version, "Superpowers version differs from component-lock.json");
assert.equal(SUPERPOWERS.commit, superpowers.commit, "Superpowers commit differs from component-lock.json");
assert.equal(SUPERPOWERS.archiveSha256, superpowers.sha256, "Superpowers checksum differs from component-lock.json");
assert.deepEqual([...SUPERPOWERS.enabled], superpowers.enable_upstream_skills, "Superpowers allowlist differs from component-lock.json");
const vendoredSkills = (await fs.readdir(path.join(repoRoot, "payload", "skills")))
	.filter((name) => name.startsWith("superpowers-") && name !== "superpowers-LICENSE")
	.sort();
assert.deepEqual(vendoredSkills, superpowers.enable_upstream_skills.map((name) => `superpowers-${name}`).sort(), "vendored Superpowers skills differ from allowlist");
const vendorLock = await json("components/superpowers/vendor-lock.json");
assert.equal(vendorLock.schema, 1, "Superpowers vendor lock schema differs");
assert.equal(vendorLock.version, SUPERPOWERS.version, "Superpowers vendor lock version differs");
assert.equal(vendorLock.commit, SUPERPOWERS.commit, "Superpowers vendor lock commit differs");
assert.equal(vendorLock.archiveSha256, SUPERPOWERS.archiveSha256, "Superpowers vendor lock archive checksum differs");
const vendorTargets = [];
for (const resource of vendorLock.resources) {
	const bytes = await fs.readFile(path.join(repoRoot, "payload", "skills", resource.target));
	assert.equal(sha256(bytes), resource.sha256, `vendored Superpowers file differs from verified archive extraction: ${resource.target}`);
	vendorTargets.push(resource.target);
}
const actualVendorTargets = [];
async function collectVendorFiles(directory, prefix = "") {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const relative = path.posix.join(prefix, entry.name);
		if (entry.isDirectory()) await collectVendorFiles(path.join(directory, entry.name), relative);
		else if (entry.isFile()) actualVendorTargets.push(relative);
	}
}
await collectVendorFiles(path.join(repoRoot, "payload", "skills"));
assert.deepEqual(actualVendorTargets.filter((target) => target.startsWith("superpowers-")).sort(), vendorTargets.sort(), "Superpowers vendor lock does not cover every vendored file");
const toolchainPackage = await json("toolchain/package.json");
const toolchainLock = await json("toolchain/package-lock.json");
for (const [name, componentKey] of [["@openai/codex", "codex"], ["@playwright/mcp", "playwright_mcp"]]) {
	const component = componentLock.components[componentKey];
	assert.equal(toolchainPackage.dependencies[name], component.version, `${name} package pin differs from component-lock.json`);
	const locked = toolchainLock.packages[`node_modules/${name}`];
	assert.equal(locked.version, component.version, `${name} lockfile version differs from component-lock.json`);
	assert.equal(locked.integrity, component.integrity, `${name} lockfile integrity differs from component-lock.json`);
}

const tagIndex = process.argv.indexOf("--tag");
if (tagIndex !== -1) {
	const tag = process.argv[tagIndex + 1];
	if (!tag) throw new Error("--tag requires a value");
	assert.equal(tag, `v${actual.version}`, "tag does not match release version");
}

process.stdout.write(`release ${actual.version}: ${actual.artifacts.length} managed artifacts and ${skillCount} skills verified\n`);
