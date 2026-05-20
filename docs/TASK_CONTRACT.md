# Task Contract

Longtask Harness uses three canonical files.

The current schema version is `1`. `lth validate`, `lth verify`, `lth next`, `lth run`, `lth record`, and related commands load the JSON schemas under `schemas/` and reject unsupported versions with an explicit migration message.

## task.json

Defines the intended outcome.

Important fields:

- `id`: stable task identifier.
- `title`: short human label.
- `domain`: `coding`, `video-analysis`, `research`, or another domain.
- `objective`: the outcome the worker is trying to produce.
- `successCriteria`: verifiable completion checks. Items can be strings or structured criteria with `id`, `description`, `metric`, `target`, and `weight`.
- `constraints`: safety, scope, quality, privacy, time, or budget constraints. Items can be strings or structured constraints with `id`, `description`, `type`, and `category`.
- `context`: stable background information the worker needs on every run.
- `context.repoPath` or `context.repository`: trusted local repository path for coding workers.
- `scheduler`: scheduler adapter config, such as `type: "openclaw-cron"`, cadence, scheduler model, and scheduler timeout.
- `workerPolicy`: preferred and allowed worker adapters. It may also set `lockTtlSeconds` for `lth run` leases and `fallbackOnRateLimit` for a backup worker.
- `evidencePolicy`: optional checkpoint evidence retention settings. `checkpointWindow` controls how many recent evidence items stay inline in `checkpoint.json`; `archivePath` defaults to `evidence/checkpoint-evidence-archive.jsonl`.
- `localWorker`: command, working directory, and timeout for `lth run --worker local-command`.
- `codexWorker`: working directory, model, sandbox, local OSS provider, and timeout for `lth run --worker codex-cli`.
- `kimiWorker`: working directory, model, and timeout for `lth run --worker kimi-cli` or Kimi fallback runs.
- `rateLimitPolicy`: rate-limit sources, fallback wait time, and whether lightweight handoff work may continue.

`lth init` can write these fields up front and immediately check the configured scheduler and workers:

```bash
node src/cli.js init tasks/my-coding-task \
  --scheduler openclaw-cron \
  --worker codex-cli \
  --fallback-worker kimi-cli \
  --cwd /path/to/trusted/repo \
  --check
```

## checkpoint.json

Defines the current resumable state.

Important fields:

- `status`: `active`, `paused`, `blocked`, `done`, or `needs-human`.
- `currentPhase`: current phase name.
- `nextStep`: the next concrete action.
- `blockedUntil`: ISO timestamp or `null`.
- `blocker`: structured reason for `blocked` or `needs-human`, including type, source, message, and retry timing.
- `lastCompletedStep`: concise summary of the last verified step.
- `activeFiles`: files or artifacts most relevant to the next run.
- `openQuestions`: unresolved questions that may affect the next slice.
- `evidence`: recent references to tests, screenshots, logs, clips, or review notes.
- `evidenceArchive`: archive metadata for older evidence rolled out of the checkpoint.
- `workerCooldowns`: per-worker cooldown windows, usually from rate limits. A task may keep running on a fallback worker while `codex-cli` is cooling down, then return to `codex-cli` after its `blockedUntil` expires.

For Codex CLI rate limits, `evidence` may include a `codex-session` item whose `path` points at the local `.codex/sessions/...jsonl` trace. Treat that trace as raw recovery evidence; keep the checkpoint focused on status, blocker, next step, and evidence pointers.

`checkpoint.evidence` is a rolling window, not an unlimited history. By default the harness keeps the newest 50 evidence items inline. Older items are appended to `evidence/checkpoint-evidence-archive.jsonl` as JSONL records and summarized in `checkpoint.evidenceArchive`. Verification reads both the archive and the inline window, so old manual or output evidence can still satisfy success criteria without making every future prompt carry the full evidence list.

`status: "done"` is claim-checked. `lth verify <task-dir>` evaluates every success criterion, and `lth record --status done` refuses to write unless the same verification passes. Command criteria run their target command; `output_contains` criteria search recorded evidence text; manual criteria require evidence with a matching `criterionId`.

Evidence items have a small shared contract:

- `type`: required evidence kind, such as `worker-output`, `codex-session`, or `review-note`.
- `path`: optional path to an evidence file or external trace.
- `manifestPath`: optional path to the JSON manifest written by `lth evidence`.
- `criterionId`: optional success criterion satisfied by this evidence.
- `criteria`: optional list of success criterion ids.
- `observedAt`: optional ISO timestamp for when the evidence was captured.
- `source`, `command`, `exitCode`, `status`, `text`, `output`, `note`, and `summary`: optional fields used by worker output, manual review, and failure evidence.

## runs/*.jsonl

Defines append-only execution events.

Important event types:

- `tick_started`: scheduler woke up and evaluated the task.
- `run_skipped`: task was not runnable, usually because `blockedUntil` is still in the future.
- `worker_prompt_generated`: the harness produced the bounded worker prompt for the next slice.
- `worker_started`: the harness started a worker process for one bounded slice.
- `worker_completed`: the worker process exited successfully and output was captured under `evidence/`.
- `worker_failed`: the worker process exited unsuccessfully and output was captured under `evidence/`.
- `progress_recorded`: a human or worker updated task progress.
- `failure_classified`: worker output was classified as an auth error, test failure, missing context, or unknown failure.
- `rate_limited`: a worker or adapter hit a rate limit.
- `checkpoint_written`: the harness or worker persisted resumable state.
- `handoff_written`: a human-readable handoff note was written.
- `needs_human`: automation stopped because human judgment is required.
- `evidence_recorded`: `lth evidence` wrote a manifest and appended it to checkpoint evidence.

## evidence manifests

`lth evidence <task-dir>` records structured evidence under `evidence/` and appends the same item to `checkpoint.evidence`.

```bash
node src/cli.js evidence tasks/my-coding-task \
  --type test \
  --path evidence/test-output.txt \
  --criterion-id tests-pass \
  --status pass \
  --command "npm test" \
  --summary "Smoke suite passed."
```

Supported evidence types are `test`, `screenshot`, `video-clip`, `transcript`, `benchmark`, `review-note`, `worker-output`, `codex-session`, `handoff`, and `artifact`.

## harness.md

Defines operating rules for human and AI workers.

This is where project-specific safety rules, verification commands, and handoff expectations live.

## .lth.lock

Runtime-only lease created atomically by `lth run` before a worker starts.

This lock is not durable task state. It prevents overlapping workers from writing the same checkpoint and run log at the same time. If the lock has not expired, a second `lth run` returns `decision: "wait"`. If the lock has expired, the next run retires it and creates a fresh lease.

## Codex safety defaults

`codex-cli` runs with `--sandbox read-only` unless `task.codexWorker.sandbox` or `--sandbox` explicitly opts into a broader sandbox. The harness refuses to start any worker in default forbidden working directories such as the home directory, `~/.ssh`, `~/.openclaw`, `~/.claude`, and `~/.codex`. Tasks can add `forbiddenCwdPatterns` under a worker config, `workerPolicy`, or individual constraints.

In the default read-only sandbox, Codex CLI is not expected to write `checkpoint.json` itself. The worker still receives the checkpoint contract and should report enough output for recovery, but `lth run` owns the durable write after the worker exits: it captures worker output as evidence, classifies failures, and writes a fallback checkpoint update when the checkpoint timestamp did not change during the run. Broader sandboxes may allow worker-authored checkpoint updates, but the harness does not depend on that permission for safe resumption.
