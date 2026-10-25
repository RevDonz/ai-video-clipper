// The landing's media in public/landing (docs/design/LANDING.md): two screenshots of the real app
// and one Sebelum/Sesudah pair from the same source. They are the only static files the proxy
// serves without a session, and web/tests/landing-media.test.mjs holds them to the budget.

export const LANDING_MEDIA_BUDGET_BYTES = 4_000_000;

export const LANDING_MEDIA = Object.freeze({
  hasil: Object.freeze({ src: "/landing/hasil.webp", width: 1400, height: 860 }),
  editor: Object.freeze({ src: "/landing/editor.webp", width: 1440, height: 900 }),
  sebelum: Object.freeze({ src: "/landing/sebelum.webp", width: 960, height: 540 }),
  sesudah: Object.freeze({ src: "/landing/sesudah.mp4", poster: "/landing/sesudah.webp", width: 432, height: 768 }),
});

export const LANDING_MEDIA_PATHS = Object.freeze(Object.values(LANDING_MEDIA)
  .flatMap((entry) => (entry.poster ? [entry.src, entry.poster] : [entry.src])));

const PUBLIC_PATHS = new Set(LANDING_MEDIA_PATHS);

/** True only for the exact path of a listed file (the proxy's public exception). */
export function isLandingMediaPath(pathname) {
  return typeof pathname === "string" && PUBLIC_PATHS.has(pathname);
}
