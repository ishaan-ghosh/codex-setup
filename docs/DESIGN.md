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
so unknown values cannot influence retained managed metadata.

Toolchain release directory identities include both the component-lock and npm package-lock digests, so either exact lock changing selects a distinct immutable path. Bootstrap delegates this identity entirely to the JavaScript installer.

Install and update use staging plus atomic replacement. Updates perform a
three-way ownership check:

1. the previous manifest says the path is owned;
2. ordinary-file bytes match their installed digest, or every managed
   configuration value matches its recorded structural value;
3. the destination is not reached through a symlink.

If any check fails, the command stops without overwriting the path. Install and
update also require the current toolchain receipt to match the checkout locks.
If bootstrap selected a new toolchain but release loading or payload preparation
fails, update restores the toolchain recorded by the active state; dry-run never
switches it. Transactions bind previous and current toolchain identities.
Rollback prevalidates the previous release, checks every destination for
symlinks before reads and immediately before mutations, then atomically selects
the previous toolchain before changing payload files. Uninstall removes only
proven-owned, unchanged files.

## Configuration model

`config.toml` is merged structurally. Unknown tables and user values remain
untouched. The setup owns only the keys declared in `payload/config/managed.toml`.
Transaction records for JSON/TOML merge targets store only managed-path
before/after presence and declared values plus file-level mode and creation
metadata. They never retain whole merged bytes or unknown user values, so
rollback reverses managed paths against the current document rather than
overwriting unrelated edits. Profiles are separate top-level
`*.config.toml` files, matching current Codex profile behavior.

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
