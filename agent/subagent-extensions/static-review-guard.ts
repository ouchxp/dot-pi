/**
 * Subagent-only static-review guard for `reviewer` and `oracle`.
 *
 * Separate from filesystem sandboxing (`ask-mode.ts`): blocks heavy
 * read-only verification commands (test suites, typecheckers like `tsc`,
 * linters, formatters, and build tools) so reviewers stay static and do not
 * spin up multi-GB compiler/test processes.
 *
 * Uses a quote-aware tokenizer (linear time, no backtracking regexes) so
 * search arguments like `rg 'tsc|eslint' package.json` are never blocked,
 * while wrappers (`npx --yes tsc`, `pnpm --filter app build`,
 * `bash -lc 'npm test'`) are caught.
 *
 * Does NOT hook `before_agent_start`, keeping `oracle` fork prompt cache intact.
 * Loaded only via `subagentOnlyExtensions`; never auto-loaded in the parent.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const STATIC_GUIDANCE =
  "Review statically from code and existing test files; do not retry or work around this restriction. Report verification commands for the parent to run.";

const VERIFICATION_BINS = new Set([
  "tsc",
  "vue-tsc",
  "tsgo",
  "eslint",
  "oxlint",
  "biome",
  "prettier",
  "jest",
  "vitest",
  "mocha",
  "ava",
  "tap",
  "jasmine",
  "karma",
  "pytest",
  "unittest",
  "nose2",
  "playwright",
  "cypress",
  "webpack",
  "vite",
  "rollup",
  "esbuild",
  "tsup",
  "turbo",
  "nx",
  "gradle",
  "mvn",
  "mypy",
  "pyright",
  "ruff",
  "flake8",
  "pylint",
  "black",
  "rubocop",
  "rspec",
  "phpstan",
  "phpunit",
  "make",
]);

const PM_BINS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PM_COMMON_VALUE_FLAGS = new Set([
  "--filter",
  "-F",
  "-C",
  "--dir",
  "--prefix",
  "--cwd",
  "--workspace",
  "--config",
]);
const NPM_VALUE_FLAGS = new Set([...PM_COMMON_VALUE_FLAGS, "-w", "--package"]);
const PM_BLOCKED_SCRIPT =
  /^(?:test|t|build|lint|typecheck|type-check|check|format|prettier|eslint|tsc|e2e|coverage|verify|generate|codegen)(?::|$)/i;

const GO_BLOCKED = new Set(["test", "build", "vet", "generate", "install", "run"]);
const CARGO_BLOCKED = new Set(["test", "build", "check", "clippy", "fmt", "run", "bench"]);
const DENO_BUN_BLOCKED = new Set(["test", "check", "lint", "fmt", "build"]);
const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_LEADING_KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "{",
]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

type GuardResult =
  | { blocked: true; label: string; reason: string }
  | { blocked: false };

function block(label: string): GuardResult {
  return {
    blocked: true,
    label,
    reason: `Blocked by static-review-guard ("${label}"): ${STATIC_GUIDANCE}`,
  };
}

/**
 * Split a shell command into top-level segments (on unquoted `;`, `&`, `|`, `\n`, `(`, `)`)
 * and also collect any `$(...)` or backtick command substitutions for inspection.
 */
function extractSegments(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }

    if (ch === "\\" && i + 1 < input.length) {
      if (input[i + 1] === "\r" && input[i + 2] === "\n") {
        current += "\\\r\n";
        i += 2;
        continue;
      }
      current += ch + input[i + 1];
      i++;
      continue;
    }

    if (ch === "$" && input[i + 1] === "(") {
      const end = findMatchingParen(input, i + 2);
      if (end > i + 2) {
        const inner = input.slice(i + 2, end);
        segments.push(...extractSegments(inner));
        current += " ";
        i = end;
        continue;
      }
    }

    if (ch === "`") {
      const end = input.indexOf("`", i + 1);
      if (end > i + 1) {
        segments.push(...extractSegments(input.slice(i + 1, end)));
        current += " ";
        i = end;
        continue;
      }
    }

    if (quote === '"') {
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function findMatchingParen(input: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tokenizeWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      if (segment[i + 1] === "\n") {
        i++;
        continue;
      }
      if (segment[i + 1] === "\r" && segment[i + 2] === "\n") {
        i += 2;
        continue;
      }
      current += segment[i + 1];
      hasToken = true;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        words.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }

  if (hasToken) words.push(current);
  return words;
}

