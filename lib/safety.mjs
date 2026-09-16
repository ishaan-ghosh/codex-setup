import fs from "node:fs/promises";
import path from "node:path";

const PROTECTED_COMPONENTS = new Set([
	"auth.json",
	"sessions",
	"memories",
	"logs",
	"cache",
	"browser",
	"browser-profiles",
	"browser_profiles",
	"secrets",
]);

export function assertAbsolute(candidate, label) {
	if (!path.isAbsolute(candidate)) throw new Error(`${label} must be an absolute path`);
	return path.resolve(candidate);
}

export function normalizeRelative(candidate, label = "path") {
	if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
		throw new Error(`${label} must be a non-empty relative path`);
	}
	if (path.isAbsolute(candidate) || candidate.includes("\\")) {
		throw new Error(`${label} must use portable relative path syntax: ${candidate}`);
	}
	const components = candidate.split("/");
	if (components.some((component) => !component || component === "." || component === "..")) {
		throw new Error(`${label} contains an unsafe component: ${candidate}`);
	}
	return components.join("/");
}

export function assertManagedTarget(candidate) {
	const normalized = normalizeRelative(candidate, "managed target");
	for (const component of normalized.toLowerCase().split("/")) {
		if (PROTECTED_COMPONENTS.has(component) || component.startsWith("secret.")) {
			throw new Error(`release attempts to manage protected Codex state: ${candidate}`);
		}
	}
	if (normalized === ".codex-setup" || normalized.startsWith(".codex-setup/")) {
		throw new Error(`release target overlaps lifecycle state: ${candidate}`);
	}
	return normalized;
}

export function inside(root, relative) {
	const result = path.resolve(root, relative);
	if (result !== root && !result.startsWith(`${root}${path.sep}`)) {
		throw new Error(`path escapes its root: ${relative}`);
	}
	return result;
}

export async function assertNoSymlinkComponents(candidate, label, { allowMissing = true } = {}) {
	const absolute = assertAbsolute(candidate, label);
	const parsed = path.parse(absolute);
	let current = parsed.root;
	for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		let info;
		try {
			info = await fs.lstat(current);
		} catch (error) {
			if (error.code === "ENOENT" && allowMissing) continue;
			throw error;
		}
		if (info.isSymbolicLink()) throw new Error(`${label} contains a symbolic-link component: ${current}`);
	}
	return absolute;
}

export async function classify(candidate) {
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

export async function assertSafeRoot(root, label) {
	const absolute = assertAbsolute(root, label);
	await assertNoSymlinkComponents(absolute, label);
	const kind = await classify(absolute);
	if (kind !== "missing" && kind !== "directory") throw new Error(`${label} is not a directory: ${absolute}`);
	return absolute;
}
