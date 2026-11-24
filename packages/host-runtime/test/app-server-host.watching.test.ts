import { describe, expect, it, vi } from "vitest";
import type { HostTurnSnapshot } from "@codexhost/harness-adapter";
import { FakeHarnessAdapter, type FakeHarnessSession } from "@codexhost/harness-adapter/testing";
import type { JsonObject } from "@codexhost/protocol-core";
import {
  harnessIdSchema,
  hostItemIdSchema,
  hostTurnIdSchema,
  THREAD_WATCHING_READ_METHOD,
  THREAD_WATCHING_UPDATED_METHOD,
  type ThreadWatchingReadResult,
} from "@codexhost/shared-contracts";
import { DelegationControlRegistry } from "../src/delegation-control-registry.js";
import {
  bindOfficialThread,
  createFixture,
  messageParams,
  method,
  readJsonLine,
  requestId,
  startExternalThread,
  startPiThread,
  startPiTurn,
  stopFixture,
  threadStatus,
  turnEvent,
  writeRequest,
} from "./app-server-host-fixture.js";

function required<T>(value: T | null | undefined, message: string): T {
  if (value == null) throw new Error(message);
  return value;
}

function setBackgroundWork(session: FakeHarnessSession, check: () => boolean): void {
  Object.assign(session, { hasBackgroundWork: check });
}

let nextReadRequestId = 200;

async function readWatching(
  fixture: ReturnType<typeof createFixture>,
  id = ++nextReadRequestId,
): Promise<ThreadWatchingReadResult> {
  writeRequest(fixture.desktopInput, {
    id,
    method: THREAD_WATCHING_READ_METHOD,
    params: {},
  });
  const reply = await fixture.collector.waitFor((message) => requestId(message, id));
  expect(reply).not.toHaveProperty("error");
  return reply.result as ThreadWatchingReadResult;
}

