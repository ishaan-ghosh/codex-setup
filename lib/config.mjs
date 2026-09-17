import crypto from "node:crypto";

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DISPLACED_ENTRIES = 64;
const MAX_DISPLACED_VALUE_BYTES = 4096;
const MAX_DISPLACED_TOTAL_BYTES = 32768;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const TOML_LITERAL_KEY = "$tomlLiteral";
const TOML_INT64_MIN = -(2n ** 63n);
const TOML_INT64_MAX = (2n ** 63n) - 1n;
const TOML_DECIMAL_INTEGER = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/;
const TOML_FLOAT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:(?:\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?|(?:[eE][+-]?[0-9](?:_?[0-9])*))$/;
const TOML_LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TOML_LOCAL_TIME = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/;
const TOML_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:(?:[Zz])|(?:[+-](\d{2}):(\d{2})))?$/;

function hasTomlLiteralMarker(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, TOML_LITERAL_KEY));
}

function parseTomlInteger(value) {
	const integer = BigInt(value.replaceAll("_", ""));
	if (integer < TOML_INT64_MIN || integer > TOML_INT64_MAX) throw new Error("TOML integer is outside the signed 64-bit range");
	return integer;
}

function validTomlDate(year, month, day) {
	const numericYear = Number(year);
	const numericMonth = Number(month);
	const numericDay = Number(day);
	const leap = numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0);
	const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	return numericMonth >= 1 && numericMonth <= 12 && numericDay >= 1 && numericDay <= days[numericMonth - 1];
}

function validTomlTime(hour, minute, second) {
	return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

function validTomlDateTimeLiteral(value) {
	let match = TOML_LOCAL_DATE.exec(value);
	if (match) return validTomlDate(match[1], match[2], match[3]);
	match = TOML_LOCAL_TIME.exec(value);
	if (match) return validTomlTime(match[1], match[2], match[3]);
	match = TOML_DATE_TIME.exec(value);
	return Boolean(match
		&& validTomlDate(match[1], match[2], match[3])
		&& validTomlTime(match[4], match[5], match[6])
		&& (match[7] === undefined || (Number(match[7]) <= 23 && Number(match[8]) <= 59)));
}

function validateTomlLiteral(value) {
	if (!hasTomlLiteralMarker(value) || Object.keys(value).length !== 1 || typeof value[TOML_LITERAL_KEY] !== "string") {
		throw new Error("invalid internal TOML literal marker");
	}
	const literal = value[TOML_LITERAL_KEY];
	if (literal.includes("\n") || literal.includes("\r")) throw new Error("invalid internal TOML literal marker");
	if (validTomlDateTimeLiteral(literal)) return literal;
	if (TOML_FLOAT.test(literal)) return literal;
	if (TOML_DECIMAL_INTEGER.test(literal)) {
		const integer = parseTomlInteger(literal);
		if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) return literal;
	}
	throw new Error("invalid internal TOML literal marker");
}

function tomlLiteral(value) {
	const literal = { [TOML_LITERAL_KEY]: value };
	validateTomlLiteral(literal);
	return literal;
}

function assertSafeKey(key, context) {
	if (key === TOML_LITERAL_KEY) throw new Error(`reserved config key at ${context}`);
	if (FORBIDDEN_KEYS.has(key)) throw new Error(`unsafe config key at ${context}`);
	return key;
}

