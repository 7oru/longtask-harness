#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const VERSION = "0.2.0";

function main(argv) {
  const [cmd, taskDirArg, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return help();
  if (cmd === "--version" || cmd === "-v") return console.log(VERSION);

  const taskDir = taskDirArg ? resolve(taskDirArg) : null;
  if (!taskDir && cmd !== "help") fail(`Missing task directory for "${cmd}".`);

  if (cmd === "init") return initTask(taskDir, parseArgs(rest));
  if (cmd === "validate") return validateTask(taskDir);
  if (cmd === "next") return printNext(taskDir);
  if (cmd === "tick") return tick(taskDir, parseArgs(rest));
  if (cmd === "record") return recordProgress(taskDir, parseArgs(rest));
  if (cmd === "classify") return classifyCommand(taskDir, parseArgs(rest));
  if (cmd === "health") return healthCheck(taskDir, parseArgs(rest));
  if (cmd === "openclaw-recipe") return openclawRecipe(taskDir, parseArgs(rest));
  if (cmd === "help") return help();

  fail(`Unknown command: ${cmd}`);
}

function help() {
  console.log(`Longtask Harness ${VERSION}

Usage:
  lth init <task-dir> [--template coding|video-analysis]
  lth validate <task-dir>
  lth next <task-dir>
  lth tick <task-dir> [--dry-run]
  lth record <task-dir> --status active|paused|blocked|done|needs-human --note "..."
    [--blocked-until <iso>] [--reason rate_limit|auth_error|test_failure|missing_context|external|manual|unknown]
    [--source openclaw-provider|codex-cli|scheduler|external-api|manual]
  lth classify <task-dir> (--text "..."|--file <path>) [--source ...] [--exit-code <n>] [--record]
  lth health <task-dir>
  lth openclaw-recipe <task-dir> [--every 30m] [--name longtask-tick]
`);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = args[i + 1]?.startsWith("--") || args[i + 1] == null ? true : args[++i];
    out[key] = value;
  }
  return out;
}

function initTask(taskDir, args) {
  const template = args.template || "coding";
  if (!["coding", "video-analysis"].includes(template)) fail(`Unsupported template: ${template}`);
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(taskDir, "runs"), { recursive: true });
  mkdirSync(join(taskDir, "artifacts"), { recursive: true });
  mkdirSync(join(taskDir, "evidence"), { recursive: true });

  const now = new Date().toISOString();
  const task = {
    schemaVersion: 1,
    id: basenameSafe(taskDir),
    title: template === "coding" ? "Coding long task" : "Video analysis long task",
    domain: template,
    objective: "Replace this with a clear outcome.",
    successCriteria: [
      {
        id: "verified-outcome",
        description: "Define a verifiable acceptance criterion.",
        metric: "manual",
        weight: 1
      }
    ],
    constraints: [
      {
        id: "bounded-runs",
        description: "Keep each run bounded and checkpointed.",
        type: "hard",
        category: "scope"
      }
    ],
    context: {
      summary: "Add domain context, repo notes, source material, or user preferences here.",
      files: [],
      links: []
    },
    workerPolicy: {
      preferred: template === "coding" ? "openclaw-codex-cli" : "openclaw-direct-model",
      allowed: ["openclaw-direct-model", "openclaw-codex-cli"]
    },
    rateLimitPolicy: {
      sources: ["openclaw-provider", "codex-cli"],
      fallbackWaitSeconds: 14400,
      allowHandoffOnRateLimit: true
    },
    createdAt: now
  };
  const checkpoint = {
    schemaVersion: 1,
    taskId: task.id,
    status: "active",
    currentPhase: "setup",
    nextStep: "Fill in task.json, then run lth validate.",
    blockedUntil: null,
    blocker: null,
    lastCompletedStep: "",
    activeFiles: [],
    openQuestions: [],
    evidence: [],
    updatedAt: now
  };

  writeJson(join(taskDir, "task.json"), task);
  writeJson(join(taskDir, "checkpoint.json"), checkpoint);
  writeFileSync(join(taskDir, "harness.md"), defaultHarness(template), "utf8");
  console.log(`Initialized ${template} task at ${taskDir}`);
}

