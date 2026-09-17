# Test strategy

## Layers

1. Unit tests cover manifest parsing, structural TOML merging, path validation,
   platform detection, checksums, and redaction.
2. Contract tests install into a temporary `CODEX_HOME` and data root, repeat
   the install for idempotence, mutate one managed file to verify conflict
   handling, then exercise rollback and uninstall. Launcher-migration contracts
   cover absent launchers, explicit consent, dry-run privacy, absolute/relative
   and live/broken targets, no-dereference behavior, unrelated and ancestor
   symlinks, failure restoration, update carry-forward, manifest removal,
   uninstall rollback, repeated uninstall, metadata drift, transaction
   action/version relationships, exact rollback resource-set completeness,
   two-fresh-install serialization, stale-lock fail-closed ABA preservation,
   rollback/update and uninstall/update toolchain-pointer serialization,
   pre-mutation pointer authentication, state and payload recovery drift
   refusal, dry-run uninstall nonmutation, non-UTF-8 target bytes, and schema-3
   and schema-4 install/update/uninstall rollback compatibility. Managed-config
   migration contracts cover JSON and TOML structural replacement, ordinary
   fail-closed conflicts, path-only dry-run output, schema-5 private metadata,
   combined launcher/config restoration, update carry-forward, manifest
   removal, uninstall/rollback repetition, tamper and misplaced-metadata
   rejection, predecessor-lineage consistency, active/current-record omission
   and schema-relabel rejection, CLI scope, and non-migratable MCP
   command/argument and hook-enablement conflicts.
   Profile contracts use Mac-shaped project-trust and TUI keys to verify
   value-free dry runs, unknown-key preservation, idempotence, initial rollback,
   uninstall, and schema-3 through schema-5 whole-file to schema-6 structural
   transition. The transition tests also prove unrelated kind changes remain
   rejected and that rollback fails before mutation when a post-transition
   unknown key cannot be represented by the prior byte-owned state. Valid
   signed 64-bit TOML integers beyond JavaScript's safe range and decimal floats
   such as signed zero or very large exponents retain their exact lexemes through
   profile lifecycle rewrites. Reserved internal-literal marker collisions in
   TOML and JSON fail before mutation, while validated generated date/time,
   float, and large-integer markers round-trip through arrays and inline tables;
   malformed, out-of-range, and multiline markers are rejected. Empty managed
   roots, nested tables, and legacy transition inputs fail before mutation.
   Existing user-owned empty ancestors survive install, rollback, and uninstall;
   setup-created containers are recorded, pruned only when empty, and checked for
   missing or misplaced state metadata.
3. Toolchain tests verify exact Node, Codex, Playwright MCP, and Chromium
   identities without changing the host toolchain. Executed regressions tamper
   with runtime, package, and platform-native Codex executables and prove
   bootstrap and receipt validation reject them. A hostile ambient npm
   `omit=optional` setting is stripped, optional packages are explicitly
   included, and a missing native package cannot be certified. A
   package-lock-only fixture verifies that both exact lock digests participate
   in the immutable release path.
4. Browser smoke tests launch a local fixture and verify initialization,
   navigation, snapshot, click, screenshot, console/network evidence, and clean
   shutdown.
5. Secret-hygiene tests scan tracked files and captured output for forbidden
   storage paths and credential-shaped values without reading live secrets.

## Platform coverage

- Ubuntu 24.04 AMD64: CI plus a real install on the current development host.
- Arch AMD64: container coverage for the pacman adapter.
- CachyOS AMD64: required real-machine release canary.
- macOS Apple Silicon: native CI runner.

Linux ARM64 and WSL intentionally fail with a clear unsupported-platform
message in v1.

## Local browser smoke

After `./bin/bootstrap` and `./bin/codex-setup install`, run:

```sh
npm run test:browser
```

This starts a trusted loopback fixture, initializes the installed Playwright MCP,
launches the pinned headless Chromium, navigates, captures a DOM snapshot, clicks
a button, verifies the state change, checks console and network evidence, captures
a screenshot, and verifies that a directly navigated non-allowlisted loopback
origin is rejected before any request reaches its fixture. The origin test is only
a direct-navigation guardrail: pinned MCP redirects are not constrained, so this
smoke test is not evidence of network isolation and does not contact an external
site.

## Release validation boundary

CI runs unit, contract, manifest, skill-frontmatter, and secret-hygiene checks only. It does not download the managed Node/Codex/Playwright toolchain, launch Chromium, or exercise a real browser session. The release gate therefore requires the separate CachyOS AMD64 canary below (and an equivalent Ubuntu/macOS check when practical); its redacted report is the evidence for real toolchain and browser behavior.

## macOS launcher-migration canary

On a Mac with the current standalone Codex link at `~/.local/bin/codex`, retain
its exact raw link-target bytes privately, run migration dry-run, install with
`--migrate-codex-launcher`, run doctor and the managed launcher version check,
then exercise uninstall or initial rollback and confirm `readlink` returns the exact original bytes. This real-home canary remains required even when the
isolated cross-platform regression suite is green.

The same canary must retain pre-existing `dev.config.toml` and
`review.config.toml` project-trust/TUI paths while adding only the declared
profile paths. Reports list paths and outcomes, never profile values.

## CachyOS first-use canary

For a pre-existing low-risk managed config conflict, first run the path-only
`install --dry-run --migrate-managed-config`. Review every reported path, then
run `install --migrate-managed-config` (optionally combined with launcher
migration), doctor, rollback/uninstall, and confirm only the displaced declared
paths return to their original typed values. Never put config values in the
report. The real macOS canary remains pending until this sequence completes on
Apple Silicon.

1. Record OS, architecture, shell, existing Codex path, and `CODEX_HOME`
   without printing secrets.
2. Run the installer against an alternate temporary `CODEX_HOME` in dry-run
   mode, then install.
3. Run the full doctor and local browser fixture smoke test.
4. Repeat install to prove idempotence; exercise rollback.
5. Review the report and back up the real setup-owned paths.
6. Install into the real `CODEX_HOME`, then use it for one representative
   repository task.

Retain the redacted canary report with the release evidence. A container is
useful adapter coverage but is not a substitute for this canary.

## Evidence format

Every test report records the exact command, exit status, observed result,
platform, setup revision, what was not run, and remaining risk. A passing unit
suite is not described as browser or end-to-end validation.
