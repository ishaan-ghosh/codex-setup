import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
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

async function addLauncher(h, version, { first = false, target = "codex" } = {}) {
	const contents = Buffer.from(`#!/bin/sh\necho managed-${version}\n`);
	await fs.writeFile(path.join(h.repo, "payload", "codex"), contents);
	const releasePath = path.join(h.repo, "release.json");
	const release = JSON.parse(await fs.readFile(releasePath));
	const artifact = {
		source: "payload/codex",
		target_root: "local_bin",
		target,
		sha256: digest(contents),
		kind: "file",
		mode: "0755",
	};
	if (first) release.artifacts.unshift(artifact);
	else release.artifacts.push(artifact);
	await fs.writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`);
	return contents;
}

async function writeLauncherSymlink(h, linkText) {
	const launcher = path.join(h.home, ".local", "bin", "codex");
	await fs.mkdir(path.dirname(launcher), { recursive: true });
	await fs.symlink(linkText, launcher);
	return launcher;
}

function snapshotLinkBytes(snapshot) {
	return Buffer.from(snapshot.linkBase64, "base64");
}

function snapshotLinkText(snapshot) {
	return snapshotLinkBytes(snapshot).toString("utf8");
}

function convertTransactionToSchema3(transaction) {
	transaction.schema = 3;
	for (const record of transaction.resources.filter((entry) => entry.kind === "file")) {
		record.beforeSha256 = record.beforeSnapshot.type === "missing" ? null : record.beforeSnapshot.sha256;
		record.beforeMode = record.beforeSnapshot.type === "missing" ? null : record.beforeSnapshot.mode;
		record.afterSha256 = record.afterSnapshot.type === "missing" ? null : record.afterSnapshot.sha256;
		record.afterMode = record.afterSnapshot.type === "missing" ? null : record.afterSnapshot.mode;
		delete record.beforeSnapshot;
		delete record.afterSnapshot;
	}
	return transaction;
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

test("dry-run install and uninstall remain write-free without lifecycle locks", async (t) => {
	const h = await harness(); t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	const dry = new Lifecycle({ repoRoot: h.repo, codexHome: h.codexHome, dataHome: h.dataHome, dryRun: true, output: h.output, toolchain: h.toolchain });
	await dry.install();
	await assert.rejects(() => fs.stat(h.codexHome), { code: "ENOENT" });
	assert.ok(h.lines.some((line) => line.includes("[dry-run]")));

	const installed = await harness(); t.after(() => fs.rm(installed.root, { recursive: true, force: true }));
	await installed.lifecycle.install();
	const statePath = path.join(installed.codexHome, ".codex-setup", "state.json");
	const skillPath = path.join(installed.codexHome, "skills", "managed", "SKILL.md");
	const stateBefore = await fs.readFile(statePath);
	const skillBefore = await fs.readFile(skillPath);
	const dryInstalled = new Lifecycle({
		repoRoot: installed.repo,
		codexHome: installed.codexHome,
		dataHome: installed.dataHome,
		userHome: installed.home,
		localBin: path.join(installed.home, ".local", "bin"),
		dryRun: true,
		output: installed.output,
		toolchain: installed.toolchain,
	});
	await dryInstalled.uninstall();
	assert.deepEqual(await fs.readFile(statePath), stateBefore);
	assert.deepEqual(await fs.readFile(skillPath), skillBefore);
	await assert.rejects(() => fs.lstat(path.join(installed.codexHome, ".codex-setup", "lifecycle.lock")), { code: "ENOENT" });
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
	await assert.rejects(() => fs.stat(path.join(h.codexHome, ".codex-setup")), { code: "ENOENT" });
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
	await assert.rejects(() => fs.stat(path.join(conflict.codexHome, ".codex-setup")), { code: "ENOENT" });
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
	const originalSwitch = h.toolchain.switchToIdentity.bind(h.toolchain);
	let restoredWhileLocked = false;
	h.toolchain.switchToIdentity = async (identity) => {
		if (identity.releaseId === "toolchain-a") {
			const owner = await fs.lstat(path.join(h.codexHome, ".codex-setup", "lifecycle.lock", "owner.json"));
			assert.equal(owner.isFile(), true);
			assert.equal(owner.mode & 0o777, 0o600);
			restoredWhileLocked = true;
		}
		return originalSwitch(identity);
	};
	h.toolchain.current = structuredClone(toolchainB);

	await assert.rejects(() => h.lifecycle.update(), /managed resource drifted/);
	assert.deepEqual(await fs.readFile(statePath), stateBefore);
	assert.deepEqual(await fs.readFile(skillPath), skillBefore);
	assert.deepEqual(await fs.readFile(configPath), configBefore);
	assert.deepEqual(await fs.readdir(path.join(h.codexHome, ".codex-setup/backups")), backupsBefore);
	assert.equal(h.toolchain.current.releaseId, "toolchain-a");
	assert.equal(restoredWhileLocked, true);

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
	await assert.rejects(() => fs.lstat(path.join(h.codexHome, ".codex-setup", "lifecycle.lock")), { code: "ENOENT" });
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


test("Codex launcher migration is explicit, private, and dry-run safe", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0");
	const privateTarget = "../private/arbitrary-broken-launcher-target";
	const launcher = await writeLauncherSymlink(h, privateTarget);

	await assert.rejects(() => h.lifecycle.install(), /--migrate-codex-launcher/);
	assert.equal(await fs.readlink(launcher), privateTarget);
	await assert.rejects(() => fs.stat(path.join(h.codexHome, ".codex-setup")), { code: "ENOENT" });

	const dry = new Lifecycle({
		repoRoot: h.repo,
		codexHome: h.codexHome,
		dataHome: h.dataHome,
		userHome: h.home,
		localBin: path.join(h.home, ".local", "bin"),
		dryRun: true,
		output: h.output,
		toolchain: h.toolchain,
	});
	await dry.install({ migrateCodexLauncher: true });
	assert.equal(await fs.readlink(launcher), privateTarget);
	assert.match(h.lines.join("\n"), /migrate existing launcher symlink local_bin:codex/);
	assert.doesNotMatch(h.lines.join("\n"), /private\/arbitrary/);
	await assert.rejects(() => fs.stat(path.join(h.codexHome, ".codex-setup")), { code: "ENOENT" });

	await h.lifecycle.install({ migrateCodexLauncher: true });
	assert.equal((await fs.lstat(launcher)).isFile(), true);
	const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
	const state = JSON.parse(await fs.readFile(statePath));
	assert.equal(state.schema, 4);
	const resource = state.resources.find((entry) => entry.targetRoot === "local_bin" && entry.target === "codex");
	assert.equal(snapshotLinkText(resource.displacedSymlink), privateTarget);
	assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
	const transactionPath = path.join(h.codexHome, ".codex-setup", "backups", state.lastTransaction, "transaction.json");
	assert.equal((await fs.stat(transactionPath)).mode & 0o777, 0o600);
	await h.lifecycle.rollback();
	assert.equal(await fs.readlink(launcher), privateTarget);
});

test("launcher migration preserves absolute, relative, live, and broken arbitrary link text without dereferencing", async (t) => {
	const cases = [
		["absolute live", (h) => path.join(h.root, "live-target"), true],
		["absolute broken", () => "/definitely/not/a/codex/layout", false],
		["relative live", () => "../share/live-target", true],
		["relative broken", () => "../../arbitrary/missing", false],
	];
	for (const [name, targetFactory, createTarget] of cases) {
		await t.test(name, async (t) => {
			const h = await harness();
			t.after(() => fs.rm(h.root, { recursive: true, force: true }));
			await addLauncher(h, "1.0.0");
			const linkText = targetFactory(h);
			if (createTarget) {
				const resolved = path.isAbsolute(linkText) ? linkText : path.resolve(path.join(h.home, ".local", "bin"), linkText);
				await fs.mkdir(path.dirname(resolved), { recursive: true });
				await fs.writeFile(resolved, "target contents must not be read\n", { mode: 0o000 });
			}
			const launcher = await writeLauncherSymlink(h, linkText);
			await h.lifecycle.install({ migrateCodexLauncher: true });
			await h.lifecycle.uninstall();
			assert.equal(await fs.readlink(launcher), linkText);
		});
	}
});

test("migration rejects unrelated leaf and ancestor symlinks without lifecycle residue", async (t) => {
	await t.test("unrelated leaf", async (t) => {
		const h = await harness();
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addLauncher(h, "1.0.0", { target: "codex-helper" });
		const helper = path.join(h.home, ".local", "bin", "codex-helper");
		await fs.mkdir(path.dirname(helper), { recursive: true });
		await fs.symlink("missing", helper);
		await assert.rejects(() => h.lifecycle.install({ migrateCodexLauncher: true }), /only local_bin:codex/);
		assert.equal(await fs.readlink(helper), "missing");
		await assert.rejects(() => fs.stat(path.join(h.codexHome, ".codex-setup")), { code: "ENOENT" });
	});
	await t.test("ancestor", async (t) => {
		const h = await harness();
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addLauncher(h, "1.0.0");
		const outside = path.join(h.root, "outside-bin");
		await fs.mkdir(path.join(h.home, ".local"), { recursive: true });
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(h.home, ".local", "bin"), "dir");
		await assert.rejects(() => h.lifecycle.install({ migrateCodexLauncher: true }), /symbolic-link component/);
		assert.deepEqual(await fs.readdir(outside), []);
		await assert.rejects(() => fs.stat(path.join(h.codexHome, ".codex-setup")), { code: "ENOENT" });
	});
});

test("failed migrated install restores the exact launcher symlink", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0", { first: true });
	const linkText = "../standalone/current/bin/codex";
	const launcher = await writeLauncherSymlink(h, linkText);
	const originalWrite = h.lifecycle.writeFileOutcome.bind(h.lifecycle);
	let calls = 0;
	h.lifecycle.writeFileOutcome = async (...args) => {
		calls += 1;
		if (calls === 2) throw new Error("synthetic post-launcher failure");
		return originalWrite(...args);
	};
	await assert.rejects(() => h.lifecycle.install({ migrateCodexLauncher: true }), /was rolled back/);
	assert.equal(await fs.readlink(launcher), linkText);
	await assert.rejects(() => fs.stat(path.join(h.codexHome, ".codex-setup", "state.json")), { code: "ENOENT" });
});

test("launcher origin survives update, uninstall rollback, and repeated uninstall", async (t) => {
	const h = await harness("1.0.0");
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0");
	const linkText = "/arbitrary/original/codex";
	const launcher = await writeLauncherSymlink(h, linkText);
	await h.lifecycle.install({ migrateCodexLauncher: true });

	const next = await harness("1.1.0");
	t.after(() => fs.rm(next.root, { recursive: true, force: true }));
	await addLauncher(next, "1.1.0");
	h.lifecycle.repoRoot = next.repo;
	await h.lifecycle.update();
	let state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup", "state.json")));
	assert.equal(state.schema, 4);
	assert.equal(snapshotLinkText(state.resources.find((entry) => entry.targetRoot === "local_bin" && entry.target === "codex").displacedSymlink), linkText);

	await h.lifecycle.uninstall();
	assert.equal(await fs.readlink(launcher), linkText);
	const stateDir = path.join(h.codexHome, ".codex-setup");
	const uninstalled = (await fs.readdir(stateDir)).find((name) => name.startsWith("state.uninstalled-"));
	await h.lifecycle.rollback({ transaction: uninstalled.slice("state.uninstalled-".length, -".json".length) });
	assert.equal((await fs.lstat(launcher)).isFile(), true);
	state = JSON.parse(await fs.readFile(path.join(stateDir, "state.json")));
	assert.equal(snapshotLinkText(state.resources.find((entry) => entry.targetRoot === "local_bin" && entry.target === "codex").displacedSymlink), linkText);
	await h.lifecycle.uninstall();
	assert.equal(await fs.readlink(launcher), linkText);
});

test("manifest removal restores migrated launcher and rollback restores the wrapper", async (t) => {
	const h = await harness("1.0.0");
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0");
	const linkText = "../legacy/current/codex";
	const launcher = await writeLauncherSymlink(h, linkText);
	await h.lifecycle.install({ migrateCodexLauncher: true });
	const next = await harness("1.1.0");
	t.after(() => fs.rm(next.root, { recursive: true, force: true }));
	h.lifecycle.repoRoot = next.repo;
	await h.lifecycle.update();
	assert.equal(await fs.readlink(launcher), linkText);
	const state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup", "state.json")));
	assert.equal(state.resources.some((entry) => entry.targetRoot === "local_bin" && entry.target === "codex"), false);
	await h.lifecycle.rollback();
	assert.equal((await fs.lstat(launcher)).isFile(), true);
});

test("schema-4 launcher metadata rejects drift and malformed combinations without disclosure", async (t) => {
	await t.test("state integrity", async (t) => {
		const h = await harness();
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addLauncher(h, "1.0.0");
		const privateTarget = "../PRIVATE_STATE_TARGET";
		await writeLauncherSymlink(h, privateTarget);
		await h.lifecycle.install({ migrateCodexLauncher: true });
		const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
		const state = JSON.parse(await fs.readFile(statePath));
		state.resources.find((entry) => entry.displacedSymlink).displacedSymlink.byteLength += 1;
		await fs.writeFile(statePath, `${JSON.stringify(state)}\n`);
		await assert.rejects(() => h.lifecycle.uninstall(), (error) => {
			assert.match(error.message, /integrity metadata/);
			assert.doesNotMatch(error.message, /PRIVATE_STATE_TARGET/);
			return true;
		});
	});
	await t.test("transaction integrity and exact current link", async (t) => {
		const h = await harness();
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addLauncher(h, "1.0.0");
		const launcher = await writeLauncherSymlink(h, "../private-transaction-target");
		await h.lifecycle.install({ migrateCodexLauncher: true });
		const state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup", "state.json")));
		const transactionPath = path.join(h.codexHome, ".codex-setup", "backups", state.lastTransaction, "transaction.json");
		const transaction = JSON.parse(await fs.readFile(transactionPath));
		transaction.resources.find((entry) => entry.targetRoot === "local_bin").beforeSnapshot.sha256 = "0".repeat(64);
		await fs.writeFile(transactionPath, `${JSON.stringify(transaction)}\n`);
		await assert.rejects(() => h.lifecycle.rollback(), /integrity metadata/);
		assert.equal((await fs.lstat(launcher)).isFile(), true);
	});
	await t.test("schema and field separation", async (t) => {
		const h = await harness();
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await h.lifecycle.install();
		const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
		const state = JSON.parse(await fs.readFile(statePath));
		const transactionPath = path.join(h.codexHome, ".codex-setup", "backups", state.lastTransaction, "transaction.json");
		const transaction = JSON.parse(await fs.readFile(transactionPath));
		transaction.schema = 3;
		await fs.writeFile(transactionPath, `${JSON.stringify(transaction)}\n`);
		await assert.rejects(() => h.lifecycle.rollback(), /schema-3 transaction contains schema-4 snapshots/);
		transaction.schema = 4;
		const fileRecord = transaction.resources.find((entry) => entry.kind === "file");
		delete fileRecord.beforeSnapshot;
		await fs.writeFile(transactionPath, `${JSON.stringify(transaction)}\n`);
		await assert.rejects(() => h.lifecycle.rollback(), /unsupported snapshot type/);
	});
});

test("schema-3 state and transactions remain readable and upgrade only after successful update", async (t) => {
	await t.test("schema-3 previous state survives schema-4 update rollback", async (t) => {
		const h = await harness("1.0.0");
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await h.lifecycle.install();
		const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
		const legacyState = JSON.parse(await fs.readFile(statePath));
		legacyState.schema = 3;
		await fs.writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, { mode: 0o600 });
		const next = await harness("1.1.0");
		t.after(() => fs.rm(next.root, { recursive: true, force: true }));
		h.lifecycle.repoRoot = next.repo;
		await h.lifecycle.update();
		assert.equal(JSON.parse(await fs.readFile(statePath)).schema, 4);
		await h.lifecycle.rollback();
		assert.equal(JSON.parse(await fs.readFile(statePath)).schema, 3);
	});
	await t.test("schema-3 transaction rollback", async (t) => {
		const h = await harness();
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await h.lifecycle.install();
		const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
		const state = JSON.parse(await fs.readFile(statePath));
		state.schema = 3;
		await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
		const transactionPath = path.join(h.codexHome, ".codex-setup", "backups", state.lastTransaction, "transaction.json");
		const transaction = convertTransactionToSchema3(JSON.parse(await fs.readFile(transactionPath)));
		await fs.writeFile(transactionPath, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
		await h.lifecycle.rollback();
		await assert.rejects(() => fs.stat(path.join(h.codexHome, "skills", "managed", "SKILL.md")), { code: "ENOENT" });
	});
});

test("CLI rejects --migrate-codex-launcher outside install", () => {
	const cli = path.join(import.meta.dirname, "../../scripts/codex-setup.mjs");
	for (const command of ["adopt", "update", "doctor", "rollback", "uninstall", "install-toolchain"]) {
		const result = spawnSync(process.execPath, [cli, command, "--migrate-codex-launcher"], { encoding: "utf8" });
		assert.equal(result.status, 1, command);
		assert.match(result.stderr, /valid only with install/);
	}
});


test("an absent Codex launcher installs normally without migration consent", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	const contents = await addLauncher(h, "1.0.0");
	const launcher = path.join(h.home, ".local", "bin", "codex");
	await h.lifecycle.install();
	assert.deepEqual(await fs.readFile(launcher), contents);
	await h.lifecycle.uninstall();
	await assert.rejects(() => fs.lstat(launcher), { code: "ENOENT" });
});

test("rollback of uninstall verifies the exact restored launcher link", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0");
	const launcher = await writeLauncherSymlink(h, "../original/codex");
	await h.lifecycle.install({ migrateCodexLauncher: true });
	await h.lifecycle.uninstall();
	await fs.unlink(launcher);
	await fs.symlink("../tampered/codex", launcher);
	const stateDir = path.join(h.codexHome, ".codex-setup");
	const uninstalled = (await fs.readdir(stateDir)).find((name) => name.startsWith("state.uninstalled-"));
	const transaction = uninstalled.slice("state.uninstalled-".length, -".json".length);
	await assert.rejects(() => h.lifecycle.rollback({ transaction }), /resource drifted/);
	assert.equal(await fs.readlink(launcher), "../tampered/codex");
});


test("launcher migration revalidates exact symlink text immediately before replacement", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0");
	const linkText = "../same-text/codex";
	const launcher = await writeLauncherSymlink(h, linkText);
	await h.lifecycle.preflightRoots();
	const release = await h.lifecycle.release();
	const toolchains = await h.lifecycle.coupledToolchains();
	const prepared = await h.lifecycle.prepareRelease(release, null, { migrateCodexLauncher: true });
	await fs.unlink(launcher);
	const changedText = "../changed-after-preparation/codex";
	await fs.symlink(changedText, launcher);
	await assert.rejects(() => h.lifecycle.commitTransaction("install", release, prepared, null, toolchains), /changed after preparation/);
	assert.equal(await fs.readlink(launcher), changedText);
	await assert.rejects(() => fs.stat(path.join(h.codexHome, ".codex-setup", "state.json")), { code: "ENOENT" });
});

test("schema-3 state rejects schema-4 launcher fields", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0");
	await writeLauncherSymlink(h, "../private/codex");
	await h.lifecycle.install({ migrateCodexLauncher: true });
	const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
	const state = JSON.parse(await fs.readFile(statePath));
	state.schema = 3;
	await fs.writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	await assert.rejects(() => h.lifecycle.uninstall(), /schema-3 managed state contains schema-4 launcher metadata/);
});


test("launcher migration round-trips non-UTF-8 raw target bytes", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0");
	const rawTarget = Buffer.from([0x2e, 0x2e, 0x2f, 0x72, 0x61, 0x77, 0x2d, 0xff, 0xfe]);
	const launcher = path.join(h.home, ".local", "bin", "codex");
	await fs.mkdir(path.dirname(launcher), { recursive: true });
	await fs.symlink(rawTarget, launcher);
	await h.lifecycle.install({ migrateCodexLauncher: true });
	const state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup", "state.json")));
	const snapshot = state.resources.find((entry) => entry.targetRoot === "local_bin" && entry.target === "codex").displacedSymlink;
	assert.deepEqual(snapshotLinkBytes(snapshot), rawTarget);
	assert.equal(Object.hasOwn(snapshot, "linkText"), false);
	await h.lifecycle.uninstall();
	assert.deepEqual(await fs.readlink(launcher, { encoding: "buffer" }), rawTarget);
});

test("schema-3 uninstall transaction rolls back structurally and preserves unknown config edits", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
	const legacyState = JSON.parse(await fs.readFile(statePath));
	legacyState.schema = 3;
	await fs.writeFile(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, { mode: 0o600 });
	const configPath = path.join(h.codexHome, "config.json");
	const beforeUninstall = JSON.parse(await fs.readFile(configPath));
	beforeUninstall.userBeforeUninstall = true;
	await fs.writeFile(configPath, `${JSON.stringify(beforeUninstall)}\n`, { mode: 0o600 });
	await h.lifecycle.uninstall();
	const stateDir = path.join(h.codexHome, ".codex-setup");
	const uninstalled = (await fs.readdir(stateDir)).find((name) => name.startsWith("state.uninstalled-"));
	const id = uninstalled.slice("state.uninstalled-".length, -".json".length);
	const transactionPath = path.join(stateDir, "backups", id, "transaction.json");
	const transaction = convertTransactionToSchema3(JSON.parse(await fs.readFile(transactionPath)));
	await fs.writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`, { mode: 0o600 });
	const afterUninstall = JSON.parse(await fs.readFile(configPath));
	afterUninstall.userAfterUninstall = true;
	await fs.writeFile(configPath, `${JSON.stringify(afterUninstall)}\n`, { mode: 0o600 });
	await h.lifecycle.rollback({ transaction: id });
	const restored = JSON.parse(await fs.readFile(configPath));
	assert.equal(restored.features.managed, "1.0.0");
	assert.equal(restored.userBeforeUninstall, true);
	assert.equal(restored.userAfterUninstall, true);
	assert.equal(JSON.parse(await fs.readFile(statePath)).schema, 3);
});

