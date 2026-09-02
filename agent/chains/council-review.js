// Council review, step 1 of 2.
// Invoke as workflowScript (not workflowScriptPath) so resume-retry-guard injects retryAll:
//   subagent({ workflowScript: <this file>, async: true })
// Edit `task` before launch. After this returns, launch oracle as a single child:
//   subagent({ agent: "oracle", model: "openai-codex/gpt-5.6-sol:max", task: result.synthesisTask })
// Synthesis is a separate launch because this environment allows only one retryAll/retryRun per script.

const task = "the current change";

const reviews = await retryAll([
  {
    key: "correctness",
    agent: "reviewer",
    label: "Correctness review",
    model: "openai-codex/gpt-5.6-luna:high",
    task:
      "Review " +
      task +
      " for correctness, regressions, and missing edge cases. Do not edit files.",
  },
  {
    key: "tests",
    agent: "reviewer",
    label: "Test review",
    model: "openai-codex/gpt-5.6-terra:high",
    task:
      "Review " +
      task +
      " with emphasis on test coverage, verification evidence, and failure modes. Do not edit files.",
  },
  {
    key: "scope",
    agent: "reviewer",
    label: "Scope review",
    model: "openai-codex/gpt-5.6-sol:high",
    task:
      "Review " +
      task +
      " for unnecessary complexity, scope drift, and maintainability risks. Do not edit files.",
  },
]);

return {
  correctness: reviews[0].output,
  tests: reviews[1].output,
  scope: reviews[2].output,
  synthesisTask: [
    "Act as the council chair. Synthesize the independent reports below for " +
      task +
      ". Separate blockers, actionable fixes, and non-blocking observations. Do not edit files.",
    "",
    "Correctness report:",
    reviews[0].output,
    "",
    "Test report:",
    reviews[1].output,
    "",
    "Scope report:",
    reviews[2].output,
  ].join("\n"),
};
