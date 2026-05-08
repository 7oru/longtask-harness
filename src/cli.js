#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
    [--blocked-until <iso>] [--reason rate_limit|auth_error|external|manual|unknown]
    [--source openclaw-provider|codex-cli|scheduler|external-api|manual]
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
