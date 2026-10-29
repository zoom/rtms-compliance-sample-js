# Platform-agnostic image for rtms-compliance-sample-js.
#
# IMPORTANT: the base image has two hard constraints, both from the @zoom/rtms
# native addon (N-API 9/10, prebuilt for linux-x64 and darwin-arm64).
#
#   1. glibc, not musl. Alpine cannot load the addon at all.
#   2. libstdc++ providing GLIBCXX_3.4.31 or newer. Debian bookworm ships
#      gcc-12 and stops at GLIBCXX_3.4.30, so the container builds fine and
#      then dies at import with:
#        version `GLIBCXX_3.4.31' not found (required by .../rtms.node)
#      Trixie ships gcc-14 (GLIBCXX_3.4.33) and works.
#   3. linux/amd64 only. There is no linux-arm64 prebuild, and on arm64 the
#      addon's install script warns and exits 0, leaving build/Release empty.
#      The image then dies at import with ERR_MODULE_NOT_FOUND. Both stages
#      are pinned so Apple Silicon hosts build x64 under emulation.
#
# Verify with a real container boot before changing these lines. All three
# failures happen at runtime, not at build time.
#
# Build:  docker build -t rtms-compliance-sample .
# Run:    docker run --env-file .env -p 3000:3000 rtms-compliance-sample

# ─── Stage 1: build the Surface App and install production dependencies ─────
FROM --platform=linux/amd64 node:24-trixie-slim AS builder

WORKDIR /app

# Backend dependencies. Copy manifests first so the layer caches on lockfile
# changes only. Dev dependencies are needed here for the Prisma CLI and the
# Vite build; they are pruned before the runtime stage copies node_modules.
#
# `prisma generate` is an explicit step further down, not a postinstall hook.
# Running it from postinstall races @prisma/client's own install and fails
# nondeterministically on clean CI runners.
COPY package.json package-lock.json ./
RUN npm ci

# Frontend build.
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY web ./web
RUN npm --prefix web run build

# Generate the Prisma client into src/db/generated. It is gitignored, so it
# must be produced here rather than copied from the build context.
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate

# Drop dev dependencies now that the build is done.
RUN npm prune --omit=dev

# ─── Stage 2: runtime ───────────────────────────────────────────────────────
FROM --platform=linux/amd64 node:24-trixie-slim AS runtime

# The slim image has no CA bundle. Node carries its own, but the RTMS native
# addon verifies the media server's TLS against the system bundle, and
# without one the join fails after the SDK warns "No CA certificate found".
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Run as a non-root user.
RUN groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app app

WORKDIR /app

# The native SDK writes its own log files to ./logs relative to the working
# directory. /app is root-owned, so the directory must exist and belong to the
# app user, or every write fails with "failed to open file [/app/logs/...]".
RUN mkdir -p /app/logs && chown app:app /app/logs

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/dist ./web/dist

# src comes from the builder, not the build context: it carries the generated
# Prisma client, which is gitignored and therefore absent from the context.
COPY --from=builder /app/src ./src

COPY package.json ./
COPY rule-packs ./rule-packs
COPY prisma ./prisma

ENV NODE_ENV=production
ENV PORT=3000

# Commercial Zoom by default. Set to https://zoomgov.com for Zoom for
# Government; api and marketplace hosts are derived from this single value.
ENV ZOOM_HOST=https://zoom.us

# Explicit rather than relying on the SDK's search of common locations.
ENV ZM_RTMS_CA=/etc/ssl/certs/ca-certificates.crt

# Structured SDK logs so they land parseable in a log pipeline.
ENV ZM_RTMS_LOG_FORMAT=json
ENV ZM_RTMS_LOG_LEVEL=info

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations before serving. Idempotent, so every start runs it;
# without it a fresh database has no tables and every write fails.
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node src/server.js"]
