# Review Priorities

Date: 2026-05-13

Implementation status: the first hardening pass implements the top three items: `lth verify` with `done` blocking, atomic JSON writes plus file-based run locks, and safer Codex cwd/sandbox defaults. The next pass wires schema-backed validation and `schemaVersion` migration checks into runtime loading.

This document records the verified review of the current Longtask Harness repo. The main finding is that the repo has a strong protocol shape, but several load-bearing pieces are still written as conventions instead of executable contracts.

## Verified Findings

| Priority | Finding | Verification | Recommended fix |
|---|---|---|---|
| P0 | Completion claims are not verified. | `lth record --status done` writes `checkpoint.status = "done"` without checking `task.successCriteria` or evidence. | Add `lth verify <task-dir>` and reject `record --status done` unless verification passes. |
| P0 | Persistent writes and locks are interruption-fragile. | `.lth.lock/` is created with atomic `mkdir`, but `lock.json`, `checkpoint.json`, and `task.json` are written directly to final paths. A crash can leave partial state or an orphan lock directory. | Use temp-file-plus-rename for durable JSON writes and replace the lock directory with an atomic `O_EXCL` lock file. |
| P0/P1 | Codex worker defaults are too permissive for a safety-oriented harness. | `buildCodexCommand` defaults to `--ask-for-approval never` and `--sandbox workspace-write`. Hard constraints such as "Do not start Codex inside ~/.openclaw" are plain text only. | Default Codex to `read-only`; require explicit opt-in for `workspace-write`; enforce forbidden cwd patterns before spawning Codex. |
| P1 | JSON schemas are not connected to validation. | `schemas/*.schema.json` exist, but `loadAndValidate` only performs a small hand-written subset and does not check `schemaVersion === 1`. | Add AJV or a small local subset validator, and give explicit migration guidance for unknown schema versions. Initial subset validator now exists. |
| P1 | Failure classification uses broad substring matching. | `expected` or `received` classify arbitrary stack traces as `test_failure`; `api` can over-classify sources as `external-api`; reset timing is not provider-specific. | Move classification into a core module with prioritized rules, confidence tests, provider-specific reset parsing, and a realistic sample set. |
| P1 | Classification can erase better worker-written recovery context. | `applyClassification` always replaces `checkpoint.nextStep` with a generic default. | Preserve a worker-updated `nextStep` and only use classifier defaults when the worker did not write one. |
| P1 | Worker prompts are too thin. | `buildWorkerPrompt` only includes title, objective, phase, next step, and a few checkpoint fields. The worker is told to read task files, but Codex runs in the target repo cwd, not the task directory. | Inline taskDir, success criteria, hard constraints, key context, recent blocker state, and evidence expectations. |
| P2 | Multi-task operation is not modeled yet. | There is no task root, `lth ls`, `lth status --all`, cross-task priority, or quota primitive. | Add a task-root view and cross-task status commands after core single-task contracts are hardened. |
| P2 | Observability is per-task only. | Run events are written under each task's `runs/YYYY-MM-DD.jsonl`, but there is no aggregate `tail`, `summary`, or rate-limit report. | Add `lth tail`, `lth summary`, and aggregate reports once event semantics settle. |
| P2 | Cross-worker resume is only lightly simulated. | Smoke tests fake Codex and Kimi fallback, but there is no recorded real-world multi-worker resume fixture. | Add a demo run with real logs, evidence, and a handoff from one worker to another. |
| P3 | Documentation has started drifting. | README contains English and Chinese versions with different Quick Start content and inconsistent execution-mode wording. | Keep one canonical doc flow or make translated sections generated/short. |
| P3 | Small CLI polish items remain. | `--flag=value` is unsupported; HTTP-date `Retry-After` is unsupported; `package.json` lacks `files`; session lookup uses a fixed time pad. | Address as cleanup after the load-bearing protocol fixes. |

## Recommended PR Order

1. Implement `lth verify` and block unverified `done` writes.
2. Make persistent writes and run locks atomic.
3. Harden Codex worker defaults and forbidden cwd enforcement.
4. Wire schema validation and `schemaVersion` migration checks into `loadAndValidate`.
5. Extract and test failure classification with realistic samples.
6. Preserve worker-authored `nextStep` when applying classifier output.
7. Strengthen worker prompt generation.
8. Add observability and multi-task commands.
9. Record and commit a real demo run.

## Portfolio Assessment

The positioning is strong: this is a small protocol primitive, not another broad agent framework. The code is readable, and the OpenClaw/Codex/Kimi shape is specific enough to be credible. The missing proof is operational hardness: verified claims, interruption-safe state, enforceable safety boundaries, and a recorded real task run.

The first three fixes move the repo from "reference scaffold" toward a runtime primitive that can be trusted during interrupted long tasks.