test("rollback validates transaction action and version relationships before mutation", async (t) => {
	for (const [name, mutate, pattern] of [
		["action", (transaction) => { transaction.action = "invented"; }, /invalid action/],
		["initial previous state", (transaction) => { transaction.action = "update"; }, /previous state and version disagree/],
		["active version", (transaction) => { transaction.toVersion = "9.9.9"; }, /version disagree/],
	]) {
		await t.test(name, async (t) => {
			const h = await harness();
			t.after(() => fs.rm(h.root, { recursive: true, force: true }));
			await h.lifecycle.install();
			const state = JSON.parse(await fs.readFile(path.join(h.codexHome, ".codex-setup", "state.json")));
			const transactionPath = path.join(h.codexHome, ".codex-setup", "backups", state.lastTransaction, "transaction.json");
			const transaction = JSON.parse(await fs.readFile(transactionPath));
			mutate(transaction);
			await fs.writeFile(transactionPath, `${JSON.stringify(transaction)}\n`, { mode: 0o600 });
			await assert.rejects(() => h.lifecycle.rollback(), pattern);
			assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.0.0\n");
		});
	}
});

test("failure restoration refuses concurrent drift for launcher and merge resources", async (t) => {
	await t.test("launcher", async (t) => {
		const h = await harness();
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addLauncher(h, "1.0.0", { first: true });
		const launcher = await writeLauncherSymlink(h, "../original/codex");
		const originalWrite = h.lifecycle.writeFileOutcome.bind(h.lifecycle);
		let calls = 0;
		h.lifecycle.writeFileOutcome = async (...args) => {
			calls += 1;
			if (calls === 2) {
				await fs.unlink(launcher);
				await fs.symlink("../concurrent/codex", launcher);
				throw new Error("synthetic concurrent failure");
			}
			return originalWrite(...args);
		};
		await assert.rejects(() => h.lifecycle.install({ migrateCodexLauncher: true }), /rollback was incomplete/);
		assert.equal(await fs.readlink(launcher), "../concurrent/codex");
	});
	await t.test("merge resource", async (t) => {
		const h = await harness();
		t.after(() => fs.rm(h.root, { recursive: true, force: true }));
		await addLauncher(h, "1.0.0");
		const configPath = path.join(h.codexHome, "config.json");
		const originalWrite = h.lifecycle.writeFileOutcome.bind(h.lifecycle);
		let calls = 0;
		h.lifecycle.writeFileOutcome = async (...args) => {
			calls += 1;
			if (calls === 3) {
				const config = JSON.parse(await fs.readFile(configPath));
				config.concurrentValue = true;
				await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
				throw new Error("synthetic concurrent failure");
			}
			return originalWrite(...args);
		};
		await assert.rejects(() => h.lifecycle.install(), /rollback was incomplete/);
		assert.equal(JSON.parse(await fs.readFile(configPath)).concurrentValue, true);
	});
});

