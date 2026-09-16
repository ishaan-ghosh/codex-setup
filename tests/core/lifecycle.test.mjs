import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Lifecycle } from "../../lib/lifecycle.mjs";

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");

function toolchainIdentity(name = "toolchain-a") {
	const checksum = digest(name);
	return {
		releaseId: name,
		platform: "linux-x64",
		nodeVersion: "22.22.0",
		componentLockSha256: checksum,
		packageLockSha256: digest(`${name}-package-lock`),
		browserInstalled: true,
		executables: {
			"app/node_modules/@openai/codex/bin/codex.js": digest(`${name}-codex`),
			"app/node_modules/@playwright/mcp/cli.js": digest(`${name}-mcp`),
			"node/bin/node": digest(`${name}-node`),
			"node/lib/node_modules/npm/bin/npm-cli.js": digest(`${name}-npm`),
		},
	};
}

function fakeToolchain(initial = toolchainIdentity()) {
	const releases = new Map([[initial.releaseId, structuredClone(initial)]]);
	return {
		current: structuredClone(initial),
		add(identity) { releases.set(identity.releaseId, structuredClone(identity)); },
		remove(identity) { releases.delete(identity.releaseId); },
		async currentIdentity() { return structuredClone(this.current); },
		async validateReleaseIdentity(identity) {
			const found = releases.get(identity.releaseId);
			if (!found) throw new Error("missing recorded toolchain");
			assert.deepEqual(found, identity);
			return structuredClone(found);
		},
		async switchToIdentity(identity) {
			await this.validateReleaseIdentity(identity);
			this.current = structuredClone(identity);
			return structuredClone(identity);
		},
	};
}

async function harness(version = "1.0.0", extraArtifacts = []) {
	const tempRoot = await fs.realpath(os.tmpdir());
	const root = await fs.mkdtemp(path.join(tempRoot, "codex-setup-core-"));
	const repo = path.join(root, "repo");
	const home = path.join(root, "home");
	const codexHome = path.join(home, ".codex");
	const dataHome = path.join(home, ".local", "share", "codex-setup");
	await fs.mkdir(path.join(repo, "payload"), { recursive: true });
	const skill = Buffer.from(`# managed ${version}\n`);
	const config = Buffer.from(`${JSON.stringify({ features: { managed: version } }, null, 2)}\n`);
	await fs.writeFile(path.join(repo, "payload", "skill.md"), skill);
	await fs.writeFile(path.join(repo, "payload", "config.json"), config);
	const release = {
		schema: 1,
		version,
		artifacts: [
			{ source: "payload/skill.md", target: "skills/managed/SKILL.md", sha256: digest(skill), kind: "file", mode: "0644" },
			{ source: "payload/config.json", target: "config.json", sha256: digest(config), kind: "json-merge", mode: "0600" },
			...extraArtifacts,
		],
	};
	await fs.writeFile(path.join(repo, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
	const lines = [];
	const output = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
	const toolchain = fakeToolchain();
	return {
		root, repo, home, codexHome, dataHome, lines, output, toolchain,
		lifecycle: new Lifecycle({ repoRoot: repo, codexHome, dataHome, userHome: home, localBin: path.join(home, ".local", "bin"), output, toolchain }),
	};
}

async function addTomlMerge(h, version) {
	const contents = Buffer.from(`[features]\nmanaged = "${version}"\n`);
	await fs.writeFile(path.join(h.repo, "payload", "config.toml"), contents);
	const releasePath = path.join(h.repo, "release.json");
	const release = JSON.parse(await fs.readFile(releasePath));
	release.artifacts.push({
		source: "payload/config.toml",
		target: "config.toml",
		sha256: digest(contents),
		kind: "toml-merge",
		mode: "0600",
	});
	await fs.writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
}

async function assertValueNotRetained(root, privateValue) {
	const visit = async (directory) => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const candidate = path.join(directory, entry.name);
			if (entry.isDirectory()) await visit(candidate);
			else if (entry.isFile()) {
				const contents = await fs.readFile(candidate, "utf8");
				assert.equal(contents.includes(privateValue), false, `${path.relative(root, candidate)} retained a private config value`);
			}
		}
	};
	await visit(root);
}

