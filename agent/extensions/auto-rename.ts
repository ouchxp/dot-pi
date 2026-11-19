/**
 * Auto-Rename Extension for Pi
 *
 * Automatically generates a concise session name on the first user prompt using
 * a configured LLM model and prompt template (loaded from auto-rename.json).
 *
 * Config lookup order:
 *   1. ./auto-rename.json
 *   2. ./.pi/auto-rename.json
 *   3. ~/.pi/agent/auto-rename.json
 *
 * Command:
 *   /auto-rename          Regenerate session name from branch user-message history
 *   /auto-rename <name>   Set session name manually
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ModelConfig {
	provider: string;
	id: string;
}

export interface AutoRenameConfig {
	model?: ModelConfig | null;
	prompt?: string;
	prefix?: string;
	prefixCommand?: string;
	enabled?: boolean;
	debug?: boolean;
	maxQueryLength?: number;
	maxNameLength?: number;
	maxRetries?: number;
}

export interface ResolvedConfig {
	model: ModelConfig | null;
	prompt: string;
	prefix: string;
	prefixCommand: string | undefined;
	enabled: boolean;
	debug: boolean;
	maxQueryLength: number;
	maxNameLength: number;
	maxRetries: number;
}

export interface TitleGenerationResult {
	title: string | null;
	reason: string | null;
	attempts: number;
}

const DEFAULT_PROMPT = `Generate a short, descriptive title (max 6 words) for a chat session based on this first message:

<message>
{{query}}
</message>

Rules:
- Be concise and specific
- Use title case
- No quotes or punctuation at the end
- Focus on the main topic or intent

Reply with ONLY the title, nothing else.`;

const DEFAULT_CONFIG: ResolvedConfig = {
	model: null,
	prompt: DEFAULT_PROMPT,
	prefix: "",
	prefixCommand: undefined,
	enabled: true,
	debug: false,
	maxQueryLength: 2000,
	maxNameLength: 80,
	maxRetries: 3,
};

const CONFIG_FILENAME = "auto-rename.json";
const PREFIX_TIMEOUT_MS = 5000;
const LLM_TIMEOUT_MS = 15000;

export function loadConfig(cwd: string, homeDir: string = homedir()): ResolvedConfig {
	const paths = [
		join(cwd, CONFIG_FILENAME),
		join(cwd, ".pi", CONFIG_FILENAME),
		join(homeDir, ".pi", "agent", CONFIG_FILENAME),
	];

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as AutoRenameConfig;
			return { ...DEFAULT_CONFIG, ...parsed };
		} catch {
			// Skip unreadable or invalid JSON and fall through to next candidate.
		}
	}

	return DEFAULT_CONFIG;
}

export function resolvePrefix(config: ResolvedConfig, cwd: string, ctx: ExtensionContext): string {
	if (config.prefixCommand) {
		try {
			const output = execSync(config.prefixCommand, {
				cwd,
				encoding: "utf-8",
				timeout: PREFIX_TIMEOUT_MS,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();
			if (output) return output;
		} catch {
			if (config.debug && ctx.hasUI) {
				ctx.ui.notify("[auto-rename] prefixCommand failed, using static prefix", "warning");
			}
		}
	}
	return config.prefix;
}

export function formatFullName(prefix: string, name: string): string {
	return prefix ? `${prefix}: ${name}` : name;
}

export function truncateQuery(query: string, maxLength: number): string {
	if (query.length <= maxLength) return query;
	const marker = "\n[...truncated...]\n";
	const budget = maxLength - marker.length;
	if (budget <= 0) return query.slice(0, maxLength);

	const headBudget = Math.ceil(budget * 0.6);
	const tailBudget = budget - headBudget;

	let head = query.slice(0, headBudget);
	const headSpace = head.lastIndexOf(" ");
	if (headSpace > headBudget * 0.6) {
		head = head.slice(0, headSpace);
	}

	let tail = query.slice(query.length - tailBudget);
	const tailSpace = tail.indexOf(" ");
	if (tailSpace >= 0 && tailSpace < tailBudget * 0.4) {
		tail = tail.slice(tailSpace + 1);
	}

	return `${head}${marker}${tail}`;
}

export function enforceNameLength(name: string, maxLength: number): string {
	if (name.length <= maxLength) return name;
	const limit = maxLength - 3;
	if (limit <= 0) return name.slice(0, maxLength);

	const truncated = name.slice(0, limit);
	const lastSpace = truncated.lastIndexOf(" ");
	const cut = lastSpace > limit * 0.4 ? truncated.slice(0, lastSpace) : truncated;
	return `${cut.replace(/[,;:\s]+$/, "")}...`;
}

function stripThinkTags(text: string): string {
	return text
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/<think>[\s\S]*/gi, "")
		.replace(/<thinking>[\s\S]*/gi, "")
		.trim();
}

