import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./atomic.mjs";
import { assertManagedTarget, assertNoSymlinkComponents, inside, normalizeRelative } from "./safety.mjs";

const SUPPORTED_KINDS = new Set(["file", "json-merge", "toml-merge"]);
const SUPPORTED_MODES = new Set([0o600, 0o644, 0o755]);
export const TARGET_ROOTS = new Set(["codex_home", "user_home", "local_bin"]);

async function linuxDistribution() {
	const values = {};
	try {
		const text = await fs.readFile("/etc/os-release", "utf8");
		for (const line of text.split("\n")) {
			const match = /^([A-Z_]+)=(.*)$/.exec(line);
			if (!match) continue;
			values[match[1]] = match[2].replace(/^['\"]|['\"]$/g, "");
		}
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	return values;
}

export async function platformId() {
	if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
	if (process.platform === "linux" && process.arch === "x64") {
		const distro = await linuxDistribution();
		if (distro.ID === "ubuntu" && distro.VERSION_ID === "24.04") return "ubuntu-24.04-amd64";
		if (distro.ID === "arch" || distro.ID === "cachyos" || (distro.ID_LIKE ?? "").split(/\s+/).includes("arch")) return "arch-amd64";
	}
	throw new Error(`unsupported v1 platform: ${process.platform}-${process.arch}`);
}

function parseMode(value, kind) {
	if (value === undefined) return kind === "file" ? 0o644 : 0o600;
	const mode = typeof value === "string" && /^0[0-7]{3}$/.test(value) ? Number.parseInt(value, 8) : value;
	if (!SUPPORTED_MODES.has(mode)) throw new Error(`artifact mode must be one of 0600, 0644, or 0755`);
	if (kind !== "file" && mode !== 0o600) throw new Error(`managed config files must use mode 0600`);
	return mode;
}

export async function loadRelease(manifestPath, repoRoot) {
	const resolvedManifest = path.resolve(manifestPath);
	await assertNoSymlinkComponents(resolvedManifest, "release manifest", { allowMissing: false });
	let bytes;
	let raw;
	try {
		bytes = await fs.readFile(resolvedManifest);
		raw = JSON.parse(bytes);
	} catch (error) {
		throw new Error(`cannot read release manifest ${resolvedManifest}: ${error.message}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== 1) throw new Error("release manifest schema must be exactly 1");
	if (typeof raw.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)) throw new Error("release version must be an exact semantic version");
	if (!Array.isArray(raw.artifacts) || raw.artifacts.length === 0) throw new Error("release must contain a non-empty artifacts array");
	const currentPlatform = await platformId();
	const targets = new Set();
	const artifacts = [];
	for (const [index, artifact] of raw.artifacts.entries()) {
		if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) throw new Error(`artifact ${index} must be an object`);
		const kind = artifact.kind ?? "file";
		if (!SUPPORTED_KINDS.has(kind)) throw new Error(`artifact ${index} has unsupported kind: ${kind}`);
		if (artifact.platforms !== undefined && (!Array.isArray(artifact.platforms) || !artifact.platforms.every((value) => typeof value === "string"))) {
			throw new Error(`artifact ${index} platforms must be an array of strings`);
		}
		if (artifact.platforms && !artifact.platforms.includes(currentPlatform)) continue;
		const source = normalizeRelative(artifact.source, `artifact ${index} source`);
		const targetRoot = artifact.target_root ?? "codex_home";
		if (!TARGET_ROOTS.has(targetRoot)) throw new Error(`artifact ${index} has unsupported target_root: ${targetRoot}`);
		const target = assertManagedTarget(artifact.target);
		const targetKey = `${targetRoot}:${target}`;
		if (targets.has(targetKey)) throw new Error(`duplicate managed target: ${targetKey}`);
		targets.add(targetKey);
		if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error(`artifact ${index} requires a lowercase SHA-256`);
		const sourcePath = inside(repoRoot, source);
		await assertNoSymlinkComponents(sourcePath, `artifact source ${source}`, { allowMissing: false });
		const info = await fs.lstat(sourcePath);
		if (!info.isFile()) throw new Error(`artifact source is not a regular file: ${source}`);
		const contents = await fs.readFile(sourcePath);
		if (sha256(contents) !== artifact.sha256) throw new Error(`artifact checksum mismatch: ${source}`);
		artifacts.push({ source, sourcePath, targetRoot, target, kind, mode: parseMode(artifact.mode, kind), sha256: artifact.sha256, contents });
	}
	if (artifacts.length === 0) throw new Error(`release has no artifacts for ${currentPlatform}`);
	return { schema: 1, version: raw.version, manifestPath: resolvedManifest, manifestSha256: sha256(bytes), platform: currentPlatform, artifacts };
}
