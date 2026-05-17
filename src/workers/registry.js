export function configuredWorkers(task) {
  return uniqueStrings([
    normalizeWorker(task.workerPolicy?.preferred || ""),
    ...(task.workerPolicy?.allowed || []).map(normalizeWorker),
    normalizeWorker(task.workerPolicy?.fallbackOnRateLimit || "")
  ].filter((worker) => isRunnableWorker(worker)));
}

export function missingWorkerPlanConfig(task, worker) {
  if (worker === "local-command" && !task.localWorker?.command) {
    return "local-command requires localWorker.command.";
  }
  if ((worker === "codex-cli" || worker === "kimi-cli") && !workerCwdValue(task, worker)) {
    return `${worker} requires context.repoPath, context.repository, or ${workerConfigKey(worker)}.cwd.`;
  }
  return null;
}

export function workerCwdValue(task, worker) {
  if (worker === "codex-cli") return task.codexWorker?.cwd || task.context?.repoPath || task.context?.repository;
  if (worker === "kimi-cli") return task.kimiWorker?.cwd || task.context?.repoPath || task.context?.repository;
  if (worker === "local-command") return task.localWorker?.cwd || task.context?.repoPath || task.context?.repository;
  return null;
}

export function workerConfigKey(worker) {
  if (worker === "codex-cli") return "codexWorker";
  if (worker === "kimi-cli") return "kimiWorker";
  if (worker === "local-command") return "localWorker";
  return "worker";
}

export function normalizeWorker(worker) {
  const value = String(worker || "").trim();
  if (value === "openclaw-codex-cli") return "codex-cli";
  if (value === "codex") return "codex-cli";
  if (value === "kimi") return "kimi-cli";
  if (value === "local") return "local-command";
  return value;
}

export function normalizeScheduler(scheduler) {
  const value = String(scheduler || "").trim();
  if (value === "openclaw" || value === "openclaw-cron") return "openclaw-cron";
  if (value === "none" || value === "manual") return "manual";
  return value;
}

export function isRunnableWorker(worker) {
  return ["codex-cli", "local-command", "kimi-cli"].includes(worker);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean).map(String)));
}