function skipFlags(
  args: string[],
  valueFlags: ReadonlySet<string> = new Set(),
): number {
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === "--") return i + 1;
    if (!token.startsWith("-") || token === "-") return i;
    const flagName = token.split("=", 1)[0];
    if (!token.includes("=") && valueFlags.has(flagName)) {
      i += 2;
      continue;
    }
    i++;
  }
  return i;
}

const ENV_VALUE_FLAGS = new Set([
  "-u",
  "--unset",
  "-C",
  "--chdir",
  "-P",
]);

const EXEC_VALUE_FLAGS = new Set(["-a"]);
const EMPTY_VALUE_FLAGS = new Set<string>();

function valueFlagsForPrefix(base: string): ReadonlySet<string> {
  if (base === "env") return ENV_VALUE_FLAGS;
  if (base === "exec") return EXEC_VALUE_FLAGS;
  return EMPTY_VALUE_FLAGS;
}

function expandEnvSplitString(
  words: string[],
  i: number,
): { expanded: string[]; consumed: number } | undefined {
  const token = words[i];
  if (token === "-S" || token === "--split-string") {
    if (words[i + 1] === undefined) return undefined;
    return { expanded: tokenizeWords(words[i + 1]), consumed: 2 };
  }
  if (token.startsWith("--split-string=")) {
    return { expanded: tokenizeWords(token.slice("--split-string=".length)), consumed: 1 };
  }
  if (token.startsWith("-S") && token.length > 2) {
    return { expanded: tokenizeWords(token.slice(2)), consumed: 1 };
  }
  return undefined;
}

function stripPrefixArgs(words: string[], base: string): string[] {
  const valueFlags = valueFlagsForPrefix(base);
  let remaining = words.slice(1);
  let i = 0;
  let splitCount = 0;

  while (i < remaining.length) {
    const token = remaining[i];
    if (token === "--") return remaining.slice(i + 1);
    if (base === "env") {
      if (ENV_ASSIGNMENT.test(token)) {
        i++;
        continue;
      }
      if (splitCount < 4) {
        const split = expandEnvSplitString(remaining, i);
        if (split) {
          splitCount++;
          remaining = [
            ...remaining.slice(0, i),
            ...split.expanded,
            ...remaining.slice(i + split.consumed),
          ];
          continue;
        }
      }
    }
    if (!token.startsWith("-") || token === "-") return remaining.slice(i);
    if (base === "command" && /^-[^-]*[vV]/.test(token)) {
      // `command -v <bin>` / `command -V <bin>` only inspects PATH; it never runs `<bin>`.
      return [];
    }
    const flagName = token.split("=", 1)[0];
    if (!token.includes("=") && valueFlags.has(flagName)) {
      i += 2;
      continue;
    }
    i++;
  }
  return [];
}

function stripLeadingPrefixes(words: string[]): string[] {
  let current = words;
  while (current.length > 0) {
    const w = current[0];
    if (SHELL_LEADING_KEYWORDS.has(w) || ENV_ASSIGNMENT.test(w)) {
      current = current.slice(1);
      continue;
    }
    const base = path.posix.basename(w);
    if (base === "env" || base === "command" || base === "exec" || base === "time") {
      current = stripPrefixArgs(current, base);
      continue;
    }
    break;
  }
  return current;
}

const NPX_VALUE_FLAGS = new Set(["-p", "--package"]);
const NODE_VALUE_FLAGS = new Set([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "-C",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--input-type",
  "--title",
  "--redirect-warnings",
  "--diagnostic-dir",
  "--heapsnapshot-signal",
  "--inspect-port",
  "--max-old-space-size",
]);

function checkCallFlagPayloads(
  args: string[],
  otherValueFlags: ReadonlySet<string>,
): GuardResult {
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (token === "--" || !token.startsWith("-") || token === "-") break;
    if (token === "-c" || token === "--call") {
      if (args[i + 1] !== undefined) {
        const res = checkStaticReviewCommand(args[i + 1]);
        if (res.blocked) return res;
      }
      i += 2;
      continue;
    }
    if (token.startsWith("--call=") || token.startsWith("-c=")) {
      const payload = token.startsWith("--call=")
        ? token.slice("--call=".length)
        : token.slice("-c=".length);
      const res = checkStaticReviewCommand(payload);
      if (res.blocked) return res;
      i++;
      continue;
    }
    const flagName = token.split("=", 1)[0];
    if (!token.includes("=") && otherValueFlags.has(flagName)) {
      i += 2;
      continue;
    }
    i++;
  }
  return { blocked: false };
}

