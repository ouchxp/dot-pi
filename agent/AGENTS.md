Batch independent tool calls in the same assistant turn; do not wait between independent reads/greps/bash calls.

## pi-lens Rules

- The pi-lens automated check (🔴/⚠️ messages after edits) scans edited files and may flag issues that predate the change. A finding on the file does not mean the change introduced it.
- Never add `pi-lens-ignore` comments, `lens_diagnostic_mark` suppress/defer dispositions, or any other inline suppression to silence automated checks — unless the user explicitly asks for it.
- Let the user decide whether to track or fix findings separately; report honestly (file, line, rule, one-line reason).

## Subagent Runs — No Attention Looping

- After launching an async subagent, arm the wait subscription **once** and return control. Do not re-arm, re-check status, or steer on repeated "needs attention" wakes.
- A "needs attention" wake is a notification, not a poll. Check `subagent_supervisor pending` once; if empty, ignore the wake — the completion wake arrives on its own.
- Only act when the run is genuinely stuck: the attention threshold fires AND a steer gets no response. Then steer once with a concrete question, or interrupt.
- Never run status/polling loops or repeatedly inspect session files to "watch" a run. Long thinking phases (max-effort models) are normal.

## Subagent Delegation

Use subagents dynamically when they materially improve the result. Do not delegate trivial tasks.

- **scout**: inspect unfamiliar codebases, locate relevant files, trace behavior, and gather local context.
- **researcher**: investigate external documentation, APIs, libraries, current behavior, or factual questions. For substantial research, run multiple researchers in parallel with distinct focuses.
- **oracle**: use for difficult, ambiguous, architectural, or high-impact decisions, especially when there are competing approaches or conflicting evidence.
- **worker**: implement a well-understood, bounded task after necessary exploration/research is complete.
- **reviewer**: independently review meaningful changes for correctness, edge cases, tests, regressions, and unnecessary complexity. Verify reviewer findings before acting on them.
- **exception-detector**: scan a diff for judgment-boundary exceptions — unusual code a human reviewer would stop at (unexplained existence, deviation from codebase precedent, scope-boundary violations). Complements correctness review; launch alongside reviewer on high-risk changes, or when a previous review round felt "clean but uneasy".
- **delegate**: use for independent bounded subtasks that do not clearly fit another specialist.

Prefer parallel delegation when tasks are independent.

Typical flows:

- Research: `researcher(s) [+ scout] → synthesize → oracle if needed`
- Implementation: `scout → researcher/oracle if needed → worker → reviewer → verify/fix`
- Simple task: handle directly.

The parent agent remains responsible for decomposition, choosing agents, reconciling conflicting results, verifying important claims, and producing the final answer.
