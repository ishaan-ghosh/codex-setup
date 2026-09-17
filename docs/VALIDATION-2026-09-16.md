# Validation report: 2026-09-16

## Candidate

- Release: 0.1.0
- Host: Ubuntu 24.04.4 LTS, Linux 6.8.0-137-generic, x86_64
- Isolated root: /tmp/codex-setup-v1-final.7TV1JE
- Retained schema-3 compatibility HOME: /tmp/codex-setup-v1-final.7TV1JE/home-schema3
- Published base revision: `ebc38802a6bf92a0e143ee841ca5f471d21b9a92`
- Current profile-transport compatibility hotfix: uncommitted
- Managed release: 47 artifacts and 11 skills
- Toolchain: Node.js 22.22.0, Codex CLI 0.154.0, Playwright MCP 0.0.81, pinned Chromium

## Automated evidence

The integrated local suite was run with:

    npm run check

The current profile-transport hotfix was run locally with the same command.
Result: 155 tests passed, zero failed; tracked secret hygiene was clean; and the
release manifest verified all 47 managed artifacts plus all 11 skill
directories. The added isolated coverage exercises explicit launcher migration,
dry-run privacy, arbitrary live/broken absolute/relative targets including
non-UTF-8 target bytes, failure and rollback restoration, exact two-fresh-install
serialization, stale-lock fail-closed ABA preservation, rollback/update and
uninstall/update toolchain-pointer serialization, pre-mutation pointer
authentication, dry-run uninstall nonmutation, state and payload recovery drift
refusal, rollback resource-set completeness, update carry-forward, manifest
removal, uninstall rollback/repeat, transaction action/version and metadata
drift, and schema-3/schema-4 compatibility. Schema-5 coverage additionally
exercises structural JSON/TOML config migration, collected path-only conflicts,
strict scalar allowlisting, per-value integrity metadata, non-migratable MCP
commands/arguments and hook enablement, combined launcher/config rollback,
displaced-value update carry, manifest removal, repeated uninstall/rollback,
and absent-state doctor
wording. Schema-6 coverage adds Mac-shaped structural profile merging,
existing-only project-trust/TUI preservation, initial rollback, uninstall,
idempotence, schema-3 through schema-5 prior-file transition, state-bound
transition-mode tamper rejection, lossless signed 64-bit TOML integers,
lossless decimal-float lexemes including signed zero and very large exponents,
reserved-marker collision and multiline-injection rejection, nested generated
literal round-trips, out-of-range seconds rejection, empty managed-root/table
and legacy-transition refusal, preservation of pre-existing empty ancestor
tables, setup-created-container pruning and state-metadata tamper rejection,
conservative legacy handling when container ownership metadata is absent,
post-transition unknown-key refusal, and rejection of every unrelated resource
kind change. Profile-local MCP tables are additionally required to declare one
complete standalone transport so Codex can validate configuration writes while
any profile is active. Existing incompatible stdio/HTTP transport and unsupported
runtime fields are rejected before install or update mutation, including when
managed-config migration is requested, while fields accepted by both transports
remain user-owned. Adversarial regressions also cover bidirectional carried-displacement
binding and retained predecessor-lineage checks against active/current-record
omission or schema relabeling. These are local consistency checks, not
cryptographic authentication against wholesale lineage rewriting.

Every bundled skill was also validated with the installed skill-creator
quick_validate.py. Shell syntax checks and git diff --check passed.

