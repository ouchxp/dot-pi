import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

const EDIT_TOOLS = new Set<string>(["edit", "write", "ast_grep_replace"]);

export default function askModeExtension(pi: ExtensionAPI): void {
  let askModeEnabled = true;
  let toolsBeforeAskMode: string[] | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("ask-mode", askModeEnabled ? "? ASK" : "● EDIT");
  }

  function applyActiveTools(): void {
    if (askModeEnabled) {
      if (toolsBeforeAskMode === undefined) {
        toolsBeforeAskMode = pi.getActiveTools();
      }
      const readOnlyTools = toolsBeforeAskMode.filter(
        (t) => !EDIT_TOOLS.has(t),
      );
      pi.setActiveTools(readOnlyTools);
    } else if (toolsBeforeAskMode !== undefined) {
      pi.setActiveTools(toolsBeforeAskMode);
      toolsBeforeAskMode = undefined;
    }
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
    applyActiveTools();
    updateStatus(ctx);
    persistState();

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
    } else {
      askModeEnabled = lastEntry.data.enabled;
      toolsBeforeAskMode = lastEntry.data.toolsBeforeAskMode;
    }

    applyActiveTools();
    updateStatus(ctx);
  });

  // Inject mode state into system prompt per turn
  pi.on("before_agent_start", (event) => {
    const modeInstruction = askModeEnabled
      ? "\n\n[ASK MODE: ACTIVE]\nYou are in Ask Mode (read-only consultation). You MUST NOT attempt to edit or write files. Answer questions, provide analysis, explain solutions, or read files, but do not execute changes."
      : "\n\n[EDIT MODE: ACTIVE]\nYou are in Edit Mode. File edits and code modifications are allowed.";

    return {
      systemPrompt: event.systemPrompt + modeInstruction,
    };
  });

  // Extra safety guard: block edit/write tool calls if invoked in Ask Mode
  pi.on("tool_call", (event: ToolCallEvent) => {
    if (!askModeEnabled) return undefined;

    if (EDIT_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked: Ask mode is ACTIVE. File edits (${event.toolName}) are disabled. Toggle to EDIT mode (Shift+Tab) to make edits.`,
      };
    }
    return undefined;
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
