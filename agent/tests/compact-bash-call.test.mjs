import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const piTuiEntry = pathToFileURL(
	path.resolve(
		import.meta.dirname,
		"../install/releases/1.5.2/node_modules/@earendil-works/pi-tui/dist/index.js",
	),
).href;

const fakeCodingAgentUrl =
	"data:text/javascript,export class ToolExecutionComponent {} export class AssistantMessageComponent {}";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-tui") {
			return { url: piTuiEntry, shortCircuit: true };
		}
		if (specifier === "@earendil-works/pi-coding-agent") {
			return { url: fakeCodingAgentUrl, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

const { Container, stripTerminalSequences, Text } = await import("@earendil-works/pi-tui");
const {
	default: compactBashCallExtension,
	compactBashCommand,
	patchBorderedToolStack,
	summarizeBashCommand,
	summarizeCodemodeScript,
} = await import("../extensions/compact-bash-call.ts");

const theme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function loadResolver() {
	let resolver;
	compactBashCallExtension({
		on() {},
		registerToolRenderer(fn) {
			resolver = fn;
		},
	});
	return resolver;
}

function stripBoxSides(line) {
	return line.replace(/^│/, "").replace(/│$/, "").trim();
}

test("short single-line command stays untouched; multi-line commands compact", () => {
	const oneLine = compactBashCommand("git status --short");
	assert.equal(oneLine.compacted, false);
	assert.equal(oneLine.text, "git status --short");

	const twoLines = compactBashCommand("cd /tmp\nls -la");
	assert.equal(twoLines.compacted, true);
	assert.equal(twoLines.lineCount, 2);
	assert.equal(twoLines.text, "ls");
});

test("long single-line command truncates with ellipsis", () => {
	const longCmd = `echo ${"a".repeat(150)}`;
	const result = compactBashCommand(longCmd);
	assert.equal(result.compacted, true);
	assert.equal(result.lineCount, 1);
	assert.equal(result.text.length, 120);
	assert.ok(result.text.endsWith("…"));
});

test("multi-line script summarizes tools and skips heredoc body", () => {
	const script = [
		'cd /Users/nanw/Projects/gogo-web || exit "$?"',
		'd=$(mktemp -d /tmp/eng15205-redeem-error.XXXXXX) || exit "$?"',
		"f=src/components/Main/Operator/RideRegistration/CreateUpdateCustomer.vue",
		'NODENV_VERSION=26.7.0 nodenv exec node ./node_modules/eslint/bin/eslint.js "$f" --cache --format json',
		"lint_exit=$?",
		'git show HEAD:"$f" > "$d/head.vue" || exit "$?"',
		'NODENV_VERSION=26.7.0 nodenv exec node ./node_modules/vitest/vitest.mjs run tests/unit/PromoInventory.spec.ts',
		"test_exit=$?",
		"python3 - \"$d\" <<'PY'",
		"import json, sys",
		"from pathlib import Path",
		"print('ignored inside heredoc')",
		"PY",
		'printf \'{"lintExit":%s}\\n\' "$lint_exit"',
		'git diff --unified=3 -- "$f"',
	].join("\n");

	const result = compactBashCommand(script);
	assert.equal(result.compacted, true);
	assert.equal(result.lineCount, 15);
	assert.equal(result.text, "eslint · git show · vitest · python3 +1");
});

test("multi-line shell-only script falls back to first line", () => {
	const script = ["cd /tmp", "echo hello", "echo world"].join("\n");
	assert.equal(summarizeBashCommand(script), "cd /tmp");
});

test("codemode script summarizes called tools with counts", () => {
	const code = [
		"const r = await Promise.allSettled([",
		'  tools.bash({command: "echo 1"}),',
		'  tools.bash({command: "echo 2"}),',
		'  tools.lens_diagnostics({source: "lsp"}),',
		'  tools.bash({command: "echo 3"}),',
		"]);",
		"return r;",
	].join("\n");

	const summary = summarizeCodemodeScript(code);
	assert.equal(summary.lineCount, 7);
	assert.equal(summary.summary, "bash×3 · lens_diagnostics");
});

test("bash stays expanded while running, collapses to 1 bordered row when done (including errors), and expands on click", () => {
	const resolver = loadResolver();
	let lastCallArgs;
	let lastResultExpanded;

	const base = {
		renderCall(args, _theme, context) {
			lastCallArgs = args;
			const text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(`$ ${args.command}`);
			return text;
		},
		renderResult(result, options) {
			lastResultExpanded = options.expanded;
			return new Text(result.content[0]?.text ?? "", 0, 0);
		},
	};

	const wrapped = resolver("bash", () => base);
	assert.equal(wrapped.renderShell, "self");
	const longScript = "cd /repo\nnpm run lint\nnpm run test\ngit diff";
	const rowState = {};

	// Running (isPartial=true): expanded call + expanded result share one border via ├─┤.
	const runningCall = wrapped.renderCall(
		{ command: longScript },
		theme,
		{ isPartial: true, expanded: false, state: rowState, lastComponent: undefined },
	);
	const runningResult = wrapped.renderResult(
		{ content: [{ type: "text", text: "live line 1\nlive line 2" }] },
		{ isPartial: true, expanded: false },
		theme,
		{ isPartial: true, expanded: false, state: rowState },
	);
	assert.equal(lastCallArgs.command, longScript);
	assert.equal(lastResultExpanded, true);

	const runningCallLines = runningCall.render(60);
	const runningResultLines = runningResult.render(60);
	assert.equal(runningCallLines[0], `┌${"─".repeat(58)}┐`);
	assert.equal(runningCallLines.length, 5); // top border + 4 command lines (bottom suppressed by result)
	assert.equal(runningResultLines[0], `├${"─".repeat(58)}┤`);
	assert.deepEqual(
		runningResultLines.slice(1, -1).map(stripBoxSides),
		["live line 1", "live line 2"],
	);
	assert.equal(runningResultLines.at(-1), `└${"─".repeat(58)}┘`);

	// Finished (isPartial=false, expanded=false, including error): 3-row bordered 1-liner, empty result.
	const collapsedCall = wrapped.renderCall(
		{ command: longScript },
		theme,
		{ isPartial: false, expanded: false, isError: true, durationMs: 2400, state: rowState, lastComponent: runningCall },
	);
	const collapsedResult = wrapped.renderResult(
		{ content: [{ type: "text", text: "error details" }], isError: true },
		{ isPartial: false, expanded: false },
		theme,
		{ isPartial: false, expanded: false, isError: true, state: rowState },
	);
	assert.equal(lastCallArgs.command, "npm lint · npm test · git diff");
	const collapsedLines = collapsedCall.render(60);
	assert.equal(collapsedLines.length, 3);
	assert.equal(collapsedLines[0], `┌${"─".repeat(58)}┐`);
	assert.equal(stripBoxSides(collapsedLines[1]), "● $ npm lint · npm test · git diff (4 lines) · 2.4s");
	assert.equal(collapsedLines[2], `└${"─".repeat(58)}┘`);
	assert.deepEqual(collapsedResult.render(60), []);

	// Clicked / expanded: full call + divider + full result.
	const expandedCall = wrapped.renderCall(
		{ command: longScript },
		theme,
		{ isPartial: false, expanded: true, state: rowState, lastComponent: collapsedCall },
	);
	const expandedResult = wrapped.renderResult(
		{ content: [{ type: "text", text: "full output" }] },
		{ isPartial: false, expanded: true },
		theme,
		{ isPartial: false, expanded: true, state: rowState, lastComponent: collapsedResult },
	);
	assert.equal(lastCallArgs.command, longScript);
	assert.equal(expandedCall.render(60).length, 5);
	assert.equal(expandedResult.render(60)[0], `├${"─".repeat(58)}┤`);
	assert.equal(stripBoxSides(expandedResult.render(60)[1]), "full output");
	assert.equal(expandedResult.render(60)[2], `└${"─".repeat(58)}┘`);
});

test("codemode stays expanded while running, collapses to 1 bordered row when done, and expands on click", () => {
	const resolver = loadResolver();
	const seen = { callExpanded: [], resultExpanded: [] };

	const base = {
		renderCall(_args, _theme, context) {
			seen.callExpanded.push(context.expanded);
			const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
			container.clear();
			container.addChild(new Text("codemode\nfull script", 0, 0));
			return container;
		},
		renderResult(_result, options, _theme, context) {
			seen.resultExpanded.push(options.expanded);
			const container = context.lastComponent instanceof Container ? context.lastComponent : new Container();
			container.clear();
			container.addChild(new Text("✓ read\nfull output", 0, 0));
			return container;
		},
	};

	const wrapped = resolver("codemode", () => base);
	const script = "const a = 1;\nawait tools.bash({command:'ls'});\nawait tools.bash({command:'pwd'});\nawait tools.lens_diagnostics({});";
	const rowState = {};

	const runningCall = wrapped.renderCall(
		{ code: script },
		theme,
		{ isPartial: true, expanded: false, state: rowState, lastComponent: undefined },
	);
	const runningResult = wrapped.renderResult(
		{ content: [], details: { calls: [] } },
		{ isPartial: true, expanded: false },
		theme,
		{ isPartial: true, expanded: false, state: rowState, lastComponent: undefined },
	);
	assert.deepEqual(seen.callExpanded, [true]);
	assert.deepEqual(seen.resultExpanded, [true]);
	assert.equal(runningCall.render(80).length, 3); // top + 2 lines
	assert.equal(runningResult.render(80).length, 4); // divider + 2 lines + bottom

	const collapsedCall = wrapped.renderCall(
		{ code: script },
		theme,
		{ isPartial: false, expanded: false, durationMs: 75_000, state: rowState, lastComponent: runningCall },
	);
	const collapsedResult = wrapped.renderResult(
		{ content: [{ type: "text", text: "line 1\nline 2" }], details: { calls: [] } },
		{ isPartial: false, expanded: false },
		theme,
		{ isPartial: false, expanded: false, state: rowState, lastComponent: runningResult },
	);
	const collapsedLines = collapsedCall.render(80);
	assert.equal(collapsedLines.length, 3);
	assert.equal(stripBoxSides(collapsedLines[1]), "● codemode bash×2 · lens_diagnostics (4 lines) · 1m 15s");
	assert.deepEqual(collapsedResult.render(80), []);

	wrapped.renderCall({ code: script }, theme, {
		isPartial: false,
		expanded: true,
		state: rowState,
		lastComponent: collapsedCall,
	});
	wrapped.renderResult(
		{ content: [], details: { calls: [] } },
		{ isPartial: false, expanded: true },
		theme,
		{ isPartial: false, expanded: true, state: rowState, lastComponent: collapsedResult },
	);
	assert.deepEqual(seen.callExpanded, [true, true]);
	assert.deepEqual(seen.resultExpanded, [true, true]);
});

test("edit and other tools stay expanded while running, collapse to 1 bordered row when done, and expand on click", () => {
	const resolver = loadResolver();
	const base = {
		renderCall(_args, _theme, context) {
			return new Text(
				context.expanded ? "edit src/app.ts (3 lines)\npending diff line" : "edit src/app.ts (3 lines)\nextra line",
				0,
				0,
			);
		},
		renderResult() {
			return new Text("- old\n+ new", 0, 0);
		},
	};

	const wrapped = resolver("edit", () => base);
	const rowState = {};

	const runningCall = wrapped.renderCall(
		{ path: "src/app.ts" },
		theme,
		{ isPartial: true, expanded: false, state: rowState },
	);
	assert.equal(runningCall.render(60).length, 4); // top + 2 lines + bottom

	const collapsedCall = wrapped.renderCall(
		{ path: "src/app.ts" },
		theme,
		{ isPartial: false, expanded: false, state: rowState, lastComponent: runningCall },
	);
	const collapsedLines = collapsedCall.render(60);
	assert.equal(collapsedLines.length, 3);
	assert.equal(stripBoxSides(collapsedLines[1]), "● edit src/app.ts (3 lines)");

	const collapsedResult = wrapped.renderResult(
		{ content: [{ type: "text", text: "ok" }] },
		{ isPartial: false, expanded: false },
		theme,
		{ isPartial: false, expanded: false, state: rowState },
	);
	assert.deepEqual(collapsedResult.render(60), []);

	wrapped.renderCall(
		{ path: "src/app.ts" },
		theme,
		{ isPartial: false, expanded: true, state: rowState, lastComponent: collapsedCall },
	);
	const expandedResult = wrapped.renderResult(
		{ content: [{ type: "text", text: "ok" }] },
		{ isPartial: false, expanded: true },
		theme,
		{ isPartial: false, expanded: true, state: rowState, lastComponent: collapsedResult },
	);
	const expandedResultLines = expandedResult.render(60);
	assert.equal(expandedResultLines[0], `├${"─".repeat(58)}┤`);
	assert.deepEqual(expandedResultLines.slice(1, -1).map(stripBoxSides), ["- old", "+ new"]);
	assert.equal(expandedResultLines.at(-1), `└${"─".repeat(58)}┘`);
});

test("patchBorderedToolStack removes blank gap and merges adjacent tool boxes with shared ├───┤ dividers", () => {
	const resolver = loadResolver();
	const wrapped = resolver("read", () => ({
		renderCall: (args) => new Text(`read ${args.path}`, 0, 0),
		renderResult: () => new Text("ok", 0, 0),
	}));

	class FakeToolExecution {
		constructor(pathArg) {
			this.callRendererComponent = wrapped.renderCall(
				{ path: pathArg },
				theme,
				{ isPartial: false, expanded: false, outputPad: 1, state: {} },
			);
			this.selfRenderHeight = 3;
			this.lastMouse = undefined;
			this.selfRenderContainer = {
				handleMouse: (ev) => {
					this.lastMouse = ev;
					return { handled: true };
				},
			};
		}
		hasRendererDefinition() {
			return true;
		}
		getRenderShell() {
			return "self";
		}
		render(width) {
			return ["", ...this.callRendererComponent.render(width)];
		}
		handleMouse(ev) {
			return { original: ev.y };
		}
	}

	class FakeContainer {
		constructor(children) {
			this.children = children;
		}
		render(width) {
			return this.children.flatMap((c) => c.render(width));
		}
	}

	const restore = patchBorderedToolStack(FakeToolExecution.prototype, FakeContainer.prototype);
	try {
		const t1 = new FakeToolExecution("a.ts");
		const t2 = new FakeToolExecution("b.ts");
		const t3 = new FakeToolExecution("c.ts");
		const container = new FakeContainer([t1, t2, t3]);

		// 3 stacked blocks -> 7 rows total (2*3 + 1), shared ├───┤ dividers, 0 blank gaps.
		const lines = container.render(24);
		assert.equal(lines.length, 7);
		assert.equal(lines[0], `┌${"─".repeat(22)}┐`);
		assert.equal(stripBoxSides(lines[1]), "● read a.ts");
		assert.equal(lines[2], `├${"─".repeat(22)}┤`);
		assert.equal(stripBoxSides(lines[3]), "● read b.ts");
		assert.equal(lines[4], `├${"─".repeat(22)}┤`);
		assert.equal(stripBoxSides(lines[5]), "● read c.ts");
		assert.equal(lines[6], `└${"─".repeat(22)}┘`);

		// Mouse layout reflects merged heights (3, 2, 2).
		assert.deepEqual(
			container.mouseLayout.children.map((c) => c.height),
			[3, 2, 2],
		);

		// First block (unmerged top) forwards y=1 -> y=1; merged second block shifts y=0 -> y=1.
		t1.handleMouse({ y: 1, height: 3 });
		assert.equal(t1.lastMouse.y, 1);
		t2.handleMouse({ y: 0, height: 2 });
		assert.equal(t2.lastMouse.y, 1);
	} finally {
		restore();
	}
});

test("collapsed tools hide inline images, keep bash/codemode to 1 row on narrow widths, and show fallback text when expanded", () => {
	const resolver = loadResolver();

	// 1. Narrow terminal: long collapsed bash & codemode headers stay strictly 1 content row (3 rows w/ border).
	const bashWrapped = resolver("bash", () => ({
		renderCall: (args, _theme, ctx) => {
			const text = ctx.lastComponent ?? new Text("", 0, 0);
			text.setText(`$ ${args.command}`);
			return text;
		},
		renderResult: () => new Text("out", 0, 0),
	}));
	const longSingle = `echo ${"x".repeat(110)}`;
	const narrowBashLines = bashWrapped
		.renderCall({ command: longSingle }, theme, { isPartial: false, expanded: false, state: {} })
		.render(40);
	assert.equal(narrowBashLines.length, 3);
	assert.ok(stripTerminalSequences(stripBoxSides(narrowBashLines[1])).endsWith("…"));

	const codemodeWrapped = resolver("codemode", () => ({
		renderCall: () => new Container(),
		renderResult: () => new Container(),
	}));
	const narrowCodemodeLines = codemodeWrapped
		.renderCall(
			{
				code: "await tools.very_long_tool_name_one({});\nawait tools.very_long_tool_name_two({});\nawait tools.very_long_tool_name_three({});",
			},
			theme,
			{ isPartial: false, expanded: false, durationMs: 1200, state: {} },
		)
		.render(40);
	assert.equal(narrowCodemodeLines.length, 3);

	// 2. Expanded read/search/MCP whose base renderer returns empty (pi-tool-display hidden mode) falls back to content text.
	const hiddenReadWrapped = resolver("read", () => ({
		renderCall: () => new Text("read foo.ts", 0, 0),
		renderResult: () => new Text("", 0, 0),
	}));
	const expandedHiddenResult = hiddenReadWrapped.renderResult(
		{ content: [{ type: "text", text: "line A\nline B" }] },
		{ isPartial: false, expanded: true },
		theme,
		{ isPartial: false, expanded: true, state: {} },
	);
	assert.deepEqual(
		expandedHiddenResult.render(60).slice(1, -1).map(stripBoxSides),
		["line A", "line B"],
	);

	// 3. Collapsed tool with inline image rows suppresses images past selfRenderHeight.
	const readCallBox = hiddenReadWrapped.renderCall({ path: "img.png" }, theme, {
		isPartial: false,
		expanded: false,
		state: {},
	});
	const collapsedEmptyResult = hiddenReadWrapped.renderResult(
		{ content: [{ type: "image", data: "abc", mimeType: "image/png" }] },
		{ isPartial: false, expanded: false },
		theme,
		{ isPartial: false, expanded: false, state: {} },
	);

	class FakeImageToolExecution {
		constructor() {
			this.callRendererComponent = readCallBox;
			this.resultRendererComponent = collapsedEmptyResult;
			this.selfRenderHeight = 3;
		}
		hasRendererDefinition() {
			return true;
		}
		getRenderShell() {
			return "self";
		}
		render(width) {
			return ["", ...this.callRendererComponent.render(width), "", "[INLINE IMAGE ROW]"];
		}
		handleMouse() {
			return undefined;
		}
	}
	class FakeContainer {
		render() {
			return [];
		}
	}
	const restore = patchBorderedToolStack(FakeImageToolExecution.prototype, FakeContainer.prototype);
	try {
		const imgTool = new FakeImageToolExecution();
		const lines = imgTool.render(30);
		assert.equal(lines.length, 3);
		assert.ok(!lines.some((line) => line.includes("INLINE IMAGE")));
	} finally {
		restore();
	}
});

test("tool calls render with no background fill and status-colored ● + tool name (green normal, red error)", () => {
	const resolver = loadResolver();
	const taggedTheme = {
		fg: (color, text) => `<fg:${color}>${text}</fg>`,
		bg: (color, text) => `<bg:${color}>${text}</bg>`,
		bold: (text) => text,
	};

	const wrapped = resolver("read", () => ({
		renderCall: () => new Text("\x1b[38;2;222;224;225mread\x1b[39m src/foo.ts", 0, 0),
		renderResult: () => new Text("ok", 0, 0),
	}));

	const okLines = wrapped
		.renderCall({ path: "src/foo.ts" }, taggedTheme, {
			isPartial: false,
			expanded: false,
			isError: false,
			outputPad: 1,
			state: {},
		})
		.render(40);
	assert.ok(!okLines.some((line) => line.includes("<bg:")));
	assert.ok(okLines[1].includes("<fg:success>● read</fg> src/foo.ts"));

	const errLines = wrapped
		.renderCall({ path: "src/foo.ts" }, taggedTheme, {
			isPartial: false,
			expanded: false,
			isError: true,
			outputPad: 1,
			state: {},
		})
		.render(40);
	assert.ok(!errLines.some((line) => line.includes("<bg:")));
	assert.ok(errLines[1].includes("<fg:error>● read</fg> src/foo.ts"));
});

test("concurrent pending tools stop invalidating each other and keep the newest result expanded", async (context) => {
	const { ToolExecutionComponent } = await import(
		"../install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js"
	);
	const { initTheme } = await import(
		"../install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js"
	);
	initTheme("dark");
	const resolver = loadResolver();
	const pending = [];
	context.mock.method(globalThis, "queueMicrotask", (callback) => pending.push(callback));

	function createPendingTool(toolName, toolCallId) {
		const renderers = resolver(toolName, () => ({
			renderCall(args, _theme, renderContext) {
				const text = renderContext.lastComponent ?? new Text("", 0, 0);
				text.setText(`${toolName} ${args.path}`);
				return text;
			},
			renderResult(result) {
				return new Text(result.content[0]?.text ?? "", 0, 0);
			},
		}));
		return new ToolExecutionComponent(
			toolName,
			toolCallId,
			{ path: "agent/extensions/compact-bash-call.ts" },
			{},
			renderers,
			{ requestRender() {} },
			process.cwd(),
		);
	}

	const older = createPendingTool("read", "read-1");
	const latest = createPendingTool("ls", "ls-2");
	assert.equal(pending.length, 1);

	for (let processed = 0; processed < 20 && pending.length > 0; processed++) {
		pending.shift()();
	}
	assert.equal(pending.length, 0, "pending tools must not schedule an endless invalidation loop");

	latest.updateResult({ content: [{ type: "text", text: "latest output" }] });
	older.invalidate();
	assert.equal(pending.length, 0);
	older.updateResult({ content: [{ type: "text", text: "older output" }] });

	assert.deepEqual(older.resultRendererComponent.render(60), []);
	const latestOutputLine = stripTerminalSequences(latest.resultRendererComponent.render(60)[1]);
	assert.equal(stripBoxSides(latestOutputLine), "latest output");
});

test("last tool call stays expanded after finishing until a newer tool call starts (and still toggles on click)", async () => {
	const resolver = loadResolver();
	const wrapped = resolver("bash", () => ({
		renderCall(args, _theme, context) {
			const text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(`$ ${args.command}`);
			return text;
		},
		renderResult(result) {
			return new Text(result.content[0]?.text ?? "", 0, 0);
		},
	}));

	const script = "cd /repo\nnpm run lint\nnpm run test";
	const state1 = {};
	let invalidated1 = 0;

	// Tool 1 starts running.
	const call1Running = wrapped.renderCall({ command: script }, theme, {
		toolCallId: "call-1",
		isPartial: true,
		expanded: false,
		state: state1,
		invalidate: () => {
			invalidated1++;
		},
	});
	assert.equal(call1Running.render(60).length, 5); // top + 3 lines + bottom

	// Tool 1 finishes: still the latest tool call, so it stays expanded with output.
	const call1Done = wrapped.renderCall({ command: script }, theme, {
		toolCallId: "call-1",
		isPartial: false,
		expanded: false,
		state: state1,
		lastComponent: call1Running,
	});
	const res1Done = wrapped.renderResult(
		{ content: [{ type: "text", text: "all passed" }] },
		{ isPartial: false, expanded: false },
		theme,
		{ toolCallId: "call-1", isPartial: false, expanded: false, state: state1 },
	);
	assert.equal(call1Done.render(60).length, 4); // top + 3 lines (bottom suppressed by result)
	assert.equal(stripBoxSides(res1Done.render(60)[1]), "all passed");

	// User clicks the latest tool call (expanded flips false -> true): toggles collapsed.
	const call1Clicked = wrapped.renderCall({ command: script }, theme, {
		toolCallId: "call-1",
		isPartial: false,
		expanded: true,
		state: state1,
		lastComponent: call1Done,
	});
	const res1Clicked = wrapped.renderResult(
		{ content: [{ type: "text", text: "all passed" }] },
		{ isPartial: false, expanded: true },
		theme,
		{ toolCallId: "call-1", isPartial: false, expanded: true, state: state1 },
	);
	assert.equal(call1Clicked.render(60).length, 3);
	assert.equal(stripBoxSides(call1Clicked.render(60)[1]), "● $ npm lint · npm test (3 lines)");
	assert.deepEqual(res1Clicked.render(60), []);

	// Tool 2 starts running: Tool 1 gets invalidated and collapses; Tool 2 stays expanded when done.
	const state2 = {};
	wrapped.renderCall({ command: script }, theme, {
		toolCallId: "call-2",
		isPartial: true,
		expanded: false,
		state: state2,
	});
	await Promise.resolve();
	assert.equal(invalidated1, 1);

	const call1AfterTool2 = wrapped.renderCall({ command: script }, theme, {
		toolCallId: "call-1",
		isPartial: false,
		expanded: true, // Pi still holds expanded=true from the click that collapsed call-1 while latest
		state: state1,
		lastComponent: call1Clicked,
	});
	assert.equal(call1AfterTool2.render(60).length, 3, "manually collapsed latest tool must stay collapsed when superseded");

	// Clicking call-1 again now toggles expanded true -> false and opens it.
	const call1Reopened = wrapped.renderCall({ command: script }, theme, {
		toolCallId: "call-1",
		isPartial: false,
		expanded: false,
		state: state1,
		lastComponent: call1AfterTool2,
	});
	assert.equal(call1Reopened.render(60).length, 5);

	const res2Done = wrapped.renderResult(
		{ content: [{ type: "text", text: "tool 2 output" }] },
		{ isPartial: false, expanded: false },
		theme,
		{ toolCallId: "call-2", isPartial: false, expanded: false, state: state2 },
	);
	assert.equal(stripBoxSides(res2Done.render(60)[1]), "tool 2 output");
});

test("historical thinking blocks auto-collapse while the last thinking block stays expanded and click-to-expand is respected", async () => {
	const { AssistantMessageComponent } = await import("@earendil-works/pi-coding-agent");

	class FakeAssistantMessage extends AssistantMessageComponent {
		constructor(thinkingText, isStreaming = false) {
			super();
			this.lastMessage = { content: [{ type: "thinking", thinking: thinkingText }, { type: "text", text: "answer" }] };
			this.hideThinkingBlock = false;
			this.thinkingVisibilityOverrides = new Map();
			this.isStreaming = isStreaming;
			this.updateCalls = 0;
		}
		updateContent(message, isStreaming) {
			this.lastMessage = message;
			this.isStreaming = isStreaming;
			this.updateCalls++;
		}
		render() {
			const hidden = this.thinkingVisibilityOverrides.get(0) ?? this.hideThinkingBlock;
			return [hidden ? "Thinking..." : `THINKING: ${this.lastMessage.content[0].thinking}`, "answer"];
		}
	}

	class FakeToolExecution {
		render() {
			return [];
		}
		handleMouse() {
			return undefined;
		}
	}

	class FakeContainer {
		constructor(children) {
			this.children = children;
		}
		render(width) {
			return this.children.flatMap((c) => c.render(width));
		}
	}

	const restore = patchBorderedToolStack(FakeToolExecution.prototype, FakeContainer.prototype);
	try {
		const msg1 = new FakeAssistantMessage("first thought");
		const msg2 = new FakeAssistantMessage("second thought");
		const container = new FakeContainer([msg1, msg2]);

		// First render: msg1 auto-collapses, msg2 (last) stays expanded.
		assert.deepEqual(container.render(80), ["Thinking...", "answer", "THINKING: second thought", "answer"]);
		assert.equal(msg1.updateCalls, 1);
		assert.equal(msg2.updateCalls, 0);

		// Second render with no changes: zero extra updateContent calls (no redraw loop).
		container.render(80);
		assert.equal(msg1.updateCalls, 1);
		assert.equal(msg2.updateCalls, 0);

		// User clicks msg1 to expand it manually (override becomes false).
		msg1.thinkingVisibilityOverrides.set(0, false);
		assert.deepEqual(container.render(80), ["THINKING: first thought", "answer", "THINKING: second thought", "answer"]);

		// A third thinking message arrives: msg2 now auto-collapses, msg1 stays manually expanded, msg3 stays expanded.
		const msg3 = new FakeAssistantMessage("third thought");
		container.children.push(msg3);
		assert.deepEqual(container.render(80), [
			"THINKING: first thought",
			"answer",
			"Thinking...",
			"answer",
			"THINKING: third thought",
			"answer",
		]);
		assert.equal(msg2.updateCalls, 1);
		assert.equal(msg3.updateCalls, 0);
	} finally {
		restore();
	}
});
