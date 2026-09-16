const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeKey(key, context) {
	if (FORBIDDEN_KEYS.has(key)) throw new Error(`unsafe config key at ${context}`);
	return key;
}

function assertSafeObjectKeys(value, prefix = []) {
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		assertSafeKey(key, [...prefix, key].join("."));
		assertSafeObjectKeys(child, [...prefix, key]);
	}
}

function splitOutside(input, delimiter) {
	const output = [];
	let quote = null;
	let escaped = false;
	let start = 0;
	let square = 0;
	let curly = 0;
	for (let index = 0; index < input.length; index += 1) {
		const character = input[index];
		if (escaped) { escaped = false; continue; }
		if (quote === '"' && character === "\\") { escaped = true; continue; }
		if (quote) { if (character === quote) quote = null; continue; }
		if (character === '"' || character === "'") { quote = character; continue; }
		if (character === "[") square += 1;
		if (character === "]") square -= 1;
		if (character === "{") curly += 1;
		if (character === "}") curly -= 1;
		if (square < 0 || curly < 0) throw new Error("unbalanced TOML value");
		if (character === delimiter && square === 0 && curly === 0) {
			output.push(input.slice(start, index));
			start = index + 1;
		}
	}
	if (quote || square || curly) throw new Error("multiline or unbalanced TOML values are not supported");
	output.push(input.slice(start));
	return output;
}

function stripComment(line) {
	let quote = null;
	let escaped = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index];
		if (escaped) { escaped = false; continue; }
		if (quote === '"' && character === "\\") { escaped = true; continue; }
		if (quote) { if (character === quote) quote = null; continue; }
		if (character === '"' || character === "'") quote = character;
		else if (character === "#") return line.slice(0, index);
	}
	if (quote) throw new Error("unterminated TOML string");
	return line;
}

function parseKeyPart(part) {
	const trimmed = part.trim();
	if (BARE_KEY.test(trimmed)) return assertSafeKey(trimmed, trimmed);
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) return assertSafeKey(JSON.parse(trimmed), trimmed);
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return assertSafeKey(trimmed.slice(1, -1), trimmed);
	throw new Error(`unsupported TOML key: ${trimmed}`);
}

function parseKey(key) {
	return splitOutside(key, ".").map(parseKeyPart);
}

function parseTomlValue(raw) {
	const value = raw.trim();
	if (!value) throw new Error("missing TOML value");
	if (value.startsWith('"')) return JSON.parse(value);
	if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^[+-]?[0-9][0-9_]*$/.test(value)) return Number(value.replaceAll("_", ""));
	if (/^[+-]?(?:[0-9][0-9_]*)?\.[0-9][0-9_]*(?:[eE][+-]?[0-9_]+)?$/.test(value)) return Number(value.replaceAll("_", ""));
	if (value.startsWith("[") && value.endsWith("]")) {
		const body = value.slice(1, -1).trim();
		return body ? splitOutside(body, ",").map(parseTomlValue) : [];
	}
	if (value.startsWith("{") && value.endsWith("}")) {
		const result = {};
		const body = value.slice(1, -1).trim();
		for (const field of body ? splitOutside(body, ",") : []) {
			const [key, fieldValue] = splitAssignment(field);
			setPath(result, parseKey(key), parseTomlValue(fieldValue));
		}
		return result;
	}
	// Date/time literals are retained as typed lexical values rather than guessed.
	if (/^\d{4}-\d\d-\d\d(?:[Tt ].*)?$/.test(value) || /^\d\d:\d\d:\d\d/.test(value)) {
		return { $tomlLiteral: value };
	}
	throw new Error(`unsupported TOML value: ${value}`);
}

function splitAssignment(line) {
	const parts = splitOutside(line, "=");
	if (parts.length < 2) throw new Error(`invalid TOML assignment: ${line}`);
	return [parts.shift(), parts.join("=")];
}

