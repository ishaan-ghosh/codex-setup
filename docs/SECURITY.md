# Security model

## Protected state

The installer must not read, copy, back up, hash, or remove:

- Codex authentication, sessions, history, memories, logs, or caches;
- API keys, OAuth tokens, GitHub credentials, SSH keys, or environment values;
- Playwright storage-state files or persistent browser-profile contents.

Presence-only health checks are allowed. Diagnostics must redact values and
avoid printing raw configuration from user files.

## Filesystem changes

Mutation paths are resolved component by component and rejected when a symlink
is present. The sole exception is explicit migration of the fixed
`local_bin:codex` leaf during fresh install. Its ancestors remain symlink-free;
the leaf is inspected only with `lstat`/`readlink`, its target is never opened,
and its exact type, raw target bytes, device, and inode are checked immediately
before same-directory atomic replacement. The same rules apply to absolute, relative,
live, and broken targets. Every other leaf symlink remains rejected.

Rollback checks every managed destination before reading it and again
immediately before each mutation. Lifecycle writes use transaction backups and
per-file atomic replacement; launcher restoration uses a temporary symlink and
same-directory rename and never chmods a symlink. Toolchain releases are staged
and atomically selected. Mode `0700` transaction directories may retain
mode-`0600` full-byte backups for ordinary managed files. Schema-4 state and
transactions may also retain bounded base64 of the migrated launcher's exact
raw target bytes plus their length and SHA-256, always in local mode-`0600`
files. Diagnostics and dry-runs never print or decode those bytes. JSON/TOML
merge targets instead retain only
managed-path presence, value, mode, and creation deltas; rollback reconstructs
those paths structurally while preserving unknown current keys. Unknown user
configuration values are never copied into lifecycle state or backups, and
merge resources never retain a digest of the whole user document.

The transaction record is durably written before payload mutation and caught
in-process failures attempt reverse-order payload and toolchain restoration.
Non-dry-run update and uninstall preparation plus all mutating commit and
rollback phases
hold an exclusive local lifecycle lock. Strict mode-`0600` owner metadata is
validated without exposing it. Live, dead, and malformed owners fail closed;
stale locks require manual inspection and cleanup. The lifecycle never removes
an observed lock, avoiding stale-observation replacement of a newer owner.
State observed before mutation and state written by the operation are both
authenticated before any failure-path replacement. Every payload recovery
replacement likewise verifies that the live leaf still exactly matches the
outcome written by that operation;
concurrent drift is left untouched and reported as incomplete restoration.
Rollback rejects a transaction whose resource keys omit or add anything
relative to the action-specific current/previous state set before mutation.
As with ordinary managed files, this is not a claim of automatic recovery from
`SIGKILL`, kernel failure, or power loss: there is no startup journal replay.
After such an interruption, preserve `$CODEX_HOME/.codex-setup`, inspect state
and transaction metadata, and reconcile before rerunning a lifecycle command.

Existing regular files are unmanaged until explicitly adopted. Adoption
requires an exact content match or an intentional conflict-resolution step.
Symlink migration is separate explicit consent and is not supported by
`adopt`.

## Browser safety

- Default sessions are isolated and headless.
- Automatically named browser output belongs in the setup's machine-local data
  directory. Explicit evidence paths inside a repository must be ignored or
  intentionally reviewed before tracking.
- Persistent authenticated state lives outside repositories with mode `0700`.
- One authenticated profile must not be used concurrently.
- External browser writes require explicit approval.
- The setup wrapper binds MCP transport to loopback and accepts only the three named modes; caller-supplied Playwright flags are rejected.
- `local-test` is for trusted loopback fixtures. Its pinned `--allowed-origins` list guards direct navigation to loopback origins, but Playwright MCP explicitly does not apply it to redirects. All modes must therefore be treated as network-capable and MCP is not a security boundary.
- `web-research` and the explicit authenticated mode intentionally permit browser navigation to external hosts while keeping MCP transport on loopback.
- Output and authenticated-profile paths are checked component-by-component and rejected if any component is a symlink.

## Dependency integrity

Versions and integrity values live in `component-lock.json` and the npm
lockfile. Downloads go to setup-owned temporary files, are verified before
extraction, and are promoted only after health checks. Schema-versioned toolchain directory names bind bounded prefixes of both exact lock digests; a package-lock-only change cannot collide with an older release. A schema-versioned
receipt records checksums for the Node, npm, Codex, Playwright MCP, native
package, and browser executables discovered after that verified install. Reuse
and doctor recompute the inventory. Bootstrap never executes an existing local
runtime; it runs the installer with a fresh transient Node extracted from the
archive whose checksum is pinned in the checkout. Package lifecycle scripts are
disabled. The npm install uses installer-owned empty user and global npmrc files,
discards ambient `npm_config_*` values, and explicitly includes optional
dependencies. The supported platform's exact Codex native package and executable
must match the lock, and a bounded `codex --version` identity check must pass
before a receipt is written or the release is promoted. The Playwright browser
download is a separate explicit step.

Linux system browser dependencies are reported, not installed implicitly.
Their package-manager command requires a separate approval.

## Reporting concerns

Do not include secrets, private endpoints, browser cookies, or raw session
artifacts in an issue. Report the setup version, platform, failing command,
redacted doctor output, and whether the failure reproduces with a fresh
temporary `CODEX_HOME`.
