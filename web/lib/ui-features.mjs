// What the app shows per user and per deployment (05-ui-dashboard.md §4.1), computed on the
// server and handed to the shell (lib/shell-data.mjs). The flags are 03-sosmed-performa.md §3's:
// POTONGIN_SOCIAL = off (default) | admin | on, POTONGIN_PERFORMANCE = off (default) | on.

export const UI_FEATURES = Object.freeze(["social", "performance", "analytics", "admin"]);

// A link is only shown once its page exists: /sosial (Fase 8), /analitik (Fase 9) and
// /admin/pengguna (Fase 6) do not yet, so a flag turned on early cannot link to a 404. Each of
// those phases flips its entry here together with the page.
export const LIVE_PAGES = Object.freeze({ social: false, analytics: false, admin: false });

// The multi-user database arrives in Fase 4 and its admin pages in Fase 6.
const MULTI_USER = false;

/** { social, performance, analytics, admin }: booleans for the shell's links and the pages. */
export function uiFeatures(user, env = process.env, { pages = LIVE_PAGES } = {}) {
  const admin = user?.role === "admin";
  const socialFlag = env?.POTONGIN_SOCIAL === "on" || (env?.POTONGIN_SOCIAL === "admin" && admin);
  const performance = env?.POTONGIN_PERFORMANCE === "on";
  return {
    social: socialFlag && pages.social === true,
    performance,
    // The same gate as /api/analytics/** (03 §9): social or performance.
    analytics: (socialFlag || performance) && pages.analytics === true,
    admin: admin && MULTI_USER && pages.admin === true,
  };
}