function setPath(root, keys, value) {
	let cursor = root;
	for (const key of keys.slice(0, -1)) {
		if (!Object.hasOwn(cursor, key)) cursor[key] = {};
		if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key]) || Object.hasOwn(cursor[key], "$tomlLiteral")) {
			throw new Error(`TOML key conflicts with a value: ${keys.join(".")}`);
		}
		cursor = cursor[key];
	}
	const final = keys.at(-1);
	if (Object.hasOwn(cursor, final)) throw new Error(`duplicate TOML key: ${keys.join(".")}`);
	cursor[final] = value;
}

export function parseToml(text) {
	if (typeof text !== "string") throw new Error("TOML input must be text");
	const root = {};
	let table = [];
	for (const original of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = stripComment(original).trim();
		if (!line) continue;
		if (line.startsWith("[[")) throw new Error("array-of-tables TOML is not supported for managed config");
		if (line.startsWith("[") && line.endsWith("]")) {
			table = parseKey(line.slice(1, -1));
			let cursor = root;
			for (const key of table) {
				if (!Object.hasOwn(cursor, key)) cursor[key] = {};
				if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) throw new Error(`TOML table conflicts with a value: ${table.join(".")}`);
				cursor = cursor[key];
			}
			continue;
		}
		const [key, value] = splitAssignment(line);
		setPath(root, [...table, ...parseKey(key)], parseTomlValue(value));
	}
	return root;
}

function quoteKey(key) {
	return BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function formatTomlValue(value) {
	if (value && typeof value === "object" && Object.keys(value).length === 1 && Object.hasOwn(value, "$tomlLiteral")) return value.$tomlLiteral;
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
	if (value && typeof value === "object") {
		return `{ ${Object.entries(value).map(([key, child]) => `${quoteKey(key)} = ${formatTomlValue(child)}`).join(", ")} }`;
	}
	throw new Error("unsupported value while serializing TOML");
}

export function stringifyToml(value) {
	const lines = [];
	const emit = (object, prefix) => {
		const scalars = Object.entries(object).filter(([, child]) => !child || typeof child !== "object" || Array.isArray(child) || Object.hasOwn(child, "$tomlLiteral"));
		const tables = Object.entries(object).filter(([, child]) => child && typeof child === "object" && !Array.isArray(child) && !Object.hasOwn(child, "$tomlLiteral"));
		if (prefix.length) {
			if (lines.length) lines.push("");
			lines.push(`[${prefix.map(quoteKey).join(".")}]`);
		}
		for (const [key, child] of scalars) lines.push(`${quoteKey(key)} = ${formatTomlValue(child)}`);
		for (const [key, child] of tables) emit(child, [...prefix, key]);
	};
	emit(value, []);
	return `${lines.join("\n")}\n`;
}

export function parseConfig(kind, contents, label) {
	try {
		if (kind === "json-merge") {
			const parsed = JSON.parse(contents);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
			assertSafeObjectKeys(parsed);
			return parsed;
		}
		if (kind === "toml-merge") return parseToml(contents);
	} catch (error) {
		throw new Error(`${label} is not valid supported ${kind === "toml-merge" ? "TOML" : "JSON"}: ${error.message}`);
	}
	throw new Error(`unsupported config merge kind: ${kind}`);
}

export function serializeConfig(kind, value) {
	return kind === "json-merge" ? `${JSON.stringify(value, null, 2)}\n` : stringifyToml(value);
}

function clone(value) {
	return structuredClone(value);
}

function validateManagedPath(path, label) {
	if (!Array.isArray(path) || path.length === 0 || path.some((key) => typeof key !== "string" || key.length === 0)) {
		throw new Error(`${label} has an invalid path`);
	}
	for (const key of path) assertSafeKey(key, path.join("."));
	return path;
}

function pathKey(path) {
	return JSON.stringify(path);
}

function valueAt(root, keys) {
	let cursor = root;
	for (const key of keys) {
		if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) || !Object.hasOwn(cursor, key)) {
			return { present: false };
		}
		cursor = cursor[key];
	}
	return { present: true, value: cursor };
}

