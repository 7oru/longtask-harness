# Harness

## Run Rules

- Read `task.json`, `checkpoint.json`, and this file before doing work.
- Do one bounded slice per run.
- Prefer reversible edits and small commits.
- Record evidence before claiming success.
- Update `checkpoint.json` before stopping.
- If rate limited, set status to `blocked`, record `blockedUntil`, and write a conservative next step.
- If a blocker requires human judgment, set status to `needs-human`.

## Worker Notes

This fixture demonstrates a real local `lth run` without requiring OpenClaw, Codex, Kimi, or network credentials.

Run one bounded slice with:

```bash
node ../../src/cli.js run . --worker local-command
```

Required evidence:

- Worker output containing `DEMO_SLICE_OK`.
- A review-note evidence item linked to `demo-reviewed`.

The worker may write `artifacts/demo-result.txt`, but the harness owns checkpoint and run-log updates.
