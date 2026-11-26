// @vitest-environment jsdom
import {
  THREAD_WATCHING_READ_METHOD,
  THREAD_WATCHING_UPDATED_METHOD,
  type ThreadWatchingReadResult,
} from "@codexhost/shared-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSER_WATCHING_ATTRIBUTE,
  COMPOSER_WATCHING_TOOLTIP_ATTRIBUTE,
  mountRendererComposerWatching,
} from "../src/renderer-composer-watching.js";
import {
  disposeComposerAgentControl,
  mountComposerAgentControl,
  renderComposerAgentControl,
} from "../src/renderer-composer-dom.js";
import {
  createRendererModelClient,
  type RendererModelClient,
} from "../src/renderer-model-client.js";
import {
  BrowserSidebarWatchingDom,
  installRendererSidebarWatching,
  SIDEBAR_WATCHING_ATTRIBUTE,
} from "../src/renderer-sidebar-watching.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
} from "../src/renderer-sidebar-agent-icons.js";

function createSidebarRow(threadId: string, hostId = "local", title = "Row title"): HTMLElement {
  const row = document.createElement("div");
  const attributes = {
    [SIDEBAR_THREAD_ROW_ATTRIBUTE]: "",
    [SIDEBAR_THREAD_ID_ATTRIBUTE]: `${hostId}:${threadId}`,
    [SIDEBAR_THREAD_HOST_ID_ATTRIBUTE]: hostId,
  };
  for (const [key, value] of Object.entries(attributes)) {
    row.setAttribute(key, value);
  }
  const flex = document.createElement("div");
  flex.style.display = "flex";
  const trigger = document.createElement("div");
  trigger.setAttribute("data-thread-title-trigger", "");
  const titleEl = document.createElement("span");
  titleEl.setAttribute("data-thread-title", "");
  titleEl.textContent = title;
  trigger.append(titleEl);
  flex.append(trigger);
  row.append(flex);
  Object.defineProperty(row, "__reactFiber$test", {
    value: {
      memoizedProps: {
        conversationId: threadId,
        dataAttributes: attributes,
      },
      return: null,
    },
  });
  return row;
}

