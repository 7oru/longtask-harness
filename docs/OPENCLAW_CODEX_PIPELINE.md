# OpenClaw + Codex Pipeline

This project treats OpenClaw as an orchestrator and Codex CLI as an optional coding worker.

## Mode A: OpenClaw Direct Model

OpenClaw runs each bounded slice using its configured model, for example `minimax/MiniMax-M2.5`.

Use this when the work is mostly planning, inspection, small edits, media analysis, or checkpoint maintenance.

## Mode B: OpenClaw Schedules Codex CLI

OpenClaw reads the task contract and checkpoint, then starts Codex CLI inside a trusted git repository for heavier coding work.

This mode uses the local Codex CLI login/subscription path. It should pause cleanly on rate limits instead of retrying aggressively.

`lth run --worker codex-cli` is the preferred execution entry point for this mode. OpenClaw only needs to wake the task; the harness decides whether the task should run, starts `codex exec`, captures stdout/stderr, classifies failures, and writes checkpoint/run-log state.

```bash
node src/cli.js run tasks/my-coding-task \
  --worker codex-cli \
  --cwd /path/to/trusted/repo
```

For cloud-independent local runs, use `local-command` instead. The worker prompt is passed on stdin:

```bash
node src/cli.js run tasks/my-coding-task \
  --worker local-command \
  --command "ollama run qwen2.5-coder:32b"
```

## Cron Shape

```bash
openclaw cron add \
  --name "longtask-resume" \
  --every 5h \
  --session isolated \
  --session-key agent:main:cron:longtask \
  --model minimax/MiniMax-M2.5 \
  --tools "exec read write" \
  --timeout-seconds 1800 \
  --message "Read task.json, checkpoint.json, and harness.md. Continue one bounded slice. Update checkpoint before stopping."
```

Once `lth run` is used as the scheduler entry point, the cron message can stay small because the task directory owns both the run decision and worker execution:

```bash
node src/cli.js openclaw-recipe tasks/my-coding-task --every 30m
```

For `codex-cli` and `local-command` workers, the recipe generator emits a cron command that calls `node src/cli.js run ...`. For `openclaw-direct-model`, it falls back to `tick` and leaves the bounded worker slice to the OpenClaw model. Run `node src/cli.js health <task-dir>` before installing the recipe to check task validity, run decision, OpenClaw availability, Codex CLI availability, and optional repo context.

## Concurrency

`lth run` uses a task-local `.lth.lock/` directory as a lease before starting a worker. If a cron tick overlaps with an existing worker, the second run returns `decision: "wait"` and exits without changing checkpoint state or starting another worker. The lease has an expiration timestamp; stale locks are removed and replaced before the new worker starts.

Use `--lock-ttl-seconds` to tune the lease window. It should be longer than the expected worker timeout.

## Worker Contract

A worker must:

- Read the task contract before acting.
- Respect `blockedUntil`.
- Avoid dense retries after rate limits.
- Classify whether the rate limit came from `openclaw-provider`, `codex-cli`, `scheduler`, or an external API.
- Use `lth classify` on captured output when a worker exits unexpectedly.
- Produce evidence for claims.
- Update the checkpoint before exit.
- Leave enough context for a different worker to resume.

## Adapter Boundary

The harness protocol is local-first. `local-command` can run without any cloud service if the configured command is local. `codex-cli` and `openclaw-direct-model` are optional adapters and may use remote model services depending on local configuration.

This document describes the current primary integration path. The intended long-term shape is scheduler and worker adapters around the same checkpoint-first core. See [ADAPTER_ARCHITECTURE.md](ADAPTER_ARCHITECTURE.md) for the generalized boundary.

## Codex Session Evidence

When `codex-cli` hits a rate limit, the harness should keep the checkpoint small and store raw session context as evidence.

`lth run --worker codex-cli` now attempts to attach a `codex-session` evidence item when a failed Codex run is classified as `rate_limit`. It resolves the session path in this order:

- `--codex-session-path <path>` or `task.codexWorker.sessionPath`
- a `.codex/sessions/...jsonl` or `.codex/archived_sessions/...jsonl` path found in Codex stdout/stderr
- the newest `.jsonl` under `$CODEX_HOME/sessions`, `$CODEX_HOME/archived_sessions`, `~/.codex/sessions`, or `~/.codex/archived_sessions` within the run window

The evidence item points to the raw trace:

```json
{
  "type": "codex-session",
  "path": "/Users/example/.codex/sessions/trace.jsonl",
  "source": "codex-cli",
  "note": "Raw Codex CLI session trace for interrupted rate-limited run."
}
```

The checkpoint still owns only resumable state: blocker, `blockedUntil`, next step, active files, open questions, and evidence pointers.

## Kimi Fallback

For environments with Kimi CLI installed, Codex CLI can fall back to Kimi when the primary Codex run is classified as `rate_limit`.

Use a one-off CLI override:

```bash
node src/cli.js run tasks/my-coding-task \
  --worker codex-cli \
  --fallback-worker kimi-cli \
  --cwd /path/to/trusted/repo
```

Or configure the task contract:

```json
{
  "workerPolicy": {
    "preferred": "openclaw-codex-cli",
    "allowed": ["openclaw-codex-cli", "kimi-cli"],
    "fallbackOnRateLimit": "kimi-cli"
  },
  "kimiWorker": {
    "cwd": "/path/to/trusted/repo",
    "model": "kimi-k2",
    "timeoutSeconds": 1800
  }
}
```

The fallback receives the same bounded worker prompt. If Kimi succeeds, the task is checkpointed as `paused` with evidence for both the original Codex rate limit and the Kimi output. If Kimi also fails, the fallback output is classified and the checkpoint is updated from that final failure.