test("rollback-failure recovery refuses concurrent drift", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const skill = path.join(h.codexHome, "skills/managed/SKILL.md");
	const originalWrite = h.lifecycle.writeFileOutcome.bind(h.lifecycle);
	let calls = 0;
	h.lifecycle.writeFileOutcome = async (...args) => {
		calls += 1;
		if (calls === 2) {
			await fs.mkdir(path.dirname(skill), { recursive: true });
			await fs.writeFile(skill, "concurrent rollback drift\n", { mode: 0o644 });
			throw new Error("synthetic rollback failure");
		}
		return originalWrite(...args);
	};
	await assert.rejects(() => h.lifecycle.rollback(), /restoration was incomplete/);
	assert.equal(await fs.readFile(skill, "utf8"), "concurrent rollback drift\n");
	assert.equal((await h.lifecycle.state()).version, "1.0.0");
});

test("exclusive lifecycle lock rejects an overlapping fresh install without disturbing the winner", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	const second = new Lifecycle({
		repoRoot: h.repo,
		codexHome: h.codexHome,
		dataHome: h.dataHome,
		userHome: h.home,
		localBin: path.join(h.home, ".local", "bin"),
		output: h.output,
		toolchain: h.toolchain,
	});
	const originalWrite = h.lifecycle.writeFileOutcome.bind(h.lifecycle);
	let enteredResolve;
	let resumeResolve;
	const entered = new Promise((resolve) => { enteredResolve = resolve; });
	const resume = new Promise((resolve) => { resumeResolve = resolve; });
	let held = false;
	h.lifecycle.writeFileOutcome = async (...args) => {
		if (!held) {
			held = true;
			enteredResolve();
			await resume;
		}
		return originalWrite(...args);
	};

	const firstInstall = h.lifecycle.install();
	await entered;
	try {
		await assert.rejects(() => second.install(), /another lifecycle operation is already in progress/);
	} finally {
		resumeResolve();
	}
	await firstInstall;
	assert.equal((await h.lifecycle.state()).version, "1.0.0");
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.0.0\n");
	await assert.rejects(() => fs.lstat(path.join(h.codexHome, ".codex-setup", "lifecycle.lock")), { code: "ENOENT" });
});