function assertSafeObjectKeys(value, prefix = [], { allowTomlLiterals = false } = {}) {
	if (!value || typeof value !== "object") return;
	if (hasTomlLiteralMarker(value)) {
		if (!allowTomlLiterals) throw new Error(`reserved config key at ${[...prefix, TOML_LITERAL_KEY].join(".")}`);
		validateTomlLiteral(value);
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		assertSafeKey(key, [...prefix, key].join("."));
		assertSafeObjectKeys(child, [...prefix, key], { allowTomlLiterals });
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
	if (TOML_DECIMAL_INTEGER.test(value)) {
		const normalized = value.replaceAll("_", "");
		const integer = parseTomlInteger(value);
		if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) {
			return tomlLiteral(value);
		}
		return Number(normalized);
	}
	if (TOML_FLOAT.test(value)) return tomlLiteral(value);
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
	if (validTomlDateTimeLiteral(value)) return tomlLiteral(value);
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
		if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key]) || hasTomlLiteralMarker(cursor[key])) {
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
				if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key]) || hasTomlLiteralMarker(cursor[key])) {
					throw new Error(`TOML table conflicts with a value: ${table.join(".")}`);
				}
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
	if (hasTomlLiteralMarker(value)) return validateTomlLiteral(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map(formatTomlValue).join(", ")}]`;
	if (value && typeof value === "object") {
		return `{ ${Object.entries(value).map(([key, child]) => `${quoteKey(key)} = ${formatTomlValue(child)}`).join(", ")} }`;
	}
	throw new Error("unsupported value while serializing TOML");
}

export function stringifyToml(value) {
	if (hasTomlLiteralMarker(value)) throw new Error("TOML root cannot be an internal literal");
	assertSafeObjectKeys(value, [], { allowTomlLiterals: true });
	const scalarValue = (child) => {
		if (!child || typeof child !== "object" || Array.isArray(child)) return true;
		if (hasTomlLiteralMarker(child)) { validateTomlLiteral(child); return true; }
		return false;
	};
	const lines = [];
	const emit = (object, prefix) => {
		const scalars = Object.entries(object).filter(([, child]) => scalarValue(child));
		const tables = Object.entries(object).filter(([, child]) => !scalarValue(child));
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
	} catch {
		throw new Error(`${label} is not valid supported ${kind === "toml-merge" ? "TOML" : "JSON"}`);
	}
	throw new Error(`unsupported config merge kind: ${kind}`);
}

export function serializeConfig(kind, value) {
	if (kind === "json-merge") {
		assertSafeObjectKeys(value);
		return `${JSON.stringify(value, null, 2)}\n`;
	}
	return stringifyToml(value);
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


function displacedValueBytes(value) {
	return Buffer.from(JSON.stringify(value));
}

const MIGRATABLE_SCALAR_TYPES = new Map([
	[["approval_policy"], (value) => typeof value === "string"],
	[["approvals_reviewer"], (value) => typeof value === "string"],
	[["model"], (value) => typeof value === "string"],
	[["model_reasoning_effort"], (value) => typeof value === "string"],
	[["plan_mode_reasoning_effort"], (value) => typeof value === "string"],
	[["review_model"], (value) => typeof value === "string"],
	[["check_for_update_on_startup"], (value) => typeof value === "boolean"],
	[["features", "memories"], (value) => typeof value === "boolean"],
	[["features", "multi_agent"], (value) => typeof value === "boolean"],
	[["memories", "generate_memories"], (value) => typeof value === "boolean"],
	[["memories", "use_memories"], (value) => typeof value === "boolean"],
	[["memories", "disable_on_external_context"], (value) => typeof value === "boolean"],
	[["agents", "enabled"], (value) => typeof value === "boolean"],
	[["agents", "max_concurrent_threads_per_session"], (value) => Number.isSafeInteger(value) && value >= 1],
	[["agents", "default_subagent_model"], (value) => typeof value === "string"],
	[["agents", "default_subagent_reasoning_effort"], (value) => typeof value === "string"],
].map(([path, predicate]) => [pathKey(path), predicate]));

function migratableScalar(path, value) {
	const predicate = MIGRATABLE_SCALAR_TYPES.get(pathKey(path));
	return predicate ? predicate(value) : false;
}

function makeDisplacedValue(path, value) {
	const bytes = displacedValueBytes(value);
	return {
		path: clone(path), value: clone(value), byteLength: bytes.length,
		sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
	};
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
}

function setManagedPath(root, keys, value) {
	let cursor = root;
	for (const key of keys.slice(0, -1)) {
		if (!Object.hasOwn(cursor, key)) cursor[key] = {};
		if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key]) || hasTomlLiteralMarker(cursor[key])) {
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
		assertSafeObjectKeys(entry.value, entry.path, { allowTomlLiterals: true });
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

export function validateManagedContainers(managedContainers, managedPaths, label = "managed config containers") {
	if (!Array.isArray(managedContainers)) throw new Error(`${label} must be an array`);
	validateManagedPaths(managedPaths, `${label} paths`);
	const seen = new Set();
	for (const container of managedContainers) {
		validateManagedPath(container, label);
		const key = pathKey(container);
		if (seen.has(key)) throw new Error(`${label} contains a duplicate path`);
		seen.add(key);
		const ownsDescendant = managedPaths.some((entry) => entry.path.length > container.length
			&& container.every((part, index) => entry.path[index] === part));
		if (!ownsDescendant) throw new Error(`${label} contains a path without a managed descendant`);
	}
	return managedContainers;
}

function pruneManagedContainers(root, managedContainers, managedPaths) {
	validateManagedContainers(managedContainers, managedPaths);
	for (const container of [...managedContainers].sort((left, right) => right.length - left.length)) {
		let parent = root;
		for (const key of container.slice(0, -1)) {
			if (!parent || typeof parent !== "object" || Array.isArray(parent) || !Object.hasOwn(parent, key)) {
				parent = null;
				break;
			}
			parent = parent[key];
		}
		if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
		const key = container.at(-1);
		if (parent[key] && typeof parent[key] === "object" && !Array.isArray(parent[key]) && Object.keys(parent[key]).length === 0) {
			delete parent[key];
		}
	}
	return root;
}

function managedPathMap(managedPaths, label) {
	validateManagedPaths(managedPaths, label);
	return new Map(managedPaths.map((entry) => [pathKey(entry.path), entry]));
}


export function validateDisplacedValues(displacedValues, managedPaths, label = "displaced managed config values") {
	if (!Array.isArray(displacedValues) || displacedValues.length === 0 || displacedValues.length > MAX_DISPLACED_ENTRIES) {
		throw new Error(`${label} must be a non-empty bounded array`);
	}
	const managed = managedPathMap(managedPaths, `${label} managed paths`);
	const seen = new Set();
	let totalBytes = 0;
	for (const entry of displacedValues) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)
			|| JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["byteLength", "path", "sha256", "value"])) {
			throw new Error(`${label} contains an invalid entry`);
		}
		validateManagedPath(entry.path, label);
		const key = pathKey(entry.path);
		if (seen.has(key)) throw new Error(`${label} contains a duplicate path`);
		seen.add(key);
		if (!managed.has(key)) throw new Error(`${label} contains a path outside managed config`);
		if (!migratableScalar(entry.path, entry.value) || !migratableScalar(entry.path, managed.get(key).value)) {
			throw new Error(`${label} contains a non-migratable path or value type`);
		}
		const bytes = displacedValueBytes(entry.value);
		if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength !== bytes.length || bytes.length > MAX_DISPLACED_VALUE_BYTES
			|| !HEX_SHA256.test(entry.sha256 ?? "") || crypto.createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
			throw new Error(`${label} contains invalid integrity metadata`);
		}
		totalBytes += bytes.length;
	}
	if (totalBytes > MAX_DISPLACED_TOTAL_BYTES) throw new Error(`${label} exceeds the total size limit`);
	return displacedValues;
}

export function restoreDisplacedValues(current, displacedValues, managedPaths) {
	if (!displacedValues?.length) return clone(current);
	validateDisplacedValues(displacedValues, managedPaths);
	const result = clone(current);
	for (const entry of displacedValues) {
		if (valueAt(result, entry.path).present) throw new Error(`cannot restore displaced managed config at ${entry.path.join(".")}`);
		setManagedPath(result, entry.path, entry.value);
	}
	return result;
}
export function createManagedRollbackDelta(before, after, beforeManagedPaths, afterManagedPaths, { displacedValues = [] } = {}) {
	const beforePaths = managedPathMap(beforeManagedPaths, "previous managed config paths");
	const afterPaths = managedPathMap(afterManagedPaths, "next managed config paths");
	const keys = new Set([...beforePaths.keys(), ...afterPaths.keys()]);
	const displaced = new Map();
	if (displacedValues.length) {
		const unionPaths = [...new Map([...beforeManagedPaths, ...afterManagedPaths].map((entry) => [pathKey(entry.path), entry])).values()];
		validateDisplacedValues(displacedValues, unionPaths, "rollback displaced managed config values");
		for (const entry of displacedValues) displaced.set(pathKey(entry.path), entry);
	}
	const delta = [];
	for (const key of keys) {
		const managedBefore = beforePaths.get(key);
		const managedAfter = afterPaths.get(key);
		const path = clone((managedBefore ?? managedAfter).path);
		const actualBefore = valueAt(before, path);
		const actualAfter = valueAt(after, path);
		const knownBefore = managedBefore ?? managedAfter;
		const displacedEntry = displaced.get(key);
		if (actualBefore.present && !deepEqual(actualBefore.value, knownBefore.value)
			&& (!displacedEntry || !deepEqual(actualBefore.value, displacedEntry.value))) {
			throw new Error(`refusing to retain unknown config value at ${path.join(".")}`);
		}
		if (actualAfter.present && ((!managedAfter || !deepEqual(actualAfter.value, managedAfter.value))
			&& (!displacedEntry || managedAfter || !deepEqual(actualAfter.value, displacedEntry.value)))) {
			throw new Error(`next managed config value is inconsistent at ${path.join(".")}`);
		}
		delta.push({
			path,
			before: actualBefore.present ? { present: true, value: clone(actualBefore.value) } : { present: false },
			after: actualAfter.present ? { present: true, value: clone(actualAfter.value) } : { present: false },
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
			if (snapshot.present) assertSafeObjectKeys(snapshot.value, entry.path, { allowTomlLiterals: true });
		}
	}
	for (const candidate of paths) {
		for (let depth = 1; depth < candidate.length; depth += 1) {
			if (seen.has(pathKey(candidate.slice(0, depth)))) throw new Error("managed rollback delta contains overlapping paths");
		}
	}
	return delta;
}

export function restoreManagedRollbackDelta(current, delta, { managedContainers = [], managedPaths = [] } = {}) {
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
	pruneManagedContainers(result, managedContainers, managedPaths);
	for (const entry of [...delta].sort((left, right) => left.path.length - right.path.length)) {
		if (entry.before.present) setManagedPath(result, entry.path, entry.before.value);
	}
	return result;
}

export function mergeManaged(current, fragment, { allowEqual = true, migrateConflicts = false } = {}) {
	assertSafeObjectKeys(current, [], { allowTomlLiterals: true });
	assertSafeObjectKeys(fragment, [], { allowTomlLiterals: true });
	if (Object.keys(fragment).length === 0) throw new Error("managed config must contain at least one leaf");
	const result = clone(current);
	const paths = [];
	const managedContainers = [];
	const displacedValues = [];
	const conflicts = [];
	const walk = (target, patch, prefix) => {
		for (const [key, value] of Object.entries(patch)) {
			const keyPath = [...prefix, key];
			if (value && typeof value === "object" && !Array.isArray(value) && !hasTomlLiteralMarker(value)) {
				if (Object.keys(value).length === 0) {
					throw new Error(`managed config contains an unrepresentable empty object at ${keyPath.join(".")}`);
				}
				if (!Object.hasOwn(target, key)) {
					target[key] = {};
					managedContainers.push(keyPath);
				}
				if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key]) || hasTomlLiteralMarker(target[key])) {
					conflicts.push(keyPath);
					continue;
				}
				walk(target[key], value, keyPath);
			} else if (!Object.hasOwn(target, key)) {
				target[key] = clone(value);
				paths.push({ path: keyPath, value: clone(value) });
			} else if (allowEqual && deepEqual(target[key], value)) {
				paths.push({ path: keyPath, value: clone(value) });
			} else if (migrateConflicts && migratableScalar(keyPath, target[key]) && migratableScalar(keyPath, value)) {
				displacedValues.push(makeDisplacedValue(keyPath, target[key]));
				target[key] = clone(value);
				paths.push({ path: keyPath, value: clone(value) });
			} else {
				conflicts.push(keyPath);
			}
		}
	};
	walk(result, fragment, []);
	if (conflicts.length) throw new Error(`managed config conflicts with user value at ${conflicts.map((entry) => entry.join(".")).join(", ")}`);
	if (displacedValues.length) validateDisplacedValues(displacedValues, paths);
	validateManagedContainers(managedContainers, paths);
	return { value: result, paths, managedContainers, displacedValues };
}

export function removeManaged(current, managedPaths, managedContainers = []) {
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
	}
	return pruneManagedContainers(result, managedContainers, managedPaths);
}
