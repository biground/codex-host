import type { ThreadWatchingEntry } from "@codexhost/shared-contracts";
import type { RendererSettingsLocale } from "./settings/localization.js";

export function rendererWatchingBadgeText(locale: RendererSettingsLocale): string {
  return locale === "zh-CN" ? "监听中" : "Watching";
}

export function rendererWatchingTooltip(
  entry: ThreadWatchingEntry,
  locale: RendererSettingsLocale,
): string {
  const targets = entry.watchTargets?.filter((item) => item.trim().length > 0) ?? [];
  if (locale === "zh-CN") {
    if (entry.watchCount > 0 && entry.backgroundWork) {
      return `正在监听 ${entry.watchCount} 个会话并等待后台任务，完成后自动继续`;
    }
    if (entry.watchCount > 0) {
      return targets.length > 0
        ? `正在监听 ${entry.watchCount} 个会话（${targets.join("、")}），完成后自动继续`
        : `正在监听 ${entry.watchCount} 个会话，完成后自动继续`;
    }
    return "后台任务运行中，等待唤醒继续";
  }
  if (entry.watchCount > 0 && entry.backgroundWork) {
    return `Watching ${entry.watchCount} sessions and a background task; resumes automatically`;
  }
  if (entry.watchCount > 0) {
    return targets.length > 0
      ? `Watching ${entry.watchCount} sessions (${targets.join(", ")}); resumes automatically`
      : `Watching ${entry.watchCount} sessions; resumes automatically`;
  }
  return "Background task running; waiting to wake and resume";
}