test("install owns only listed files and structurally preserves user config", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await fs.mkdir(h.codexHome, { recursive: true });
	await fs.writeFile(path.join(h.codexHome, "config.json"), '{"user":"keep","features":{"userFlag":true}}\n');
	await h.lifecycle.install();
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json"))), {
		user: "keep",
		features: { userFlag: true, managed: "1.0.0" },
	});
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.0.0\n");
	const state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json")));
	assert.equal(state.resources.length, 2);
	const fileResource = state.resources.find((entry) => entry.kind === "file");
	const mergeResource = state.resources.find((entry) => entry.kind === "json-merge");
	assert.match(fileResource.installedSha256, /^[0-9a-f]{64}$/);
	assert.equal(Object.hasOwn(mergeResource, "installedSha256"), false);
});

test("install conflict and symlink path fail before managed writes", async (t) => {
	await t.test("unmanaged file", async (t) => {
		const h = await harness(); t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await fs.mkdir(path.join(h.codexHome, "skills/managed"), { recursive: true });
		await fs.writeFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "user\n");
		await assert.rejects(() => h.lifecycle.install(), /unmanaged file blocks install/);
		await assert.rejects(() => fs.stat(path.join(h.codexHome, ".codex-setup/state.json")), { code: "ENOENT" });
	});
	await t.test("symlink parent", async (t) => {
		const h = await harness(); t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		const outside = path.join(h.root, "outside");
		const symlinkParent = path.join(h.codexHome, "skills");
		await fs.mkdir(h.codexHome, { recursive: true }); await fs.mkdir(outside);
		await fs.symlink(outside, symlinkParent, "dir");
		await assert.rejects(() => h.lifecycle.install(), (error) => {
			assert.match(error.message, /symbolic-link component/);
			assert.ok(error.message.endsWith(symlinkParent));
			return true;
		});
		assert.deepEqual(await fs.readdir(outside), []);
	});
});

test("dry-run plans without creating CODEX_HOME or lifecycle state", async (t) => {
	const h = await harness(); t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	const dry = new Lifecycle({ repoRoot: h.repo, codexHome: h.codexHome, dataHome: h.dataHome, dryRun: true, output: h.output, toolchain: h.toolchain });
	await dry.install();
	await assert.rejects(() => fs.stat(h.codexHome), { code: "ENOENT" });
	assert.ok(h.lines.some((line) => line.includes("[dry-run]")));
});

test("doctor does not print config values and tolerates unknown user-key edits", async (t) => {
	const h = await harness(); t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const configPath = path.join(h.codexHome, "config.json");
	const config = JSON.parse(await fs.readFile(configPath));
	config.userSecretLookingValue = "DO_NOT_PRINT_THIS";
	await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
	assert.equal(await h.lifecycle.doctor(), 0);
	assert.doesNotMatch(h.lines.join("\n"), /DO_NOT_PRINT_THIS/);
});

test("exact update, coupled toolchain rollback, and uninstall are checksum guarded", async (t) => {
	const h = await harness("1.0.0"); t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const firstState = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json")));
	const next = await harness("1.1.0"); t.after(() => fs.rm(next.root, { recursive: true, force: true }));
	h.lifecycle.repoRoot = next.repo;
	const nextToolchain = toolchainIdentity("toolchain-b");
	h.toolchain.add(nextToolchain);
	h.toolchain.current = structuredClone(nextToolchain);
	await h.lifecycle.update();
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.1.0\n");
	const updated = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json")));
	await h.lifecycle.rollback({ transaction: updated.lastTransaction });
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.0.0\n");
	const restored = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json")));
	assert.equal(restored.version, firstState.version);
	assert.equal(restored.releaseManifestSha256, firstState.releaseManifestSha256);
	assert.equal(h.toolchain.current.releaseId, firstState.toolchain.releaseId);
	assert.equal(await h.lifecycle.doctor(), 0);
	await h.lifecycle.uninstall();
	await assert.rejects(() => fs.stat(path.join(h.codexHome, "skills/managed/SKILL.md")), { code: "ENOENT" });
	await assert.rejects(() => fs.stat(path.join(h.codexHome, "config.json")), { code: "ENOENT" });
});

