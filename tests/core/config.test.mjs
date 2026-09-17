import assert from "node:assert/strict";
import test from "node:test";
import {
	deepEqual, mergeManaged, parseConfig, parseToml, removeManaged, restoreDisplacedValues,
	stringifyToml, validateDisplacedValues, validateManagedContainers,
} from "../../lib/config.mjs";

test("TOML parsing and serialization are structural", () => {
	const parsed = parseToml(`model = "gpt-5"\n\n[features]\nweb = true\nlist = ["a", "b"]\n`);
	assert.deepEqual(parsed, { model: "gpt-5", features: { web: true, list: ["a", "b"] } });
	assert.deepEqual(parseToml(stringifyToml(parsed)), parsed);
});

test("TOML integers outside the JavaScript safe range retain their exact valid lexemes", () => {
	const source = "positive = 9_007_199_254_740_993\nnegative = -9007199254740993\n";
	const parsed = parseToml(source);
	assert.equal(stringifyToml(parsed), source);
	assert.deepEqual(parseToml(stringifyToml(parsed)), parsed);
	assert.throws(() => parseToml("too_large = 9223372036854775808\n"), /signed 64-bit range/);
	assert.throws(() => parseToml("too_small = -9223372036854775809\n"), /signed 64-bit range/);
});

test("the internal TOML literal marker is reserved and strictly validated", () => {
	for (const source of [
		'user = { "$tomlLiteral" = "true" }\n',
		'user = { nested = { "$tomlLiteral" = "true" } }\n',
		'user = [{ "$tomlLiteral" = "true" }]\n',
		'["$tomlLiteral"]\nvalue = true\n',
	]) {
		assert.throws(() => parseToml(source), /reserved config key/);
	}
	assert.throws(
		() => parseConfig("json-merge", '{"user":{"$tomlLiteral":"true"}}', "existing config"),
		/not valid supported JSON/,
	);

	const nested = parseToml("values = [1979-05-27T07:32:00Z, 07:32:00, 9_007_199_254_740_993, -0.0, 1.0e999, 5e+22]\nmetadata = { when = 1979-05-27, count = -9007199254740993 }\n");
	const rendered = stringifyToml(nested);
	assert.deepEqual(parseToml(rendered), nested);
	assert.match(rendered, /9_007_199_254_740_993/);
	assert.match(rendered, /1979-05-27T07:32:00Z/);
	assert.match(rendered, /-0\.0/);
	assert.match(rendered, /1\.0e999/);
	assert.match(rendered, /5e\+22/);

	for (const marker of [
		{ $tomlLiteral: "true" },
		{ $tomlLiteral: "true\ninjected = true" },
		{ $tomlLiteral: 42 },
		{ $tomlLiteral: "1979-05-27", extra: true },
		{ $tomlLiteral: "9_007__199_254_740_993" },
		{ $tomlLiteral: "1979-99-99T99:99:99Z" },
		{ $tomlLiteral: "23:59:60" },
		{ $tomlLiteral: "1979-05-27T23:59:60" },
		{ $tomlLiteral: "1979-05-27T23:59:60Z" },
		{ $tomlLiteral: "1979-05-27T23:59:60+07:00" },
	]) {
		assert.throws(() => stringifyToml({ user: marker }), /invalid internal TOML literal marker/);
	}
	assert.throws(() => parseToml("invalid = 9_007__199_254_740_993\n"), /unsupported TOML value/);
	assert.throws(() => parseToml("invalid = 1.0e9__9\n"), /unsupported TOML value/);
	assert.throws(() => parseToml("invalid = 1979-99-99T99:99:99Z\n"), /unsupported TOML value/);
	for (const value of ["23:59:60", "1979-05-27T23:59:60", "1979-05-27T23:59:60Z", "1979-05-27T23:59:60+07:00"]) {
		assert.throws(() => parseToml(`invalid = ${value}\n`), /unsupported TOML value/);
	}
	assert.throws(() => parseToml("value = 9_007_199_254_740_993\n[value]\nnested = true\n"), /table conflicts with a value/);
});

test("managed merge preserves unknown values and fails closed on conflicts", () => {
	const current = { model: "user-choice", features: { retained: true }, user_empty: {} };
	const fragment = { features: { managed: true } };
	const merged = mergeManaged(current, fragment, { allowEqual: false });
	assert.deepEqual(merged.value, { model: "user-choice", features: { retained: true, managed: true }, user_empty: {} });
	assert.deepEqual(removeManaged(merged.value, merged.paths), current);
	assert.throws(() => mergeManaged(current, { model: "setup-choice" }), /conflicts with user value at model/);
	assert.throws(() => mergeManaged(current, { managed_empty: {} }), /unrepresentable empty object at managed_empty/);
	assert.throws(() => mergeManaged(current, { managed: { nested_empty: {} } }), /unrepresentable empty object at managed.nested_empty/);
	assert.throws(() => mergeManaged(current, {}), /must contain at least one leaf/);
});

test("managed container ownership prunes only containers created by the merge", () => {
	const fragment = { features: { memories: true } };
	const created = mergeManaged({}, fragment);
	assert.deepEqual(created.managedContainers, [["features"]]);
	assert.deepEqual(removeManaged(created.value, created.paths, created.managedContainers), {});

	const preexisting = mergeManaged({ features: {} }, fragment);
	assert.deepEqual(preexisting.managedContainers, []);
	assert.deepEqual(removeManaged(preexisting.value, preexisting.paths, preexisting.managedContainers), { features: {} });
	assert.throws(() => validateManagedContainers([["unrelated"]], preexisting.paths), /without a managed descendant/);
	assert.throws(() => validateManagedContainers([["features"], ["features"]], preexisting.paths), /duplicate path/);
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
