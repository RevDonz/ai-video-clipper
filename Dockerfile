# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS web-deps
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS web-builder
WORKDIR /web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=web-deps /web/node_modules ./node_modules
COPY web/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runner
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    JOBS_ROOT=/data/jobs \
    WHISPER_MODEL=small \
    WHISPER_DEVICE=cpu \
    WHISPER_LANGUAGE=id \
    MAX_UPLOAD_BYTES=524288000 \
    PATH=/app/.venv/bin:$PATH

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project --python /usr/bin/python3 --extra transcribe --extra vision --extra web
COPY src/ ./src/
RUN uv sync --frozen --no-dev --python /usr/bin/python3 --extra transcribe --extra vision --extra web

COPY --from=web-builder /web/.next/standalone ./
COPY --from=web-builder /web/.next/static ./.next/static
COPY --from=web-builder /web/public ./public
COPY web/scripts ./scripts
RUN mkdir -p /data/jobs && chown -R node:node /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
