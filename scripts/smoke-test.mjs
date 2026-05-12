#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "src", "cli.js");

function run(args, opts = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: opts.env || process.env
  });
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error([
      `Command failed: node src/cli.js ${args.join(" ")}`,
      `exit: ${result.status}`,
      result.stdout.trim(),
      result.stderr.trim()
    ].filter(Boolean).join("\n"));
  }
  if (opts.json) return JSON.parse(result.stdout);
  return result.stdout;
}

function taskCopy(name = "task") {
  const dir = mkdtempSync(join(tmpdir(), "longtask-harness-"));
  const taskDir = join(dir, name);
  cpSync(join(repoRoot, "examples", "coding"), taskDir, { recursive: true });
  return { dir, taskDir };
}

function countRunLines(taskDir) {
  const runsDir = join(taskDir, "runs");
  if (!existsSync(runsDir)) return 0;
  return readdirSync(runsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .reduce((count, file) => {
      const text = readFileSync(join(runsDir, file), "utf8").trim();
      return count + (text ? text.split("\n").length : 0);
    }, 0);
}

function runEvents(taskDir) {
  const runsDir = join(taskDir, "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => readFileSync(join(runsDir, file), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

function readCheckpoint(taskDir) {
  return JSON.parse(readFileSync(join(taskDir, "checkpoint.json"), "utf8"));
}

function withTask(fn) {
  const { dir, taskDir } = taskCopy();
  try {
    fn(taskDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(label, fn) {
  fn();
  console.log(`ok - ${label}`);
}

check("examples validate", () => {
  run(["validate", "examples/coding"]);
  run(["validate", "examples/video-analysis"]);
});

check("next returns run for active task", () => {
  const next = run(["next", "examples/coding"], { json: true });
  assert.equal(next.decision, "run");
  assert.equal(next.status, "active");
  assert.equal(next.waitSeconds, 0);
});

check("tick --dry-run generates a prompt without writing logs", () => withTask((taskDir) => {
  const before = countRunLines(taskDir);
  const tick = run(["tick", taskDir, "--dry-run"], { json: true });
  const after = countRunLines(taskDir);

  assert.equal(tick.decision, "run");
  assert.equal(tick.dryRun, true);
  assert.match(tick.workerPrompt, /Continue exactly one bounded slice/);
  assert.equal(after, before);
}));

check("recorded rate limit makes next wait", () => withTask((taskDir) => {
  run([
    "record",
    taskDir,
    "--status", "blocked",
    "--reason", "rate_limit",
    "--source", "codex-cli",
    "--retry-after-seconds", "3600",
    "--note", "Codex CLI rate limited during parser tests"
  ]);

  const next = run(["next", taskDir], { json: true });
  assert.equal(next.decision, "wait");
  assert.equal(next.status, "blocked");
  assert.ok(next.waitSeconds > 0);
  assert.ok(next.waitSeconds <= 3600);
  assert.match(next.nextStep, /Codex CLI rate limited/);
}));

check("tick --dry-run does not append wait events", () => withTask((taskDir) => {
  run([
    "record",
    taskDir,
    "--status", "blocked",
    "--reason", "rate_limit",
    "--source", "codex-cli",
    "--retry-after-seconds", "3600",
    "--note", "Codex CLI rate limited during parser tests"
  ]);
  const before = countRunLines(taskDir);
  const tick = run(["tick", taskDir, "--dry-run"], { json: true });
  const after = countRunLines(taskDir);

  assert.equal(tick.decision, "wait");
  assert.equal(tick.workerPrompt, null);
  assert.equal(after, before);
}));

check("tick appends skipped events while waiting", () => withTask((taskDir) => {
  run([
    "record",
    taskDir,
    "--status", "blocked",
    "--reason", "rate_limit",
    "--source", "codex-cli",
    "--retry-after-seconds", "3600",
    "--note", "Codex CLI rate limited during parser tests"
  ]);
  const before = countRunLines(taskDir);
  const tick = run(["tick", taskDir], { json: true });
  const after = countRunLines(taskDir);
  const types = runEvents(taskDir).map((event) => event.type);

  assert.equal(tick.decision, "wait");
  assert.equal(after, before + 2);
  assert.ok(types.includes("tick_started"));
  assert.ok(types.includes("run_skipped"));
}));

check("blocked task without blockedUntil needs human", () => withTask((taskDir) => {
  run([
    "record",
    taskDir,
    "--status", "blocked",
    "--reason", "external",
    "--source", "external-api",
    "--note", "External API is unavailable without a reset time"
  ]);

  const next = run(["next", taskDir], { json: true });
  assert.equal(next.decision, "needs-human");
}));

check("needs-human status stops automation", () => withTask((taskDir) => {
  run([
    "record",
    taskDir,
    "--status", "needs-human",
    "--reason", "manual",
    "--source", "manual",
    "--note", "User must approve the next action"
  ]);

  const tick = run(["tick", taskDir, "--dry-run"], { json: true });
  assert.equal(tick.decision, "needs-human");
  assert.equal(tick.workerPrompt, null);
}));

check("expired blockedUntil reopens the task", () => withTask((taskDir) => {
  const past = new Date(Date.now() - 60_000).toISOString();
  run([
    "record",
    taskDir,
    "--status", "blocked",
    "--reason", "rate_limit",
    "--source", "codex-cli",
    "--blocked-until", past,
    "--note", "Window already reopened"
  ]);

  const tick = run(["tick", taskDir], { json: true });
  const checkpoint = readCheckpoint(taskDir);
  const types = runEvents(taskDir).map((event) => event.type);

  assert.equal(tick.decision, "run");
  assert.equal(checkpoint.status, "active");
  assert.equal(checkpoint.blockedUntil, null);
  assert.equal(checkpoint.blocker, null);
  assert.ok(types.includes("checkpoint_written"));
  assert.ok(types.includes("worker_prompt_generated"));
}));

check("classify detects rate limits with retry timing", () => withTask((taskDir) => {
  const result = run([
    "classify",
    taskDir,
    "--text", "Codex CLI returned 429 Too Many Requests. Retry after 120 seconds.",
    "--exit-code", "1"
  ], { json: true });

  assert.equal(result.class, "rate_limit");
  assert.equal(result.source, "codex-cli");
  assert.equal(result.statusSuggestion, "blocked");
  assert.equal(result.retryAfterSeconds, 120);
  assert.ok(result.blockedUntil);
}));

check("classify --record updates checkpoint and run events", () => withTask((taskDir) => {
  run([
    "classify",
    taskDir,
    "--text", "OpenClaw Minimax quota exceeded. Try again in 1 minute.",
    "--record"
  ], { json: true });

  const checkpoint = readCheckpoint(taskDir);
  const types = runEvents(taskDir).map((event) => event.type);

  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.blocker.type, "rate_limit");
  assert.equal(checkpoint.blocker.source, "openclaw-provider");
  assert.ok(checkpoint.blockedUntil);
  assert.ok(types.includes("rate_limited"));
  assert.ok(types.includes("checkpoint_written"));
}));

check("classify --record links explicit Codex session evidence on rate limit", () => withTask((taskDir) => {
  const sessionPath = join(taskDir, "evidence", "codex-session.jsonl");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, "{}\n", "utf8");

  run([
    "classify",
    taskDir,
    "--text", "Codex CLI returned 429 Too Many Requests.",
    "--source", "codex-cli",
    "--codex-session-path", sessionPath,
    "--record"
  ], { json: true });

  const checkpoint = readCheckpoint(taskDir);
  const rateLimitEvent = runEvents(taskDir).find((event) => event.type === "rate_limited");

  assert.equal(checkpoint.status, "blocked");
  assert.ok(checkpoint.evidence.some((item) => item.type === "codex-session" && item.path === sessionPath));
  assert.ok(rateLimitEvent.evidence.some((item) => item.type === "codex-session" && item.path === sessionPath));
}));

check("classify routes auth and missing context to needs-human", () => withTask((taskDir) => {
  const auth = run([
    "classify",
    taskDir,
    "--text", "401 unauthorized: invalid API key"
  ], { json: true });
  const missing = run([
    "classify",
    taskDir,
    "--text", "ENOENT: file not found, cannot find repo path"
  ], { json: true });

  assert.equal(auth.class, "auth_error");
  assert.equal(auth.statusSuggestion, "needs-human");
  assert.equal(missing.class, "missing_context");
  assert.equal(missing.statusSuggestion, "needs-human");
}));

check("classify routes test failures to paused", () => withTask((taskDir) => {
  const result = run([
    "classify",
    taskDir,
    "--text", "AssertionError: expected true received false. tests failed."
  ], { json: true });

  assert.equal(result.class, "test_failure");
  assert.equal(result.statusSuggestion, "paused");
}));

check("run local-command executes one bounded slice", () => withTask((taskDir) => {
  const command = [
    "node -e",
    JSON.stringify([
      "process.stdin.setEncoding('utf8');",
      "let input = '';",
      "process.stdin.on('data', chunk => input += chunk);",
      "process.stdin.on('end', () => {",
      "  if (!input.includes('Continue exactly one bounded slice')) process.exit(2);",
      "  console.log('local worker completed');",
      "});"
    ].join(""))
  ].join(" ");

  const result = run([
    "run",
    taskDir,
    "--worker", "local-command",
    "--command", command,
    "--timeout-seconds", "5"
  ], { json: true });
  const checkpoint = readCheckpoint(taskDir);
  const types = runEvents(taskDir).map((event) => event.type);

  assert.equal(result.decision, "run");
  assert.equal(result.worker, "local-command");
  assert.equal(result.exitCode, 0);
  assert.match(result.outputPath, /^evidence\/worker-output-/);
  assert.equal(checkpoint.status, "paused");
  assert.ok(checkpoint.evidence.some((item) => item.path === result.outputPath));
  assert.ok(types.includes("worker_started"));
  assert.ok(types.includes("worker_completed"));
  assert.ok(types.includes("checkpoint_written"));
}));

check("run local-command classifies failed worker output", () => withTask((taskDir) => {
  const command = "node -e \"console.error('429 Too Many Requests. Retry after 2 seconds.'); process.exit(1)\"";

  const result = run([
    "run",
    taskDir,
    "--worker", "local-command",
    "--command", command,
    "--timeout-seconds", "5"
  ], { json: true, allowFailure: true });
  const checkpoint = readCheckpoint(taskDir);
  const types = runEvents(taskDir).map((event) => event.type);

  assert.equal(result.worker, "local-command");
  assert.equal(result.exitCode, 1);
  assert.equal(result.classification.class, "rate_limit");
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.blocker.type, "rate_limit");
  assert.ok(types.includes("worker_failed"));
  assert.ok(types.includes("rate_limited"));
  assert.ok(types.includes("checkpoint_written"));
}));

check("run codex-cli links session evidence from failed rate-limit output", () => withTask((taskDir) => {
  const binDir = mkdtempSync(join(taskDir, "fake-bin-"));
  const sessionPath = join(taskDir, ".codex", "sessions", "fake-codex-session.jsonl");
  const codexPath = join(binDir, "codex");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, "{}\n", "utf8");
  writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    `console.error("Codex CLI returned 429 Too Many Requests. Session: ${sessionPath}");`,
    "process.exit(1);"
  ].join("\n"), "utf8");
  chmodSync(codexPath, 0o755);

  const result = run([
    "run",
    taskDir,
    "--worker", "codex-cli",
    "--cwd", taskDir,
    "--timeout-seconds", "5"
  ], {
    json: true,
    allowFailure: true,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  });
  const checkpoint = readCheckpoint(taskDir);

  assert.equal(result.worker, "codex-cli");
  assert.equal(result.classification.class, "rate_limit");
  assert.equal(checkpoint.status, "blocked");
  assert.ok(checkpoint.evidence.some((item) => item.type === "codex-session" && item.path === sessionPath));
}));

