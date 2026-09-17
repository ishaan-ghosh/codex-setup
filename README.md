# codex-setup

Reproducible Codex CLI setup for macOS Apple Silicon, Ubuntu 24.04 AMD64, and
CachyOS/Arch AMD64. It provides pinned tooling, portable guidance, specialized
agents, reusable engineering workflows, safe profiles, memories, and an
isolated Playwright MCP browser.

This repository is pre-release. Until the `v0.1.0` tag exists, bootstrap test
installs from a reviewed `main` commit. After the first release, install from the
reviewed tag rather than `main`.

## What it manages

- A pinned, setup-owned Node/Codex/Playwright MCP toolchain under
  `~/.local/share/codex-setup/toolchains/` (or `$XDG_DATA_HOME`).
- Named files under `${CODEX_HOME:-~/.codex}`: global guidance, profiles,
  custom agents, and hooks.
- Namespaced personal skills under `~/.agents/skills`, including the five
  reviewed Superpowers workflows and their vendored MIT license.
- A checksum inventory, backups, and rollback metadata under
  `$CODEX_HOME/.codex-setup/`.
- Pinned `codex`, Playwright MCP, and policy launchers under `~/.local/bin`.

It does **not** manage `auth.json`, sessions, memories, history, logs, caches,
credentials, browser login state, or repository-local editor settings.

## Bootstrap

The supported bootstrap is intentionally inspectable; there is no `curl | sh`
path.

```sh
git clone --branch main --depth 1 \
  git@github.com:ishaan-ghosh/codex-setup.git
cd codex-setup
./bin/bootstrap
./bin/codex-setup install --dry-run
./bin/codex-setup install
./bin/codex-setup doctor
~/.local/bin/codex --version
```

Before running a release, compare the checked-out tag/commit and release
checksums with the published release metadata. The installer verifies every
download and managed file before promotion. Ensure `~/.local/bin` precedes any
other Codex installation on `PATH`. After first install or any hook change, open
`/hooks` in Codex and review/trust the exact user hook definition.

If `CODEX_HOME` already exists, it is respected. Otherwise Codex's default
`~/.codex` is used. Existing unknown settings are preserved; conflicting
managed settings stop for review instead of being overwritten.
The four setup profiles are structural TOML merge targets, so pre-existing
project trust entries, TUI state, and other undeclared profile settings survive
install, rollback, update, and uninstall. Only paths declared by the matching
`payload/profiles/*.config.toml` fragment become setup-owned.
The supported structural syntax reserves the quoted key `$tomlLiteral` for its
validated internal date/time, decimal-float, and large-integer representation;
encountering that key in user TOML or JSON fails before lifecycle mutation.
Empty tables remain valid when user-owned, but are rejected in setup-managed
fragments or legacy whole-file transition inputs because they have no leaf path
that the ownership record can represent. Schema 6 also records which non-empty
table containers it created, so removal prunes only those containers when they
become empty and preserves pre-existing user tables.

`bootstrap` owns only the pinned setup runtime and Chromium installation. The
lifecycle `install` command owns payload files and launchers. If
`~/.local/bin/codex` is already a symlink, ordinary install stops without
following or replacing it. Review the dry-run, then explicitly migrate that one
launcher with:

```sh
./bin/codex-setup install --dry-run --migrate-codex-launcher
./bin/codex-setup install --migrate-codex-launcher
```

Migration is valid only for `install` and only for the exact
`~/.local/bin/codex` leaf. It accepts absolute, relative, live, or broken link targets without reading or
executing them. The exact raw target bytes are retained as bounded base64 plus
length and SHA-256 integrity metadata in mode-`0600` lifecycle state and are restored by failed install,
initial rollback, manifest removal, or uninstall. Symlinked ancestors and every
other managed symlink remain closed conflicts. Dry-run reports the migration
without printing or decoding the link target bytes.

An existing scalar value at a repository-declared config path remains a closed
conflict by default. After reviewing the path-only dry-run, a fresh install may
explicitly preserve and replace low-risk policy settings with:

```sh
./bin/codex-setup install --dry-run --migrate-managed-config
./bin/codex-setup install --migrate-managed-config
```

This install-only flag covers allowlisted model/reasoning/approval strings,
non-executable boolean feature and memory settings, and typed agent policy
settings, consistent with the top-level policy concepts in the official Codex
configuration reference. MCP commands/arguments, `features.hooks`, and other
executable- or credential-capable fields are never auto-migrated. Diagnostics
print paths, not values; rollback and uninstall restore displaced values.

