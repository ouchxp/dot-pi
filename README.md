# Pi Configuration

This repository contains the personal configuration and customizations used by the Pi coding agent. It is intentionally small: reusable configuration and source code are tracked, while credentials, sessions, caches, installed packages, and other runtime state are ignored.

## Repository contents

- `AGENTS.md` — instructions for delegating work to Pi subagents.
- `.gitignore` — keeps runtime state out of source control and excludes local `orca-*` extensions.
- `agent/settings.json` — Pi defaults, installed packages, model settings, UI preferences, and subagent overrides.
- `agent/extensions/` — tracked custom extensions:
  - `enforce-permissions.ts` — adds a second enforcement layer for restricted commands and protected paths.
  - `openai-service-tier.ts` — applies the OpenAI `priority` service tier to configured models.
  - `tps.ts` — reports token throughput and usage after an agent run.
- `agent/chains/` — reusable multi-agent workflows:
  - `council-review.chain.json` — runs independent correctness, test, and scope reviews, then synthesizes them with an oracle.

## Local-only state

The Pi runtime also creates local files and directories under `agent/`, including authentication data, sessions, missions, caches, installed packages, and model state. These are intentionally excluded from this repository. Extensions matching `agent/extensions/orca-*` are also local-only.

Pi loads this configuration from `~/.pi` and `~/.pi/agent` when running locally.
