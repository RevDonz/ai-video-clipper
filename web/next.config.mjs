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
};

export default nextConfig;
