// Council review, stage 2 of 3: dedupe + independent verification.
// Merges repeats so each issue is checked once. Rejected and unsure verdicts
// stay in the ledger only; the chairman only sees confirmed (UPHELD) issues.
// No issue codes are shown to the reader; ids live in JSON only.
// Invoke as workflowScript (not workflowScriptPath) so resume-retry-guard injects retryAll:
//   subagent({ workflowScript: <this file>, async: true })
// Before launch, the parent replaces `stage2Payload` with stage 1's
// result.stage2Payload string (exact replacement of the placeholder line).
// `VERIFIER_MODEL` is the single customization point for the verifier model;
// the chairman model is chosen at its single-child launch; fallbacks live in the
// council-verifier / council-chairman agent frontmatter.
// Convergence counts P1/P2 signal only: P3 findings are still verified for the
// memo low notes, but never enter the convergence tuple or the converged decision.
// After this returns, the parent launches the chairman as a single child:
//   subagent({ agent: "council-chairman", task: result.chairmanTask })
// then appends finding_verified + chairman_decision events to the ledger.

const stage2Payload = "__STAGE1_OUTPUT__";
const VERIFIER_MODEL = "openai-codex/gpt-6-luna";

let payload;
try {
  payload = JSON.parse(stage2Payload);
} catch {
  throw new Error(
    "stage2Payload is not valid JSON — embed stage 1 result.stage2Payload verbatim before launch.",
  );
}
const task = payload.task;
const ticket = payload.ticket || "";
const round = payload.round;
const reviewerModel = payload.reviewerModel || "";
const priorCount = payload.priorCount || 0;
const incoming = Array.isArray(payload.findings) ? payload.findings : [];

function normClaim(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Fingerprints ignore the `[Pn] [<tag>]` claim prefix so a re-tagged repeat
// of the same claim still dedupes instead of looking new.
function fpClaim(s) {
  return normClaim(s)
    .replace(/^\[p[0123]\]\s*/, "")
    .replace(/^\[(in-scope|regression|pre-existing|preexisting)\]\s*/, "")
    .replace(/^\[p[0123]\]\s*/, "");
}

const seen = {};
const unique = [];
let duplicateCount = 0;
for (let i = 0; i < incoming.length; i++) {
  const f = incoming[i];
  const key = (f.file || "") + "|" + (f.lines || "") + "|" + fpClaim(f.claim);
  if (seen[key]) {
    seen[key].sources = seen[key].sources.concat(f.sources || []);
    seen[key].isNew = seen[key].isNew && f.isNew;
    duplicateCount++;
  } else {
    seen[key] = f;
    unique.push(f);
  }
}

const jobs = [];
for (let i = 0; i < unique.length; i++) {
  const f = unique[i];
  const slim = {
    id: f.id,
    aspect: f.aspect,
    file: f.file,
    lines: f.lines,
    claim: f.claim,
    evidence: f.evidence,
    recommendation: f.recommendation,
    how_to_verify: f.how_to_verify,
    severity: f.severity,
    confidence: f.confidence,
    classification: f.classification,
  };
  jobs.push({
    key: "verify-" + (i + 1),
    agent: "council-verifier",
    label:
      "verify finding " +
      (i + 1) +
      "/" +
      unique.length +
      ": " +
      (f.file || "") +
      " " +
      (f.lines || ""),
    model: VERIFIER_MODEL,
    task:
      "Change scope: " +
      task +
      ". Round: " +
      round +
      ".\nVerify this ONE finding independently against the actual code:\n" +
      JSON.stringify(slim) +
      "\nReturn ONLY the single JSON verdict object.",
    timeoutMs: 3600000,
    toolTimeoutMs: 300000,
  });
}

const verdicts = await retryAll(jobs);

function tryParseObject(s) {
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
  } catch {
    return null;
  }
  return null;
}

// Returns { verdict, reason, evidence, unparseable }: unparseable=true keeps the
// finding visible as INCONCLUSIVE but says why, instead of an empty reason.
function parseVerdict(text) {
  const raw = String(text || "");
  if (!raw.trim())
    return {
      verdict: "INCONCLUSIVE",
      reason: "verifier output unparseable: empty output",
      evidence: "",
      unparseable: true,
    };
  const direct = tryParseObject(raw.trim());
  if (direct && direct.verdict)
    return {
      verdict: direct.verdict,
      reason: direct.reason || "",
      evidence: direct.evidence || "",
      unparseable: false,
    };
  const fences = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(raw)) !== null) fences.push(m[1]);
  for (let i = fences.length - 1; i >= 0; i--) {
    const hit = tryParseObject(fences[i].trim());
    if (hit && hit.verdict)
      return {
        verdict: hit.verdict,
        reason: hit.reason || "",
        evidence: hit.evidence || "",
        unparseable: false,
      };
  }
  const clean = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();
  const end = clean.lastIndexOf("}");
  if (end > 0) {
    let start = clean.indexOf("{");
    while (start >= 0 && start < end) {
      const hit = tryParseObject(clean.slice(start, end + 1));
      if (hit && hit.verdict)
        return {
          verdict: hit.verdict,
          reason: hit.reason || "",
          evidence: hit.evidence || "",
          unparseable: false,
        };
      start = clean.indexOf("{", start + 1);
    }
  }
  return {
    verdict: "INCONCLUSIVE",
    reason:
      "verifier output unparseable: no JSON object extracted — manual recovery needed",
    evidence: "",
    unparseable: true,
  };
}

