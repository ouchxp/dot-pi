import {
	AssistantMessageComponent,
	type ExtensionAPI,
	ToolExecutionComponent,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
	type Box,
	type Component,
	Container,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_SINGLE_LINE_CHARS = 120;
const MAX_SUMMARY_TOOLS = 4;
const STATUS_DOT = "●";

const CODEMODE_TOOL_CALL_RE = /\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const HEREDOC_RE = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const VALID_BINARY_RE = /^[A-Za-z0-9._@+-]+$/;
const LEADING_ANSI_RE = /^(?:\x1b\[[0-9;:]*m)*/;
const TOP_BORDER_RE = /^((?:\x1b\[[0-9;:]*m)*)┌(─+)┐((?:\x1b\[[0-9;:]*m)*)$/;
const BOTTOM_BORDER_RE = /^((?:\x1b\[[0-9;:]*m)*)└(─+)┘((?:\x1b\[[0-9;:]*m)*)$/;

const SHELL_KEYWORDS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"in",
	"function",
	"set",
	"export",
	"local",
	"unset",
	"true",
	"false",
	"exit",
	"return",
	"cd",
	"echo",
	"printf",
	"mktemp",
	"mkdir",
	"sleep",
	"test",
	"[",
	"[[",
	"!",
	"time",
]);
const RUNNER_WRAPPERS = new Set(["npm", "pnpm", "yarn", "bun", "uv"]);
const SUBCOMMAND_TOOLS = new Set([
	"git",
	"docker",
	"kubectl",
	"gh",
	"cargo",
	"go",
	"npm",
	"pnpm",
	"yarn",
	"uv",
	"brew",
]);

const CALL_BOX_KEY = Symbol.for("compact-bash-call.callBox.v1");
const MANUAL_TOGGLE_KEY = Symbol.for("compact-bash-call.manualToggle.v1");
const THINKING_AUTO_HIDDEN_KEY = Symbol.for("compact-bash-call.thinkingAutoHidden.v1");
const MERGED_TOP_KEY = Symbol.for("compact-bash-call.mergedTop.v1");
const STACK_PATCH_KEY = Symbol.for("compact-bash-call.borderedStackPatch.v1");

const EMPTY_TEXT = new Text("", 0, 0);

type ToolRenderTheme = Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];

interface ActiveToolTracker {
	seenToolCallIds: Set<string>;
	lastToolCallId?: string;
	lastInvalidate?: () => void;
}

interface RowState {
	[CALL_BOX_KEY]?: BorderedBox;
	[MANUAL_TOGGLE_KEY]?: {
		lastSeenExpanded: boolean;
		wasLatest: boolean;
		shown: boolean;
	};
}

type MouseEventArg = Parameters<Box["handleMouse"]>[0];
type MouseDispatchReturn = ReturnType<Box["handleMouse"]>;

interface ToolExecutionLike {
	toolCallId?: string;
	callRendererComponent?: Component;
	resultRendererComponent?: Component;
	selfRenderContainer?: { handleMouse(event: MouseEventArg): MouseDispatchReturn };
	selfRenderHeight?: number;
	hasRendererDefinition?: () => boolean;
	getRenderShell?: () => string;
	invalidate?: () => void;
	[MERGED_TOP_KEY]?: boolean;
}

interface ContainerLike {
	children?: unknown[];
	mouseLayout?: { width: number; children: Array<{ component: Component; height: number }> };
}

interface ToolExecutionProto {
	render?: (this: ToolExecutionLike, width: number) => string[];
	handleMouse?: (this: ToolExecutionLike, event: MouseEventArg) => MouseDispatchReturn;
}

interface ContainerProto {
	render?: (this: ContainerLike, width: number) => string[];
}

interface AssistantMessageLike {
	lastMessage?: { content?: Array<{ type?: string; thinking?: string }> };
	hideThinkingBlock?: boolean;
	thinkingVisibilityOverrides?: Map<number, boolean>;
	isStreaming?: boolean;
	updateContent?: (message: unknown, isStreaming?: boolean) => void;
	[THINKING_AUTO_HIDDEN_KEY]?: boolean;
}

class CompactBashText extends Text {
	suffix = "";
	override setText(text: string): void {
		super.setText(this.suffix ? `${text}${this.suffix}` : text);
	}
}

class SingleLineComponent implements Component {
	readonly inner: Component;
	constructor(inner: Component) {
		this.inner = inner;
	}
	invalidate(): void {
		this.inner.invalidate();
	}
	render(width: number): string[] {
		if (width <= 0) return [];
		// Render wide first so single-line headers aren't word-wrapped before we clamp to `width`.
		const lines = this.inner.render(Math.max(width, 512));
		if (lines.length === 0) return [];
		const first = lines[0].replace(/ +$/, "");
		return [visibleWidth(first) > width ? truncateToWidth(first, width, "…") : first];
	}
}

/** Falls back to raw text output when a base result renderer hides content in expanded view (e.g. pi-tool-display hidden mode). */
class FallbackIfEmptyComponent implements Component {
	readonly inner: Component;
	private readonly fallback: Text;
	constructor(inner: Component, fallbackText: string) {
		this.inner = inner;
		this.fallback = new Text(fallbackText, 0, 0);
	}
	invalidate(): void {
		this.inner.invalidate();
		this.fallback.invalidate();
	}
	render(width: number): string[] {
		const lines = this.inner.render(width);
		return lines.length > 0 ? lines : this.fallback.render(width);
	}
}

/** Transparent box-drawing frame (`┌───┐` / `│ ... │` / `└───┘`) for `renderShell: "self"`. */
class BorderedBox implements Component {
	inner?: Component;
	padX = 1;
	borderFn: (text: string) => string = (text) => text;
	drawTop = true;
	drawDivider = false;
	drawBottom = true;
	headerStyle?: (line: string) => string;

	setContent(
		inner: Component,
		frame: {
			padX: number;
			borderFn: (text: string) => string;
			drawTop: boolean;
			drawDivider: boolean;
			drawBottom: boolean;
			headerStyle?: (line: string) => string;
		},
	): this {
		this.inner = inner;
		this.padX = frame.padX;
		this.borderFn = frame.borderFn;
		this.drawTop = frame.drawTop;
		this.drawDivider = frame.drawDivider;
		this.drawBottom = frame.drawBottom;
		this.headerStyle = frame.headerStyle;
		return this;
	}

	invalidate(): void {
		this.inner?.invalidate();
	}

	render(width: number): string[] {
		if (!this.inner || width < 4) return [];
		const innerWidth = Math.max(1, width - 2 - this.padX * 2);
		const prefixWidth = this.headerStyle ? 2 : 0; // "● "
		const bodyLines = this.inner.render(Math.max(1, innerWidth - prefixWidth));
		const horiz = "─".repeat(width - 2);

		if (bodyLines.length === 0) {
			return this.drawBottom && !this.drawTop ? [this.borderFn(`└${horiz}┘`)] : [];
		}

		const leftPad = " ".repeat(this.padX);
		const side = this.borderFn("│");
		const out: string[] = [];

		if (this.drawTop) out.push(this.borderFn(`┌${horiz}┐`));
		else if (this.drawDivider) out.push(this.borderFn(`├${horiz}┤`));

		for (let i = 0; i < bodyLines.length; i++) {
			const line = i === 0 && this.headerStyle ? this.headerStyle(bodyLines[i]) : bodyLines[i];
			const padRight = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)) + this.padX);
			out.push(`${side}${leftPad}${line}${padRight}${side}`);
		}

		if (this.drawBottom) out.push(this.borderFn(`└${horiz}┘`));
		return out;
	}
}

