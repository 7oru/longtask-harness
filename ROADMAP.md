# Roadmap

## 0.1 Contract

- Define canonical task, checkpoint, and run event schemas.
- Ship a tiny dependency-free CLI for init, validate, next, and record.
- Include coding and video-analysis examples.
- Document OpenClaw direct-model and OpenClaw-to-Codex execution modes.

## 0.2 Adapters

- Add OpenClaw cron recipe generator. *(Initial `lth openclaw-recipe` support exists.)*
- Add Codex CLI worker prompt generator. *(Initial `lth tick` prompt generation exists.)*
- Add worker execution runner for local commands and Codex CLI. *(Initial `lth run` support exists.)*
- Add adapter health checks for Minimax, Codex CLI, and local repo trust. *(Initial `lth health` support exists.)*
- Add failure classification for rate limits, auth errors, tests, and missing context. *(Initial `lth classify` and `--record` support exists.)*
- Add machine-readable run decisions for `run`, `wait`, `done`, and `needs-human`. *(Initial `lth next` / `lth tick` support exists.)*

## 0.3 Evidence

- Add evidence manifests for tests, screenshots, video clips, transcripts, and benchmark runs.
- Add run summary generation from JSONL logs.
- Add "claim verifier" that blocks completion without evidence.

## 0.4 Portfolio Polish

- Add diagrams and a live demo task.
- Publish example case studies: coding refactor, PR review, video analysis.
- Add GitHub Actions validation.
