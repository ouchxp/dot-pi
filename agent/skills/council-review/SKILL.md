---
name: council-review
description: Run the 2-step council review chain on a branch/PR (6 parallel reviewers, 2 models x 3 aspects, then an oracle chairman synthesis). Supports extra instructions such as reading a Jira ticket or Bitbucket PR comments as review context. Use when the user says "council review", "run the council", "chain review", or invokes /skill:council-review. Not a substitute for a single-pass code review request.
---

# Council Review Chain

A branch/PR review in two orchestrated steps, defined by `~/.pi/agent/chains/council-review.js`.
Do not edit that file; pass its content as the `workflowScript` string so the
resume-retry-guard extension injects its `retryAll` preamble (it only injects for
`workflowScript`, never for `workflowScriptPath` or `workflow`).

## Protocol

1. **Resolve the scope.** Use the user's scope (branch, PR URL/id, ticket key, or plain
   description). Gather review context the user asked for before launching reviewers:
   - Jira ticket: `twg jira workitem get <KEY>` and
     `twg jira workitem comment query --issue-id <KEY>` (both read-only).
   - Bitbucket PR: `twg bb prs get <ID>`, `twg bb prs comment query <ID>`,
     `twg bb prs activity <ID>`.
   - Local branch diff: read-only git (`git diff dev...<branch> --stat`,
     `git diff dev...<branch>`, `git log --oneline dev..<branch>`).
     Never guess keys or IDs; resolve them with twg help when unsure.

2. **Read the chain file.** `~/.pi/agent/chains/council-review.js`. It contains a
   `const task = "the current change"` placeholder and a header comment explaining the
   2-step chain.

3. **Prepare the workflow script.** Take the file content, replace only the task value
   with the concrete scope (branch vs dev, PR number, ticket key, plus any context the
   reviewers need). Keep it a single concise string. Do not change models/aspects unless
   the user asked.

4. **Launch step 1.** One async `subagent` call:
   `subagent({ workflowScript: <edited file content>, async: true })`.
   Inside the script the file itself uses one `retryAll` batch of 6 reviewer children
   (2 models x correctness/tests/scope) and returns per-reviewer outputs plus a
   `synthesisTask`.

5. **Launch step 2 (chairman).** When step 1 returns, launch the chairman as a separate
   single child (the one-batch-per-workflow engine limit makes this a separate launch):
   `subagent({ agent: "oracle", model: "quotio-gpt/gpt-6-astra:high", task: result.synthesisTask })`.
   Tell the user step 1 finished, count completed/agreed/disputed reports, and that the
   chairman pass is running.

6. **Memo.** After the chairman returns, write the final review to
   `~/Projects/ai-docs/reviews/<repo>/<branch>.md` (for gogo: `~/Projects/ai-docs/reviews/gogo/`).
   Include: verdict (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION), mandatory fixes,
   recommended improvements, conflict resolutions, per-reviewer tags, and run ids.
   Report findings to the user; fixes wait for explicit user approval (review gate).

## Notes

- Roster fallback: the chain file pins its own two reviewer models; do not substitute
  `council-*` agents, they are not required for this chain.
- The chain is sequential synthesis, not a cross-exam loop; advisors do not see each
  other and there is no pass 3 unless the user asks.
