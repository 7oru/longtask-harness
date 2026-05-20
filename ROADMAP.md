# Roadmap

See [docs/REVIEW_2026-05-19.md](docs/REVIEW_2026-05-19.md) for the latest runnable-tool review. See [docs/REVIEW_PRIORITIES.md](docs/REVIEW_PRIORITIES.md) for the hardening review and priority order.

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

- Add `lth verify` and block `done` claims that do not satisfy success criteria. *(Initial support exists.)*
- Make checkpoint, task, and lock writes interruption-safe. *(Initial atomic JSON writes and file lock support exists.)*
- Harden Codex worker defaults and enforce forbidden working directories. *(Initial read-only default and cwd blocklist support exists.)*
- Wire schema validation and `schemaVersion` migration checks into `loadAndValidate`. *(Initial zero-dependency subset validator exists.)*
- Add evidence manifests for tests, screenshots, video clips, transcripts, and benchmark runs. *(Initial `lth evidence` support exists.)*
- Add run summary generation from JSONL logs. *(Initial `lth summary` and `lth tail` support exists.)*

## 0.4 Portfolio Polish

- Reposition README around the runnable CLI loop: `install`, `init`, `run`, `status`, and `resume`.
- Add `lth status` and `lth resume` as first-class user workflow commands.
- Add diagrams and a live demo task.
- Publish example case studies: React-to-TypeScript migration, coding refactor, PR review, video analysis. *(Initial local resume demo fixture exists.)*
- Add GitHub Actions validation.
