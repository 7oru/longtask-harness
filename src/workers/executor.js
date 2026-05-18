import { spawnSync } from "node:child_process";

export function executeWorkerCommand(plan, workerPrompt) {
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
