import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type {
  HostCommandExecutionItem,
  HostEvent,
  HostItemOutcome,
  HostToolExecutionItem,
} from "@codexhost/harness-adapter";
import type { HostTurnId } from "@codexhost/shared-contracts";

import { nativeBrainDirPath, nativeBrainRoot, nativeConversationSummariesDbPath } from "./fork.js";
import { compactToolName } from "./tool-projection.js";

const DEFAULT_POLL_INTERVAL_MS = 750;
const READ_CHUNK_BYTES = 64 * 1024;
const VALID_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;
const VALID_TASK_NUMBER = /^\d+$/u;
const BACKGROUND_TASK_SPAWN_RE =
  /Tool is running as a background task with task id:\s*([a-zA-Z0-9][a-zA-Z0-9_-]*\/task-(\d+))/iu;
const SENDER_TASK_RE = /\bsender=([a-zA-Z0-9][a-zA-Z0-9_-]*\/task-\d+)\b/u;
const SETTLEMENT_RE =
  /(?:Task id ["']?([a-zA-Z0-9][a-zA-Z0-9_-]*\/task-\d+)["']?\s+)?(finished|was cance(?:l|ll)ed) with result:\s*([\s\S]*?)(?=\n<\/SYSTEM_MESSAGE>|$)/iu;
const EXIT_CODE_RE = /Command exited with code (-?\d+)/iu;
const RESTART_NOTICE_RE =
  /\[Notice\]\s*All your subagents and background tasks have been stopped due to server restart/iu;

export interface DetectedAntigravityBackgroundTask {
  taskId: string;
  sessionId: string;
  taskNumber: string;
}

export interface DetachedAntigravityTask {
  taskId: string;
  taskNumber: string;
  turnId: HostTurnId;
  item: HostCommandExecutionItem | HostToolExecutionItem;
  startedAtMs: number;
}

export interface BackgroundTaskSettlement {
  taskId: string;
  stepIndex: number;
  kind: "finished" | "cancelled";
  exitCode?: number;
  resultText: string;
}

export interface DanglingBackgroundTaskCompletion {
  stepIndex: number;
  taskIds: string[];
}

export interface AntigravityBackgroundTasksOptions {
  nativeSessionId(): string | undefined;
  home: string;
  outputLimit: number;
  pollIntervalMs?: number;
  emit(event: HostEvent): void;
  onTaskFinished?(info: { taskId: string; stepIndex: number }): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      return {};
    }
    return {};
  }
  if (!isRecord(value)) return {};
  for (const wrapper of ["input", "arguments", "params", "parameters"] as const) {
    if (isRecord(value[wrapper])) return value[wrapper] as Record<string, unknown>;
  }
  return value;
}

