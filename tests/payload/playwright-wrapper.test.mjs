import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const wrapper = join(import.meta.dirname, "../../payload/bin/codex-playwright-mcp");

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "codex-playwright-wrapper-test-"));
  const node = join(root, "data/toolchains/release/node/bin/node");
  const cli = join(root, "data/toolchains/release/app/node_modules/@playwright/mcp/cli.js");
  mkdirSync(join(root, "data/toolchains/release/node/bin"), { recursive: true });
  mkdirSync(join(root, "data/toolchains/release/app/node_modules/@playwright/mcp"), { recursive: true });
  writeFileSync(cli, "// fixture\n");
  writeFileSync(node, '#!/bin/sh\nprintf "%s\n" "$@" > "$CODEX_WRAPPER_ARGS"\n');
  chmodSync(node, 0o755);
  mkdirSync(join(root, "data/toolchains"), { recursive: true });
  symlinkSync("release", join(root, "data/toolchains/current"));
  return { root, data: join(root, "data"), args: join(root, "args") };
}

function run(fixture, args, extra = {}) {
  return spawnSync(wrapper, args, {
    encoding: "utf8",
    env: { ...process.env, CODEX_SETUP_DATA_HOME: fixture.data, CODEX_WRAPPER_ARGS: fixture.args, ...extra },
  });
}

test("named modes pass fixed direct-navigation guardrail arguments", () => {
  const testFixture = fixture();
  const result = run(testFixture, ["local-test"]);
  assert.equal(result.status, 0, result.stderr);
  const args = readFileSync(testFixture.args, "utf8").trim().split("\n");
  assert.ok(args.includes("--host"));
  assert.ok(args.includes("127.0.0.1"));
  const hostIndex = args.indexOf("--allowed-hosts");
  const originIndex = args.indexOf("--allowed-origins");
  assert.ok(hostIndex >= 0);
  assert.equal(args[hostIndex + 1], "localhost,127.0.0.1");
  assert.ok(originIndex >= 0);
  assert.equal(args[originIndex + 1], "http://localhost:*;http://127.0.0.1:*");
  assert.notEqual(args[hostIndex + 1], args[originIndex + 1]);
  assert.ok(args.includes("--isolated"));
  assert.ok(args.every((arg) => !arg.includes("--user-data-dir")));
});

test("wrapper rejects caller flags", () => {
  const testFixture = fixture();
  const result = run(testFixture, ["web-research", "--host", "0.0.0.0"]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /additional arguments are not accepted/);
});

test("wrapper rejects symlinked writable output and profile components", () => {
  const output = fixture();
  mkdirSync(join(output.root, "outside"));
  symlinkSync(join(output.root, "outside"), join(output.data, "browser-output"));
  const blockedOutput = run(output, ["local-test"]);
  assert.equal(blockedOutput.status, 70);
  assert.equal(blockedOutput.stderr.trim(), `codex-playwright-mcp: unsafe path: ${join(output.data, "browser-output")}`);

  const profile = fixture();
  mkdirSync(join(profile.data, "browser-output"), { recursive: true });
  mkdirSync(join(profile.root, "outside-profile"));
  mkdirSync(join(profile.data, "browser-profiles"), { recursive: true });
  symlinkSync(join(profile.root, "outside-profile"), join(profile.data, "browser-profiles/authenticated"));
  const blockedProfile = run(profile, ["authenticated-browser"]);
  assert.equal(blockedProfile.status, 70);
  assert.equal(blockedProfile.stderr.trim(), `codex-playwright-mcp: unsafe path: ${join(profile.data, "browser-profiles/authenticated")}`);
});