// --- Expansion tracking & header styling ---

function getRowState(state: unknown): RowState | undefined {
	return state && typeof state === "object" ? (state as RowState) : undefined;
}

function recordPartialTool(
	tracker: ActiveToolTracker,
	toolCallId: string | undefined,
	invalidate: (() => void) | undefined,
): void {
	if (!toolCallId) return;
	if (!tracker.seenToolCallIds.has(toolCallId)) {
		tracker.seenToolCallIds.add(toolCallId);
		const prevInvalidate = tracker.lastInvalidate;
		tracker.lastToolCallId = toolCallId;
		tracker.lastInvalidate = invalidate;
		if (prevInvalidate && prevInvalidate !== invalidate) {
			queueMicrotask(() => prevInvalidate());
		}
	} else if (tracker.lastToolCallId === toolCallId && invalidate) {
		tracker.lastInvalidate = invalidate;
	}
}

function shouldExpandTool(
	tracker: ActiveToolTracker,
	context: {
		toolCallId?: string;
		isPartial?: boolean;
		expanded?: boolean;
		invalidate?: () => void;
		state?: unknown;
	},
): boolean {
	if (context.isPartial) {
		recordPartialTool(tracker, context.toolCallId, context.invalidate);
		return true;
	}

	const isLatest =
		context.toolCallId !== undefined && tracker.lastToolCallId === context.toolCallId;
	const expandedFlag = context.expanded === true;
	const state = getRowState(context.state);
	if (!state) return isLatest || expandedFlag;

	const prev = state[MANUAL_TOGGLE_KEY];
	if (!prev) {
		const shown = isLatest ? true : expandedFlag;
		state[MANUAL_TOGGLE_KEY] = { lastSeenExpanded: expandedFlag, wasLatest: isLatest, shown };
		return shown;
	}

	if (prev.wasLatest !== isLatest) {
		prev.wasLatest = isLatest;
		prev.shown = isLatest;
		prev.lastSeenExpanded = expandedFlag;
		return isLatest;
	}

	if (prev.lastSeenExpanded !== expandedFlag) {
		prev.lastSeenExpanded = expandedFlag;
		prev.shown = !prev.shown;
	}
	return prev.shown;
}

