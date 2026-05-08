# Task Contract

Longtask Harness uses three canonical files.

## task.json

Defines the intended outcome.

Important fields:

- `id`: stable task identifier.
- `title`: short human label.
- `domain`: `coding`, `video-analysis`, `research`, or another domain.
- `objective`: the outcome the worker is trying to produce.
- `successCriteria`: verifiable completion checks.
- `constraints`: safety, scope, and budget constraints.
- `workerPolicy`: preferred and allowed worker adapters.

## checkpoint.json

Defines the current resumable state.

Important fields:

- `status`: `active`, `paused`, `blocked`, or `done`.
- `currentPhase`: current phase name.
- `nextStep`: the next concrete action.
- `blockedUntil`: ISO timestamp or `null`.
- `evidence`: references to tests, screenshots, logs, clips, or review notes.

## harness.md

Defines operating rules for human and AI workers.

This is where project-specific safety rules, verification commands, and handoff expectations live.