function createWatchingClient(initial: ThreadWatchingReadResult): {
  client: RendererModelClient;
  emitUpdate(next: ThreadWatchingReadResult): void;
} {
  const listeners = new Set<(snapshot: ThreadWatchingReadResult) => void>();
  let current = initial;
  const client: RendererModelClient = {
    forkThread: vi.fn(),
    handoffThread: vi.fn(),
    inspectHarness: vi.fn(),
    inspectThread: vi.fn(),
    inspectHarnessCommands: vi.fn(),
    inspectThreadCommands: vi.fn(),
    executeThreadCommand: vi.fn(),
    inspectThreadUsage: vi.fn(),
    listThreadOwnership: vi.fn(),
    selectThreadModel: vi.fn(),
    selectThreadThinking: vi.fn(),
    selectThreadPermissionMode: vi.fn(),
    checkUpdate: vi.fn(),
    startUpdate: vi.fn(),
    readUpdateStatus: vi.fn(),
    listCodexAccounts: vi.fn(),
    refreshCodexAccounts: vi.fn(),
    readThreadWatching: vi.fn(async () => current),
    subscribeThreadWatching: vi.fn((listener: (snapshot: ThreadWatchingReadResult) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  return {
    client,
    emitUpdate(next) {
      current = next;
      for (const listener of listeners) listener(next);
    },
  };
}

function createComposerFixture(): {
  composer: HTMLDivElement;
  sendButton: HTMLButtonElement;
} {
  const composer = document.createElement("div");
  composer.setAttribute("data-codex-composer-root", "true");
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.setAttribute("role", "textbox");
  const toolbar = document.createElement("div");
  const sendButton = document.createElement("button");
  sendButton.type = "submit";
  sendButton.setAttribute("aria-label", "Send");
  toolbar.append(sendButton);
  composer.append(editor, toolbar);
  document.body.append(composer);
  return { composer, sendButton };
}

describe("Renderer watching client, sidebar rows, and composer pill", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("reads watching state, subscribes to updates, and falls back to empty map on -32601", async () => {
    let notify: ((message: unknown) => void) | undefined;
    const sendRequest = vi.fn(async (method: string) => {
      if (method === THREAD_WATCHING_READ_METHOD) {
        return {
          threads: {
            "codex-supervisor": { watchCount: 1, watchTargets: ["Worker"], backgroundWork: false },
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const client = createRendererModelClient([
      {
        sendRequest,
        addNotificationCallback(method, callback) {
          if (method === THREAD_WATCHING_UPDATED_METHOD) notify = callback;
          return () => {
            notify = undefined;
          };
        },
      },
    ]);
    if (!client?.readThreadWatching || !client.subscribeThreadWatching) {
      throw new Error("Expected watching client methods");
    }

    await expect(client.readThreadWatching()).resolves.toEqual({
      threads: {
        "codex-supervisor": { watchCount: 1, watchTargets: ["Worker"], backgroundWork: false },
      },
    });
    const received: ThreadWatchingReadResult[] = [];
    const unsubscribe = client.subscribeThreadWatching((snapshot) => received.push(snapshot));
    notify?.({
      method: THREAD_WATCHING_UPDATED_METHOD,
      params: { threads: { "agy-1": { watchCount: 0, backgroundWork: true } } },
    });
    expect(received).toEqual([{ threads: { "agy-1": { watchCount: 0, backgroundWork: true } } }]);
    unsubscribe();

    const legacyClient = createRendererModelClient([
      {
        sendRequest: vi.fn(async () => {
          throw Object.assign(new Error("Method not found"), { code: -32601 });
        }),
      },
    ]);
    if (!legacyClient?.readThreadWatching) throw new Error("Expected legacy watching method");
    await expect(legacyClient.readThreadWatching()).resolves.toEqual({ threads: {} });
  });

  it("renders sidebar watching pills for both native Codex and external Antigravity rows and clears cleanly", async () => {
    const codexRow = createSidebarRow("codex-supervisor", "local", "Codex Supervisor");
    const agyRow = createSidebarRow("agy-worker", "local", "Antigravity Worker");
    document.body.append(codexRow, agyRow);

    const { client, emitUpdate } = createWatchingClient({
      threads: {
        "codex-supervisor": {
          watchCount: 2,
          watchTargets: ["Antigravity Worker", "Review"],
          backgroundWork: false,
        },
        "agy-worker": {
          watchCount: 0,
          backgroundWork: true,
        },
      },
    });
    let locale: "zh-CN" | "en" = "zh-CN";
    const onWatchingChange = vi.fn();
    const watching = installRendererSidebarWatching({
      dom: new BrowserSidebarWatchingDom(document),
      getClient: () => client,
      getKnownHostIds: () => ["local"],
      getLocale: () => locale,
      onWatchingChange,
    });

    try {
      await vi.waitFor(() => {
        const codexBadge = codexRow.querySelector<HTMLElement>(`[${SIDEBAR_WATCHING_ATTRIBUTE}]`);
        const agyBadge = agyRow.querySelector<HTMLElement>(`[${SIDEBAR_WATCHING_ATTRIBUTE}]`);
        expect(codexBadge?.textContent).toBe("监听中");
        expect(codexBadge?.title).toContain("正在监听 2 个会话");
        expect(codexBadge?.title).toContain("Antigravity Worker");
        expect(agyBadge?.textContent).toBe("监听中");
        expect(agyBadge?.title).toContain("后台任务运行中");
      });
      expect(onWatchingChange).toHaveBeenCalled();

      locale = "en";
      watching.syncLocale();
      await vi.waitFor(() => {
        expect(
          codexRow.querySelector<HTMLElement>(`[${SIDEBAR_WATCHING_ATTRIBUTE}]`)?.textContent,
        ).toBe("Watching");
        expect(
          agyRow.querySelector<HTMLElement>(`[${SIDEBAR_WATCHING_ATTRIBUTE}]`)?.textContent,
        ).toBe("Watching");
      });

      emitUpdate({ threads: {} });
      await vi.waitFor(() => {
        expect(codexRow.querySelector(`[${SIDEBAR_WATCHING_ATTRIBUTE}]`)).toBeNull();
        expect(agyRow.querySelector(`[${SIDEBAR_WATCHING_ATTRIBUTE}]`)).toBeNull();
      });
    } finally {
      watching.dispose();
    }
  });

  it("renders the composer watching pill for both codex and antigravity even without permissionModeVisible", () => {
    if (typeof window.HTMLElement.prototype.animate !== "function") {
      Object.defineProperty(window.HTMLElement.prototype, "animate", {
        configurable: true,
        value: () => ({ cancel() {} }),
      });
    }
    const { composer, sendButton } = createComposerFixture();
    const control = mountComposerAgentControl(
      composer,
      "composer-1",
      sendButton,
      ["codex", "antigravity"],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
    try {
      // Native Codex supervisor thread holding an active watch (permissionModeVisible is false).
      renderComposerAgentControl(
        control,
        { agent: "codex", phase: "locked" },
        "ready",
        false,
        {},
        { status: "idle" },
        { status: "idle" },
        null,
        null,
        "zh-CN",
        null,
        false,
        null,
        { watchCount: 1, watchTargets: ["Worker"], backgroundWork: false },
      );
      const codexPill = composer.querySelector<HTMLElement>(`[${COMPOSER_WATCHING_ATTRIBUTE}]`);
      expect(codexPill).not.toBeNull();
      expect(codexPill?.hidden).toBe(false);
      expect(codexPill?.textContent).toBe("监听中");
      expect(codexPill?.title).toContain("正在监听 1 个会话");

      // Immediate hover tooltip appears on mouseenter and cleans up on mouseleave.
      codexPill?.dispatchEvent(new MouseEvent("mouseenter"));
      expect(
        document.querySelector(`[${COMPOSER_WATCHING_TOOLTIP_ATTRIBUTE}]`)?.textContent,
      ).toContain("Worker");
      codexPill?.dispatchEvent(new MouseEvent("mouseleave"));
      expect(document.querySelector(`[${COMPOSER_WATCHING_TOOLTIP_ATTRIBUTE}]`)).toBeNull();

      // External Antigravity thread running a background task in English locale.
      renderComposerAgentControl(
        control,
        { agent: "antigravity", phase: "locked" },
        "ready",
        false,
        {},
        { status: "idle" },
        { status: "unsupported" },
        null,
        null,
        "en",
        null,
        false,
        null,
        { watchCount: 0, backgroundWork: true },
      );
      const agyPill = composer.querySelector<HTMLElement>(`[${COMPOSER_WATCHING_ATTRIBUTE}]`);
      expect(agyPill?.hidden).toBe(false);
      expect(agyPill?.textContent).toBe("Watching");
      expect(agyPill?.title).toContain("Background task running");

      // Clearing watching hides the pill immediately.
      renderComposerAgentControl(
        control,
        { agent: "antigravity", phase: "locked" },
        "ready",
        false,
        {},
        { status: "idle" },
        { status: "unsupported" },
        null,
        null,
        "en",
        null,
        false,
        null,
        null,
      );
      expect(agyPill?.hidden).toBe(true);
    } finally {
      disposeComposerAgentControl(control);
    }
    expect(composer.querySelector(`[${COMPOSER_WATCHING_ATTRIBUTE}]`)).toBeNull();
  });

  it("cleans up standalone composer watching tooltip on dispose", () => {
    const { composer } = createComposerFixture();
    const watching = mountRendererComposerWatching(composer);
    watching.place(composer, null);
    watching.render({ watchCount: 0, backgroundWork: true }, "zh-CN");
    watching.root.dispatchEvent(new MouseEvent("mouseenter"));
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    watching.dispose();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(composer.querySelector(`[${COMPOSER_WATCHING_ATTRIBUTE}]`)).toBeNull();
  });
});
