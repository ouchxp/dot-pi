---
name: council-review
description: Run the 3-stage council review chain (structured findings, dedupe, cross-check verification, then chairman). Persistent append-only ledger survives across sessions and rounds. Use when the user says "council review", "run the council", or invokes /council-review.
---

# Council Review

Three stages, cheap models throughout. Findings ledger is mandatory and survives across sessions. Stage 1 runs N parallel correctness reviewers per angle across three angles (edge, callers, simplify), one reviewer per configured model; scope plus ponytail cleanliness rules are folded into every reviewer.

## Files

- Chain: `~/.pi/agent/chains/council-review-stage1.js`, `~/.pi/agent/chains/council-review-stage2.js`
- Agents: `council-reviewer`, `council-verifier`, `council-chairman` (chairman primary `openai/gpt-6-astra` at `thinking: high`, fallback `commandcode/deepseek/deepseek-v4.1-flash` in frontmatter)
- Ledger: `~/Projects/ai-docs/reviews/<repo>/<slug>.jsonl` plus memo `<slug>.md` beside it

## 1. Resolve scope and ledger

1. Determine the slug: ticket key uppercase when ticket-based, else branch name sanitized. Never guess keys. Reuse the ticket key plus intent as stage1 `TICKET`.
2. Gather context read-only: Jira ticket, Bitbucket PR, or `git diff dev...<branch> --stat`, full diff, `git log --oneline dev..<branch>`.
3. Check whether the ledger `.jsonl` exists for the slug. When it exists, read it and compute `ROUND` as max round plus 1. Build `ledgerSummary` listing open, fixed, rejected, and refuted finding IDs with one line each. Pass it into stage 1.

## 2. Ledger event format

Two files. The `.jsonl` ledger is per-review history (full finding details live here). The stats file is the long-term model scoreboard (counts only).

- Ledger: `~/Projects/ai-docs/reviews/<repo>/<slug>.jsonl`
- Model stats: `~/.pi/council-review-model-stats.jsonl` (one shared file, all repos, all rounds)

Append one JSON object per line. Never rewrite history. Finding rows carry `fp` (fingerprint `file|lines|normalized-claim`) so future rounds can match repeats:

```json
{
  "ts": "<iso>",
  "round": 1,
  "type": "run_started|finding_created|finding_verified|chairman_decision|human_override",
  "id": "<finding id>",
  "fp": "<fingerprint>",
  "reviewerModel": "<model>",
  "verifierModel": "<model>",
  "verdict": "UPHELD|REFUTED|INCONCLUSIVE",
  "file": "<path>",
  "lines": "<start-end>",
  "claim": "<text>",
  "note": "<reason>"
}
```

After the workflow returns, append completed results in stage order: `finding_created` rows (with `reviewerModel`, `fp`) from stage 1, `finding_verified` rows (with both models) from stage 2, and `chairman_decision` (with `reviewerModel`, `verifierModel`, chairman model, plus the convergence numbers) from the chairman. Preserve completed stage results even when a later stage fails. Record user fix or dismiss decisions as `human_override`. Stage 1 syncs each internal claim's `[Pn] [<tag>]` prefix with its `severity`/`classification` fields and carries its `kind` field separately through verification. Finding IDs stay in ledger and JSON only.

## 3. Launch sequence

Use the installed `pi-subagents` skill for current workflow syntax. The two stage files are statement-body templates; compose them and the chairman into one top-level async workflow, not separate top-level launches. Keep each stage in its own block scope, with `let stage1Result; let stage2Result;` outside the blocks. Keep native awaits at the top level; do not introduce nested async helpers.

1. Prepare stage 1: replace `task`, `TICKET`, `ledgerSummary`, `ROUND`, `PRIOR` (JSON array of prior-round `fp` fingerprints; `[]` on round 1), and `MODELS` (per-category model lists for `edge`, `callers`, `simplify`). Keep model defaults unless the user asked to change them. Replace only the stage's final `return { ... }` with `stage1Result = { ... }` in the composed script.
2. Before stage 2, return `{ stage1Result }` if `stage1Result.parseFailures` is non-empty. Never proceed with a silently thinned review. Otherwise set stage 2's `stage2Payload` to `stage1Result.stage2Payload`, and replace its final return with `stage2Result = { ... }`. Preserve the native batch results for failure triage; do not advance past a failed child. Return completed stage data and failed run evidence instead of automatically retrying.
3. Launch the chairman inside that same workflow with native `await runs.all([{ key: "chairman-r" + stage2Result.round, agent: "council-chairman", label: "Synthesize council findings", task: stage2Result.chairmanTask, output: "council-chairman.md" }])`. Return `{ stage1Result, stage2Result, chairmanResult }`, where `chairmanResult` is the single batch result. Its `ok` value must be checked before treating the review as complete. The chairman task already contains only confirmed issues, with repeats merged and no finding IDs.
4. Write the composed script in one fenced `js workflow` block and launch exactly once with `subagent({ workflow: true, async: true, globalConcurrencyLimit: <limit> })`, where `<limit>` is the larger of 6 and the total reviewer count. A prepared script file can instead use `workflow: "./path/to/script.js"`. Bind durable child reports through each native job's `output` field. Consume the workflow result before recording findings; on failure, inspect native run artifacts and make an explicit recovery decision.
5. Append completed results to the ledger in stage order, then write `<slug>.md` with verdict, mandatory fixes, recommended improvements, low notes, merged count, the chairman's CONVERGENCE line, stage 2's `convergence`, and run IDs. Report any `unparseableVerdicts` count with a pointer to the run logs. Every issue MUST carry `[Pn] [<classification>] [<kind>] file lines`, with no finding IDs. Append the model-stats row described in section 5, including the chairman model actually used. Do not publish a completed verdict or convergence claim for an incomplete run.

