import assert from "node:assert/strict";
import test from "node:test";
import {
	deepEqual, mergeManaged, parseConfig, parseToml, removeManaged, restoreDisplacedValues,
	stringifyToml, validateDisplacedValues,
} from "../../lib/config.mjs";

test("TOML parsing and serialization are structural", () => {
	const parsed = parseToml(`model = "gpt-5"\n\n[features]\nweb = true\nlist = ["a", "b"]\n`);
	assert.deepEqual(parsed, { model: "gpt-5", features: { web: true, list: ["a", "b"] } });
	assert.deepEqual(parseToml(stringifyToml(parsed)), parsed);
});

test("managed merge preserves unknown values and fails closed on conflicts", () => {
	const current = { model: "user-choice", features: { retained: true } };
	const fragment = { features: { managed: true } };
	const merged = mergeManaged(current, fragment, { allowEqual: false });
	assert.deepEqual(merged.value, { model: "user-choice", features: { retained: true, managed: true } });
	assert.deepEqual(removeManaged(merged.value, merged.paths), current);
	assert.throws(() => mergeManaged(current, { model: "setup-choice" }), /conflicts with user value at model/);
});

test("TOML parser rejects ambiguous constructs rather than regex editing", () => {
	assert.throws(() => parseToml("[[servers]]\nname = 'x'\n"), /array-of-tables/);
	assert.throws(() => parseToml("value = [\n  1,\n  2\n]\n"), /unbalanced|unsupported/);
	assert.equal(deepEqual({ x: [1, 2] }, { x: [1, 2] }), true);
});


test("config parsers reject prototype-polluting keys", () => {
	assert.throws(() => parseConfig("json-merge", '{"__proto__":{"polluted":true}}', "fragment"), /not valid supported JSON/);
	assert.throws(() => parseToml('["__proto__"]\npolluted = true\n'), /unsafe config key/);
	assert.equal({}.polluted, undefined);
});

test("managed conflict migration is structural, allowlisted, typed, and integrity checked", () => {
	for (const [kind, currentText, fragmentText] of [
		["json-merge", '{"model":"private-choice","features":{"memories":false}}', '{"model":"managed-choice","features":{"memories":true}}'],
		["toml-merge", 'model = "private-choice"\n[features]\nmemories = false\n', 'model = "managed-choice"\n[features]\nmemories = true\n'],
	]) {
		const current = parseConfig(kind, currentText, "current");
		const fragment = parseConfig(kind, fragmentText, "fragment");
		assert.throws(() => mergeManaged(current, fragment), /model, features.memories/);
		const migrated = mergeManaged(current, fragment, { migrateConflicts: true });
		assert.deepEqual(migrated.value, { model: "managed-choice", features: { memories: true } });
		assert.deepEqual(migrated.displacedValues.map((entry) => [entry.path.join("."), entry.value]), [
			["model", "private-choice"], ["features.memories", false],
		]);
		validateDisplacedValues(migrated.displacedValues, migrated.paths);
		const invalidManagedPaths = structuredClone(migrated.paths);
		invalidManagedPaths.find((entry) => entry.path.join(".") === "model").value = 42;
		assert.throws(() => validateDisplacedValues(migrated.displacedValues, invalidManagedPaths), /non-migratable path or value type/);
		const stripped = removeManaged(migrated.value, migrated.paths);
		assert.deepEqual(restoreDisplacedValues(stripped, migrated.displacedValues, migrated.paths), current);
		const tampered = structuredClone(migrated.displacedValues);
		tampered[0].byteLength += 1;
		assert.throws(() => validateDisplacedValues(tampered, migrated.paths), /integrity metadata/);
	}
});

test("executable and credential-capable MCP settings are not migratable", () => {
	const current = { mcp_servers: { playwright: { command: "private-command", args: ["private-arg"] } } };
	const fragment = { mcp_servers: { playwright: { command: "managed-command", args: ["managed-arg"] } } };
	assert.throws(() => mergeManaged(current, fragment, { migrateConflicts: true }), /mcp_servers.playwright.command, mcp_servers.playwright.args/);
});

test("executable-capable hook enablement is not migratable", () => {
	assert.throws(
		() => mergeManaged({ features: { hooks: false } }, { features: { hooks: true } }, { migrateConflicts: true }),
		/features.hooks/,
	);
});

test("managed conflict migration enforces the value type for each allowlisted path", () => {
	for (const [current, fragment, conflict] of [
		[{ model: 7 }, { model: "managed" }, /model/],
		[{ check_for_update_on_startup: "yes" }, { check_for_update_on_startup: false }, /check_for_update_on_startup/],
		[{ features: { memories: 1 } }, { features: { memories: true } }, /features.memories/],
		[{ memories: { use_memories: 1 } }, { memories: { use_memories: true } }, /memories.use_memories/],
		[{ agents: { enabled: 1 } }, { agents: { enabled: true } }, /agents.enabled/],
		[{ agents: { max_concurrent_threads_per_session: true } }, { agents: { max_concurrent_threads_per_session: 3 } }, /agents.max_concurrent_threads_per_session/],
	]) {
		assert.throws(() => mergeManaged(current, fragment, { migrateConflicts: true }), conflict);
	}
	assert.throws(
		() => mergeManaged({ features: { future_toggle: false } }, { features: { future_toggle: true } }, { migrateConflicts: true }),
		/features.future_toggle/,
	);
	assert.throws(
		() => mergeManaged({ memories: { private_flag: false } }, { memories: { private_flag: true } }, { migrateConflicts: true }),
		/memories.private_flag/,
	);
});
