# V1 architecture record

## Goals

The setup should produce the same intentional Codex CLI environment on each
supported machine while preserving local authentication and repository-owned
instructions. It adapts the mature workflows from `claude-code-setup` and
`pi-dev-setup` without coupling v1 to a three-repository refactor.

## Ownership model

The repository is a declaration, not a backup of `$CODEX_HOME`. A release
manifest identifies every managed source, destination, mode, and SHA-256
digest. Installed state records the release, ordinary-file installed digests,
managed configuration paths and values, modes, and the exact validated
toolchain identity.
It deliberately records no whole-document digest for JSON/TOML merge targets,
so unknown values cannot influence retained managed metadata. Schema 4 added a
single typed displaced-symlink snapshot for an explicitly migrated
`local_bin:codex` launcher. That private snapshot contains bounded base64 of
exact raw target bytes, byte length, and digest; it is carried through updates
until restored by manifest removal or uninstall. Schema 5 adds typed, bounded,
per-value length/SHA-256 metadata only for explicitly displaced allowlisted
scalar config paths. It never retains a whole config document, its digest, or
unknown keys. Schema 6 adds a narrowly scoped representation transition from an
exact-checksummed, setup-owned top-level `*.config.toml` file to structural TOML
ownership. It also records which table containers were created to hold managed
leaves, allowing removal to prune only those containers after they become empty.
Schema-3 through schema-5 state and transactions remain readable and upgrade
only when a later update commits successfully; absent legacy container metadata
is interpreted conservatively and does not authorize ancestor pruning.
Rollback also cross-checks an embedded previous state against its retained
predecessor transaction. This detects omission or legacy relabeling when the
predecessor remains intact; it is a consistency check, not authentication.

Toolchain release directory identities include both the component-lock and npm package-lock digests, so either exact lock changing selects a distinct immutable path. Bootstrap delegates this identity entirely to the JavaScript installer.

Install and update use staging plus atomic replacement. Updates perform a
three-way ownership check:

1. the previous manifest says the path is owned;
2. ordinary-file bytes match their installed digest, or every managed
   configuration value matches its recorded structural value;
3. the destination is not reached through a symlink.

The only exception is a fresh `install --migrate-codex-launcher` for the exact
`local_bin:codex` leaf. Its ancestors must still be real directories. The leaf
is inspected with `lstat` and `readlink`, without dereferencing its target, then
its exact type, raw target bytes, device, and inode are revalidated immediately
before same-directory atomic replacement. All other leaf symlinks remain rejected.


A second fresh-install exception, `--migrate-managed-config`, can replace a
conflicting declared leaf only when both old and new values are safe scalars on
the strict model/reasoning/approval string, non-executable boolean
feature/memory, and typed agent-policy allowlist. Structural ancestor conflicts
and MCP command/argument fields remain closed; `features.hooks` is also excluded
because enabling it activates installed commands. Updates carry an existing
displacement while the path remains managed and restore it when the manifest
drops the path; they cannot create a new displacement.
If any check fails, the command stops without overwriting the path. Install and
update also require the current toolchain receipt to match the checkout locks.
If bootstrap selected a new toolchain but release loading or payload preparation
fails, update restores the toolchain recorded by the active state; dry-run never
switches it. Transactions bind previous and current toolchain identities.
Non-dry-run update and uninstall preparation plus all mutating commit and
rollback phases
hold a setup-local exclusive lifecycle lock. After taking that lock they
authenticate the exact active-state snapshot used by the operation; failure
recovery restores state only when the live file is still that snapshot or the
exact outcome written by the current operation. Live, dead, and malformed lock
owners all fail closed. Stale locks require manual inspection and cleanup; the
lifecycle never removes an observed lock and therefore cannot replace a newer
owner through a stale-observation race.
Rollback prevalidates the previous release, requires transaction resource keys
to equal the action-specific state-derived set, checks every destination for
symlinks before reads and immediately before mutations, then atomically selects
the previous toolchain before changing payload files. Symlink restoration uses
a temporary link plus same-directory rename and never applies `chmod` to the
link. Uninstall removes only proven-owned, unchanged files, except that it
restores a recorded migrated launcher link after verifying the managed wrapper.

## Configuration model

`config.toml` is merged structurally. Unknown tables and user values remain
untouched. The setup owns only the keys declared in `payload/config/managed.toml`.
Transaction records for JSON/TOML merge targets store only managed-path
before/after presence and declared values plus file-level mode and creation
metadata. Active schema-6 state additionally stores setup-created container
paths; rollback uses the active and previous states' respective container
ownership. They never retain whole merged bytes or unknown user values, so
rollback reverses managed paths against the current document rather than
overwriting unrelated edits. Profiles are separate top-level
`*.config.toml` files, matching current Codex profile behavior, and are TOML
merge targets rather than byte-owned files. Existing-only project trust, TUI,
and other local paths remain outside setup ownership.

An update from the pre-schema-6 whole-file profile representation is permitted
only for a declared `payload/profiles/<name>.config.toml` target whose live
bytes and mode still match its prior state. The transition transaction retains
that already-owned file as a mode-`0600` rollback backup and records the new
managed-path delta. It never backs up an unmanaged fresh-install profile. A
rollback to the old whole-file state fails closed if user-only paths were added
after the representation transition, because the old state cannot represent
those paths without silently discarding them. Uninstall under the new state
removes only declared profile paths and preserves later unknown edits.

Global `AGENTS.md` stays concise. Detailed workflows live in namespaced skills.
Repositories retain authority through their nearest `AGENTS.md`, contribution
guide, ADRs, and CI configuration.

## State model

- Repository work state follows the repository's declared root.
- Otherwise reuse an existing authoritative `.agent/local/` root.
- Reuse `.pi/local/` or legacy `.claude/local/` only when repository guidance
  declares it authoritative.
- New repositories default to `.agent/local/`.
- Audits always use the neutral `.audit/local/` root.

Generated memories are useful recall, not authoritative evidence. They remain
machine-local and are disabled when external context is active.

## Agent routing

- Astra: primary orchestration, planning, reconciliation, and difficult
  reasoning. High by default; xhigh in Plan mode; max is deliberate opt-in.
- Luna: bounded context gathering and mechanical implementation.
- Sol: ambiguous or cross-cutting implementation and all formal reviews.

The custom roles are `repo_explorer`, `github_researcher`, `web_researcher`,
`mechanical_worker`, `complex_worker`, `reviewer`, and `audit_verifier`.

## Publication boundary

Auto mode handles routine work within the active sandbox, including validated
local commits. Push, PR mutation, merge, tags, and releases are independent
approval points. Destructive history edits, credentials, production, external
writes, hardware, and non-loopback services also remain human-gated.

## Browser model

The setup-owned Playwright MCP serves agentic browsing and harness smoke tests.
It is not a security boundary. Deterministic work uses isolated headless
contexts. Authenticated use requires a separately selected profile and a
dedicated unsynced browser directory. Application E2E dependencies remain in
the application repository.