check("run codex-cli falls back to kimi-cli on rate limit", () => withTask((taskDir) => {
  const binDir = mkdtempSync(join(taskDir, "fake-bin-"));
  const sessionPath = join(taskDir, ".codex", "sessions", "fallback-codex-session.jsonl");
  const codexPath = join(binDir, "codex");
  const kimiPath = join(binDir, "kimi");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, "{}\n", "utf8");
  writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    `console.error("Codex CLI returned 429 Too Many Requests. Session: ${sessionPath}");`,
    "process.exit(1);"
  ].join("\n"), "utf8");
  writeFileSync(kimiPath, [
    "#!/usr/bin/env node",
    "process.stdin.setEncoding('utf8');",
    "let input = '';",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    "  if (!input.includes('Continue exactly one bounded slice')) process.exit(2);",
    "  console.log('kimi fallback completed');",
    "});"
  ].join("\n"), "utf8");
  chmodSync(codexPath, 0o755);
  chmodSync(kimiPath, 0o755);

  const result = run([
    "run",
    taskDir,
    "--worker", "codex-cli",
    "--fallback-worker", "kimi-cli",
    "--cwd", taskDir,
    "--timeout-seconds", "5"
  ], {
    json: true,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  });
  const checkpoint = readCheckpoint(taskDir);
  const events = runEvents(taskDir);

  assert.equal(result.worker, "codex-cli");
  assert.equal(result.classification.class, "rate_limit");
  assert.equal(result.fallback.worker, "kimi-cli");
  assert.equal(result.fallback.exitCode, 0);
  assert.equal(checkpoint.status, "paused");
  assert.ok(checkpoint.evidence.some((item) => item.type === "codex-session" && item.path === sessionPath));
  assert.ok(checkpoint.evidence.some((item) => item.path === result.fallback.outputPath));
  assert.ok(events.some((event) => event.type === "rate_limited" && event.status === "fallback"));
}));

