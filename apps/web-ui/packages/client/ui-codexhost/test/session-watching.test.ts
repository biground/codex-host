import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
  SessionListState,
  SessionSummary,
} from "@deepseek-ai/dsh-api-session-controller/client";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import {
  en as workspaceEn,
  zh as workspaceZh,
  type WorkspaceKey,
} from "../../ui-workspace/src/client/locales.ts";
import { deriveSearchResults, sessionActivity } from "../../ui-workspace/src/client/tree.ts";
import { sessionStatuses } from "../../ui-workspace/src/client/rows/session-status.tsx";
import {
  en as codexhostEn,
  zh as codexhostZh,
  type ImportLocaleKey,
} from "../src/client/locales.ts";
import {
  formatSessionWatchingDetail,
  readSessionWatching,
  SessionWatchingNotice,
} from "../src/client/SessionWatchingNotice.tsx";

function interpolate(
  dict: Record<string, string>,
  key: string,
  params?: Record<string, string | number>,
): string {
  let template = dict[key] ?? key;
  for (const [name, value] of Object.entries(params ?? {})) {
    template = template.replaceAll(`{${name}}`, String(value));
  }
  return template;
}

const zhWorkspaceT = ((key: WorkspaceKey, params?: Record<string, string | number>) =>
  interpolate(workspaceZh, key, params)) as unknown as Parameters<typeof sessionStatuses>[1];
const enWorkspaceT = ((key: WorkspaceKey, params?: Record<string, string | number>) =>
  interpolate(workspaceEn, key, params)) as unknown as Parameters<typeof sessionStatuses>[1];
const zhCodexhostT = ((key: ImportLocaleKey, params?: Record<string, string | number>) =>
  interpolate(codexhostZh, key, params)) as unknown as PropsLocale<"codexhostImport">["t"];
const enCodexhostT = ((key: ImportLocaleKey, params?: Record<string, string | number>) =>
  interpolate(codexhostEn, key, params)) as unknown as PropsLocale<"codexhostImport">["t"];

describe("Web UI watching status and conversation notice", () => {
  it("projects codexhostWatching into sessionActivity and search results, and respects live clearing", () => {
    const id = SessionId("thread-1");
    const summary: SessionSummary = {
      id,
      title: "Supervisor",
      displayTitle: "Supervisor",
      running: false,
      blank: false,
      retainedBy: {},
      updatedAt: 1000,
      projectionValues: {
        codexhostWatching: {
          watchCount: 2,
          watchTargets: ["Worker A", "Worker B"],
          backgroundWork: false,
        },
      },
    };
    const unopenedList: SessionListState = {
      ids: [id],
      byId: { [id]: summary },
      phase: "ready",
      projectionsBySession: {},
    };
    expect(sessionActivity(summary, unopenedList, new Map()).watching).toEqual({
      watchCount: 2,
      watchTargets: ["Worker A", "Worker B"],
      backgroundWork: false,
    });
    const searchRows = deriveSearchResults(
      unopenedList,
      [],
      "Supervisor",
      [],
      "default",
      new Map(),
      { items: [], hasMore: false },
      20,
    );
    expect(searchRows.items[0]?.watching).toEqual({
      watchCount: 2,
      watchTargets: ["Worker A", "Worker B"],
      backgroundWork: false,
    });

    // Live projection clearing to null overrides stale summary projectionValues.
    const clearedList: SessionListState = {
      ...unopenedList,
      projectionsBySession: {
        [id]: {
          asOfSeq: 5,
          values: { codexhostWatching: null },
        } as unknown as SessionListState["projectionsBySession"][typeof id],
      },
    };
    expect(sessionActivity(summary, clearedList, new Map()).watching).toBeUndefined();
  });

  it("orders status priority pendingInteraction > running > watching > subagents > completed > idle", () => {
    const watching = { watchCount: 2, watchTargets: ["Worker A"], backgroundWork: false };
    const idleWatching = sessionStatuses(
      { running: false, watching, runningSubagentCount: 1, completed: true },
      zhWorkspaceT,
    );
    expect(idleWatching[0]).toMatchObject({
      state: "ongoing",
      trailingLabel: "监听中",
      watching: true,
      label: "监听中 · 等待 2 个子会话（Worker A）",
    });
    expect(idleWatching[1]?.label).toBe("1 个子智能体运行中");

    const bgOnlyEn = sessionStatuses(
      {
        running: false,
        watching: { watchCount: 0, backgroundWork: true },
        runningSubagentCount: 0,
        completed: false,
      },
      enWorkspaceT,
    );
    expect(bgOnlyEn[0]).toMatchObject({
      state: "ongoing",
      trailingLabel: "Watching",
      watching: true,
      label: "Watching · waiting on background task",
    });

    const runningWins = sessionStatuses(
      { running: true, watching, runningSubagentCount: 0, completed: false },
      zhWorkspaceT,
    );
    expect(runningWins[0]?.label).toBe("进行中");
    expect(runningWins[0]?.trailingLabel).toBeUndefined();

    const pendingWins = sessionStatuses(
      {
        pendingInteraction: "approval",
        running: false,
        watching,
        runningSubagentCount: 0,
        completed: false,
      },
      zhWorkspaceT,
    );
    expect(pendingWins[0]?.label).toBe("等待审批");
  });

  it("renders SessionWatchingNotice in zh/en when watching and hides while running", () => {
    const id = SessionId("thread-notice");
    const state: SessionListState = {
      ids: [id],
      byId: {
        [id]: {
          id,
          title: "Supervisor",
          displayTitle: "Supervisor",
          running: false,
          blank: false,
          retainedBy: {},
          updatedAt: 1000,
          projectionValues: {
            codexhostWatching: {
              watchCount: 1,
              watchTargets: ["APK Build"],
              backgroundWork: false,
            },
          },
        },
      },
      phase: "ready",
      projectionsBySession: {},
    };
    const observable = {
      subscribe: () => () => {},
      getSnapshot: () => state,
    };
    const idleUseSession = ((selector: (session: { running: boolean }) => unknown) =>
      selector({ running: false })) as PropsRuntime<"conversation.header.notice">["useSession"];
    const runningUseSession = ((selector: (session: { running: boolean }) => unknown) =>
      selector({ running: true })) as PropsRuntime<"conversation.header.notice">["useSession"];

    expect(readSessionWatching(state, id)).toEqual({
      watchCount: 1,
      watchTargets: ["APK Build"],
      backgroundWork: false,
    });
    expect(
      formatSessionWatchingDetail({ watchCount: 0, backgroundWork: true }, enCodexhostT),
    ).toContain("Background command running");

    const zhHtml = renderToStaticMarkup(
      createElement(SessionWatchingNotice, {
        sessionId: id,
        useSession: idleUseSession,
        list: observable,
        t: zhCodexhostT,
      }),
    );
    expect(zhHtml).toContain('data-session-watching-notice="true"');
    expect(zhHtml).toContain("监听中");
    expect(zhHtml).toContain("APK Build");

    const enHtml = renderToStaticMarkup(
      createElement(SessionWatchingNotice, {
        sessionId: id,
        useSession: idleUseSession,
        list: observable,
        t: enCodexhostT,
      }),
    );
    expect(enHtml).toContain("Watching");
    expect(enHtml).toContain("APK Build");

    const hiddenWhileRunning = renderToStaticMarkup(
      createElement(SessionWatchingNotice, {
        sessionId: id,
        useSession: runningUseSession,
        list: observable,
        t: zhCodexhostT,
      }),
    );
    expect(hiddenWhileRunning).toBe("");
  });
});
