# Adapter Architecture

Longtask Harness should scale from the current OpenClaw + Codex CLI path to any scheduler + worker pair.

The stable core is the task protocol:

- `task.json`: objective, constraints, success criteria, worker policy, and adapter config.
- `checkpoint.json`: resumable state, blocker, next step, active files, open questions, and evidence references.
- `harness.md`: human-readable operating rules.
- `runs/*.jsonl`: append-only execution events.
- `evidence/`: captured output, traces, screenshots, handoff notes, and other raw recovery material.

Schedulers and workers are adapters around that protocol. The harness should own the state machine; adapters should only translate between external tools and the protocol.

## Roles

### Scheduler Adapter

A scheduler wakes a task and invokes the harness. It should not decide task semantics itself.

Responsibilities:

- Register or describe a recurring trigger.
- Provide the command or message that wakes `lth`.
- Pass scheduler-specific metadata when useful, such as job id, session key, or trigger time.
- Report scheduler availability in health checks.

Examples:

- `openclaw-cron`
- `systemd-timer`
- `launchd`
- `github-actions`
- `manual`

### Worker Adapter

A worker executes one bounded slice after the harness decides the task is runnable.

Responsibilities:

- Build an executable command or direct invocation from task config and the worker prompt.
- Run exactly one bounded slice.
- Capture stdout, stderr, exit code, timeout, and adapter-specific metadata.
- Classify or expose enough output for harness classification.
- Return evidence references, including raw session traces when available.
- Avoid writing scheduler-level state.

Examples:

- `codex-cli`
- `kimi-cli`
- `local-command`
- `openclaw-direct-model`
- `claude-code`
- `gemini-cli`
- `custom-http-agent`

## Suggested Interface Shape

JavaScript does not need a heavy inheritance tree for this. Prefer small adapter contracts plus registries. If classes are introduced, keep base classes thin and mostly behavioral.

```js
class SchedulerAdapter {
  constructor({ taskDir, task, checkpoint, args }) {}
  health() {}
  recipe() {}
}

class WorkerAdapter {
  constructor({ taskDir, task, checkpoint, args }) {}
  health() {}
  buildPlan(workerPrompt) {}
  execute(plan, workerPrompt) {}
  collectEvidence(result, context) {}
  classify(result, context) {}
}
```

The harness runner should stay worker-agnostic:

1. Load and validate task state.
2. Decide `run`, `wait`, `done`, or `needs-human`.
3. Acquire the task lease.
4. Build the bounded worker prompt.
5. Ask the selected worker adapter for a plan.
6. Execute the plan.
7. Capture output and evidence.
8. Classify result.
9. Write checkpoint and run events.
10. Release the lease.

## Why Not Put Everything In Derived Classes?

Do not move the checkpoint state machine into adapter subclasses. That would make every scheduler or worker responsible for resuming tasks consistently, which is exactly the problem the harness is meant to solve.

Use adapters for tool-specific behavior:

- OpenClaw recipe generation belongs in an OpenClaw scheduler adapter.
- Codex command construction, sandbox/model flags, and Codex session trace discovery belong in a Codex worker adapter.
- Kimi command construction, print-mode flags, and fallback execution belong in a Kimi worker adapter.
- Local shell command execution belongs in a local-command worker adapter.
- Failure classification defaults can live in the core, with adapter-specific hints layered in.

## Current Mapping

Current code in `src/cli.js` already contains these adapter boundaries, but they are implemented as functions:

- Scheduler-ish: `openclawRecipe`, `tick`, `healthCheck`.
- Worker-ish: `buildLocalCommand`, `buildCodexCommand`, `executeWorkerCommand`.
- Kimi fallback: `buildKimiCommand` and rate-limit fallback execution after `codex-cli` failures.
- Codex-specific evidence: Codex session trace detection for rate-limited `codex-cli` runs.
- Core state machine: `decideNext`, `runWorkerUnlocked`, `applyClassification`, lock handling, checkpoint writes, and run events.

The next refactor should extract modules before introducing inheritance:

```text
src/core/
  state.js
  prompt.js
  classification.js
  evidence.js
  lock.js

src/workers/
  local-command.js
  codex-cli.js
  kimi-cli.js

src/schedulers/
  openclaw.js
```

After modules are separated, add base classes or adapter interfaces only where they remove duplication. The best first abstraction is a worker adapter registry:

```js
const workerAdapters = {
  "local-command": new LocalCommandWorkerAdapter(),
  "codex-cli": new CodexCliWorkerAdapter(),
  "kimi-cli": new KimiCliWorkerAdapter()
};
```

This keeps the protocol stable while letting new scheduler and worker integrations arrive independently.