function matchVerificationPackageSpec(token: string): string | null {
  if (token.startsWith(".") || token.startsWith("/")) return null;
  const minAt = token.startsWith("@") ? token.indexOf("/") + 1 : 1;
  if (minAt <= 0) return null;
  const at = token.indexOf("@", minAt);
  const spec = at > 0 ? token.slice(0, at) : token;
  const name = path.posix.basename(spec).toLowerCase();
  if (VERIFICATION_BINS.has(name)) return name;
  if (spec.startsWith("@") && (name === "cli" || name === "test")) {
    const scope = spec.slice(1, spec.indexOf("/")).toLowerCase();
    if (VERIFICATION_BINS.has(scope)) return scope;
  }
  return null;
}

function checkPackageExecWords(words: string[], depth: number): GuardResult {
  if (words.length === 0) return { blocked: false };
  const matched = matchVerificationPackageSpec(words[0]);
  if (matched) return block(matched);
  return checkWords(words, depth);
}

function checkNodeCommand(rest: string[]): GuardResult {
  let i = 0;
  let hasInlineCode = false;
  while (i < rest.length) {
    const token = rest[i];
    if (token === "--") {
      i++;
      break;
    }
    if (token === "--test" || token.startsWith("--test-")) {
      return block("node --test");
    }
    if (!token.startsWith("-") || token === "-") break;
    const flagName = token.split("=", 1)[0];
    if (flagName === "-e" || flagName === "--eval" || flagName === "-p" || flagName === "--print") {
      hasInlineCode = true;
    }
    if (!token.includes("=") && NODE_VALUE_FLAGS.has(flagName)) {
      i += 2;
      continue;
    }
    i++;
  }
  if (hasInlineCode || i >= rest.length) return { blocked: false };

  const script = rest[i];
  const stem = path.posix
    .basename(script)
    .replace(/\.(?:[cm]?js|[cm]?ts)$/i, "")
    .toLowerCase();
  if (VERIFICATION_BINS.has(stem)) {
    return block(`node ${stem}`);
  }
  const nmMatch = /(?:^|\/)node_modules\/(?:@[^/]+\/)?([^/]+)\//.exec(script);
  if (nmMatch) {
    const pkg = nmMatch[1].toLowerCase().replace(/-cli$/, "");
    if (pkg === "typescript" && /(?:^|\/)tsc(?:\.[cm]?js)?$/i.test(script)) {
      return block("node tsc");
    }
    if (VERIFICATION_BINS.has(pkg)) {
      return block(`node ${pkg}`);
    }
  }
  return { blocked: false };
}

function getExecValueFlags(bin: string, baseFlags: ReadonlySet<string>): Set<string> {
  // npm's `-p` is boolean (`--parseable`), not `--package`; yarn dlx accepts `-p <pkg>`.
  const flags = new Set([...baseFlags, "--package"]);
  if (bin === "yarn") flags.add("-p");
  return flags;
}

function checkPackageManager(bin: string, rest: string[], depth: number): GuardResult {
  const valueFlags = bin === "npm" ? NPM_VALUE_FLAGS : PM_COMMON_VALUE_FLAGS;
  if (bin === "npm") {
    const preCallCheck = checkCallFlagPayloads(rest, getExecValueFlags(bin, valueFlags));
    if (preCallCheck.blocked) return preCallCheck;
  }
  const idx = skipFlags(rest, valueFlags);
  if (idx >= rest.length) return { blocked: false };

  let sub = rest[idx];
  let afterSub = rest.slice(idx + 1);
  if (bin === "yarn" && sub === "workspace" && afterSub.length >= 2) {
    sub = afterSub[1];
    afterSub = afterSub.slice(2);
  }
  if (bin === "npm") {
    if (sub === "run-script" || sub === "rum" || sub === "urn") sub = "run";
    else if (sub === "x") sub = "exec";
  }
  if (sub === "exec" || sub === "dlx") {
    const execValueFlags = getExecValueFlags(bin, valueFlags);
    const callCheck = checkCallFlagPayloads(afterSub, execValueFlags);
    if (callCheck.blocked) return callCheck;
    const execIdx = skipFlags(afterSub, new Set([...execValueFlags, "-c", "--call"]));
    return checkPackageExecWords(afterSub.slice(execIdx), depth + 1);
  }
  if (bin === "bun" && DENO_BUN_BLOCKED.has(sub)) {
    return block(`bun ${sub}`);
  }
  if (sub === "run") {
    const scriptIdx = skipFlags(afterSub, valueFlags);
    const script = afterSub[scriptIdx];
    if (script && PM_BLOCKED_SCRIPT.test(script)) {
      return block(`${bin} ${script}`);
    }
    return { blocked: false };
  }
  if (PM_BLOCKED_SCRIPT.test(sub)) {
    return block(`${bin} ${sub}`);
  }
  return { blocked: false };
}

