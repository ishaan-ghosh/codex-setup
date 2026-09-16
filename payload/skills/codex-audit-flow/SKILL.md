---
name: codex-audit-flow
description: Run a human-gated commit, PR, stack, or multi-repository audit with immutable snapshots, blind review, evidence-bound verification, and neutral .audit artifacts.
---

# Codex Audit Flow

Use this skill before shipping review gates or when the user explicitly requests
an audit. Read the repository instructions and selected `.audit/` profile first.
The parent Codex session is the sole orchestrator for one audit directory.

## Neutral layout

Tracked inputs live under `.audit/profiles/` and `.audit/prompts/`. Generated
private artifacts live under ignored `.audit/local/audits/<audit-id>/`. Do not
mirror the run under `.codex/`, `.claude/`, or `.pi/`, and do not use symlinked
artifact roots. Honor a project's explicitly documented legacy fallback only
while migrating it to `.audit/`.

## Required lifecycle

1. Establish the exact review unit and explicit base/head refs for PR/stack runs.
2. Start the repository's installed/shared audit helper if one exists. It must
   bind a `git-worktree-v2` snapshot: refs/OIDs, staged and unstaged diff
   digests, ordered raw tracked/untracked manifests, bytes, modes, symlink text,
   and missing state. Reject drift, parent symlinks, special files, unmerged
   entries, tracked gitlinks, unignored artifacts, and audit-ID collisions.
3. Generate distinct primary, blind-peer, and final-diff prompts with dispatch
   IDs and SHA-256 digests. The blind peer gets no primary report/path or
   repository-controlled private fragments.
4. Dispatch a read-only primary reviewer. Record the actual tool, model, session,
   prompt, report, dispatch ID, target digest, and completion time.
5. Dispatch and record the blind peer before comparing reports. A finding is
   confirmed only when two independent runs directly inspect the target evidence.
   Primary-only, peer-only, disputed, or final-diff-only findings need a fresh
   focused verifier with its own prompt, report, identity, and dispatch.
6. Dispatch the separate adversarial final-diff reviewer after primary and peer.
   It is a whole-target shipping gate and does not automatically count as a
   second finding verifier.
7. Keep human accepted/rejected/deferred decisions separate from review output.
   Only after approval may a scoped writer fix accepted findings. Any change
   invalidates the snapshot and requires a fresh audit.
8. Finalize only after nonempty `findings.json` and `receipt.md` exist. Revalidate
   snapshot, prompt/report digests, identities, stage chronology, finding enum,
   exact reviewer keys/artifacts, and final status.

## Safety and evidence

Reviewers may run safe, targeted inspection, tests, linters, typechecks, and
read-only schema checks. Ask separately before Docker/service lifecycle, GPU or
physical robot work, secrets, production systems, GitHub posting, commits when
not already authorized, pushes, merges, tags, or releases.

Never put secrets, private endpoints, raw payloads/captures, customer data, or
sensitive logs in tracked prompts, reports, receipts, or PR packets. Report exact
commands and observed results; unverified claims remain open questions.

Read [audit-contract.md](references/audit-contract.md), [audit-metadata.md](references/audit-metadata.md), [findings-schema.md](references/findings-schema.md), and [profile-schema.md](references/profile-schema.md) when creating or checking metadata, findings, profiles, or finalization artifacts.
