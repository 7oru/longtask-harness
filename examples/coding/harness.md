# Coding Harness

## Rules

- Work inside a trusted git repository.
- Make small edits and run focused tests.
- Write evidence before claiming a slice is complete.
- If using Codex CLI, keep it outside `~/.openclaw`.
- If rate limited, update `checkpoint.json` with `status`, `blockedUntil`, `blocker`, and a concrete `nextStep`, then stop.
- If a blocker requires human judgment, use `status: needs-human`.