function deletePath(root, keys) {
	let cursor = root;
	for (const key of keys.slice(0, -1)) cursor = cursor[key];
	delete cursor[keys.at(-1)];
	for (let depth = keys.length - 1; depth > 0; depth -= 1) {
		let parent = root;
		for (const key of keys.slice(0, depth - 1)) parent = parent[key];
		const key = keys[depth - 1];
		if (parent[key] && typeof parent[key] === "object" && !Array.isArray(parent[key]) && Object.keys(parent[key]).length === 0) {
			delete parent[key];
		}
	}
}

function setManagedPath(root, keys, value) {
	let cursor = root;
	for (const key of keys.slice(0, -1)) {
		if (!Object.hasOwn(cursor, key)) cursor[key] = {};
		if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key]) || Object.hasOwn(cursor[key], "$tomlLiteral")) {
			throw new Error(`managed config conflicts with user value at ${keys.join(".")}`);
		}
		cursor = cursor[key];
	}
	cursor[keys.at(-1)] = clone(value);
}

export function deepEqual(left, right) {
	if (Object.is(left, right)) return true;
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
	}
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return deepEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqual(left[key], right[key]));
}

export function validateManagedPaths(managedPaths, label = "managed config paths") {
	if (!Array.isArray(managedPaths)) throw new Error(`${label} must be an array`);
	const paths = new Map();
	for (const entry of managedPaths) {
		if (!entry || typeof entry !== "object" || !Object.hasOwn(entry, "value")) throw new Error(`${label} contains an invalid entry`);
		validateManagedPath(entry.path, label);
		assertSafeObjectKeys(entry.value, entry.path);
		const key = pathKey(entry.path);
		if (paths.has(key)) throw new Error(`${label} contains a duplicate path`);
		paths.set(key, entry.path);
	}
	for (const candidate of paths.values()) {
		for (let depth = 1; depth < candidate.length; depth += 1) {
			if (paths.has(pathKey(candidate.slice(0, depth)))) throw new Error(`${label} contains overlapping paths`);
		}
	}
	return managedPaths;
}

function managedPathMap(managedPaths, label) {
	validateManagedPaths(managedPaths, label);
	return new Map(managedPaths.map((entry) => [pathKey(entry.path), entry]));
}

export function createManagedRollbackDelta(before, after, beforeManagedPaths, afterManagedPaths) {
	const beforePaths = managedPathMap(beforeManagedPaths, "previous managed config paths");
	const afterPaths = managedPathMap(afterManagedPaths, "next managed config paths");
	const keys = new Set([...beforePaths.keys(), ...afterPaths.keys()]);
	const delta = [];
	for (const key of keys) {
		const managedBefore = beforePaths.get(key);
		const managedAfter = afterPaths.get(key);
		const path = clone((managedBefore ?? managedAfter).path);
		const actualBefore = valueAt(before, path);
		const actualAfter = valueAt(after, path);
		const knownBefore = managedBefore ?? managedAfter;
		if (actualBefore.present && !deepEqual(actualBefore.value, knownBefore.value)) {
			throw new Error(`refusing to retain unknown config value at ${path.join(".")}`);
		}
		if (actualAfter.present && (!managedAfter || !deepEqual(actualAfter.value, managedAfter.value))) {
			throw new Error(`next managed config value is inconsistent at ${path.join(".")}`);
		}
		delta.push({
			path,
			before: actualBefore.present ? { present: true, value: clone(knownBefore.value) } : { present: false },
			after: actualAfter.present ? { present: true, value: clone(managedAfter.value) } : { present: false },
		});
	}
	return validateManagedRollbackDelta(delta);
}

