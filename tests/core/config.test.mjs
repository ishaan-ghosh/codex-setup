import assert from "node:assert/strict";
import test from "node:test";
import { deepEqual, mergeManaged, parseConfig, parseToml, removeManaged, stringifyToml } from "../../lib/config.mjs";

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
	assert.throws(() => parseConfig("json-merge", '{"__proto__":{"polluted":true}}', "fragment"), /unsafe config key/);
	assert.throws(() => parseToml('["__proto__"]\npolluted = true\n'), /unsafe config key/);
	assert.equal({}.polluted, undefined);
});