function validateTask(taskDir) {
  const { task, checkpoint, errors } = loadAndValidate(taskDir);

  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK ${task.id}: ${checkpoint.status} -> ${checkpoint.nextStep}`);
}

function printNext(taskDir) {
  const { checkpoint, errors } = loadAndValidate(taskDir);
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  const decision = decideNext(checkpoint);
  console.log(JSON.stringify({
    decision: decision.decision,
    reason: decision.reason,
    status: checkpoint.status,
    blockedUntil: checkpoint.blockedUntil,
    waitSeconds: decision.waitSeconds,
    nextStep: checkpoint.nextStep
  }, null, 2));
}

function tick(taskDir, args) {
  const dryRun = Boolean(args["dry-run"]);
  const { task, checkpoint, errors } = loadAndValidate(taskDir);
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const decision = decideNext(checkpoint, now);
  const events = [];
  events.push({
    type: "tick_started",
    decision: decision.decision,
    status: checkpoint.status,
    at: now.toISOString()
  });

  if (decision.decision === "wait") {
    events.push({
      type: "run_skipped",
      reason: decision.reason,
      blockedUntil: checkpoint.blockedUntil,
      waitSeconds: decision.waitSeconds,
      at: now.toISOString()
    });
  }

  if (decision.decision === "needs-human") {
    events.push({
      type: "needs_human",
      reason: decision.reason,
      nextStep: checkpoint.nextStep,
      at: now.toISOString()
    });
  }

  let workerPrompt = null;
  let checkpointChanged = false;
  if (decision.decision === "run") {
    const wasBlocked = checkpoint.status === "blocked";
    if (wasBlocked) {
      checkpoint.status = "active";
      checkpoint.blockedUntil = null;
      checkpoint.blocker = null;
      checkpoint.updatedAt = now.toISOString();
      checkpointChanged = true;
      events.push({
        type: "checkpoint_written",
        status: checkpoint.status,
        reason: "blocked window reopened",
        at: now.toISOString()
      });
    }
    workerPrompt = buildWorkerPrompt(task, checkpoint);
    events.push({
      type: "worker_prompt_generated",
      worker: task.workerPolicy?.preferred || "unspecified",
      at: now.toISOString()
    });
  }

  if (!dryRun) {
    if (checkpointChanged) {
      writeJson(join(taskDir, "checkpoint.json"), checkpoint);
    }
    for (const event of events) appendRunEvent(taskDir, event);
  }

  console.log(JSON.stringify({
    decision: decision.decision,
    reason: decision.reason,
    dryRun,
    status: checkpoint.status,
    blockedUntil: checkpoint.blockedUntil,
    waitSeconds: decision.waitSeconds,
    nextStep: checkpoint.nextStep,
    worker: task.workerPolicy?.preferred || null,
    workerPrompt
  }, null, 2));
}

function recordProgress(taskDir, args) {
  const status = args.status || "active";
  const note = args.note || "";
  if (!["active", "paused", "blocked", "done", "needs-human"].includes(status)) fail(`Invalid status: ${status}`);
  const checkpointPath = join(taskDir, "checkpoint.json");
  const checkpoint = readJson(checkpointPath);
  const now = new Date().toISOString();
  checkpoint.status = status;
  checkpoint.updatedAt = now;
  if (note) checkpoint.nextStep = note;
  if (args["last-completed-step"]) checkpoint.lastCompletedStep = String(args["last-completed-step"]);
  if (args["active-files"]) checkpoint.activeFiles = splitCsv(args["active-files"]);
  if (args["open-questions"]) checkpoint.openQuestions = splitCsv(args["open-questions"]);

  const blockedUntil = args["blocked-until"] || blockedUntilFromRetryAfter(args["retry-after-seconds"]);
  if (blockedUntil) {
    assertIsoDate(blockedUntil, "--blocked-until");
    checkpoint.blockedUntil = blockedUntil;
  } else if (status !== "blocked") {
    checkpoint.blockedUntil = null;
  }

  if (status === "blocked" || status === "needs-human" || args.reason || args.source) {
    checkpoint.blocker = {
      type: String(args.reason || (status === "needs-human" ? "manual" : "unknown")),
      source: String(args.source || "manual"),
      message: note,
      observedAt: now,
      retryAfterSeconds: args["retry-after-seconds"] ? Number(args["retry-after-seconds"]) : null,
      requiresHuman: status === "needs-human" || Boolean(args["requires-human"])
    };
  } else if (status === "active" || status === "paused" || status === "done") {
    checkpoint.blocker = null;
  }

  writeJson(checkpointPath, checkpoint);

  appendRunEvent(taskDir, {
    type: "progress_recorded",
    status,
    note,
    blockedUntil: checkpoint.blockedUntil,
    blocker: checkpoint.blocker,
    at: now
  });
  console.log(`Recorded ${status} for ${checkpoint.taskId}`);
}

function classifyCommand(taskDir, args) {
  const { task, checkpoint, errors } = loadAndValidate(taskDir);
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const text = readClassifierInput(args);
  const result = classifyFailure(text, {
    source: args.source,
    exitCode: args["exit-code"],
    task
  });

  if (args.record) {
    applyClassification(taskDir, checkpoint, result, text);
  }

  console.log(JSON.stringify(result, null, 2));
}

function healthCheck(taskDir, args) {
  const { task, checkpoint, errors } = loadAndValidate(taskDir);
  const checks = [];

  checks.push({
    name: "task-contract",
    status: errors.length ? "fail" : "pass",
    message: errors.length ? errors.join("; ") : "task, checkpoint, and harness are readable"
  });

  if (!errors.length) {
    const decision = decideNext(checkpoint);
    checks.push({
      name: "run-decision",
      status: decision.decision === "needs-human" ? "warn" : "pass",
      message: `${decision.decision}: ${decision.reason}`,
      decision: decision.decision,
      waitSeconds: decision.waitSeconds
    });
  }

  const allowed = task.workerPolicy?.allowed || [];
  const preferred = task.workerPolicy?.preferred || "";
  if (preferred || allowed.includes("openclaw-direct-model") || allowed.includes("openclaw-codex-cli")) {
    checks.push(commandCheck("openclaw", ["--version"], "OpenClaw CLI"));
  }
  if (preferred === "openclaw-codex-cli" || allowed.includes("openclaw-codex-cli")) {
    checks.push(commandCheck("codex", ["--version"], "Codex CLI"));
  }

  const repoPath = task.context?.repoPath || task.context?.repository || null;
  if (repoPath) {
    checks.push(gitRepoCheck(resolve(String(repoPath))));
  } else if (task.domain === "coding") {
    checks.push({
      name: "repo-context",
      status: "warn",
      message: "coding task has no context.repoPath; worker must infer the trusted repo from harness.md or user input"
    });
  }

  const overall = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  console.log(JSON.stringify({
    status: overall,
    taskId: task.id,
    preferredWorker: preferred || null,
    checks
  }, null, 2));

  if (overall === "fail" && args.strict) process.exitCode = 1;
}

function openclawRecipe(taskDir, args) {
  const { task, errors } = loadAndValidate(taskDir);
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const every = String(args.every || "30m");
  const name = String(args.name || `${task.id}-tick`);
  const model = String(args.model || "minimax/MiniMax-M2.5");
  const sessionKey = String(args["session-key"] || `agent:main:cron:${task.id}`);
  const timeoutSeconds = String(args["timeout-seconds"] || "300");
  const tools = String(args.tools || "exec read write");
  const message = [
    `Run: node ${shellQuote(relativeCliPath())} tick ${shellQuote(taskDir)}.`,
    "If the decision is wait, done, or needs-human, stop after reporting the decision.",
    "If the decision is run, start exactly one bounded worker slice using the generated workerPrompt.",
    "Before stopping, update checkpoint.json and append run events."
  ].join(" ");

  const lines = [
    "openclaw cron add \\",
    `  --name ${shellQuote(name)} \\`,
    `  --every ${shellQuote(every)} \\`,
    "  --session isolated \\",
    `  --session-key ${shellQuote(sessionKey)} \\`,
    `  --model ${shellQuote(model)} \\`,
    `  --tools ${shellQuote(tools)} \\`,
    `  --timeout-seconds ${shellQuote(timeoutSeconds)} \\`,
    `  --message ${shellQuote(message)}`
  ];

  console.log(JSON.stringify({
    taskId: task.id,
    command: lines.join("\n"),
    message,
    schedule: { every, name, sessionKey, model, timeoutSeconds, tools }
  }, null, 2));
}

function defaultHarness(template) {
  return `# Harness

## Run Rules

- Read \`task.json\`, \`checkpoint.json\`, and this file before doing work.
- Do one bounded slice per run.
- Prefer reversible edits and small commits.
- Record evidence before claiming success.
- Update \`checkpoint.json\` before stopping.
- If rate limited, set status to \`blocked\`, record \`blockedUntil\`, and write a conservative next step.
- If a blocker requires human judgment, set status to \`needs-human\`.

## Worker Notes

Preferred template: \`${template}\`.
`;
}

