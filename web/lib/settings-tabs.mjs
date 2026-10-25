// The tabs of Pengaturan and their hashes (05-ui-dashboard.md §6.10). The hash of a tab is the id
// of the part of the page it replaced, so a link written before the tabs (/settings#youtube) still
// opens the same place. DOM-free.

export const SETTINGS_TABS = Object.freeze(["ai", "transkripsi", "tampilan", "youtube", "sistem"]);

function hashId(hash) {
  let text = String(hash ?? "").replace(/^#/, "");
  try {
    text = decodeURIComponent(text);
  } catch {
    return "";
  }
  return text.trim().toLowerCase();
}

/** The tab a hash opens, among the tabs shown; anything else opens the first of them. */
export function tabFromHash(hash, shown = SETTINGS_TABS) {
  const id = hashId(hash);
  if (shown.includes(id)) return id;
  // The provider cards (#provider-openrouter) were part of the AI section.
  if (id.startsWith("provider-") && shown.includes("ai")) return "ai";
  return shown[0] ?? null;
}

/** "#youtube" for a tab, null for an unknown id. */
export function hashForTab(id) {
  return SETTINGS_TABS.includes(id) ? `#${id}` : null;
}
