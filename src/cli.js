#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const VERSION = "0.2.0";

function main(argv) {
  const [cmd, taskDirArg, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") return help();
  if (cmd === "--version" || cmd === "-v") return console.log(VERSION);

  const taskDir = taskDirArg ? resolve(taskDirArg) : null;
  if (!taskDir && cmd !== "help") fail(`Missing task directory for "${cmd}".`);

  if (cmd === "init" || cmd === "initiate") return initTask(taskDir, parseArgs(rest));
  if (cmd === "validate") return validateTask(taskDir);
  if (cmd === "next") return printNext(taskDir);
  if (cmd === "tick") return tick(taskDir, parseArgs(rest));
  if (cmd === "run") return runWorker(taskDir, parseArgs(rest));
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
    [--scheduler openclaw-cron|manual] [--worker codex-cli|kimi-cli|local-command]
    [--fallback-worker kimi-cli] [--cwd <dir>] [--check] [--strict]
  lth validate <task-dir>
  lth next <task-dir>
  lth tick <task-dir> [--dry-run]
  lth run <task-dir> [--worker local-command|codex-cli|kimi-cli] [--command "..."] [--cwd <dir>]
    [--timeout-seconds <n>] [--lock-ttl-seconds <n>] [--codex-session-path <path>]
    [--fallback-worker <worker>] [--dry-run]
  lth record <task-dir> --status active|paused|blocked|done|needs-human --note "..."
    [--blocked-until <iso>] [--reason rate_limit|auth_error|test_failure|missing_context|external|manual|unknown]
    [--source openclaw-provider|codex-cli|kimi-cli|scheduler|external-api|manual]
  lth classify <task-dir> (--text "..."|--file <path>) [--source ...] [--exit-code <n>]
    [--codex-session-path <path>] [--record]
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
  const scheduler = normalizeScheduler(args.scheduler || (template === "coding" ? "openclaw-cron" : "manual"));
  const preferredWorker = normalizeWorker(args.worker || (template === "coding" ? "codex-cli" : "local-command"));
  const fallbackWorker = args["fallback-worker"] && args["fallback-worker"] !== true
    ? normalizeWorker(args["fallback-worker"])
    : null;
  const cwd = args.cwd && args.cwd !== true ? resolve(String(args.cwd)) : null;
  const timeoutSeconds = args["timeout-seconds"] && args["timeout-seconds"] !== true
    ? Number(args["timeout-seconds"])
    : null;
  if (timeoutSeconds != null) assertPositiveSeconds(timeoutSeconds, "--timeout-seconds");

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
      links: [],
      ...(cwd ? { repoPath: cwd } : {})
    },
    scheduler: {
      type: scheduler,
      ...(scheduler === "openclaw-cron" ? {
        every: String(args.every || "30m"),
        name: String(args.name || `${basenameSafe(taskDir)}-tick`),
        model: String(args.model || "minimax/MiniMax-M2.5"),
        timeoutSeconds: Number(args["scheduler-timeout-seconds"] || 300)
      } : {})
    },
    workerPolicy: {
      preferred: preferredWorker,
      allowed: uniqueStrings([preferredWorker, fallbackWorker].filter(Boolean)),
      ...(fallbackWorker ? { fallbackOnRateLimit: fallbackWorker } : {})
    },
    ...workerConfigForInit({ preferredWorker, fallbackWorker, cwd, timeoutSeconds, args }),
    rateLimitPolicy: {
      sources: rateLimitSourcesForInit({ scheduler, preferredWorker, fallbackWorker }),
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
  if (args.check) {
    const health = buildHealthReport(taskDir, { strict: args.strict });
    console.log(JSON.stringify({
      initialized: true,
      taskDir,
      taskId: task.id,
      scheduler,
      worker: preferredWorker,
      fallbackWorker,
      health
    }, null, 2));
    if (health.status === "fail" && args.strict) process.exitCode = 1;
    return;
  }
  console.log(`Initialized ${template} task at ${taskDir}`);
}

function workerConfigForInit({ preferredWorker, fallbackWorker, cwd, timeoutSeconds, args }) {
  const workers = new Set([preferredWorker, fallbackWorker].filter(Boolean));
  const config = {};
  if (workers.has("codex-cli")) {
    config.codexWorker = {
      ...(cwd ? { cwd } : {}),
      ...(args.model && args.model !== true ? { model: String(args.model) } : {}),
      ...(args.sandbox && args.sandbox !== true ? { sandbox: String(args.sandbox) } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {})
    };
  }
  if (workers.has("kimi-cli")) {
    config.kimiWorker = {
      ...(cwd ? { cwd } : {}),
      ...(args["kimi-model"] && args["kimi-model"] !== true ? { model: String(args["kimi-model"]) } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {})
    };
  }
  if (workers.has("local-command")) {
    config.localWorker = {
      ...(args.command && args.command !== true ? { command: String(args.command) } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timeoutSeconds ? { timeoutSeconds } : {})
    };
  }
  return config;
}

function rateLimitSourcesForInit({ scheduler, preferredWorker, fallbackWorker }) {
  const sources = [];
  if (scheduler === "openclaw-cron") sources.push("openclaw-provider");
  for (const worker of [preferredWorker, fallbackWorker]) {
    if (worker === "codex-cli" || worker === "kimi-cli") sources.push(worker);
  }
  return uniqueStrings(sources);
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

function runWorker(taskDir, args) {
  const dryRun = Boolean(args["dry-run"]);
  const { task, checkpoint, errors } = loadAndValidate(taskDir);
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  if (dryRun) return runWorkerUnlocked(taskDir, args, task, checkpoint, dryRun);

  const lock = acquireRunLock(taskDir, task, args);
  if (!lock.acquired) {
    return printRunResult({
      decision: "wait",
      reason: "task lock is active",
      dryRun,
      status: checkpoint.status,
      waitSeconds: lock.waitSeconds,
      worker: null,
      lock: lock.info
    });
  }

  try {
    return runWorkerUnlocked(taskDir, args, task, checkpoint, dryRun);
  } finally {
    releaseRunLock(lock);
  }
}

function runWorkerUnlocked(taskDir, args, task, checkpoint, dryRun) {
  const now = new Date();
  const decision = decideNext(checkpoint, now);
  const events = [{
    type: "tick_started",
    decision: decision.decision,
    status: checkpoint.status,
    at: now.toISOString()
  }];

  if (decision.decision === "wait") {
    events.push({
      type: "run_skipped",
      reason: decision.reason,
      blockedUntil: checkpoint.blockedUntil,
      waitSeconds: decision.waitSeconds,
      at: now.toISOString()
    });
    if (!dryRun) appendEvents(taskDir, events);
    return printRunResult({
      decision: decision.decision,
      reason: decision.reason,
      dryRun,
      status: checkpoint.status,
      waitSeconds: decision.waitSeconds,
      worker: null
    });
  }

  if (decision.decision === "done" || decision.decision === "needs-human") {
    if (decision.decision === "needs-human") {
      events.push({
        type: "needs_human",
        reason: decision.reason,
        nextStep: checkpoint.nextStep,
        at: now.toISOString()
      });
    }
    if (!dryRun) appendEvents(taskDir, events);
    return printRunResult({
      decision: decision.decision,
      reason: decision.reason,
      dryRun,
      status: checkpoint.status,
      waitSeconds: decision.waitSeconds,
      worker: null
    });
  }

  const wasBlocked = checkpoint.status === "blocked";
  if (wasBlocked) {
    checkpoint.status = "active";
    checkpoint.blockedUntil = null;
    checkpoint.blocker = null;
    checkpoint.updatedAt = now.toISOString();
    events.push({
      type: "checkpoint_written",
      status: checkpoint.status,
      reason: "blocked window reopened",
      at: now.toISOString()
    });
  }
  const clearedCooldowns = clearExpiredWorkerCooldowns(checkpoint, now);
  for (const workerName of clearedCooldowns) {
    checkpoint.updatedAt = now.toISOString();
    events.push({
      type: "checkpoint_written",
      status: checkpoint.status,
      worker: workerName,
      reason: "worker cooldown expired",
      at: now.toISOString()
    });
  }

  const workerPrompt = buildWorkerPrompt(task, checkpoint);
  const requestedWorker = normalizeWorker(args.worker || task.workerPolicy?.preferred || "local-command");
  const selection = selectWorkerForRun({ requestedWorker, task, args, checkpoint, now });
  if (selection.wait) {
    events.push({
      type: "run_skipped",
      reason: selection.reason,
      worker: requestedWorker,
      blockedUntil: selection.cooldown?.blockedUntil || null,
      waitSeconds: selection.waitSeconds,
      at: now.toISOString()
    });
    if (!dryRun) appendEvents(taskDir, events);
    return printRunResult({
      decision: "wait",
      reason: selection.reason,
      dryRun,
      status: checkpoint.status,
      waitSeconds: selection.waitSeconds,
      worker: null,
      requestedWorker,
      workerCooldown: selection.cooldown
    });
  }
  const worker = selection.worker;
  const commandPlan = buildWorkerCommand(taskDir, task, worker, workerPrompt, args);
  events.push({
    type: "worker_prompt_generated",
    worker,
    requestedWorker,
    degradedFrom: selection.degradedFrom || undefined,
    blockedUntil: selection.cooldown?.blockedUntil || undefined,
    at: now.toISOString()
  });

  if (dryRun) {
    return printRunResult({
      decision: decision.decision,
      reason: decision.reason,
      dryRun,
      status: checkpoint.status,
      waitSeconds: decision.waitSeconds,
      worker,
      requestedWorker,
      degradedFrom: selection.degradedFrom || undefined,
      workerCooldown: selection.cooldown || undefined,
      command: commandPlan.displayCommand,
      cwd: commandPlan.cwd,
      workerPrompt
    });
  }

  if (wasBlocked || clearedCooldowns.length) writeJson(join(taskDir, "checkpoint.json"), checkpoint);
  appendEvents(taskDir, events);

  const startedAt = new Date().toISOString();
  appendRunEvent(taskDir, {
    type: "worker_started",
    worker,
    note: commandPlan.displayCommand,
    at: startedAt
  });

  const beforeUpdatedAt = checkpoint.updatedAt;
  const result = executeWorkerCommand(commandPlan, workerPrompt);
  const finishedAt = new Date().toISOString();
  const outputPath = writeWorkerOutput(taskDir, {
    worker,
    command: commandPlan.displayCommand,
    cwd: commandPlan.cwd,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message || null,
    startedAt,
    finishedAt
  });

  appendRunEvent(taskDir, {
    type: result.status === 0 ? "worker_completed" : "worker_failed",
    worker,
    status: result.status === 0 ? "paused" : "needs-human",
    reason: result.status === 0 ? "exit 0" : `exit ${result.status}`,
    note: outputPath,
    evidence: [{ type: "worker-output", path: outputPath }],
    at: finishedAt
  });

  let finalCheckpoint = readJson(join(taskDir, "checkpoint.json"));
  let classification = null;
  if (result.status === 0) {
    if (finalCheckpoint.updatedAt === beforeUpdatedAt) {
      finalCheckpoint.status = "paused";
      finalCheckpoint.lastCompletedStep = `Worker ${worker} completed one bounded slice.`;
      finalCheckpoint.nextStep = "Review worker output and choose the next bounded step.";
      finalCheckpoint.evidence = Array.isArray(finalCheckpoint.evidence) ? finalCheckpoint.evidence : [];
      finalCheckpoint.evidence.push({
        type: "worker-output",
        path: outputPath,
        observedAt: finishedAt
      });
      finalCheckpoint.updatedAt = finishedAt;
      finalCheckpoint.blocker = null;
      finalCheckpoint.blockedUntil = null;
      writeJson(join(taskDir, "checkpoint.json"), finalCheckpoint);
      appendRunEvent(taskDir, {
        type: "checkpoint_written",
        status: finalCheckpoint.status,
        reason: "worker completed without checkpoint update",
        at: finishedAt
      });
    }
  } else {
    const combinedOutput = [result.stdout, result.stderr, result.error?.message || ""].filter(Boolean).join("\n");
    classification = classifyFailure(combinedOutput, {
      source: worker,
      exitCode: result.status,
      task
    });
    const primaryFailureEvidence = [
      {
        type: "worker-output",
        path: outputPath,
        observedAt: finishedAt
      },
      codexSessionEvidenceForFailure({
        worker,
        task,
        args,
        text: combinedOutput,
        classification,
        startedAt,
        finishedAt
      })
    ].filter(Boolean);
    const fallbackWorker = fallbackWorkerForRateLimit({ worker, classification, task, args });
    if (fallbackWorker) {
      const fallback = executeFallbackWorker({
        taskDir,
        task,
        args,
        primaryWorker: worker,
        worker: fallbackWorker,
        workerPrompt,
        beforeUpdatedAt,
        primaryClassification: classification,
        primaryEvidence: primaryFailureEvidence
      });
      return printFallbackRunResult({
        taskDir,
        decision,
        dryRun,
        worker,
        commandPlan,
        result,
        outputPath,
        classification,
        fallback
      });
    }
    finalCheckpoint = readJson(join(taskDir, "checkpoint.json"));
    applyWorkerCooldown(finalCheckpoint, worker, classification, primaryFailureEvidence, finishedAt);
    applyClassification(taskDir, finalCheckpoint, classification, combinedOutput, {
      evidence: primaryFailureEvidence
    });
  }

  printRunResult({
    decision: decision.decision,
    reason: decision.reason,
    dryRun,
    status: readJson(join(taskDir, "checkpoint.json")).status,
    waitSeconds: decision.waitSeconds,
    worker,
    requestedWorker,
    degradedFrom: selection.degradedFrom || undefined,
    workerCooldown: selection.cooldown || undefined,
    command: commandPlan.displayCommand,
    cwd: commandPlan.cwd,
    exitCode: result.status,
    outputPath,
    classification
  });

  if (result.status !== 0) process.exitCode = result.status;
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
    applyClassification(taskDir, checkpoint, result, text, {
      evidence: codexSessionEvidenceForFailure({
        worker: result.source === "codex-cli" ? "codex-cli" : result.source,
        task,
        args,
        text,
        classification: result,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        finishedAt: new Date().toISOString()
      })
    });
  }

  console.log(JSON.stringify(result, null, 2));
}

function healthCheck(taskDir, args) {
  const report = buildHealthReport(taskDir, args);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "fail" && args.strict) process.exitCode = 1;
}

