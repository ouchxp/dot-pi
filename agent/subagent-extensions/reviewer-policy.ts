/**
 * Subagent-only prompt overlay for the bundled `reviewer` preset.
 *
 * Keeps the bundled `pi-subagents` reviewer authoritative while layering:
 *   - Read-only `bash` inspection rules (`git`, `twg`, `gh`, `mycli`, etc.)
 *   - Static-only review rules (no tests, typecheck, lint, or build runs — also
 *     enforced by `static-review-guard.ts`; filesystem writes outside temp and
 *     the review ledger are kernel-blocked by `ask-mode.ts`)
 *   - Scope-anchoring and token-efficiency rules
 *   - Finding classification (`[pre-existing]`, `[in-scope]`, `[regression]`, `[surfaced]`)
 *   - Finding kind (`[req]`, `[bug]`, `[risk]`, `[opinion]`, `[cleanup]`)
 *   - Review ledger, simplicity, and P2 fix-cost rules
 *
 * Loaded only via `subagents.agentOverrides.reviewer.subagentOnlyExtensions`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WATCHDOG_LIMITATION_LINE =
  "- `watchdog_diff` does not inspect committed ranges. When a task asks for one, require a supplied artifact or report that limitation rather than claiming the commit was reviewed.";

const NO_SHELL_LINE =
  "- Do not use shell commands, mutate the repository, or request general Git access. Report any test command a supervisor must run.";

const READ_ONLY_BASH_LINE =
  "- Use `bash` only for read-only inspection (`git show`, `git diff`, `git log`, `git status`, `git merge-base`, `twg`, `gh`, `mycli` read-only queries, etc.). Filesystem writes outside temp folders and `~/Projects/ai-docs/reviews` are kernel-blocked by macOS `sandbox-exec`. Never mutate git state or external records. Never run test suites, typecheck (`tsc`), lint, format, or build commands — review statically from code and existing test files, and report any verification commands for the parent to run (also blocked at tool call time).";

const BUNDLED_FINDING_FORMAT_LINE =
  "- Finding: P0/P1/P2, issue, location, evidence, and smallest fix";

const CUSTOM_FINDING_FORMAT_LINES = [
  "- Finding: [P0/P1/P2] [classification] [kind] path lines — issue; evidence and smallest fix",
  "- Ledger: which prior findings this round confirmed, overturned, or pushed back on (when a ledger is given)",
].join("\n");

const SCOPE_ANCHORING_BULLET =
  "- Anchor investigation to the diff, changed files, and their direct callers/config. Follow deeper leads into third-party dependencies or `node_modules/` only when verifying one concrete, high-impact hypothesis from the diff — do not explore framework internals speculatively.\n";

function isGptModel(modelId?: string): boolean {
  return typeof modelId === "string" && /\bgpt(?:[-_.\s]|$)/i.test(modelId);
}

function buildReviewerPolicyAppend(options?: { modelId?: string }): string {
  const scopeBullet = isGptModel(options?.modelId) ? "" : SCOPE_ANCHORING_BULLET;
  return `
## Token efficiency and static review

- Review statically from code, git history, and existing test files. Never run test suites, typecheck (\`tsc\`), lint, or build commands; note any verification command the parent should run.
- Run each \`git diff\` / \`git log\` / \`git show\` command at most once per ref/scope. Reuse prior output; if you need surrounding context, read the specific file region instead of re-fetching the diff with wider context.
- Never read \`*.jsonl\` session, fork, or transcript files.
- Prefer targeted reads (\`read\` with \`offset\`/\`limit\`, \`read_symbol\`, \`read_enclosing\`, \`ffgrep\`, \`fffind\`) over whole-file reads.
${scopeBullet}- Simplicity is a per-finding criterion: flag complexity introduced by the diff — speculative abstraction, unnecessary structure, names or indirection that hurt readability (\`[in-scope]\` for diff-added complexity, \`[regression]\` if it made existing code harder).

## Finding classification and kind

Every reader-facing finding and fix update states exactly one classification tag and one kind tag:

- Classification:
  - \`[pre-existing]\` — existed before the reviewed change (verify with \`git show HEAD:<file>\` when in doubt). Report it, do not fix it.
  - \`[in-scope]\` — part of the current task/ticket. Must be fixed.
  - \`[regression]\` — the change breaks previously working behavior. Must be fixed. State the root cause.
  - \`[surfaced]\` — the change exposes existing behavior through a new in-scope path or materially broadens its impact. Verify the baseline and describe the new impact. Preserve the classification in fix updates.
- Kind: \`[req]\` (named requirement mismatch), \`[bug]\` (incorrect processing), \`[risk]\` (plausible timing or edge hazard), \`[opinion]\` (preference), or \`[cleanup]\` (dead or stale code).
- Do not display finding IDs; keep them in ledgers only.

## Fix cost vs. impact

Weigh fix cost against impact (severity × likelihood × blast radius, not visibility — silent data corruption is high-impact). For P2 findings, if the smallest fix is one line, say "fix it"; if even the smallest fix restructures code or adds complexity, rule it report-only and state why. State fix cost only when it changes the verdict.

## Review ledger

When the task names a review ledger path, read it before reviewing:

- Do not re-flag findings already marked \`[fixed]\` or \`[rejected]\`. Verify the fix against code; if wrong or incomplete, push back plainly with evidence and tag it \`[regression]\`.
- Resolve \`[contested]\` findings with code proof or previously missed evidence; state which side you took and why.
- The ledger is a log, not authority: re-verify prior claims against current code.
- Report this round's findings in your review; do not edit the ledger yourself unless instructed.
`.trim();
}

export function applyReviewerPolicy(
  systemPrompt: string,
  options?: { modelId?: string },
): string {
  if (systemPrompt.includes("## Finding classification and kind")) {
    return systemPrompt;
  }

  const updated = systemPrompt
    .replace(`${WATCHDOG_LIMITATION_LINE}\n${NO_SHELL_LINE}`, READ_ONLY_BASH_LINE)
    .replace(NO_SHELL_LINE, READ_ONLY_BASH_LINE)
    .replace(BUNDLED_FINDING_FORMAT_LINE, CUSTOM_FINDING_FORMAT_LINES);

  return `${updated}\n\n${buildReviewerPolicyAppend(options)}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const next = applyReviewerPolicy(event.systemPrompt, {
      modelId: ctx.model?.id,
    });
    return next === event.systemPrompt ? undefined : { systemPrompt: next };
  });
}
