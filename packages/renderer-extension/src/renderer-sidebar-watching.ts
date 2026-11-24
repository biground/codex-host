import {
  hostThreadIdSchema,
  type ThreadWatchingEntry,
  type ThreadWatchingReadResult,
} from "@codexhost/shared-contracts";
import type { RendererModelClient } from "./renderer-model-client.js";
import {
  SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ID_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_ATTRIBUTE,
  SIDEBAR_THREAD_ROW_SELECTOR,
  threadIdFromSidebarRowElement,
} from "./renderer-sidebar-agent-icons.js";
import type { RendererSettingsLocale } from "./settings/localization.js";
import { rendererWatchingBadgeText, rendererWatchingTooltip } from "./renderer-watching-format.js";

export const SIDEBAR_WATCHING_ATTRIBUTE = "data-codexhost-sidebar-watching";

export interface SidebarWatchingRow {
  isConnected(): boolean;
  hostId(): string | null;
  threadId(): string | null;
  render(entry: ThreadWatchingEntry | null, locale: RendererSettingsLocale): void;
  clear(): void;
}

export interface SidebarWatchingDom {
  rows(): readonly SidebarWatchingRow[];
  observe(onChange: (rows: readonly SidebarWatchingRow[]) => void): () => void;
  clear(): void;
}

export interface RendererSidebarWatching {
  refresh(): void;
  syncLocale(): void;
  getWatching(hostId: string | null, threadId: string | null): ThreadWatchingEntry | null;
  dispose(): void;
}

function sidebarWatchingInsertionPoint(element: HTMLElement): {
  parent: HTMLElement;
  before: Node | null;
} {
  const titleTrigger = element.querySelector<HTMLElement>("[data-thread-title-trigger]");
  const title = titleTrigger?.querySelector<HTMLElement>("[data-thread-title]");
  const view = element.ownerDocument.defaultView;
  if (titleTrigger?.parentElement) {
    const parentStyle = view?.getComputedStyle?.(titleTrigger.parentElement);
    if (
      !parentStyle ||
      (parentStyle.display.includes("flex") && !parentStyle.flexDirection.startsWith("column"))
    ) {
      return { parent: titleTrigger.parentElement, before: titleTrigger.nextSibling };
    }
  }
  if (title?.parentElement) {
    return { parent: title.parentElement, before: title.nextSibling };
  }
  return { parent: element, before: null };
}

export class BrowserSidebarWatchingRow implements SidebarWatchingRow {
  constructor(readonly element: HTMLElement) {}

  isConnected(): boolean {
    return this.element.isConnected;
  }

  hostId(): string | null {
    return this.element.getAttribute(SIDEBAR_THREAD_HOST_ID_ATTRIBUTE);
  }

  threadId(): string | null {
    return threadIdFromSidebarRowElement(this.element);
  }

  render(entry: ThreadWatchingEntry | null, locale: RendererSettingsLocale): void {
    const active = entry !== null && (entry.watchCount > 0 || entry.backgroundWork);
    if (!active || !entry) {
      this.clear();
      return;
    }
    const text = rendererWatchingBadgeText(locale);
    const tooltip = rendererWatchingTooltip(entry, locale);
    const presentation = JSON.stringify([text, tooltip]);
    const existing = [
      ...this.element.querySelectorAll<HTMLElement>(`[${SIDEBAR_WATCHING_ATTRIBUTE}]`),
    ];
    if (existing.length === 1 && existing[0]?.dataset.presentation === presentation) {
      return;
    }
    this.clear();

    const doc = this.element.ownerDocument;
    const badge = doc.createElement("span");
    badge.setAttribute(SIDEBAR_WATCHING_ATTRIBUTE, "true");
    badge.dataset.presentation = presentation;
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-label", tooltip);
    badge.title = tooltip;
    Object.assign(badge.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "0 5px",
      marginInlineStart: "4px",
      borderRadius: "999px",
      border: "1px solid rgba(59, 130, 246, 0.35)",
      background: "rgba(59, 130, 246, 0.12)",
      color: "rgb(59, 130, 246)",
      fontSize: "10px",
      fontWeight: "600",
      lineHeight: "16px",
      whiteSpace: "nowrap",
      flex: "none",
      pointerEvents: "auto",
    });