function loadAndValidate(taskDir) {
  const task = readJson(join(taskDir, "task.json"));
  const checkpoint = readJson(join(taskDir, "checkpoint.json"));
  const errors = [];

  requireString(task, "id", errors);
  requireString(task, "title", errors);
  requireString(task, "domain", errors);
  requireString(task, "objective", errors);
  requireArray(task, "successCriteria", errors);
  requireString(checkpoint, "taskId", errors);
  requireString(checkpoint, "status", errors);
  requireString(checkpoint, "nextStep", errors);
  if (!["active", "paused", "blocked", "done", "needs-human"].includes(checkpoint.status)) {
    errors.push(`invalid checkpoint.status: ${checkpoint.status}`);
  }
  if (checkpoint.blockedUntil != null && Number.isNaN(Date.parse(checkpoint.blockedUntil))) {
    errors.push(`invalid checkpoint.blockedUntil: ${checkpoint.blockedUntil}`);
  }
  if (task.id && checkpoint.taskId && task.id !== checkpoint.taskId) {
    errors.push(`checkpoint.taskId (${checkpoint.taskId}) must equal task.id (${task.id})`);
  }
  if (!existsSync(join(taskDir, "harness.md"))) errors.push("missing harness.md");
  return { task, checkpoint, errors };
}

