import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  THREAD_WATCHING_READ_METHOD,
  THREAD_WATCHING_UPDATED_METHOD,
} from "@codexhost/shared-contracts";
import { FakeChChannel } from "./support/ch-channel.ts";
import { ChSessions } from "../src/ch-sessions.ts";
import { DataDir } from "../src/store.ts";
import { Workspaces } from "../src/workspaces.ts";
import {
  EventHub,
  RpcRegistry,
  StreamRegistry,
  type StreamHandler,
  type StreamSink,
} from "../src/transport.ts";

class Streams extends StreamRegistry {
  endpoints = new Map<string, StreamHandler>();
  override register(name: string, handler: StreamHandler): void {
    super.register(name, handler);
    this.endpoints.set(name, handler);
  }
}

function createSink() {
  const frames: unknown[] = [];
  const cleanup: Array<() => void> = [];
  let closed = false;
  const sink: StreamSink = {
    id: "test",
    get closed() {
      return closed;
    },
    push: (value) => frames.push(value),
    end() {
      closed = true;
      for (const stop of cleanup) stop();
    },
    fail(code, message) {
      throw new Error(`${code}: ${message}`);
    },
    onClose: (fn) => cleanup.push(fn),
  };
  return { frames, sink };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for watching update");
    await delay(10);
  }
}

it("projects codexhostWatching into session/list summaries, catalog deltas, and open control streams", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-watching-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const host = new FakeChChannel();
  host.add("thread-native", root, "Native supervisor");
  host.add("thread-agy", root, "Agy worker");
  host.watching = {
    "thread-native": {
      watchCount: 2,
      watchTargets: ["Agy worker", "Build task"],
      backgroundWork: false,
    },
  };

  const added: Array<{ sessionId: string; projections?: { values?: Record<string, unknown> } }> =
    [];
  const events = new EventHub(root);
  const originalEmit = events.emit.bind(events);
  events.emit = ((name: string, ...args: unknown[]) => {
    if (name === "api-session/added") {
      added.push(
        args[0] as { sessionId: string; projections?: { values?: Record<string, unknown> } },
      );
    }
    return originalEmit(name, ...args);
  }) as typeof events.emit;

  const sessions = new ChSessions(host, new Workspaces(new DataDir(root), root), events);
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new Streams();
  sessions.register(rpc, streams);

  const listedResult = await rpc.dispatch("session/list", { args: {} });
  assert.equal(listedResult.ok, true);
  const listed = listedResult.value as {
    items: Array<{ sessionId: string; projections: { values: Record<string, unknown> } }>;
  };
  const nativeSummary = listed.items.find((item) => item.sessionId === "thread-native");
  const agySummary = listed.items.find((item) => item.sessionId === "thread-agy");
  assert.deepEqual(nativeSummary?.projections.values.codexhostWatching, {
    watchCount: 2,
    watchTargets: ["Agy worker", "Build task"],
    backgroundWork: false,
  });
  assert.equal(agySummary?.projections.values.codexhostWatching, null);

  // Open only thread-native; thread-agy stays unopened so we verify both open projection
  // streams AND unopened sidebar catalog deltas.
  const control = createSink();
  t.after(() => control.sink.end());
  const follow = createSink();
  t.after(() => follow.sink.end());
  await streams.endpoints.get("session/follow")?.(
    { request: { address: { sessionId: "thread-native" } } },
    follow.sink,
  );
  await streams.endpoints.get("session/control")?.({}, control.sink);
  const baseline = control.frames.find(
    (frame) => (frame as { type?: string }).type === "baseline",
  ) as { value?: { projections?: Record<string, { values?: Record<string, unknown> }> } };
  assert.deepEqual(baseline?.value?.projections?.["thread-native"]?.values?.codexhostWatching, {
    watchCount: 2,
    watchTargets: ["Agy worker", "Build task"],
    backgroundWork: false,
  });

  // Host transitions: thread-native finishes watching, unopened thread-agy starts background work.
  added.length = 0;
  host.watching = {
    "thread-agy": { watchCount: 0, backgroundWork: true },
  };
  host.changed("thread-agy", THREAD_WATCHING_UPDATED_METHOD);

  await waitFor(
    () =>
      added.some(
        (row) =>
          row.sessionId === "thread-agy" &&
          (row.projections?.values?.codexhostWatching as { backgroundWork?: boolean } | null)
            ?.backgroundWork === true,
      ) &&
      control.frames.some(
        (frame) =>
          (frame as { type?: string; sessionId?: string; key?: string; value?: unknown }).type ===
            "projection" &&
          (frame as { sessionId?: string }).sessionId === "thread-native" &&
          (frame as { key?: string }).key === "codexhostWatching" &&
          (frame as { value?: unknown }).value === null,
      ),
  );
  assert.ok(
    added.some(
      (row) =>
        row.sessionId === "thread-native" && row.projections?.values?.codexhostWatching === null,
    ),
  );
});

it("falls back silently when an older Host rejects codexhost/thread/watching/read with -32601", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ch-watching-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const host = new FakeChChannel();
  host.add("thread-1", root, "Legacy row");
  host.watchingErrorCode = -32601;

  const sessions = new ChSessions(
    host,
    new Workspaces(new DataDir(root), root),
    new EventHub(root),
  );
  t.after(() => sessions.close());
  const rpc = new RpcRegistry();
  const streams = new Streams();
  sessions.register(rpc, streams);

  const listedResult = await rpc.dispatch("session/list", { args: {} });
  assert.equal(listedResult.ok, true);
  const listed = listedResult.value as {
    items: Array<{ sessionId: string; projections: { values: Record<string, unknown> } }>;
  };
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.projections.values.codexhostWatching, null);

  const callsAfterFirst = host.requests.filter(
    (entry) => entry.method === THREAD_WATCHING_READ_METHOD,
  ).length;
  host.changed("thread-1", THREAD_WATCHING_UPDATED_METHOD);
  await delay(50);
  const callsAfterUpdate = host.requests.filter(
    (entry) => entry.method === THREAD_WATCHING_READ_METHOD,
  ).length;
  assert.equal(callsAfterUpdate, callsAfterFirst);
});
