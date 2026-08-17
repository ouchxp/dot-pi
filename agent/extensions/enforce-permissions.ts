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
 *   - bash: git add/commit/push/checkout/restore/reset/clean/stash/rebase/
 *     merge/cherry-pick/revert, git branch -d/-D, rm, rmdir, trash
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
 * matches (e.g. "xterm x" or "git status && echo add"). The word boundary
 * after the op also catches plumbing variants the file's space-based globs
 * miss (e.g. "git commit-tree", "git checkout-index") — the safe direction.
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
      /(^|[;&|()\s])\s*git(\s+[^\s|;&\\]*)*\s+(?<op>add|commit|push|checkout|restore|reset|clean|stash|rebase|merge|cherry-pick|revert)\b/i,
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
