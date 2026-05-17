import { isRunnableWorker, normalizeWorker } from "../workers/registry.js";

export function buildOpenClawRecipe(taskDir, task, args, cliPath = "src/cli.js") {
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
    ? `node ${shellQuote(cliPath)} run ${shellQuote(taskDir)} --worker ${shellQuote(worker)}${fallbackFlag} --timeout-seconds ${shellQuote(timeoutSeconds)}`
    : `node ${shellQuote(cliPath)} tick ${shellQuote(taskDir)}`;
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

  return {
    taskId: task.id,
    command: lines.join("\n"),
    message,
    schedule: { every, name, sessionKey, model, timeoutSeconds, tools, worker, schedulerCommand }
  };
}

function shellQuote(value) {
  const text = String(value);
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}