function styleCallHeaderLine(
	line: string,
	statusColor: "warning" | "error" | "success",
	theme: ToolRenderTheme,
): string {
	const prefixLen = LEADING_ANSI_RE.exec(line)?.[0].length ?? 0;
	const rest = line.slice(prefixLen);
	const spaceIndex = rest.indexOf(" ");

	if (spaceIndex <= 0) {
		const plain = stripTerminalSequences(rest).trim();
		return theme.fg(statusColor, theme.bold(plain ? `${STATUS_DOT} ${plain}` : STATUS_DOT));
	}

	const toolName = stripTerminalSequences(rest.slice(0, spaceIndex));
	return `${theme.fg(statusColor, theme.bold(`${STATUS_DOT} ${toolName}`))}${rest.slice(spaceIndex)}`;
}

function wrapBordered(
	slot: "call" | "result",
	inner: Component,
	lastComponent: Component | undefined,
	context: { isPartial?: boolean; isError?: boolean; outputPad?: number; state?: unknown },
	theme: ToolRenderTheme,
): BorderedBox {
	const statusColor = context.isPartial ? "warning" : context.isError ? "error" : "success";
	const borderColor = context.isPartial ? "warning" : context.isError ? "error" : "borderMuted";
	const state = getRowState(context.state);

	if (slot === "result" && state?.[CALL_BOX_KEY]) {
		state[CALL_BOX_KEY].drawBottom = false;
	}

	const box = lastComponent instanceof BorderedBox ? lastComponent : new BorderedBox();
	box.setContent(inner, {
		padX: context.outputPad ?? 1,
		borderFn: (text) => theme.fg(borderColor, text),
		drawTop: slot === "call",
		drawDivider: slot === "result",
		drawBottom: true,
		headerStyle:
			slot === "call" ? (line) => styleCallHeaderLine(line, statusColor, theme) : undefined,
	});

	if (slot === "call" && state) {
		state[CALL_BOX_KEY] = box;
	}
	return box;
}

function unwrapInner(component: Component | undefined): Component | undefined {
	let current = component;
	if (current instanceof BorderedBox) current = current.inner;
	if (current instanceof SingleLineComponent || current instanceof FallbackIfEmptyComponent) {
		current = current.inner;
	}
	return current;
}

// --- Stacked border merging & historical thinking collapse ---

function isBorderedToolComponent(value: unknown): value is ToolExecutionLike {
	if (!value || typeof value !== "object") return false;
	const candidate = value as ToolExecutionLike;
	return (
		candidate.hasRendererDefinition?.() === true &&
		candidate.getRenderShell?.() === "self" &&
		candidate.callRendererComponent instanceof BorderedBox
	);
}

function isAssistantMessageWithThinking(value: unknown): value is AssistantMessageLike {
	if (!value || typeof value !== "object") return false;
	if (
		typeof AssistantMessageComponent === "function" &&
		!(value instanceof AssistantMessageComponent)
	) {
		return false;
	}
	const content = (value as AssistantMessageLike).lastMessage?.content;
	return (
		Array.isArray(content) &&
		content.some(
			(b) => b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0,
		)
	);
}

