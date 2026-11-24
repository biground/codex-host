import { useSyncExternalStore } from "react";
import type { SessionListState } from "@deepseek-ai/dsh-api-session-controller/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type { HostObservable, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import css from "./SessionWatchingNotice.module.css";

export interface SessionWatchingNoticeState {
  watchCount: number;
  watchTargets?: readonly string[];
  backgroundWork: boolean;
}

declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionMap {
    codexhostWatching: SessionWatchingNoticeState | null;
  }
}

export function readSessionWatching(
  list: SessionListState,
  sessionId: PropsRuntime<"conversation.header.notice">["sessionId"],
): SessionWatchingNoticeState | null {
  if (sessionId === undefined) return null;
  const live = list.projectionsBySession[sessionId]?.values;
  const value =
    live !== undefined && Object.hasOwn(live, "codexhostWatching")
      ? live.codexhostWatching
      : list.byId[sessionId]?.projectionValues?.codexhostWatching;
  if (value == null) return null;
  return value.watchCount > 0 || value.backgroundWork ? value : null;
}

export function formatSessionWatchingDetail(
  watching: SessionWatchingNoticeState,
  t: PropsLocale<"codexhostImport">["t"],
): string {
  if (watching.watchCount > 0 && watching.backgroundWork) {
    return t("watching.detail.both", { n: watching.watchCount });
  }
  if (watching.watchCount > 0) {
    const targets = watching.watchTargets?.filter((item) => item.trim().length > 0) ?? [];
    if (targets.length > 0) {
      return t("watching.detail.childrenTargets", {
        n: watching.watchCount,
        targets: targets.join(t("watching.listSeparator")),
      });
    }
    return t("watching.detail.children", { n: watching.watchCount });
  }
  return t("watching.detail.background");
}

export function SessionWatchingNotice({
  sessionId,
  useSession,
  list,
  t,
}: PropsRuntime<"conversation.header.notice"> & {
  list: HostObservable<SessionListState>;
} & PropsLocale<"codexhostImport">) {
  const getWatching = () => readSessionWatching(list.getSnapshot(), sessionId);
  const watching = useSyncExternalStore((fn) => list.subscribe(fn), getWatching, getWatching);
  const getListRunning = () =>
    sessionId === undefined ? false : list.getSnapshot().byId[sessionId]?.running === true;
  const listRunning = useSyncExternalStore(
    (fn) => list.subscribe(fn),
    getListRunning,
    getListRunning,
  );
  const sessionRunning = useSession((session) => session.running);
  if (watching === null || sessionRunning || listRunning) return null;
  return (
    <div className={css.notice} role="status" data-session-watching-notice="true">
      <span className={css.badge} data-session-watching-badge="true">
        <span className={css.dot} aria-hidden="true" />
        {t("watching.badge")}
      </span>
      <span className={css.detail}>{formatSessionWatchingDetail(watching, t)}</span>
    </div>
  );
}
