import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../lib/atomic.mjs";

const VERSION = "0.1.0";

async function walk(root, relative = "") {
	const directory = path.join(root, relative);
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const output = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const child = path.posix.join(relative, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`payload must not contain symbolic links: ${child}`);
		if (entry.isDirectory()) output.push(...await walk(root, child));
		else if (entry.isFile()) output.push(child);
		else throw new Error(`payload must contain only regular files: ${child}`);
	}
	return output;
}

function destination(relative) {
	if (relative === "AGENTS.md") return { target_root: "codex_home", target: "AGENTS.md", mode: "0644" };
	if (relative === "config/managed.toml") return { target_root: "codex_home", target: "config.toml", kind: "toml-merge", mode: "0600" };
	if (relative === "hooks/hooks.json") return { target_root: "codex_home", target: "hooks.json", kind: "json-merge", mode: "0600" };
	if (relative === "hooks/read-policy.mjs") return { target_root: "codex_home", target: "hooks/codex-setup-read-policy.mjs", mode: "0644" };
	if (relative.startsWith("agents/") && relative.endsWith(".toml")) return { target_root: "codex_home", target: relative, mode: "0644" };
	if (relative.startsWith("profiles/") && relative.endsWith(".config.toml")) {
		return { target_root: "codex_home", target: path.posix.basename(relative), kind: "toml-merge", mode: "0600" };
	}
	if (relative.startsWith("bin/")) return { target_root: "local_bin", target: path.posix.basename(relative), mode: "0755" };
	if (relative.startsWith("skills/")) return { target_root: "user_home", target: `.agents/${relative}`, mode: "0644" };
	if (relative.endsWith(".test.mjs")) return null;
	throw new Error(`payload file has no release destination: payload/${relative}`);
}

export async function buildRelease(repoRoot) {
	const payloadRoot = path.join(repoRoot, "payload");
	const artifacts = [];
	for (const relative of await walk(payloadRoot)) {
		let mapped = destination(relative);
		if (!mapped) continue;
		const source = path.posix.join("payload", relative);
		const sourcePath = path.join(repoRoot, source);
		const info = await fs.lstat(sourcePath);
		if (mapped.mode === "0644" && (info.mode & 0o111) !== 0) mapped = { ...mapped, mode: "0755" };
		const contents = await fs.readFile(sourcePath);
		artifacts.push({ source, ...mapped, sha256: sha256(contents) });
	}
	return { schema: 1, version: VERSION, artifacts };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const output = `${JSON.stringify(await buildRelease(repoRoot), null, 2)}\n`;
	if (process.argv.includes("--write")) await fs.writeFile(path.join(repoRoot, "release.json"), output, { mode: 0o644 });
	else process.stdout.write(output);
}