function decideNext(checkpoint, now = new Date()) {
  if (checkpoint.status === "done") {
    return { decision: "done", reason: "task is complete", waitSeconds: 0 };
  }
  if (checkpoint.status === "needs-human") {
    return { decision: "needs-human", reason: "checkpoint requires human input", waitSeconds: 0 };
  }
  if (checkpoint.blocker?.requiresHuman) {
    return { decision: "needs-human", reason: "blocker requires human input", waitSeconds: 0 };
  }
  if (checkpoint.status === "blocked") {
    if (!checkpoint.blockedUntil) {
      return { decision: "needs-human", reason: "blocked without blockedUntil", waitSeconds: 0 };
    }
    const blockedUntil = new Date(checkpoint.blockedUntil);
    if (Number.isNaN(blockedUntil.getTime())) {
      return { decision: "needs-human", reason: "invalid blockedUntil", waitSeconds: 0 };
    }
    if (blockedUntil > now) {
      return {
        decision: "wait",
        reason: "blocked window has not reopened",
        waitSeconds: Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000)
      };
    }
    return { decision: "run", reason: "blocked window reopened", waitSeconds: 0 };
  }
  return { decision: "run", reason: `checkpoint status is ${checkpoint.status}`, waitSeconds: 0 };
}

function buildWorkerPrompt(task, checkpoint) {
  return [
    "Read task.json, checkpoint.json, and harness.md before doing work.",
    "Continue exactly one bounded slice.",
    "Respect constraints, success criteria, blockedUntil, and the worker policy.",
    "Before stopping, update checkpoint.json and append run evidence.",
    "",
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    `Current phase: ${checkpoint.currentPhase || "unspecified"}`,
    `Next step: ${checkpoint.nextStep}`,
    checkpoint.lastCompletedStep ? `Last completed step: ${checkpoint.lastCompletedStep}` : "",
    checkpoint.activeFiles?.length ? `Active files: ${checkpoint.activeFiles.join(", ")}` : "",
    checkpoint.openQuestions?.length ? `Open questions: ${checkpoint.openQuestions.join("; ")}` : ""
  ].filter(Boolean).join("\n");
}