test("a stale lifecycle lock fails closed and remains unchanged across contenders", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	const lockDir = path.join(h.codexHome, ".codex-setup", "lifecycle.lock");
	const ownerPath = path.join(lockDir, "owner.json");
	await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
	await fs.writeFile(ownerPath, JSON.stringify({
		schema: 1,
		pid: 2147483647,
		token: "a".repeat(32),
		createdAt: "2026-09-16T00:00:00.000Z",
	}) + "\n", { mode: 0o600 });
	const beforeIdentity = await fs.lstat(lockDir);
	const beforeOwner = await fs.readFile(ownerPath);
	const second = new Lifecycle({
		repoRoot: h.repo,
		codexHome: h.codexHome,
		dataHome: h.dataHome,
		userHome: h.home,
		localBin: path.join(h.home, ".local", "bin"),
		output: h.output,
		toolchain: h.toolchain,
	});
	await assert.rejects(() => h.lifecycle.install(), /stale lifecycle lock requires manual inspection and cleanup/);
	await assert.rejects(() => second.install(), /stale lifecycle lock requires manual inspection and cleanup/);
	const afterIdentity = await fs.lstat(lockDir);
	assert.equal(afterIdentity.dev, beforeIdentity.dev);
	assert.equal(afterIdentity.ino, beforeIdentity.ino);
	assert.deepEqual(await fs.readFile(ownerPath), beforeOwner);
	await assert.rejects(() => fs.lstat(path.join(h.codexHome, "skills", "managed", "SKILL.md")), { code: "ENOENT" });
});