const SHELL_LONG_VALUE_FLAGS = new Set(["--rcfile", "--init-file"]);

function checkShellWrapper(rest: string[]): GuardResult {
  let seenC = false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--" || tok === "-") {
      if (seenC && rest[i + 1] !== undefined) {
        return checkStaticReviewCommand(rest[i + 1]);
      }
      break;
    }
    if (tok === "+" || (!tok.startsWith("-") && !tok.startsWith("+"))) {
      return seenC ? checkStaticReviewCommand(tok) : { blocked: false };
    }
    if (tok.startsWith("--")) {
      if (!tok.includes("=") && SHELL_LONG_VALUE_FLAGS.has(tok)) i++;
      continue;
    }

    // Short shell flags can be grouped (e.g. `-euo pipefail -c '...'`, `-co pipefail '...'`,
    // `-O globstar -c '...'`). Each `o`/`O` consumes one following operand; a `-` group
    // containing `c` executes the first positional operand after all flags.
    const flags = tok.slice(1);
    if (tok.startsWith("-") && flags.includes("c")) seenC = true;
    for (const ch of flags) {
      if (ch === "o" || ch === "O") i++;
    }
  }
  return { blocked: false };
}

function checkWords(rawWords: string[], depth = 0): GuardResult {
  if (depth > 4) return { blocked: false };
  const words = stripLeadingPrefixes(rawWords);
  if (words.length === 0) return { blocked: false };

  const bin = path.posix.basename(words[0]).toLowerCase();
  const rest = words.slice(1);

  if (bin === "sandbox-exec") {
    // Unwrap `ask-mode.ts` sandbox-exec prefix if ask-mode's tool_call hook ran first.
    const idx = skipFlags(rest, new Set(["-p", "-f", "-D"]));
    return checkWords(rest.slice(idx), depth + 1);
  }

  if (VERIFICATION_BINS.has(bin)) {
    return block(bin);
  }

  if (bin === "npx" || bin === "pnpx" || bin === "bunx") {
    const callCheck = checkCallFlagPayloads(rest, NPX_VALUE_FLAGS);
    if (callCheck.blocked) return callCheck;
    const idx = skipFlags(rest, new Set([...NPX_VALUE_FLAGS, "-c", "--call"]));
    return checkPackageExecWords(rest.slice(idx), depth + 1);
  }

  if ((bin === "uv" || bin === "poetry") && rest[0] === "run") {
    return checkWords(rest.slice(1), depth + 1);
  }

  if ((bin === "python" || bin === "python3") && rest[0] === "-m" && rest[1]) {
    const mod = rest[1].toLowerCase();
    if (VERIFICATION_BINS.has(mod)) return block(`${bin} -m ${mod}`);
    return { blocked: false };
  }

  if (bin === "node") {
    return checkNodeCommand(rest);
  }

  if (bin === "deno") {
    const idx = skipFlags(rest);
    if (rest[idx] && DENO_BUN_BLOCKED.has(rest[idx])) {
      return block(`deno ${rest[idx]}`);
    }
    return { blocked: false };
  }

  if (PM_BINS.has(bin)) {
    return checkPackageManager(bin, rest, depth);
  }

  if (bin === "go") {
    const idx = skipFlags(rest);
    if (rest[idx] && GO_BLOCKED.has(rest[idx])) {
      return block(`go ${rest[idx]}`);
    }
    return { blocked: false };
  }

  if (bin === "cargo") {
    const idx = skipFlags(rest);
    if (rest[idx] && CARGO_BLOCKED.has(rest[idx])) {
      return block(`cargo ${rest[idx]}`);
    }
    return { blocked: false };
  }

  if (SHELL_BINS.has(bin)) {
    return checkShellWrapper(rest);
  }

  return { blocked: false };
}

export function checkStaticReviewCommand(command: string): GuardResult {
  const trimmed = command.trim();
  if (!trimmed) return { blocked: false };

  for (const segment of extractSegments(trimmed)) {
    const words = tokenizeWords(segment);
    const res = checkWords(words);
    if (res.blocked) return res;
  }

  return { blocked: false };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input?.command;
    if (typeof command !== "string") return undefined;
    const check = checkStaticReviewCommand(command);
    if (check.blocked) {
      return { block: true, reason: check.reason };
    }
    return undefined;
  });
}
