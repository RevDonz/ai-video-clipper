# syntax=docker/dockerfile:1.7

# Editor V3 (plan E10): the rendering toolchain is pinned so that a rebuild never changes how a
# clip looks. The base image is pinned by digest, and apt reads a fixed snapshot of the Debian
# archive (snapshot.debian.org never drops a version, unlike the security archive), with the six
# rendering packages pinned to exact versions on top. The runner stage records the result in
# /app/resources/toolchain.json, which is hashed into every render key (plan §5.2 R9).
# Changing any of these values re-runs P-TIME, P-TXT, P-ENC, P-COLOR and P-RT (plan §10).
ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
ARG DEBIAN_SNAPSHOT=20260924T000000Z

FROM ${NODE_IMAGE} AS web-deps
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS web-builder
WORKDIR /web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=web-deps /web/node_modules ./node_modules
COPY web/ ./
RUN npm run build

FROM ${NODE_IMAGE} AS runner
ARG NODE_IMAGE
ARG DEBIAN_SNAPSHOT
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

RUN printf '%s\n' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}" \
      'Suites: bookworm bookworm-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      'Check-Valid-Until: no' \
      '' \
      'Types: deb' \
      "URIs: http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}" \
      'Suites: bookworm-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      'Check-Valid-Until: no' \
      > /etc/apt/sources.list.d/debian.sources \
    && printf 'Acquire::Retries "5";\n' > /etc/apt/apt.conf.d/80-retries \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-venv \
       ffmpeg=7:5.1.9-0+deb12u1 \
       libass9=1:0.17.1-1+deb12u1 \
       libfreetype6=2.12.1+dfsg-5+deb12u4 \
       libharfbuzz0b=6.0.0+dfsg-3 \
       libfribidi0=1.0.8-2.1 \
       fontconfig=2.14.1-4 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /usr/local/bin/

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-dev --no-install-project --python /usr/bin/python3 --extra transcribe --extra vision --extra web
COPY src/ ./src/
RUN uv sync --frozen --no-dev --python /usr/bin/python3 --extra transcribe --extra vision --extra web
# Pinned caption fonts, packs, hook designs and the fontconfig lockdown (plan §5.2 R6, §5.4),
# then the toolchain record of this image (E10).
COPY resources/ ./resources/
RUN /app/.venv/bin/python -m ai_clipper.edit_v2.toolchain write /app/resources/toolchain.json \
      --base-image "${NODE_IMAGE}" --apt-snapshot "${DEBIAN_SNAPSHOT}" \
    && /app/.venv/bin/python -m ai_clipper.edit_v2.toolchain check /app/resources/toolchain.json

COPY --from=web-builder /web/.next/standalone ./
COPY --from=web-builder /web/.next/static ./.next/static
COPY --from=web-builder /web/public ./public
COPY web/scripts ./scripts
COPY web/lib ./lib
RUN mkdir -p /data/jobs /data/settings && chown -R node:node /data && chmod 700 /data/settings

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