Round N plus 1 reuses the ledger: collect all prior `fp` values (all severities) into the next round's `PRIOR`, so `isNew` flags only genuinely new claims.

## 5. Model performance stats (long-term scoreboard)

One append-only row per review round, shared across all repos. No finding text, only counts plus tiny metadata for model choice evaluation:

```json
{
  "ts": "<iso>",
  "repo": "<repo>",
  "slug": "<ticket-or-branch>",
  "round": 1,
  "reviewerModel": "<model>",
  "verifierModel": "<model>",
  "chairmanModel": "<model>",
  "raised": 0,
  "unique": 0,
  "newUnique": 0,
  "newUpheld": 0,
  "newUpheldP1": 0,
  "newUpheldP2": 0,
  "newUpheldP3": 0,
  "converged": false,
  "humanAccepted": 0,
  "humanDismissed": 0,
  "verdict": "APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION"
}
```

- `prior` is the full prior-fingerprint suppression-list size (all severities and verdicts — dedupe must suppress P3 repeats too). Every other convergence count is P1/P2 signal only: `raised`, `unique`, `newUnique`, `newUpheld`, `newUpheldP1`, `newUpheldP2` exclude P3. P3 findings are still verified and recorded in the ledger and memo as low notes, and counted once as stats-only `newUpheldP3` noise — they never enter convergence counts or the `converged` decision. `newUnique`/`newUpheld*` count only claims whose fingerprint never appeared in a prior round.
- `converged` is true when round is past 1 and `newUpheldP1` and `newUpheldP2` are both 0. A P3-only round converges; P3 is noise, not progress. (P3 exclusion effective 2026-09-16; earlier stats rows counted P3 inside raised/unique.)

Score per reviewer model with `duckdb`. Example:

```sql
SELECT reviewerModel,
  COUNT(*) AS rounds,
  SUM(unique) AS findings,
  ROUND(SUM(newUpheldP1) * 1.0 / NULLIF(SUM(unique), 0), 2) AS new_signal_rate,
  ROUND(AVG(CASE WHEN converged THEN 1.0 ELSE 0.0 END), 2) AS converged_share
FROM read_json_auto('~/.pi/council-review-model-stats.jsonl')
GROUP BY 1 ORDER BY new_signal_rate DESC;
```

`humanAccepted` and `humanDismissed` come from `human_override` ledger rows. Append the round row after the chairman with pending human counts, then append a corrected row once triage finishes. Never edit history.

## 4. Model customization

Per-subagent primaries: stage1 `MODELS` maps each category (`edge`, `callers`, `simplify`) to its list of models (one reviewer per entry, each on a different model); stage2 `VERIFIER_MODEL` sets the verifier; the chairman model is chosen through its native job's `model` field in the composed workflow. Fallbacks stay in agent frontmatter `fallbackModels`. Each finding carries its reviewer's exact model in `reviewerModel`. Stage 1 also reports aggregate `reviewerModel` (the single model when every list holds that same one entry, else `"mixed"`) plus the per-category lists in `reviewerModels` for the stats row. Never add per-child model logic elsewhere.

## Reporting rule (mandatory)

Every surface the reader sees — memo, chat reply — shows each confirmed issue once, in plain words, in the form `[Pn] [<classification>] [<kind>] <path> <lines> — <claim>`. Finding IDs live in JSON and ledger rows only, never in reader-facing prose.

```
[P2] [in-scope] [bug] gogo/models/Ride.ts 6799-6812 — completed-but-unpaid rides charged after the deploy lose the $5 tip
```

- Repeats are merged: one line per issue. The merged-away copies are not listed, and there is no merged-into list.
- Rejected and unsure items never surface: no refuted list, no conflict section, no inconclusive section. They stay in the ledger only.
- All three tags are mandatory on every mention, in every section, including chat summaries and "notes for the owner". Dropping one to shorten a line loses evidence.
- Never group issues under a bare severity heading or restate a claim in prose without its tags.
- Pre-send check before the chat report and memo: every issue line contains `[Pn]`, `[<classification>]`, `[<kind>]`, path, and lines, and no finding ID. If any line fails, fix it before sending.

## Notes

- Each stage uses native `await runs.all(jobs)`. No injected preamble or retry helper is required. The deprecated helper's one-batch restriction does not apply.
- Failed children are not automatically retried. Preserve their run IDs and artifacts, inspect the failure, and use current native resume controls only after an explicit recovery decision.
- Concurrency: the single workflow uses `globalConcurrencyLimit` equal to the larger of 6 and the total reviewer count. Extra children queue on stable keys.
- Review principles: never run tests, typecheck, lint, or builds; correctness plus ticket scope plus ponytail cleanliness only; out-of-scope code only when it breaks correctness.
- Fixes wait for explicit user approval.