check("run waits when another worker holds the task lock", () => withTask((taskDir) => {
  const lockDir = join(taskDir, ".lth.lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "lock.json"), JSON.stringify({
    owner: "test-worker",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  }, null, 2), "utf8");

  const before = countRunLines(taskDir);
  const result = run([
    "run",
    taskDir,
    "--worker", "local-command",
    "--command", "node -e \"process.exit(9)\""
  ], { json: true });
  const after = countRunLines(taskDir);

  assert.equal(result.decision, "wait");
  assert.equal(result.reason, "task lock is active");
  assert.equal(result.worker, null);
  assert.ok(result.waitSeconds > 0);
  assert.equal(result.lock.owner, "test-worker");
  assert.equal(after, before);
}));

check("run takes over expired task lock and releases it", () => withTask((taskDir) => {
  const lockDir = join(taskDir, ".lth.lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "lock.json"), JSON.stringify({
    owner: "stale-worker",
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString()
  }, null, 2), "utf8");

  const result = run([
    "run",
    taskDir,
    "--worker", "local-command",
    "--command", "node -e \"process.stdin.resume(); console.log('stale lock cleared')\"",
    "--timeout-seconds", "5"
  ], { json: true });

  assert.equal(result.decision, "run");
  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(lockDir), false);
}));

