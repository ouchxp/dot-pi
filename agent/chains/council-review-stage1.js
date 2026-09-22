// Council review, stage 1 of 3: independent structured-findings reviewers.
// N reviewers per angle (edge, callers, simplify): MODELS maps each category to
// its list of models, one reviewer per entry, each on a different model.
// Invoke as workflowScript (not workflowScriptPath) so resume-retry-guard injects retryAll:
//   subagent({ workflowScript: <this file>, async: true, globalConcurrencyLimit: <total reviewers> })
// Edit `task`, `TICKET`, `ledgerSummary`, `PRIOR`, `ROUND`, and `MODELS` before launch.
// `MODELS` sets the per-category model lists; lists may differ in length per
// category. Per-agent fallbackModels live in the
// agent frontmatter (~/.pi/agent/agents/council-*.md), not here.
// After this returns, the parent embeds result.stage2Payload into
// council-review-stage2.js (`const stage2Payload = ...`) and launches it.
// Chairman is a separate single-child launch afterwards (no workflow needed).

const task = "the current change";
const TICKET = "";
const ledgerSummary = "";
const PRIOR = "";
const ROUND = 1;
const MODELS = {
  edge: [
    "commandcode/meta/muse-spark-1.3-contributor",
    "commandcode/deepseek/deepseek-v4.1-flash",
  ],
  callers: [
    "commandcode/meta/muse-spark-1.3-contributor",
    "commandcode/deepseek/deepseek-v4.1-flash",
  ],
  simplify: [
    "commandcode/meta/muse-spark-1.3-contributor",
    "commandcode/deepseek/deepseek-v4.1-flash",
  ],
};

const angles = {
  edge: "correctness angle A (edge cases): boundary values, null/empty/error paths, off-by-one, missing branches in the touched code",
  callers:
    "correctness angle B (callers and regressions): trace callers/callees of the changed symbols, broken contracts, behavior changes visible outside the diff",
  simplify:
    "correctness angle C (simplification risk): does the change do more than the ticket needs, can a smaller diff hold the same behavior, flag dead code and speculative structure",
};

// One reviewer per MODELS entry: each category runs len(MODELS[category])
// independent reviewers, each on a different model. Lists may differ in length
// per category. Stage 2 dedupe merges identical claims into one finding with
// multiple sources, so cross-reviewer consensus raises verification priority
// without double-counting.
function asList(v, category) {
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0 || !list.every((m) => typeof m === "string" && m)) {
    throw new Error(
      "MODELS." + category + " must be a non-empty list of model strings.",
    );
  }
  return list;
}
const reviewers = [];
for (const category of ["edge", "callers", "simplify"]) {
  const models = asList(MODELS[category], category);
  for (let copy = 1; copy <= models.length; copy++) {
    reviewers.push({
      key: category + "-" + copy,
      category: category,
      copy: copy,
      total: models.length,
      model: models[copy - 1],
      angle: angles[category],
    });
  }
}

const SHARED_RULES =
  "\nShared rules for every reviewer: ticket scope is a hard boundary — out-of-scope code only when it breaks correctness of the in-scope change. " +
  "Judge cleanliness by ponytail rules — shortest diff that works; one finding per cut with location, what to cut, what replaces it. " +
  "Never run test suites, typecheck, lint, or build commands; review statically only. Never report test coverage, test/lint runs, or coverage gaps as findings. " +
  "Identifier rule: start every finding claim with both tags, `[Pn] [<tag>]`, matching the severity/classification fields (e.g. `[P1] [regression] ...`). A claim without both tags is malformed.";

const jobs = [];
for (const r of reviewers) {
  jobs.push({
    key: "r" + ROUND + "-" + r.key,
    agent: "council-reviewer",
    label:
      r.category +
      " review " +
      r.copy +
      "/" +
      r.total +
      " (round " +
      ROUND +
      ")",
    model: r.model,
    task:
      "Review " +
      task +
      " for correctness. Your angle (emphasis, not blinders — still flag any P1 outside it): " +
      r.angle +
      ". You are independent copy " +
      r.copy +
      " of " +
      r.total +
      " on this angle; judge from the code alone, do not coordinate." +
      " Aspect: correctness. Round: " +
      ROUND +
      ".\nTicket scope (out-of-scope code only when it breaks correctness):\n" +
      (TICKET || "(none — review the diff as scoped)") +
      "." +
      SHARED_RULES +
      "\nPrior-ledger summary (verify fixed/rejected items against code; overturn only with file-plus-line proof tagged [regression]):\n" +
      (ledgerSummary || "(none — first round)") +
      "\nReturn ONLY the JSON findings array.",
    timeoutMs: 3600000,
    toolTimeoutMs: 300000,
  });
}

const reviews = await retryAll(jobs);

function stripFences(text) {
  return String(text || "")
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
}

function tryParseArray(s) {
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return null;
  }
  return null;
}