const results = [];
const unparseableVerdicts = [];
for (let i = 0; i < jobs.length; i++) {
  const f = unique[i];
  const res = verdicts[i];
  if (!res.ok) {
    results.push({
      finding: f,
      verifierModel: VERIFIER_MODEL,
      verdict: "INCONCLUSIVE",
      reason: "verifier failed: " + (res.error || "no output"),
      evidence: "",
    });
    continue;
  }
  const v = parseVerdict(res.output);
  const verdict =
    v.verdict === "UPHELD" ||
    v.verdict === "REFUTED" ||
    v.verdict === "INCONCLUSIVE"
      ? v.verdict
      : "INCONCLUSIVE";
  const unparseable = v.unparseable === true;
  if (unparseable) unparseableVerdicts.push(f.id);
  results.push({
    finding: f,
    verifierModel: VERIFIER_MODEL,
    verdict: verdict,
    reason: v.reason || "",
    evidence: v.evidence || "",
  });
}

function isSignal(f) {
  return String((f && f.severity) || "").toUpperCase() !== "P3";
}
const signalIncoming = incoming.filter(isSignal);
const signalUnique = unique.filter(isSignal);
const newUnique = signalUnique.filter((f) => f.isNew).length;

const upheld = results.filter((r) => r.verdict === "UPHELD");
const lines = [];
lines.push(
  "Act as the council chairman for round " + round + " of: " + task + ".",
);
lines.push(
  "Ticket scope: " +
    (ticket || "(none)") +
    ". Out-of-scope findings stand only when they break correctness of the in-scope change.",
);
lines.push(
  "Below are the confirmed issues. Each one was found by a reviewer and checked against the code. Rejected and unsure items are already removed and must not appear in your review.",
);
lines.push(
  "Never list test/lint/build runs or coverage gaps as fixes. Cleanliness follows ponytail rules: shortest diff that works.",
);
lines.push(
  "Give: FINAL VERDICT (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION),",
);
lines.push("MANDATORY FIXES (P1 only, with file, lines, smallest fix),");
lines.push(
  "RECOMMENDED IMPROVEMENTS (P2), and LOW NOTES (P3, cap 5, non-blocking).",
);
lines.push(
  "Marking rule: reproduce each issue's two tags verbatim in every section, in the form `[Pn] [<tag>] file lines — claim` (e.g. `[P2] [in-scope] gogo/models/Ride.ts 6799-6812 — ...`). Never show issue codes; this task has none. Never drop the classification tag; the parent quotes these lines directly into chat and into the memo.",
);
lines.push("Be decisive. Do not edit files.");
lines.push("");
if (upheld.length === 0) {
  lines.push("No confirmed issues this round.");
  lines.push("");
}
for (let i = 0; i < upheld.length; i++) {
  const r = upheld[i];
  lines.push(
    (r.finding.isNew ? "[NEW] " : "[SEEN] ") +
      "[" +
      r.finding.severity +
      " " +
      r.finding.classification +
      "] " +
      r.finding.file +
      " " +
      r.finding.lines +
      " — " +
      r.finding.claim,
  );
  lines.push("Claim: " + r.finding.claim);
  lines.push("Reviewer evidence: " + r.finding.evidence);
  lines.push("Why it stands: " + r.reason);
  lines.push("Check evidence: " + r.evidence);
  lines.push("");
}
if (duplicateCount > 0) {
  lines.push(
    "Merged " + duplicateCount + " repeat report(s) into the issues above.",
  );
  lines.push("");
}

let newUpheld = 0;
let newUpheldP1 = 0;
let newUpheldP2 = 0;
let newUpheldP3 = 0;
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.finding.isNew && r.verdict === "UPHELD") {
    if (r.finding.severity === "P1") {
      newUpheld++;
      newUpheldP1++;
    } else if (r.finding.severity === "P3") {
      newUpheldP3++;
    } else {
      newUpheld++;
      newUpheldP2++;
    }
  }
}
const converged = round > 1 && newUpheldP1 === 0 && newUpheldP2 === 0;
lines.push("CONVERGENCE (report verbatim, then one-line reading):");
lines.push(
  "prior=" +
    priorCount +
    " raised=" +
    signalIncoming.length +
    " unique=" +
    signalUnique.length +
    " newUnique=" +
    newUnique +
    " newUpheld=" +
    newUpheld +
    " newUpheldP1=" +
    newUpheldP1 +
    " newUpheldP2=" +
    newUpheldP2 +
    " converged=" +
    converged,
);
lines.push(
  "Reading rule: counts are P1/P2 signal only (P3 excluded from this line); converged=true means no new upheld P1/P2 this round — the review is near exhaustive. A P3-only round converges. First round converged=false always (no baseline).",
);
lines.push("");

return {
  round: round,
  reviewerModel: reviewerModel,
  verifierModel: VERIFIER_MODEL,
  uniqueCount: unique.length,
  duplicateCount: duplicateCount,
  upheldCount: upheld.length,
  unparseableVerdicts: unparseableVerdicts,
  newUpheldP3: newUpheldP3,
  convergence: {
    prior: priorCount,
    raised: signalIncoming.length,
    unique: signalUnique.length,
    newUnique: newUnique,
    newUpheld: newUpheld,
    newUpheldP1: newUpheldP1,
    newUpheldP2: newUpheldP2,
    converged: converged,
  },
  results: results,
  chairmanTask: lines.join("\n"),
};