test("adopt requires exact file bytes", async (t) => {
	const h = await harness(); t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await fs.mkdir(path.join(h.codexHome, "skills/managed"), { recursive: true });
	await fs.writeFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "wrong\n");
	await assert.rejects(() => h.lifecycle.install({ adopt: true }), /cannot adopt non-matching file/);
});


test("target_root maps personal skills and launchers outside CODEX_HOME", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	const skill = Buffer.from("# personal\n");
	const launcher = Buffer.from("#!/bin/sh\nexit 0\n");
	await fs.writeFile(path.join(h.repo, "payload/personal.md"), skill);
	await fs.writeFile(path.join(h.repo, "payload/helper"), launcher);
	const releasePath = path.join(h.repo, "release.json");
	const release = JSON.parse(await fs.readFile(releasePath));
	release.artifacts.push(
		{ source: "payload/personal.md", target_root: "user_home", target: ".agents/skills/example/SKILL.md", sha256: digest(skill), mode: "0644" },
		{ source: "payload/helper", target_root: "local_bin", target: "codex-helper", sha256: digest(launcher), mode: "0755" },
	);
	await fs.writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
	await h.lifecycle.install();
	assert.equal(await fs.readFile(path.join(h.home, ".agents/skills/example/SKILL.md"), "utf8"), "# personal\n");
	assert.equal(await fs.readFile(path.join(h.home, ".local/bin/codex-helper"), "utf8"), "#!/bin/sh\nexit 0\n");
	const state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json")));
	assert.ok(state.resources.some((entry) => entry.targetRoot === "user_home"));
	assert.ok(state.resources.some((entry) => entry.targetRoot === "local_bin"));
});

test("update consumes the exact release from the selected checkout", async (t) => {
	const h = await harness("1.0.0");
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const next = await harness("1.1.0");
	t.after(() => fs.rm(next.root, { recursive: true, force: true }));
	h.lifecycle.repoRoot = next.repo;
	await h.lifecycle.update();
	assert.equal(JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json"))).version, "1.1.0");
});


test("fresh install accepts semantically equal managed config but rejects different values", async (t) => {
	const equal = await harness();
	t.after(() => fs.rm(equal.root, { recursive: true, force: true }));
	await fs.mkdir(equal.codexHome, { recursive: true });
	await fs.writeFile(path.join(equal.codexHome, "config.json"), '{"features":{"managed":"1.0.0"},"user":"keep"}\n', { mode: 0o600 });
	await equal.lifecycle.install();
	assert.equal(JSON.parse(await fs.readFile(path.join(equal.codexHome, "config.json"))).user, "keep");

	const conflict = await harness();
	t.after(() => fs.rm(conflict.root, { recursive: true, force: true }));
	await fs.mkdir(conflict.codexHome, { recursive: true });
	await fs.writeFile(path.join(conflict.codexHome, "config.json"), '{"features":{"managed":"different"}}\n', { mode: 0o600 });
	await assert.rejects(() => conflict.lifecycle.install(), /managed config conflicts with user value/);
	await assert.rejects(() => fs.stat(path.join(conflict.codexHome, "skills/managed/SKILL.md")), { code: "ENOENT" });
});

test("doctor reports managed mode drift without exposing contents", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const skill = path.join(h.codexHome, "skills/managed/SKILL.md");
	await fs.chmod(skill, 0o600);
	assert.equal(await h.lifecycle.doctor(), 1);
	assert.ok(h.lines.some((line) => line.includes("mode drift")));
});

