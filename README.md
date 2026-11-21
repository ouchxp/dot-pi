# Pi Configuration

This repository contains the personal configuration and customizations used by the Pi coding agent. It is intentionally small: reusable configuration and source code are tracked, while credentials, sessions, caches, installed packages, and other runtime state are ignored.

## Repository contents

- `agent/AGENTS.md` — global agent rules: subagent delegation rules, pi-lens reporting rules, and subagent attention-looping guidance.
- `agent/agents/` — custom subagent prompt definitions (`reviewer` and `oracle` use the bundled `pi-subagents` presets configured via `agent/settings.json` + `agent/subagent-extensions/`):
  - `exception-detector.md` — scans diffs for judgment-boundary exceptions, code a human reviewer would stop at; complements reviewer on high-risk changes.
- `agent/subagent-extensions/` — child-only extensions loaded via `subagents.agentOverrides.*.subagentOnlyExtensions` (never auto-loaded in the parent):
  - `static-review-guard.ts` — blocks heavy verification commands (`tsc`, test suites, linters, formatters, builds) in `reviewer` and `oracle` so reviews stay static. (Filesystem read-only sandboxing via macOS `sandbox-exec` is owned by `agent/extensions/ask-mode.ts`.)
  - `reviewer-policy.ts` — appends read-only `bash`, static-review, scope-anchoring, classification/kind tag, review-ledger, simplicity, and P2 fix-cost rules onto the bundled `reviewer` preset.
- `agent/.i-have-adhd-always` — marker that keeps the i-have-adhd skill enabled by default.
- `.gitignore` — keeps runtime state out of source control and excludes local `orca-*` extensions and `agent/git/`.
- `agent/settings.json` — Pi defaults, installed packages (including the i-have-adhd skill), model settings, UI preferences, and subagent overrides.
- `agent/auto-rename.json` — model configuration used for automatic session titles.
- `agent/extensions/` — tracked custom extensions:
  - `ask-mode.ts` — adds an Ask mode (read-only consultation, default on) and an Edit mode with `Shift+Tab` toggle, `/ask` command, session state persistence, system prompt context injection, and write tool blocking.
  - `auto-rename.ts` — automatically generates concise session names on the first prompt using `auto-rename.json`, with `/auto-rename <name>` to set manually and `/auto-rename` to regenerate from user-message history.
  - `caveman-autoload.ts` — injects the caveman skill instructions into every turn (on by default at full level) and shows the current mode in the footer.
  - `cursor-acp.ts` — Cursor agent over ACP; models come from the local (ignored) `cursor-models.json`.
  - `enforce-permissions.ts` — adds a second enforcement layer for restricted commands and protected paths.
  - `ff-tool-preference.ts` — steers agents toward `ffgrep`/`fffind` for pure keyword lookups instead of bash `grep`/`find`.
  - `notify-done.ts` — sends a native terminal notification when a run finishes.
  - `openai-service-tier.ts` — applies the OpenAI `priority` service tier to configured models.
  - `pi-tool-display/config.json` — output display tuning for tool results (collapsed lines, hidden ffgrep/fffind output).
  - `resume-retry-guard.ts` — deprecated and excluded from loading by `agent/settings.json`; its source is retained unchanged for historical reference. New workflows use native `runs.run` / `runs.all`, with explicit recovery decisions rather than injected retry helpers.
  - `side-pane-fork.ts` — opens chat forks in a side pane.
  - `tps.ts` — reports token throughput and usage after an agent run.
  - `subagent/config.json` — subagent runtime timeout (`timeoutMs`, 2h default for single-agent/workflow runs; async chain/parallel composites fall back to 30m unless per-call `timeoutMs` is set) and attention tuning.
- `agent/chains/` — reusable multi-agent workflows:
  - `council-review-stage1.js` and `council-review-stage2.js` — stage templates for reviewer fanout and independent verification using native `runs.all`. The council-review skill describes composing these stages and the chairman into one async workflow.
- `agent/skills/council-review/SKILL.md` — skill front-end that launches the council-review chain on a branch/PR.

## Local-only state

The Pi runtime also creates local files and directories under `agent/`, including authentication data, sessions, missions, caches, installed packages, git state, and model state. These are intentionally excluded from this repository. Extensions matching `agent/extensions/orca-*` are also local-only.

Pi loads this configuration from `~/.pi` and `~/.pi/agent` when running locally.
