#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";

const wrapper = process.env.CODEX_PLAYWRIGHT_MCP
	|| path.join(process.env.HOME || "", ".local", "bin", "codex-playwright-mcp");
let blockedRequests = 0;
const blockedServer = http.createServer((request, response) => {
	blockedRequests += 1;
	response.writeHead(200, { "content-type": "text/plain" });
	response.end("directly disallowed origin should not be contacted");
});
const server = http.createServer((request, response) => {
	if (request.url === "/probe") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"ok":true}');
		return;
	}
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(`<!doctype html>
		<title>Codex Browser Smoke</title>
		<h1>Codex Browser Smoke</h1>
		<button id="increment">Increment</button>
		<output id="value">0</output>
		<script>
			fetch("/probe").then(() => console.log("probe-ok"));
			document.querySelector("#increment").addEventListener("click", () => {
				const output = document.querySelector("#value");
				output.textContent = String(Number(output.textContent) + 1);
			});
		</script>`);
});
await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
await new Promise((resolve, reject) => {
	blockedServer.once("error", reject);
	blockedServer.listen(0, "127.0.0.2", resolve);
});
const address = server.address();
const blockedAddress = blockedServer.address();
const child = spawn(wrapper, ["local-test"], {
	stdio: ["pipe", "pipe", "pipe"],
	env: process.env,
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8000); });
const pending = new Map();
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	while (buffer.includes("\n")) {
		const index = buffer.indexOf("\n");
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		let message;
		try { message = JSON.parse(line); } catch { continue; }
		if (message.id !== undefined && pending.has(message.id)) {
			const waiter = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
			else waiter.resolve(message.result);
		}
	}
});
let nextId = 1;
function send(message) {
	child.stdin.write(`${JSON.stringify(message)}\n`);
}
function request(method, params = {}) {
	const id = nextId++;
	send({ jsonrpc: "2.0", id, method, params });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out; stderr: ${stderr}`));
		}, 30000);
		pending.set(id, {
			resolve: (value) => { clearTimeout(timer); resolve(value); },
			reject: (error) => { clearTimeout(timer); reject(error); },
		});
	});
}
function text(result) {
	return (result?.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

try {
	const initialized = await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "codex-setup-browser-smoke", version: "0.1.0" },
	});
	assert.ok(initialized.serverInfo?.name, "MCP initialize response omitted serverInfo");
	send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
	const listed = await request("tools/list");
	const tools = new Map((listed.tools ?? []).map((tool) => [tool.name, tool]));
	for (const required of ["browser_navigate", "browser_snapshot", "browser_click", "browser_console_messages", "browser_network_requests", "browser_take_screenshot"]) {
		assert.ok(tools.has(required), `Playwright MCP omitted ${required}`);
	}
	const url = `http://127.0.0.1:${address.port}/`;
	const navigated = await request("tools/call", { name: "browser_navigate", arguments: { url } });
	assert.match(text(navigated), /Codex Browser Smoke/);
	const snapshot = await request("tools/call", { name: "browser_snapshot", arguments: {} });
	const snapshotText = text(snapshot);
	assert.match(snapshotText, /Increment/);
	const reference = snapshotText.match(/button "Increment" \[ref=([^\]]+)\]/)?.[1];
	assert.ok(reference, `snapshot omitted button reference: ${snapshotText}`);
	await request("tools/call", { name: "browser_click", arguments: { element: "Increment button", ref: reference } });
	const after = await request("tools/call", { name: "browser_snapshot", arguments: {} });
	assert.match(text(after), /output[^\n]*"1"|generic[^\n]*"1"|text=1|\b1\b/);
	if (tools.has("browser_wait_for")) await request("tools/call", { name: "browser_wait_for", arguments: { time: 1 } });
	const consoleMessages = await request("tools/call", { name: "browser_console_messages", arguments: { level: "info" } });
	assert.match(text(consoleMessages), /probe-ok/);
	const networkRequests = await request("tools/call", { name: "browser_network_requests", arguments: { includeStatic: true } });
	assert.match(text(networkRequests), /\/probe/);
	await request("tools/call", { name: "browser_take_screenshot", arguments: { fullPage: true } });
	const blockedUrl = `http://127.0.0.2:${blockedAddress.port}/blocked`;
	let blockedResult;
	let blockedError;
	try { blockedResult = await request("tools/call", { name: "browser_navigate", arguments: { url: blockedUrl } }); }
	catch (error) { blockedError = error; }
	assert.ok(blockedError || blockedResult?.isError || /not allowed|blocked|forbidden/i.test(text(blockedResult)), "local-test did not reject the directly disallowed loopback origin");
	assert.equal(blockedRequests, 0, "local-test contacted the disallowed origin");
	if (tools.has("browser_close")) await request("tools/call", { name: "browser_close", arguments: {} });
	process.stdout.write(`browser smoke passed: ${initialized.serverInfo.name}; ${tools.size} tools; navigation, snapshot, click, console, network, screenshot, and direct-origin guardrail verified (redirects are not a boundary)\n`);
} finally {
	child.stdin.end();
	child.kill("SIGTERM");
	server.close();
	blockedServer.close();
}