test("commit failure recovery preserves an unauthenticated concurrent state", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
	const concurrentState = {
		schema: 4,
		version: "9.9.9",
		platform: "linux-x64",
		toolchain: structuredClone(h.toolchain.current),
		releaseManifestSha256: "9".repeat(64),
		installedAt: "2026-09-16T00:00:00.000Z",
		lastTransaction: "20260916T000000Z-9999999999",
		resources: [],
	};
	const concurrentBytes = Buffer.from(JSON.stringify(concurrentState) + "\n");
	const originalWrite = h.lifecycle.writeFileOutcome.bind(h.lifecycle);
	let calls = 0;
	h.lifecycle.writeFileOutcome = async (...args) => {
		calls += 1;
		if (calls === 2) {
			await fs.writeFile(statePath, concurrentBytes, { mode: 0o600 });
			throw new Error("synthetic concurrent state");
		}
		return originalWrite(...args);
	};
	await assert.rejects(() => h.lifecycle.install(), /rollback was incomplete/);
	assert.deepEqual(await fs.readFile(statePath), concurrentBytes);
});

test("rollback failure recovery preserves an unauthenticated concurrent state", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
	const concurrentState = {
		schema: 4,
		version: "9.9.9",
		platform: "linux-x64",
		toolchain: structuredClone(h.toolchain.current),
		releaseManifestSha256: "8".repeat(64),
		installedAt: "2026-09-16T00:00:00.000Z",
		lastTransaction: "20260916T000000Z-8888888888",
		resources: [],
	};
	const concurrentBytes = Buffer.from(JSON.stringify(concurrentState) + "\n");
	const originalInspect = h.lifecycle.inspectFileLeaf.bind(h.lifecycle);
	h.lifecycle.inspectFileLeaf = async (destination, label) => {
		const inspected = await originalInspect(destination, label);
		if (destination === statePath && label === "managed state" && inspected.snapshot.type === "missing") {
			await fs.writeFile(statePath, concurrentBytes, { mode: 0o600 });
			throw new Error("synthetic rollback state race");
		}
		return inspected;
	};
	await assert.rejects(() => h.lifecycle.rollback(), /restoration was incomplete/);
	assert.deepEqual(await fs.readFile(statePath), concurrentBytes);
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.0.0\n");
});