function toggleThinkingRunOverride(
	overrides: Map<number, boolean>,
	runIndex: number,
	shouldHide: boolean,
): boolean {
	if (shouldHide) {
		if (overrides.has(runIndex)) return false;
		overrides.set(runIndex, true);
		return true;
	}
	if (overrides.get(runIndex) !== true) return false;
	overrides.delete(runIndex);
	return true;
}

function applyThinkingAutoCollapse(msg: AssistantMessageLike, shouldHide: boolean): void {
	if (msg.hideThinkingBlock === true) return;
	const overrides = msg.thinkingVisibilityOverrides;
	const content = msg.lastMessage?.content;
	if (!overrides || !content || typeof msg.updateContent !== "function") return;
	if ((msg[THINKING_AUTO_HIDDEN_KEY] === true) === shouldHide) return;

	msg[THINKING_AUTO_HIDDEN_KEY] = shouldHide;

	let runIndex = 0;
	let inRun = false;
	let changed = false;
	for (const block of content) {
		const isThinking = block?.type === "thinking";
		if (!isThinking) {
			inRun = false;
			continue;
		}
		const hasText = typeof block.thinking === "string" && block.thinking.trim().length > 0;
		if (!inRun && hasText) {
			if (toggleThinkingRunOverride(overrides, runIndex, shouldHide)) changed = true;
			runIndex++;
			inRun = true;
		}
	}

	if (changed) msg.updateContent(msg.lastMessage, msg.isStreaming);
}

function syncLatestTool(
	lastBordered: ToolExecutionLike | undefined,
	tracker: ActiveToolTracker | undefined,
): void {
	if (!tracker || !lastBordered?.toolCallId || tracker.lastToolCallId === lastBordered.toolCallId) {
		return;
	}
	const prevInvalidate = tracker.lastInvalidate;
	tracker.lastToolCallId = lastBordered.toolCallId;
	tracker.lastInvalidate = lastBordered.invalidate?.bind(lastBordered);
	lastBordered.invalidate?.();
	if (prevInvalidate && prevInvalidate !== tracker.lastInvalidate) {
		prevInvalidate();
	}
}

function syncTranscriptChildren(
	children: readonly unknown[],
	tracker: ActiveToolTracker | undefined,
): void {
	let lastThinkingIndex = -1;
	let lastBordered: ToolExecutionLike | undefined;

	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (isAssistantMessageWithThinking(child)) {
			lastThinkingIndex = i;
		} else if (tracker && isBorderedToolComponent(child) && child.toolCallId) {
			tracker.seenToolCallIds.add(child.toolCallId);
			lastBordered = child;
		}
	}

	if (lastThinkingIndex !== -1) {
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (isAssistantMessageWithThinking(child)) {
				applyThinkingAutoCollapse(child, i !== lastThinkingIndex && !child.isStreaming);
			}
		}
	}

	syncLatestTool(lastBordered, tracker);
}

function renderMergedStackContainer(
	container: ContainerLike,
	width: number,
	originalContainerRender: (width: number) => string[],
	tracker?: ActiveToolTracker,
): string[] {
	const children = container.children;
	if (!Array.isArray(children)) {
		return originalContainerRender.call(container, width);
	}

	syncTranscriptChildren(children, tracker);
	if (!children.some(isBorderedToolComponent)) {
		return originalContainerRender.call(container, width);
	}

	const lines: string[] = [];
	const mouseChildren: Array<{ component: Component; height: number }> = [];
	let prevWasBordered = false;

	for (const child of children) {
		const component = child as Component;
		const childLines = component.render(width);
		const bordered = isBorderedToolComponent(child);
		const lastLine = lines.at(-1);
		const topMatch =
			bordered &&
			prevWasBordered &&
			lastLine !== undefined &&
			childLines.length > 0 &&
			BOTTOM_BORDER_RE.test(lastLine)
				? TOP_BORDER_RE.exec(childLines[0])
				: null;

		if (topMatch) {
			lines[lines.length - 1] = `${topMatch[1]}├${topMatch[2]}┤${topMatch[3]}`;
			if (bordered) child[MERGED_TOP_KEY] = true;
			const merged = childLines.slice(1);
			mouseChildren.push({ component, height: merged.length });
			lines.push(...merged);
			prevWasBordered = true;
			continue;
		}

		if (bordered) child[MERGED_TOP_KEY] = false;
		mouseChildren.push({ component, height: childLines.length });
		lines.push(...childLines);
		prevWasBordered = bordered && childLines.length > 0;
	}

	container.mouseLayout = { width, children: mouseChildren };
	return lines;
}

