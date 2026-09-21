import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const EDIT_TOOLS = new Set<string>(["edit", "write", "ast_grep_replace"]);

// Agents that may write. Every other subagent child starts read-only, which is
// the safe direction: a writer agent has to be added here deliberately. The
// aliases mirror the worker agent's declared aliases; the -writer suffix covers
// the external CLI writer agents. To restrict Ask Mode to named read-only
// agents instead, invert this check to an allowlist of those names.
const WRITE_CAPABLE_AGENTS = new Set<string>([
  "worker",
  "delegate",
  "developer",
  "coder",
  "implementer",
  "develop",
]);

function isWriteCapableAgent(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return WRITE_CAPABLE_AGENTS.has(normalized) || normalized.endsWith("-writer");
}

/**
 * Which agents this process is running. A child session gets no agent env var
 * and, when spawned fresh, no session entries naming it, so the identity comes
 * from the launch the subagent runner writes for its own run: the runner passes
 * its config path in argv, that path names the run, and the run's status.json
 * records every step's agent. Undefined means "not a subagent child, or the
 * launch could not be read", which keeps the read-only default.
 */
function launchedAgents(): string[] | undefined {
  if (process.env.PI_SUBAGENT_CHILD !== "1") return undefined;

  const cfgPath = process.argv.find((arg) => /(^|\/)async-cfg-[^/]+\.json$/.test(arg));
  if (!cfgPath) return undefined;
  const runId = path.basename(cfgPath).replace(/^async-cfg-/, "").replace(/\.json$/, "");

  // status.json is written before the child session starts; the config itself is
  // a fallback for the moment before that, and is deleted once the run is up.
  const candidates = [
    path.join(path.dirname(cfgPath), "async-subagent-runs", runId, "status.json"),
    cfgPath,
  ];

  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf-8")) as {
        agent?: unknown;
        steps?: Array<{ agent?: unknown }>;
      };
      const names = [raw.agent, ...(raw.steps ?? []).map((step) => step?.agent)].filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      );
      if (names.length > 0) return names;
    } catch {
      // Try the next candidate; an unreadable launch keeps the read-only default.
    }
  }
  return undefined;
}

// Read-only OS sandbox profile (SBPL) applied to every bash command in Ask Mode.
// Denies all file-write syscalls at the kernel; allows only temp dirs, /dev/null
// and /dev/fd so read commands, git status/diff/log and test infra still work.
// This is the enforcement layer: no interpreter (python/node/tee/printf/base64)
// can bypass a kernel deny, so Ask Mode's read-only guarantee does not depend on
// the model respecting the system prompt or on deny-list pattern coverage.
// ~/.mycli.log and ~/.mycli_history are the two explicit file exceptions:
// mycli appends its own log and history there and is otherwise a read-only client.
const MYCLI_WRITE_PATHS = [".mycli.log", ".mycli_history"].map((name) =>
  path.join(os.homedir(), name),
);
const ASK_MODE_SANDBOX_PROFILE =
  "(version 1)" +
  "(allow default)" +
  "(deny file-write*)" +
  '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (subpath "/dev/fd") ' +
  `${MYCLI_WRITE_PATHS.map((p) => `(literal ${JSON.stringify(p)})`).join(" ")})`;

