#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const VERSION = "0.1.0";

function main(argv) {
  const [cmd, taskDirArg, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return help();
  if (cmd === "--version" || cmd === "-v") return console.log(VERSION);

  const taskDir = taskDirArg ? resolve(taskDirArg) : null;
  if (!taskDir && cmd !== "help") fail(`Missing task directory for "${cmd}".`);

  if (cmd === "init") return initTask(taskDir, parseArgs(rest));
  if (cmd === "validate") return validateTask(taskDir);
  if (cmd === "next") return printNext(taskDir);
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
  lth record <task-dir> --status active|paused|blocked|done --note "..."
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
    successCriteria: ["Define a verifiable acceptance criterion."],
    constraints: ["Keep each run bounded and checkpointed."],
    workerPolicy: {
      preferred: template === "coding" ? "openclaw-codex-cli" : "openclaw-direct-model",
      allowed: ["openclaw-direct-model", "openclaw-codex-cli"]
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
    evidence: [],
    updatedAt: now
  };

  writeJson(join(taskDir, "task.json"), task);
  writeJson(join(taskDir, "checkpoint.json"), checkpoint);
  writeFileSync(join(taskDir, "harness.md"), defaultHarness(template), "utf8");
  console.log(`Initialized ${template} task at ${taskDir}`);
}

function validateTask(taskDir) {
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
  if (task.id && checkpoint.taskId && task.id !== checkpoint.taskId) {
    errors.push(`checkpoint.taskId (${checkpoint.taskId}) must equal task.id (${task.id})`);
  }
  if (!existsSync(join(taskDir, "harness.md"))) errors.push("missing harness.md");

  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`OK ${task.id}: ${checkpoint.status} -> ${checkpoint.nextStep}`);
}

function printNext(taskDir) {
  validateTask(taskDir);
  if (process.exitCode) return;
  const checkpoint = readJson(join(taskDir, "checkpoint.json"));
  console.log(JSON.stringify({
    status: checkpoint.status,
    blockedUntil: checkpoint.blockedUntil,
    nextStep: checkpoint.nextStep
  }, null, 2));
}

function recordProgress(taskDir, args) {
  const status = args.status || "active";
  const note = args.note || "";
  if (!["active", "paused", "blocked", "done"].includes(status)) fail(`Invalid status: ${status}`);
  const checkpointPath = join(taskDir, "checkpoint.json");
  const checkpoint = readJson(checkpointPath);
  const now = new Date().toISOString();
  checkpoint.status = status;
  checkpoint.updatedAt = now;
  if (note) checkpoint.nextStep = note;
  writeJson(checkpointPath, checkpoint);

  const runPath = join(taskDir, "runs", `${now.slice(0, 10)}.jsonl`);
  mkdirSync(dirname(runPath), { recursive: true });
  appendFileSync(runPath, JSON.stringify({ type: "progress", status, note, at: now }) + "\n");
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
- If rate limited, set status to \`blocked\` and record a conservative next step.

## Worker Notes

Preferred template: \`${template}\`.
`;
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

function basenameSafe(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/[^a-zA-Z0-9._-]/g, "-") || "task";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main(process.argv.slice(2));