    const dot = doc.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    Object.assign(dot.style, {
      width: "5px",
      height: "5px",
      borderRadius: "999px",
      background: "currentColor",
      flex: "none",
    });
    const label = doc.createElement("span");
    label.textContent = text;
    badge.append(dot, label);

    const { parent, before } = sidebarWatchingInsertionPoint(this.element);
    parent.insertBefore(badge, before);
  }

  clear(): void {
    for (const badge of this.element.querySelectorAll(`[${SIDEBAR_WATCHING_ATTRIBUTE}]`)) {
      badge.remove();
    }
  }
}

export class BrowserSidebarWatchingDom implements SidebarWatchingDom {
  readonly #rowsByElement = new WeakMap<HTMLElement, BrowserSidebarWatchingRow>();
  readonly #trackedRows = new Set<BrowserSidebarWatchingRow>();

  constructor(private readonly root: ParentNode & Node) {}

  #row(element: HTMLElement): BrowserSidebarWatchingRow {
    let row = this.#rowsByElement.get(element);
    if (!row) {
      row = new BrowserSidebarWatchingRow(element);
      this.#rowsByElement.set(element, row);
    }
    if (element.isConnected && element.matches(SIDEBAR_THREAD_ROW_SELECTOR)) {
      this.#trackedRows.add(row);
    } else {
      this.#trackedRows.delete(row);
    }
    return row;
  }

  rows(): readonly BrowserSidebarWatchingRow[] {
    for (const row of this.#trackedRows) {
      if (!row.isConnected()) this.#trackedRows.delete(row);
    }
    return [...this.root.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)].map(
      (element) => this.#row(element),
    );
  }

  observe(onChange: (rows: readonly SidebarWatchingRow[]) => void): () => void {
    const observer = new MutationObserver((mutations) => {
      const changed = new Set<SidebarWatchingRow>();
      const collect = (node: Node): void => {
        if (!(node instanceof Element)) return;
        if (node.matches(SIDEBAR_THREAD_ROW_SELECTOR)) {
          changed.add(this.#row(node as HTMLElement));
        }
        for (const element of node.querySelectorAll<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR)) {
          changed.add(this.#row(element));
        }
      };
      for (const mutation of mutations) {
        const target =
          mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        const row = target?.closest<HTMLElement>(SIDEBAR_THREAD_ROW_SELECTOR);
        if (row) changed.add(this.#row(row));
        else if (target && this.#rowsByElement.has(target as HTMLElement)) {
          changed.add(this.#row(target as HTMLElement));
        }
        for (const node of mutation.addedNodes) collect(node);
        for (const node of mutation.removedNodes) collect(node);
      }
      if (changed.size) onChange([...changed]);
    });
    observer.observe(this.root, {
      attributes: true,
      attributeFilter: [
        SIDEBAR_THREAD_ROW_ATTRIBUTE,
        SIDEBAR_THREAD_ID_ATTRIBUTE,
        SIDEBAR_THREAD_HOST_ID_ATTRIBUTE,
      ],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }

  clear(): void {
    for (const row of this.#trackedRows) row.clear();
    this.#trackedRows.clear();
  }
}

export function installRendererSidebarWatching(options: {
  getClient(hostId: string): RendererModelClient | null;
  getKnownHostIds?(): readonly string[];
  getLocale(): RendererSettingsLocale;
  onWatchingChange?(): void;
  dom?: SidebarWatchingDom;
}): RendererSidebarWatching {
  const dom = options.dom ?? new BrowserSidebarWatchingDom(document);
  const watchingByHost = new Map<string, Record<string, ThreadWatchingEntry>>();
  const subscriptions = new Map<string, { client: RendererModelClient; dispose: () => void }>();
  const dirtyRows = new Set<SidebarWatchingRow>();
  let disposed = false;
  let scanScheduled = false;

  const scheduleScan = (rows: Iterable<SidebarWatchingRow>): void => {
    if (disposed) return;
    for (const row of rows) dirtyRows.add(row);
    if (scanScheduled || dirtyRows.size === 0) return;
    scanScheduled = true;
    const run = () => {
      if (!disposed) scan();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else queueMicrotask(run);
  };

  const applySnapshot = (hostId: string, snapshot: ThreadWatchingReadResult): void => {
    if (disposed) return;
    const previous = watchingByHost.get(hostId) ?? {};
    if (JSON.stringify(previous) === JSON.stringify(snapshot.threads)) return;
    watchingByHost.set(hostId, { ...snapshot.threads });
    scheduleScan(dom.rows());
    options.onWatchingChange?.();
  };

  const ensureHostConnected = (hostId: string, forceRead = false): void => {
    if (disposed || !hostId || hostId === "durable") return;
    const client = options.getClient(hostId);
    const existing = subscriptions.get(hostId);
    if (existing?.client === client) {
      if (forceRead && client?.readThreadWatching) {
        void client
          .readThreadWatching()
          .then((snapshot) => {
            if (!disposed && options.getClient(hostId) === client) {
              applySnapshot(hostId, snapshot);
            }
          })
          .catch(() => undefined);
      }
      return;
    }
    existing?.dispose();
    subscriptions.delete(hostId);
    if (!client) return;
    const dispose =
      client.subscribeThreadWatching?.((snapshot) => {
        if (!disposed && options.getClient(hostId) === client) {
          applySnapshot(hostId, snapshot);
        }
      }) ?? (() => {});
    subscriptions.set(hostId, { client, dispose });
    if (client.readThreadWatching) {
      void client
        .readThreadWatching()
        .then((snapshot) => {
          if (!disposed && options.getClient(hostId) === client) {
            applySnapshot(hostId, snapshot);
          }
        })
        .catch(() => undefined);
    }
  };

  const renderRow = (row: SidebarWatchingRow): void => {
    if (!row.isConnected()) {
      row.clear();
      return;
    }
    const hostId = row.hostId();
    if (!hostId) {
      row.clear();
      return;
    }
    ensureHostConnected(hostId);
    const parsed = hostThreadIdSchema.safeParse(row.threadId());
    if (!parsed.success) {
      row.clear();
      return;
    }
    const entry = watchingByHost.get(hostId)?.[parsed.data] ?? null;
    row.render(entry, options.getLocale());
  };

  const scan = (): void => {
    scanScheduled = false;
    if (disposed) return;
    const rows = [...dirtyRows];
    dirtyRows.clear();
    for (const row of rows) renderRow(row);
  };

  const syncHosts = (forceRead = false): void => {
    const hosts = new Set<string>(["local", ...(options.getKnownHostIds?.() ?? [])]);
    for (const row of dom.rows()) {
      const hostId = row.hostId();
      if (hostId) hosts.add(hostId);
    }
    for (const hostId of hosts) ensureHostConnected(hostId, forceRead);
  };

  const stopObserving = dom.observe(scheduleScan);
  syncHosts(true);
  for (const row of dom.rows()) dirtyRows.add(row);
  scan();

  return {
    refresh() {
      if (disposed) return;
      syncHosts(true);
      scheduleScan(dom.rows());
    },
    syncLocale() {
      if (disposed) return;
      scheduleScan(dom.rows());
    },
    getWatching(hostId, threadId) {
      if (!hostId || !threadId) return null;
      ensureHostConnected(hostId);
      const entry = watchingByHost.get(hostId)?.[threadId] ?? null;
      return entry && (entry.watchCount > 0 || entry.backgroundWork) ? entry : null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      for (const { dispose } of subscriptions.values()) dispose();
      subscriptions.clear();
      for (const row of dirtyRows) row.clear();
      dirtyRows.clear();
      dom.clear();
      watchingByHost.clear();
    },
  };
}
