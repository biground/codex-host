import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { HarnessOutput, HostEvent } from "@codexhost/harness-adapter";
import {
  hostItemIdSchema,
  hostTurnIdSchema,
  nativeSessionRefSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AntigravityAdapter, AntigravitySession } from "../src/antigravity-adapter.js";
import {
  AntigravityTransportError,
  type AntigravityAcpConfigOption,
  type AntigravityAcpTransportLike,
  type AntigravityAcpTransportOptions,
  type AntigravityActivePromptHandler,
  type AntigravityOpenAcpSessionInput,
  type AntigravityPromptInputPart,
  type AntigravityPromptResult,
  type AntigravitySessionEventHandler,
} from "../src/acp-types.js";
import {
  AntigravityBackgroundTasks,
  detectAntigravityBackgroundTask,
  findDanglingBackgroundTaskCompletion,
  parseBackgroundTaskSettlements,
} from "../src/background-tasks.js";
import { nativeBrainDirPath, nativeConversationSummariesDbPath } from "../src/fork.js";
import { AntigravityWakeObserver } from "../src/wake-observer.js";
import {
  answerStep,
  createNativeHistoryDatabase,
  systemStep,
  userStep,
} from "../../../../tests/fixtures/antigravity/native-history-fixture.js";

function required<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined);
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const config = (): AntigravityAcpConfigOption[] => [
  {
    id: "model",
    category: "model",
    name: "Model",
    currentValue: "gemini",
    options: [{ value: "gemini", name: "Gemini" }],
  },
];

class FakeTransport implements AntigravityAcpTransportLike {
  sessionId: string | null = null;
  isClosed = false;
  eventHandler: AntigravitySessionEventHandler | null = null;
  handler?: AntigravityActivePromptHandler;
  parts?: readonly AntigravityPromptInputPart[];
  promptCalls: Array<{
    parts: readonly AntigravityPromptInputPart[];
    handler: AntigravityActivePromptHandler;
    result: ReturnType<typeof deferred<AntigravityPromptResult>>;
  }> = [];
  result = deferred<AntigravityPromptResult>();
  config = config();

  constructor(readonly options: AntigravityAcpTransportOptions) {}

  get skipPermissions() {
    return this.options.skipPermissions === true;
  }

  initialize = vi.fn(async (): Promise<InitializeResponse> => ({
    protocolVersion: 1,
    agentCapabilities: {},
  }));

  setSessionEventHandler(handler: AntigravitySessionEventHandler | null) {
    this.eventHandler = handler;
  }

  setSessionInteractionHandler = vi.fn();

  openSession = vi.fn(async (input: AntigravityOpenAcpSessionInput) => {
    this.sessionId = input.sessionId ?? randomUUID();
    return {
      opened: {
        sessionId: this.sessionId,
        configOptions: this.config,
        modes: { currentModeId: "default", availableModes: [] },
      },
    };
  });

  setMode = vi.fn(async () => {});

  setConfigOption = vi.fn(async (id: string, value: string) => {
    this.config = this.config.map((entry) =>
      entry.id === id ? { ...entry, currentValue: value } : entry,
    );
    return this.config;
  });

  prompt = vi.fn(
    (parts: readonly AntigravityPromptInputPart[], handler: AntigravityActivePromptHandler) => {
      this.parts = parts;
      this.handler = handler;
      const callResult =
        this.promptCalls.length === 0 ? this.result : deferred<AntigravityPromptResult>();
      this.result = callResult;
      this.promptCalls.push({ parts, handler, result: callResult });
      return callResult.promise;
    },
  );

  steer = vi.fn(async (): Promise<AntigravityPromptResult> => ({
    stopReason: "end_turn",
  }));

  cancel = vi.fn(async () => {});

  closeSession = vi.fn(async () => {
    this.sessionId = null;
  });

  close = vi.fn(async () => {
    this.isClosed = true;
    this.result.resolve({ stopReason: "cancelled" });
  });

  fault(error = new AntigravityTransportError("processExited", "agy exited")) {
    this.isClosed = true;
    this.options.onFault?.(error);
  }
}

const adapters: AntigravityAdapter[] = [];
const homes: string[] = [];
const dbs: DatabaseSync[] = [];
const watchers: Array<{ close(): void | Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  for (const db of dbs.splice(0)) db.close();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-bg-tasks-"));
  homes.push(home);
  return home;
}