function readArg(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function hasPositiveOrNumericDuration(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0 && Number.isFinite(Number(value));
  return false;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Detect whether a completed foreground Antigravity tool spawned a finite native background task.
 * Daemon commands (`IsDaemon === true`) and recurring cron schedules are intentionally ignored so
 * they never block idle Session release indefinitely.
 */
export function detectAntigravityBackgroundTask(params: {
  toolName: string;
  kind?: string | undefined;
  args: unknown;
  output: string;
  nativeSessionId?: string | undefined;
}): DetectedAntigravityBackgroundTask | null {
  if (!params.output) return null;
  const match = BACKGROUND_TASK_SPAWN_RE.exec(params.output);
  if (!match?.[1] || !match[2]) return null;
  const taskId = match[1];
  const taskNumber = match[2];
  const slashIndex = taskId.lastIndexOf("/");
  if (slashIndex <= 0) return null;
  const sessionId = taskId.slice(0, slashIndex);
  if (!VALID_SESSION_ID.test(sessionId) || !VALID_TASK_NUMBER.test(taskNumber)) return null;
  if (params.nativeSessionId && sessionId !== params.nativeSessionId) return null;

  const args = unwrapArgs(params.args);
  if (isTruthyFlag(readArg(args, ["IsDaemon", "isDaemon", "is_daemon"]))) return null;

  const compact = compactToolName(params.toolName);
  const isCommandTool = compact === "runcommand" || params.kind === "execute";
  if (isCommandTool) {
    return { taskId, sessionId, taskNumber };
  }
  if (compact === "schedule") {
    const cron = readArg(args, ["CronExpression", "cronExpression", "cron_expression"]);
    if (hasNonEmptyString(cron)) return null;
    const duration = readArg(args, ["DurationSeconds", "durationSeconds", "duration_seconds"]);
    if (!hasPositiveOrNumericDuration(duration)) return null;
    return { taskId, sessionId, taskNumber };
  }
  return null;
}

export function extractKilledBackgroundTaskId(toolName: string, args: unknown): string | null {
  if (compactToolName(toolName) !== "managetask") return null;
  const record = unwrapArgs(args);
  const action = readArg(record, ["Action", "action"]);
  if (typeof action !== "string" || action.trim().toLowerCase() !== "kill") return null;
  const taskId = readArg(record, ["TaskId", "taskId", "task_id"]);
  if (typeof taskId !== "string" || !taskId.trim()) return null;
  return taskId.trim();
}

export function parseBackgroundTaskSettlements(
  entry: Record<string, unknown>,
  expectedSessionId?: string,
): BackgroundTaskSettlement[] {
  if (entry.type !== "SYSTEM_MESSAGE") return [];
  if (entry.status !== undefined && entry.status !== "DONE") return [];
  if (
    typeof entry.step_index !== "number" ||
    !Number.isInteger(entry.step_index) ||
    entry.step_index < 0
  )
    return [];
  if (typeof entry.content !== "string" || !entry.content) return [];

  const blocks = entry.content.split(/(?=\[Message\]\s)/u);
  const settlements: BackgroundTaskSettlement[] = [];
  for (const block of blocks) {
    const senderTaskId = SENDER_TASK_RE.exec(block)?.[1];
    const settled = SETTLEMENT_RE.exec(block);
    if (!settled?.[2]) continue;
    const bodyTaskId = settled[1];
    if (senderTaskId && bodyTaskId && senderTaskId !== bodyTaskId) continue;
    const taskId = senderTaskId ?? bodyTaskId;
    if (!taskId) continue;
    if (expectedSessionId && !taskId.startsWith(`${expectedSessionId}/task-`)) continue;
    const kind = settled[2].toLowerCase() === "finished" ? "finished" : "cancelled";
    const resultText = (settled[3] ?? "").trim();
    const exitMatch = EXIT_CODE_RE.exec(resultText);
    const exitCode = exitMatch?.[1] !== undefined ? Number(exitMatch[1]) : undefined;
    settlements.push({
      taskId,
      stepIndex: entry.step_index,
      kind,
      ...(exitCode !== undefined && Number.isInteger(exitCode) ? { exitCode } : {}),
      resultText,
    });
  }
  return settlements;
}

function normalizePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function resolveNativeBrainFile(
  home: string,
  nativeSessionId: string,
  relativeParts: readonly string[],
): Promise<string | null> {
  if (!VALID_SESSION_ID.test(nativeSessionId)) return null;
  const candidate = path.join(nativeBrainDirPath(nativeSessionId, home), ...relativeParts);
  try {
    const brainRoot = await realpath(nativeBrainRoot(home));
    const resolved = await realpath(candidate);
    const expected = path.join(brainRoot, nativeSessionId, ...relativeParts);
    if (normalizePath(resolved) !== normalizePath(expected)) return null;
    return resolved;
  } catch {
    return null;
  }
}

export async function readNativeConversationStatus(
  home: string,
  nativeSessionId: string,
): Promise<"running" | "idle" | null> {
  if (!VALID_SESSION_ID.test(nativeSessionId)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(nativeConversationSummariesDbPath(home), { readOnly: true });
    const row = db
      .prepare("SELECT status FROM conversation_summaries WHERE conversation_id = ?")
      .get(nativeSessionId);
    if (!row) return null;
    if (row.status === "CASCADE_RUN_STATUS_RUNNING") return "running";
    if (row.status === "CASCADE_RUN_STATUS_IDLE") return "idle";
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function isServerRestartNotice(entry: Record<string, unknown>): boolean {
  return (
    entry.type === "SYSTEM_MESSAGE" &&
    typeof entry.content === "string" &&
    RESTART_NOTICE_RE.test(entry.content)
  );
}

/**
 * Inspect `transcript.jsonl` to determine whether the latest unanswered non-notice step is a
 * completed background task `SYSTEM_MESSAGE` with no subsequent `PLANNER_RESPONSE` or `USER_INPUT`.
 */
export async function findDanglingBackgroundTaskCompletion(
  home: string,
  nativeSessionId: string,
): Promise<DanglingBackgroundTaskCompletion | null> {
  const resolved = await resolveNativeBrainFile(home, nativeSessionId, [
    ".system_generated",
    "logs",
    "transcript.jsonl",
  ]);
  if (!resolved) return null;

  let handle;
  let content = "";
  try {
    handle = await open(resolved, "r");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      content += decoder.write(buffer.subarray(0, bytesRead));
    }
    content += decoder.end();
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const byStep = new Map<number, Record<string, unknown>>();
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (
      typeof parsed.step_index !== "number" ||
      !Number.isInteger(parsed.step_index) ||
      parsed.step_index < 0
    )
      continue;
    byStep.set(parsed.step_index, parsed);
  }

  const ordered = [...byStep.entries()].sort(([a], [b]) => a - b);
  let dangling: DanglingBackgroundTaskCompletion | null = null;
  for (const [, entry] of ordered) {
    if (entry.type === "USER_INPUT" || entry.type === "PLANNER_RESPONSE") {
      dangling = null;
      continue;
    }
    if (entry.type === "SYSTEM_MESSAGE") {
      if (isServerRestartNotice(entry)) continue;
      const finished = parseBackgroundTaskSettlements(entry, nativeSessionId).filter(
        (settlement) => settlement.kind === "finished",
      );
      if (finished.length > 0) {
        const taskIds: Set<string> = new Set(dangling?.taskIds ?? []);
        for (const item of finished) taskIds.add(item.taskId);
        dangling = {
          stepIndex: finished.at(-1)?.stepIndex ?? (entry.step_index as number),
          taskIds: [...taskIds],
        };
      }
    }
  }
  return dangling;
}

export function buildBackgroundRecoveryPrompt(dangling: DanglingBackgroundTaskCompletion): string {
  const list = dangling.taskIds.join(", ");
  return `Background task ${list} finished and reported its result in the conversation transcript, but no follow-up response was sent yet. Review the completed task result above and continue with the remaining work.`;
}

interface TrackedBackgroundTask {
  task: DetachedAntigravityTask;
  offset: number;
  decoder: StringDecoder;
  output: string;
  truncated: boolean;
  completed: boolean;
}

function settlementOutcome(settlement: BackgroundTaskSettlement): {
  outcome: HostItemOutcome;
  exitCode?: number;
} {
  if (settlement.kind === "cancelled") {
    return {
      outcome: { status: "cancelled", reason: "Background task cancelled" },
      exitCode: settlement.exitCode ?? 1,
    };
  }
  if (settlement.exitCode !== undefined && settlement.exitCode !== 0) {
    return {
      outcome: {
        status: "failed",
        error: {
          code: "nativeFailure",
          message: `Background command exited with code ${settlement.exitCode}`,
          retryable: false,
        },
      },
      exitCode: settlement.exitCode,
    };
  }
  return {
    outcome: { status: "succeeded" },
    exitCode: settlement.exitCode ?? 0,
  };
}

/**
 * Tracks finite detached Antigravity background tasks (`run_command` with `IsDaemon !== true` and
 * one-shot `schedule`), streams `.system_generated/tasks/task-<N>.log`, and settles each item from
 * `transcript.jsonl` or explicit `manage_task` cancellation.
 */
export class AntigravityBackgroundTasks {
  readonly #tasks = new Map<string, TrackedBackgroundTask>();
  readonly #seenSettlements = new Map<string, BackgroundTaskSettlement>();
  readonly #settledTaskIds = new Set<string>();
  #transcriptOffset = 0;
  #transcriptDecoder = new StringDecoder("utf8");
  #transcriptRemainder = "";
  #timer: ReturnType<typeof setInterval> | undefined;
  #refreshing: Promise<void> | undefined;
  #stopped = false;

  constructor(private readonly options: AntigravityBackgroundTasksOptions) {}

  get running(): boolean {
    return this.#tasks.size > 0;
  }

  track(task: DetachedAntigravityTask): void {
    if (this.#stopped || this.#tasks.has(task.taskId) || this.#settledTaskIds.has(task.taskId))
      return;
    const initialOutput = task.item.type === "commandExecution" ? (task.item.output ?? "") : "";
    const tracked: TrackedBackgroundTask = {
      task,
      offset: 0,
      decoder: new StringDecoder("utf8"),
      output: initialOutput,
      truncated: initialOutput.length >= this.options.outputLimit,
      completed: false,
    };
    this.#tasks.set(task.taskId, tracked);
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        void this.refresh();
      }, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      this.#timer.unref();
    }
    void this.refresh();
  }

  markCancelled(taskId: string, reason = "Background task cancelled"): void {
    if (this.#stopped) return;
    const tracked = this.#tasks.get(taskId);
    if (!tracked || tracked.completed) return;
    this.#complete(tracked, { status: "cancelled", reason }, 1);
    this.#stopTimerIfIdle();
  }

  refresh(): Promise<void> {
    if (this.#stopped || !this.running) return Promise.resolve();
    return (this.#refreshing ??= this.#poll().finally(() => {
      this.#refreshing = undefined;
      this.#stopTimerIfIdle();
    }));
  }

  abandonAll(outcome: HostItemOutcome): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    for (const tracked of [...this.#tasks.values()]) {
      this.#complete(tracked, outcome, outcome.status === "succeeded" ? 0 : 1);
    }
    this.#tasks.clear();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async close(): Promise<void> {
    this.stop();
    await this.#refreshing;
  }

  #stopTimerIfIdle(): void {
    if (!this.running && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  async #poll(): Promise<void> {
    const sessionId = this.options.nativeSessionId();
    if (!sessionId || this.#stopped) return;

    await this.#readTranscriptDelta(sessionId);
    if (this.#stopped) return;

    for (const tracked of [...this.#tasks.values()]) {
      if (this.#stopped || tracked.completed) continue;
      await this.#readTaskLogDelta(sessionId, tracked);
      if (this.#stopped || tracked.completed) continue;

      const settlement = this.#seenSettlements.get(tracked.task.taskId);
      if (!settlement) continue;

      const trailing = tracked.decoder.end();
      if (trailing) this.#appendOutput(tracked, trailing);

      const { outcome, exitCode } = settlementOutcome(settlement);
      const fallbackOutput =
        tracked.output.length === 0 && settlement.resultText ? settlement.resultText : undefined;

      if (settlement.kind === "finished") {
        // Notify wake observer BEFORE deleting the last active task so hasBackgroundWork()
        // stays continuously true across the handoff from task completion to autonomous wake.
        this.options.onTaskFinished?.({
          taskId: tracked.task.taskId,
          stepIndex: settlement.stepIndex,
        });
      }
      this.#complete(tracked, outcome, exitCode, fallbackOutput);
    }
  }

  async #readTaskLogDelta(sessionId: string, tracked: TrackedBackgroundTask): Promise<void> {
    if (tracked.truncated || tracked.completed) return;
    if (!VALID_TASK_NUMBER.test(tracked.task.taskNumber)) return;
    const resolved = await resolveNativeBrainFile(this.options.home, sessionId, [
      ".system_generated",
      "tasks",
      `task-${tracked.task.taskNumber}.log`,
    ]);
    if (!resolved || this.#stopped || tracked.completed) return;

    let handle;
    try {
      handle = await open(resolved, "r");
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      while (!this.#stopped && !tracked.completed && !tracked.truncated) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, tracked.offset);
        if (this.#stopped || tracked.completed || bytesRead === 0) break;
        tracked.offset += bytesRead;
        this.#appendOutput(tracked, tracked.decoder.write(buffer.subarray(0, bytesRead)));
      }
    } catch {
      return;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #readTranscriptDelta(sessionId: string): Promise<void> {
    const resolved = await resolveNativeBrainFile(this.options.home, sessionId, [
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ]);
    if (!resolved || this.#stopped) return;

    let handle;
    let decoded = "";
    try {
      handle = await open(resolved, "r");
      const size = (await handle.stat()).size;
      if (size < this.#transcriptOffset) {
        this.#transcriptOffset = 0;
        this.#transcriptDecoder = new StringDecoder("utf8");
        this.#transcriptRemainder = "";
      }
      if (size === this.#transcriptOffset) return;
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      while (!this.#stopped) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.#transcriptOffset);
        if (this.#stopped || bytesRead === 0) break;
        this.#transcriptOffset += bytesRead;
        decoded += this.#transcriptDecoder.write(buffer.subarray(0, bytesRead));
      }
    } catch {
      return;
    } finally {
      await handle?.close().catch(() => undefined);
    }

    if (!decoded) return;
    const combined = this.#transcriptRemainder + decoded;
    const lines = combined.split("\n");
    const tail = lines.pop() ?? "";
    for (const line of lines) this.#consumeTranscriptLine(line, sessionId);
    if (!tail.trim()) {
      this.#transcriptRemainder = "";
    } else if (this.#consumeTranscriptLine(tail, sessionId)) {
      this.#transcriptRemainder = "";
    } else {
      this.#transcriptRemainder = tail;
    }
  }

  #consumeTranscriptLine(line: string, sessionId: string): boolean {
    if (!line.trim()) return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (!isRecord(parsed)) return true;
    for (const settlement of parseBackgroundTaskSettlements(parsed, sessionId)) {
      this.#seenSettlements.set(settlement.taskId, settlement);
    }
    return true;
  }

  #appendOutput(tracked: TrackedBackgroundTask, text: string): void {
    if (!text || tracked.completed || tracked.truncated) return;
    const room = this.options.outputLimit - tracked.output.length;
    const accepted = text.length > room ? text.slice(0, Math.max(0, room)) : text;
    if (text.length > room) tracked.truncated = true;
    if (!accepted) return;
    tracked.output += accepted;
    if (tracked.task.item.type === "commandExecution") {
      this.options.emit({
        type: "item.updated",
        turnId: tracked.task.turnId,
        itemId: tracked.task.item.itemId,
        update: { type: "output.append", text: accepted },
      });
    } else {
      this.options.emit({
        type: "item.updated",
        turnId: tracked.task.turnId,
        itemId: tracked.task.item.itemId,
        update: {
          type: "output.replace",
          output: {
            content: [{ type: "text", text: tracked.output }],
            ...(tracked.truncated ? { truncated: true } : {}),
          },
        },
      });
    }
  }

  #complete(
    tracked: TrackedBackgroundTask,
    outcome: HostItemOutcome,
    exitCode?: number,
    fallbackOutput?: string,
  ): void {
    if (tracked.completed) return;
    tracked.completed = true;
    this.#settledTaskIds.add(tracked.task.taskId);
    this.#tasks.delete(tracked.task.taskId);

    const rawOutput = tracked.output || fallbackOutput || "";
    const truncated = tracked.truncated || rawOutput.length > this.options.outputLimit;
    const bounded = rawOutput ? rawOutput.slice(0, this.options.outputLimit) : "";
    const durationMs = Math.max(0, Date.now() - tracked.task.startedAtMs);

    const completedItem: HostCommandExecutionItem | HostToolExecutionItem =
      tracked.task.item.type === "commandExecution"
        ? {
            ...tracked.task.item,
            ...(bounded
              ? { output: bounded, ...(truncated ? { outputTruncated: true } : {}) }
              : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            durationMs,
          }
        : {
            ...tracked.task.item,
            ...(bounded
              ? {
                  output: {
                    content: [{ type: "text", text: bounded }],
                    ...(truncated ? { truncated: true } : {}),
                  },
                }
              : {}),
            durationMs,
          };

    this.options.emit({
      type: "item.completed",
      turnId: tracked.task.turnId,
      snapshot: { item: completedItem, outcome },
    });
  }
}
