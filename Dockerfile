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

# --- PO Token Provider Source ---
# Official bgutil-ytdlp-pot-provider image (node variant), pinned to an
# immutable SHA tag. Only the compiled server + its runtime deps are copied
# (not the full build image) to keep the final image small. Canvas is listed in
# its dependencies but is never imported by the server code, so the copy is
# ABI-agnostic. Started at runtime only when ENABLE_POT != "0".
FROM brainicism/bgutil-ytdlp-pot-provider:sha-7608dd5-node AS pot

# --- Runtime Stage ---
# Node, not Bun: Bun cannot dlopen the better-sqlite3 native addon on Linux
# (oven-sh/bun#4290), which crashes every request at startup. The addon is a
# standard node-gyp build, so Node loads it fine.
FROM node:22-slim AS run
WORKDIR /app

# Install system ffmpeg and python for backend scripts
# curl_cffi gives yt-dlp / youtube-transcript-api browser TLS impersonation,
# which is what keeps YouTube from bot-blocking the VPS datacenter egress IP.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-venv python3-pip wget && \
    python3 -m venv /app/fast-whisper-env && \
    # Install with --upgrade: yt-dlp and youtube-transcript-api must be current.
    # YouTube changes its player JS and API endpoints frequently; an old version
    # will silently fail even when impersonation and cookies are working.
    /app/fast-whisper-env/bin/pip install --no-cache-dir --upgrade \
        youtube-transcript-api yt-dlp "curl_cffi>=0.10,<0.16" faster-whisper \
        bgutil-ytdlp-pot-provider && \
    rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=9090
ENV DATA_DIR=/data
ENV PATH="/app/fast-whisper-env/bin:$PATH"
ENV HF_HOME=/data/huggingface

# Create persistent data directory
RUN mkdir -p /data

# Pre-download the default Whisper model ("small") into the image so the
# container never needs to reach huggingface.co at runtime (VPS egress is
# often blocked). The cache lands on the /data volume on first boot.
RUN /app/fast-whisper-env/bin/python3 -c \
    "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8'); print('whisper model cached OK')"

# Copy built assets and required files
# NOTE: src/ is required at runtime — vite preview re-resolves the TanStack
# router entry (src/router.tsx) and route tree (src/routes) on startup.
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/vite.config.ts ./vite.config.ts
COPY --from=build /app/src ./src

# Bundled PO token provider (bgutil-ytdlp-pot-provider): copy only the compiled
# server + its runtime node_modules from the pinned image. Started by entrypoint
# only when ENABLE_POT != "0", so it stays dormant for users on clean IPs.
COPY --from=pot /app/build ./opt/bgutil/build
COPY --from=pot /app/node_modules ./opt/bgutil/node_modules

# better-sqlite3 was compiled in the build stage against a newer glibc
# (oven/bun images are trixie-based) than this Debian bookworm runtime.
# Rebuild the native addon here so it links against this image's glibc,
# then remove the compilers so they don't bloat the final image.
# NOTE: python3 must NOT be purged — the Whisper venv above
# (/app/fast-whisper-env/bin/python3) symlinks to the system interpreter.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential python3 make g++ && \
    npm rebuild better-sqlite3 && \
    apt-get purge -y build-essential make g++ && \
    apt-get autoremove --purge -y && \
    rm -rf /var/lib/apt/lists/*

VOLUME ["/data"]

EXPOSE 9090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/api/healthz || exit 1

# entrypoint.sh starts the PO token provider (when ENABLE_POT != "0") and waits
# for it to be healthy, then execs the app (vite preview).
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh", "node", "node_modules/vite/bin/vite.js", "preview"]