function readClassifierInput(args) {
  if (args.text) return String(args.text);
  if (args.file) return readFileSync(resolve(String(args.file)), "utf8");
  fail("classify requires --text or --file.");
}

function classifyFailure(text, opts = {}) {
  const normalized = String(text || "");
  const lower = normalized.toLowerCase();
  const exitCode = opts.exitCode == null || opts.exitCode === true ? null : Number(opts.exitCode);
  const source = inferFailureSource(lower, opts.source);
  const retryAfterSeconds = parseRetryAfterSeconds(normalized);
  const fallbackWaitSeconds = opts.task?.rateLimitPolicy?.fallbackWaitSeconds ?? 14400;

  if (matchesAny(lower, [
    "rate limit",
    "ratelimit",
    "rate_limit",
    "too many requests",
    "quota exceeded",
    "quota_exceeded",
    "429",
    "try again later",
    "retry after"
  ])) {
    const waitSeconds = retryAfterSeconds ?? fallbackWaitSeconds;
    return {
      class: "rate_limit",
      source,
      statusSuggestion: "blocked",
      blockedUntil: new Date(Date.now() + waitSeconds * 1000).toISOString(),
      retryAfterSeconds,
      fallbackWaitSeconds,
      confidence: retryAfterSeconds == null ? 0.78 : 0.9,
      summary: "Rate limit or quota window detected."
    };
  }

  if (matchesAny(lower, [
    "unauthorized",
    "authentication",
    "auth error",
    "invalid api key",
    "api key",
    "permission denied",
    "forbidden",
    "401",
    "403"
  ])) {
    return {
      class: "auth_error",
      source,
      statusSuggestion: "needs-human",
      blockedUntil: null,
      retryAfterSeconds: null,
      confidence: 0.82,
      summary: "Authentication or permission problem detected."
    };
  }

  if (matchesAny(lower, [
    "test failed",
    "tests failed",
    "failing test",
    "assertionerror",
    "err_assertion",
    "expected",
    "received",
    "npm err!",
    "failed test"
  ])) {
    return {
      class: "test_failure",
      source,
      statusSuggestion: "paused",
      blockedUntil: null,
      retryAfterSeconds: null,
      confidence: 0.72,
      summary: "Test or assertion failure detected."
    };
  }

  if (matchesAny(lower, [
    "missing context",
    "not enough context",
    "need more context",
    "cannot find",
    "could not find",
    "file not found",
    "enoent",
    "no such file"
  ])) {
    return {
      class: "missing_context",
      source,
      statusSuggestion: "needs-human",
      blockedUntil: null,
      retryAfterSeconds: null,
      confidence: 0.7,
      summary: "Missing context or missing file detected."
    };
  }

  return {
    class: exitCode === 0 ? "success" : "unknown",
    source,
    statusSuggestion: exitCode === 0 ? "paused" : "needs-human",
    blockedUntil: null,
    retryAfterSeconds: null,
    confidence: exitCode === 0 ? 0.6 : 0.2,
    summary: exitCode === 0 ? "No failure pattern detected." : "No known failure pattern detected."
  };
}

function applyClassification(taskDir, checkpoint, result, text) {
  const now = new Date().toISOString();
  checkpoint.status = result.statusSuggestion;
  checkpoint.updatedAt = now;
  checkpoint.nextStep = nextStepForClassification(result);
  checkpoint.blockedUntil = result.blockedUntil;
  checkpoint.blocker = result.class === "success" ? null : {
    type: result.class,
    source: result.source,
    message: result.summary,
    observedAt: now,
    retryAfterSeconds: result.retryAfterSeconds,
    requiresHuman: result.statusSuggestion === "needs-human"
  };
  writeJson(join(taskDir, "checkpoint.json"), checkpoint);
  appendRunEvent(taskDir, {
    type: result.class === "rate_limit" ? "rate_limited" : "failure_classified",
    status: checkpoint.status,
    reason: result.class,
    note: truncate(text, 500),
    blockedUntil: checkpoint.blockedUntil,
    blocker: checkpoint.blocker,
    at: now
  });
  appendRunEvent(taskDir, {
    type: "checkpoint_written",
    status: checkpoint.status,
    reason: `classified ${result.class}`,
    at: now
  });
}

