# Video Analysis Harness

## Rules

- Preserve source media.
- Store generated clips, frames, and transcripts under `artifacts/` or `evidence/`.
- Use timestamps in every claim.
- Keep each run bounded to one analysis or editing slice.
- If rate limited, update `checkpoint.json` with `status`, `blockedUntil`, `blocker`, and a concrete `nextStep`, then stop.
