# Platform-agnostic image for rtms-compliance-sample-js.
#
# IMPORTANT: this must stay on a glibc base. @zoom/rtms ships a glibc-linked
# native addon (N-API 9/10) with prebuilds for linux-x64 and darwin-arm64.
# Alpine's musl libc cannot load it, and the failure mode is a segfault at
# import rather than a readable error. A test asserts no Alpine base here.
#
# Build:  docker build -t rtms-compliance-sample .
# Run:    docker run --env-file .env -p 3000:3000 rtms-compliance-sample

# ─── Stage 1: build the Surface App and install production dependencies ─────
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Backend dependencies. Copy manifests first so the layer caches on lockfile
# changes only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Frontend build. Dev dependencies are needed here and discarded with the stage.
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

COPY web ./web
RUN npm --prefix web run build

# ─── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

# Run as a non-root user. The image needs no write access outside /tmp.
RUN groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app app

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/web/dist ./web/dist

COPY package.json ./
COPY src ./src
COPY rule-packs ./rule-packs
COPY prisma ./prisma

ENV NODE_ENV=production
ENV PORT=3000

# Commercial Zoom by default. Set to https://zoomgov.com for Zoom for
# Government; api and marketplace hosts are derived from this single value.
ENV ZOOM_HOST=https://zoom.us

# Structured SDK logs so they land parseable in a log pipeline.
ENV ZM_RTMS_LOG_FORMAT=json
ENV ZM_RTMS_LOG_LEVEL=info

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
