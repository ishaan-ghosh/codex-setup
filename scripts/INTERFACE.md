# Lifecycle release interface

`bin/codex-setup` is a POSIX launcher. It prefers the setup-owned Node runtime at
`~/.local/share/codex-setup/toolchains/current/node/bin/node`, then falls back to
`node` for repository development. Runtime provisioning is an explicit `install-toolchain` operation performed by
`bin/bootstrap`. Bootstrap uses a transient archive-verified Node and delegates
versioned release-ID derivation to the installer; the ID binds both component
and npm package-lock digests. `CODEX_SETUP_NODE` and `CODEX_SETUP_DATA_HOME` are explicit
bootstrap integration points.

The default release is repository-root `release.json`; `--release PATH`
selects another already-local manifest whose source paths remain relative to the
current reviewed checkout. The lifecycle performs no remote discovery. To
update, acquire the exact target tag in a separate checkout, run that
checkout's bootstrap, then run its `update` command. Source paths are
repository-relative:

```json
{
  "schema": 1,
  "version": "1.0.0",
  "artifacts": [
    {
      "source": "payload/skills/example/SKILL.md",
      "target_root": "user_home",
      "target": ".agents/skills/example/SKILL.md",
      "sha256": "lowercase 64-character digest",
      "kind": "file",
      "mode": "0644",
      "platforms": ["darwin-arm64", "ubuntu-24.04-amd64", "arch-amd64"]
    }
  ]
}
```

Target roots are `codex_home` (default), `user_home`, and `local_bin`.
Kinds are `file`, `json-merge`, and `toml-merge`. Config fragments must be
objects/tables. A managed key may be added or already have the exact requested
value; a different user value is a closed conflict. Unknown user keys survive
install, update, and uninstall. The deliberately conservative TOML parser
rejects multiline strings, multiline arrays, and arrays of tables instead of
editing a syntax it cannot prove safe.

State and transaction backups live under `$CODEX_HOME/.codex-setup`.
Byte-owned file resources store their installed SHA-256 and mode; merge
resources store their managed paths and mode. State and transactions also bind
the release to a validated toolchain receipt and executable checksum inventory.
Schema 4 introduced typed missing/file/symlink transaction snapshots. Schema 5
adds bounded typed displaced-value metadata for explicitly migrated config
leaves. Each entry carries canonical byte length and SHA-256 integrity data;
whole config bytes/digests and unknown keys are never retained. Schema-3 and
schema-4 read/rollback/update compatibility remains strict.

A fresh `install --migrate-codex-launcher` may replace only an existing
`local_bin:codex` leaf symlink. It records bounded base64 of the exact raw
target bytes privately for rollback, update carry-forward, manifest removal, and uninstall. The flag is
invalid with every other command, including `adopt`; without it the symlink is
an actionable closed conflict. No link target is dereferenced, executed,
allowlisted by shape, decoded for diagnostics, or printed.

A fresh `install --migrate-managed-config` may replace conflicting declared
leaves only on the low-risk scalar allowlist: model/reasoning/approval strings,
non-executable boolean feature/memory settings, and typed scalar agent settings.
Structural ancestors, `features.hooks`, MCP commands/arguments, and executable- or
credential-capable fields remain closed conflicts. Dry-run and diagnostics list
paths only. Existing displacement is carried through updates, restored on
manifest removal/uninstall, and reapplied correctly by rollback. The flag is
invalid for adopt, update, doctor, rollback, uninstall, and install-toolchain.

Update, rollback, doctor, and uninstall refuse payload, mode, pointer, link, or
toolchain drift. The lifecycle never targets authentication, sessions, memories,
logs, caches, browser profiles, or secrets.