test("update fails before payload mutation when the previous toolchain cannot be restored", async (t) => {
	const h = await harness("1.0.0");
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const previous = structuredClone(h.toolchain.current);
	const next = await harness("1.1.0");
	t.after(() => fs.rm(next.root, { recursive: true, force: true }));
	h.lifecycle.repoRoot = next.repo;
	const replacement = toolchainIdentity("toolchain-b");
	h.toolchain.add(replacement);
	h.toolchain.current = structuredClone(replacement);
	h.toolchain.remove(previous);
	await assert.rejects(() => h.lifecycle.update(), /missing recorded toolchain/);
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.0.0\n");
});

test("rollback rejects an escaping backup basename before mutation", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await fs.mkdir(path.join(h.codexHome, "skills/managed"), { recursive: true });
	await fs.writeFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "# managed 1.0.0\n", { mode: 0o644 });
	await fs.writeFile(path.join(h.codexHome, "config.json"), '{"user":"keep"}\n', { mode: 0o600 });
	await h.lifecycle.install({ adopt: true });
	const state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json")));
	const transactionPath = path.join(h.codexHome, ".codex-setup/backups", state.lastTransaction, "transaction.json");
	const transaction = JSON.parse(await fs.readFile(transactionPath));
	const backedUp = transaction.resources.find((record) => record.backup);
	backedUp.backup = "../escape";
	await fs.writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
	await assert.rejects(() => h.lifecycle.rollback(), /invalid backup metadata/);
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.0.0\n");
});
test("rollback rejects a managed ancestor replaced by a symlink without touching outside files", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json")));
	const outside = path.join(h.root, "outside-skills");
	await fs.rename(path.join(h.codexHome, "skills"), outside);
	const sentinel = path.join(outside, "sentinel.txt");
	await fs.writeFile(sentinel, "outside-sentinel\n");
	const outsideManaged = path.join(outside, "managed/SKILL.md");
	const outsideBefore = await fs.readFile(outsideManaged);
	const symlinkParent = path.join(h.codexHome, "skills");
	await fs.symlink(outside, symlinkParent, "dir");

	await assert.rejects(() => h.lifecycle.rollback({ transaction: state.lastTransaction }), (error) => {
		assert.match(error.message, /symbolic-link component/);
		assert.ok(error.message.endsWith(symlinkParent));
		return true;
	});
	assert.equal(await fs.readFile(sentinel, "utf8"), "outside-sentinel\n");
	assert.deepEqual(await fs.readFile(outsideManaged), outsideBefore);
	assert.equal(JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup/state.json"))).lastTransaction, state.lastTransaction);
});

