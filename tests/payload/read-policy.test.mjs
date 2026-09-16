import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const hook = join(import.meta.dirname, "../../payload/hooks/read-policy.mjs");

function newState() {
	return mkdtempSync(join(tmpdir(), "codex-read-policy-test-"));
}

function run(input, env = {}, state = newState()) {
	const result = spawnSync(process.execPath, [hook], {
		input: JSON.stringify(input),
		encoding: "utf8",
		env: { ...process.env, CODEX_READ_POLICY_STATE_DIR: state, ...env },
	});
	assert.equal(result.status, 0, result.stderr);
	return { output: JSON.parse(result.stdout || "{}"), state };
}

function prompt(prompt = "inspect the code") {
	return { hook_event_name: "UserPromptSubmit", session_id: "s", turn_id: "t", prompt_text: prompt };
}

function read(extra = {}) {
	return { hook_event_name: "PreToolUse", session_id: "s", turn_id: "t", tool_name: "Read", tool_input: { file_path: "x.txt", ...extra } };
}

test("warns on an unbounded structured read and stores only boolean turn state", () => {
	const state = newState();
	assert.deepEqual(run(prompt(), {}, state).output, {});
	const result = run(read(), { CODEX_READ_POLICY_MODE: "warn" }, state);
	assert.equal(result.output.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.match(result.output.hookSpecificOutput.additionalContext, /Grep\/Glob/);
	const files = readdirSync(result.state);
	assert.equal(files.length, 1);
	assert.deepEqual(JSON.parse(readFileSync(join(result.state, files[0]), "utf8")), { allowFull: false, searchUsed: false });
	assert.equal(statSync(join(result.state, files[0])).mode & 0o777, 0o600);
});

test("search tools unlock later structured reads", () => {
	const state = newState();
	run(prompt(), {}, state);
	const search = run({ ...read(), tool_name: "Grep", tool_input: { pattern: "needle", path: "." } }, {}, state);
	assert.deepEqual(search.output, {});
	const later = run(read(), {}, state);
	assert.deepEqual(later.output, {});
});

test("deny blocks and ask explains the Codex limitation", () => {
	const state = newState();
	run(prompt(), {}, state);
	const denied = run(read(), { CODEX_READ_POLICY_MODE: "deny" }, state);
	assert.equal(denied.output.hookSpecificOutput.permissionDecision, "deny");
	run(prompt(), {}, state);
	const asked = run(read(), { CODEX_READ_POLICY_MODE: "ask" }, state);
	assert.equal(asked.output.hookSpecificOutput.permissionDecision, "deny");
	assert.match(asked.output.hookSpecificOutput.permissionDecisionReason, /cannot emit permissionDecision=ask/);
	assert.match(asked.output.hookSpecificOutput.permissionDecisionReason, /request approval/i);
});

test("compound Bash reads cannot be masked by a search or another bounded segment", () => {
	const piped = run({ hook_event_name: "PreToolUse", session_id: "compound-1", turn_id: "t", tool_name: "Bash", tool_input: { command: "cat src/file.ts | rg needle" } }, { CODEX_READ_POLICY_MODE: "deny" }, newState());
	assert.equal(piped.output.hookSpecificOutput.permissionDecision, "deny");
	const later = run({ hook_event_name: "PreToolUse", session_id: "compound-2", turn_id: "t", tool_name: "Bash", tool_input: { command: "rg needle src; cat src/other.ts" } }, { CODEX_READ_POLICY_MODE: "deny" }, newState());
	assert.equal(later.output.hookSpecificOutput.permissionDecision, "deny");
	const bounded = run({ hook_event_name: "PreToolUse", session_id: "compound-3", turn_id: "t", tool_name: "Bash", tool_input: { command: "sed -n '1,10p' src/file.ts | rg needle" } }, { CODEX_READ_POLICY_MODE: "deny" }, newState());
	assert.deepEqual(bounded.output, {});
});

test("Bash searches unlock reads and bounded shell reads pass", () => {
	const state = newState();
	run(prompt(), {}, state);
	const search = run({ hook_event_name: "PreToolUse", session_id: "s", turn_id: "t", tool_name: "Bash", tool_input: { command: "rg -n needle src" } }, {}, state);
	assert.deepEqual(search.output, {});
	const catState = newState();
	const cat = run({ hook_event_name: "PreToolUse", session_id: "s2", turn_id: "t2", tool_name: "Bash", tool_input: { command: "cat src/file.ts" } }, { CODEX_READ_POLICY_MODE: "deny" }, catState);
	assert.equal(cat.output.hookSpecificOutput.permissionDecision, "deny");
	const bounded = run({ hook_event_name: "PreToolUse", session_id: "s3", turn_id: "t3", tool_name: "Bash", tool_input: { command: "sed -n '1,400p' src/file.ts" } }, { CODEX_READ_POLICY_MODE: "deny" }, newState());
	assert.deepEqual(bounded.output, {});
});

test("explicit full-file request and off mode proceed", () => {
	const state = newState();
	run(prompt("read the entire file"), {}, state);
	assert.deepEqual(run(read(), { CODEX_READ_POLICY_MODE: "deny" }, state).output, {});
	assert.deepEqual(run(read(), { CODEX_READ_POLICY_MODE: "off" }, state).output, {});
});

test("malformed input fails open with a bounded diagnostic", () => {
	const state = mkdtempSync(join(tmpdir(), "codex-read-policy-test-"));
	const result = spawnSync(process.execPath, [hook], { input: "not-json", encoding: "utf8", env: { ...process.env, CODEX_READ_POLICY_STATE_DIR: state } });
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, /^codex-read-policy: invalid input; proceeding\n$/);
});

test("wrapper is executable and resolves installed Codex paths", () => {
	const wrapper = join(import.meta.dirname, "../../payload/bin/codex-read-policy");
	assert.equal(statSync(wrapper).mode & 0o111, 0o111);
	const text = readFileSync(wrapper, "utf8");
	assert.match(text, /CODEX_HOME.*\$HOME\/.codex/);
	assert.match(text, /hooks\/codex-setup-read-policy\.mjs/);
	assert.match(text, /toolchains\/current\/node\/bin\/node/);
});