export function validateManagedRollbackDelta(delta) {
	if (!Array.isArray(delta)) throw new Error("managed rollback delta must be an array");
	const paths = [];
	const seen = new Set();
	for (const entry of delta) {
		if (!entry || typeof entry !== "object") throw new Error("managed rollback delta contains an invalid entry");
		validateManagedPath(entry.path, "managed rollback delta");
		const key = pathKey(entry.path);
		if (seen.has(key)) throw new Error("managed rollback delta contains a duplicate path");
		seen.add(key);
		paths.push(entry.path);
		for (const side of ["before", "after"]) {
			const snapshot = entry[side];
			if (!snapshot || typeof snapshot !== "object" || typeof snapshot.present !== "boolean") {
				throw new Error(`managed rollback delta has invalid ${side} metadata`);
			}
			if (snapshot.present !== Object.hasOwn(snapshot, "value")) {
				throw new Error(`managed rollback delta has inconsistent ${side} metadata`);
			}
			if (snapshot.present) assertSafeObjectKeys(snapshot.value, entry.path);
		}
	}
	for (const candidate of paths) {
		for (let depth = 1; depth < candidate.length; depth += 1) {
			if (seen.has(pathKey(candidate.slice(0, depth)))) throw new Error("managed rollback delta contains overlapping paths");
		}
	}
	return delta;
}

export function restoreManagedRollbackDelta(current, delta) {
	validateManagedRollbackDelta(delta);
	const result = clone(current);
	for (const entry of delta) {
		const actual = valueAt(result, entry.path);
		if (actual.present !== entry.after.present || (actual.present && !deepEqual(actual.value, entry.after.value))) {
			throw new Error(`managed config value drifted at ${entry.path.join(".")}`);
		}
	}
	for (const entry of [...delta].sort((left, right) => right.path.length - left.path.length)) {
		if (!entry.before.present && entry.after.present) deletePath(result, entry.path);
	}
	for (const entry of [...delta].sort((left, right) => left.path.length - right.path.length)) {
		if (entry.before.present) setManagedPath(result, entry.path, entry.before.value);
	}
	return result;
}

export function mergeManaged(current, fragment, { allowEqual = true } = {}) {
	const result = clone(current);
	const paths = [];
	const walk = (target, patch, prefix) => {
		for (const [key, value] of Object.entries(patch)) {
			const keyPath = [...prefix, key];
			if (value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "$tomlLiteral")) {
				if (!Object.hasOwn(target, key)) target[key] = {};
				if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key]) || Object.hasOwn(target[key], "$tomlLiteral")) {
					throw new Error(`managed config conflicts with user value at ${keyPath.join(".")}`);
				}
				walk(target[key], value, keyPath);
			} else if (!Object.hasOwn(target, key)) {
				target[key] = clone(value);
				paths.push({ path: keyPath, value: clone(value) });
			} else if (allowEqual && deepEqual(target[key], value)) {
				paths.push({ path: keyPath, value: clone(value) });
			} else {
				throw new Error(`managed config conflicts with user value at ${keyPath.join(".")}`);
			}
		}
	};
	walk(result, fragment, []);
	return { value: result, paths };
}

export function removeManaged(current, managedPaths) {
	validateManagedPaths(managedPaths);
	const result = clone(current);
	for (const entry of [...managedPaths].sort((a, b) => b.path.length - a.path.length)) {
		let cursor = result;
		for (const key of entry.path.slice(0, -1)) cursor = cursor?.[key];
		const final = entry.path.at(-1);
		if (!cursor || !Object.hasOwn(cursor, final) || !deepEqual(cursor[final], entry.value)) {
			throw new Error(`managed config value drifted at ${entry.path.join(".")}`);
		}
		delete cursor[final];
		for (let depth = entry.path.length - 1; depth > 0; depth -= 1) {
			let parent = result;
			for (const key of entry.path.slice(0, depth - 1)) parent = parent[key];
			const key = entry.path[depth - 1];
			if (parent[key] && Object.keys(parent[key]).length === 0) delete parent[key];
		}
	}
	return result;
}