type ContentPart = { type: string; text?: string; thinking?: string };

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	const parts = content as ContentPart[];
	const text = parts
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("")
		.trim();
	if (text) return text;

	// Some reasoning models put short replies inside thinking blocks only.
	const thinking = parts
		.filter((c): c is { type: "thinking"; thinking: string } => c.type === "thinking" && typeof c.thinking === "string")
		.map((c) => c.thinking)
		.join("")
		.trim();
	if (!thinking) return "";

	const lines = thinking
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("*") && !l.startsWith("-") && !l.startsWith("#"));
	return lines.length > 0 ? lines[lines.length - 1] : "";
}

function normalizeCandidateLine(line: string): string {
	return line
		.replace(/<[^>]+>/g, " ")
		.replace(/^[\s\-*>#]+/, "")
		.replace(/^\d+[.)]\s*/, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/^["']+|["']+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function looksLikeReasoning(line: string): boolean {
	if (!line) return true;
	if (line.includes("|")) return true;
	if (/^(step|analysis|reasoning|thinking|selecting|here'?s|let'?s)\b/i.test(line)) return true;
	if (/\b(best title|final title|option \d|candidate \d)\b/i.test(line)) return true;
	if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(line)) return true;
	if (/[{}<>]/.test(line)) return true;
	const words = line.split(/\s+/).filter(Boolean);
	if (words.length < 2 || words.length > 12) return true;
	return false;
}

export function parseNameFromResponse(
	response: { content: ContentPart[] },
	maxNameLength: number,
): string | null {
	const raw = stripThinkTags(extractTextFromContent(response.content));
	if (!raw) return null;

	const lines = raw
		.split("\n")
		.map(normalizeCandidateLine)
		.filter((l) => l.length > 0);

	// Prefer the last non-reasoning line when a model outputs reasoning before the title.
	let name = "";
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!looksLikeReasoning(lines[i])) {
			name = lines[i];
			break;
		}
	}
	if (!name && lines.length > 0) {
		name = [...lines].sort((a, b) => a.length - b.length)[0];
	}

	name = name.replace(/\.+$/, "").trim();
	if (!name || looksLikeReasoning(name)) return null;

	return enforceNameLength(name, maxNameLength) || null;
}

type BranchEntry = { type: string; message?: { role?: string; content?: unknown } };

export function extractFirstUserQuery(branch: BranchEntry[]): string | null {
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = extractTextFromContent(entry.message.content);
		if (text) return text;
	}
	return null;
}

export function extractUserHistory(branch: BranchEntry[]): string | null {
	const messages: string[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const text = extractTextFromContent(entry.message.content);
		if (text) messages.push(text);
	}
	return messages.length > 0 ? messages.join("\n\n") : null;
}

function hasUsableName(name: string | undefined): boolean {
	if (!name) return false;
	const normalized = name.trim().toLowerCase();
	return normalized.length > 0 && normalized !== "chat";
}

function debugNotify(
	ctx: ExtensionContext,
	config: ResolvedConfig,
	message: string,
	level: "info" | "warning" | "error" = "info",
): void {
	if (config.debug && ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function resolveModel(config: ResolvedConfig, ctx: ExtensionContext): Model<Api> | null {
	if (config.model) {
		const configured = ctx.modelRegistry.find(config.model.provider, config.model.id);
		if (configured && ctx.modelRegistry.hasConfiguredAuth(configured)) {
			return configured;
		}
		debugNotify(
			ctx,
			config,
			`[auto-rename] Configured model ${config.model.provider}/${config.model.id} unavailable, falling back to session model`,
			"warning",
		);
	}

	if (ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
		return ctx.model;
	}

	return null;
}

function normalizeMaxRetries(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_CONFIG.maxRetries;
	return Math.max(0, Math.floor(value));
}

async function generateTitleOnce(
	model: Model<Api>,
	prompt: string,
	maxNameLength: number,
	ctx: ExtensionContext,
): Promise<{ title: string | null; reason: string | null }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

	try {
		const response: AssistantMessage = await ctx.modelRegistry.complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				cacheRetention: "none",
				signal: controller.signal,
			},
		);

		if (response.stopReason === "error" || response.stopReason === "aborted") {
			return {
				title: null,
				reason: `LLM ${response.stopReason}: ${response.errorMessage ?? "unknown"}`,
			};
		}

		const title = parseNameFromResponse(response, maxNameLength);
		if (!title) {
			const raw = extractTextFromContent(response.content).replace(/\s+/g, " ").trim();
			const snippet = raw ? `"${raw.slice(0, 80)}${raw.length > 80 ? "..." : ""}"` : "empty response";
			return {
				title: null,
				reason: `unusable response (${snippet})`,
			};
		}

		return { title, reason: null };
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return { title: null, reason: `LLM error: ${msg}` };
	} finally {
		clearTimeout(timeout);
	}
}