test("merge transactions never retain unknown JSON or TOML values and roll back structurally", async (t) => {
	await t.test("install", async (t) => {
		const h = await harness("1.0.0");
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addTomlMerge(h, "1.0.0");
		const jsonPrivate = "PRIVATE_JSON_INSTALL_VALUE";
		const tomlPrivate = "PRIVATE_TOML_INSTALL_VALUE";
		await fs.mkdir(h.codexHome, { recursive: true });
		await fs.writeFile(path.join(h.codexHome, "config.json"), `${JSON.stringify({
			privateValue: jsonPrivate,
			features: { managed: "1.0.0" },
		})}\n`, { mode: 0o600 });
		await fs.writeFile(path.join(h.codexHome, "config.toml"), `private_value = "${tomlPrivate}"\n\n[features]\nmanaged = "1.0.0"\n`, { mode: 0o600 });

		await h.lifecycle.install();
		const stateDir = path.join(h.codexHome, ".codex-setup");
		await assertValueNotRetained(stateDir, jsonPrivate);
		await assertValueNotRetained(stateDir, tomlPrivate);
		const state = JSON.parse(await fs.readFile(path.join(stateDir, "state.json")));
		const transaction = JSON.parse(await fs.readFile(path.join(stateDir, "backups", state.lastTransaction, "transaction.json")));
		for (const record of transaction.resources.filter((entry) => entry.kind !== "file")) {
			assert.equal(Object.hasOwn(record, "backup"), false);
			assert.equal(Object.hasOwn(record, "beforeSha256"), false);
			assert.equal(Object.hasOwn(record, "afterSha256"), false);
		}

		const currentJson = JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json")));
		currentJson.addedAfterInstall = true;
		await fs.writeFile(path.join(h.codexHome, "config.json"), `${JSON.stringify(currentJson)}\n`);
		await fs.appendFile(path.join(h.codexHome, "config.toml"), "added_after_install = true\n");
		await h.lifecycle.rollback();
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json"))), {
			privateValue: jsonPrivate,
			addedAfterInstall: true,
			features: { managed: "1.0.0" },
		});
		const restoredToml = await fs.readFile(path.join(h.codexHome, "config.toml"), "utf8");
		assert.match(restoredToml, /PRIVATE_TOML_INSTALL_VALUE/);
		assert.match(restoredToml, /added_after_install = true/);
		assert.match(restoredToml, /managed = "1.0.0"/);
		await assertValueNotRetained(stateDir, jsonPrivate);
		await assertValueNotRetained(stateDir, tomlPrivate);
	});

	await t.test("update", async (t) => {
		const h = await harness("1.0.0");
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addTomlMerge(h, "1.0.0");
		const jsonPrivate = "PRIVATE_JSON_UPDATE_VALUE";
		const tomlPrivate = "PRIVATE_TOML_UPDATE_VALUE";
		await fs.mkdir(h.codexHome, { recursive: true });
		await fs.writeFile(path.join(h.codexHome, "config.json"), `{"privateValue":"${jsonPrivate}"}\n`, { mode: 0o600 });
		await fs.writeFile(path.join(h.codexHome, "config.toml"), `private_value = "${tomlPrivate}"\n`, { mode: 0o600 });
		await h.lifecycle.install();

		const next = await harness("1.1.0");
		t.after(() => fs.rm(next.root, { recursive: true, force: true }));
		await addTomlMerge(next, "1.1.0");
		h.lifecycle.repoRoot = next.repo;
		const toolchainB = toolchainIdentity("toolchain-b");
		h.toolchain.add(toolchainB);
		h.toolchain.current = structuredClone(toolchainB);
		await h.lifecycle.update();
		const stateDir = path.join(h.codexHome, ".codex-setup");
		const updatedState = JSON.parse(await fs.readFile(path.join(stateDir, "state.json")));
		const updateTransaction = JSON.parse(await fs.readFile(path.join(stateDir, "backups", updatedState.lastTransaction, "transaction.json")));
		for (const resource of updateTransaction.previousState.resources.filter((entry) => entry.kind !== "file")) {
			assert.equal(Object.hasOwn(resource, "installedSha256"), false);
		}
		await assertValueNotRetained(stateDir, jsonPrivate);
		await assertValueNotRetained(stateDir, tomlPrivate);

		const currentJson = JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json")));
		currentJson.addedAfterUpdate = true;
		await fs.writeFile(path.join(h.codexHome, "config.json"), `${JSON.stringify(currentJson)}\n`);
		await fs.appendFile(path.join(h.codexHome, "config.toml"), "added_after_update = true\n");
		await h.lifecycle.rollback();
		const json = JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json")));
		assert.equal(json.privateValue, jsonPrivate);
		assert.equal(json.addedAfterUpdate, true);
		assert.equal(json.features.managed, "1.0.0");
		const toml = await fs.readFile(path.join(h.codexHome, "config.toml"), "utf8");
		assert.match(toml, /PRIVATE_TOML_UPDATE_VALUE/);
		assert.match(toml, /added_after_update = true/);
		assert.match(toml, /managed = "1.0.0"/);
		await assertValueNotRetained(stateDir, jsonPrivate);
		await assertValueNotRetained(stateDir, tomlPrivate);
	});

	await t.test("uninstall", async (t) => {
		const h = await harness("1.0.0");
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addTomlMerge(h, "1.0.0");
		const jsonPrivate = "PRIVATE_JSON_UNINSTALL_VALUE";
		const tomlPrivate = "PRIVATE_TOML_UNINSTALL_VALUE";
		await fs.mkdir(h.codexHome, { recursive: true });
		await fs.writeFile(path.join(h.codexHome, "config.json"), `{"privateValue":"${jsonPrivate}"}\n`, { mode: 0o600 });
		await fs.writeFile(path.join(h.codexHome, "config.toml"), `private_value = "${tomlPrivate}"\n`, { mode: 0o600 });
		await h.lifecycle.install();
		await h.lifecycle.uninstall();
		const stateDir = path.join(h.codexHome, ".codex-setup");
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json"))), { privateValue: jsonPrivate });
		assert.match(await fs.readFile(path.join(h.codexHome, "config.toml"), "utf8"), /PRIVATE_TOML_UNINSTALL_VALUE/);
		await assertValueNotRetained(stateDir, jsonPrivate);
		await assertValueNotRetained(stateDir, tomlPrivate);

		const currentJson = JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json")));
		currentJson.addedAfterUninstall = true;
		await fs.writeFile(path.join(h.codexHome, "config.json"), `${JSON.stringify(currentJson)}\n`);
		await fs.appendFile(path.join(h.codexHome, "config.toml"), "added_after_uninstall = true\n");
		const uninstalledState = (await fs.readdir(stateDir)).find((name) => /^state\.uninstalled-[0-9TZ]+-[0-9a-f]{10}\.json$/.test(name));
		assert.ok(uninstalledState, "uninstall must retain its prior state with the transaction id");
		const transaction = uninstalledState.slice("state.uninstalled-".length, -".json".length);
		await h.lifecycle.rollback({ transaction });
		const json = JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json")));
		assert.equal(json.privateValue, jsonPrivate);
		assert.equal(json.addedAfterUninstall, true);
		assert.equal(json.features.managed, "1.0.0");
		const toml = await fs.readFile(path.join(h.codexHome, "config.toml"), "utf8");
		assert.match(toml, /PRIVATE_TOML_UNINSTALL_VALUE/);
		assert.match(toml, /added_after_uninstall = true/);
		assert.match(toml, /managed = "1.0.0"/);
		await assertValueNotRetained(stateDir, jsonPrivate);
		await assertValueNotRetained(stateDir, tomlPrivate);
	});
});