## Daily profiles

```sh
codex --profile dev
codex --profile dev-net
codex --profile review
```

- `dev`: workspace-write, interactive/Auto-review escalation, command network
  disabled.
- `dev-net`: workspace-write with network enabled and isolated public browser
  research.
- `review`: Sol at high reasoning, read-only, browser disabled.

Profile files follow the same fail-closed conflict rule as `config.toml`.
Existing-only paths are preserved automatically; a different value at a
setup-declared path still requires the explicit managed-config migration flag
and remains subject to its strict non-executable allowlist.
Profile-local MCP overrides include a complete standalone transport so Codex
configuration writes, including hook trust, remain valid with any profile active.
An existing server definition with incompatible transport or unsupported runtime
fields is rejected before mutation instead of being combined into an invalid or
ambiguous configuration.

The base model is Astra at high reasoning. Plan mode can be raised to xhigh
interactively. Context gathering defaults to Luna; complex implementation and
all formal review roles use Sol. The setup caps concurrent subagents at three.

## Browser modes

The pinned Playwright MCP wrapper supports:

```sh
codex-playwright-mcp local-test
codex-playwright-mcp web-research
codex-playwright-mcp authenticated-browser
```

`local-test` is the default: isolated, headless Chromium with automatic output
under the setup's machine-local data directory. It is intended only for trusted
loopback fixtures; its pinned MCP `--allowed-origins` setting guards direct
navigation, but does not constrain redirects, so local-test is not a network
security boundary. Treat every MCP mode as network-capable. `web-research` is
also isolated and is selected by `dev-net`. `authenticated-browser` is an
explicit opt-in profile using a dedicated machine-local browser directory; do
not sync it, share it between concurrent sessions, or treat MCP as a security
boundary.

Application browser tests remain project-local. Each application should pin
its own `@playwright/test` version and configuration. To verify the setup-owned
MCP against a local fixture after bootstrap, run `npm run test:browser`.

## Lifecycle

```sh
./bin/codex-setup doctor

# Acquire the exact next tag in a separate shallow checkout.
git clone --branch v0.2.0 --depth 1 \
  git@github.com:ishaan-ghosh/codex-setup.git ../codex-setup-v0.2.0
cd ../codex-setup-v0.2.0
./bin/bootstrap
./bin/codex-setup update --dry-run
./bin/codex-setup update
./bin/codex-setup doctor

./bin/codex-setup rollback
./bin/codex-setup uninstall --dry-run
```

`update` never discovers or executes remote content. It applies the exact
`release.json` and payload in the reviewed checkout that runs it. This makes
updates work from shallow tagged clones: acquire and review the requested tag,
run that checkout's bootstrap to select its checksummed toolchain, then dry-run
and apply its release. Rollback verifies and atomically restores the previous
recorded toolchain pointer before restoring payload files. Retain the old
checkout until rollback is no longer needed.

Uninstall removes only files whose current bytes still match the recorded
owned version. Modified files and ambiguous ownership stop for review. Use the
explicit `adopt` command to bring a pre-existing matching resource under
management.

## Authentication and secrets

Use normal `codex login` with browser login on macOS/CachyOS or device auth on
headless Ubuntu. API-key auth is optional and is never provisioned by this
repository. GitHub CLI authentication is separate. MCP configuration may name
environment variables but must not contain their values.

The doctor reports only whether expected variables or files are present. It
must never print credential values.

## Development and validation

```sh
npm test
npm run check
```

See [testing](docs/TESTING.md), [security](docs/SECURITY.md), and the
[architecture record](docs/DESIGN.md). Ubuntu and Arch paths run in CI; macOS
ARM64 runs natively in CI. A real CachyOS install is the release canary.

Deferred work is tracked in GitHub issues: Linux ARM64
[#1](https://github.com/ishaan-ghosh/codex-setup/issues/1), WSL
[#2](https://github.com/ishaan-ghosh/codex-setup/issues/2), shared harness core
[#3](https://github.com/ishaan-ghosh/codex-setup/issues/3), IDE
[#4](https://github.com/ishaan-ghosh/codex-setup/issues/4), desktop
[#5](https://github.com/ishaan-ghosh/codex-setup/issues/5), cloud
[#6](https://github.com/ishaan-ghosh/codex-setup/issues/6), editor settings
[#7](https://github.com/ishaan-ghosh/codex-setup/issues/7), and frontend-design
capability [#8](https://github.com/ishaan-ghosh/codex-setup/issues/8).