interface GlobalWithStackPatch {
	[STACK_PATCH_KEY]?: {
		toolProto: ToolExecutionProto;
		containerProto: ContainerProto;
		originalToolRender: (width: number) => string[];
		originalToolMouse: (event: MouseEventArg) => MouseDispatchReturn;
		originalContainerRender: (width: number) => string[];
	};
}

function renderPatchedBorderedTool(
	instance: ToolExecutionLike,
	width: number,
	originalToolRender: (width: number) => string[],
): string[] {
	const lines = originalToolRender.call(instance, width);
	if (!isBorderedToolComponent(instance)) return lines;
	const stripped = lines[0] === "" ? lines.slice(1) : lines;
	if (
		instance.resultRendererComponent === EMPTY_TEXT &&
		typeof instance.selfRenderHeight === "number" &&
		stripped.length > instance.selfRenderHeight
	) {
		return stripped.slice(0, instance.selfRenderHeight);
	}
	return stripped;
}

function handlePatchedBorderedMouse(
	instance: ToolExecutionLike,
	event: MouseEventArg,
	originalToolMouse: (event: MouseEventArg) => MouseDispatchReturn,
): MouseDispatchReturn {
	if (!isBorderedToolComponent(instance)) return originalToolMouse.call(instance, event);
	const selfHeight = instance.selfRenderHeight ?? 0;
	const mappedY = event.y + (instance[MERGED_TOP_KEY] ? 1 : 0);
	if (mappedY < 0 || mappedY >= selfHeight) return undefined;
	return instance.selfRenderContainer?.handleMouse({ ...event, y: mappedY, height: selfHeight });
}

/**
 * Strips Pi's blank spacer row on bordered tools, hides inline images when collapsed,
 * merges touching `└───┘` + `┌───┐` rows into shared `├───┤` dividers (with mouse offset),
 * and auto-collapses historical thinking blocks. Restores on `/reload`.
 */
export function patchBorderedToolStack(
	toolProto: ToolExecutionProto | undefined = ToolExecutionComponent?.prototype as
		| ToolExecutionProto
		| undefined,
	containerProto: ContainerProto | undefined = Container?.prototype as
		| ContainerProto
		| undefined,
	tracker?: ActiveToolTracker,
): () => void {
	if (!toolProto || !containerProto) return () => {};

	const globalStore = globalThis as GlobalWithStackPatch;
	const existing = globalStore[STACK_PATCH_KEY];
	const originalToolRender = existing?.originalToolRender ?? toolProto.render;
	const originalToolMouse = existing?.originalToolMouse ?? toolProto.handleMouse;
	const originalContainerRender = existing?.originalContainerRender ?? containerProto.render;

	if (
		typeof originalToolRender !== "function" ||
		typeof originalToolMouse !== "function" ||
		typeof originalContainerRender !== "function"
	) {
		return () => {};
	}

	globalStore[STACK_PATCH_KEY] = {
		toolProto,
		containerProto,
		originalToolRender,
		originalToolMouse,
		originalContainerRender,
	};

	toolProto.render = function patchedBorderedToolRender(this: ToolExecutionLike, width: number) {
		return renderPatchedBorderedTool(this, width, originalToolRender);
	};
	toolProto.handleMouse = function patchedBorderedToolMouse(
		this: ToolExecutionLike,
		event: MouseEventArg,
	) {
		return handlePatchedBorderedMouse(this, event, originalToolMouse);
	};
	containerProto.render = function patchedBorderedStackContainerRender(
		this: ContainerLike,
		width: number,
	) {
		return renderMergedStackContainer(this, width, originalContainerRender, tracker);
	};

	return () => {
		const saved = globalStore[STACK_PATCH_KEY];
		if (!saved) return;
		saved.toolProto.render = saved.originalToolRender;
		saved.toolProto.handleMouse = saved.originalToolMouse;
		saved.containerProto.render = saved.originalContainerRender;
		delete globalStore[STACK_PATCH_KEY];
	};
}

// --- Command & script summarization ---

function formatSummaryList(items: readonly string[]): string {
	return items.length <= MAX_SUMMARY_TOOLS
		? items.join(" · ")
		: `${items.slice(0, MAX_SUMMARY_TOOLS).join(" · ")} +${items.length - MAX_SUMMARY_TOOLS}`;
}

