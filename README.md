# Pi Configuration

This repository contains the personal configuration and customizations used by the Pi coding agent. It is intentionally small: reusable configuration and source code are tracked, while credentials, sessions, caches, installed packages, and other runtime state are ignored.

## Repository contents

- `agent/AGENTS.md` — global agent rules: subagent delegation rules, pi-lens reporting rules, and subagent attention-looping guidance.
- `agent/agents/` — subagent prompt definitions:
  - `reviewer.md` — PR/code review agent; reviews statically, never runs test suites or builds.
  - `oracle.md` — design-consultation agent; read-only analysis only.
  - `exception-detector.md` — scans diffs for judgment-boundary exceptions, code a human reviewer would stop at; complements reviewer on high-risk changes.
- `agent/.i-have-adhd-always` — marker that keeps the i-have-adhd skill enabled by default.
- `.gitignore` — keeps runtime state out of source control and excludes local `orca-*` extensions and `agent/git/`.
- `agent/settings.json` — Pi defaults, installed packages (including the i-have-adhd skill), model settings, UI preferences, and subagent overrides.
- `agent/auto-rename.json` — model configuration used for automatic session titles.
- `agent/extensions/` — tracked custom extensions:
  - `caveman-autoload.ts` — injects the caveman skill instructions into every turn (on by default at full level) and shows the current mode in the footer.
  - `cursor-acp.ts` — Cursor agent over ACP; models come from the local (ignored) `cursor-models.json`.
  - `enforce-permissions.ts` — adds a second enforcement layer for restricted commands and protected paths.
  - `ff-tool-preference.ts` — steers agents toward `ffgrep`/`fffind` for pure keyword lookups instead of bash `grep`/`find`.
  - `notify-done.ts` — sends a native terminal notification when a run finishes.
  - `openai-service-tier.ts` — applies the OpenAI `priority` service tier to configured models.
  - `pi-tool-display/config.json` — output display tuning for tool results (collapsed lines, hidden ffgrep/fffind output).
  - `resume-retry-guard.ts` — resumes interrupted subagent workflow runs from their persisted session instead of restarting them.
  - `side-pane-fork.ts` — opens chat forks in a side pane.
  - `tps.ts` — reports token throughput and usage after an agent run.
  - `subagent/config.json` — subagent attention timeout tuning.
- `agent/chains/` — reusable multi-agent workflows:
  - `council-review.js` — stage 1 runs two non-GPT reviewer models (gemini, grok) across three aspects (correctness, tests, scope) in parallel (`retryAll`), then the parent launches the GPT chairman (oracle) with the returned `synthesisTask`.
- `agent/skills/council-review/SKILL.md` — skill front-end that launches the council-review chain on a branch/PR.

## Local-only state

The Pi runtime also creates local files and directories under `agent/`, including authentication data, sessions, missions, caches, installed packages, git state, and model state. These are intentionally excluded from this repository. Extensions matching `agent/extensions/orca-*` are also local-only.

Pi loads this configuration from `~/.pi` and `~/.pi/agent` when running locally.
