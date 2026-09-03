/**
 * Enforce Permissions Extension
 *
 * In-process second enforcement layer mirroring the deny rules in
 * ~/.pi/agent/pi-permissions.jsonc. The permissions file remains the primary
 * gate; this extension hard-blocks the same commands and paths at the
 * tool_call event so the deny rules stay enforced even if the permissions
 * file is edited or removed.
 *
 * Deny rules mirrored:
 *   - bash: git add/commit/push/pull/checkout/restore/reset/clean/stash/rebase/
 *     merge/cherry-pick/revert/apply/am, git branch -d/-D, rm, rmdir, trash
 *   - tools: write/edit under ~/.pi/agent/npm/node_modules/pi-subagents
 *
 * The "ask" rules (.env reads, doom_loop, external_directory) are
 * intentionally left to the permissions file: they are prompts, not hard
 * blocks, and some (doom_loop, external_directory) are not tool calls this
 * extension can observe.
 *
 * Pattern semantics: a command is blocked when "git <op>" (or rm/rmdir/trash)
 * appears as its own command invocation — at the start of the command string
 * or right after a separator (; && || | ( ), optionally with git global
 * options in between (e.g. "git -C /repo push"). This matches the intent of
 * the permissions file's glob rules while avoiding its accidental substring
 * matches (e.g. "xterm x" or "git status && echo add"). The op is matched
 * as a whole git subcommand word; the negative lookahead after it keeps
 * `git stash list` / `git stash show` (read-only) allowed. Hyphenated
 * plumbing commands ("git commit-tree", "git checkout-index") and
 * lookalike flags/paths are not treated as ops.
 *
 * Design notes for this regex (see the matching spec tests at the bottom):
 * - git may carry global options before the subcommand ("git -C /repo push"),
 *   and only flags (starting with "-") may appear before the op; value-taking
 *   flags (-C, --git-dir, --work-tree, --namespace, -c, --exec-path) may be
 *   followed by their value token.
 * - A subcommand is an op only when it is the FIRST non-flag token after
 *   "git". Read-only commands whose later args contain op-named paths/refs
 *   ("git show am.ts", "git log --grep='I am here'") never match, because the
 *   op cannot be reached past the read-only subcommand.
 * - The word boundary after the op blocks hyphenated plumbing variants
 *   ("git commit-tree", "git checkout-index", "git merge-base") and any
 *   op-prefixed lookalike ("git pull-request" — not a real git command) — the
 *   safe direction for a deny list. Known limitation: quoted or unusual shell
 *   tokenization is modeled only for simple '...'/"..." values; a mutation
 *   hidden behind exotic quoting may not match here (the permissions file
 *   remains the primary gate).
 * - "git stash list|show ..." is read-only and stays allowed, while
 *   "git stash <anything else>" stays denied.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

type BashDenyRule = {
  pattern: RegExp;
  label: (match: RegExpExecArray) => string;
};

const BASH_DENY_RULES: BashDenyRule[] = [
  {
    pattern:
      /(^|[;&|()\s])\s*git((?:\s+(?:-C|--git-dir|--work-tree|--namespace|-c|--exec-path)\s+(?:[^\s|;&\\'"]+|'[^']*'|"[^"]*")+|\s+--[^\s|;&\\]+|\s+-[^\s|;&\\]+)*)\s+(?<op>add|commit|push|pull|checkout|restore|reset|clean|stash(?!\s+(?:list|show)(?![-\w]))|rebase|merge|cherry-pick|revert|apply|am)\b/i,
    label: (match) => `git ${match.groups?.op ?? "mutation"}`,
  },
  {
    pattern: /(^|[;&|()\s])\s*git(\s+[^\s|;&\\]*)*\s+branch\s+-[dD]\b/,
    label: () => "git branch -d/-D",
  },
  { pattern: /(^|[;&|()\s])\s*rm(\s+|$)/, label: () => "rm" },
  { pattern: /(^|[;&|()\s])\s*rmdir(\s+|$)/, label: () => "rmdir" },
  { pattern: /(^|[;&|()\s])\s*trash(\s+|$)/, label: () => "trash" },
];

// write/edit deny rule from the permissions file:
// "write:/Users/nanw/.pi/agent/npm/node_modules/pi-subagents" and children.
const PROTECTED_PREFIX = "/Users/nanw/.pi/agent/npm/node_modules/pi-subagents";

function isProtectedPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "");
  return (
    normalized === PROTECTED_PREFIX ||
    normalized.startsWith(`${PROTECTED_PREFIX}/`)
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (isToolCallEventType("bash", event)) {
      const command = event.input.command;
      for (const { pattern, label } of BASH_DENY_RULES) {
        const match = pattern.exec(command);
        if (match) {
          return {
            block: true,
            reason: `Blocked by enforce-permissions extension (deny rule "${label(match)}"): ${command}`,
          };
        }
      }
      return undefined;
    }

    if (
      isToolCallEventType("write", event) ||
      isToolCallEventType("edit", event)
    ) {
      const path = event.input.path;
      if (isProtectedPath(path)) {
        return {
          block: true,
          reason: `Blocked by enforce-permissions extension (protected path): ${path}`,
        };
      }
      return undefined;
    }

    return undefined;
  });
}
