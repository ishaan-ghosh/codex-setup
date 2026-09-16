# Neutral audit contract

This is the Codex adapter summary of the proven audit-flow contract used by
`claude-code-setup` and `pi-dev-setup`. The shared helper remains authoritative
when installed; this file is only the routing and artifact reference.

## Artifact set

Use one ignored `.audit/local/audits/<audit-id>/` directory containing, as needed:

```text
audit.yml
primary-reviewer-prompt.md
primary-initial.md
peer-review-prompt.md
peer-review.md
verification-<name>-prompt.md
verification-<name>.md
final-diff-reviewer-prompt.md
final-diff-review.md
synthesis.md
final-human-reviewed.md
final-plan.md
findings.json
receipt.md
```

The parent owns the directory. Never overwrite an existing audit ID or redirect
paths through symlinks. The complete future artifact directory must be ignored.

## Snapshot and provenance

`audit.yml` must bind every selected Git repository to `git-worktree-v2`, retaining
resolved refs/OIDs, binary staged/unstaged diff digests, ordered stage-0 index
metadata, raw tracked worktree bytes/modes, raw untracked bytes/modes, symlink
link text, and explicit missing state. Revalidate before every stage record and
at finalization. Any drift requires a new audit.

Every reviewer run requires:

- a stable reviewer key (`primary`, `peer`, `final_diff`, or a verifier key);
- unique dispatch and completed-session IDs;
- nonempty tool, model, session, prompt, and report;
- SHA-256 prompt/report digests;
- exact dispatched artifact paths;
- a structural attestation binding reviewer key, dispatch, target snapshot,
  prompt digest, report digest, artifact, and completion time.

Primary, peer, and final-diff completion times must be ordered. Focused verifiers
must not predate primary and peer. Fixed reports are immutable and pairwise
distinct. These are local structural attestations, not cryptographic proof of
authorship, independence, blindness, direct inspection, or model cognition.

## Findings

Each retained finding needs nonempty `id`, `title`, `impact`, and `evidence`, plus:

```json
{
  "severity": "critical|high|medium|low",
  "confidence": "confirmed|likely|speculative|question",
  "status": "candidate|unverified|accepted|rejected|deferred|needs_more_info|fixed|partially_fixed|still_open|verified|commented",
  "recommended_action": "fix|comment|defer|ignore|investigate",
  "source": ["primary", "peer"],
  "verification": {
    "required": 2,
    "artifacts": ["primary-initial.md", "peer-review.md"]
  }
}
```

`source` must contain at least two concrete completed reviewer keys whose reports
directly inspect the same target evidence. Every cited report must appear in
`verification.artifacts`, have distinct hashes, and have complete provenance.
Single-reviewer concerns stay in open questions until independently verified.
Unresolved findings require final status `blocked`; deferred findings require
`passed_with_deferred` or `blocked`, never `passed`.

## Trust boundary

The human remains the trust boundary. A valid receipt proves that local metadata
and artifact bytes satisfy the structural checks; it does not prove that a
declared reviewer actually ran independently or inspected the target.
