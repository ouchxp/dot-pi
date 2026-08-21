/**
 * Caveman autoload: injects the caveman skill instructions into every
 * turn unless turned off, and shows the current mode in the footer.
 *
 * - Default: ON, level "full"
 * - /caveman            -> enable at full level
 * - /caveman <level>    -> enable at lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|wenyan
 * - /caveman off        -> disable
 * - "stop caveman" / "normal mode"  -> disable (input interception)
 * - "caveman mode" / "talk like caveman" / "use caveman" -> enable
 *
 * State is per-session: every session starts ON at "full". Turning it off
 * applies to the current session only; /new, /resume, /fork, /reload all
 * reset to on/full.
 *
 * If the skill file (~/.agents/skills/caveman/SKILL.md) is missing, no
 * instructions are injected: a notify shows the install command and the
 * footer status reads "skill missing". Install: npx skills add JuliusBrussee/caveman
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LEVELS = [
  "lite",
  "full",
  "ultra",
  "wenyan-lite",
  "wenyan-full",
  "wenyan-ultra",
] as const;
type Level = (typeof LEVELS)[number];

interface State {
  enabled: boolean;
  level: Level;
}

const skillFile = join(homedir(), ".agents", "skills", "caveman", "SKILL.md");

function loadSkill(): string | null {
  try {
    return readFileSync(skillFile, "utf8");
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  // Per-session state: always starts ON at full.
  let state: State = { enabled: true, level: "full" };
  const skill = loadSkill();

  function refreshStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (!skill) {
      ctx.ui.setStatus(
        "caveman",
        ctx.ui.theme.fg("warning", "● Caveman: skill missing"),
      );
      return;
    }
    if (state.enabled)
      ctx.ui.setStatus(
        "caveman",
        ctx.ui.theme.fg("accent", `● Caveman: ${state.level}`),
      );
    else ctx.ui.setStatus("caveman", undefined);
  }

  function warnMissing(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      "Caveman skill not installed. Run: npx skills add JuliusBrussee/caveman",
      "error",
    );
  }

  // Fresh session (startup, /new, /resume, /fork, /reload) -> back to on/full.
  pi.on("session_start", async (_event, ctx) => {
    state = { enabled: true, level: "full" };
    refreshStatus(ctx);
    if (!skill) warnMissing(ctx);
  });

  // Inject instructions into every turn while enabled.
  pi.on("before_agent_start", async (event) => {
    if (!state.enabled || !skill) return;
    const directive = `Caveman mode ACTIVE, level: ${state.level}. Follow the instructions below.`;
    return { systemPrompt: `${event.systemPrompt}\n\n${directive}\n${skill}` };
  });

  pi.registerCommand("caveman", {
    description:
      "Caveman mode: /caveman [lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|off]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (!skill && arg !== "off") {
        warnMissing(ctx);
        return;
      }

      if (arg === "off" || arg === "normal") {
        state = { ...state, enabled: false };
        refreshStatus(ctx);
        ctx.ui.notify("Caveman off", "info");
        return;
      }

      let level: Level = "full";
      if (arg) {
        if (arg === "wenyan") level = "wenyan-full";
        else if (LEVELS.includes(arg as Level)) level = arg as Level;
        else {
          ctx.ui.notify(
            `Unknown level: ${arg}. Use: ${LEVELS.join(", ")} or off`,
            "error",
          );
          return;
        }
      }

      state = { enabled: true, level };
      refreshStatus(ctx);
      ctx.ui.notify(`Caveman: ${state.level}`, "info");
    },
  });

  // Support the skill's plain-language toggles without a slash.
  pi.on("input", async (event, ctx) => {
    const text = event.text.trim().toLowerCase();
    const turnOff = text === "stop caveman" || text === "normal mode";
    const turnOn =
      text === "caveman mode" ||
      text === "talk like caveman" ||
      text === "use caveman";

    if (turnOff && state.enabled) {
      state = { ...state, enabled: false };
      refreshStatus(ctx);
      ctx.ui.notify("Caveman off. Next reply normal prose.", "info");
    } else if (turnOn && !state.enabled) {
      if (!skill) {
        warnMissing(ctx);
        return { action: "continue" };
      }
      state = { ...state, enabled: true };
      refreshStatus(ctx);
      ctx.ui.notify(`Caveman: ${state.level}`, "info");
    }

    return { action: "continue" };
  });
}
