import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_CODEX_SANDBOX = "read-only";
const DEFAULT_CODEX_FORBIDDEN_CWD_PATTERNS = [
  "~",
  "~/.ssh",
  "~/.ssh/**",
  "~/.openclaw",
  "~/.openclaw/**",
  "~/.claude",
  "~/.claude/**",
  "~/.codex",
  "~/.codex/**"
];

export function buildWorkerCommand(taskDir, task, worker, args) {
  if (worker === "local-command") return buildLocalCommand(taskDir, task, args);
  if (worker === "codex-cli") return buildCodexCommand(taskDir, task, args);
  if (worker === "kimi-cli") return buildKimiCommand(taskDir, task, args);
  throw new Error(`Unsupported worker adapter: ${worker}`);
}

function buildLocalCommand(taskDir, task, args) {
  const command = args.command || task.localWorker?.command;
  if (!command || command === true) {
    throw new Error("local-command requires --command or task.localWorker.command.");
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
    throw new Error("codex-cli requires --cwd, task.codexWorker.cwd, or task.context.repoPath.");
  }
  const cwd = resolveWorkerCwd(taskDir, task, cwdValue);
  assertCodexCwdAllowed(cwd, task, args);
  const timeoutSeconds = Number(args["timeout-seconds"] || task.codexWorker?.timeoutSeconds || 1800);
  assertPositiveSeconds(timeoutSeconds, "--timeout-seconds");
  const commandArgs = ["exec", "--cd", cwd, "--ask-for-approval", "never"];
  const sandbox = args.sandbox || task.codexWorker?.sandbox || DEFAULT_CODEX_SANDBOX;
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
    throw new Error("kimi-cli requires --cwd, task.kimiWorker.cwd, or task.context.repoPath.");
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

function assertCodexCwdAllowed(cwd, task, args) {
  const match = codexForbiddenCwdPatterns(task, args).find((pattern) => pathMatchesForbiddenPattern(cwd, pattern));
  if (match) {
    throw new Error(`Refusing to start codex-cli in forbidden cwd ${cwd} (matched ${match}).`);
  }
}

function codexForbiddenCwdPatterns(task, args) {
  const argPatterns = args["forbidden-cwd-patterns"] && args["forbidden-cwd-patterns"] !== true
    ? splitCsv(args["forbidden-cwd-patterns"])
    : [];
  const taskPatterns = [
    ...(Array.isArray(task.codexWorker?.forbiddenCwdPatterns) ? task.codexWorker.forbiddenCwdPatterns : []),
    ...(Array.isArray(task.workerPolicy?.forbiddenCwdPatterns) ? task.workerPolicy.forbiddenCwdPatterns : []),
    ...(Array.isArray(task.constraints) ? task.constraints.flatMap((constraint) => Array.isArray(constraint?.forbiddenCwdPatterns) ? constraint.forbiddenCwdPatterns : []) : [])
  ];
  return uniqueStrings([
    ...DEFAULT_CODEX_FORBIDDEN_CWD_PATTERNS,
    ...taskPatterns,
    ...argPatterns
  ]);
}

function pathMatchesForbiddenPattern(path, pattern) {
  const normalizedPath = normalizeAbsolutePath(path);
  const normalizedPattern = normalizeAbsolutePath(expandHome(String(pattern)));
  if (String(pattern).endsWith("/**")) {
    const base = normalizeAbsolutePath(expandHome(String(pattern).slice(0, -3)));
    return normalizedPath === base || normalizedPath.startsWith(`${base}/`);
  }
  if (String(pattern).includes("*")) {
    return globPatternToRegExp(normalizedPattern).test(normalizedPath);
  }
  return normalizedPath === normalizedPattern;
}

function globPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`);
}

export function resolveWorkerCwd(taskDir, task, cwdValue) {
  const value = cwdValue || task.context?.repoPath || task.context?.repository || taskDir;
  return resolve(taskDir, expandHome(String(value)));
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  return path;
}

function normalizeAbsolutePath(path) {
  const resolved = resolve(String(path));
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") : resolved;
}

function assertPositiveSeconds(value, flag) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${flag}: ${value}`);
}

function splitCsv(value) {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean).map(String)));
}

function shellQuote(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}
