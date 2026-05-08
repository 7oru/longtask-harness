# OpenClaw + Codex Pipeline

This project treats OpenClaw as an orchestrator and Codex CLI as an optional coding worker.

## Mode A: OpenClaw Direct Model

OpenClaw runs each bounded slice using its configured model, for example `minimax/MiniMax-M2.5`.

Use this when the work is mostly planning, inspection, small edits, media analysis, or checkpoint maintenance.

## Mode B: OpenClaw Schedules Codex CLI

OpenClaw reads the task contract and checkpoint, then starts Codex CLI inside a trusted git repository for heavier coding work.

This mode uses the local Codex CLI login/subscription path. It should pause cleanly on rate limits instead of retrying aggressively.

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

Once `lth tick` is used as the scheduler entry point, the cron message can stay much smaller because the task directory owns the run decision:

```bash
openclaw cron add \
  --name "longtask-tick" \
  --every 30m \
  --session isolated \
  --session-key agent:main:cron:longtask \
  --tools "exec read write" \
  --timeout-seconds 300 \
  --message "Run lth tick for the configured task directory. If it returns wait, stop. If it returns run, start exactly one bounded worker slice using the generated prompt."
```

## Worker Contract

A worker must:

- Read the task contract before acting.
- Respect `blockedUntil`.
- Avoid dense retries after rate limits.
- Classify whether the rate limit came from `openclaw-provider`, `codex-cli`, `scheduler`, or an external API.
- Produce evidence for claims.
- Update the checkpoint before exit.
- Leave enough context for a different worker to resume.