function nextStepForClassification(result) {
  if (result.class === "rate_limit") return "Resume the same bounded slice after the rate-limit window reopens.";
  if (result.class === "auth_error") return "Fix authentication or permissions, then rerun health checks.";
  if (result.class === "test_failure") return "Inspect the failing test output and fix the smallest failing slice.";
  if (result.class === "missing_context") return "Provide the missing file, repo path, or task context before resuming.";
  if (result.class === "success") return "Review the completed slice and decide the next bounded step.";
  return "Human review required: classify the failure and choose the next bounded step.";
}

function inferFailureSource(text, explicitSource) {
  if (explicitSource && explicitSource !== true) return String(explicitSource);
  if (text.includes("codex")) return "codex-cli";
  if (text.includes("openclaw") || text.includes("minimax")) return "openclaw-provider";
  if (text.includes("cron") || text.includes("scheduler")) return "scheduler";
  if (text.includes("api")) return "external-api";
  return "manual";
}

function parseRetryAfterSeconds(text) {
  const retryAfter = text.match(/retry(?:\s|-)?after(?:\s|:)+(\d+)/i);
  if (retryAfter) return Number(retryAfter[1]);
  const resetIn = text.match(/(?:reset|resets|try again)(?:\s+\w+){0,3}\s+in\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)/i);
  if (!resetIn) return null;
  const value = Number(resetIn[1]);
  const unit = resetIn[2].toLowerCase();
  if (unit.startsWith("hour")) return value * 3600;
  if (unit.startsWith("minute")) return value * 60;
  return value;
}

function matchesAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function commandCheck(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 3000 });
  if (result.error) {
    return {
      name: `${command}-cli`,
      status: "warn",
      message: `${label} was not found on PATH`
    };
  }
  if (result.status !== 0) {
    return {
      name: `${command}-cli`,
      status: "warn",
      message: `${label} command exited with ${result.status}`
    };
  }
  return {
    name: `${command}-cli`,
    status: "pass",
    message: firstLine(result.stdout || result.stderr) || `${label} is available`
  };
}

function gitRepoCheck(repoPath) {
  if (!existsSync(repoPath)) {
    return { name: "repo-context", status: "fail", message: `repoPath does not exist: ${repoPath}` };
  }
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    timeout: 3000
  });
  if (result.status !== 0 || result.stdout.trim() !== "true") {
    return { name: "repo-context", status: "fail", message: `repoPath is not a git worktree: ${repoPath}` };
  }
  return { name: "repo-context", status: "pass", message: `repoPath is a git worktree: ${repoPath}` };
}

function requireString(obj, key, errors) {
  if (typeof obj[key] !== "string" || obj[key].trim() === "") errors.push(`missing string: ${key}`);
}

function requireArray(obj, key, errors) {
  if (!Array.isArray(obj[key]) || obj[key].length === 0) errors.push(`missing non-empty array: ${key}`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Cannot read JSON ${path}: ${error.message}`);
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function appendRunEvent(taskDir, event) {
  const at = event.at || new Date().toISOString();
  const runPath = join(taskDir, "runs", `${at.slice(0, 10)}.jsonl`);
  mkdirSync(dirname(runPath), { recursive: true });
  appendFileSync(runPath, JSON.stringify({ ...event, at }) + "\n");
}

function relativeCliPath() {
  return "src/cli.js";
}

function shellQuote(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function firstLine(text) {
  return String(text).split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function truncate(text, max) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function blockedUntilFromRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) fail(`Invalid --retry-after-seconds: ${value}`);
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function assertIsoDate(value, flag) {
  if (Number.isNaN(Date.parse(value))) fail(`Invalid ${flag}: ${value}`);
}

function splitCsv(value) {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function basenameSafe(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/[^a-zA-Z0-9._-]/g, "-") || "task";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main(process.argv.slice(2));
