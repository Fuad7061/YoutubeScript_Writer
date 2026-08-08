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

# --- PO Token Provider Stage ---
# Official bgutil-ytdlp-pot-provider image (node variant), pinned to an
# immutable SHA tag. Only its files are needed: the app entrypoint starts
# this server inside the container on 127.0.0.1:4416, so yt-dlp gets fresh
# PO tokens with zero manual setup. Canvas is listed in its dependencies but
# is never imported by the server code, so the copy is ABI-agnostic.
FROM brainicism/bgutil-ytdlp-pot-provider:sha-7608dd5-node AS pot

# --- Runtime Stage ---
# Node, not Bun: Bun cannot dlopen the better-sqlite3 native addon on Linux
# (oven-sh/bun#4290), which crashes every request at startup. The addon is a
# standard node-gyp build, so Node loads it fine.
# node:25-bookworm-slim matches the base of the pinned provider image above.
FROM node:25-bookworm-slim AS run
WORKDIR /app

# Install system ffmpeg and python for backend scripts
# curl_cffi gives yt-dlp / youtube-transcript-api browser TLS impersonation,
# which is what keeps YouTube from bot-blocking the VPS datacenter egress IP.
# bgutil-ytdlp-pot-provider is the yt-dlp plugin that fetches PO tokens from
# the provider started by entrypoint.sh on 127.0.0.1:4416 — the standard fix
# for "Sign in to confirm you're not a bot" on flagged datacenter IPs.
# (BGUTIL_POT_URL env overrides the provider address for advanced setups.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-venv python3-pip wget && \
    python3 -m venv /app/fast-whisper-env && \
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

# Bundled PO token provider: copy the official image's /app (server code +
# node_modules) into the runtime. entrypoint.sh starts it before the app.
COPY --from=pot /app /opt/bgutil

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

# entrypoint.sh starts the bundled PO token provider, waits for it to be
# healthy, then execs the app (vite preview).
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh", "node", "node_modules/vite/bin/vite.js", "preview"]
