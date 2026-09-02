/**
 * FF Tool Preference Extension
 *
 * Guides the agent toward `ffgrep`/`fffind` for keyword/name lookups instead
 * of plain bash `grep`/`rg`/`fd`/`find`, per the global AGENTS.md tool rule.
 *
 * Design:
 *  - Detect a pure standalone lookup: a grep-family binary as the FIRST token
 *    with nothing piping/redirecting/capturing output (those are legit uses).
 *  - Count them per session. After THREE since the last steer, send a
 *    non-blocking steer telling the agent to use ffgrep/fffind. Threshold
 *    keeps isolated greps quiet and only flags a pattern.
 *  - The steer goes through pi's own message channel (`deliverAs: "steer"`),
 *    which is delivered after the current tool calls and before the next LLM
 *    call — the model sees it in context, and stdout/stderr stay 100% pure.
 *  - Counter clears on each steer (not per turn), so the habit check is
 *    per-session with feedback windows between steers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const SEARCH_BINARY = /^(grep|rg|ag|ack|find|fd)$/;
const THRESHOLD = 3;
const STEER_MESSAGE =
 "[ff-tool-preference] You have used plain bash grep/find for a standalone lookup several times this session. Use ffgrep/fffind instead for keyword/name lookups.";

let pureCount = 0;

// True when the command is a pure standalone lookup: a grep-family binary is
// the FIRST token and nothing pipes, redirects, or captures output.
function isPureLookup(command: string): boolean {
 const trimmed = command.trim();
 if (!trimmed) return false;
 if (/[|&;<>`]|\$\(/.test(trimmed)) return false;
 const firstToken = trimmed.split(/\s+/)[0].split("/").pop() ?? "";
 return SEARCH_BINARY.test(firstToken);
}

export default function (pi: ExtensionAPI) {
 pi.on("tool_call", (event) => {
  if (!isToolCallEventType("bash", event)) return undefined;
  const command = event.input?.command;
  if (typeof command !== "string") return undefined;
  if (!isPureLookup(command)) return undefined;

  pureCount += 1;
  if (pureCount >= THRESHOLD) {
   // Session-level: clear the counter on each steer so a fresh window
   // starts after feedback, rather than nagging on every grep forever.
   pureCount = 0;
   pi.sendUserMessage(STEER_MESSAGE, { deliverAs: "steer" });
  }
  return undefined;
 });
}
