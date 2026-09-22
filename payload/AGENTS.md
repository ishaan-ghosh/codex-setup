# Shared Codex operating rules

This file is the global template for the Codex setup. Project instructions remain
the source of truth for project-specific language, architecture, validation, and
workflow.

## Instruction precedence

Follow the highest applicable authority in this order:

1. System, platform, and user instructions.
2. The nearest applicable `AGENTS.md`; a deeper repository or subtree file
   supplements and can refine a parent file.
3. Project `CLAUDE.md`, `CONTEXT.md`, `CONTRIBUTING.md`, ADRs, and task-local
   instructions, using them for domain language and decisions.
4. This global template and Codex skills.

If instructions conflict, preserve the higher-priority rule and surface the
conflict. Do not silently choose unresolved architecture, domain, safety, data,
or repository-boundary decisions; ask one focused question with a recommendation.

## Orchestration and routing

- Read the applicable repository instructions and domain context before changing
  code. Load sibling-repository context only when the task crosses that boundary.
- Use `codex-tdd` for behavior-first implementation, `codex-diagnose` for bugs
  and regressions, `codex-grill-with-docs` for unresolved plans and terminology,
  `codex-improve-architecture` for architectural friction, and `codex-to-prd`
  for issue-tracker-ready product requirements.
- Use `codex-audit-flow` before push, PR review, merge, or other shipping gates.
- Keep one parent session responsible for the plan, approvals, synthesis, and
  handoff. Luna subagents handle bounded context gathering, repository
  exploration, and mechanical work. Sol handles reviews and adversarial
  verification; give each only the context needed for its role.
- Model IDs and reasoning settings are configured in Codex TOML, including each
  custom agent definition. Repository instructions guide role selection but do
  not rewrite those settings; honor the selected role's configured model and
  surface conflicts with repository-requested routing.
- Reviewers and verifiers are read-only for application code. A writer/worker
  starts only after the user accepts findings and the requested write scope.

## State, evidence, and handoffs

- Use the harness-neutral `.audit/` root for tracked audit profiles/prompts and
  ignored `.audit/local/audits/` for generated audit evidence.
- Use ignored `.agent/local/` for progress ledgers and resumable handoffs. Do not
  create competing Codex, Claude, or Pi ledgers when the repository defines a
  neutral root. Honor legacy `.pi/` or `.claude/` paths only when that project
  explicitly requires them during migration.
- Report exact changed files, commands, observed results, and unverified gaps.
  Never claim a test, browser run, review, or external action that was not run.
- Keep secrets, credentials, private endpoints, raw customer/robot data, raw
  captures, and sensitive logs out of tracked files and receipts.

## Automation boundaries

Routine local inspection, editing, validation, and local commits may proceed when
the task authorizes the work. Ask separately immediately before:

- push, PR creation/update, merge, tag, release, or externally visible comments;
- destructive or difficult-to-recover actions;
- production or third-party writes, credential changes, secret access, Docker or
  hardware/GPU operations, physical robot actuation, or long-running jobs.
  Reversible local Docker inspection and test lifecycle work is routine auto-mode
  when within the task scope; destructive Docker actions, persistent volume
  changes, production containers, published images, and external services remain
  separately gated.

Browser automation may inspect local applications and run approved tests. Treat
login, purchases, account changes, data submission, or any external mutation as a
separate approved action. Prefer Playwright for real browser validation when it is
available, and record the exact browser command and result.