function clipText(text: string): string {
	return text.length > MAX_SINGLE_LINE_CHARS
		? `${text.slice(0, MAX_SINGLE_LINE_CHARS - 1)}…`
		: text;
}

function normalizeBinary(token: string): string {
	const cleaned = token.replace(/^['"]|['"]$/g, "");
	const base = cleaned.split("/").pop() ?? cleaned;
	return base.replace(/\.(mjs|cjs|js|ts|sh)$/, "");
}

function isValidCommandToken(name: string): boolean {
	return name.length > 0 && !name.startsWith("-") && VALID_BINARY_RE.test(name);
}

function stripCommandPrefix(tokens: string[]): string[] {
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (ENV_ASSIGN_RE.test(token)) {
			if (token.includes("$(") || token.includes("`")) return [];
			i++;
		} else if (token === "nodenv" && tokens[i + 1] === "exec") {
			i += 2;
		} else if (token === "env" || token === "exec" || token === "sudo" || token === "nohup") {
			i++;
		} else {
			break;
		}
	}
	return tokens.slice(i);
}

function resolveSubcommandLabel(binary: string, tokens: string[]): string | undefined {
	const argIndex = tokens.findIndex((t, idx) => idx > 0 && !t.startsWith("-"));
	if (argIndex === -1) return undefined;
	const arg = tokens[argIndex];
	if (RUNNER_WRAPPERS.has(binary) && (arg === "run" || arg === "exec") && tokens[argIndex + 1]) {
		const script = normalizeBinary(tokens[argIndex + 1]);
		if (isValidCommandToken(script)) return `${binary} ${script}`;
	}
	return isValidCommandToken(arg) ? `${binary} ${arg}` : undefined;
}

function labelForSegment(segment: string): string | undefined {
	const trimmed = segment.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;

	const tokens = stripCommandPrefix(trimmed.split(/\s+/));
	if (tokens.length === 0) return undefined;

	const first = normalizeBinary(tokens[0]);
	if (!isValidCommandToken(first) || SHELL_KEYWORDS.has(first)) return undefined;

	if (first === "node" && tokens[1] && !tokens[1].startsWith("-")) {
		const script = normalizeBinary(tokens[1]);
		if (isValidCommandToken(script)) return script;
	}

	return SUBCOMMAND_TOOLS.has(first) ? (resolveSubcommandLabel(first, tokens) ?? first) : first;
}

function stripQuotedText(
	line: string,
	initialQuote: "'" | '"' | undefined,
): { unquoted: string; openQuote: "'" | '"' | undefined } {
	let openQuote = initialQuote;
	let out = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (openQuote === "'") {
			if (ch === "'") openQuote = undefined;
		} else if (openQuote === '"') {
			if (ch === "\\" && i + 1 < line.length) i++;
			else if (ch === '"') openQuote = undefined;
		} else if (ch === "\\" && i + 1 < line.length) {
			out += ch + line[++i];
		} else if (ch === "'" || ch === '"') {
			openQuote = ch;
			out += " ";
		} else {
			out += ch;
		}
	}
	return { unquoted: out, openQuote };
}

export function summarizeBashCommand(command: string): string {
	const lines = command.replace(/\r\n/g, "\n").split("\n");
	const labels: string[] = [];
	const seen = new Set<string>();
	let heredocEnd: string | undefined;
	let openQuote: "'" | '"' | undefined;

	for (const line of lines) {
		if (heredocEnd) {
			if (line.trim() === heredocEnd) heredocEnd = undefined;
			continue;
		}

		const startedInQuote = openQuote !== undefined;
		const stripped = stripQuotedText(line, openQuote);
		openQuote = stripped.openQuote;
		if (startedInQuote) continue;

		const heredocMatch = HEREDOC_RE.exec(line);
		const commandPart = heredocMatch
			? stripped.unquoted.slice(0, stripped.unquoted.indexOf("<<"))
			: stripped.unquoted;
		if (heredocMatch) heredocEnd = heredocMatch[1];

		for (const segment of commandPart.split(/&&|\|\||;|\|/)) {
			const label = labelForSegment(segment);
			if (label && !seen.has(label)) {
				seen.add(label);
				labels.push(label);
			}
		}
	}

	if (labels.length === 0) {
		return clipText(lines.find((l) => l.trim().length > 0)?.trim() ?? "...");
	}
	return formatSummaryList(labels);
}

