import type { ThreadWatchingEntry } from "@codexhost/shared-contracts";
import type { RendererSettingsLocale } from "./settings/localization.js";
import { rendererWatchingBadgeText, rendererWatchingTooltip } from "./renderer-watching-format.js";

export const COMPOSER_WATCHING_ATTRIBUTE = "data-codexhost-composer-watching";
export const COMPOSER_WATCHING_TOOLTIP_ATTRIBUTE = "data-codexhost-composer-watching-tooltip";

export interface RendererComposerWatching {
  root: HTMLElement;
  place(parent: HTMLElement | null, before?: Node | null): void;
  render(entry: ThreadWatchingEntry | null, locale: RendererSettingsLocale): void;
  dispose(): void;
}

export function mountRendererComposerWatching(composer: Element): RendererComposerWatching {
  const doc = composer.ownerDocument;
  const root = doc.createElement("span");
  root.setAttribute(COMPOSER_WATCHING_ATTRIBUTE, "true");
  root.setAttribute("role", "status");
  root.hidden = true;
  Object.assign(root.style, {
    display: "none",
    alignItems: "center",
    gap: "5px",
    height: "24px",
    padding: "0 8px",
    borderRadius: "999px",
    border: "1px solid rgba(59, 130, 246, 0.35)",
    background: "rgba(59, 130, 246, 0.12)",
    color: "rgb(59, 130, 246)",
    fontSize: "12px",
    fontWeight: "500",
    lineHeight: "16px",
    whiteSpace: "nowrap",
    flexShrink: "0",
    cursor: "default",
    userSelect: "none",
  });

  const dot = doc.createElement("span");
  dot.setAttribute("aria-hidden", "true");
  Object.assign(dot.style, {
    width: "6px",
    height: "6px",
    borderRadius: "999px",
    background: "currentColor",
    flexShrink: "0",
  });

  const label = doc.createElement("span");
  root.append(dot, label);

  let currentEntry: ThreadWatchingEntry | null = null;
  let currentLocale: RendererSettingsLocale = "en";
  let currentSummary = "";
  let tip: HTMLElement | null = null;

  const hideTip = (): void => {
    tip?.remove();
    tip = null;
  };
  const showTip = (): void => {
    if (!currentSummary || root.hidden) return;
    hideTip();
    const el = doc.createElement("div");
    el.setAttribute("role", "tooltip");
    el.setAttribute(COMPOSER_WATCHING_TOOLTIP_ATTRIBUTE, "true");
    el.textContent = currentSummary;
    Object.assign(el.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      padding: "4px 8px",
      borderRadius: "8px",
      fontSize: "12px",
      maxWidth: "360px",
      background: "rgba(30, 30, 30, 0.92)",
      color: "#fff",
      visibility: "hidden",
    });
    (doc.body ?? doc.documentElement).append(el);
    const rect = root.getBoundingClientRect();
    const width = el.offsetWidth;
    const viewportWidth = doc.defaultView?.innerWidth ?? 1280;
    const left = Math.max(
      4,
      Math.min(rect.left + rect.width / 2 - width / 2, viewportWidth - width - 4),
    );
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(4, rect.top - el.offsetHeight - 6)}px`;
    el.style.visibility = "visible";
    tip = el;
  };

  root.addEventListener("mouseenter", showTip);
  root.addEventListener("mouseleave", hideTip);

  const refresh = (): void => {
    const active =
      currentEntry !== null && (currentEntry.watchCount > 0 || currentEntry.backgroundWork);
    if (!active || !currentEntry) {
      hideTip();
      currentSummary = "";
      root.hidden = true;
      root.style.display = "none";
      root.removeAttribute("title");
      root.removeAttribute("aria-label");
      return;
    }
    const badgeText = rendererWatchingBadgeText(currentLocale);
    const tooltip = rendererWatchingTooltip(currentEntry, currentLocale);
    currentSummary = tooltip;
    if (label.textContent !== badgeText) label.textContent = badgeText;
    if (root.title !== tooltip) root.title = tooltip;
    if (root.getAttribute("aria-label") !== tooltip) root.setAttribute("aria-label", tooltip);
    root.hidden = false;
    root.style.display = "inline-flex";
  };

  return {
    root,
    place(parent, before = null) {
      if (!parent) {
        hideTip();
        root.remove();
        return;
      }
      if (root.parentElement !== parent || root.nextSibling !== before) {
        parent.insertBefore(root, before);
      }
    },
    render(entry, locale) {
      currentEntry = entry;
      currentLocale = locale;
      refresh();
    },
    dispose() {
      root.removeEventListener("mouseenter", showTip);
      root.removeEventListener("mouseleave", hideTip);
      hideTip();
      root.remove();
    },
  };
}
