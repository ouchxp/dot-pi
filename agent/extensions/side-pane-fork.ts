import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * side-pane-fork: "ask in side chat" for pi.
 *
 * /side [message] (or Alt+/) forks the current conversation into a NEW session
 * running in a split pane of the terminal, leaving the main agent untouched:
 *
 *   - Ghostty (macOS): AppleScript split with a surface configuration
 *   - Orca: `orca terminal split --direction horizontal --command ...`
 *
 * The pane runs `pi --fork <session-file> [message]`, which creates a forked
 * session from the current conversation. With a message, the side chat sends
 * it immediately; without, the editor is restored from the last prompt.
 */

export type TerminalId = "ghostty" | "orca";

export function detectTerminal(
  env: NodeJS.ProcessEnv = process.env,
): TerminalId | null {
  switch ((env.TERM_PROGRAM ?? "").toLowerCase()) {
    case "ghostty":
      return "ghostty";
    case "orca":
      return "orca";
    default:
      return null;
  }
}

/** POSIX single-quote escaping for shell command strings. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface PaneCommandOptions {
  /** Leading argv of the pane command, e.g. [nodeBin, piCliPath] or ["/opt/homebrew/bin/pi"]. */
  launcher: string[];
  sessionFile: string;
  message?: string;
}

/** The shell command the new pane runs: `<launcher> --fork <session-file> [message]`. */
export function buildPaneCommand(opts: PaneCommandOptions): string {
  const parts = [...opts.launcher.map(shq), "--fork", shq(opts.sessionFile)];
  if (opts.message) parts.push(shq(opts.message));
  const shell = process.env.SHELL ?? "/bin/bash";
  // Ghostty wraps the pane command in `exec -l <cmd>`, so a plain trailing `;`
  // is unreachable (exec replaces the shell before it is parsed). Run the fork
  // from a throwaway bash that falls through to an interactive login shell when
  // pi exits, keeping the pane alive (Orca behavior). SIGINT is ignored here so
  // Ctrl+C reaches pi but does not kill the holder before the fallthrough runs.
  //
  // Ghostty spawns pane processes with a scrubbed env (the `env =` config does
  // not reach surface commands), so export a full PATH here - pi's bash tool
  // otherwise sees only ~/.pi/agent/bin and coreutils (head, cut, tr) are missing.
  const fullPath =
    "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin" +
    ":$HOME/.nodenv/shims:$HOME/.nodenv/bin:$HOME/.local/bin:$PATH";
  // double quotes: $HOME / $PATH expand in the pane's bash; no user input lands here
  const script = `trap '' INT; export PATH="${fullPath}"; ${parts.join(" ")}; exec -l ${shq(shell)}`;
  return `${shq("/bin/bash")} -c ${shq(script)}`;
}

/** AppleScript string literal escaping (backslash and double quote). */
function applescriptQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** AppleScript that splits the focused Ghostty surface right, running `command` in the new pane. */
export function buildGhosttyAppleScript(opts: {
  cwd: string;
  command: string;
}): string {
  return [
    `tell application "Ghostty"`,
    `  set cfg to new surface configuration`,
    `  set command of cfg to ${applescriptQuote(opts.command)}`,
    `  set initial working directory of cfg to ${applescriptQuote(opts.cwd)}`,
    `  set currentTerm to focused terminal of selected tab of front window`,
    `  split currentTerm direction right with configuration cfg`,
    `end tell`,
  ].join("\n");
}

/**
 * Resolve the launcher for the side pane.
 *
 * Ghostty runs the pane command via `login -q -flp <user> <shell> --noprofile --norc
 * -c "exec -l <cmd>"`, i.e. a non-interactive shell with a minimal PATH, so pi's
 * `#!/usr/bin/env node` shebang cannot find node. Invoking the running node binary
 * and pi's own script by absolute path avoids PATH entirely.
 */
