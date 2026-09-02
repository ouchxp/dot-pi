# Pi Configuration

This repository contains the personal configuration and customizations used by the Pi coding agent. It is intentionally small: reusable configuration and source code are tracked, while credentials, sessions, caches, installed packages, and other runtime state are ignored.

## Repository contents

- `agent/AGENTS.md` — subagent delegation rules, pi-lens reporting rules, and subagent attention-looping guidance.
- `agent/.i-have-adhd-always` — marker that keeps the i-have-adhd skill enabled by default.
- `.gitignore` — keeps runtime state out of source control and excludes local `orca-*` extensions and `agent/git/`.
- `agent/settings.json` — Pi defaults, installed packages (including the i-have-adhd skill), model settings, UI preferences, and subagent overrides.
- `agent/extensions/` — tracked custom extensions:
  - `caveman-autoload.ts` — injects the caveman skill instructions into every turn (on by default at full level) and shows the current mode in the footer.
  - `enforce-permissions.ts` — adds a second enforcement layer for restricted commands and protected paths.
  - `openai-service-tier.ts` — applies the OpenAI `priority` service tier to configured models.
  - `resume-retry-guard.ts` — resumes interrupted subagent workflow runs from their persisted session instead of restarting them.
  - `side-pane-fork.ts` — opens chat forks in a side pane.
  - `tps.ts` — reports token throughput and usage after an agent run.
  - `subagent/config.json` — subagent attention timeout tuning.
- `agent/chains/` — reusable multi-agent workflows:
  - `council-review.js` — parallel correctness, test, and scope reviews (`retryAll`). Parent then launches oracle with the returned `synthesisTask`.

## Local-only state

The Pi runtime also creates local files and directories under `agent/`, including authentication data, sessions, missions, caches, installed packages, git state, and model state. These are intentionally excluded from this repository. Extensions matching `agent/extensions/orca-*` are also local-only.

Pi loads this configuration from `~/.pi` and `~/.pi/agent` when running locally.
