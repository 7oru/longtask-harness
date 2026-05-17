export function buildWorkerPrompt(taskDir, task, checkpoint) {
  const hardConstraints = normalizeConstraints(task.constraints).filter((constraint) => constraint.type !== "soft");
  const contextLines = formatContext(task.context);
  const cooldownLines = formatWorkerCooldowns(checkpoint.workerCooldowns);
  return [
    "Read task.json, checkpoint.json, and harness.md before doing work.",
    "Continue exactly one bounded slice.",
    "Respect constraints, success criteria, blockedUntil, and the worker policy.",
    "Before stopping, update checkpoint.json and append run evidence.",
    "",
    `Task directory: ${taskDir}`,
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    `Current phase: ${checkpoint.currentPhase || "unspecified"}`,
    `Next step: ${checkpoint.nextStep}`,
    "",
    "Success criteria:",
    ...normalizeSuccessCriteria(task.successCriteria).map((criterion) => `- ${formatSuccessCriterion(criterion)}`),
    ...formatPromptSection("Hard constraints:", hardConstraints.map((constraint) => `- ${formatConstraint(constraint)}`)),
    ...formatPromptSection("Key context:", contextLines),
    checkpoint.blockedUntil ? `Blocked until: ${checkpoint.blockedUntil}` : "",
    checkpoint.blocker ? `Recent blocker: ${formatBlocker(checkpoint.blocker)}` : "",
    ...formatPromptSection("Worker cooldowns:", cooldownLines),
    ...formatPromptSection("Recent evidence:", recentEvidence(checkpoint.evidence).map((item) => `- ${formatEvidence(item)}`)),
    "",
    "Evidence expectations:",
    "- Capture tests, worker output, screenshots, transcripts, or review notes that support the slice.",
    "- Link evidence to success criteria with criterionId or criteria when it verifies completion.",
    checkpoint.lastCompletedStep ? `Last completed step: ${checkpoint.lastCompletedStep}` : "",
    checkpoint.activeFiles?.length ? `Active files: ${checkpoint.activeFiles.join(", ")}` : "",
    checkpoint.openQuestions?.length ? `Open questions: ${checkpoint.openQuestions.join("; ")}` : ""
  ].filter(Boolean).join("\n");
}

export function normalizeSuccessCriteria(criteria) {
  return (Array.isArray(criteria) ? criteria : []).map((criterion, index) => {
    if (typeof criterion === "string") {
      return {
        id: slugify(criterion) || `criterion-${index + 1}`,
        description: criterion,
        metric: "manual",
        target: null
      };
    }
    const description = String(criterion?.description || criterion?.id || `criterion ${index + 1}`);
    return {
      id: String(criterion?.id || slugify(description) || `criterion-${index + 1}`),
      description,
      metric: String(criterion?.metric || "manual"),
      target: criterion?.target ?? null
    };
  });
}

function formatPromptSection(title, lines) {
  return lines.length ? [title, ...lines] : [];
}

function normalizeConstraints(constraints) {
  return (Array.isArray(constraints) ? constraints : []).map((constraint, index) => {
    if (typeof constraint === "string") {
      return {
        id: slugify(constraint) || `constraint-${index + 1}`,
        description: constraint,
        type: "hard",
        category: "scope"
      };
    }
    return {
      id: String(constraint?.id || `constraint-${index + 1}`),
      description: String(constraint?.description || constraint?.id || `constraint ${index + 1}`),
      type: String(constraint?.type || "hard"),
      category: String(constraint?.category || "other")
    };
  });
}

function formatSuccessCriterion(criterion) {
  const target = criterion.target == null ? "" : ` target=${formatInlineValue(criterion.target)}`;
  return `${criterion.id}: ${criterion.description} (${criterion.metric}${target})`;
}

function formatConstraint(constraint) {
  return `${constraint.id}: ${constraint.description} (${constraint.type}/${constraint.category})`;
}

function formatContext(context = {}) {
  return [
    context.summary ? `- Summary: ${context.summary}` : "",
    context.repoPath ? `- Repo path: ${context.repoPath}` : "",
    context.repository ? `- Repository: ${context.repository}` : "",
    ...(Array.isArray(context.files) && context.files.length ? [`- Files: ${context.files.join(", ")}`] : []),
    ...(Array.isArray(context.links) && context.links.length ? [`- Links: ${context.links.join(", ")}`] : []),
    ...(Array.isArray(context.notes) ? context.notes.map((note) => `- Note: ${note}`) : [])
  ].filter(Boolean);
}

function formatBlocker(blocker) {
  return [
    blocker.type || "unknown",
    blocker.source ? `from ${blocker.source}` : "",
    blocker.message ? `- ${blocker.message}` : "",
    blocker.retryAfterSeconds != null ? `(retryAfterSeconds: ${blocker.retryAfterSeconds})` : ""
  ].filter(Boolean).join(" ");
}

function formatWorkerCooldowns(cooldowns = {}) {
  return Object.entries(cooldowns || {}).map(([worker, cooldown]) => {
    const until = cooldown?.blockedUntil || "unknown";
    const message = cooldown?.message ? ` - ${cooldown.message}` : "";
    return `- ${worker}: blocked until ${until}${message}`;
  });
}

function recentEvidence(evidence = []) {
  return Array.isArray(evidence) ? evidence.slice(-5) : [];
}

function formatEvidence(item) {
  return [
    item.type || "evidence",
    item.path || item.manifestPath || "",
    item.criterionId ? `(criterion: ${item.criterionId})` : "",
    item.summary || item.note || ""
  ].filter(Boolean).join(" ");
}

function formatInlineValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
