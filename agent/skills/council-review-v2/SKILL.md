---
name: council-review-v2
description: Run the 3-stage council review v2 chain (structured findings, dedupe, cross-check verification, then chairman). Persistent append-only ledger survives across sessions and rounds. Use when the user says "council review v2", "run the v2 council", or invokes /skill:council-review-v2. Never touches v1 files.
---

# Council Review v2

Three stages, cheap models throughout. Findings ledger is mandatory and survives across sessions. Stage 1 runs six parallel correctness reviewers (two independent copies per angle across three angles); scope plus ponytail cleanliness rules are folded into every reviewer.

## Files (do not rename v1)

- Chain: `~/.pi/agent/chains/council-review-v2-stage1.js`, `~/.pi/agent/chains/council-review-v2-stage2.js`
- Agents: `council-v2-reviewer`, `council-v2-verifier`, `council-v2-chairman` (chairman primary `openai-codex/gpt-6-astra` at `thinking: high`, fallback `commandcode/deepseek/deepseek-v4.1-flash` in frontmatter)
- Ledger: `~/Projects/ai-docs/reviews/<repo>/<slug>.jsonl` plus memo `<slug>.md` beside it

## 1. Resolve scope and ledger

1. Determine the slug: ticket key uppercase when ticket-based, else branch name sanitized. Never guess keys. Reuse the ticket key plus intent as stage1 `TICKET`.
2. Gather context read-only: Jira ticket, Bitbucket PR, or `git diff dev...<branch> --stat`, full diff, `git log --oneline dev..<branch>`.
3. Check whether the ledger `.jsonl` exists for the slug. When it exists, read it and compute `ROUND` as max round plus 1. Build `ledgerSummary` listing open, fixed, rejected, and refuted finding IDs with one line each. Pass it into stage 1.

## 2. Ledger event format

Two files. The `.jsonl` ledger is per-review history (full finding details live here). The stats file is the long-term model scoreboard (counts only).

- Ledger: `~/Projects/ai-docs/reviews/<repo>/<slug>.jsonl`
- Model stats: `~/.pi/council-review-v2-model-stats.jsonl` (one shared file, all repos, all rounds)

Append one JSON object per line. Never rewrite history. Finding rows carry `fp` (fingerprint `file|lines|normalized-claim`) so future rounds can match repeats:

```json
{"ts": "<iso>", "round": 1, "type": "run_started|finding_created|finding_verified|chairman_decision|human_override", "id": "<finding id>", "fp": "<fingerprint>", "reviewerModel": "<model>", "verifierModel": "<model>", "verdict": "UPHELD|REFUTED|INCONCLUSIVE", "file": "<path>", "lines": "<start-end>", "claim": "<text>", "note": "<reason>"}
```

Append `finding_created` rows (with `reviewerModel`, `fp`) after stage 1, `finding_verified` rows (with both models) after stage 2, and `chairman_decision` (with `reviewerModel`, `verifierModel`, chairman model, plus the convergence numbers) after the chairman. Record user fix or dismiss decisions as `human_override`. Stage 1 syncs every finding claim to start with `[Pn] [<tag>]` matching its `severity`/`classification` fields, so the tags travel with the claim into the ledger, stage 2, and the chairman task — never strip them when copying a claim between representations.

## 3. Launch sequence

1. Stage 1: copy stage1 file content, replace `task`, `TICKET`, `ledgerSummary`, `ROUND`, `PRIOR` (JSON array of prior-round `fp` fingerprints from the ledger; `[]` on round 1), and `MODELS` (one primary model per category: `edge`, `callers`, `simplify`; both copies in a category share its model). Keep the defaults unless the user asked to change models. Launch one async `subagent({ workflowScript, async: true, globalConcurrencyLimit: 6 })`.
2. Append `finding_created` events from `result.findings` (include each finding's `fp`). When `result.parseFailures` is non-empty, stop: recover the raw output from the failed child run logs first, never proceed to stage 2 with a silently thinned set. Then embed `result.stage2Payload` into the stage2 file placeholder and launch it the same way: `subagent({ workflowScript, async: true, globalConcurrencyLimit: 6 })`.
3. Append `finding_verified` events from `result.results` (reviewer plus verifier models), then launch the chairman as a single child: `subagent({ agent: "council-v2-chairman", task: result.chairmanTask })`. Pass the chairman model used into the stats row. When `result.unparseableVerdicts` is non-empty, flag those findings in the memo as needing manual recovery. Convergence numbers are P1/P2 signal only — P3 never enters them (see section 5).
4. Append `chairman_decision` (copy the chairman's CONVERGENCE line plus `result.convergence` from stage 2) and write the memo `<slug>.md` with verdict, mandatory fixes, recommended improvements, conflict resolution, inconclusive items, convergence line, and run ids. Every finding mentioned in the memo (Current state list, round sections, verdict tallies) MUST carry both identifiers inline as `[Pn] [<tag>] file lines` — never present a finding without both tags.
5. Append one round row to `~/.pi/council-review-v2-model-stats.jsonl` (see section 5), including the convergence numbers. Do this every round, no exceptions.

Round N plus 1 reuses the ledger: collect all prior `fp` values (all severities) into the next round's `PRIOR`, so `isNew` flags only genuinely new claims.

## 5. Model performance stats (long-term scoreboard)

One append-only row per review round, shared across all repos. No finding text, only counts plus tiny metadata for model choice evaluation:

```json
{"ts": "<iso>", "repo": "<repo>", "slug": "<ticket-or-branch>", "round": 1, "reviewerModel": "<model>", "verifierModel": "<model>", "chairmanModel": "<model>", "raised": 0, "unique": 0, "newUnique": 0, "newUpheld": 0, "newUpheldP1": 0, "newUpheldP2": 0, "newUpheldP3": 0, "converged": false, "humanAccepted": 0, "humanDismissed": 0, "verdict": "APPROVE|REQUEST_CHANGES|NEEDS_DISCUSSION"}
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
FROM read_json_auto('~/.pi/council-review-v2-model-stats.jsonl')
GROUP BY 1 ORDER BY new_signal_rate DESC;
```

`humanAccepted` and `humanDismissed` come from `human_override` ledger rows. Append the round row after the chairman with pending human counts, then append a corrected row once triage finishes. Never edit history.

## 4. Model customization

Per-subagent primaries: stage1 `MODELS` maps each category (`edge`, `callers`, `simplify`) to its model (both copies in a category share it); stage2 `VERIFIER_MODEL` sets the verifier; the chairman model is chosen at its single-child launch (`subagent({ agent: "council-v2-chairman", model: ... })`). Fallbacks stay in agent frontmatter `fallbackModels`. When all three categories share one model, stage 1 reports it as `reviewerModel`; otherwise `"mixed"` with the per-category map in `reviewerModels`. Never add per-child model logic elsewhere.

## Notes

- Each stage file contains exactly one `retryAll` call. Never merge stages into one script.
- Concurrency: every stage launch passes `globalConcurrencyLimit: 6`. Peak 6 children, the rest queue on stable keys. Zero accuracy cost; verifier-heavy rounds take longer wall-clock.
- Review principles: never run tests, typecheck, lint, or builds; correctness plus ticket scope plus ponytail cleanliness only; out-of-scope code only when it breaks correctness.
- Fixes wait for explicit user approval.