describe("Background-aware delegation completion and watching indicators", () => {
  it("keeps delegated child running across detached background work and wakes watch only after autonomous wake settles", async () => {
    const registry = new DelegationControlRegistry();
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("antigravity"));
    const fixture = createFixture({
      externalAdapters: new Map([["antigravity", adapter]]),
      onDelegationApi: (registration) => registry.register(registration, { harnessCatalog: true }),
      watchingSubscribers: () => registry.watchingBySubscriber(),
      onWatchesChanged: (listener) => registry.subscribeChanges(listener),
    });
    try {
      await fixture.ready;
      const supervisorId = await startExternalThread(fixture, "codexhost/antigravity-native", 1);
      const started = await registry.start({
        harnessId: "antigravity",
        parentThreadId: supervisorId,
        cwd: process.cwd(),
        task: "Build APK in background",
        taskName: "APK Build",
      });
      const childId = started.threadId;
      const childTurnId = hostTurnIdSchema.parse(started.turnId);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", childTurnId));

      const childSession = required(adapter.sessions[1], "Missing delegated child session");
      const childNativeSessionId = required(
        childSession.initialState.nativeRef?.nativeSessionId,
        "Missing child nativeSessionId",
      );
      let backgroundWorkActive = true;
      setBackgroundWork(childSession, () => backgroundWorkActive);

      const watchResult = await registry.watch({
        threadId: childId,
        notifyThreadId: supervisorId,
        timeoutMs: 60_000,
      });
      expect(watchResult).toMatchObject({ state: "watching", status: "running" });

      // Child starts a background command, detaches it, and completes its foreground turn.
      const cmdItemId = childSession.startCommandExecution("gradlew assembleRelease");
      childSession.detachItem(cmdItemId);
      childSession.appendText("Build started in background; waiting for completion.");
      childSession.succeedTurn();

      // Foreground wire status turns idle (so Send is never blocked), while watching shows BOTH
      // the supervisor's outgoing watch AND the child's backgroundWork!
      await fixture.collector.waitFor((message) => threadStatus(message, childId, "idle"));
      const watchingMid = await readWatching(fixture, 20);
      expect(watchingMid.threads[supervisorId]).toEqual({
        watchCount: 1,
        watchTargets: ["APK Build"],
        backgroundWork: false,
      });
      expect(watchingMid.threads[childId]).toEqual({
        watchCount: 0,
        backgroundWork: true,
      });

      // Delegation read, wait, and list must all report "running" and watch must NOT deliver early.
      const midRead = await registry.read({ threadId: childId, view: "result" });
      expect(midRead.status).toBe("running");
      const midWait = await registry.wait({ threadId: childId, timeoutMs: 120, view: "result" });
      expect(midWait.timedOut).toBe(true);
      expect(midWait.status).toBe("running");
      const midList = await registry.list({
        parentThreadId: supervisorId,
        limit: 10,
        sort: "updated-desc",
      });
      expect(midList.threads.find((row) => row.threadId === childId)?.status).toBe("running");
      expect((await registry.watches()).watches).toMatchObject([
        { threadId: childId, notifyThreadId: supervisorId, state: "watching" },
      ]);

      // Background task completes and autonomous wake publishes the final answer.
      childSession.emitEvent({
        type: "item.completed",
        turnId: childTurnId,
        snapshot: {
          item: {
            type: "commandExecution",
            itemId: cmdItemId,
            command: "gradlew assembleRelease",
            cwd: process.cwd(),
            output: "BUILD SUCCESSFUL",
            exitCode: 0,
          },
          outcome: { status: "succeeded" },
        },
      });

      const autonomousTurn: HostTurnSnapshot = {
        nativeTurnRef: {
          harnessId: adapter.harnessId,
          nativeSessionId: childNativeSessionId,
          nativeTurnKey: "wake-1",
          formatVersion: 1,
        },
        input: [],
        items: [
          {
            item: {
              type: "agentMessage",
              itemId: hostItemIdSchema.parse("wake-final-answer"),
              text: "APK build finished successfully at app-release.apk.",
              phase: "final_answer",
            },
            outcome: { status: "succeeded" },
          },
        ],
        outcome: { status: "succeeded" },
      };
      // Keep native readSnapshot consistent with the committed autonomous turn.
      const baseReadSnapshot = childSession.readSnapshot.bind(childSession);
      childSession.readSnapshot = async () => {
        const snapshot = await baseReadSnapshot();
        if (!snapshot.ok) return snapshot;
        return {
          ok: true,
          value: {
            ...snapshot.value,
            turns: [...snapshot.value.turns, autonomousTurn],
          },
        };
      };

      const afterMid = fixture.collector.messages.length;
      childSession.emitEvent({
        type: "turn.autonomous.completed",
        snapshot: autonomousTurn,
      });

      // Still holding while backgroundWorkActive is true until wake observer settles.
      backgroundWorkActive = false;
      childSession.emitEvent({
        type: "session.backgroundWork.changed",
        active: false,
      });

      // Watch delivers immediately to supervisor once background work settles.
      await vi.waitFor(() => {
        const updates = fixture.collector.messages.slice(afterMid);
        expect(
          updates.find(
            (message) =>
              method(message, "item/started") &&
              messageParams(message).threadId === supervisorId &&
              (messageParams(message).item as JsonObject | undefined)?.type === "userMessage",
          ),
        ).toMatchObject({
          params: {
            item: {
              content: [{ text: expect.stringContaining(`(thread://${childId}): completed`) }],
            },
          },
        });
      });

      const finalRead = await registry.read({ threadId: childId, view: "result" });
      expect(finalRead.status).toBe("completed");
      expect(finalRead.result.text).toContain("app-release.apk");

      const watchingAfter = await readWatching(fixture, 21);
      expect(watchingAfter.threads[childId]).toBeUndefined();
      expect(watchingAfter.threads[supervisorId]).toBeUndefined();
    } finally {
      registry.close();
      await stopFixture(fixture);
    }
  });

  it("keeps foreground thread send unblocked while background work is active", async () => {
    const registry = new DelegationControlRegistry();
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      onDelegationApi: (registration) => registry.register(registration, { harnessCatalog: true }),
      watchingSubscribers: () => registry.watchingBySubscriber(),
      onWatchesChanged: (listener) => registry.subscribeChanges(listener),
    });
    try {
      const threadId = await startPiThread(fixture);
      const firstTurnId = hostTurnIdSchema.parse(await startPiTurn(fixture, threadId, 2));
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", firstTurnId));
      const session = required(adapter.sessions[0], "Missing session");
      let backgroundWorkActive = true;
      setBackgroundWork(session, () => backgroundWorkActive);

      session.appendText("Background job launched");
      session.succeedTurn();
      await fixture.collector.waitFor((message) => threadStatus(message, threadId, "idle"));

      expect((await readWatching(fixture, 30)).threads[threadId]).toEqual({
        watchCount: 0,
        backgroundWork: true,
      });

      // Sending a new foreground message must NOT be rejected with THREAD_BUSY.
      const sent = await registry.send({ threadId, message: "Check status while running" });
      expect(sent.turnId).toBeTruthy();

      // While the foreground turn runs, watching hides; when it finishes with backgroundWork still true, it reappears.
      const secondTurnId = hostTurnIdSchema.parse(sent.turnId);
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/started", secondTurnId),
      );
      expect((await readWatching(fixture, 31)).threads[threadId]).toBeUndefined();

      session.appendText("Still building");
      session.succeedTurn();
      await fixture.collector.waitFor((message) =>
        turnEvent(message, "turn/completed", secondTurnId),
      );
      expect((await readWatching(fixture, 32)).threads[threadId]).toEqual({
        watchCount: 0,
        backgroundWork: true,
      });

      backgroundWorkActive = false;
      session.emitEvent({ type: "session.backgroundWork.changed", active: false });
      await vi.waitFor(async () => {
        expect((await readWatching(fixture)).threads[threadId]).toBeUndefined();
      });
    } finally {
      registry.close();
      await stopFixture(fixture);
    }
  });

  it("reports, hides during active turn, and clears watching for a native Codex supervisor thread", async () => {
    const registry = new DelegationControlRegistry();
    const adapter = new FakeHarnessAdapter(harnessIdSchema.parse("pi"));
    const fixture = createFixture({
      externalAdapters: new Map([["pi", adapter]]),
      onDelegationApi: (registration) => registry.register(registration, { harnessCatalog: true }),
      watchingSubscribers: () => registry.watchingBySubscriber(),
      onWatchesChanged: (listener) => registry.subscribeChanges(listener),
    });
    try {
      await fixture.ready;
      await bindOfficialThread(fixture, "codex-supervisor");

      const childId = await startPiThread(fixture);
      const childTurnId = await startPiTurn(fixture, childId, 2);
      await fixture.collector.waitFor((message) => turnEvent(message, "turn/started", childTurnId));

      const answerOfficial = (id: unknown, result: JsonObject) => {
        fixture.official.stdout.write(`${JSON.stringify({ id, result })}\n`);
      };
      const idleThreadResult = {
        thread: { id: "codex-supervisor", status: { type: "idle" }, turns: [] },
      };

      // Answer official thread/read so DelegationWatchService validates notifyThreadId.
      const watchPromise = registry.watch({
        threadId: childId,
        notifyThreadId: "codex-supervisor",
        timeoutMs: 60_000,
      });
      const initialRead = await readJsonLine(fixture.official.stdin);
      expect(initialRead).toMatchObject({
        method: "thread/read",
        params: { threadId: "codex-supervisor", includeTurns: true },
      });
      answerOfficial(initialRead.id, idleThreadResult);
      await expect(watchPromise).resolves.toMatchObject({ state: "watching" });

      // Host pushes THREAD_WATCHING_UPDATED_METHOD and serves THREAD_WATCHING_READ_METHOD.
      await fixture.collector.waitFor(
        (message) =>
          method(message, THREAD_WATCHING_UPDATED_METHOD) &&
          (
            (messageParams(message).threads as Record<string, unknown> | undefined)?.[
              "codex-supervisor"
            ] as { watchCount?: number } | undefined
          )?.watchCount === 1,
      );
      const snapshot = await readWatching(fixture, 40);
      expect(snapshot.threads["codex-supervisor"]).toMatchObject({
        watchCount: 1,
        backgroundWork: false,
      });

      // Official supervisor running a foreground turn hides watching, then restores on completion.
      fixture.official.stdout.write(
        `${JSON.stringify({
          method: "turn/started",
          params: { threadId: "codex-supervisor", turn: { id: "codex-turn-1" } },
        })}\n`,
      );
      await vi.waitFor(async () => {
        expect((await readWatching(fixture)).threads["codex-supervisor"]).toBeUndefined();
      });
      fixture.official.stdout.write(
        `${JSON.stringify({
          method: "turn/completed",
          params: {
            threadId: "codex-supervisor",
            turn: { id: "codex-turn-1", status: "completed" },
          },
        })}\n`,
      );
      await vi.waitFor(async () => {
        expect((await readWatching(fixture)).threads["codex-supervisor"]).toMatchObject({
          watchCount: 1,
          backgroundWork: false,
        });
      });

      // Cancelling the watched child drops the watch immediately and clears the native Codex supervisor.
      const childSession = required(adapter.sessions[0], "Missing child session");
      childSession.completeCancellationOnRequest();
      await expect(registry.cancel({ threadId: childId })).resolves.toMatchObject({
        cancelled: true,
      });

      await vi.waitFor(async () => {
        expect((await readWatching(fixture)).threads["codex-supervisor"]).toBeUndefined();
      });
    } finally {
      registry.close();
      await stopFixture(fixture);
    }
  });
});
