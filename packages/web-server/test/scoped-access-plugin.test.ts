/**
 * End-to-end verification of the `codexhostAccess` Host extension point together with the
 * standalone `plugins/web-scoped-access` Web extension package.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

import WebSocket from "ws";

import { FakeChHost, startFakeChDebugger } from "./support/ch-host.ts";
import { startServer } from "./support/server.ts";
import { seedWebExtension } from "./support/web-extension.ts";

interface RpcEnvelope {
  result: {
    ok: boolean;
    value?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

class MultiModelFakeChHost extends FakeChHost {
  readonly modelsByThread = new Map<string, string>();

  constructor() {
    super();
    this.inspection.catalog = {
      models: [
        { ref: { id: "pro-model" }, label: "Pro Model (Restricted)" },
        { ref: { id: "native" }, label: "Native Model (Allowed)" },
      ],
      defaultModel: { id: "pro-model" },
      thinkingOptions: [],
    };
  }

  override async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (method === "codexhost/thread/inspect") {
      const base = (await super.request(method, params)) as Record<string, unknown>;
      const id = String(params.threadId);
      const modelId = this.modelsByThread.get(id) ?? "pro-model";
      return { ...base, effectiveModel: { id: modelId } } as T;
    }
    if (method === "codexhost/thread/model/select") {
      const id = String(params.threadId);
      const model = params.model as { id?: string } | undefined;
      if (model?.id) this.modelsByThread.set(id, model.id);
      return { effectiveModel: { id: model?.id ?? "native" } } as T;
    }
    if (method === "thread/start") {
      const result = (await super.request<{ thread: { id: string } }>(method, params)) as {
        thread: { id: string };
      };
      // Decode requested model from plugin route JSON envelope when present.
      const rawModel = params.model;
      let modelId = "pro-model";
      if (typeof rawModel === "string") {
        try {
          const parsed = JSON.parse(rawModel) as { model?: { id?: string } };
          if (parsed.model?.id) modelId = parsed.model.id;
        } catch {
          // Non-JSON model string falls back to default.
        }
      }
      this.modelsByThread.set(result.thread.id, modelId);
      return result as T;
    }
    return super.request<T>(method, params);
  }
}

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=",
  "base64",
);

async function openMux(base: URL, token: string): Promise<{
  ws: WebSocket;
  openStream: (endpoint: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const wsUrl = new URL("/api/remote.mux", base);
  wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(wsUrl, {
    headers: { authorization: `Bearer ${token}`, origin: base.origin },
  });
  await once(ws, "open");
  let seq = 0;
  const openStream = (
    endpoint: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> =>
    new Promise((resolveFrame, rejectFrame) => {
      const streamId = `s-${++seq}`;
      const timer = setTimeout(() => rejectFrame(new Error(`Timed out waiting for ${endpoint}`)), 5000);
      const onMessage = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(String(raw)) as {
          streamId?: string;
          type?: string;
          value?: unknown;
          error?: unknown;
        };
        if (msg.streamId !== streamId) return;
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolveFrame(msg as Record<string, unknown>);
      };
      ws.on("message", onMessage);
      ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    });
  return { ws, openStream };
}

it(
  "isolates projects, models, files, streams, and admin surfaces for scoped keys created via the plugin",
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "codexhost-scoped-access-e2e-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const data = join(root, "data");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(projectA, "allowed.txt"), "hello from project A\n");
    writeFileSync(join(projectB, "secret.txt"), "secret from project B\n");
    writeFileSync(join(projectA, "ok.png"), TINY_PNG);
    writeFileSync(join(projectB, "secret.png"), TINY_PNG);

    const pluginSource = resolve(import.meta.dirname, "../../../plugins/web-scoped-access");
    seedWebExtension(data, pluginSource);

    const host = new MultiModelFakeChHost();
    host.add("thread-a-allowed", projectA, "Project A Allowed Thread");
    host.modelsByThread.set("thread-a-allowed", "native");
    host.add("thread-a-pro", projectA, "Project A Pro Thread");
    host.modelsByThread.set("thread-a-pro", "pro-model");
    host.add("thread-b-secret", projectB, "Project B Secret Thread");
    host.modelsByThread.set("thread-b-secret", "native");

    const debug = await startFakeChDebugger(host);
    t.after(() => debug.close());

    const baseUrl = new URL(
      await startServer(
        t,
        resolve(import.meta.dirname, ".."),
        ["--import", "tsx", "src/main.ts"],
        [
          "--session-source",
          "codexhost",
          "--data",
          data,
          "--ch-cdp",
          debug.endpoint,
          "--adapters",
          "test/fake-harness",
        ],
        { authenticated: true },
      ),
    );
    const primaryToken = baseUrl.searchParams.get("token");
    assert.ok(primaryToken);

    const rpc = async (
      token: string,
      method: string,
      args: Record<string, unknown> = {},
    ): Promise<{ status: number; envelope?: RpcEnvelope }> => {
      const response = await fetch(new URL(`/api/${method}`, baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          origin: baseUrl.origin,
        },
        body: JSON.stringify({
          type: "client-request",
          rpcId: `rpc-${method}`,
          method,
          payload: { args },
        }),
      });
      const text = await response.text();
      return {
        status: response.status,
        ...(text.startsWith("{") ? { envelope: JSON.parse(text) as RpcEnvelope } : {}),
      };
    };

    // Prime catalog as primary user so both projects are loaded.
    const primaryList = await rpc(primaryToken, "session/list");
    assert.equal(primaryList.envelope?.result.ok, true);
    assert.equal((primaryList.envelope?.result.value?.items as unknown[]).length, 3);

    // Primary user queries plugin management state and creates a secondary key.
    const stateRes = await fetch(new URL("/codexhost-scoped-access/state", baseUrl), {
      headers: { authorization: `Bearer ${primaryToken}` },
    });
    assert.equal(stateRes.status, 200);
    const initialState = (await stateRes.json()) as {
      projects: Array<{ path: string }>;
      modelGroups: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    assert.ok(initialState.projects.length >= 2);
    assert.ok(
      initialState.modelGroups.some(
        (group) =>
          group.id === "fake" &&
          group.models.some((m) => m.id === "native") &&
          group.models.some((m) => m.id === "pro-model"),
      ),
    );

    const createRes = await fetch(new URL("/codexhost-scoped-access/keys", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${primaryToken}`,
        "content-type": "application/json",
        origin: baseUrl.origin,
      },
      body: JSON.stringify({
        name: "Project A Guest",
        allowedProjectPaths: [projectA],
        allowedModels: [{ provider: "fake", model: "native" }],
        allowWorkspaceFiles: true,
        allowTerminal: false,
      }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { key: { id: string; secret: string } };
    assert.match(created.key.secret, /^chsk_/u);
    const scopedToken = created.key.secret;

    // 1. Auth status & sign-in endpoint accept scoped key with scope: "scoped".
    const statusRes = await fetch(new URL("/api/auth/status", baseUrl), {
      headers: { authorization: `Bearer ${scopedToken}` },
    });
    assert.equal(statusRes.status, 200);
    const authStatus = (await statusRes.json()) as {
      authenticated: boolean;
      scope: string;
      label: string;
      capabilities: { workspaceFiles: boolean; terminal: boolean };
    };
    assert.equal(authStatus.authenticated, true);
    assert.equal(authStatus.scope, "scoped");
    assert.equal(authStatus.label, "Project A Guest");
    assert.deepEqual(authStatus.capabilities, { workspaceFiles: true, terminal: false });

    // 2. Project isolation on session/list, direct sessionId lookup, session/search, session/create.
    const scopedList = await rpc(scopedToken, "session/list");
    assert.equal(scopedList.envelope?.result.ok, true);
    const listedIds = (scopedList.envelope?.result.value?.items as Array<{ sessionId: string }>)
      .map((item) => item.sessionId)
      .sort();
    assert.deepEqual(listedIds, ["thread-a-allowed", "thread-a-pro"]);

    const directB = await rpc(scopedToken, "session/list", {
      request: { sessionId: "thread-b-secret" },
    });
    assert.equal(directB.envelope?.result.ok, false);
    assert.equal(directB.envelope?.result.error?.code, "auth/forbidden");

    const searchB = await rpc(scopedToken, "session/search", { request: { query: "Secret" } });
    assert.equal(searchB.envelope?.result.ok, true);
    assert.deepEqual(searchB.envelope?.result.value?.items, []);

    const createInB = await rpc(scopedToken, "session/create", { request: { cwd: projectB } });
    assert.equal(createInB.envelope?.result.error?.code, "auth/forbidden");

    const createProjectless = await rpc(scopedToken, "session/create", { request: {} });
    assert.equal(createProjectless.envelope?.result.error?.code, "auth/forbidden");

    // 3. Model catalog filtering & enforcement.
    const catalog = await rpc(scopedToken, "session/modelCatalog");
    assert.equal(catalog.envelope?.result.ok, true);
    assert.deepEqual(catalog.envelope?.result.value?.default, {
      provider: "fake",
      model: "native",
    });
    assert.equal(catalog.envelope?.result.value?.preferencesAvailable, false);
    const groups = catalog.envelope?.result.value?.groups as Array<{
      id: string;
      models: Array<{ id: string }>;
    }>;
    assert.deepEqual(
      groups.map((g) => ({ id: g.id, models: g.models.map((m) => m.id) })),
      [{ id: "fake", models: ["native"] }],
    );

    // Existing thread in projectA with disallowed model ("pro-model") rejects prompt until switched.
    const blockedPrompt = await rpc(scopedToken, "session/prompt", {
      request: {
        sessionId: "thread-a-pro",
        content: [{ type: "text", text: "hi" }],
      },
    });
    assert.equal(blockedPrompt.envelope?.result.ok, false);
    assert.equal(blockedPrompt.envelope?.result.error?.code, "auth/model-forbidden");

    const badSelect = await rpc(scopedToken, "session/selectModel", {
      request: { sessionId: "thread-a-pro", provider: "fake", model: "pro-model" },
    });
    assert.equal(badSelect.envelope?.result.error?.code, "auth/model-forbidden");

    const goodSelect = await rpc(scopedToken, "session/selectModel", {
      request: { sessionId: "thread-a-pro", provider: "fake", model: "native" },
    });
    assert.equal(goodSelect.envelope?.result.ok, true);

    const allowedPrompt = await rpc(scopedToken, "session/prompt", {
      request: {
        sessionId: "thread-a-pro",
        content: [{ type: "text", text: "now using allowed model" }],
      },
    });
    assert.equal(allowedPrompt.envelope?.result.ok, true);

    // New draft in projectA automatically chooses allowed model ("native") instead of global default ("pro-model").
    const createInA = await rpc(scopedToken, "session/create", { request: { cwd: projectA } });
    assert.equal(createInA.envelope?.result.ok, true);
    const draftId = String(createInA.envelope?.result.value?.sessionId);
    const draftPrompt = await rpc(scopedToken, "session/prompt", {
      request: { sessionId: draftId, content: [{ type: "text", text: "draft hello" }] },
    });
    assert.equal(draftPrompt.envelope?.result.ok, true);

    // 4. File access allowed inside projectA, strictly blocked outside projectA.
    const readAllowed = await rpc(scopedToken, "workspaceFiles/read", {
      workspaceFileScopeId: "thread-a-allowed",
      path: "allowed.txt",
      range: {},
    });
    assert.equal(readAllowed.envelope?.result.ok, true);
    assert.equal(readAllowed.envelope?.result.value?.text, "hello from project A");

    const readOutsideAbsolute = await rpc(scopedToken, "workspaceFiles/read", {
      workspaceFileScopeId: "thread-a-allowed",
      path: join(projectB, "secret.txt"),
      range: {},
    });
    assert.equal(readOutsideAbsolute.envelope?.result.ok, false);
    assert.equal(readOutsideAbsolute.envelope?.result.error?.code, "auth/forbidden");

    const readOutsideTraversal = await rpc(scopedToken, "workspaceFiles/read", {
      workspaceFileScopeId: "thread-a-allowed",
      path: "../project-b/secret.txt",
      range: {},
    });
    assert.equal(readOutsideTraversal.envelope?.result.error?.code, "auth/forbidden");

    const downloadAllowed = await fetch(
      new URL(
        `/api/workspace-file/download?sessionId=thread-a-allowed&path=allowed.txt`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${scopedToken}` } },
    );
    assert.equal(downloadAllowed.status, 200);
    assert.equal(await downloadAllowed.text(), "hello from project A\n");

    const downloadEscape = await fetch(
      new URL(
        `/api/workspace-file/download?sessionId=thread-a-allowed&path=${encodeURIComponent(join(projectB, "secret.txt"))}`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${scopedToken}` } },
    );
    assert.equal(downloadEscape.status, 403);

    const downloadB = await fetch(
      new URL(
        `/api/workspace-file/download?sessionId=thread-b-secret&path=secret.txt`,
        baseUrl,
      ),
      { headers: { authorization: `Bearer ${scopedToken}` } },
    );
    assert.equal(downloadB.status, 403);

    const imgA = await fetch(
      new URL(`/api/file?path=${encodeURIComponent(join(projectA, "ok.png"))}`, baseUrl),
      { headers: { authorization: `Bearer ${scopedToken}` } },
    );
    assert.equal(imgA.status, 200);

    const imgB = await fetch(
      new URL(`/api/file?path=${encodeURIComponent(join(projectB, "secret.png"))}`, baseUrl),
      { headers: { authorization: `Bearer ${scopedToken}` } },
    );
    assert.equal(imgB.status, 403);

    // 5. Terminal, admin RPCs, plugin routes, /extensions, and /api/ch/v1 are blocked.
    const termCall = await rpc(scopedToken, "terminal/shells", { agentId: "thread-a-allowed" });
    assert.equal(termCall.envelope?.result.error?.code, "auth/forbidden");

    for (const adminMethod of [
      "codexhost/accessTokenGet",
      "codexhost/uiExtensions/list",
      "directoryPicker/list",
      "workspace/create",
      "settings/mutate",
    ]) {
      const denied = await rpc(scopedToken, adminMethod, {});
      assert.equal(
        denied.envelope?.result.error?.code,
        "auth/forbidden",
        `${adminMethod} must be forbidden`,
      );
    }

    assert.equal(
      (
        await fetch(new URL("/codexhost-scoped-access/state", baseUrl), {
          headers: { authorization: `Bearer ${scopedToken}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(new URL("/extensions", baseUrl), {
          headers: { authorization: `Bearer ${scopedToken}` },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(new URL("/api/ch/v1/rpc", baseUrl), {
          method: "POST",
          headers: {
            authorization: `Bearer ${scopedToken}`,
            "content-type": "application/json",
            origin: baseUrl.origin,
          },
          body: JSON.stringify({ method: "thread/list", params: {} }),
        })
      ).status,
      403,
    );

    // 6. WebSocket streams filter workspaces, sessions, and host home.
    const mux = await openMux(baseUrl, scopedToken);
    t.after(() => mux.ws.close());

    const eventsFrame = await mux.openStream("$events");
    assert.equal(eventsFrame.type, "item");
    assert.equal(
      ((eventsFrame.value as { host?: { home?: string } }).host ?? {}).home,
      "",
    );

    const wsBaseline = await mux.openStream("workspace/follow");
    assert.equal(wsBaseline.type, "item");
    const wsValue = (wsBaseline.value as { value: { items: Array<{ path: string }>; canStartProjectless?: boolean } }).value;
    assert.equal(wsValue.canStartProjectless, false);
    assert.ok(wsValue.items.every((item) => item.path.toLowerCase() === projectA.toLowerCase()));

    const followB = await mux.openStream("session/follow", {
      request: { address: { sessionId: "thread-b-secret" } },
    });
    assert.equal(followB.type, "error");
    assert.equal((followB.error as { code?: string }).code, "auth/forbidden");

    // 7. Rotating the scoped key drops the live WebSocket and invalidates the old secret.
    const closed = once(mux.ws, "close");
    const rotateRes = await fetch(
      new URL(`/codexhost-scoped-access/keys/${encodeURIComponent(created.key.id)}/rotate`, baseUrl),
      {
        method: "POST",
        headers: { authorization: `Bearer ${primaryToken}`, origin: baseUrl.origin },
      },
    );
    assert.equal(rotateRes.status, 200);
    const rotated = (await rotateRes.json()) as { key: { secret: string } };
    assert.notEqual(rotated.key.secret, scopedToken);
    await closed;

    assert.equal(
      (
        await fetch(new URL("/api/auth/status", baseUrl), {
          headers: { authorization: `Bearer ${scopedToken}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(new URL("/api/auth/status", baseUrl), {
          headers: { authorization: `Bearer ${rotated.key.secret}` },
        })
      ).status,
      200,
    );

    // 8. Disabling the plugin immediately revokes the rotated key (fail-closed).
    const disableRes = await rpc(primaryToken, "codexhost/uiExtensions/setEnabled", {
      id: "codexhost-plugin-scoped-access",
      enabled: false,
    });
    assert.equal(disableRes.envelope?.result.ok, true);
    assert.equal(
      (
        await fetch(new URL("/api/auth/status", baseUrl), {
          headers: { authorization: `Bearer ${rotated.key.secret}` },
        })
      ).status,
      401,
    );
  },
);
