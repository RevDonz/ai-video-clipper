// The Editor V3 page (plan §9.1, §11.2 T2.Z): cross-origin isolated (COOP + COEP, so the player
// may use SharedArrayBuffer and precise timers; every subresource of the editor is same-origin),
// never sniffed and never framed.
export const EDITOR_PAGE_HEADERS = Object.freeze([
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
]);

// Every HTML page is rendered per request in the visitor's language (cookie or Accept-Language,
// rombak 07 §5.4), so no shared cache may keep one: private, no-store, and the inputs named.
// The public files (landing media, licence texts) are the same for everyone and stay out.
export const HTML_CACHE_SOURCE = "/((?!_next/|api/|landing/|licenses/|favicon\\.ico).*)";
export const HTML_CACHE_HEADERS = Object.freeze([
  { key: "Cache-Control", value: "private, no-store" },
  { key: "Vary", value: "Cookie, Accept-Language" },
]);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // next dev would otherwise write AGENTS.md and CLAUDE.md into the project
  // whenever it detects an AI coding agent.
  agentRules: false,
  experimental: {
    serverActions: { bodySizeLimit: "500mb" },
  },
  // The JASSUB worker glue and wasm are served by /api/resources/jassub/* but never imported by
  // server code, so file tracing would leave them out of the standalone build (the image).
  outputFileTracingIncludes: {
    "/api/resources/[kind]/[name]": ["./node_modules/jassub/dist/wasm/jassub-worker.js", "./node_modules/jassub/dist/wasm/jassub-worker.wasm"],
    // The message catalogs, which lib/i18n/catalog.mjs reads from disk.
    "/**": ["./messages/**/*.json"],
  },
  async headers() {
    return [
      { source: HTML_CACHE_SOURCE, headers: [...HTML_CACHE_HEADERS] },
      { source: "/projects/:id/clips/:clipId/edit", headers: [...EDITOR_PAGE_HEADERS] },
    ];
  },
};

export default nextConfig;