// Returns { items, parsed, rawEmpty }:
// - parsed=true means the output yielded a JSON array (possibly empty = clean review).
// - parsed=false means extraction failed; rawEmpty says whether the child returned nothing at all.
// Never silently maps garbage to [].
function parseFindings(text) {
  const raw = String(text || "");
  if (!raw.trim()) return { items: [], parsed: false, rawEmpty: true };
  const direct = tryParseArray(raw.trim());
  if (direct) return { items: direct, parsed: true, rawEmpty: false };
  const fences = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(raw)) !== null) fences.push(m[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    const hit = tryParseArray(fences[i].trim());
    if (hit) return { items: hit, parsed: true, rawEmpty: false };
  }
  const clean = stripFences(raw).trim();
  const end = clean.lastIndexOf("]");
  if (end > 0) {
    let start = clean.indexOf("[");
    while (start >= 0 && start < end) {
      const hit = tryParseArray(clean.slice(start, end + 1));
      if (hit) return { items: hit, parsed: true, rawEmpty: false };
      start = clean.indexOf("[", start + 1);
    }
  }
  return { items: [], parsed: false, rawEmpty: false };
}

// Canonical severity: P1 (blocker), P2 (medium), P3 (low). Old P0 merges into P1;
// Nit/Suggestion drops into P3. Unknown values default to P2, never passthrough.
// The claim prefix is authoritative presentation: sync the claim's [Pn]/[<tag>]
// tags to the normalized fields so every downstream representation carries them.
function normalizeSeverity(s) {
  const v = String(s || "").toLowerCase();
  if (/\bp0\b|critical|high|blocker/.test(v)) return "P1";
  if (/\bp2\b|medium/.test(v)) return "P2";
  if (/\bp3\b|\blow\b|nit|suggestion|style|naming/.test(v)) return "P3";
  if (/\bp1\b/.test(v)) return "P1";
  return "P2";
}

function normalizeClassification(s) {
  const v = String(s || "").toLowerCase();
  if (v.indexOf("regression") >= 0) return "[regression]";
  if (v.indexOf("pre-existing") >= 0 || v.indexOf("preexisting") >= 0)
    return "[pre-existing]";
  return "[in-scope]";
}

// Rewrite the claim so it starts with `[Pn] [<tag>]` matching severity and
// classification. Existing prefixes are replaced, not stacked.
function syncClaimTags(claim, severity, classification) {
  const sevTag = "[" + severity + "]";
  let rest = String(claim || "").trim();
  rest = rest
    .replace(/^\s*\[p[0123]\]\s*/i, "")
    .replace(/^\s*\[(in-scope|regression|pre-existing|preexisting)\]\s*/i, "")
    .replace(/^\s*\[p[0123]\]\s*/i, "");
  return sevTag + " " + classification + " " + rest;
}

function normClaim(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

let priorSet = {};
try {
  const arr = JSON.parse(PRIOR || "[]");
  if (Array.isArray(arr)) {
    for (const k of arr) priorSet[k] = true;
  }
} catch {
  priorSet = {};
}

const findings = [];
const reviewStatus = {};
const parseFailures = [];
for (let i = 0; i < jobs.length; i++) {
  const job = jobs[i];
  const res = reviews[i];
  if (!res.ok) {
    reviewStatus[job.key] =
      "[review failed: " + (res.error || "no output") + "]";
    parseFailures.push(job.key);
    continue;
  }
  const parsed = parseFindings(res.output);
  if (!parsed.parsed) {
    reviewStatus[job.key] = parsed.rawEmpty
      ? "[review ok but empty output: no findings extracted]"
      : "[review ok BUT PARSE FAILED: non-empty output yielded no JSON array — manual recovery needed]";
    parseFailures.push(job.key);
    continue;
  }
  reviewStatus[job.key] = "ok (" + parsed.items.length + " findings)";
  const items = parsed.items;
  for (let j = 0; j < items.length; j++) {
    const f = items[j] || {};
    const fp =
      (f.file || "") + "|" + (f.lines || "") + "|" + normClaim(f.claim);
    const sev = normalizeSeverity(f.severity);
    const cls = normalizeClassification(f.classification);
    findings.push({
      id: "R" + ROUND + "-" + job.key + "-" + (j + 1),
      aspect: f.aspect || "correctness",
      fp: fp,
      isNew: !priorSet[fp],
      file: f.file || "",
      lines: f.lines || "",
      claim: syncClaimTags(f.claim, sev, cls),
      evidence: f.evidence || "",
      recommendation: f.recommendation || "",
      how_to_verify: f.how_to_verify || "",
      severity: sev,
      confidence: f.confidence || "low",
      classification: cls,
      reviewerModel: jobs[i].model,
      sources: [job.key],
    });
  }
}

const priorCount = Object.keys(priorSet).length;

const reviewerModels = {
  edge: asList(MODELS.edge, "edge").slice(),
  callers: asList(MODELS.callers, "callers").slice(),
  simplify: asList(MODELS.simplify, "simplify").slice(),
};
const distinctModels = Array.from(
  new Set(
    reviewerModels.edge.concat(reviewerModels.callers, reviewerModels.simplify),
  ),
);
const reviewerModel = distinctModels.length === 1 ? distinctModels[0] : "mixed";

return {
  round: ROUND,
  reviewerModel: reviewerModel,
  reviewerModels: reviewerModels,
  priorCount: priorCount,
  reviewStatus: reviewStatus,
  parseFailures: parseFailures,
  findings: findings,
  stage2Payload: JSON.stringify({
    task: task,
    ticket: TICKET,
    round: ROUND,
    reviewerModel: reviewerModel,
    reviewerModels: reviewerModels,
    priorCount: priorCount,
    findings: findings,
  }),
};