function buildHealthReport(taskDir, args = {}) {
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

  const scheduler = normalizeScheduler(task.scheduler?.type || (task.workerPolicy?.preferred === "openclaw-direct-model" ? "openclaw-cron" : "manual"));
  if (!errors.length) {
    checks.push(schedulerConfigCheck(task, scheduler));
  }
  if (scheduler === "openclaw-cron" || task.workerPolicy?.preferred === "openclaw-direct-model" || (task.workerPolicy?.allowed || []).includes("openclaw-direct-model")) {
    checks.push(commandCheck("openclaw", ["--version"], "OpenClaw CLI"));
  }

  const allowed = task.workerPolicy?.allowed || [];
  const normalizedAllowed = allowed.map(normalizeWorker);
  const preferred = task.workerPolicy?.preferred || "";
  const normalizedPreferred = normalizeWorker(preferred);
  if (normalizedPreferred === "codex-cli" || normalizedAllowed.includes("codex-cli")) {
    checks.push(commandCheck("codex", ["--version"], "Codex CLI"));
  }
  if (normalizedPreferred === "kimi-cli" || normalizedAllowed.includes("kimi-cli") || normalizeWorker(task.workerPolicy?.fallbackOnRateLimit) === "kimi-cli") {
    checks.push(commandCheck("kimi", ["--version"], "Kimi CLI"));
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

  if (!errors.length) {
    for (const worker of configuredWorkers(task)) {
      checks.push(workerPlanCheck(taskDir, task, worker));
    }
  }

  const overall = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn")
      ? "warn"
      : "pass";

  return {
    status: overall,
    taskId: task.id,
    scheduler,
    preferredWorker: preferred || null,
    checks
  };
}

function openclawRecipe(taskDir, args) {
  const { task, errors } = loadAndValidate(taskDir);
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  const every = String(args.every || task.scheduler?.every || "30m");
  const name = String(args.name || task.scheduler?.name || `${task.id}-tick`);
  const model = String(args.model || task.scheduler?.model || "minimax/MiniMax-M2.5");
  const sessionKey = String(args["session-key"] || `agent:main:cron:${task.id}`);
  const timeoutSeconds = String(args["timeout-seconds"] || task.scheduler?.timeoutSeconds || "300");
  const tools = String(args.tools || "exec read write");
  const worker = normalizeWorker(args.worker || task.workerPolicy?.preferred || "");
  const fallbackWorker = normalizeWorker(args["fallback-worker"] || task.workerPolicy?.fallbackOnRateLimit || "");
  const fallbackFlag = fallbackWorker ? ` --fallback-worker ${shellQuote(fallbackWorker)}` : "";
  const schedulerCommand = isRunnableWorker(worker)
    ? `node ${shellQuote(relativeCliPath())} run ${shellQuote(taskDir)} --worker ${shellQuote(worker)}${fallbackFlag} --timeout-seconds ${shellQuote(timeoutSeconds)}`
    : `node ${shellQuote(relativeCliPath())} tick ${shellQuote(taskDir)}`;
  const message = isRunnableWorker(worker)
    ? [
      `Run: ${schedulerCommand}.`,
      "Report the JSON result and stop."
    ].join(" ")
    : [
      `Run: ${schedulerCommand}.`,
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
    schedule: { every, name, sessionKey, model, timeoutSeconds, tools, worker, schedulerCommand }
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

function applyClassification(taskDir, checkpoint, result, text, opts = {}) {
  const now = new Date().toISOString();
  const evidence = normalizeEvidence(opts.evidence, now);
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
  if (evidence.length) {
    checkpoint.evidence = appendEvidenceItems(checkpoint.evidence, evidence);
  }
  writeJson(join(taskDir, "checkpoint.json"), checkpoint);
  appendRunEvent(taskDir, {
    type: result.class === "rate_limit" ? "rate_limited" : "failure_classified",
    status: checkpoint.status,
    reason: result.class,
    note: truncate(text, 500),
    blockedUntil: checkpoint.blockedUntil,
    blocker: checkpoint.blocker,
    evidence: evidence.length ? evidence : undefined,
    at: now
  });
  appendRunEvent(taskDir, {
    type: "checkpoint_written",
    status: checkpoint.status,
    reason: `classified ${result.class}`,
    at: now
  });
}

function fallbackWorkerForRateLimit({ worker, classification, task, args }) {
  if (worker !== "codex-cli" || classification?.class !== "rate_limit") return null;
  const configured = args["fallback-worker"] || task.workerPolicy?.fallbackOnRateLimit;
  if (!configured || configured === true) return null;
  const fallback = normalizeWorker(configured);
  return fallback && fallback !== worker ? fallback : null;
}

function selectWorkerForRun({ requestedWorker, task, args, checkpoint, now }) {
  const cooldown = activeWorkerCooldown(checkpoint, requestedWorker, now);
  if (!cooldown) return { worker: requestedWorker };
  const fallback = normalizeWorker(args["fallback-worker"] || task.workerPolicy?.fallbackOnRateLimit || "");
  if (fallback && fallback !== requestedWorker) {
    return {
      worker: fallback,
      degradedFrom: requestedWorker,
      cooldown
    };
  }
  return {
    wait: true,
    reason: `${requestedWorker} is rate-limited until ${cooldown.blockedUntil}`,
    waitSeconds: Math.max(1, Math.ceil((Date.parse(cooldown.blockedUntil) - now.getTime()) / 1000)),
    cooldown
  };
}

function activeWorkerCooldown(checkpoint, worker, now = new Date()) {
  const cooldown = checkpoint.workerCooldowns?.[worker];
  if (!cooldown?.blockedUntil) return null;
  const blockedUntil = Date.parse(cooldown.blockedUntil);
  if (!Number.isFinite(blockedUntil) || blockedUntil <= now.getTime()) return null;
  return cooldown;
}

function clearExpiredWorkerCooldowns(checkpoint, now = new Date()) {
  const cooldowns = checkpoint.workerCooldowns;
  if (!cooldowns || typeof cooldowns !== "object") return [];
  const cleared = [];
  for (const [worker, cooldown] of Object.entries(cooldowns)) {
    const blockedUntil = Date.parse(cooldown?.blockedUntil || "");
    if (!Number.isFinite(blockedUntil) || blockedUntil <= now.getTime()) {
      delete cooldowns[worker];
      cleared.push(worker);
    }
  }
  if (Object.keys(cooldowns).length === 0) delete checkpoint.workerCooldowns;
  return cleared;
}

function applyWorkerCooldown(checkpoint, worker, classification, evidence, observedAt) {
  if (!worker || classification?.class !== "rate_limit" || !classification.blockedUntil) return;
  checkpoint.workerCooldowns = checkpoint.workerCooldowns && typeof checkpoint.workerCooldowns === "object"
    ? checkpoint.workerCooldowns
    : {};
  checkpoint.workerCooldowns[worker] = {
    type: "rate_limit",
    source: worker,
    message: classification.summary,
    observedAt,
    blockedUntil: classification.blockedUntil,
    retryAfterSeconds: classification.retryAfterSeconds,
    evidence: normalizeEvidence(evidence, observedAt)
  };
}

function mergeRateLimitClassificationFromCooldowns(classification, cooldowns) {
  const blockedUntilValues = Object.values(cooldowns || {})
    .map((cooldown) => Date.parse(cooldown?.blockedUntil || ""))
    .filter(Number.isFinite);
  if (!blockedUntilValues.length) return classification;
  const earliestReset = new Date(Math.min(...blockedUntilValues)).toISOString();
  return {
    ...classification,
    blockedUntil: earliestReset,
    statusSuggestion: "blocked",
    summary: "All attempted workers are rate-limited; wait for the earliest worker cooldown to reopen."
  };
}

function executeFallbackWorker({
  taskDir,
  task,
  args,
  primaryWorker,
  worker,
  workerPrompt,
  beforeUpdatedAt,
  primaryClassification,
  primaryEvidence
}) {
  const plan = buildWorkerCommand(taskDir, task, worker, workerPrompt, args);
  const fallbackStartedAt = new Date().toISOString();
  appendRunEvent(taskDir, {
    type: "rate_limited",
    status: "fallback",
    reason: primaryClassification.class,
    note: `Primary worker rate limited; falling back to ${worker}.`,
    blockedUntil: primaryClassification.blockedUntil,
    evidence: primaryEvidence,
    at: fallbackStartedAt
  });
  appendRunEvent(taskDir, {
    type: "worker_prompt_generated",
    worker,
    reason: "fallback_on_rate_limit",
    at: fallbackStartedAt
  });
  appendRunEvent(taskDir, {
    type: "worker_started",
    worker,
    reason: "fallback_on_rate_limit",
    note: plan.displayCommand,
    at: fallbackStartedAt
  });

  const result = executeWorkerCommand(plan, workerPrompt);
  const fallbackFinishedAt = new Date().toISOString();
  const outputPath = writeWorkerOutput(taskDir, {
    worker,
    command: plan.displayCommand,
    cwd: plan.cwd,
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message || null,
    startedAt: fallbackStartedAt,
    finishedAt: fallbackFinishedAt
  });
  const fallbackOutputEvidence = {
    type: "worker-output",
    path: outputPath,
    observedAt: fallbackFinishedAt
  };

  appendRunEvent(taskDir, {
    type: result.status === 0 ? "worker_completed" : "worker_failed",
    worker,
    status: result.status === 0 ? "paused" : "needs-human",
    reason: result.status === 0 ? "fallback exit 0" : `fallback exit ${result.status}`,
    note: outputPath,
    evidence: [fallbackOutputEvidence],
    at: fallbackFinishedAt
  });

  let classification = null;
  if (result.status === 0) {
    const checkpoint = readJson(join(taskDir, "checkpoint.json"));
    const evidenceItems = [
      ...primaryEvidence,
      fallbackOutputEvidence
    ];
    applyWorkerCooldown(checkpoint, primaryWorker, primaryClassification, primaryEvidence, fallbackFinishedAt);
    const beforeEvidenceLength = Array.isArray(checkpoint.evidence) ? checkpoint.evidence.length : 0;
    checkpoint.evidence = appendEvidenceItems(checkpoint.evidence, evidenceItems);
    if (checkpoint.updatedAt === beforeUpdatedAt) {
      checkpoint.status = "paused";
      checkpoint.lastCompletedStep = `Fallback worker ${worker} completed one bounded slice after Codex CLI rate limit.`;
      checkpoint.nextStep = "Review fallback worker output and choose the next bounded step.";
      checkpoint.updatedAt = fallbackFinishedAt;
      checkpoint.blocker = null;
      checkpoint.blockedUntil = null;
      writeJson(join(taskDir, "checkpoint.json"), checkpoint);
      appendRunEvent(taskDir, {
        type: "checkpoint_written",
        status: checkpoint.status,
        reason: "fallback worker completed without checkpoint update",
        at: fallbackFinishedAt
      });
    } else if (checkpoint.evidence.length > beforeEvidenceLength) {
      checkpoint.updatedAt = fallbackFinishedAt;
      writeJson(join(taskDir, "checkpoint.json"), checkpoint);
      appendRunEvent(taskDir, {
        type: "checkpoint_written",
        status: checkpoint.status,
        reason: "fallback evidence recorded",
        at: fallbackFinishedAt
      });
    }
  } else {
    const combinedOutput = [result.stdout, result.stderr, result.error?.message || ""].filter(Boolean).join("\n");
    classification = classifyFailure(combinedOutput, {
      source: worker,
      exitCode: result.status,
      task
    });
    const checkpoint = readJson(join(taskDir, "checkpoint.json"));
    applyWorkerCooldown(checkpoint, primaryWorker, primaryClassification, primaryEvidence, fallbackFinishedAt);
    applyWorkerCooldown(checkpoint, worker, classification, [fallbackOutputEvidence], fallbackFinishedAt);
    if (classification.class === "rate_limit") {
      classification = mergeRateLimitClassificationFromCooldowns(classification, checkpoint.workerCooldowns);
    }
    applyClassification(taskDir, checkpoint, classification, combinedOutput, {
      evidence: [...primaryEvidence, fallbackOutputEvidence]
    });
    process.exitCode = result.status;
  }

  return {
    worker,
    command: plan.displayCommand,
    cwd: plan.cwd,
    exitCode: result.status,
    outputPath,
    classification
  };
}

function printFallbackRunResult({ taskDir, decision, dryRun, worker, commandPlan, result, outputPath, classification, fallback }) {
  printRunResult({
    decision: decision.decision,
    reason: decision.reason,
    dryRun,
    status: readJson(join(taskDir, "checkpoint.json")).status,
    waitSeconds: decision.waitSeconds,
    worker,
    command: commandPlan.displayCommand,
    cwd: commandPlan.cwd,
    exitCode: result.status,
    finalExitCode: fallback.exitCode,
    outputPath,
    classification,
    fallback
  });
}

function configuredWorkers(task) {
  return uniqueStrings([
    normalizeWorker(task.workerPolicy?.preferred || ""),
    ...(task.workerPolicy?.allowed || []).map(normalizeWorker),
    normalizeWorker(task.workerPolicy?.fallbackOnRateLimit || "")
  ].filter((worker) => isRunnableWorker(worker)));
}

function schedulerConfigCheck(task, scheduler) {
  if (scheduler === "openclaw-cron") {
    return {
      name: "scheduler-config",
      status: "pass",
      message: `scheduler configured: ${scheduler}`,
      scheduler,
      every: task.scheduler?.every || "30m"
    };
  }
  if (scheduler === "manual") {
    return {
      name: "scheduler-config",
      status: "pass",
      message: "scheduler configured: manual",
      scheduler
    };
  }
  return {
    name: "scheduler-config",
    status: "warn",
    message: `unknown scheduler adapter: ${scheduler}`,
    scheduler
  };
}

function workerPlanCheck(taskDir, task, worker) {
  const missing = missingWorkerPlanConfig(task, worker);
  if (missing) {
    return {
      name: `worker-plan:${worker}`,
      status: "warn",
      message: missing,
      worker
    };
  }
  try {
    const plan = buildWorkerCommand(taskDir, task, worker, "", {});
    return {
      name: `worker-plan:${worker}`,
      status: "pass",
      message: `worker command can be built: ${plan.displayCommand}`,
      worker,
      cwd: plan.cwd
    };
  } catch (error) {
    return {
      name: `worker-plan:${worker}`,
      status: "warn",
      message: error.message,
      worker
    };
  }
}

function missingWorkerPlanConfig(task, worker) {
  if (worker === "local-command" && !task.localWorker?.command) {
    return "local-command requires localWorker.command.";
  }
  if ((worker === "codex-cli" || worker === "kimi-cli") && !workerCwdValue(task, worker)) {
    return `${worker} requires context.repoPath, context.repository, or ${workerConfigKey(worker)}.cwd.`;
  }
  return null;
}

function workerCwdValue(task, worker) {
  if (worker === "codex-cli") return task.codexWorker?.cwd || task.context?.repoPath || task.context?.repository;
  if (worker === "kimi-cli") return task.kimiWorker?.cwd || task.context?.repoPath || task.context?.repository;
  if (worker === "local-command") return task.localWorker?.cwd || task.context?.repoPath || task.context?.repository;
  return null;
}

function workerConfigKey(worker) {
  if (worker === "codex-cli") return "codexWorker";
  if (worker === "kimi-cli") return "kimiWorker";
  if (worker === "local-command") return "localWorker";
  return "worker";
}

function normalizeWorker(worker) {
  const value = String(worker || "").trim();
  if (value === "openclaw-codex-cli") return "codex-cli";
  if (value === "codex") return "codex-cli";
  if (value === "kimi") return "kimi-cli";
  if (value === "local") return "local-command";
  return value;
}

function normalizeScheduler(scheduler) {
  const value = String(scheduler || "").trim();
  if (value === "openclaw" || value === "openclaw-cron") return "openclaw-cron";
  if (value === "none" || value === "manual") return "manual";
  return value;
}

function buildWorkerCommand(taskDir, task, worker, workerPrompt, args) {
  if (worker === "local-command") return buildLocalCommand(taskDir, task, args);
  if (worker === "codex-cli") return buildCodexCommand(taskDir, task, args);
  if (worker === "kimi-cli") return buildKimiCommand(taskDir, task, args);
  fail(`Unsupported worker adapter: ${worker}`);
}

function isRunnableWorker(worker) {
  return ["codex-cli", "local-command", "kimi-cli"].includes(worker);
}

function buildLocalCommand(taskDir, task, args) {
  const command = args.command || task.localWorker?.command;
  if (!command || command === true) {
    fail("local-command requires --command or task.localWorker.command.");
  }
  const cwd = resolveWorkerCwd(taskDir, task, args.cwd || task.localWorker?.cwd);
  const timeoutSeconds = Number(args["timeout-seconds"] || task.localWorker?.timeoutSeconds || 1800);
  assertPositiveSeconds(timeoutSeconds, "--timeout-seconds");
  return {
    kind: "local-command",
    command: String(command),
    args: [],
    cwd,
    shell: true,
    timeoutMs: timeoutSeconds * 1000,
    displayCommand: String(command)
  };
}

function buildCodexCommand(taskDir, task, args) {
  const cwdValue = args.cwd || task.codexWorker?.cwd || task.context?.repoPath || task.context?.repository;
  if (!cwdValue) {
    fail("codex-cli requires --cwd, task.codexWorker.cwd, or task.context.repoPath.");
  }
  const cwd = resolveWorkerCwd(taskDir, task, cwdValue);
  const timeoutSeconds = Number(args["timeout-seconds"] || task.codexWorker?.timeoutSeconds || 1800);
  assertPositiveSeconds(timeoutSeconds, "--timeout-seconds");
  const commandArgs = ["exec", "--cd", cwd, "--ask-for-approval", "never"];
  const sandbox = args.sandbox || task.codexWorker?.sandbox || "workspace-write";
  if (sandbox && sandbox !== true) commandArgs.push("--sandbox", String(sandbox));
  const model = args.model || task.codexWorker?.model;
  if (model && model !== true) commandArgs.push("--model", String(model));
  if (args.oss || task.codexWorker?.oss) commandArgs.push("--oss");
  const localProvider = args["local-provider"] || task.codexWorker?.localProvider;
  if (localProvider && localProvider !== true) commandArgs.push("--local-provider", String(localProvider));
  commandArgs.push("-");

  return {
    kind: "codex-cli",
    command: "codex",
    args: commandArgs,
    cwd,
    shell: false,
    timeoutMs: timeoutSeconds * 1000,
    displayCommand: ["codex", ...commandArgs.map(shellQuote)].join(" ")
  };
}

function buildKimiCommand(taskDir, task, args) {
  const cwdValue = args.cwd || task.kimiWorker?.cwd || task.context?.repoPath || task.context?.repository;
  if (!cwdValue) {
    fail("kimi-cli requires --cwd, task.kimiWorker.cwd, or task.context.repoPath.");
  }
  const cwd = resolveWorkerCwd(taskDir, task, cwdValue);
  const timeoutSeconds = Number(args["timeout-seconds"] || task.kimiWorker?.timeoutSeconds || 1800);
  assertPositiveSeconds(timeoutSeconds, "--timeout-seconds");
  const commandArgs = [
    "--work-dir", cwd,
    "--print",
    "--input-format", "text",
    "--output-format", "text",
    "--final-message-only",
    "--yolo"
  ];
  const model = args["kimi-model"] || task.kimiWorker?.model;
  if (model && model !== true) commandArgs.push("--model", String(model));

  return {
    kind: "kimi-cli",
    command: "kimi",
    args: commandArgs,
    cwd,
    shell: false,
    timeoutMs: timeoutSeconds * 1000,
    displayCommand: ["kimi", ...commandArgs.map(shellQuote)].join(" ")
  };
}

function resolveWorkerCwd(taskDir, task, cwdValue) {
  const value = cwdValue || task.context?.repoPath || task.context?.repository || taskDir;
  return resolve(taskDir, String(value));
}

function executeWorkerCommand(plan, workerPrompt) {
  const result = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd,
    input: workerPrompt,
    encoding: "utf8",
    shell: plan.shell,
    timeout: plan.timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null
  };
}

function writeWorkerOutput(taskDir, record) {
  const stamp = record.finishedAt.replace(/[:.]/g, "-");
  const relativePath = join("evidence", `worker-output-${stamp}.txt`);
  const fullPath = join(taskDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  const text = [
    `worker: ${record.worker}`,
    `command: ${record.command}`,
    `cwd: ${record.cwd}`,
    `exitCode: ${record.exitCode}`,
    `startedAt: ${record.startedAt}`,
    `finishedAt: ${record.finishedAt}`,
    record.error ? `error: ${record.error}` : "",
    "",
    "## stdout",
    record.stdout || "",
    "",
    "## stderr",
    record.stderr || ""
  ].filter((line) => line !== "").join("\n");
  writeFileSync(fullPath, text, "utf8");
  return relativePath;
}

function appendEvents(taskDir, events) {
  for (const event of events) appendRunEvent(taskDir, event);
}

function printRunResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function acquireRunLock(taskDir, task, args) {
  const lockDir = join(taskDir, ".lth.lock");
  const now = Date.now();
  const ttlSeconds = Number(args["lock-ttl-seconds"] || task.workerPolicy?.lockTtlSeconds || args["timeout-seconds"] || 1860);
  assertPositiveSeconds(ttlSeconds, "--lock-ttl-seconds");
  const expiresAt = new Date(now + ttlSeconds * 1000).toISOString();
  const owner = String(args["lock-owner"] || `${process.pid}@${process.platform}`);
  const info = {
    owner,
    pid: process.pid,
    acquiredAt: new Date(now).toISOString(),
    expiresAt
  };

  try {
    mkdirSync(lockDir);
    writeJson(join(lockDir, "lock.json"), info);
    return { acquired: true, path: lockDir, info };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = readLockInfo(lockDir);
  const existingExpiry = Date.parse(existing?.expiresAt || "");
  if (Number.isFinite(existingExpiry) && existingExpiry <= now) {
    rmSync(lockDir, { recursive: true, force: true });
    try {
      mkdirSync(lockDir);
      writeJson(join(lockDir, "lock.json"), info);
      return { acquired: true, path: lockDir, info, stoleExpired: existing };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  const waitSeconds = Number.isFinite(existingExpiry)
    ? Math.max(1, Math.ceil((existingExpiry - now) / 1000))
    : ttlSeconds;
  return {
    acquired: false,
    path: lockDir,
    waitSeconds,
    info: existing || { path: lockDir, message: "lock exists but lock.json could not be read" }
  };
}

function releaseRunLock(lock) {
  if (lock?.acquired && lock.path) rmSync(lock.path, { recursive: true, force: true });
}

function readLockInfo(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, "lock.json"), "utf8"));
  } catch {
    return null;
  }
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

function codexSessionEvidenceForFailure({ worker, task, args, text, classification, startedAt, finishedAt }) {
  if (worker !== "codex-cli" || classification?.class !== "rate_limit") return null;
  const sessionPath = resolveCodexSessionPath({
    explicitPath: args["codex-session-path"] || task.codexWorker?.sessionPath,
    text,
    startedAt,
    finishedAt
  });
  if (!sessionPath) return null;
  return {
    type: "codex-session",
    path: sessionPath,
    source: "codex-cli",
    observedAt: finishedAt,
    note: "Raw Codex CLI session trace for interrupted rate-limited run."
  };
}

function resolveCodexSessionPath({ explicitPath, text, startedAt, finishedAt }) {
  if (explicitPath && explicitPath !== true) return expandHome(String(explicitPath));
  const fromOutput = extractCodexSessionPath(text);
  if (fromOutput) return fromOutput;
  return findLatestCodexSessionPath(startedAt, finishedAt);
}

function extractCodexSessionPath(text) {
  const pattern = /((?:~|\/)[^\s"'<>]*\.codex\/(?:sessions|archived_sessions)\/[^\s"'<>]+\.jsonl)/g;
  const matches = String(text || "").matchAll(pattern);
  for (const match of matches) {
    const candidate = expandHome(match[1].replace(/[),.;:]+$/, ""));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findLatestCodexSessionPath(startedAt, finishedAt) {
  const roots = codexSessionRoots();
  const startedMs = Date.parse(startedAt) - 5000;
  const finishedMs = Date.parse(finishedAt) + 60_000;
  const files = roots.flatMap((root) => collectJsonlFiles(root, 6));
  return files
    .filter((file) => file.mtimeMs >= startedMs && file.mtimeMs <= finishedMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path || null;
}

function codexSessionRoots() {
  const homes = [process.env.CODEX_HOME, join(homedir(), ".codex")].filter(Boolean).map((value) => resolve(String(value)));
  return Array.from(new Set(homes.flatMap((root) => [
    join(root, "sessions"),
    join(root, "archived_sessions")
  ])));
}

function collectJsonlFiles(root, depth) {
  if (depth < 0 || !existsSync(root)) return [];
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return collectJsonlFiles(path, depth - 1);
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return [];
    try {
      const stat = statSync(path);
      return [{ path, mtimeMs: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
}

function normalizeEvidence(value, observedAt) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .filter(Boolean)
    .map((item) => ({ observedAt, ...item }));
}

function appendEvidenceItems(existing, items) {
  const evidence = Array.isArray(existing) ? existing : [];
  const seen = new Set(evidence.map((item) => `${item.type || ""}:${item.path || ""}`));
  for (const item of items) {
    const key = `${item.type || ""}:${item.path || ""}`;
    if (!seen.has(key)) {
      evidence.push(item);
      seen.add(key);
    }
  }
  return evidence;
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function matchesAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean).map(String)));
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

function assertPositiveSeconds(value, flag) {
  if (!Number.isFinite(value) || value <= 0) fail(`Invalid ${flag}: ${value}`);
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