CI run
[35244737726](https://github.com/ishaan-ghosh/codex-setup/actions/runs/35244737726)
completed successfully on 2026-09-17. Its Ubuntu 24.04 Node tests, macOS 14 Node
tests, Arch AMD64 adapter, and tracked-secret-hygiene jobs were all green. That
run validates published base revision `ebc3880`; it does not validate this
uncommitted profile-transport hotfix.

## Real Ubuntu lifecycle evidence

Multiple fresh isolated HOME, CODEX_HOME, and CODEX_SETUP_DATA_HOME fixtures were
used. The final schema-3 rollback, reinstall, and doctor run used the retained
`/tmp/codex-setup-v1-final.7TV1JE/home-schema3` HOME. Earlier bootstrap and
update checks used sibling fixtures under the same isolated root. No live
credentials, sessions, memories, or browser profiles were read.

The following paths were exercised:

1. bin/bootstrap downloaded the pinned Node archive, verified its SHA-256,
   installed the exact npm lock and pinned Chromium, and wrote a schema-2
   executable inventory.
2. A repeated bootstrap downloaded a fresh verified transient Node runtime,
   authenticated the existing toolchain receipt and executable inventory, and
   selected the already-installed exact toolchain without reinstalling it.
3. codex-setup install --dry-run enumerated 47 planned resources without
   installing them.
4. codex-setup install completed, and doctor reported 47 resources and the
   toolchain healthy.
5. The managed launcher reported codex-cli 0.154.0.
6. codex mcp list reported the Playwright MCP enabled through the managed
   wrapper.
7. browser-smoke.mjs initialized the MCP server with 26 tools and verified
   loopback navigation, DOM snapshot, click behavior, console output, network
   observation, screenshot capture, the direct-origin guardrail, and shutdown.
   Redirects are explicitly not treated as a containment boundary.
8. The installed read-policy wrapper denied a compound unbounded read that
   attempted to mask itself with a later search command.
9. In the retained `home-schema3` fixture, a full payload rollback completed,
   followed by a clean reinstall and a healthy doctor result.

10. A deliberately stale component-lock and toolchain combination was rejected
    before payload mutation; re-bootstrap of the final lock followed by update and
    doctor completed successfully.

## Real macOS canary evidence

On Apple Silicon macOS, bootstrap reused the verified pinned
`22.22.0-darwin-arm64` toolchain. The combined launcher/config migration dry-run
and install completed, doctor verified all 47 resources and the toolchain, and
the managed launcher reported Codex CLI 0.154.0. The `dev` and `review` profiles
started with their declared models. Initial rollback completed and restored the
exact original launcher symlink target; a subsequent reinstall and doctor also
completed successfully.

Trying to trust the installed hooks from the `review` profile then failed before
the trust write with `invalid transport in mcp_servers.playwright`. An isolated
Codex 0.154.0 app-server reproduction confirmed that a profile-local MCP table
containing only `enabled` or `args` cannot be validated independently, while the
same table with a complete stdio transport can. No hook trust was applied. The
profile fragments now carry complete standalone transports, and merge
preparation rejects preserved incompatible or unsupported runtime fields
before mutation; publication and a real-machine hook-trust rerun remain pending.

## Release-review evidence

An independent Sol review found two high, six medium, and two low/test-gap
findings in the initial candidate. The candidate was not committed. The
findings were remediated and regression tests were added for exact-checkout
updates, toolchain-coupled rollback, executable receipt tampering, mode drift,
equal managed configuration, fixed browser modes, symlinked browser paths, and
compound Bash reads.

A separate blind and bounded QA review before push found whole-config backup
retention, rollback symlink revalidation, pre-commit toolchain restoration,
direct loopback-origin guardrail coverage, and ambient npm optional-dependency gaps; Playwright redirects remain outside the origin allowlist by design.
Those findings were fixed with retained regressions before publication.

## Not yet validated

- A real CachyOS AMD64 canary is required before using this setup as the primary
  local installation.
- The macOS 14 and Arch AMD64 adapter jobs are green in CI run 35244737726, but
  that run predates this profile-transport hotfix.
- The real macOS lifecycle canary passed combined migration dry-run, install,
  doctor, profile launch, rollback with byte-exact launcher restoration,
  reinstall, and a second doctor. Hook trust under `review` exposed the
  incomplete profile-local MCP transport fixed by this candidate; the
  interactive `/hooks` trust write must be rerun after publication.
- Hook trust through the interactive `/hooks` screen must be reviewed on each
  machine after first install or a hook change.
- The authenticated-browser profile was not exercised and no login state was
  created.
- A real update between two published tags cannot be run until a second release
  exists. The exact-checkout update and coupled toolchain rollback paths have
  isolated regression coverage.
- Linux ARM64, WSL, desktop, cloud, and repo-wide editor integration remain
  intentionally deferred.
