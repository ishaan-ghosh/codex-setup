#!/usr/bin/env node

/**
 * Codex-native search-first read policy.
 *
 * Hook registrations are intentionally kept outside this file: the installer
 * or managed config wires this program to UserPromptSubmit and PreToolUse.
 * The policy cannot rewrite a Codex tool call, and Codex PreToolUse does not
 * support permissionDecision=ask, so ask is represented by a deny response
 * that tells the agent to request approval from the user.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_LINES = 400;
const MODES = new Set(["warn", "deny", "ask", "off"]);
const FULL_FILE_REQUEST = /\b(?:read|open|inspect)\s+(?:the\s+)?(?:entire|full|whole)\s+(?:contents?|file)|\ball\s+contents\b|\bfull\s+file\b/i;
const SEARCH_COMMAND = /(?:^|[;&|()\s])(?:rg|ripgrep|grep|egrep|fgrep|find|fd|ls|tree)(?:\s|$)|(?:^|[;&|()\s])git\s+(?:grep|ls-files)(?:\s|$)/i;
const READ_COMMAND = /(?:^|[;&|()\s])(?:cat|head|tail|sed|awk|bat|less|more)(?:\s|$)|(?:^|[;&|()\s])git\s+(?:show|diff)(?:\s|$)/i;

function mode() {
	const value = String(process.env.CODEX_READ_POLICY_MODE || "warn").trim().toLowerCase();
	return MODES.has(value) ? value : "warn";
}

function stateRoot() {
	const root = process.env.CODEX_READ_POLICY_STATE_DIR || join(tmpdir(), "codex-read-policy");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	return root;
}

function stateKey(input) {
	const session = input.session_id ?? input.sessionId ?? "unknown-session";
	const turn = input.turn_id ?? input.turnId ?? input.prompt_id ?? input.promptId ?? "unknown-turn";
	return createHash("sha256").update(`${String(session)}\0${String(turn)}`).digest("hex").slice(0, 32);
}

function statePath(input) {
	return join(stateRoot(), `turn-${stateKey(input)}.json`);
}

function loadState(input) {
	try {
		const value = JSON.parse(readFileSync(statePath(input), "utf8"));
		if (typeof value.allowFull === "boolean" && typeof value.searchUsed === "boolean") return value;
	} catch {
		// Missing or malformed best-effort state starts conservatively.
	}
	return { allowFull: false, searchUsed: false };
}

function saveState(input, state) {
	try {
		writeFileSync(statePath(input), JSON.stringify({
			allowFull: Boolean(state.allowFull),
			searchUsed: Boolean(state.searchUsed),
		}), { encoding: "utf8", mode: 0o600 });
		// chmod is deliberate because an existing file's mode is not changed by
		// writeFileSync({mode}) on every platform.
		chmodSync(statePath(input), 0o600);
	} catch {
		// Policy state is advisory; failure must never block the real tool.
	}
}

function toolInput(input) {
	return input.tool_input ?? input.toolInput ?? input.input ?? {};
}

function toolName(input) {
	return String(input.tool_name ?? input.toolName ?? input.name ?? "").toLowerCase();
}

function bashCommand(input) {
	const value = toolInput(input).command ?? toolInput(input).cmd;
	return typeof value === "string" ? value : "";
}

function isSearchTool(input) {
	const name = toolName(input);
	return name === "grep" || name === "glob" || name === "find" || name === "ls" || name === "search";
}

function numeric(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function boundedStructuredRead(input) {
	const limit = numeric(toolInput(input).limit);
	return limit !== undefined && limit <= MAX_LINES;
}

function boundedShellRead(command) {
	// An explicit output limiter is the shell equivalent of Read.limit. This is
	// intentionally conservative: unknown shell syntax is treated as unbounded.
	const head = command.match(/\b(?:head|tail)\s+(?:-[a-z]*\s*)?-n\s*(\d+)/i) || command.match(/\b(?:head|tail)\s+-(\d+)/i);
	if (head && Number(head[1]) <= MAX_LINES) return true;
	const sed = command.match(/\bsed\s+(?:-[^\n]*?)?-n\s+['"]?(\d+)\s*,\s*(\d+)p/i);
	if (sed && Number(sed[2]) - Number(sed[1]) + 1 <= MAX_LINES) return true;
	const awk = command.match(/\bawk\b[^\n]*?NR\s*<=\s*(\d+)/i);
	return Boolean(awk && Number(awk[1]) <= MAX_LINES);
}

function shellSegments(command) {
	// This is deliberately not a shell parser. Splitting on compound operators
	// errs toward blocking when quoting or substitution makes the shape unclear.
	return command.split(/[;&|]+|[()]/).map((segment) => segment.trim()).filter(Boolean);
}

function shellReadsBounded(command) {
	return shellSegments(command).every((segment) => !READ_COMMAND.test(segment) || boundedShellRead(segment));
}

function proceed(context) {
	if (!context) return;
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			additionalContext: context,
		},
	}));
}

function diagnostic(code) {
	try {
		process.stderr.write(`codex-read-policy: ${code}; proceeding\n`);
	} catch {
		// Diagnostics are best effort and never include input, paths, or secrets.
	}
}

function violationReason(kind) {
	return `Read-policy: ${kind} is not bounded and no search ran in this turn. Prefer Grep/Glob or a Bash search first, or use a bounded read of at most ${MAX_LINES} lines. Explicitly ask the user to approve a full-file read if it is necessary.`;
}

function block(reason, selectedMode) {
	if (selectedMode === "warn") {
		proceed(reason);
		return;
	}
	const ask = selectedMode === "ask";
	const suffix = ask ? " Codex PreToolUse cannot emit permissionDecision=ask; request approval from the user, then retry." : " Set CODEX_READ_POLICY_MODE=off or search/page the file first.";
	process.stdout.write(JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `${reason}${suffix}`,
		},
	}));
}

function handlePrompt(input) {
	const prompt = String(input.prompt_text ?? input.prompt ?? input.user_prompt ?? "");
	saveState(input, { allowFull: FULL_FILE_REQUEST.test(prompt), searchUsed: false });
	proceed();
}

function handleTool(input) {
	if (mode() === "off") {
		proceed();
		return;
	}
	const name = toolName(input);
	const state = loadState(input);
	if (isSearchTool(input)) {
		state.searchUsed = true;
		saveState(input, state);
		proceed();
		return;
	}
	if (name === "bash") {
		const command = bashCommand(input);
		const hasRead = READ_COMMAND.test(command);
		const readsBounded = !hasRead || shellReadsBounded(command);
		// Evaluate all compound segments before recording a search. An unbounded
		// read such as "cat file | rg needle" must not be masked by its search
		// segment, and a later "; cat other" must not be masked by an earlier
		// bounded read.
		if (hasRead && !readsBounded && !state.allowFull && !state.searchUsed) {
			block(violationReason("this Bash read"), mode());
			return;
		}
		if (SEARCH_COMMAND.test(command)) {
			state.searchUsed = true;
			saveState(input, state);
		}
		if (!hasRead || readsBounded || state.allowFull || state.searchUsed) {
			proceed();
			return;
		}
		block(violationReason("this Bash read"), mode());
		return;
	}

	if (name !== "read" || state.allowFull || state.searchUsed || boundedStructuredRead(input)) {
		proceed();
		return;
	}
	block(violationReason("this Read call"), mode());
}

function main() {
	let input;
	try {
		input = JSON.parse(readFileSync(0, "utf8") || "{}");
	} catch {
		diagnostic("invalid input");
		return;
	}
	try {
		if (input.hook_event_name === "UserPromptSubmit" || input.event === "UserPromptSubmit") handlePrompt(input);
		else if (input.hook_event_name === "PreToolUse" || input.event === "PreToolUse") handleTool(input);
		else proceed();
	} catch {
		diagnostic("internal error");
	}
}

main();