export function compactBashCommand(command: string): {
	text: string;
	compacted: boolean;
	lineCount: number;
} {
	const normalized = command.replace(/\r\n/g, "\n").trimEnd();
	const lineCount = normalized.split("\n").length;

	if (lineCount === 1 && normalized.length <= MAX_SINGLE_LINE_CHARS) {
		return { text: normalized, compacted: false, lineCount };
	}
	return {
		text: lineCount === 1 ? clipText(normalized) : summarizeBashCommand(normalized),
		compacted: true,
		lineCount,
	};
}

export function summarizeCodemodeScript(code: string): { summary: string; lineCount: number } {
	const normalized = code.replace(/\r\n/g, "\n").trimEnd();
	const lines = normalized.split("\n");
	const counts = new Map<string, number>();

	for (const match of normalized.matchAll(CODEMODE_TOOL_CALL_RE)) {
		counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
	}

	if (counts.size > 0) {
		const parts = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name));
		return { summary: formatSummaryList(parts), lineCount: lines.length };
	}

	const firstLine =
		lines.find((l) => l.trim().length > 0 && !l.trim().startsWith("//"))?.trim() ?? "...";
	return { summary: clipText(firstLine), lineCount: lines.length };
}

function formatDurationSuffix(ms: number | undefined, theme: ToolRenderTheme): string {
	if (ms === undefined) return "";
	let label: string;
	if (ms < 1000) label = `${Math.round(ms)}ms`;
	else if (ms < 60_000) label = `${(ms / 1000).toFixed(1)}s`;
	else label = `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	return theme.fg("muted", ` · ${label}`);
}

// --- Unified tool renderer wrapper ---

function renderBashCallInner(
	baseRenderCall: NonNullable<ToolRenderers["renderCall"]>,
	args: unknown,
	theme: ToolRenderTheme,
	context: Parameters<NonNullable<ToolRenderers["renderCall"]>>[2],
	showExpanded: boolean,
	prevInner: Component | undefined,
): Component {
	const bashArgs = (args ?? {}) as { command?: string };
	const rawCommand = typeof bashArgs.command === "string" ? bashArgs.command : "";
	const textComponent =
		prevInner instanceof CompactBashText ? prevInner : new CompactBashText("", 0, 0);

	if (showExpanded || !rawCommand) {
		textComponent.suffix = "";
		return baseRenderCall(args, theme, {
			...context,
			expanded: showExpanded,
			lastComponent: textComponent,
		});
	}

	const compacted = compactBashCommand(rawCommand);
	const duration = formatDurationSuffix(context.durationMs, theme);
	if (!compacted.compacted) {
		textComponent.suffix = duration;
		return baseRenderCall(args, theme, { ...context, lastComponent: textComponent });
	}

	const lineMeta = compacted.lineCount > 1 ? ` (${compacted.lineCount} lines)` : "";
	textComponent.suffix = theme.fg("muted", lineMeta) + duration;
	return baseRenderCall(
		{ ...bashArgs, command: compacted.text },
		theme,
		{ ...context, lastComponent: textComponent },
	);
}

function renderCodemodeCallInner(
	baseRenderCall: ToolRenderers["renderCall"],
	args: unknown,
	theme: ToolRenderTheme,
	context: Parameters<NonNullable<ToolRenderers["renderCall"]>>[2],
	showExpanded: boolean,
	prevInner: Component | undefined,
): Component {
	if (showExpanded && baseRenderCall) {
		return baseRenderCall(args, theme, {
			...context,
			expanded: true,
			lastComponent: prevInner instanceof Container ? prevInner : undefined,
		});
	}

	const code = (args as { code?: unknown } | undefined)?.code;
	const title = theme.fg("toolTitle", theme.bold("codemode"));
	const textComponent = prevInner instanceof Text ? prevInner : new Text("", 0, 0);
	const duration = formatDurationSuffix(context.durationMs, theme);

	if (typeof code !== "string" || !code.trim()) {
		textComponent.setText(`${title}${duration}`);
		return textComponent;
	}

	const { summary, lineCount } = summarizeCodemodeScript(code);
	const meta = lineCount > 1 ? theme.fg("muted", ` (${lineCount} lines)`) : "";
	textComponent.setText(`${title} ${theme.fg("accent", summary)}${meta}${duration}`);
	return textComponent;
}

function extractFallbackResultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: string; text?: string } => Boolean(item) && typeof item === "object")
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("\n")
		.trim();
}

function renderCallInner(
	toolName: string,
	baseRenderCall: ToolRenderers["renderCall"],
	args: unknown,
	theme: ToolRenderTheme,
	context: Parameters<NonNullable<ToolRenderers["renderCall"]>>[2],
	showExpanded: boolean,
): Component {
	const prevInner = unwrapInner(context.lastComponent);
	let rendered: Component;

	if (toolName === "bash" && baseRenderCall) {
		rendered = renderBashCallInner(baseRenderCall, args, theme, context, showExpanded, prevInner);
	} else if (toolName === "codemode") {
		rendered = renderCodemodeCallInner(baseRenderCall, args, theme, context, showExpanded, prevInner);
	} else if (!baseRenderCall) {
		const header = theme.fg("toolTitle", theme.bold(toolName));
		const duration = showExpanded ? "" : formatDurationSuffix(context.durationMs, theme);
		rendered = new Text(`${header}${duration}`, 0, 0);
	} else {
		rendered = baseRenderCall(args, theme, {
			...context,
			expanded: showExpanded,
			lastComponent: prevInner,
		});
	}

	return showExpanded ? rendered : new SingleLineComponent(rendered);
}

function renderResultInner(
	toolName: string,
	baseRenderResult: ToolRenderers["renderResult"],
	result: Parameters<NonNullable<ToolRenderers["renderResult"]>>[0],
	options: Parameters<NonNullable<ToolRenderers["renderResult"]>>[1],
	theme: ToolRenderTheme,
	context: Parameters<NonNullable<ToolRenderers["renderResult"]>>[3],
): Component | undefined {
	if (!baseRenderResult) {
		if (toolName === "codemode") return undefined;
		const text = extractFallbackResultText(result.content);
		return new Text(text ? theme.fg("toolOutput", text) : "", 0, 0);
	}
	const prev = context.lastComponent === EMPTY_TEXT ? undefined : unwrapInner(context.lastComponent);
	const lastComponent =
		toolName === "codemode" ? (prev instanceof Container ? prev : undefined) : prev;
	const rendered = baseRenderResult(
		result,
		{ ...options, expanded: true },
		theme,
		{ ...context, expanded: true, lastComponent },
	);
	if (!options.isPartial && toolName !== "codemode") {
		const fallbackText = extractFallbackResultText(result.content);
		if (fallbackText) {
			return new FallbackIfEmptyComponent(rendered, theme.fg("toolOutput", fallbackText));
		}
	}
	return rendered;
}

function wrapToolRenderer(
	toolName: string,
	base: ToolRenderers,
	tracker: ActiveToolTracker,
): ToolRenderers {
	const wrapSelfShell = base.renderShell !== "self";
	const renderShell = wrapSelfShell ? ("self" as const) : base.renderShell;

	return {
		...base,
		renderShell,
		renderCall(args, theme, context) {
			const showExpanded = shouldExpandTool(tracker, context);
			const inner = renderCallInner(toolName, base.renderCall, args, theme, context, showExpanded);
			return wrapSelfShell
				? wrapBordered("call", inner, context.lastComponent, context, theme)
				: inner;
		},
		renderResult(result, options, theme, context) {
			const showExpanded = shouldExpandTool(tracker, {
				...context,
				isPartial: options.isPartial,
				expanded: options.expanded,
			});
			if (!showExpanded) return EMPTY_TEXT;
			const inner = renderResultInner(toolName, base.renderResult, result, options, theme, context);
			if (!inner) return EMPTY_TEXT;
			return wrapSelfShell
				? wrapBordered("result", inner, context.lastComponent, context, theme)
				: inner;
		},
	};
}

export default function compactBashCallExtension(pi: ExtensionAPI): void {
	const tracker: ActiveToolTracker = { seenToolCallIds: new Set() };
	const restoreStackPatch = patchBorderedToolStack(
		ToolExecutionComponent?.prototype as ToolExecutionProto | undefined,
		Container?.prototype as ContainerProto | undefined,
		tracker,
	);
	pi.on("session_shutdown", () => {
		restoreStackPatch();
	});

	pi.registerToolRenderer((toolName, next): ToolRenderers | undefined => {
		const base = next();
		return base ? wrapToolRenderer(toolName, base, tracker) : base;
	});
}
