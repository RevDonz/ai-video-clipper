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
  },
  async headers() {
    return [{ source: "/projects/:id/clips/:clipId/edit", headers: [...EDITOR_PAGE_HEADERS] }];
  },
};

export default nextConfig;
