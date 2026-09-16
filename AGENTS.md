# Codex Setup Contributor Guide

This repository builds a reproducible personal Codex CLI environment. Treat the
installer, manifests, and generated configuration as security-sensitive code.

## Scope

- V1 supports macOS Apple Silicon, Ubuntu 24.04 AMD64, and CachyOS/Arch AMD64.
- V1 owns only resources recorded in its installation state. It must not copy,
  back up, inspect, or remove authentication, sessions, memories, logs, caches,
  browser profiles, or secret values.
- Keep application Playwright suites project-local. The setup-owned browser is
  for MCP use and harness diagnostics.

## Engineering standard

- Prefer evidence over inference. State exactly what was and was not run.
- Fail closed on unknown platforms, checksum mismatches, symlinked mutation
  paths, ownership ambiguity, merge conflicts, and tracked secret-like files.
- Preserve unknown user configuration and stop on conflicting managed values.
- Keep the shell entrypoint small. Put structural data handling in testable
  JavaScript modules.
- Search before broad reads and keep generated or machine-local state out of the
  repository.

## Validation

Run `npm test` for the full local suite. New installer behavior needs an
isolated temporary `CODEX_HOME` test, an idempotence test, and a failure-path
test when practical. Skill changes must pass the installed `quick_validate.py`.

## Publication boundary

Auto mode may make validated local commits. Pushes, PR creation or updates,
merges, tags, and releases each require separate explicit approval. Destructive
history edits, branch or worktree deletion, external writes, credential access,
and non-loopback services also remain explicitly gated.
