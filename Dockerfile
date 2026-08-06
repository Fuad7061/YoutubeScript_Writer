# --- Build Stage ---
FROM oven/bun:1 AS build
WORKDIR /app

# Python + C++ toolchain required by better-sqlite3 (node-gyp) during install
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip build-essential make g++ && \
    rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# --- Runtime Stage ---
# Node, not Bun: Bun cannot dlopen the better-sqlite3 native addon on Linux
# (oven-sh/bun#4290), which crashes every request at startup. The addon is a
# standard node-gyp build, so Node loads it fine.
FROM node:22-slim AS run
WORKDIR /app

# Install system ffmpeg and python for backend scripts
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-venv python3-pip wget && \
    python3 -m venv /app/fast-whisper-env && \
    /app/fast-whisper-env/bin/pip install --no-cache-dir youtube-transcript-api yt-dlp faster-whisper && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=9090
ENV DATA_DIR=/data
ENV PATH="/app/fast-whisper-env/bin:$PATH"

# Create persistent data directory
RUN mkdir -p /data

# Copy built assets and required files
# NOTE: src/ is required at runtime — vite preview re-resolves the TanStack
# router entry (src/router.tsx) and route tree (src/routes) on startup.
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vite.config.ts ./vite.config.ts
COPY --from=build /app/src ./src

# better-sqlite3 was compiled in the build stage against a newer glibc
# (oven/bun images are trixie-based) than this Debian bookworm runtime.
# Rebuild the native addon here so it links against this image's glibc,
# then remove the compilers so they don't bloat the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 make g++ && \
    npm rebuild better-sqlite3 && \
    apt-get purge -y build-essential python3 make g++ && \
    apt-get autoremove --purge -y && \
    rm -rf /var/lib/apt/lists/*

VOLUME ["/data"]

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/api/healthz || exit 1

CMD ["node", "node_modules/vite/bin/vite.js", "preview"]
