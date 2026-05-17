export function decideNext(checkpoint, now = new Date()) {
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
