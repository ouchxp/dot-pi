// Council review, step 1 of 2.
// Invoke as workflowScript (not workflowScriptPath) so resume-retry-guard injects retryAll:
//   subagent({ workflowScript: <this file>, async: true })
// Edit `task` before launch. Stage 1 runs two reviewer models, each covering all three
// review aspects (correctness, tests, scope), in parallel. No gpt model is used in this step.
// After this returns, the parent automatically launches the gpt chairman as a single child:
//   subagent({ agent: "oracle", model: "quotio-gpt/gpt-5.6-sol:max", task: result.synthesisTask })
// gpt runs ONLY the synthesis step. It is a separate launch because this environment
// allows only one retryAll/retryRun per script (resume-retry-guard engine limitation);
// the parent chains the two steps: run this workflow, then launch the chairman with the
// returned synthesisTask.

const task = "the current change";

const models = [
  { name: "gemini", model: "tokenflux-gemini/gemini-3.7-flash-tiered:high" },
  { name: "grok", model: "tokenflux-grok/grok-4.6:xhigh" },
];

const aspects = [
  {
    key: "correctness",
    prompt:
      "Review " +
      task +
      " for correctness, regressions, and missing edge cases. Do not edit files. Do not run test suites, typecheck, lint, or build commands; review statically from code.",
  },
  {
    key: "tests",
    prompt:
      "Review " +
      task +
      " with emphasis on test coverage and failure modes, assessed from code and existing test files. Do not edit files. Do not run test suites, typecheck, lint, or build commands; review statically.",
  },
  {
    key: "scope",
    prompt:
      "Review " +
      task +
      " for unnecessary complexity, scope drift, and maintainability risks. Do not edit files. Do not run test suites, typecheck, lint, or build commands; review statically from code."
  },
];

const jobs = [];
for (const m of models) {
  for (const a of aspects) {
    jobs.push({
      key: m.name + "-" + a.key,
      agent: "reviewer",
      label: a.key + " review (" + m.name + ")",
      model: m.model,
      task: a.prompt,
    });
  }
}

const reviews = await retryAll(jobs);

const result = {};
for (let i = 0; i < jobs.length; i++) {
  result[jobs[i].key] = reviews[i].ok
    ? reviews[i].output
    : `[review failed: ${reviews[i].error ?? "no output"}]`;
}

const synthesisTask = [
  "Act as the council chairman. Synthesize the independent reports below for " + task + ".",
  "Give: FINAL VERDICT (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION), MANDATORY FIXES,",
  "RECOMMENDED IMPROVEMENTS, and CONFLICT RESOLUTION where reviewers disagreed.",
  "Be decisive. Do not edit files.",
  "",
];
for (let i = 0; i < jobs.length; i++) {
  synthesisTask.push(jobs[i].label + ":");
  synthesisTask.push(reviews[i].ok
    ? reviews[i].output
    : `[NO REPORT — review failed: ${reviews[i].error ?? "no output"}. Exclude this aspect from consensus.]`);
  synthesisTask.push("");
}

result.synthesisTask = synthesisTask.join("\n");
return result;