async function generateTitle(
	query: string,
	config: ResolvedConfig,
	ctx: ExtensionContext,
): Promise<TitleGenerationResult> {
	const model = resolveModel(config, ctx);
	if (!model) {
		const reason = config.model
			? `model ${config.model.provider}/${config.model.id} and session model unavailable or unauthenticated`
			: "no authenticated model available";
		debugNotify(ctx, config, `[auto-rename] ${reason}`, "warning");
		return { title: null, reason, attempts: 0 };
	}

	const trimmedQuery = truncateQuery(query, config.maxQueryLength);
	// Callback replacement avoids special `$&`/`$$` interpretation in user queries.
	const prompt = config.prompt.replace("{{query}}", () => trimmedQuery);

	const totalAttempts = 1 + normalizeMaxRetries(config.maxRetries);
	let lastReason = "unknown failure";

	for (let attempt = 1; attempt <= totalAttempts; attempt++) {
		const result = await generateTitleOnce(model, prompt, config.maxNameLength, ctx);
		if (result.title) {
			return { title: result.title, reason: null, attempts: attempt };
		}
		lastReason = result.reason ?? lastReason;
		debugNotify(
			ctx,
			config,
			`[auto-rename] attempt ${attempt}/${totalAttempts} failed: ${lastReason}`,
			"warning",
		);
	}

	return { title: null, reason: lastReason, attempts: totalAttempts };
}

export default function (pi: ExtensionAPI) {
	let sessionRenamed = false;
	let firstPromptHandled = false;
	let inFlight = false;

	const resetState = () => {
		sessionRenamed = hasUsableName(pi.getSessionName());
		firstPromptHandled = false;
		inFlight = false;
	};

	const renameFromQuery = async (query: string, ctx: ExtensionContext): Promise<void> => {
		if (inFlight) return;
		const config = loadConfig(ctx.cwd);
		if (!config.enabled) return;

		if (hasUsableName(pi.getSessionName())) {
			sessionRenamed = true;
			return;
		}

		inFlight = true;
		try {
			const prefix = resolvePrefix(config, ctx.cwd, ctx);
			const { title } = await generateTitle(query, config, ctx);
			if (!title) return;

			// Re-check in case user manually named the session while LLM was in flight.
			if (hasUsableName(pi.getSessionName())) {
				sessionRenamed = true;
				return;
			}

			const fullName = formatFullName(prefix, title);
			pi.setSessionName(fullName);
			sessionRenamed = true;
			debugNotify(ctx, config, `[auto-rename] Named: ${fullName}`, "info");
		} finally {
			inFlight = false;
		}
	};

	pi.on("session_start", () => {
		resetState();
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (sessionRenamed || firstPromptHandled) return;
		firstPromptHandled = true;

		const prompt = event.prompt?.trim();
		if (!prompt) return;
		void renameFromQuery(prompt, ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (sessionRenamed || inFlight) return;
		if (hasUsableName(pi.getSessionName())) {
			sessionRenamed = true;
			return;
		}

		const query = extractFirstUserQuery(ctx.sessionManager.getBranch() as BranchEntry[]);
		if (!query) return;
		void renameFromQuery(query, ctx);
	});

	pi.registerCommand("auto-rename", {
		description: "Set session name (/auto-rename <name>) or regenerate from history (/auto-rename)",
		handler: async (args, ctx) => {
			const manualName = args.trim();
			if (manualName) {
				pi.setSessionName(manualName);
				sessionRenamed = true;
				if (ctx.hasUI) ctx.ui.notify(`Session renamed: ${manualName}`, "info");
				return;
			}

			const history = extractUserHistory(ctx.sessionManager.getBranch() as BranchEntry[]);
			if (!history) {
				if (ctx.hasUI) ctx.ui.notify("No user messages found in session history", "warning");
				return;
			}

			const config = loadConfig(ctx.cwd);
			if (ctx.hasUI) ctx.ui.notify("Regenerating session name...", "info");

			const prefix = resolvePrefix(config, ctx.cwd, ctx);
			const { title, reason, attempts } = await generateTitle(history, config, ctx);
			if (!title) {
				if (ctx.hasUI) {
					const suffix = attempts > 1 ? ` after ${attempts} attempts` : "";
					ctx.ui.notify(`Auto-rename skipped${suffix}: ${reason ?? "unknown error"}`, "warning");
				}
				return;
			}

			const fullName = formatFullName(prefix, title);
			pi.setSessionName(fullName);
			sessionRenamed = true;
			if (ctx.hasUI) ctx.ui.notify(`Session renamed: ${fullName}`, "info");
		},
	});
}