test("rollback rejects an omitted launcher record before state or payload mutation", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await addLauncher(h, "1.0.0");
	const privateTarget = "../private-omitted-launcher";
	const launcher = await writeLauncherSymlink(h, privateTarget);
	await h.lifecycle.install({ migrateCodexLauncher: true });
	const statePath = path.join(h.codexHome, ".codex-setup", "state.json");
	const stateBytes = await fs.readFile(statePath);
	const launcherBytes = await fs.readFile(launcher);
	const state = JSON.parse(stateBytes);
	const transactionPath = path.join(h.codexHome, ".codex-setup", "backups", state.lastTransaction, "transaction.json");
	const transaction = JSON.parse(await fs.readFile(transactionPath));
	const beforeLength = transaction.resources.length;
	transaction.resources = transaction.resources.filter((record) => !(record.targetRoot === "local_bin" && record.target === "codex"));
	assert.equal(transaction.resources.length, beforeLength - 1);
	await fs.writeFile(transactionPath, JSON.stringify(transaction) + "\n", { mode: 0o600 });
	await assert.rejects(() => h.lifecycle.rollback(), (error) => {
		assert.match(error.message, /resource set does not match/);
		assert.doesNotMatch(error.message, /private-omitted-launcher/);
		return true;
	});
	assert.deepEqual(await fs.readFile(statePath), stateBytes);
	assert.deepEqual(await fs.readFile(launcher), launcherBytes);
});

