import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const fakeCodingAgentUrl =
  "data:text/javascript," +
  encodeURIComponent(
    `export function isToolCallEventType(name, event) { return event?.toolName === name; }`,
  );

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") {
      return { url: fakeCodingAgentUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { default: askModeExtension } = await import("../extensions/ask-mode.ts");
const { default: staticReviewGuardExtension, checkStaticReviewCommand } =
  await import("../subagent-extensions/static-review-guard.ts");
const { applyReviewerPolicy } =
  await import("../subagent-extensions/reviewer-policy.ts");

function loadAskModeHandlers() {
  const handlers = {};
  askModeExtension({
    on(event, fn) {
      handlers[event] = fn;
    },
    registerShortcut() {},
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  });
  return handlers;
}

function loadAskModeToolCall() {
  return loadAskModeHandlers().tool_call;
}

test("forked writer preserves explicit inherited parent ASK-mode session entry", () => {
  const prevChild = process.env.PI_SUBAGENT_CHILD;
  const prevArgv = process.argv.slice();
  const tmpDir = mkdtempSync(path.join(tmpdir(), "pi-ask-fork-worker-"));
  const cfgPath = path.join(tmpDir, "async-cfg-test-run.json");
  writeFileSync(cfgPath, JSON.stringify({ agent: "worker" }));
  process.env.PI_SUBAGENT_CHILD = "1";
  process.argv = [...prevArgv, cfgPath];
  try {
    const handlers = loadAskModeHandlers();
    handlers.session_start(
      {},
      {
        hasUI: false,
        sessionManager: {
          getEntries: () => [
            { type: "custom", customType: "ask-mode", data: { enabled: true } },
          ],
        },
      },
    );
    handlers.before_agent_start({ systemPrompt: "" });

    const editBlocked = handlers.tool_call({
      toolName: "edit",
      input: { path: "README.md" },
    });
    assert.equal(editBlocked?.block, true);

    const bashEvent = {
      toolName: "bash",
      input: { command: "git status --short" },
    };
    handlers.tool_call(bashEvent);
    assert.match(bashEvent.input.command, /^\/usr\/bin\/sandbox-exec -p /);
    assert.match(bashEvent.input.command, /\(deny file-write\*\)/);
  } finally {
    process.argv = prevArgv;
    if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = prevChild;
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("forked subagent child ignores inherited parent EDIT-mode session entry", () => {
  const prevChild = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const handlers = loadAskModeHandlers();
    handlers.session_start(
      {},
      {
        hasUI: false,
        sessionManager: {
          getEntries: () => [
            {
              type: "custom",
              customType: "ask-mode",
              data: { enabled: false },
            },
          ],
        },
      },
    );
    const event = {
      toolName: "bash",
      input: { command: "git status --short" },
    };
    handlers.tool_call(event);
    assert.match(event.input.command, /^\/usr\/bin\/sandbox-exec -p /);
    assert.match(event.input.command, /\(deny file-write\*\)/);
  } finally {
    if (prevChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = prevChild;
  }
});

test(
  "ask-mode sandbox executes git read, allows temp/ledger writes, blocks repo writes, and does not double-wrap",
  { skip: process.platform !== "darwin" },
  () => {
    const toolCall = loadAskModeToolCall();
    assert.equal(typeof toolCall, "function");

    const event = {
      toolName: "bash",
      input: {
        command: 'git status --short && echo "locks=$GIT_OPTIONAL_LOCKS"',
      },
    };
    toolCall(event);
    assert.match(event.input.command, /^\/usr\/bin\/sandbox-exec -p /);
    assert.match(
      event.input.command,
      new RegExp(path.join(homedir(), "Projects", "ai-docs", "reviews")),
    );

    // Calling ask-mode tool_call again on the same event must not nest sandbox-exec.
    const wrappedOnce = event.input.command;
    toolCall(event);
    assert.equal(event.input.command, wrappedOnce);

    // Caller-supplied `/usr/bin/sandbox-exec` must NOT bypass Ask Mode's profile.
    const spoofEvent = {
      toolName: "bash",
      input: {
        command: `/usr/bin/sandbox-exec -p '(version 1)(allow default)' touch "${path.join(repoRoot, ".sandbox-spoof-canary")}"`,
      },
    };
    const originalSpoof = spoofEvent.input.command;
    toolCall(spoofEvent);
    assert.notEqual(spoofEvent.input.command, originalSpoof);
    assert.match(spoofEvent.input.command, /\(deny file-write\*\)/);

    // Live execution succeeds (no exit 71 sandbox_apply failure) and sets GIT_OPTIONAL_LOCKS=0.
    const out = execSync(event.input.command, {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.match(out, /locks=0/);

    // Temp writes succeed inside the sandbox.
    const tmpDir = mkdtempSync(path.join(tmpdir(), "pi-ask-sb-"));
    try {
      const target = path.join(tmpDir, "ok.txt");
      const tmpEvent = {
        toolName: "bash",
        input: { command: `printf ok > "${target}"` },
      };
      toolCall(tmpEvent);
      execSync(tmpEvent.input.command, { cwd: repoRoot, encoding: "utf8" });
      assert.equal(readFileSync(target, "utf8"), "ok");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    // Repo writes are kernel-denied.
    const deniedPath = path.join(repoRoot, ".sandbox-denied-canary");
    const denyEvent = {
      toolName: "bash",
      input: { command: `touch "${deniedPath}"` },
    };
    toolCall(denyEvent);
    assert.throws(
      () => execSync(denyEvent.input.command, { cwd: repoRoot, stdio: "pipe" }),
      /Operation not permitted/i,
    );
    assert.equal(existsSync(deniedPath), false);
  },
);

test("checkStaticReviewCommand blocks tsc, tests, linters, builds, and post-subcommand flags", () => {
  const mustBlock = [
    "tsc --noEmit",
    "npx tsc -p tsconfig.json",
    "npx --yes tsc --noEmit",
    "npx -c 'tsc --noEmit'",
    "npx -c='tsc --noEmit'",
    "npx --call='vitest run'",
    "npx eslint@9.39.0 src/app.ts",
    "npx @biomejs/biome@1.9.4 check .",
    "npx @playwright/test@1.50.0",
    "pnpm dlx vitest@2.1.0 run",
    "npm exec --call 'tsc --noEmit'",
    "npm exec --call='eslint src/app.ts'",
    "npm exec --package typescript --call 'tsc --noEmit'",
    "npm --package typescript exec -- tsc --noEmit",
    "npm exec -p tsc --noEmit",
    "npm exec eslint@9.39.0 -- src/app.ts",
    "pnpm exec tsc --noEmit",
    "npm exec -- tsc --noEmit",
    "npm run-script test",
    "npm x -- tsc --noEmit",
    "npm \\\n test",
    "npx \\\r\n tsc --noEmit",
    "npm run --silent test",
    "pnpm --filter app build",
    "pnpm run --filter app build",
    "pnpm -w lint",
    "npm -w app test",
    "yarn workspace app test",
    "./node_modules/.bin/eslint src/app.ts",
    "NODE_OPTIONS=--max-old-space-size=8192 pnpm run test",
    "env -u NODE_OPTIONS npm test",
    "env -C /tmp -u FOO tsc --noEmit",
    "env -S tsc --noEmit",
    "env -S 'FOO=1 -u BAR tsc --noEmit'",
    "env --split-string='npm test'",
    "npm test",
    "pnpm run build",
    "yarn lint",
    "vitest run",
    "jest auth.spec.ts",
    "pytest -q",
    "python3 -m pytest tests/",
    "node --test agent/tests/subagent-extensions.test.mjs",
    "node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc --noEmit",
    "node ./node_modules/eslint/bin/eslint.js src/app.ts",
    "node ./node_modules/vitest/vitest.mjs run",
    "go test ./...",
    "cargo check",
    "make build",
    "bash -lc 'npm test'",
    "bash -o pipefail -c 'npm test'",
    "bash -euo pipefail -c 'tsc --noEmit'",
    "bash -euoc pipefail 'tsc --noEmit'",
    "bash -O globstar -c 'npm test'",
    "bash --rcfile /dev/null -c 'tsc --noEmit'",
    "bash -c -- 'npm test'",
    "bash -c - 'tsc --noEmit'",
    "bash +o errexit -c 'tsc --noEmit'",
    "sh -c 'tsc --noEmit'",
    "if true; then npm test; fi",
    "if ! tsc --noEmit; then echo fail; fi",
    "while false; do vitest run; done",
    "{ pytest -q; }",
    'echo "$(vitest run)"',
  ];
  for (const cmd of mustBlock) {
    const res = checkStaticReviewCommand(cmd);
    assert.equal(res.blocked, true, `expected blocked: ${cmd}`);
  }
});

test("static-review-guard still blocks verification commands after ask-mode sandbox wrapping", () => {
  const askToolCall = loadAskModeToolCall();
  let guardToolCall;
  staticReviewGuardExtension({
    on(event, fn) {
      if (event === "tool_call") guardToolCall = fn;
    },
  });

  const event = {
    toolName: "bash",
    input: { command: "npx --yes tsc --noEmit" },
  };
  askToolCall(event);
  const blocked = guardToolCall(event);
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /tsc/i);
  assert.match(blocked.reason, /do not retry or work around/i);

  const envEvent = {
    toolName: "bash",
    input: { command: "env -u NODE_OPTIONS npm test" },
  };
  askToolCall(envEvent);
  const envBlocked = guardToolCall(envEvent);
  assert.equal(envBlocked?.block, true);
  assert.match(envBlocked.reason, /npm test/i);

  const envSplitEvent = {
    toolName: "bash",
    input: { command: "env -S tsc --noEmit" },
  };
  askToolCall(envSplitEvent);
  const envSplitBlocked = guardToolCall(envSplitEvent);
  assert.equal(envSplitBlocked?.block, true);
  assert.match(envSplitBlocked.reason, /tsc/i);

  const contEvent = {
    toolName: "bash",
    input: { command: "npm \\\n test" },
  };
  askToolCall(contEvent);
  const contBlocked = guardToolCall(contEvent);
  assert.equal(contBlocked?.block, true);
  assert.match(contBlocked.reason, /npm test/i);

  const npmAliasEvent = {
    toolName: "bash",
    input: { command: "npm run-script test" },
  };
  askToolCall(npmAliasEvent);
  const npmAliasBlocked = guardToolCall(npmAliasEvent);
  assert.equal(npmAliasBlocked?.block, true);
  assert.match(npmAliasBlocked.reason, /npm test/i);

  const shellOptEvent = {
    toolName: "bash",
    input: { command: "bash -o pipefail -c 'npm test'" },
  };
  askToolCall(shellOptEvent);
  const shellOptBlocked = guardToolCall(shellOptEvent);
  assert.equal(shellOptBlocked?.block, true);
  assert.match(shellOptBlocked.reason, /npm test/i);

  const groupedShellOptEvent = {
    toolName: "bash",
    input: { command: "bash -euo pipefail -c 'tsc --noEmit'" },
  };
  askToolCall(groupedShellOptEvent);
  const groupedShellOptBlocked = guardToolCall(groupedShellOptEvent);
  assert.equal(groupedShellOptBlocked?.block, true);
  assert.match(groupedShellOptBlocked.reason, /tsc/i);

  const singleDashShellEvent = {
    toolName: "bash",
    input: { command: "bash -c - 'tsc --noEmit'" },
  };
  askToolCall(singleDashShellEvent);
  const singleDashShellBlocked = guardToolCall(singleDashShellEvent);
  assert.equal(singleDashShellBlocked?.block, true);
  assert.match(singleDashShellBlocked.reason, /tsc/i);

  const okEvent = {
    toolName: "bash",
    input: { command: "git diff --cached --stat" },
  };
  askToolCall(okEvent);
  assert.equal(guardToolCall(okEvent), undefined);
});

test("checkStaticReviewCommand allows read-only CLIs and quoted search patterns", () => {
  const mustAllow = [
    "git status --short",
    "git -C /Users/nanw/Projects/very/long/repository/path/with/many/segments status",
    "git diff main...HEAD --stat",
    "git merge-base main HEAD",
    "git show HEAD:README.md",
    "git log --oneline -n 10",
    "git tag",
    "rg 'tsc|eslint' package.json",
    'grep -n "if true; then npm test; fi" README.md',
    'grep -n "npm test" README.md',
    "command -v tsc",
    "command -V eslint",
    "twg jira view ENG-15255",
    "twg confluence view 12345 2>&1 | head -n 100",
    "gh pr view 42 --json title,body 2>/dev/null",
    "node -e 'console.log(1 + 1)'",
    "node ./scripts/inspect.mjs --json",
    "ls -la agent/subagent-extensions",
  ];
  for (const cmd of mustAllow) {
    const res = checkStaticReviewCommand(cmd);
    assert.equal(res.blocked, false, `expected allowed: ${cmd}`);
  }
});

test("settings overrides wire static-review-guard, reviewer-policy, and inheritSkills without duplicate sandbox", () => {
  const settings = JSON.parse(
    readFileSync(path.join(repoRoot, "agent", "settings.json"), "utf8"),
  );
  const { reviewer, oracle } = settings.subagents.agentOverrides;
  assert.ok(reviewer.tools.includes("bash"));
  assert.deepEqual(reviewer.subagentOnlyExtensions, [
    "/Users/nanw/.pi/agent/subagent-extensions/static-review-guard.ts",
    "/Users/nanw/.pi/agent/subagent-extensions/reviewer-policy.ts",
  ]);
  assert.deepEqual(oracle.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "contact_supervisor",
  ]);
  assert.deepEqual(oracle.subagentOnlyExtensions, [
    "/Users/nanw/.pi/agent/subagent-extensions/static-review-guard.ts",
  ]);
  for (const role of [
    "scout",
    "delegate",
    "researcher",
    "worker",
    "reviewer",
    "oracle",
    "evidence-auditor",
  ]) {
    assert.equal(
      settings.subagents.agentOverrides[role].inheritSkills,
      true,
      `${role} should inherit skills`,
    );
  }
});

test("applyReviewerPolicy patches bundled reviewer prompt idempotently", () => {
  const bundled = readFileSync(
    path.join(
      repoRoot,
      "agent",
      "npm",
      "node_modules",
      "pi-subagents",
      "agents",
      "reviewer.md",
    ),
    "utf8",
  );
  const patched = applyReviewerPolicy(bundled);

  assert.doesNotMatch(
    patched,
    /Do not use shell commands, mutate the repository/,
  );
  assert.doesNotMatch(
    patched,
    /watchdog_diff` does not inspect committed ranges/,
  );
  assert.match(patched, /Use `bash` only for read-only inspection/);
  assert.match(patched, /sandbox-exec/);
  assert.match(patched, /Never run test suites, typecheck \(`tsc`\)/);
  assert.match(patched, /Anchor investigation to the diff/);
  assert.match(patched, /\[P0\/P1\/P2\] \[classification\] \[kind\]/);
  assert.match(patched, /## Finding classification and kind/);
  assert.match(patched, /## Review ledger/);
  assert.equal(applyReviewerPolicy(patched), patched);

  const gptPatched = applyReviewerPolicy(bundled, {
    modelId: "group/gpt-astra",
  });
  assert.doesNotMatch(gptPatched, /Anchor investigation to the diff/);
  assert.match(gptPatched, /## Finding classification and kind/);

  const claudePatched = applyReviewerPolicy(bundled, {
    modelId: "group/claude-opus",
  });
  assert.match(claudePatched, /Anchor investigation to the diff/);
});