async function resolveLauncher(pi: ExtensionAPI): Promise<string[] | null> {
  const override = process.env.PI_SIDE_PANE_BIN;
  if (override) return [override];
  const cliPath = process.argv[1];
  if (cliPath) {
    return [process.execPath, resolve(process.cwd(), cliPath)];
  }
  try {
    const res = await pi.exec("which", ["pi"]);
    const bin = res.stdout.trim();
    if (res.code === 0 && bin) return [bin];
  } catch {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orca adapter
// ---------------------------------------------------------------------------

/** Locations the orca CLI is found at when it is not on PATH. */
export function orcaCliCandidates(): string[] {
  return [
    "/usr/local/bin/orca",
    "/opt/homebrew/bin/orca",
    `${homedir()}/.local/bin/orca`,
    "/Applications/Orca.app/Contents/Resources/bin/orca",
    `${homedir()}/Applications/Orca.app/Contents/Resources/bin/orca`,
  ];
}

/**
 * Resolve the orca CLI: `ORCA_CLI_COMMAND` env override first (Orca's own
 * convention, exported for managed WSL sessions), then PATH, then known
 * install locations (Finder-launched apps and non-Orca shells often lack
 * the CLI on PATH entirely).
 */
export async function resolveOrcaCli(pi: ExtensionAPI): Promise<string | null> {
  const override = process.env.ORCA_CLI_COMMAND;
  if (override) return override;
  try {
    const res = await pi.exec("which", ["orca"]);
    const bin = res.stdout.trim();
    if (res.code === 0 && bin) return bin;
  } catch {
    // fall through to known locations
  }
  for (const candidate of orcaCliCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface OrcaTerminalInfo {
  handle?: string;
  worktreePath?: string;
  [key: string]: unknown;
}

/**
 * Pick the Orca terminal pi is running in: the terminal whose worktree path
 * contains the current cwd (longest prefix wins).
 */
export function findOrcaTerminalForCwd(
  terminals: OrcaTerminalInfo[],
  cwd: string,
): string | null {
  let best: { handle: string; len: number } | null = null;
  for (const terminal of terminals) {
    const rawWorktree = terminal.worktreePath;
    const handle = terminal.handle;
    if (!rawWorktree || !handle) continue;
    const worktree = rawWorktree.replace(/\/+$/, "");
    if (cwd === worktree || cwd.startsWith(`${worktree}/`)) {
      if (!best || worktree.length > best.len) {
        best = { handle, len: worktree.length };
      }
    }
  }
  return best ? best.handle : null;
}

/**
 * Parse an orca CLI result. The CLI reports errors as JSON with exit code 0
 * (`{ ok: false, error: { code, message } }`), and some failures print plain
 * text instead; some versions exit non-zero with the error on stdout.
 */
export function parseOrcaResult(
  stdout: string,
  code: number,
): { ok: boolean; error?: string } {
  let parsed: { ok?: unknown; error?: unknown } | null = null;
  try {
    parsed = JSON.parse(stdout) as { ok?: unknown; error?: unknown };
  } catch {
    // not JSON
  }
  if (parsed && typeof parsed === "object" && "ok" in parsed) {
    if (parsed.ok) return { ok: true };
    const err = parsed.error;
    const message =
      err && typeof err === "object" && "message" in err
        ? (err as { message: unknown }).message
        : err;
    return { ok: false, error: String(message ?? "orca error") };
  }
  const text = stdout.trim();
  if (code !== 0 || /stale|error|failed|not found|usage:/i.test(text)) {
    return {
      ok: false,
      error: text || (code === 0 ? "orca error" : `exit code ${code}`),
    };
  }
  return { ok: true };
}

/** Split the terminal pi runs in; run `command` (a shell string) in the new pane. */
async function splitOrca(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  command: string,
): Promise<{ ok: boolean; error?: string }> {
  const cli = await resolveOrcaCli(pi);
  if (!cli) {
    return {
      ok: false,
      error:
        "orca CLI not found (PATH, /opt/homebrew/bin, /usr/local/bin, Orca.app). Set ORCA_CLI_COMMAND.",
    };
  }

  // Target the terminal pi runs in explicitly. The unqualified "active terminal"
  // resolution is unreliable when the CLI is spawned from inside pi.
  let handle: string | undefined;
  const listRes = await pi.exec(cli, ["terminal", "list", "--json"]);
  if (listRes.code === 0) {
    try {
      const data = JSON.parse(listRes.stdout) as {
        result?: { terminals?: OrcaTerminalInfo[] };
      };
      handle =
        findOrcaTerminalForCwd(data?.result?.terminals ?? [], ctx.cwd) ??
        undefined;
    } catch {
      // fall back to the unqualified split
    }
  }

  const args = ["terminal", "split", "--direction", "vertical", "--json"];
  // Orca's --direction refers to the divider's orientation (verified on 1.4.184):
  // "horizontal" = stacked top/bottom (full width), "vertical" = side-by-side
  // left/right (full height). The docs claim the opposite; the pane geometry
  // (`tput lines/cols`) confirms the divider interpretation.
  if (handle) args.push("--terminal", handle);
  args.push("--command", `cd ${shq(ctx.cwd)} && ${command}`);
  const res = await pi.exec(cli, args);
  const parsed = parseOrcaResult(res.stdout, res.code);
  if (!parsed.ok) {
    const stderr = res.stderr.trim();
    return {
      ok: false,
      error: stderr
        ? `${parsed.error} (${stderr})`
        : (parsed.error ?? "orca error"),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ghostty adapter
// ---------------------------------------------------------------------------

/** Split the focused Ghostty surface right; run `command` in the new pane. */
async function splitGhostty(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  command: string,
): Promise<{ ok: boolean; error?: string }> {
  const script = buildGhosttyAppleScript({ cwd: ctx.cwd, command });
  const res = await pi.exec("osascript", ["-e", script]);
  if (res.code !== 0) {
    return { ok: false, error: res.stderr.trim() || `exit code ${res.code}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Side chat flow
// ---------------------------------------------------------------------------

async function openSideChat(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  message?: string,
): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    ctx.ui.notify(
      "Side chat needs a saved session; ephemeral sessions cannot be forked.",
      "error",
    );
    return;
  }

  const terminal = detectTerminal();
  if (!terminal) {
    ctx.ui.notify(
      `Terminal not supported for side pane (TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "unset"}). ` +
        "side-pane-fork supports Ghostty and Orca.",
      "error",
    );
    return;
  }
  if (terminal === "ghostty" && process.platform !== "darwin") {
    ctx.ui.notify(
      "Ghostty splits require macOS (AppleScript). On Linux, use Orca or a multiplexer.",
      "error",
    );
    return;
  }

  const launcher = await resolveLauncher(pi);
  if (!launcher) {
    ctx.ui.notify(
      "Could not resolve the pi launcher for the side pane. Set PI_SIDE_PANE_BIN to the pi executable path.",
      "error",
    );
    return;
  }
  const command = buildPaneCommand({
    launcher,
    sessionFile: resolve(ctx.cwd, sessionFile),
    message,
  });

  let result: { ok: boolean; error?: string };
  try {
    result =
      terminal === "ghostty"
        ? await splitGhostty(pi, ctx, command)
        : await splitOrca(pi, ctx, command);
  } catch (err) {
    result = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!result.ok) {
    ctx.ui.notify(
      `${terminal === "ghostty" ? "Ghostty" : "Orca"} split failed: ${result.error ?? "unknown error"}`,
      "error",
    );
    return;
  }

  const preview = message
    ? message.length > 60
      ? `${message.slice(0, 60)}…`
      : message
    : "";
  ctx.ui.notify(
    preview
      ? `Side chat opened: "${preview}"`
      : "Side chat opened (fork of current session)",
    "info",
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("side", {
    description:
      "Open a side chat: fork the current conversation into a split pane (Ghostty/Orca)",
    handler: async (args, ctx) => {
      const message = args?.trim() || undefined;
      await openSideChat(pi, ctx, message);
    },
  });

  pi.registerShortcut("super+shift+s", {
    description:
      "Open a side chat: fork the current conversation into a split pane",
    handler: (ctx) => openSideChat(pi, ctx),
  });
}
