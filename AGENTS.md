Batch independent tool calls in the same assistant turn; do not wait between independent reads/greps/bash calls.

## Subagent Delegation

Use subagents dynamically when they materially improve the result. Do not delegate trivial tasks.

- **scout**: inspect unfamiliar codebases, locate relevant files, trace behavior, and gather local context.
- **researcher**: investigate external documentation, APIs, libraries, current behavior, or factual questions. For substantial research, run multiple researchers in parallel with distinct focuses.
- **oracle**: use for difficult, ambiguous, architectural, or high-impact decisions, especially when there are competing approaches or conflicting evidence.
- **worker**: implement a well-understood, bounded task after necessary exploration/research is complete.
- **reviewer**: independently review meaningful changes for correctness, edge cases, tests, regressions, and unnecessary complexity. Verify reviewer findings before acting on them.
- **delegate**: use for independent bounded subtasks that do not clearly fit another specialist.

Prefer parallel delegation when tasks are independent.

Typical flows:

- Research: `researcher(s) [+ scout] → synthesize → oracle if needed`
- Implementation: `scout → researcher/oracle if needed → worker → reviewer → verify/fix`
- Simple task: handle directly.

The parent agent remains responsible for decomposition, choosing agents, reconciling conflicting results, verifying important claims, and producing the final answer.