function collectOutputs(session: AntigravitySession): HarnessOutput[] {
  const outputs: HarnessOutput[] = [];
  void (async () => {
    for await (const output of session.outputs) outputs.push(output);
  })();
  return outputs;
}

function events(outputs: readonly HarnessOutput[]): HostEvent[] {
  return outputs.flatMap((output) => (output.kind === "event" ? [output.event] : []));
}

function taskLogPath(home: string, sessionId: string, taskNumber: number | string): string {
  return path.join(
    nativeBrainDirPath(sessionId, home),
    ".system_generated",
    "tasks",
    `task-${taskNumber}.log`,
  );
}

function transcriptPath(home: string, sessionId: string): string {
  return path.join(
    nativeBrainDirPath(sessionId, home),
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
}

async function writeTranscriptLines(
  home: string,
  sessionId: string,
  entries: readonly Record<string, unknown>[],
  append = false,
): Promise<string> {
  const file = transcriptPath(home, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const text = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  if (append) await appendFile(file, text);
  else await writeFile(file, text);
  return file;
}

async function setConversationSummaryStatus(
  home: string,
  sessionId: string,
  status: "CASCADE_RUN_STATUS_RUNNING" | "CASCADE_RUN_STATUS_IDLE",
): Promise<void> {
  const dbPath = nativeConversationSummariesDbPath(home);
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT, status TEXT)",
    );
    db.prepare(
      "INSERT OR REPLACE INTO conversation_summaries (conversation_id, parent_conversation_id, status) VALUES (?, NULL, ?)",
    ).run(sessionId, status);
  } finally {
    db.close();
  }
}

function taskSystemMessage(params: {
  stepIndex: number;
  taskId: string;
  verb?: "finished" | "was canceled";
  resultBody: string;
}): Record<string, unknown> {
  const verb = params.verb ?? "finished";
  return {
    step_index: params.stepIndex,
    source: "SYSTEM",
    type: "SYSTEM_MESSAGE",
    status: "DONE",
    content: [
      "The following is a <SYSTEM_MESSAGE> not actually sent by the user.",
      "",
      "<SYSTEM_MESSAGE>",
      `[Message] timestamp=2026-11-24T03:13:06Z sender=${params.taskId} priority=MESSAGE_PRIORITY_HIGH content=Task id "${params.taskId}" ${verb} with result:`,
      params.resultBody,
      "</SYSTEM_MESSAGE>",
    ].join("\n"),
  };
}