function sandboxShellQuote(command: string): string {
  // Wrap for single-quoted /bin/bash -c argument inside the sandbox-exec arg;
  // escapes embedded single quotes the POSIX way so heredocs/nested quotes pass
  // through intact to the inner bash.
  return "'" + command.replace(/'/g, "'\\''") + "'";
}

// When a sandboxed bash command fails with a write-denial, remind the model it
// is in Ask Mode and refocus it on the mode's job: investigate, analyze, and
// explain findings — not prepare or request edits. The model otherwise sees
// only "Operation not permitted" and may drift into edit-planning or retry
// loops; this reminder returns it to read-only research posture.
const ASK_MODE_DENIAL_HINT =
  "\n\n[REMINDER: Ask Mode is ACTIVE — you are in read-only research/consultation. " +
  "Your job right now is to investigate the issue, trace the relevant code, and report findings, " +
  "root cause, and recommendations to the user. The command above was denied by the Ask Mode " +
  "read-only sandbox; every file-write attempt will fail until the mode is switched, so do not retry " +
  "writes or seek workarounds. Stay in analysis and explanation. If the user eventually asks you to apply a change, " +
  "tell them the mode must be switched to EDIT (Shift+Tab) first.]";

// Denial signals: kernel write errors and common interpreter write-denial
// traces, matched against the full command + output text. No-match is benign
// (grep returns exit 1 with empty output) and must not trigger the reminder.
function isWriteDenial(text: string): boolean {
  return /operation not permitted|permission denied|EACCES|EPERM|read-only file system|cannot create|failed to open stream|unable to write|not permitted|EBADF|EROFS/i.test(
    text,
  );
}

export default function askModeExtension(pi: ExtensionAPI): void {
  let askModeEnabled = true;
  let toolsBeforeAskMode: string[] | undefined;
  // True once the mode comes from a persisted toggle instead of the default, so
  // an explicit choice is never overridden by the agent-based default below.
  let modeExplicit = false;
  let childWriteAccess: boolean | undefined;

  /**
   * A launch runs its child with every one of its agents, and the mode is
   * session-wide, so a mixed chain stays read-only. Resolved once, then reused.
   */
  function resolveChildWriteAccess(): boolean | undefined {
    if (childWriteAccess === undefined) {
      const agents = launchedAgents();
      if (agents) childWriteAccess = agents.every(isWriteCapableAgent);
    }
    return childWriteAccess;
  }

  // Subagent sessions start in Ask Mode by default, except when the agent they
  // run is allowed to write. Called on session start and again on each agent
  // start, because the launch status may not be on disk yet at session start.
  function applyChildModeDefault(): void {
    if (modeExplicit) return;
    const writeAccess = resolveChildWriteAccess();
    if (writeAccess === undefined) return;
    askModeEnabled = !writeAccess;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    // 38;2;255;255;0m = TrueColor Pure Vibrant Yellow (#FFFF00), 38;2;0;255;100m = TrueColor Bright Green
    const askText = "\x1b[1;38;2;255;255;0m? ASK\x1b[0m";
    const editText = "\x1b[1;38;2;0;255;100m● EDIT\x1b[0m";
    ctx.ui.setStatus("ask-mode", askModeEnabled ? askText : editText);
  }

  function applyActiveTools(): void {
    // Intentional no-op: tools stay active in both modes. In Ask Mode the
    // tool_call guard below blocks edit/write calls with an explicit Ask Mode
    // reminder instead of the tools being missing from the model's toolset.
    // A removed tool made the model improvise shell-based writes (the
    // python-heredoc incident); a blocked one just redirects the model to ask
    // the user for EDIT mode. toolsBeforeAskMode is kept only for persisted
    // entry compatibility; the tool list is never stripped.
    void toolsBeforeAskMode;
  }

  function persistState(): void {
    pi.appendEntry("ask-mode", {
      enabled: askModeEnabled,
      toolsBeforeAskMode,
    });
  }

  function toggleAskMode(ctx: ExtensionContext, forceState?: boolean): void {
    const nextState = forceState === undefined ? !askModeEnabled : forceState;
    if (nextState === askModeEnabled) return;

    askModeEnabled = nextState;
    modeExplicit = true;
    applyActiveTools();
    updateStatus(ctx);
    persistState();

    pi.sendMessage(
      {
        customType: "ask-mode-boundary",
        content: askModeEnabled
          ? "[MODE: ASK] Switched to ASK mode — read-only research. Do not attempt edits."
          : "[MODE: EDIT] Switched to EDIT mode — edits allowed. Any prior assistant messages telling the user to press Shift+Tab are STALE; do NOT repeat them. Proceed directly with the requested edits.",
        display: true,
      },
      { triggerTurn: false },
    );

    if (ctx.hasUI) {
      ctx.ui.notify(
        askModeEnabled
          ? ctx.ui.theme.fg("warning", "● Switched to ASK mode")
          : "● Switched to EDIT mode",
        "info",
      );
    }
  }

  // Session start: restore persisted state or default to Ask mode
  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const lastEntry = entries
      .filter(
        (e: { type: string; customType?: string }) =>
          e.type === "custom" && e.customType === "ask-mode",
      )
      .pop() as
      | { data?: { enabled?: boolean; toolsBeforeAskMode?: string[] } }
      | undefined;

    if (lastEntry?.data?.enabled === undefined) {
      askModeEnabled = true;
      toolsBeforeAskMode = undefined;
      modeExplicit = false;
    } else {
      askModeEnabled = lastEntry.data.enabled;
      toolsBeforeAskMode = lastEntry.data.toolsBeforeAskMode;
      modeExplicit = true;
    }

    applyChildModeDefault();
    applyActiveTools();
    updateStatus(ctx);
  });

  // Inject mode state into system prompt per turn
  pi.on("before_agent_start", (event) => {
    applyChildModeDefault();

    const modeInstruction = askModeEnabled
      ? '\n\n[ASK MODE: ACTIVE]\nYou are in Ask Mode: a read-only research and consultation mode. Your job is to investigate, analyze, trace, and explain — dig into the issue, find the root cause, and report findings and recommendations clearly. You MUST NOT attempt to edit or write files, and you MUST NOT prepare edit plans or ask the user to unlock editing unless they explicitly ask you to apply a change.\n\nENFORCEMENT: The edit/write tools stay visible but every call is blocked with an explicit reminder, and every bash command runs inside an OS-level read-only sandbox (sandbox-exec). File writes of ANY kind — shell redirection, python/node/perl file writes, tee, base64 — are denied by the kernel, not by policy. Do not attempt shell-based edits or writes; they fail with "Operation not permitted". Do not seek workarounds; blocked attempts are expected and simply tell you to continue in research mode. Stay read-only and productive with analysis. If the user explicitly asks for an actual change, tell them the mode must be switched to EDIT (Shift+Tab) first.'
      : "\n\n[EDIT MODE: ACTIVE]\nYou are in Edit Mode. File edits and code modifications are allowed. Any prior assistant messages telling the user to press Shift+Tab to switch to EDIT are STALE — the switch already happened. Do NOT mention Shift+Tab, Ask Mode, or read-only restrictions. Proceed directly with the user's requested edits using edit/write tools.";

    return {
      systemPrompt: event.systemPrompt + modeInstruction,
    };
  });

  // Keep only the newest mode-boundary message in LLM context so repeated
  // toggles do not accumulate stale mode lines. History on disk untouched.
  pi.on("context", (event) => {
    const messages = event.messages as Array<{ customType?: string }>;
    let lastIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.customType === "ask-mode-boundary") {
        lastIdx = i;
        break;
      }
    }
    if (lastIdx === -1) return;
    const filtered = event.messages.filter((m, idx) => {
      const msg = m as { customType?: string };
      return msg.customType !== "ask-mode-boundary" || idx === lastIdx;
    });
    if (filtered.length === event.messages.length) return;
    return { messages: filtered };
  });

  // Extra safety guard: block edit/write tool calls if invoked in Ask Mode,
  // and sandbox every bash command read-only at the OS level.
  pi.on("tool_call", (event: ToolCallEvent) => {
    if (!askModeEnabled) return undefined;

    if (EDIT_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked: Ask Mode is ACTIVE — read-only research/consultation. ${event.toolName} edits are disabled; your job now is to investigate and report findings, not change files. Do not plan edits or ask to be unlocked; simply continue the analysis. Do not attempt workarounds (python heredocs, tee, redirects) — the OS sandbox denies all file writes. Only if the user explicitly asks you to apply a change, tell them the mode must be switched to EDIT (Shift+Tab) first.`,
      };
    }

    if (event.toolName === "bash") {
      const command = event.input.command as string;
      event.input.command = `/usr/bin/sandbox-exec -p ${sandboxShellQuote(ASK_MODE_SANDBOX_PROFILE)} /bin/bash -c ${sandboxShellQuote(command)}`;
    }
    return undefined;
  });

  // When a sandboxed bash command was denied a write, append the Ask Mode
  // reminder to the result so the model sees WHY it failed and stops retrying.
  pi.on("tool_result", (event) => {
    if (!askModeEnabled) return undefined;
    if (event.toolName !== "bash") return undefined;
    // Only real failures (nonzero exit) can be denials. Benign reads that merely
    // print denial words (git diff of this file, grep for an error phrase) exit
    // 0 and must not trigger the reminder.
    if (!event.isError) return undefined;

    const text = [
      typeof event.input.command === "string" ? event.input.command : "",
      ...event.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text),
    ].join("\n");

    if (!isWriteDenial(text)) return undefined;

    return {
      content: [
        ...event.content.filter((c) => c.type !== "text"),
        ...event.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => ({
            type: "text" as const,
            text: c.text + ASK_MODE_DENIAL_HINT,
          })),
        // Ensure a plain-text entry exists if the original result was all
        // non-text content (e.g. an image), so the hint is always visible.
        ...(event.content.some((c) => c.type === "text")
          ? []
          : [{ type: "text" as const, text: ASK_MODE_DENIAL_HINT }]),
      ],
      isError: event.isError,
    };
  });

  // Shift+Tab shortcut to toggle
  pi.registerShortcut("shift+tab", {
    description: "Toggle between ASK and EDIT mode",
    handler: (ctx) => {
      toggleAskMode(ctx);
    },
  });

  // /ask command to check or toggle
  pi.registerCommand("ask", {
    description: "Toggle or set mode (/ask, /ask on, /ask off)",
    handler: (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "ask") {
        toggleAskMode(ctx, true);
      } else if (arg === "off" || arg === "edit") {
        toggleAskMode(ctx, false);
      } else {
        toggleAskMode(ctx);
      }
    },
  });
}