test("rollback lock prevents a failing concurrent update from changing its selected toolchain", async (t) => {
	const h = await harness("1.0.0");
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const toolchainA = structuredClone(h.toolchain.current);
	const next = await harness("1.1.0");
	t.after(() => fs.rm(next.root, { recursive: true, force: true }));
	const toolchainB = toolchainIdentity("toolchain-b");
	h.toolchain.add(toolchainB);
	h.toolchain.current = structuredClone(toolchainB);
	h.lifecycle.repoRoot = next.repo;
	await h.lifecycle.update();

	const concurrentUpdate = new Lifecycle({
		repoRoot: path.join(h.root, "missing-release-checkout"),
		codexHome: h.codexHome,
		dataHome: h.dataHome,
		userHome: h.home,
		localBin: path.join(h.home, ".local", "bin"),
		output: h.output,
		toolchain: h.toolchain,
	});
	const originalSwitch = h.toolchain.switchToIdentity.bind(h.toolchain);
	let switchedResolve;
	let resumeResolve;
	const switched = new Promise((resolve) => { switchedResolve = resolve; });
	const resume = new Promise((resolve) => { resumeResolve = resolve; });
	let held = false;
	h.toolchain.switchToIdentity = async (identity) => {
		const result = await originalSwitch(identity);
		if (!held && identity.releaseId === toolchainA.releaseId) {
			held = true;
			switchedResolve();
			await resume;
		}
		return result;
	};

	const rollback = h.lifecycle.rollback();
	await switched;
	try {
		await assert.rejects(() => concurrentUpdate.update(), /another lifecycle operation is already in progress/);
		assert.equal(h.toolchain.current.releaseId, toolchainA.releaseId);
	} finally {
		resumeResolve();
	}
	await rollback;
	assert.equal(h.toolchain.current.releaseId, toolchainA.releaseId);
	assert.equal((await h.lifecycle.state()).version, "1.0.0");
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills/managed/SKILL.md"), "utf8"), "# managed 1.0.0\n");
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json"))), {
		features: { managed: "1.0.0" },
	});
});


