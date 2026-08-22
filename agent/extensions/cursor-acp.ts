/**
 * Cursor Agent over ACP. Models appear in /model; a selected turn runs
 * `cursor-agent acp` in the current workspace.
 *
 * Pi startup: load ~/.pi/agent/cursor-models.json, register the provider, do
 * not spawn Cursor. ACP starts on the first Cursor prompt or /cursor-acp-refresh.
 *
 * No cache: placeholder Cursor Auto (`default[]`). That id skips
 * session/set_model; Cursor picks its own default.
 * Stale cached id: fall back to Auto for that prompt and refresh the cache.
 * Empty advertised list is not saved (would wipe a good cache).
 *
 * /cursor-acp-refresh — spawn, discover, write cache, update /model now
 * /cursor-acp-status  — connection, session, model, message count
 * /cursor-acp-reset   — new Cursor session; next prompt re-sends full context
 * /cursor-acp-permissions allow|readonly — switch mode (default: readonly)
 * /model              — pick a Cursor model; selection does not start ACP
 *
 * On iff CURSOR_ACP_COMMAND (default cursor-agent) exists and is executable.
 * Env: CURSOR_ACP_COMMAND, CURSOR_ACP_ARGS, CURSOR_ACP_STARTUP_TIMEOUT_MS,
 * CURSOR_ACP_REQUEST_TIMEOUT_MS, CURSOR_ACP_AUTO_ALLOW=true opts into allow
 * mode (default is readonly), CURSOR_ACP_DEBUG.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const PROVIDER = "cursor-acp";
const API = "cursor-acp";
const CURSOR_COMMAND = process.env.CURSOR_ACP_COMMAND ?? "cursor-agent";
const CURSOR_ARGS = (process.env.CURSOR_ACP_ARGS ?? "acp")
  .split(/\s+/)
  .filter(Boolean);
const STARTUP_TIMEOUT_MS = Number(
  process.env.CURSOR_ACP_STARTUP_TIMEOUT_MS ?? 20_000,
);
const REQUEST_TIMEOUT_MS = Number(
  process.env.CURSOR_ACP_REQUEST_TIMEOUT_MS ?? 10 * 60_000,
);
type PermissionMode = "allow" | "readonly";

// Default: readonly (auto-approve permissions, block file writes). Flip at
// runtime with /cursor-acp-permissions allow|readonly.
let PERMISSION_MODE: PermissionMode =
  process.env.CURSOR_ACP_AUTO_ALLOW === "true" ? "allow" : "readonly";
const DEBUG = process.env.CURSOR_ACP_DEBUG === "true";

type JsonRpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
};

type CursorModelInfo = { modelId: string; name: string };

const MODEL_CACHE_DIR = path.join(os.homedir(), ".pi", "agent");
const MODEL_CACHE_FILE = path.join(MODEL_CACHE_DIR, "cursor-models.json");

async function loadCachedCursorModels(): Promise<CursorModelInfo[]> {
  try {
    const raw = await fs.readFile(MODEL_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return [];
    return parsed.models.filter(
      (m): m is CursorModelInfo =>
        typeof m === "object" &&
        m !== null &&
        typeof (m as CursorModelInfo).modelId === "string" &&
        typeof (m as CursorModelInfo).name === "string",
    );
  } catch {
    return [];
  }
}

async function saveCachedCursorModels(
  models: CursorModelInfo[],
): Promise<void> {
  if (!Array.isArray(models) || models.length === 0) return;
  try {
    await fs.mkdir(MODEL_CACHE_DIR, { recursive: true });
    // Write atomically so concurrent Pi processes never read a torn file;
    // the unique temp path keeps concurrent writers on separate inodes.
    const tmp = `${MODEL_CACHE_FILE}.${randomUUID()}.tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify({ models, updatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    await fs.rename(tmp, MODEL_CACHE_FILE);
  } catch (error) {
    console.error(
      `[cursor-acp] failed to save model cache: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

type TerminalState = {
  process: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  exitStatus?: { exitCode?: number; signal?: string };
  waiters: Array<(status: { exitCode?: number; signal?: string }) => void>;
  limit: number;
};

class AcpProcess {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private terminals = new Map<string, TerminalState>();
  private closed = false;
  // Sessions whose prompt was aborted: pending permission requests from them
  // must be answered cancelled (ACP requires this) until the next prompt.
  private cancelledSessions = new Set<string>();
  private agentCapabilities: any = null;

  constructor(
    private cwd: string,
    private onNotification?: (message: JsonRpcMessage) => void,
  ) {
    this.proc = spawn(CURSOR_COMMAND, CURSOR_ARGS, {
      cwd,
      env: process.env,
      stdio: "pipe",
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      if (DEBUG) process.stderr.write(`[cursor-acp stderr] ${chunk}`);
    });
    // Route every failure through one teardown so pending requests and
    // terminal children never leak and Pi never crashes on stream errors.
    const teardown = (error: Error) => {
      if (this.closed) return;
      this.closed = true;
      for (const terminal of this.terminals.values()) {
        terminal.process.kill();
      }
      this.terminals.clear();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.proc.on("error", (error) =>
      teardown(new Error(`cursor-agent acp error: ${error.message}`)),
    );
    this.proc.on("exit", (code, signal) =>
      teardown(
        new Error(`cursor-agent acp exited (${code ?? signal ?? "unknown"})`),
      ),
    );
    // EPIPE / destroyed-stream errors must also trigger teardown; swallowing
    // them would leave pending requests waiting out their full timeout.
    this.proc.stdin.on("error", (error) =>
      teardown(new Error(`cursor-agent acp stdin error: ${error.message}`)),
    );
    this.proc.stdout.on("error", (error) =>
      teardown(new Error(`cursor-agent acp stdout error: ${error.message}`)),
    );
    this.proc.stderr.on("error", (error) =>
      teardown(new Error(`cursor-agent acp stderr error: ${error.message}`)),
    );
  }

  isClosed(): boolean {
    return this.closed;
  }

  async initialize(): Promise<any> {
    const result = await this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: "pi cursor-acp extension", version: "0.2.0" },
      },
      STARTUP_TIMEOUT_MS,
    );
    this.agentCapabilities = result?.agentCapabilities ?? null;
    return result;
  }

  // Best-effort close of a finished session. Only sent when the agent
  // advertised session/close support; ACP advertises it with an empty object
  // ({}), so presence is the signal, not a boolean true. A checked request
  // (short timeout) rather than a notification, since strict agents may
  // ignore notifications; the caller does not await it.
  async closeSession(sessionId: string): Promise<void> {
    if (this.agentCapabilities?.sessionCapabilities?.close == null) return;
    await this.request("session/close", { sessionId }, 5_000);
  }

  async newSession(cwd = this.cwd): Promise<any> {
    return this.request(
      "session/new",
      { cwd, mcpServers: [] },
      STARTUP_TIMEOUT_MS,
    );
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request(
      "session/set_model",
      { sessionId, modelId },
      STARTUP_TIMEOUT_MS,
    );
  }

  async prompt(
    sessionId: string,
    prompt: any[],
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) throw new Error("aborted");
    // A fresh prompt is fresh consent for this session.
    this.cancelledSessions.delete(sessionId);
    const abort = () => {
      void this.cancelSession(sessionId).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const { id, promise } = this.requestWithId(
        "session/prompt",
        { sessionId, prompt },
        REQUEST_TIMEOUT_MS,
      );
      return await this.raceWithSignal(promise, signal, () =>
        this.cancelRequest(id),
      );
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async request(
    method: string,
    params?: any,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<any> {
    return this.requestWithId(method, params, timeoutMs).promise;
  }

  private requestWithId(
    method: string,
    params?: any,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): { id: number; promise: Promise<any> } {
    if (this.closed) throw new Error("cursor-agent acp process is closed");
    const id = this.nextId++;
    const payload: JsonRpcMessage = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    if (!this.write(payload)) {
      clearTimeout(this.pending.get(id)?.timer);
      this.pending.delete(id);
      promise.catch(() => undefined);
      return {
        id,
        promise: Promise.reject(
          new Error("cursor-agent acp process is closed"),
        ),
      };
    }
    return { id, promise };
  }

  private async raceWithSignal<T>(
    promise: Promise<T>,
    signal: AbortSignal | undefined,
    onAbort: () => void,
  ): Promise<T> {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      const abortNow = () => {
        onAbort();
        reject(new Error("aborted"));
      };
      if (signal.aborted) {
        abortNow();
        return;
      }
      signal.addEventListener("abort", abortNow, { once: true });
      promise.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abortNow);
      });
    });
  }

  private cancelRequest(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error("aborted"));
  }

  // Mark a session cancelled (pending permission requests are answered
  // cancelled) and ask the agent to stop its in-flight prompt. Idempotent;
  // also used for timeout/error paths where old work may still run.
  async cancelSession(sessionId: string): Promise<void> {
    this.cancelledSessions.add(sessionId);
    await this.notify("session/cancel", { sessionId });
  }

  async notify(method: string, params?: any): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params });
  }

  dispose(): void {
    for (const terminal of this.terminals.values()) terminal.process.kill();
    this.terminals.clear();
    if (!this.proc.killed) this.proc.kill();
  }

  private write(message: JsonRpcMessage): boolean {
    if (this.closed) return false;
    if (DEBUG)
      process.stderr.write(`[cursor-acp ->] ${JSON.stringify(message)}\n`);
    try {
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      // Process already gone; the caller's request rejects immediately.
      return false;
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (DEBUG)
          process.stderr.write(`[cursor-acp <-] ${JSON.stringify(message)}\n`);
        void this.handleMessage(message);
      } catch (error) {
        if (DEBUG)
          process.stderr.write(
            `[cursor-acp parse error] ${String(error)} for ${line}\n`,
          );
      }
    }
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && message.method) {
      await this.handleClientRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (message.error) {
        const err = new Error(
          message.error.message ?? JSON.stringify(message.error),
        ) as Error & {
          code?: number;
        };
        if (typeof message.error.code === "number")
          err.code = message.error.code;
        pending.reject(err);
      } else pending.resolve(message.result);
      return;
    }

    if (message.method) this.onNotification?.(message);
  }

  private async handleClientRequest(message: JsonRpcMessage): Promise<void> {
    try {
      const result = await this.dispatchClientRequest(
        message.method!,
        message.params ?? {},
      );
      this.write({ jsonrpc: "2.0", id: message.id!, result: result ?? {} });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: message.id!,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async dispatchClientRequest(
    method: string,
    params: any,
  ): Promise<any> {
    switch (method) {
      case "fs/read_text_file":
        return this.readTextFile(params);
      case "fs/write_text_file":
        this.assertWritable();
        await fs.mkdir(path.dirname(params.path), { recursive: true });
        await fs.writeFile(params.path, params.content ?? "", "utf8");
        return {};
      case "session/request_permission":
        return this.requestPermission(params);
      case "terminal/create":
        return this.createTerminal(params);
      case "terminal/output":
        return this.terminalOutput(params.terminalId);
      case "terminal/wait_for_exit":
        return this.waitForTerminal(params.terminalId);
      case "terminal/kill":
        this.terminals.get(params.terminalId)?.process.kill();
        return {};
      case "terminal/release":
        this.terminals.get(params.terminalId)?.process.kill();
        this.terminals.delete(params.terminalId);
        return {};
      default:
        throw new Error(`Unsupported ACP client request: ${method}`);
    }
  }

  private async readTextFile(params: any): Promise<{ content: string }> {
    let content = await fs.readFile(params.path, "utf8");
    const line = Number(params.line ?? 0);
    const limit = params.limit == null ? undefined : Number(params.limit);
    if (line > 0 || limit != null) {
      const lines = content.split(/\r?\n/);
      const start = Math.max(0, line > 0 ? line - 1 : 0);
      content = lines
        .slice(start, limit == null ? undefined : start + limit)
        .join("\n");
    }
    return { content };
  }

  private requestPermission(params: any): any {
    // After a cancelled prompt, pending permission requests from that session
    // must be answered cancelled, never auto-approved.
    if (this.cancelledSessions.has(params.sessionId)) {
      return { outcome: { outcome: "cancelled" } };
    }
    // Both modes auto-approve; readonly mode blocks writes at fs/write_text_file.
    const options = Array.isArray(params.options) ? params.options : [];
    const allow =
      options.find((option: any) =>
        String(option.kind ?? "").startsWith("allow"),
      ) ?? options[0];
    if (!allow?.optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }

  private assertWritable(): void {
    if (PERMISSION_MODE !== "allow") {
      throw new Error(
        "Cursor ACP read-only mode: file writes are blocked (/cursor-acp-permissions allow to enable)",
      );
    }
  }

  private createTerminal(params: any): { terminalId: string } {
    const terminalId = randomUUID();
    const env = { ...process.env } as Record<string, string>;
    for (const item of params.env ?? []) env[item.name] = item.value;
    const args = Array.isArray(params.args) ? params.args : [];
    const child = spawn(params.command, args, {
      cwd: params.cwd || this.cwd,
      env,
      stdio: "pipe",
    });
    const rawLimit = Number(params.outputByteLimit ?? 200_000);
    // Per ACP, 0 is a valid limit (retain nothing); negative/invalid -> default.
    const limit =
      Number.isFinite(rawLimit) && rawLimit >= 0 ? rawLimit : 200_000;
    const state: TerminalState = {
      process: child,
      output: "",
      truncated: false,
      waiters: [],
      limit,
    };
    const append = (chunk: Buffer | string) => {
      const { text, truncated } = truncateToBytes(
        state.output + chunk.toString(),
        state.limit,
      );
      state.output = text;
      state.truncated = state.truncated || truncated;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      state.exitStatus = { exitCode: undefined, signal: undefined };
      for (const waiter of state.waiters) waiter(state.exitStatus);
      state.waiters = [];
      if (DEBUG)
        process.stderr.write(`[cursor-acp terminal error] ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      state.exitStatus = {
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
      };
      for (const waiter of state.waiters) waiter(state.exitStatus);
      state.waiters = [];
    });
    this.terminals.set(terminalId, state);
    return { terminalId };
  }

  private terminalOutput(terminalId: string): any {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Unknown terminal: ${terminalId}`);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.exitStatus ?? null,
    };
  }

  private waitForTerminal(terminalId: string): Promise<any> | any {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Unknown terminal: ${terminalId}`);
    if (terminal.exitStatus) return terminal.exitStatus;
    return new Promise((resolve) => terminal.waiters.push(resolve));
  }
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function textOfContent(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image")
        return `[image: ${block.mimeType ?? "unknown"}]`;
      return `[${block.type}]`;
    })
    .join("\n");
}

function bridgeNote(configuredModelId: string): string {
  return (
    "# Bridge note\n" +
    `You are Cursor Agent running through ACP, called from Pi (active Cursor model: ${configuredModelId}). ` +
    "Answer the latest user request. If you need to inspect or modify files, use your Cursor Agent tools."
  );
}

function formatMessages(messages: Context["messages"]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user")
      parts.push(`User:\n${textOfContent(message.content)}`);
    else if (message.role === "assistant") {
      const text = message.content
        .map((block: any) =>
          block.type === "text"
            ? block.text
            : block.type === "thinking"
              ? ""
              : `[tool call: ${block.name}]`,
        )
        .filter(Boolean)
        .join("\n");
      if (text.trim()) parts.push(`Assistant:\n${text}`);
    } else if (message.role === "toolResult") {
      parts.push(
        `Tool result (${message.toolName}):\n${textOfContent(message.content)}`,
      );
    }
  }
  return parts.join("\n\n");
}

function bootstrapPrompt(context: Context, configuredModelId: string): string {
  const parts: string[] = [];
  if (context.systemPrompt)
    parts.push(`# Pi system prompt\n${context.systemPrompt}`);
  parts.push(
    bridgeNote(configuredModelId),
    "# Conversation",
    formatMessages(context.messages),
  );
  return parts.join("\n\n");
}

export function truncateToBytes(
  text: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return { text, truncated: false };
  }
  let count = 0;
  let index = text.length;
  // Walk back by code points (surrogate pairs count as one unit) so the kept
  // tail never splits a character and never exceeds the byte limit (ACP
  // requires retained output to stay within the specified limit).
  while (index > 0) {
    const unit = text.codePointAt(index - 1)!;
    const size = unit >= 0xdc00 && unit <= 0xdfff ? 2 : 1;
    if (index - size < 0) break;
    const charBytes = Buffer.byteLength(
      text.slice(index - size, index),
      "utf8",
    );
    if (count + charBytes > limit) break;
    count += charBytes;
    index -= size;
  }
  return { text: text.slice(index), truncated: true };
}

// One text or thinking block is open at a time. Text chunks append to the
// open text block; a type switch closes the previous block first. Exported
// for the standalone test in /tmp/cacp-test.
export function createBlockAssembler(
  output: AssistantMessage,
  sink: { push: (event: AssistantMessageEvent) => void },
) {
  let textIndex: number | undefined;
  let textStarted = false;
  let text = "";
  let thinkingIndex: number | undefined;
  let thinkingStarted = false;
  let thinking = "";

  const closeOpenBlock = () => {
    if (thinkingStarted) {
      sink.push({
        type: "thinking_end",
        contentIndex: thinkingIndex!,
        content: thinking,
        partial: output,
      });
      thinkingStarted = false;
      return;
    }
    if (textStarted) {
      sink.push({
        type: "text_end",
        contentIndex: textIndex!,
        content: text,
        partial: output,
      });
      textStarted = false;
    }
  };

  return {
    appendText(delta: string) {
      if (!delta) return;
      // Switch from thinking to text closes the thinking block first.
      if (thinkingStarted) closeOpenBlock();
      if (!textStarted) {
        textIndex = output.content.length;
        text = "";
        output.content.push({ type: "text", text: "" });
        sink.push({
          type: "text_start",
          contentIndex: textIndex,
          partial: output,
        });
        textStarted = true;
      }
      text += delta;
      const block = output.content[textIndex!] as any;
      block.text = text;
      sink.push({
        type: "text_delta",
        contentIndex: textIndex!,
        delta,
        partial: output,
      });
    },
    appendThinking(delta: string) {
      if (!delta) return;
      // Switch from text to thinking closes the text block first.
      if (textStarted) closeOpenBlock();
      if (!thinkingStarted) {
        thinkingIndex = output.content.length;
        thinking = "";
        output.content.push({ type: "thinking", thinking: "" });
        sink.push({
          type: "thinking_start",
          contentIndex: thinkingIndex,
          partial: output,
        });
        thinkingStarted = true;
      }
      thinking += delta;
      const block = output.content[thinkingIndex!] as any;
      block.thinking = thinking;
      sink.push({
        type: "thinking_delta",
        contentIndex: thinkingIndex!,
        delta,
        partial: output,
      });
    },
    // Emit a valid empty text block only when nothing was produced at all.
    finishBlocks() {
      if (!textStarted && !thinkingStarted) {
        const index = output.content.length;
        output.content.push({ type: "text", text: "" });
        sink.push({ type: "text_start", contentIndex: index, partial: output });
        sink.push({
          type: "text_end",
          contentIndex: index,
          content: "",
          partial: output,
        });
        return;
      }
      closeOpenBlock();
    },
    closeOpenBlock,
  };
}

export function incrementalPrompt(
  context: Context,
  sentMessageCount: number,
  configuredModelId: string,
  ownAssistantResponseId?: string | null,
): { text: string; newSentCount: number } {
  const messages = context.messages;
  if (sentMessageCount === 0 || messages.length < sentMessageCount) {
    return {
      text: bootstrapPrompt(context, configuredModelId),
      newSentCount: messages.length,
    };
  }
  const delta = messages.slice(sentMessageCount);
  // The assistant message right after the last sent message is our own prior
  // response (only when produced by this provider AND still carrying the
  // exact responseId we stamped); Cursor's session already contains it, so
  // skip re-sending it. Foreign-provider messages and regenerated replies
  // (retry/branch) are never dropped.
  if (
    delta.length > 0 &&
    delta[0].role === "assistant" &&
    delta[0].api === API &&
    delta[0].provider === PROVIDER &&
    delta[0].responseId != null &&
    delta[0].responseId === ownAssistantResponseId
  ) {
    delta.shift();
  }
  if (delta.length === 0) {
    return { text: "Continue.", newSentCount: messages.length };
  }
  return { text: formatMessages(delta), newSentCount: messages.length };
}

class CursorAcpBridge {
  private acp: AcpProcess | null = null;
  private sessionId: string | null = null;
  private currentModelId: string | null = null;
  private lastModels: CursorModelInfo[] = [];
  private cwd: string | null = null;
  private piSessionKey: string | null = null;
  private sentMessageCount = 0;
  private promptChain: Promise<void> = Promise.resolve();
  private notificationHandler: ((message: JsonRpcMessage) => void) | null =
    null;
  // Set when a prompt aborts and recovery must run before the NEXT prompt
  // (an already-queued prompt would otherwise run on the dirty session).
  private pendingReset = false;

  getStatus() {
    return {
      connected: this.acp != null && !this.acp.isClosed(),
      cursorSessionId: this.sessionId,
      currentModelId: this.currentModelId,
      sentMessageCount: this.sentMessageCount,
      piSessionKey: this.piSessionKey,
      cwd: this.cwd,
    };
  }

  getCurrentModelId(): string | null {
    return this.currentModelId;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.promptChain.then(fn, fn);
    this.promptChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async refreshModelCache(models: CursorModelInfo[]): Promise<void> {
    if (!models.length) return;
    for (const m of models) modelCatalog.set(m.modelId, m);
    await saveCachedCursorModels(models);
    onModelsDiscovered?.(models);
  }

  private async ensureSession(
    piSessionKey: string,
    cwd: string,
  ): Promise<void> {
    if (this.acp?.isClosed()) {
      // Kill the orphaned child (a stream-error teardown rejects pending
      // requests but does not terminate the process).
      this.acp.dispose();
      this.acp = null;
      this.sessionId = null;
      this.currentModelId = null;
    }

    if (this.piSessionKey !== piSessionKey || this.cwd !== cwd) {
      await this.dispose();
      this.piSessionKey = piSessionKey;
      this.cwd = cwd;
      this.sentMessageCount = 0;
    }

    if (!this.acp) {
      const acp = new AcpProcess(cwd, (message) => {
        // Ignore updates from sessions that are no longer current (late
        // chunks after cancel/reset must not leak into the next prompt).
        const sid = message.params?.sessionId;
        if (typeof sid === "string" && sid !== this.sessionId) return;
        this.notificationHandler?.(message);
      });
      try {
        await acp.initialize();
        const session = await acp.newSession(cwd);
        this.sessionId = session.sessionId as string;
        this.sentMessageCount = 0;
        const available = session?.models?.availableModels;
        this.lastModels = Array.isArray(available)
          ? available.map((m: { modelId: string; name: string }) => ({
              modelId: m.modelId,
              name: m.name,
            }))
          : [];
        // Refresh the cache from the live session without blocking the prompt.
        void this.refreshModelCache(this.lastModels).catch(() => undefined);
      } catch (error) {
        // Never leave a half-initialized process behind.
        acp.dispose();
        throw error;
      }
      this.acp = acp;
    }
  }

  private async applyModel(modelId: string): Promise<void> {
    if (!this.acp || !this.sessionId) return;
    if (this.currentModelId === modelId) return;
    // The synthetic fallback model id means cursor-agent did not advertise any
    // selectable models; the agent controls the model itself, so don't try to set it.
    if (isFallbackModelId(modelId)) {
      this.currentModelId = modelId;
      return;
    }
    try {
      await this.acp.setModel(this.sessionId, modelId);
    } catch (error) {
      // Some cursor-agent builds don't implement session/set_model. Treat a
      // method-not-found as a no-op rather than failing model selection.
      if (isMethodNotFound(error)) {
        this.currentModelId = modelId;
        return;
      }
      // The model id (typically from a stale cache) was rejected by
      // cursor-agent. Fall back to Auto, refresh the cache from the models
      // the live session advertised, and start a fresh session so the
      // agent's default model actually applies.
      console.warn(
        `[cursor-acp] model ${modelId} rejected; falling back to ${FALLBACK_MODEL_ID}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.currentModelId = FALLBACK_MODEL_ID;
      if (this.lastModels.length) {
        void this.refreshModelCache(this.lastModels).catch(() => undefined);
      }
      // Reset inline (not queued) so Auto applies to the current prompt;
      // resetSessionInline is safe inside the serialized chain. A failed
      // reset leaves pendingReset set, so the next prompt recovers first
      // (see pendingReset consumption in prompt()).
      this.pendingReset = true;
      await this.resetSessionInline();
      return;
    }
    this.currentModelId = modelId;
  }

  async resetCursorSession(): Promise<void> {
    return this.runExclusive(() => this.resetSessionInline());
  }

  // Resets the Cursor session. Safe inside the serialized chain (the chain
  // already serializes, so no re-entry) and from the public command path.
  private async resetSessionInline(): Promise<void> {
    if (!this.acp || this.acp.isClosed() || !this.cwd) return;
    const previousSessionId = this.sessionId;
    const session = await this.acp.newSession(this.cwd);
    this.sessionId = session.sessionId as string;
    this.sentMessageCount = 0;
    // Recovery is complete; a stale flag must not trigger a duplicate reset
    // (e.g. after /cursor-acp-reset or session_compact ran while a reset was
    // pending).
    this.pendingReset = false;
    if (previousSessionId) {
      // Close the old session when the agent advertises session/close. The
      // old id stays in cancelledSessions on purpose: late permission
      // requests from an aborted session must keep being cancelled, and the
      // abandoned id is never reused (bounded growth, safe direction).
      void this.acp.closeSession(previousSessionId).catch(() => undefined);
      // Its message ids are dead too (late chunks are session-filtered
      // upstream); pruning keeps the map bounded.
      completedMessageIds.delete(previousSessionId);
    }
    const previousModel = this.currentModelId;
    this.currentModelId = null;
    if (previousModel) await this.applyModel(previousModel);
  }

  async prompt(
    context: Context,
    modelId: string,
    piSessionKey: string,
    cwd: string,
    signal?: AbortSignal,
    onNotification?: ((message: JsonRpcMessage) => void) | null,
  ): Promise<any> {
    return this.runExclusive(async () => {
      if (this.pendingReset) {
        // An earlier prompt aborted/cancelled: recover before this prompt
        // runs, even if this prompt was already queued. Skip when this
        // prompt belongs to another Pi session/cwd — ensureSession disposes
        // the old process (and its dirty session) anyway.
        if (this.piSessionKey === piSessionKey && this.cwd === cwd) {
          // Only clear the flag on success; a failed reset must be retried
          // by the next prompt instead of silently running on dirty state.
          await this.resetSessionInline();
        }
        this.pendingReset = false;
      }
      await this.ensureSession(piSessionKey, cwd);
      await this.applyModel(modelId);
      const { text, newSentCount } = incrementalPrompt(
        context,
        this.sentMessageCount,
        modelId,
        lastOwnedResponseId,
      );
      // The notification handler is scoped to this prompt and installed
      // inside the chain, so concurrent prompts can never steal updates.
      this.notificationHandler = onNotification ?? null;
      try {
        const result = await this.acp!.prompt(
          this.sessionId!,
          [{ type: "text", text }],
          signal,
        );
        // Cursor can report cancellation as a normal response; treat it as
        // a failed prompt so context is not committed and the session is
        // recovered before anything else runs.
        if (result?.stopReason === "cancelled") {
          const cancelledError = new Error("cancelled by user") as Error & {
            cancelled?: boolean;
          };
          cancelledError.cancelled = true;
          throw cancelledError;
        }
        // Commit only after the prompt succeeded; on failure the session is
        // reset below so the next prompt re-bootstraps full context.
        this.sentMessageCount = newSentCount;
        return result;
      } catch (error) {
        // Stop forwarding notifications before recovery so late chunks from
        // the failed/cancelled prompt cannot reach the aborted stream.
        this.notificationHandler = null;
        const cancelledByCursor =
          (error as { cancelled?: boolean })?.cancelled === true;
        // Whatever failed, old work may still run server-side: keep the
        // abandoned session's permissions cancelled (idempotent for the
        // signal-abort path, which already marked it).
        void this.acp?.cancelSession(this.sessionId!).catch(() => undefined);
        if (signal?.aborted || cancelledByCursor) {
          // Abort/cancel must return immediately; the next prompt in the
          // chain performs the recovery first (see pendingReset above).
          this.pendingReset = true;
        } else {
          // Other failures (timeout, transport, ...): reset inline so the
          // next prompt re-bootstraps on a fresh session.
          try {
            await this.resetSessionInline();
          } catch {
            // Failed recovery: defer to the next prompt instead of letting
            // it run on the dirty session.
            this.pendingReset = true;
          }
        }
        throw error;
      } finally {
        this.notificationHandler = null;
      }
    });
  }

  async dispose(): Promise<void> {
    this.acp?.dispose();
    this.acp = null;
    this.sessionId = null;
    this.currentModelId = null;
    this.cwd = null;
    this.piSessionKey = null;
    this.sentMessageCount = 0;
    this.pendingReset = false;
    completedMessageIds.clear();
  }
}

const acpBridge = new CursorAcpBridge();
const modelCatalog = new Map<string, CursorModelInfo>();
let onModelsDiscovered: ((models: CursorModelInfo[]) => void) | undefined;

// responseId of the last assistant message this provider produced, and a
// bounded per-session history of completed ACP message ids (MessageIds are
// session-local per ACP). Used to skip re-sending our own output and to drop
// late chunks from recent previous prompts.
let lastOwnedResponseId: string | null = null;
// Late chunks more than this many prompts back are dropped; beyond that they
// are implausible and the bound keeps memory flat.
const MAX_COMPLETED_PROMPTS = 3;
const completedMessageIds = new Map<string, Set<string>[]>();

let boundPiSessionKey: string | undefined;
let boundCwd = process.cwd();

const FALLBACK_MODEL_ID = "default[]";

function isFallbackModelId(modelId: string): boolean {
  return modelId === FALLBACK_MODEL_ID;
}

export function isMethodNotFound(error: unknown): boolean {
  const code = (error as { code?: number })?.code;
  if (code === -32601) return true;
  const message = error instanceof Error ? error.message : String(error);
  // Narrow match: a model rejection mentioning "unsupported" must not be
  // mistaken for a missing session/set_model method.
  return /method not found/i.test(message);
}

function contextWindowFor(modelId: string): number {
  const match = modelId.match(/context=(\d+)k/i);
  if (match) return Number(match[1]) * 1000;
  return 200_000;
}

function isReasoningModel(modelId: string): boolean {
  return /thinking=true|reasoning=/.test(modelId);
}

async function discoverCursorModels(): Promise<CursorModelInfo[]> {
  const acp = new AcpProcess(process.cwd());
  try {
    await acp.initialize();
    const session = await acp.newSession(process.cwd());
    const models = session?.models?.availableModels;
    if (!Array.isArray(models)) return [];
    return models.map((m: { modelId: string; name: string }) => ({
      modelId: m.modelId,
      name: m.name,
    }));
  } finally {
    acp.dispose();
  }
}

function streamCursorProvider(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const stream = createAssistantMessageEventStream();
  const info = modelCatalog.get(model.id);
  // Unique per generation: lets the next prompt recognize (and skip) this
  // exact response, while a regenerated reply carries a new id and is sent.
  const responseId = randomUUID();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: API,
    provider: PROVIDER,
    model: model.id,
    responseId,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };

  (async () => {
    const assembler = createBlockAssembler(output, stream);
    // messageId/sessionId of chunks seen in THIS prompt's stream; stored on
    // success so late chunks of the completed message(s) are dropped from
    // the next prompt's stream. MessageIds are session-local (ACP), so the
    // filter is scoped by session too. A prompt may span several messages
    // (thought + text), so all ids seen are collected.
    const seenMessageIds = new Set<string>();
    let seenSessionId: string | null = null;

    const onNotification = (message: JsonRpcMessage) => {
      if (message.method !== "session/update") return;
      const update = message.params?.update;
      if (!update) return;
      // Late chunks from the previous completed message(s) of THIS session
      // must not contaminate this stream; a new response has new ids.
      const sessionId = message.params?.sessionId;
      const messageId = update.content?.messageId;
      if (
        typeof sessionId === "string" &&
        typeof messageId === "string" &&
        messageId !== "" &&
        completedMessageIds.get(sessionId)?.some((ids) => ids.has(messageId))
      ) {
        return;
      }
      if (typeof messageId === "string" && messageId !== "") {
        seenMessageIds.add(messageId);
      }
      if (typeof sessionId === "string") {
        seenSessionId = sessionId;
      }
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      ) {
        assembler.appendText(update.content.text ?? "");
      } else if (
        update.sessionUpdate === "agent_thought_chunk" &&
        update.content?.type === "text"
      ) {
        assembler.appendThinking(update.content.text ?? "");
      } else if (
        DEBUG &&
        (update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update")
      ) {
        assembler.appendText(
          `\n\n[Cursor ${update.sessionUpdate}: ${update.title ?? update.toolCallId ?? "tool"}]\n`,
        );
      }
    };

    try {
      if (!info) throw new Error(`Unknown cursor-acp model id: ${model.id}`);
      stream.push({ type: "start", partial: output });
      const piSessionKey = boundPiSessionKey ?? `ephemeral:${boundCwd}`;
      const result = await acpBridge.prompt(
        context,
        model.id,
        piSessionKey,
        boundCwd,
        options?.signal,
        onNotification,
      );
      output.stopReason =
        result?.stopReason === "max_tokens" ? "length" : "stop";

      // Only a completed response counts for skip/filter bookkeeping; ids
      // are read from the chunk stream so they match what Cursor sends.
      // Keep a bounded history (a few prompts) so late chunks from more
      // than one prompt back are still filtered.
      lastOwnedResponseId = responseId;
      if (seenMessageIds.size > 0 && seenSessionId) {
        let history = completedMessageIds.get(seenSessionId);
        if (!history) {
          history = [];
          completedMessageIds.set(seenSessionId, history);
        }
        history.push(new Set(seenMessageIds));
        if (history.length > MAX_COMPLETED_PROMPTS) history.shift();
      }

      assembler.finishBlocks();
      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length",
        message: output,
      });
      stream.end(output);
    } catch (error) {
      output.stopReason =
        options?.signal?.aborted ||
        (error as { cancelled?: boolean })?.cancelled === true
          ? "aborted"
          : "error";
      output.errorMessage =
        error instanceof Error ? error.message : String(error);
      assembler.closeOpenBlock();
      stream.push({
        type: "error",
        reason: output.stopReason as "aborted" | "error",
        error: output,
      });
      stream.end(output);
    }
  })();

  return stream;
}

function registerCursorProvider(
  pi: ExtensionAPI,
  models: CursorModelInfo[],
): void {
  for (const m of models) modelCatalog.set(m.modelId, m);
  pi.registerProvider(PROVIDER, {
    name: "Cursor Agent (ACP)",
    baseUrl: "stdio://cursor-agent/acp",
    apiKey: "cursor-acp",
    api: API,
    streamSimple: streamCursorProvider,
    models: models.map((m) => ({
      id: m.modelId,
      name: `Cursor ${m.name}`,
      reasoning: isReasoningModel(m.modelId),
      input: ["text"],
      contextWindow: contextWindowFor(m.modelId),
      maxTokens: 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
}

function cursorAgentExists(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, command), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export default async function cursorAcpExtension(pi: ExtensionAPI) {
  if (!cursorAgentExists(CURSOR_COMMAND)) {
    console.error(
      `[cursor-acp] ${CURSOR_COMMAND} not found on PATH; provider disabled`,
    );
    return;
  }

  const cached = await loadCachedCursorModels();
  let models: CursorModelInfo[] = cached.length
    ? cached
    : [{ modelId: FALLBACK_MODEL_ID, name: "Auto" }];
  registerCursorProvider(pi, models);
  onModelsDiscovered = (discovered) => {
    models = discovered;
    registerCursorProvider(pi, discovered);
  };

  pi.on("session_start", async (_event, ctx) => {
    boundPiSessionKey =
      ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
    boundCwd = ctx.sessionManager.getCwd();
  });

  pi.on("session_shutdown", async () => {
    await acpBridge.dispose();
  });

  pi.on("session_compact", async () => {
    await acpBridge.resetCursorSession();
  });

  pi.registerCommand("cursor-acp-refresh", {
    description: "Discover Cursor models now and update /model",
    handler: async (_args, ctx) => {
      try {
        const discovered = await discoverCursorModels();
        if (!discovered.length) {
          ctx.ui.notify(
            "Cursor advertised no models; left the current list unchanged.",
            "info",
          );
          return;
        }
        models = discovered;
        registerCursorProvider(pi, discovered);
        await saveCachedCursorModels(discovered);
        ctx.ui.notify(
          `Cursor models refreshed: ${discovered.length} model${discovered.length === 1 ? "" : "s"}. Open /model to pick one.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Failed to refresh Cursor models: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("cursor-acp-status", {
    description: "Show Cursor ACP bridge status",
    handler: async (_args, ctx) => {
      const s = acpBridge.getStatus();
      const lines = [
        `connected: ${s.connected ? "yes" : "no"}`,
        `cursor session: ${s.cursorSessionId ?? "(none)"}`,
        `current model: ${s.currentModelId ?? "(none)"}`,
        `messages sent: ${s.sentMessageCount}`,
        `pi session key: ${s.piSessionKey ?? "(none)"}`,
        `cwd: ${s.cwd ?? "(none)"}`,
        `available models: ${models.length}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("cursor-acp-permissions", {
    description:
      "Set permission mode: allow (auto-approve + file writes) or readonly (auto-approve, block file writes; default)",
    handler: async (args, ctx) => {
      const mode = String(args ?? "")
        .trim()
        .toLowerCase();
      if (mode === "allow" || mode === "readonly") {
        PERMISSION_MODE = mode;
      }
      ctx.ui.notify(
        `Cursor ACP permissions: ${
          PERMISSION_MODE === "allow"
            ? "allow (auto-approve, file writes enabled)"
            : "readonly (auto-approve, file writes blocked)"
        }${mode ? "" : " — pass allow or readonly to change"}`,
        "info",
      );
    },
  });

  pi.registerCommand("cursor-acp-reset", {
    description: "Start a new Cursor ACP session (keeps the same Pi session)",
    handler: async (_args, ctx) => {
      await acpBridge.resetCursorSession();
      ctx.ui.notify(
        "Cursor ACP session reset. Next prompt will bootstrap context again.",
        "info",
      );
    },
  });
}
