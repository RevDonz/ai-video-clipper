"use client";

// The words of the descriptors the settings view modules return (`{ key, values? }`, or `{ text }`
// for the server's own words; rombak 07 §8.3). Every key is written out once here, so the catalog
// scan sees it; tests/settings-view-text.test.mjs checks that each module's *_VIEW_KEYS are all here.
import { useCallback } from "react";
import { useFormatter, useTranslations } from "use-intl";

export function useViewText() {
  const t = useTranslations("settings");
  const format = useFormatter();
  return useCallback((descriptor) => {
    if (descriptor === null || descriptor === undefined) return "";
    if (typeof descriptor === "string") return descriptor;
    if (typeof descriptor.text === "string") return descriptor.text;
    const values = descriptor.values ?? {};
    switch (descriptor.key) {
      // Shared
      case "common.error.session": return t("common.error.session");
      case "common.error.offline": return t("common.error.offline");
      case "common.error.csrf": return t("common.error.csrf");
      case "common.error.settingsUnavailable": return t("common.error.settingsUnavailable");
      case "common.error.secretMissing": return t("common.error.secretMissing");
      // AI (lib/llm-settings-view.mjs)
      case "ai.error.name": return t("ai.error.name", values);
      case "ai.error.nameTaken": return t("ai.error.nameTaken");
      case "ai.error.baseUrl": return t("ai.error.baseUrl", values);
      case "ai.error.model": return t("ai.error.model", values);
      case "ai.error.httpReferer": return t("ai.error.httpReferer", values);
      case "ai.error.appTitle": return t("ai.error.appTitle", values);
      case "ai.error.fallback": return t("ai.error.fallback", values);
      case "ai.error.fallbackMax": return t("ai.error.fallbackMax", values);
      case "ai.error.number.contextTokens": return t("ai.error.number.contextTokens", values);
      case "ai.error.number.maxOutputTokens": return t("ai.error.number.maxOutputTokens", values);
      case "ai.error.number.timeout": return t("ai.error.number.timeout", values);
      case "ai.error.number.rpm": return t("ai.error.number.rpm", values);
      case "ai.error.number.maxRetries": return t("ai.error.number.maxRetries", values);
      case "ai.error.number.temperature": return t("ai.error.number.temperature", values);
      case "ai.error.baseUrlRequired": return t("ai.error.baseUrlRequired");
      case "ai.error.modelRequired": return t("ai.error.modelRequired");
      case "ai.error.keyEmpty": return t("ai.error.keyEmpty");
      case "ai.error.key": return t("ai.error.key", values);
      case "ai.status.ready": return t("ai.status.ready");
      case "ai.status.notReady": return t("ai.status.notReady");
      case "ai.status.missingKey": return t("ai.status.missingKey");
      case "ai.status.notFree": return t("ai.status.notFree");
      case "ai.status.invalid": return t("ai.status.invalid");
      case "ai.status.unknown": return t("ai.status.unknown");
      case "ai.status.keyUnreadable": return t("ai.status.keyUnreadable");
      // Transkripsi (lib/transcription-settings-view.mjs)
      case "transcription.notice.corrupt": return t("transcription.notice.corrupt");
      case "transcription.notice.secretMissing": return t("transcription.notice.secretMissing");
      case "transcription.notice.unreadable": return t("transcription.notice.unreadable");
      case "transcription.notice.keyMissing": return t("transcription.notice.keyMissing");
      case "transcription.saved.whisper": return t("transcription.saved.whisper");
      case "transcription.saved.groq": return t("transcription.saved.groq");
      case "transcription.saved.needsKey": return t("transcription.saved.needsKey");
      case "transcription.error.failed": return t("transcription.error.failed");
      // Tampilan (lib/default-logo-view.mjs, lib/default-watermark-view.mjs)
      case "appearance.logoReach.auto": return t("appearance.logoReach.auto");
      case "appearance.logoReach.editor": return t("appearance.logoReach.editor");
      case "appearance.logoPerClip": return t("appearance.logoPerClip");
      case "appearance.logoHint": return t("appearance.logoHint");
      case "appearance.logoSize": return t("appearance.logoSize", values);
      case "appearance.watermarkError.empty": return t("appearance.watermarkError.empty");
      case "appearance.watermarkError.tooLong": return t("appearance.watermarkError.tooLong", values);
      case "appearance.watermarkReach.auto": return t("appearance.watermarkReach.auto");
      case "appearance.watermarkReach.editor": return t("appearance.watermarkReach.editor");
      case "appearance.watermarkPerClip": return t("appearance.watermarkPerClip");
      // YouTube (lib/youtube-cookies-view.mjs)
      case "youtube.count": return t("youtube.count", values);
      case "youtube.uploaded": return t("youtube.uploaded", { at: format.dateTime(values.at, { dateStyle: "medium", timeStyle: "short" }) });
      case "youtube.saved": return t("youtube.saved", values);
      case "youtube.dropped.otherSites": return t("youtube.dropped.otherSites", values);
      case "youtube.dropped.expired": return t("youtube.dropped.expired", values);
      case "youtube.dropped.invalid": return t("youtube.dropped.invalid", values);
      case "youtube.error.json": return t("youtube.error.json");
      case "youtube.error.utf16": return t("youtube.error.utf16");
      case "youtube.error.notText": return t("youtube.error.notText");
      case "youtube.error.notNetscape": return t("youtube.error.notNetscape");
      case "youtube.error.empty": return t("youtube.error.empty");
      case "youtube.error.noYoutube": return t("youtube.error.noYoutube");
      case "youtube.error.expired": return t("youtube.error.expired");
      case "youtube.error.tooLarge": return t("youtube.error.tooLarge");
      case "youtube.error.mediaType": return t("youtube.error.mediaType");
      case "youtube.error.failed": return t("youtube.error.failed");
      // Sistem (lib/system-info-view.mjs)
      case "system.unknown": return t("system.unknown");
      case "system.customModel": return t("system.customModel");
      case "system.hint.ytDlp": return t("system.hint.ytDlp");
      case "system.hint.ffmpeg": return t("system.hint.ffmpeg");
      case "system.hint.libass": return t("system.hint.libass");
      case "system.hint.whisper": return t("system.hint.whisper");
      case "system.hint.commit": return t("system.hint.commit");
      default: return "";
    }
  }, [t, format]);
}
