# Task Contract

Longtask Harness uses three canonical files.

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
- `workerPolicy`: preferred and allowed worker adapters. It may also set `lockTtlSeconds` for `lth run` leases.
- `localWorker`: command, working directory, and timeout for `lth run --worker local-command`.
- `codexWorker`: working directory, model, sandbox, local OSS provider, and timeout for `lth run --worker codex-cli`.
- `rateLimitPolicy`: rate-limit sources, fallback wait time, and whether lightweight handoff work may continue.

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
- `evidence`: references to tests, screenshots, logs, clips, or review notes.

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

## harness.md

Defines operating rules for human and AI workers.

This is where project-specific safety rules, verification commands, and handoff expectations live.

## .lth.lock/

Runtime-only lease directory created by `lth run` before a worker starts.

This directory is not durable task state. It prevents overlapping workers from writing the same checkpoint and run log at the same time. If the lock has not expired, a second `lth run` returns `decision: "wait"`. If the lock has expired, the next run removes it and creates a fresh lease.
