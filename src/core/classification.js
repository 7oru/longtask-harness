const RATE_LIMIT_PATTERNS = [
  /\brate[\s_-]?limit(?:ed|ing)?\b/i,
  /\btoo many requests\b/i,
  /\bquota(?:\s|_)?exceeded\b/i,
  /\bhttp\s*429\b/i,
  /\b429\b.*\b(?:too many requests|rate|quota|retry)\b/i,
  /\b(?:too many requests|rate|quota|retry)\b.*\b429\b/i,
  /\btry again later\b/i,
  /\bretry(?:\s|-)?after\b/i
];

const AUTH_PATTERNS = [
  /\bunauthorized\b/i,
  /\bauthentication\b/i,
  /\bauth(?:orization)? error\b/i,
  /\binvalid api key\b/i,
  /\bapi key\b/i,
  /\bpermission denied\b/i,
  /\bforbidden\b/i,
  /\b(?:401|403)\b/
];

const TEST_PATTERNS = [
  /\btests? failed\b/i,
  /\bfailing tests?\b/i,
  /\bfailed tests?\b/i,
  /\bassertionerror\b/i,
  /\berr_assertion\b/i,
  /\bnpm err!\b/i,
  /\bjest\b[\s\S]*\bexpected\b[\s\S]*\breceived\b/i,
  /\bassert\b[\s\S]*\bexpected\b[\s\S]*\b(?:actual|received)\b/i,
  /\bexpected\b[\s\S]{0,200}\breceived\b[\s\S]{0,200}\b(?:test|spec|assert|fail)\b/i
];

const MISSING_CONTEXT_PATTERNS = [
  /\bmissing context\b/i,
  /\bnot enough context\b/i,
  /\bneed more context\b/i,
  /\bcannot find\b/i,
  /\bcould not find\b/i,
  /\bfile not found\b/i,
  /\benoent\b/i,
  /\bno such file\b/i
];

const SOURCE_PATTERNS = [
  ["codex-cli", /\bcodex(?:\s+cli)?\b/i],
  ["kimi-cli", /\bkimi(?:\s+cli)?\b/i],
  ["openclaw-provider", /\b(?:openclaw|minimax)\b/i],
  ["scheduler", /\b(?:cron|scheduler)\b/i],
  ["external-api", /\b(?:external api|api request|http request|rest api|graphql)\b/i]
];

export function classifyFailure(text, opts = {}) {
  const normalized = String(text || "");
  const exitCode = opts.exitCode == null || opts.exitCode === true ? null : Number(opts.exitCode);
  const source = inferFailureSource(normalized, opts.source);
  const retryAfterSeconds = parseRetryAfterSeconds(normalized, opts.now);
  const fallbackWaitSeconds = opts.task?.rateLimitPolicy?.fallbackWaitSeconds ?? 14400;

  if (matchesAny(normalized, RATE_LIMIT_PATTERNS)) {
    const waitSeconds = retryAfterSeconds ?? fallbackWaitSeconds;
    return {
      class: "rate_limit",
      source,
      statusSuggestion: "blocked",
      blockedUntil: new Date(nowMs(opts.now) + waitSeconds * 1000).toISOString(),
      retryAfterSeconds,
      fallbackWaitSeconds,
      confidence: retryAfterSeconds == null ? 0.78 : 0.9,
      summary: "Rate limit or quota window detected."
    };
  }

  if (matchesAny(normalized, AUTH_PATTERNS)) {
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

  if (matchesAny(normalized, TEST_PATTERNS)) {
    return {
      class: "test_failure",
      source,
      statusSuggestion: "paused",
      blockedUntil: null,
      retryAfterSeconds: null,
      confidence: 0.74,
      summary: "Test or assertion failure detected."
    };
  }

  if (matchesAny(normalized, MISSING_CONTEXT_PATTERNS)) {
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

export function inferFailureSource(text, explicitSource) {
  if (explicitSource && explicitSource !== true) return String(explicitSource);
  const normalized = String(text || "");
  return SOURCE_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] || "manual";
}

export function parseRetryAfterSeconds(text, now = new Date()) {
  const normalized = String(text || "");
  const numericRetryAfter = normalized.match(/retry(?:\s|-)?after(?:\s|:)+(\d+)/i);
  if (numericRetryAfter) return Number(numericRetryAfter[1]);

  const resetIn = normalized.match(/(?:reset|resets|try again)(?:\s+\w+){0,3}\s+in\s+(\d+)\s*(second|seconds|minute|minutes|hour|hours)/i);
  if (resetIn) {
    const value = Number(resetIn[1]);
    const unit = resetIn[2].toLowerCase();
    if (unit.startsWith("hour")) return value * 3600;
    if (unit.startsWith("minute")) return value * 60;
    return value;
  }

  const httpDate = normalized.match(/retry(?:\s|-)?after(?:\s|:)+([A-Z][a-z]{2},\s+\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i);
  if (!httpDate) return null;
  const resetAt = Date.parse(httpDate[1]);
  if (!Number.isFinite(resetAt)) return null;
  return Math.max(0, Math.ceil((resetAt - nowMs(now)) / 1000));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