test("failed update preparation restores the recorded toolchain without changing state or payload", async (t) => {
	const h = await harness("1.0.0");
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const next = await harness("1.1.0");
	t.after(() => fs.rm(next.root, { recursive: true, force: true }));
	h.lifecycle.repoRoot = next.repo;
	const toolchainB = toolchainIdentity("toolchain-b");
	h.toolchain.add(toolchainB);
	const statePath = path.join(h.codexHome, ".codex-setup/state.json");
	const skillPath = path.join(h.codexHome, "skills/managed/SKILL.md");
	const configPath = path.join(h.codexHome, "config.json");
	await fs.writeFile(skillPath, "# locally drifted A payload\n");
	const stateBefore = await fs.readFile(statePath);
	const skillBefore = await fs.readFile(skillPath);
	const configBefore = await fs.readFile(configPath);
	const backupsBefore = await fs.readdir(path.join(h.codexHome, ".codex-setup/backups"));
	h.toolchain.current = structuredClone(toolchainB);

	await assert.rejects(() => h.lifecycle.update(), /managed resource drifted/);
	assert.deepEqual(await fs.readFile(statePath), stateBefore);
	assert.deepEqual(await fs.readFile(skillPath), skillBefore);
	assert.deepEqual(await fs.readFile(configPath), configBefore);
	assert.deepEqual(await fs.readdir(path.join(h.codexHome, ".codex-setup/backups")), backupsBefore);
	assert.equal(h.toolchain.current.releaseId, "toolchain-a");

	h.toolchain.current = structuredClone(toolchainB);
	const dry = new Lifecycle({
		repoRoot: next.repo,
		codexHome: h.codexHome,
		dataHome: h.dataHome,
		userHome: h.home,
		localBin: path.join(h.home, ".local", "bin"),
		dryRun: true,
		output: h.output,
		toolchain: h.toolchain,
	});
	await assert.rejects(() => dry.update(), /managed resource drifted/);
	assert.equal(h.toolchain.current.releaseId, "toolchain-b");
	assert.deepEqual(await fs.readFile(statePath), stateBefore);
	assert.deepEqual(await fs.readFile(skillPath), skillBefore);
	assert.deepEqual(await fs.readFile(configPath), configBefore);
});
test("merge state metadata is independent of unknown config values and still detects managed drift", async (t) => {
	const first = await harness("1.0.0");
	const second = await harness("1.0.0");
	t.after(() => fs.rm(first.root, { recursive: true, force: true }));
	t.after(() => fs.rm(second.root, { recursive: true, force: true }));
	await addTomlMerge(first, "1.0.0");
	await addTomlMerge(second, "1.0.0");

	const installWithPrivateValue = async (h, privateValue) => {
		await fs.mkdir(h.codexHome, { recursive: true });
		await fs.writeFile(path.join(h.codexHome, "config.json"), `{"privateValue":"${privateValue}"}\n`, { mode: 0o600 });
		await fs.writeFile(path.join(h.codexHome, "config.toml"), `private_value = "${privateValue}"\n`, { mode: 0o600 });
		await h.lifecycle.install();
	};
	await installWithPrivateValue(first, "SYNTHETIC_PRIVATE_VALUE_ONE");
	await installWithPrivateValue(second, "SYNTHETIC_PRIVATE_VALUE_TWO");

	const firstStatePath = path.join(first.codexHome, ".codex-setup/state.json");
	const secondStatePath = path.join(second.codexHome, ".codex-setup/state.json");
	const firstStateBytes = await fs.readFile(firstStatePath);
	const secondStateBytes = await fs.readFile(secondStatePath);
	const firstState = JSON.parse(firstStateBytes);
	const secondState = JSON.parse(secondStateBytes);
	const mergeMetadata = (state) => state.resources.filter((entry) => entry.kind !== "file").sort((left, right) => left.target.localeCompare(right.target));
	assert.deepEqual(mergeMetadata(firstState), mergeMetadata(secondState));
	for (const resource of mergeMetadata(firstState)) assert.equal(Object.hasOwn(resource, "installedSha256"), false);
	for (const [h, stateBytes] of [[first, firstStateBytes], [second, secondStateBytes]]) {
		for (const target of ["config.json", "config.toml"]) {
			const wholeConfigDigest = digest(await fs.readFile(path.join(h.codexHome, target)));
			assert.equal(stateBytes.includes(wholeConfigDigest), false, `${target} whole-file digest must not be retained`);
		}
	}

	const drifted = JSON.parse(await fs.readFile(path.join(first.codexHome, "config.json")));
	drifted.features.managed = "locally-drifted";
	await fs.writeFile(path.join(first.codexHome, "config.json"), `${JSON.stringify(drifted)}\n`);
	assert.equal(await first.lifecycle.doctor(), 1);
	const next = await harness("1.1.0");
	t.after(() => fs.rm(next.root, { recursive: true, force: true }));
	first.lifecycle.repoRoot = next.repo;
	await assert.rejects(() => first.lifecycle.update(), /managed config value drifted/);
});