describe("Antigravity background task detection and transcript parsing", () => {
  it("detects non-daemon run_command and one-shot schedule while ignoring daemons and crons", () => {
    const sid = randomUUID();
    const spawnOutput = `Tool is running as a background task with task id: ${sid}/task-7\nTask logs are available at: file:///tmp/task-7.log`;

    expect(
      detectAntigravityBackgroundTask({
        toolName: "run_command",
        kind: "execute",
        args: { CommandLine: "npm run build", WaitMsBeforeAsync: 5000 },
        output: spawnOutput,
        nativeSessionId: sid,
      }),
    ).toEqual({ taskId: `${sid}/task-7`, sessionId: sid, taskNumber: "7" });

    expect(
      detectAntigravityBackgroundTask({
        toolName: "run_command",
        kind: "execute",
        args: { CommandLine: "npm run dev", IsDaemon: true },
        output: spawnOutput,
        nativeSessionId: sid,
      }),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTask({
        toolName: "schedule",
        args: { DurationSeconds: 60, Prompt: "check build" },
        output: spawnOutput,
        nativeSessionId: sid,
      }),
    ).toEqual({ taskId: `${sid}/task-7`, sessionId: sid, taskNumber: "7" });

    expect(
      detectAntigravityBackgroundTask({
        toolName: "schedule",
        args: { CronExpression: "*/5 * * * *", Prompt: "poll" },
        output: spawnOutput,
        nativeSessionId: sid,
      }),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTask({
        toolName: "schedule",
        args: { DurationSeconds: 60, IsDaemon: true, Prompt: "daemon" },
        output: spawnOutput,
        nativeSessionId: sid,
      }),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTask({
        toolName: "run_command",
        kind: "execute",
        args: { CommandLine: "echo spoofed" },
        output: spawnOutput,
        nativeSessionId: randomUUID(),
      }),
    ).toBeNull();
  });

  it("parses finished and canceled settlements while ignoring still-running progress messages", () => {
    const sid = randomUUID();
    const taskId = `${sid}/task-17`;
    expect(
      parseBackgroundTaskSettlements(
        {
          step_index: 12,
          type: "SYSTEM_MESSAGE",
          status: "DONE",
          content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-24T03:15:05Z sender=${taskId} priority=MESSAGE_PRIORITY_HIGH content=Background command is still running after 180s: npm ci\n</SYSTEM_MESSAGE>`,
        },
        sid,
      ),
    ).toEqual([]);

    expect(
      parseBackgroundTaskSettlements(
        taskSystemMessage({
          stepIndex: 13,
          taskId,
          resultBody: "Command exited with code 2.\n\nCommand output:\nbuild failed",
        }),
        sid,
      ),
    ).toEqual([
      {
        taskId,
        stepIndex: 13,
        kind: "finished",
        exitCode: 2,
        resultText: "Command exited with code 2.\n\nCommand output:\nbuild failed",
      },
    ]);

    expect(
      parseBackgroundTaskSettlements(
        taskSystemMessage({
          stepIndex: 14,
          taskId,
          verb: "was canceled",
          resultBody: "Canceled by user",
        }),
        sid,
      ),
    ).toEqual([
      {
        taskId,
        stepIndex: 14,
        kind: "cancelled",
        resultText: "Canceled by user",
      },
    ]);
  });

  it("rejects symlinked task logs pointing outside the native brain directory", async () => {
    const home = await createHome();
    const sid = randomUUID();
    const outsideDir = path.join(home, "outside-tasks");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "task-9.log"), "top-secret");
    const tasksDir = path.dirname(taskLogPath(home, sid, 9));
    await mkdir(path.dirname(tasksDir), { recursive: true });
    await symlink(outsideDir, tasksDir, process.platform === "win32" ? "junction" : "dir");

    const emitted: HostEvent[] = [];
    const tracker = new AntigravityBackgroundTasks({
      nativeSessionId: () => sid,
      home,
      outputLimit: 1024,
      pollIntervalMs: 50,
      emit: (event) => emitted.push(event),
    });
    watchers.push(tracker);
    tracker.track({
      taskId: `${sid}/task-9`,
      taskNumber: "9",
      turnId: hostTurnIdSchema.parse("t1"),
      item: {
        type: "commandExecution",
        itemId: hostItemIdSchema.parse("cmd-9"),
        command: "cat secret",
        cwd: home,
      },
      startedAtMs: Date.now(),
    });
    await tracker.refresh();
    expect(emitted).toEqual([]);
  });
});

describe("Antigravity background command tracking, wake lease, and recovery", () => {
  it("tracks detached run_command, streams task log deltas, transitions into expectWake, and resets hasBackgroundWork after wake commit", async () => {
    const home = await createHome();
    const transports: FakeTransport[] = [];
    const adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      backgroundTaskPollIntervalMs: 25,
      wakePollIntervalMs: 25,
      createTransport: (options) => {
        const transport = new FakeTransport(options);
        transports.push(transport);
        return transport;
      },
    });
    adapters.push(adapter);

    const opened = await adapter.open({ kind: "create", cwd: home });
    assert(opened.ok && opened.value instanceof AntigravitySession);
    const session = opened.value;
    const outputs = collectOutputs(session);

    expect(
      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("t1"),
        input: [{ type: "text", text: "build apk" }],
      }),
    ).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(transports[0]?.prompt).toHaveBeenCalledOnce());
    const transport = required(transports[0]);
    const sid = required(transport.sessionId);
    const db = await createNativeHistoryDatabase(home, sid);
    dbs.push(db);
    userStep(db, 0, "build apk", "fg-run");
    answerStep(db, 1, "Starting build.", "fg-run");
    await setConversationSummaryStatus(home, sid, "CASCADE_RUN_STATUS_IDLE");

    const taskId = `${sid}/task-1`;
    const log = taskLogPath(home, sid, 1);
    await mkdir(path.dirname(log), { recursive: true });
    await writeFile(log, "Compiling step 1\n");

    required(transport.handler).onEvent({
      type: "tool.call",
      toolCallId: "cmd-1",
      name: "run_command",
      kind: "execute",
      status: "in_progress",
      args: { CommandLine: "./gradlew assembleRelease", WaitMsBeforeAsync: 5000 },
    });
    required(transport.handler).onEvent({
      type: "tool.update",
      toolCallId: "cmd-1",
      status: "completed",
      rawOutput: `Tool is running as a background task with task id: ${taskId}\nTask logs are available at: file:///${log.replaceAll("\\", "/")}`,
    });
    transport.result.resolve({ stopReason: "end_turn" });

    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({ type: "turn.completed", turnId: "t1" }),
      ),
    );

    const afterTurn = events(outputs);
    const detached = afterTurn.find((event) => event.type === "item.detached");
    expect(detached).toBeDefined();
    assert(detached?.type === "item.detached");
    expect(
      afterTurn.some(
        (event) =>
          event.type === "item.completed" && event.snapshot.item.itemId === detached.itemId,
      ),
    ).toBe(false);
    expect(session.hasBackgroundWork()).toBe(true);

    // First log chunk streams as output.append
    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual({
        type: "item.updated",
        turnId: "t1",
        itemId: detached.itemId,
        update: { type: "output.append", text: "Compiling step 1\n" },
      }),
    );

    // Second log chunk streams incrementally
    await appendFile(log, "APK ready\n");
    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual({
        type: "item.updated",
        turnId: "t1",
        itemId: detached.itemId,
        update: { type: "output.append", text: "APK ready\n" },
      }),
    );

    // Task completes in transcript.jsonl -> item.completed fires, then seamlessly transitions to expectWake()
    await appendFile(log, "Done.\n");
    await writeTranscriptLines(home, sid, [
      taskSystemMessage({
        stepIndex: 5,
        taskId,
        resultBody: "Command exited with code 0.\n\nCommand output:\nDone.",
      }),
    ]);

    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          turnId: "t1",
          snapshot: expect.objectContaining({
            outcome: { status: "succeeded" },
            item: expect.objectContaining({
              type: "commandExecution",
              itemId: detached.itemId,
              exitCode: 0,
              output: "Compiling step 1\nAPK ready\nDone.\n",
            }),
          }),
        }),
      ),
    );

    // Still holding background work while waiting for agy's autonomous wake commit
    expect(session.hasBackgroundWork()).toBe(true);

    // agy runs autonomous wake and commits SQLite wake turn
    await setConversationSummaryStatus(home, sid, "CASCADE_RUN_STATUS_RUNNING");
    systemStep(db, 5, "wake-run");
    answerStep(db, 6, "Build finished successfully!", "wake-run");
    await setConversationSummaryStatus(home, sid, "CASCADE_RUN_STATUS_IDLE");

    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({
          type: "turn.autonomous.completed",
          snapshot: expect.objectContaining({
            nativeTurnRef: expect.objectContaining({ nativeTurnKey: "wake-5" }),
            items: [
              expect.objectContaining({
                item: expect.objectContaining({
                  type: "agentMessage",
                  text: "Build finished successfully!",
                }),
              }),
            ],
          }),
        }),
      ),
    );

    await vi.waitFor(() => expect(session.hasBackgroundWork()).toBe(false));
    const bgChanges = events(outputs).filter(
      (event) => event.type === "session.backgroundWork.changed",
    );
    expect(bgChanges).toEqual([
      { type: "session.backgroundWork.changed", active: true },
      { type: "session.backgroundWork.changed", active: false },
    ]);
  });

  it("marks non-zero background exit codes as failed and settles manage_task kill cleanly", async () => {
    const home = await createHome();
    const transports: FakeTransport[] = [];
    const adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      backgroundTaskPollIntervalMs: 25,
      wakePollIntervalMs: 25,
      createTransport: (options) => {
        const transport = new FakeTransport(options);
        transports.push(transport);
        return transport;
      },
    });
    adapters.push(adapter);

    const opened = await adapter.open({ kind: "create", cwd: home });
    assert(opened.ok && opened.value instanceof AntigravitySession);
    const session = opened.value;
    const outputs = collectOutputs(session);

    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("t1"),
      input: [{ type: "text", text: "run tests" }],
    });
    await vi.waitFor(() => expect(transports[0]?.prompt).toHaveBeenCalledOnce());
    const transport = required(transports[0]);
    const sid = required(transport.sessionId);

    const failTask = `${sid}/task-2`;
    const killTask = `${sid}/task-3`;
    required(transport.handler).onEvent({
      type: "tool.call",
      toolCallId: "cmd-fail",
      name: "run_command",
      kind: "execute",
      status: "completed",
      args: { CommandLine: "npm test" },
      rawOutput: `Tool is running as a background task with task id: ${failTask}`,
    });
    required(transport.handler).onEvent({
      type: "tool.call",
      toolCallId: "sched-kill",
      name: "schedule",
      status: "completed",
      args: { DurationSeconds: 30, Prompt: "ping" },
      rawOutput: `Tool is running as a background task with task id: ${killTask}`,
    });
    required(transport.handler).onEvent({
      type: "tool.call",
      toolCallId: "kill-call",
      name: "manage_task",
      status: "completed",
      args: { Action: "kill", TaskId: killTask },
      rawOutput: "Killed",
    });
    transport.result.resolve({ stopReason: "end_turn" });

    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({ type: "turn.completed", turnId: "t1" }),
      ),
    );

    const detachedEvents = events(outputs).filter(
      (event): event is Extract<HostEvent, { type: "item.detached" }> =>
        event.type === "item.detached",
    );
    expect(detachedEvents).toHaveLength(2);
    const failDetached = required(detachedEvents[0]);
    const killDetached = required(detachedEvents[1]);

    // manage_task kill settled the schedule task as cancelled immediately
    expect(events(outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: "t1",
        snapshot: expect.objectContaining({
          item: expect.objectContaining({ itemId: killDetached.itemId, type: "toolExecution" }),
          outcome: expect.objectContaining({ status: "cancelled" }),
        }),
      }),
    );

    // Non-zero exit code settles cmd-fail as failed with exitCode: 2
    await writeTranscriptLines(home, sid, [
      taskSystemMessage({
        stepIndex: 4,
        taskId: failTask,
        resultBody: "Command exited with code 2.\n\nCommand output:\nFAIL test.ts",
      }),
    ]);

    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({
          type: "item.completed",
          turnId: "t1",
          snapshot: expect.objectContaining({
            outcome: expect.objectContaining({ status: "failed" }),
            item: expect.objectContaining({
              itemId: failDetached.itemId,
              exitCode: 2,
              output: expect.stringContaining("Command exited with code 2"),
            }),
          }),
        }),
      ),
    );
  });

  it("completes IsDaemon: true run_command normally without item.detached and leaves hasBackgroundWork false", async () => {
    const home = await createHome();
    const transports: FakeTransport[] = [];
    const adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: (options) => {
        const transport = new FakeTransport(options);
        transports.push(transport);
        return transport;
      },
    });
    adapters.push(adapter);

    const opened = await adapter.open({ kind: "create", cwd: home });
    assert(opened.ok && opened.value instanceof AntigravitySession);
    const session = opened.value;
    const outputs = collectOutputs(session);

    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("t-daemon"),
      input: [{ type: "text", text: "start dev server" }],
    });
    await vi.waitFor(() => expect(transports[0]?.prompt).toHaveBeenCalledOnce());
    const transport = required(transports[0]);
    const sid = required(transport.sessionId);

    required(transport.handler).onEvent({
      type: "tool.call",
      toolCallId: "daemon-1",
      name: "run_command",
      kind: "execute",
      status: "in_progress",
      args: { CommandLine: "npm run dev", IsDaemon: true },
    });
    required(transport.handler).onEvent({
      type: "tool.update",
      toolCallId: "daemon-1",
      status: "completed",
      rawOutput: `Tool is running as a background task with task id: ${sid}/task-10`,
    });
    transport.result.resolve({ stopReason: "end_turn" });

    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({ type: "turn.completed", turnId: "t-daemon" }),
      ),
    );

    expect(events(outputs).some((event) => event.type === "item.detached")).toBe(false);
    expect(events(outputs)).toContainEqual(
      expect.objectContaining({
        type: "item.completed",
        turnId: "t-daemon",
        snapshot: expect.objectContaining({
          outcome: { status: "succeeded" },
          item: expect.objectContaining({ type: "commandExecution", exitCode: 0 }),
        }),
      }),
    );
    expect(session.hasBackgroundWork()).toBe(false);
  });

  it("keeps hasBackgroundWork true beyond 10s during long RUNNING wakes and expectWake prefill windows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const home = await createHome();
    const sid = randomUUID();
    const db = await createNativeHistoryDatabase(home, sid);
    dbs.push(db);
    userStep(db, 0, "start", "fg");
    answerStep(db, 1, "running", "fg");
    await setConversationSummaryStatus(home, sid, "CASCADE_RUN_STATUS_IDLE");

    const published: string[] = [];
    const onTimeout = vi.fn();
    const observer = new AntigravityWakeObserver({
      nativeSessionId: sid,
      cwd: home,
      home,
      cursor: -1,
      outputLimit: 4096,
      pollIntervalMs: 1_000,
      commitWaitMs: 10_000,
      activityLeaseMs: 90_000,
      expectWakeWaitMs: 90_000,
      runningHardCapMs: 30 * 60_000,
      canPublish: () => true,
      publish: (snapshot) => published.push(snapshot.nativeTurnRef.nativeTurnKey),
      onExpectedWakeTimeout: onTimeout,
    });
    watchers.push(observer);

    // 1) Task finished -> expectWake(). Even 30s (> 10s) later before agy flips RUNNING or emits ACP tokens,
    //    observer stays active.
    observer.expectWake({ stepIndex: 2, taskId: `${sid}/task-1` });
    expect(observer.observing).toBe(true);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(observer.observing).toBe(true);
    expect(published).toEqual([]);
    expect(onTimeout).not.toHaveBeenCalled();

    // 2) agy flips to CASCADE_RUN_STATUS_RUNNING and runs for 2 full minutes (> 90s activity lease)
    //    without emitting a single ACP token (e.g. long thinking / slow tool inside autonomous wake).
    await setConversationSummaryStatus(home, sid, "CASCADE_RUN_STATUS_RUNNING");
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(observer.observing).toBe(true);
    }
    expect(onTimeout).not.toHaveBeenCalled();

    // 3) agy commits wake-2 and flips back to IDLE -> publishes turn.autonomous.completed and stops observing.
    systemStep(db, 2, "wake-run");
    answerStep(db, 3, "Long wake completed.", "wake-run");
    await setConversationSummaryStatus(home, sid, "CASCADE_RUN_STATUS_IDLE");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(published).toEqual(["wake-2"]);
    expect(observer.observing).toBe(false);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("triggers idempotent dangling task wake recovery once when idle (including after restart notice) and skips when a user turn.start runs", async () => {
    const home = await createHome();
    const sid = randomUUID();
    const taskId = `${sid}/task-4`;
    const nativeRef = nativeSessionRefSchema.parse({
      harnessId: "antigravity",
      nativeSessionId: sid,
      formatVersion: 1,
    });

    await setConversationSummaryStatus(home, sid, "CASCADE_RUN_STATUS_IDLE");
    await writeTranscriptLines(home, sid, [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "hi" },
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "running",
      },
      taskSystemMessage({
        stepIndex: 3,
        taskId,
        resultBody: "Command exited with code 0.\n\nCommand output:\nall green",
      }),
      {
        step_index: 4,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        content:
          "<SYSTEM_MESSAGE>\n[Message] sender=system content=[Notice] All your subagents and background tasks have been stopped due to server restart\n</SYSTEM_MESSAGE>",
      },
    ]);

    expect(await findDanglingBackgroundTaskCompletion(home, sid)).toEqual({
      stepIndex: 3,
      taskIds: [taskId],
    });

    // (a) When a user turn.start is submitted concurrently on open, recovery MUST be skipped.
    const userTransports: FakeTransport[] = [];
    const userAdapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: (options) => {
        const transport = new FakeTransport(options);
        userTransports.push(transport);
        return transport;
      },
    });
    adapters.push(userAdapter);

    const userOpen = await userAdapter.open({ kind: "resume", cwd: home, nativeRef });
    assert(userOpen.ok && userOpen.value instanceof AntigravitySession);
    const userSession = userOpen.value;
    const userOutputs = collectOutputs(userSession);

    expect(
      await userSession.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("user-t1"),
        input: [{ type: "text", text: "如何了？" }],
      }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(userTransports[0]?.prompt).toHaveBeenCalledOnce());
    expect(userTransports[0]?.parts).toEqual([{ type: "text", text: "如何了？" }]);
    required(userTransports[0]).result.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() =>
      expect(events(userOutputs)).toContainEqual(
        expect.objectContaining({ type: "turn.completed", turnId: "user-t1" }),
      ),
    );
    expect(events(userOutputs).some((event) => event.type === "turn.autonomous.started")).toBe(
      false,
    );
    expect(userTransports[0]?.prompt).toHaveBeenCalledTimes(1);
    await userSession.close();

    // (b) When opened/initialized while idle, recovery triggers automatically ONCE and never repeats
    //     for the same step_index across a reopen on the same Adapter.
    const idleTransports: FakeTransport[] = [];
    const idleAdapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      createTransport: (options) => {
        const transport = new FakeTransport(options);
        idleTransports.push(transport);
        return transport;
      },
    });
    adapters.push(idleAdapter);

    const idleOpen1 = await idleAdapter.open({ kind: "resume", cwd: home, nativeRef });
    assert(idleOpen1.ok && idleOpen1.value instanceof AntigravitySession);
    const session1 = idleOpen1.value;
    const outputs1 = collectOutputs(session1);

    await session1.initialize();
    await vi.waitFor(() => expect(idleTransports[0]?.prompt).toHaveBeenCalledOnce());
    expect(events(outputs1)).toContainEqual(
      expect.objectContaining({ type: "turn.autonomous.started", input: [] }),
    );
    const idleTransport1 = required(idleTransports[0]);
    required(idleTransport1.handler).onEvent({
      type: "agent.text",
      text: "Recovered result summary.",
    });
    idleTransport1.result.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() =>
      expect(events(outputs1)).toContainEqual(
        expect.objectContaining({
          type: "turn.completed",
          outcome: expect.objectContaining({ status: "succeeded" }),
        }),
      ),
    );
    await vi.waitFor(() => expect(session1.hasBackgroundWork()).toBe(false));
    await session1.close();

    // Reopen the same session with the exact same dangling step_index still on disk -> idempotent skip!
    const idleOpen2 = await idleAdapter.open({ kind: "resume", cwd: home, nativeRef });
    assert(idleOpen2.ok && idleOpen2.value instanceof AntigravitySession);
    const session2 = idleOpen2.value;
    const outputs2 = collectOutputs(session2);
    await session2.initialize();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(idleTransports[1]?.prompt).not.toHaveBeenCalled();
    expect(events(outputs2).some((event) => event.type === "turn.autonomous.started")).toBe(false);
    await session2.close();
  });

  it("triggers dangling recovery when expectWake times out while agy stays IDLE", async () => {
    const home = await createHome();
    const transports: FakeTransport[] = [];
    const adapter = new AntigravityAdapter({
      environment: { HOME: home, USERPROFILE: home },
      backgroundTaskPollIntervalMs: 20,
      wakePollIntervalMs: 20,
      wakeExpectWaitMs: 60,
      createTransport: (options) => {
        const transport = new FakeTransport(options);
        transports.push(transport);
        return transport;
      },
    });
    adapters.push(adapter);

    const opened = await adapter.open({ kind: "create", cwd: home });
    assert(opened.ok && opened.value instanceof AntigravitySession);
    const session = opened.value;
    const outputs = collectOutputs(session);

    await session.execute({
      type: "turn.start",
      turnId: hostTurnIdSchema.parse("t1"),
      input: [{ type: "text", text: "run job" }],
    });
    await vi.waitFor(() => expect(transports[0]?.prompt).toHaveBeenCalledOnce());
    const transport = required(transports[0]);
    const sid = required(transport.sessionId);
    const taskId = `${sid}/task-8`;
    await setConversationSummaryStatus(home, sid, "CASCADE_RUN_STATUS_IDLE");

    required(transport.handler).onEvent({
      type: "tool.call",
      toolCallId: "cmd-8",
      name: "run_command",
      kind: "execute",
      status: "completed",
      args: { CommandLine: "long-job" },
      rawOutput: `Tool is running as a background task with task id: ${taskId}`,
    });
    transport.result.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() =>
      expect(events(outputs)).toContainEqual(
        expect.objectContaining({ type: "turn.completed", turnId: "t1" }),
      ),
    );

    // Task completes in transcript.jsonl, but agy stays IDLE and never writes a wake turn.
    await writeTranscriptLines(home, sid, [
      taskSystemMessage({
        stepIndex: 9,
        taskId,
        resultBody: "Command exited with code 0.\n\nCommand output:\nfinished",
      }),
    ]);

    // expectWake times out after 60ms -> automatically runs one autonomous recovery turn!
    await vi.waitFor(() => expect(transport.prompt).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(events(outputs)).toContainEqual(
      expect.objectContaining({ type: "turn.autonomous.started", input: [] }),
    );
    required(transport.handler).onEvent({
      type: "agent.text",
      text: "Handled after wake timeout.",
    });
    transport.result.resolve({ stopReason: "end_turn" });

    await vi.waitFor(() =>
      expect(events(outputs).filter((event) => event.type === "turn.completed")).toHaveLength(2),
    );
    await vi.waitFor(() => expect(session.hasBackgroundWork()).toBe(false));
    const bgChanges = events(outputs).filter(
      (event) => event.type === "session.backgroundWork.changed",
    );
    expect(bgChanges).toEqual([
      { type: "session.backgroundWork.changed", active: true },
      { type: "session.backgroundWork.changed", active: false },
    ]);
  });

  it.each(["fault", "close"] as const)(
    "settles detached task cleanly and resets hasBackgroundWork on transport %s",
    async (mode) => {
      const home = await createHome();
      const transports: FakeTransport[] = [];
      const adapter = new AntigravityAdapter({
        environment: { HOME: home, USERPROFILE: home },
        backgroundTaskPollIntervalMs: 25,
        createTransport: (options) => {
          const transport = new FakeTransport(options);
          transports.push(transport);
          return transport;
        },
      });
      adapters.push(adapter);

      const opened = await adapter.open({ kind: "create", cwd: home });
      assert(opened.ok && opened.value instanceof AntigravitySession);
      const session = opened.value;
      const outputs = collectOutputs(session);

      await session.execute({
        type: "turn.start",
        turnId: hostTurnIdSchema.parse("t-exit"),
        input: [{ type: "text", text: "build" }],
      });
      await vi.waitFor(() => expect(transports[0]?.prompt).toHaveBeenCalledOnce());
      const transport = required(transports[0]);
      const sid = required(transport.sessionId);

      required(transport.handler).onEvent({
        type: "tool.call",
        toolCallId: "cmd-exit",
        name: "run_command",
        kind: "execute",
        status: "completed",
        args: { CommandLine: "sleep 600" },
        rawOutput: `Tool is running as a background task with task id: ${sid}/task-5`,
      });
      transport.result.resolve({ stopReason: "end_turn" });
      await vi.waitFor(() =>
        expect(events(outputs)).toContainEqual(
          expect.objectContaining({ type: "turn.completed", turnId: "t-exit" }),
        ),
      );

      const detached = required(
        events(outputs).find(
          (event): event is Extract<HostEvent, { type: "item.detached" }> =>
            event.type === "item.detached",
        ),
      );
      expect(session.hasBackgroundWork()).toBe(true);

      if (mode === "fault") {
        transport.fault(new AntigravityTransportError("processExited", "agy crashed"));
      } else {
        await session.close();
      }

      expect(session.hasBackgroundWork()).toBe(false);
      await vi.waitFor(() =>
        expect(events(outputs)).toContainEqual(
          expect.objectContaining({
            type: "item.completed",
            turnId: "t-exit",
            snapshot: expect.objectContaining({
              item: expect.objectContaining({ itemId: detached.itemId }),
              outcome: expect.objectContaining({
                status: mode === "fault" ? "failed" : "cancelled",
              }),
            }),
          }),
        ),
      );
      if (mode === "fault") {
        const all = events(outputs);
        const completedIndex = all.findIndex(
          (event) =>
            event.type === "item.completed" && event.snapshot.item.itemId === detached.itemId,
        );
        const faultedIndex = all.findIndex((event) => event.type === "session.faulted");
        expect(completedIndex).toBeGreaterThanOrEqual(0);
        expect(faultedIndex).toBeGreaterThan(completedIndex);
      }
    },
  );
});
