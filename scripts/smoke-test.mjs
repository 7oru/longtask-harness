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
  if (opts.raw) return result;
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
  run(["validate", "examples/resume-demo"]);
  assert.equal(run(["verify", "examples/resume-demo"], { json: true }).status, "pass");
});

check("validate rejects unsupported schema versions", () => withTask((taskDir) => {
  const taskPath = join(taskDir, "task.json");
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  task.schemaVersion = 2;
  writeFileSync(taskPath, JSON.stringify(task, null, 2) + "\n", "utf8");

  const result = run(["validate", taskDir], { raw: true, allowFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported task\.schemaVersion 2/);
  assert.match(result.stderr, /migration/);
}));

check("validate rejects malformed evidence items", () => withTask((taskDir) => {
  const checkpointPath = join(taskDir, "checkpoint.json");
  const checkpoint = readCheckpoint(taskDir);
  checkpoint.evidence = [{ path: "evidence/missing-type.txt" }];
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");

  const result = run(["validate", taskDir], { raw: true, allowFailure: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checkpoint\.evidence\[0\]\.type is required/);
}));

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
  assert.match(tick.workerPrompt, /Task directory:/);
  assert.match(tick.workerPrompt, /Success criteria:/);
  assert.match(tick.workerPrompt, /Hard constraints:/);
  assert.match(tick.workerPrompt, /Evidence expectations:/);
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

check("classify parses HTTP-date Retry-After", () => withTask((taskDir) => {
  const retryAt = new Date(Date.now() + 90_000).toUTCString();
  const result = run([
    "classify",
    taskDir,
    "--text", `Codex CLI returned 429 Too Many Requests. Retry-After: ${retryAt}`,
    "--exit-code", "1"
  ], { json: true });

  assert.equal(result.class, "rate_limit");
  assert.equal(result.source, "codex-cli");
  assert.ok(result.retryAfterSeconds > 0);
  assert.ok(result.retryAfterSeconds <= 90);
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

check("classify avoids broad expected/received and api source false positives", () => withTask((taskDir) => {
  const arbitraryStack = run([
    "classify",
    taskDir,
    "--text", "Renderer output changed: expected compact layout but received expanded layout.",
    "--exit-code", "1"
  ], { json: true });
  const external = run([
    "classify",
    taskDir,
    "--text", "External API request failed with HTTP 500.",
    "--exit-code", "1"
  ], { json: true });

  assert.equal(arbitraryStack.class, "unknown");
  assert.equal(arbitraryStack.source, "manual");
  assert.equal(external.class, "unknown");
  assert.equal(external.source, "external-api");
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

check("verify checks command, output, and manual criteria", () => withTask((taskDir) => {
  const taskPath = join(taskDir, "task.json");
  const checkpointPath = join(taskDir, "checkpoint.json");
  const evidencePath = join(taskDir, "evidence", "verification.txt");
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  const checkpoint = readCheckpoint(taskDir);
  task.successCriteria = [
    {
      id: "cmd-ok",
      description: "A verification command passes.",
      metric: "command",
      target: "node -e \"process.exit(0)\""
    },
    {
      id: "output-ok",
      description: "Evidence contains the expected output.",
      metric: "output_contains",
      target: "verification needle"
    },
    {
      id: "manual-ok",
      description: "Manual review evidence is linked.",
      metric: "manual"
    }
  ];
  checkpoint.evidence = [
    { type: "review-note", path: "evidence/verification.txt", criterionId: "manual-ok" }
  ];
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(taskPath, JSON.stringify(task, null, 2) + "\n", "utf8");
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
  writeFileSync(evidencePath, "verification needle\n", "utf8");

  const verify = run(["verify", taskDir], { json: true });
  assert.equal(verify.status, "pass");

  run(["record", taskDir, "--status", "done", "--note", "verified complete"]);
  assert.equal(readCheckpoint(taskDir).status, "done");
}));

check("record done rejects unverified success criteria", () => withTask((taskDir) => {
  const result = run([
    "record",
    taskDir,
    "--status", "done",
    "--note", "not really done"
  ], { raw: true, allowFailure: true });
  const checkpoint = readCheckpoint(taskDir);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /verification failed/);
  assert.equal(checkpoint.status, "active");
}));

check("evidence records a manifest and satisfies manual criteria", () => withTask((taskDir) => {
  const taskPath = join(taskDir, "task.json");
  const task = JSON.parse(readFileSync(taskPath, "utf8"));
  task.successCriteria = [{
    id: "reviewed",
    description: "A manual review note exists.",
    metric: "manual"
  }];
  writeFileSync(taskPath, JSON.stringify(task, null, 2) + "\n", "utf8");

  const result = run([
    "evidence",
    taskDir,
    "--type", "review-note",
    "--criterion-id", "reviewed",
    "--summary", "Manual review confirms the slice.",
    "--status", "pass"
  ], { json: true });
  const checkpoint = readCheckpoint(taskDir);
  const events = runEvents(taskDir);

  assert.equal(result.recorded, true);
  assert.match(result.manifestPath, /^evidence\/review-note-manifest-/);
  assert.equal(existsSync(join(taskDir, result.manifestPath)), true);
  assert.ok(checkpoint.evidence.some((item) => item.criterionId === "reviewed" && item.manifestPath === result.manifestPath));
  assert.ok(events.some((event) => event.type === "evidence_recorded"));
  assert.equal(run(["verify", taskDir], { json: true }).status, "pass");
}));

check("evidence rejects unsupported types", () => withTask((taskDir) => {
  const result = run([
    "evidence",
    taskDir,
    "--type", "unknown-kind",
    "--summary", "bad"
  ], { raw: true, allowFailure: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported evidence type/);
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

check("run preserves worker-authored nextStep on failure", () => withTask((taskDir) => {
  const checkpointPath = join(taskDir, "checkpoint.json");
  const recoveryStep = "Inspect parser retry fixture before resuming.";
  const command = [
    "node -e",
    JSON.stringify([
      "const fs = require('fs');",
      `const checkpointPath = ${JSON.stringify(checkpointPath)};`,
      "const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));",
      `checkpoint.nextStep = ${JSON.stringify(recoveryStep)};`,
      "checkpoint.updatedAt = new Date().toISOString();",
      "fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + '\\n');",
      "console.error('AssertionError: tests failed after worker checkpoint update.');",
      "process.exit(1);"
    ].join(""))
  ].join(" ");

  const result = run([
    "run",
    taskDir,
    "--worker", "local-command",
    "--command", command,
    "--timeout-seconds", "5"
  ], { json: true, allowFailure: true });
  const checkpoint = readCheckpoint(taskDir);

  assert.equal(result.classification.class, "test_failure");
  assert.equal(checkpoint.status, "paused");
  assert.equal(checkpoint.nextStep, recoveryStep);
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

check("run codex-cli defaults to read-only sandbox", () => withTask((taskDir) => {
  const result = run([
    "run",
    taskDir,
    "--worker", "codex-cli",
    "--cwd", taskDir,
    "--dry-run"
  ], { json: true });

  assert.match(result.command, /--sandbox read-only/);
}));

check("run codex-cli rejects forbidden cwd", () => withTask((taskDir) => {
  const result = run([
    "run",
    taskDir,
    "--worker", "codex-cli",
    "--cwd", "~/.openclaw",
    "--dry-run"
  ], { raw: true, allowFailure: true });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /forbidden cwd/);
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
  assert.ok(checkpoint.workerCooldowns["codex-cli"].blockedUntil);
  assert.ok(checkpoint.evidence.some((item) => item.type === "codex-session" && item.path === sessionPath));
  assert.ok(checkpoint.evidence.some((item) => item.path === result.fallback.outputPath));
  assert.ok(events.some((event) => event.type === "rate_limited" && event.status === "fallback"));
}));

check("run returns to codex-cli after worker cooldown expires", () => withTask((taskDir) => {
  const binDir = mkdtempSync(join(taskDir, "fake-bin-"));
  const sessionPath = join(taskDir, ".codex", "sessions", "cooldown-codex-session.jsonl");
  const codexPath = join(binDir, "codex");
  const kimiPath = join(binDir, "kimi");
  const countPath = join(taskDir, "codex-count.txt");
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, "{}\n", "utf8");
  writeFileSync(countPath, "0", "utf8");
  writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    `const countPath = ${JSON.stringify(countPath)};`,
    "const count = Number(fs.readFileSync(countPath, 'utf8')) + 1;",
    "fs.writeFileSync(countPath, String(count));",
    "if (count === 1) {",
    `  console.error("Codex CLI returned 429 Too Many Requests. Retry after 3600 seconds. Session: ${sessionPath}");`,
    "  process.exit(1);",
    "}",
    "process.stdin.resume();",
    "console.log('codex resumed after cooldown');"
  ].join("\n"), "utf8");
  writeFileSync(kimiPath, [
    "#!/usr/bin/env node",
    "process.stdin.resume();",
    "console.log('kimi handled cooldown window');"
  ].join("\n"), "utf8");
  chmodSync(codexPath, 0o755);
  chmodSync(kimiPath, 0o755);
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };

  const first = run([
    "run",
    taskDir,
    "--worker", "codex-cli",
    "--fallback-worker", "kimi-cli",
    "--cwd", taskDir,
    "--timeout-seconds", "5"
  ], { json: true, env });
  const second = run([
    "run",
    taskDir,
    "--worker", "codex-cli",
    "--fallback-worker", "kimi-cli",
    "--cwd", taskDir,
    "--timeout-seconds", "5"
  ], { json: true, env });
  const checkpoint = readCheckpoint(taskDir);
  checkpoint.workerCooldowns["codex-cli"].blockedUntil = new Date(Date.now() - 1000).toISOString();
  writeFileSync(join(taskDir, "checkpoint.json"), JSON.stringify(checkpoint, null, 2) + "\n", "utf8");
  const third = run([
    "run",
    taskDir,
    "--worker", "codex-cli",
    "--fallback-worker", "kimi-cli",
    "--cwd", taskDir,
    "--timeout-seconds", "5"
  ], { json: true, env });
  const finalCheckpoint = readCheckpoint(taskDir);

  assert.equal(first.worker, "codex-cli");
  assert.equal(first.fallback.worker, "kimi-cli");
  assert.equal(second.worker, "kimi-cli");
  assert.equal(second.requestedWorker, "codex-cli");
  assert.equal(second.degradedFrom, "codex-cli");
  assert.equal(readFileSync(countPath, "utf8"), "2");
  assert.equal(third.worker, "codex-cli");
  assert.equal(third.exitCode, 0);
  assert.equal(finalCheckpoint.workerCooldowns, undefined);
}));

check("run records worker cooldown and blocks when no fallback is configured", () => withTask((taskDir) => {
  const binDir = mkdtempSync(join(taskDir, "fake-bin-"));
  const kimiPath = join(binDir, "kimi");
  writeFileSync(kimiPath, [
    "#!/usr/bin/env node",
    "console.error('Kimi returned 429 Too Many Requests. Retry after 10 seconds.');",
    "process.exit(1);"
  ].join("\n"), "utf8");
  chmodSync(kimiPath, 0o755);

  const result = run([
    "run",
    taskDir,
    "--worker", "kimi-cli",
    "--cwd", taskDir,
    "--timeout-seconds", "5"
  ], {
    json: true,
    allowFailure: true,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  });
  const checkpoint = readCheckpoint(taskDir);

  assert.equal(result.worker, "kimi-cli");
  assert.equal(result.classification.class, "rate_limit");
  assert.equal(checkpoint.status, "blocked");
  assert.ok(checkpoint.blockedUntil);
  assert.ok(checkpoint.workerCooldowns["kimi-cli"].blockedUntil);
}));

check("run records both cooldowns when fallback also rate limits", () => withTask((taskDir) => {
  const binDir = mkdtempSync(join(taskDir, "fake-bin-"));
  const codexPath = join(binDir, "codex");
  const kimiPath = join(binDir, "kimi");
  writeFileSync(codexPath, [
    "#!/usr/bin/env node",
    "console.error('Codex CLI returned 429 Too Many Requests. Retry after 20 seconds.');",
    "process.exit(1);"
  ].join("\n"), "utf8");
  writeFileSync(kimiPath, [
    "#!/usr/bin/env node",
    "console.error('Kimi returned 429 Too Many Requests. Retry after 10 seconds.');",
    "process.exit(1);"
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
    allowFailure: true,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` }
  });
  const checkpoint = readCheckpoint(taskDir);

  assert.equal(result.classification.class, "rate_limit");
  assert.equal(result.fallback.classification.class, "rate_limit");
  assert.equal(checkpoint.status, "blocked");
  assert.ok(checkpoint.workerCooldowns["codex-cli"].blockedUntil);
  assert.ok(checkpoint.workerCooldowns["kimi-cli"].blockedUntil);
  assert.equal(checkpoint.blockedUntil, checkpoint.workerCooldowns["kimi-cli"].blockedUntil);
}));

check("run waits when another worker holds the task lock", () => withTask((taskDir) => {
  const lockPath = join(taskDir, ".lth.lock");
  writeFileSync(lockPath, JSON.stringify({
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
  const lockPath = join(taskDir, ".lth.lock");
  writeFileSync(lockPath, JSON.stringify({
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
  assert.equal(existsSync(lockPath), false);
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

check("summary and tail report run events", () => withTask((taskDir) => {
  run([
    "record",
    taskDir,
    "--status", "paused",
    "--note", "Paused after observability check."
  ]);
  run(["tick", taskDir]);

  const summary = run(["summary", taskDir], { json: true });
  const tail = run(["tail", taskDir, "--limit", "1", "--type", "progress_recorded"], { json: true });

  assert.equal(summary.taskId, "coding-example");
  assert.equal(summary.status, "paused");
  assert.ok(summary.totalEvents >= 3);
  assert.ok(summary.eventCounts.progress_recorded >= 1);
  assert.ok(summary.lastEvent);
  assert.equal(tail.count, 1);
  assert.equal(tail.events[0].type, "progress_recorded");
}));

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
