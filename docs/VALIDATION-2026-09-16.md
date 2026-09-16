# Validation report: 2026-09-16

## Candidate

- Release: 0.1.0
- Host: Ubuntu 24.04.4 LTS, Linux 6.8.0-137-generic, x86_64
- Isolated root: /tmp/codex-setup-v1-final.7TV1JE
- Final schema-3 lifecycle HOME: /tmp/codex-setup-v1-final.7TV1JE/home-schema3
- Managed release: 47 artifacts and 11 skills
- Toolchain: Node.js 22.22.0, Codex CLI 0.154.0, Playwright MCP 0.0.81, pinned Chromium

## Automated evidence

The integrated local suite was run with:

    npm run check

Result: 56 tests passed, zero failed, and the release manifest verified all 47
managed artifacts plus all 11 skill directories.

Every bundled skill was also validated with the installed skill-creator
quick_validate.py. Shell syntax checks and git diff --check passed.

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
- macOS Apple Silicon and Arch adapter paths were not run on this Ubuntu host;
  their CI jobs have not run because the candidate has not been pushed.
- Hook trust through the interactive /hooks screen must be reviewed on each
  machine after first install or a hook change.
- The authenticated-browser profile was not exercised and no login state was
  created.
- A real update between two published tags cannot be run until a second release
  exists. The exact-checkout update and coupled toolchain rollback paths have
  isolated regression coverage.
- Linux ARM64, WSL, desktop, cloud, and repo-wide editor integration remain
  intentionally deferred.