test("commit refuses a changed toolchain pointer before backup or payload mutation", async (t) => {
	const h = await harness();
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.preflightRoots();
	const release = await h.lifecycle.release();
	const toolchains = await h.lifecycle.coupledToolchains();
	const prepared = await h.lifecycle.prepareRelease(release, null);
	const replacement = toolchainIdentity("toolchain-b");
	h.toolchain.add(replacement);
	h.toolchain.current = structuredClone(replacement);
	await assert.rejects(
		() => h.lifecycle.commitTransaction("install", release, prepared, null, toolchains),
		/active toolchain pointer changed after transaction preparation/,
	);
	assert.equal(h.toolchain.current.releaseId, replacement.releaseId);
	await assert.rejects(() => fs.lstat(path.join(h.codexHome, "skills", "managed", "SKILL.md")), { code: "ENOENT" });
	await assert.rejects(() => fs.lstat(path.join(h.codexHome, ".codex-setup", "state.json")), { code: "ENOENT" });
	await assert.rejects(() => fs.lstat(path.join(h.codexHome, ".codex-setup", "backups")), { code: "ENOENT" });
});

test("uninstall lock prevents a failing concurrent update from stranding rollback", async (t) => {
	const h = await harness("1.0.0");
	t.after(() => fs.rm(h.root, { recursive: true, force: true }));
	await h.lifecycle.install();
	const toolchainA = structuredClone(h.toolchain.current);
	const toolchainB = toolchainIdentity("toolchain-b");
	h.toolchain.add(toolchainB);
	h.toolchain.current = structuredClone(toolchainB);
	const concurrentUpdate = new Lifecycle({
		repoRoot: path.join(h.root, "missing-release-checkout"),
		codexHome: h.codexHome,
		dataHome: h.dataHome,
		userHome: h.home,
		localBin: path.join(h.home, ".local", "bin"),
		output: h.output,
		toolchain: h.toolchain,
	});
	const originalInspect = h.lifecycle.inspectFileLeaf.bind(h.lifecycle);
	let preparedResolve;
	let resumeResolve;
	const prepared = new Promise((resolve) => { preparedResolve = resolve; });
	const resume = new Promise((resolve) => { resumeResolve = resolve; });
	let held = false;
	h.lifecycle.inspectFileLeaf = async (destination, label) => {
		const inspected = await originalInspect(destination, label);
		if (!held && label.startsWith("managed target ")) {
			held = true;
			preparedResolve();
			await resume;
		}
		return inspected;
	};

	const uninstall = h.lifecycle.uninstall();
	await prepared;
	try {
		await assert.rejects(() => concurrentUpdate.update(), /another lifecycle operation is already in progress/);
		assert.equal(h.toolchain.current.releaseId, toolchainB.releaseId);
	} finally {
		resumeResolve();
	}
	await uninstall;
	assert.equal(h.toolchain.current.releaseId, toolchainB.releaseId);
	const stateDir = path.join(h.codexHome, ".codex-setup");
	const uninstalledState = (await fs.readdir(stateDir)).find((name) => name.startsWith("state.uninstalled-"));
	assert.ok(uninstalledState);
	const id = uninstalledState.slice("state.uninstalled-".length, -".json".length);
	const transaction = JSON.parse(await fs.readFile(path.join(stateDir, "backups", id, "transaction.json")));
	assert.equal(transaction.toToolchain.releaseId, toolchainB.releaseId);
	await h.lifecycle.rollback({ transaction: id });
	assert.equal(h.toolchain.current.releaseId, toolchainA.releaseId);
	assert.equal((await h.lifecycle.state()).version, "1.0.0");
	assert.equal(await fs.readFile(path.join(h.codexHome, "skills", "managed", "SKILL.md"), "utf8"), "# managed 1.0.0\n");
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.codexHome, "config.json"))), {
		features: { managed: "1.0.0" },
	});
});
