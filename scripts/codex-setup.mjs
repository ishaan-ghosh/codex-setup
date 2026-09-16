#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Lifecycle } from "../lib/lifecycle.mjs";
import { ToolchainInstaller } from "../lib/toolchain-installer.mjs";

function usage() {
	return `Usage: codex-setup [--dry-run] <command> [options]

Commands:
  install [--release PATH] [--migrate-codex-launcher]
                                 Install an exact checksummed release
  update [--release PATH]        Update from this exact reviewed checkout
  doctor                         Verify owned resources without printing contents
  rollback [--transaction ID]    Restore a checksummed transaction backup
  uninstall                      Remove only resources owned by managed state
  adopt [--release PATH]         Adopt exact matching existing files and merge config
  install-toolchain [--skip-browser]
                                 Install the pinned isolated toolchain

Global options:
  --dry-run                      Plan without filesystem writes
  --migrate-codex-launcher       Preserve and replace an existing ~/.local/bin/codex symlink (install only)
  --help                         Show this help
`;
}

function parse(argv) {
	const args = [...argv];
	let repoRoot;
	let dryRun = false;
	let command;
	const options = {};
	while (args.length) {
		const token = args.shift();
		if (token === "--repo-root") repoRoot = args.shift();
		else if (token === "--dry-run") dryRun = true;
		else if (token === "--release") options.release = args.shift();
		else if (token === "--transaction") options.transaction = args.shift();
		else if (token === "--skip-browser") options.skipBrowser = true;
		else if (token === "--migrate-codex-launcher") options.migrateCodexLauncher = true;
		else if (token === "--help" || token === "-h") options.help = true;
		else if (token.startsWith("-")) throw new Error(`unknown option: ${token}`);
		else if (!command) command = token;
		else throw new Error(`unexpected argument: ${token}`);
	}
	if (options.migrateCodexLauncher && command !== "install") throw new Error("--migrate-codex-launcher is valid only with install");
	if (!repoRoot) repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
	return { repoRoot: path.resolve(repoRoot), dryRun, command, options };
}

async function main() {
	const parsed = parse(process.argv.slice(2));
	if (parsed.options.help) { process.stdout.write(usage()); return 0; }
	if (!parsed.command) { process.stdout.write(usage()); return 2; }
	const home = process.env.HOME;
	if (!home || !path.isAbsolute(home)) throw new Error("HOME must be an absolute path");
	const codexHome = path.resolve(process.env.CODEX_HOME || path.join(home, ".codex"));
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && !path.isAbsolute(xdgDataHome)) throw new Error("XDG_DATA_HOME must be absolute when set");
	const configuredDataHome = process.env.CODEX_SETUP_DATA_HOME;
	if (configuredDataHome && !path.isAbsolute(configuredDataHome)) throw new Error("CODEX_SETUP_DATA_HOME must be absolute when set");
	const dataHome = path.resolve(configuredDataHome || path.join(xdgDataHome || path.join(home, ".local", "share"), "codex-setup"));
	if (parsed.command === "install-toolchain") {
		const installer = new ToolchainInstaller({ repoRoot: parsed.repoRoot, dataHome, dryRun: parsed.dryRun });
		await installer.install(parsed.options);
		return 0;
	}
	const lifecycle = new Lifecycle({
		repoRoot: parsed.repoRoot,
		codexHome,
		dataHome,
		userHome: home,
		localBin: path.join(home, ".local", "bin"),
		dryRun: parsed.dryRun,
	});
	if (parsed.command === "install") { await lifecycle.install(parsed.options); return 0; }
	if (parsed.command === "adopt") { await lifecycle.install({ ...parsed.options, adopt: true }); return 0; }
	if (parsed.command === "update") return lifecycle.update(parsed.options);
	if (parsed.command === "doctor") return lifecycle.doctor();
	if (parsed.command === "rollback") { await lifecycle.rollback(parsed.options); return 0; }
	if (parsed.command === "uninstall") { await lifecycle.uninstall(); return 0; }
	throw new Error(`unknown command: ${parsed.command}`);
}

try {
	process.exitCode = await main();
} catch (error) {
	console.error(`codex-setup: ${error.message}`);
	process.exitCode = 1;
}