check("health returns adapter checks without failing smoke suite", () => {
  const health = run(["health", "examples/coding"], { json: true });
  const names = health.checks.map((check) => check.name);

  assert.ok(["pass", "warn", "fail"].includes(health.status));
  assert.ok(names.includes("task-contract"));
  assert.ok(names.includes("run-decision"));
  assert.ok(names.includes("openclaw-cli"));
  assert.ok(names.includes("codex-cli"));
});

check("openclaw-recipe emits a cron command", () => {
  const recipe = run(["openclaw-recipe", "examples/coding", "--every", "30m"], { json: true });

  assert.equal(recipe.taskId, "coding-example");
  assert.match(recipe.command, /openclaw cron add/);
  assert.match(recipe.command, /lth|src\/cli\.js|node/);
  assert.match(recipe.message, /run/);
  assert.match(recipe.message, /codex-cli/);
});

check("init output validates", () => {
  const dir = mkdtempSync(join(tmpdir(), "longtask-harness-init-"));
  const taskDir = join(dir, "new-task");
  try {
    run(["init", taskDir, "--template", "coding"]);
    run(["validate", taskDir]);
    const tick = run(["tick", taskDir, "--dry-run"], { json: true });
    assert.equal(tick.decision, "run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("init configures scheduler, worker fallback, and health checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "longtask-harness-init-config-"));
  const taskDir = join(dir, "configured-task");
  try {
    const result = run([
      "init",
      taskDir,
      "--template", "coding",
      "--scheduler", "openclaw-cron",
      "--worker", "codex-cli",
      "--fallback-worker", "kimi-cli",
      "--cwd", repoRoot,
      "--check"
    ], { json: true });
    const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
    const checkNames = result.health.checks.map((check) => check.name);

    assert.equal(result.initialized, true);
    assert.equal(task.scheduler.type, "openclaw-cron");
    assert.equal(task.workerPolicy.preferred, "codex-cli");
    assert.equal(task.workerPolicy.fallbackOnRateLimit, "kimi-cli");
    assert.deepEqual(task.workerPolicy.allowed, ["codex-cli", "kimi-cli"]);
    assert.equal(task.context.repoPath, repoRoot);
    assert.equal(task.codexWorker.cwd, repoRoot);
    assert.equal(task.kimiWorker.cwd, repoRoot);
    assert.ok(checkNames.includes("scheduler-config"));
    assert.ok(checkNames.includes("openclaw-cli"));
    assert.ok(checkNames.includes("codex-cli"));
    assert.ok(checkNames.includes("kimi-cli"));
    assert.ok(checkNames.includes("worker-plan:codex-cli"));
    assert.ok(checkNames.includes("worker-plan:kimi-cli"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log("smoke test passed");
