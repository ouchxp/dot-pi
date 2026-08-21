/**
 * resume-retry-guard — enforces the resume-retry workflowScript convention.
 *
 * Hooks the `subagent` tool's `tool_call` event and:
 *   1. Blocks workflowScripts that call raw `runs.run(` / `runs.all(` directly
 *      (unless the call opts out with `retry: false`).
 *   2. Injects a portable preamble defining `retryRun()` / `retryAll()` helpers
 *      that resume a failed child from its persisted session (never restart),
 *      with task-type-aware continuation prompts.
 *
 * See ~/.agents/skills/resume-retry/SKILL.md for the convention and prompt text.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

/**
 * pi-subagents engine limitation (verified 2026-08): the workflow completion check
 * (scripted-workflow.ts) rejects a SECOND helper-mediated resume in the same workflow
 * as "unawaited runs.run launch(es)", even though the child runs fine. Supported pattern:
 * at most ONE retryRun OR ONE retryAll batch per workflowScript. Sequential dependent
 * retries require separate workflowScript launches.
 */
const ONE_BATCH_LIMIT_REASON =
	"pi-subagents workflow engine supports only ONE retryRun/retryAll batch per workflowScript (a second helper-mediated resume is rejected as unawaited). Use a single retryAll batch with all children, or split sequential dependent retries into separate workflowScript launches. See ~/.agents/skills/resume-retry/SKILL.md.";

/** Count retryRun(/retryAll( launch sites (excluding the preamble itself). */
function countHelperLaunchSites(script: string): number {
	const matches = script.match(/\bretryRun\s*\(|\bretryAll\s*\(/g);
	return matches ? matches.length : 0;
}

/**
 * Portable helper preamble. Constraint: the workflow script worker parses the combined
 * script with a portability check that rejects NESTED async functions (only the outer
 * `(async () => {...})()` wrapper may be async). So these helpers are plain functions
 * returning promise chains — do not convert them to async functions.
 */
const PREAMBLE = `// === resume-retry preamble (injected by resume-retry-guard extension) ===
function __rrResumeTask(agent, resumeTask) {
  if (resumeTask) return resumeTask;
  var name = String(agent || '').toLowerCase();
  if (/review|oracle|scout|audit|check|validator|advisor/.test(name)) {
    return "Your previous run was interrupted mid-stream. Your prior analysis is persisted — do NOT restart. Re-verify your partial findings against the actual code, complete any unfinished checks, and produce your final report.";
  }
  if (/worker|coder|develop|implement|fix/.test(name)) {
    return "Your previous run was interrupted mid-work. Your session is persisted — do NOT redo completed work. First check git status/diff to see exactly what landed, then complete only the unfinished portion and re-verify with a build/test before finishing.";
  }
  return "Your previous run was interrupted mid-stream. Your prior work is persisted — do NOT restart from scratch. Continue carefully from where you stopped, verify what was already done, and finish the task.";
}

// Retry a single child: on failure, resume it from its persisted session (runs.all
// resolves failures with the runId instead of rejecting, which makes recovery possible).
function retryRun(key, params, resumeTask) {
  return runs.all([Object.assign({ key: key }, params)]).then(function (results) {
    var result = results[0];
    if (result.ok) return result;
    if (!result.runId) {
      throw new Error("retryRun('" + key + "') child failed without a resumable runId: " + (result.error || result.output));
    }
    return runs.run(key + '__resume', { resume: result.runId, task: __rrResumeTask(params && params.agent, resumeTask) });
  });
}

// Retry a parallel fanout: resume each failed child individually, keep successful results.
function retryAll(items, resumeTask) {
  return runs.all(items).then(function (results) {
    var pending = [];
    for (var i = 0; i < results.length; i++) {
      var result = results[i];
      if (result.ok || !result.runId) {
        pending.push(Promise.resolve(result));
        continue;
      }
      var item = items[i];
      pending.push(runs.run(item.key + '__resume', { resume: result.runId, task: __rrResumeTask(item.agent, resumeTask) }));
    }
    return Promise.all(pending);
  });
}
// === end resume-retry preamble ===

`;

interface SubagentInput extends Record<string, unknown> {
	workflowScript?: unknown;
	retry?: unknown;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		// The subagent tool is extension-registered, so it arrives as a CustomToolCallEvent.
		if (!isToolCallEventType<"subagent", SubagentInput>("subagent", event)) return;

		const input = event.input as SubagentInput;
		if (typeof input.workflowScript !== "string") return; // single-child / management action
		if (input.retry === false) return; // explicit opt-out

		const script: string = input.workflowScript;

		// Enforce: no raw launches. The injected preamble itself uses runs.run/runs.all,
		// but it is added AFTER this check, so any hit here is authored by the caller.
		if (/runs\.(run|all)\s*\(/.test(script)) {
			return {
				block: true,
				reason:
					"workflowScript must use the retryRun()/retryAll() helpers (auto-injected by the resume-retry-guard extension) instead of raw runs.run()/runs.all(), so failed children resume from their persisted session. See ~/.agents/skills/resume-retry/SKILL.md. Pass retry: false on the subagent call to opt out.",
			};
		}

		// Enforce: at most ONE retryRun/retryAll batch per workflow (engine limitation).
		if (countHelperLaunchSites(script) > 1) {
			return { block: true, reason: ONE_BATCH_LIMIT_REASON };
		}

		// Inject the portable helper preamble.
		input.workflowScript = PREAMBLE + script;
	});
}
