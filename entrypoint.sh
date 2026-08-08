#!/bin/sh
set -e

# Start the bundled bgutil PO token provider on 127.0.0.1:4416 in the
# background. yt-dlp (via the bgutil-ytdlp-pot-provider plugin) fetches
# fresh PO tokens from it, which defeats YouTube's "Sign in to confirm
# you're not a bot" check on VPS datacenter IPs — with zero manual setup.
# The provider's logs go straight to stdout so any startup error is
# visible in Coolify's app logs.
if [ -f /opt/bgutil/build/main.js ]; then
  echo "[entrypoint] starting bundled PO token provider (bgutil-ytdlp-pot-provider)…"
  node /opt/bgutil/build/main.js &
  PROVIDER_PID=$!
  i=0
  # The provider's /ping route returns 200 JSON when it is alive (it exists
  # in every version, unlike "/" which older builds don't have).
  while [ "$i" -lt 120 ]; do
    if node -e "fetch('http://127.0.0.1:4416/ping').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      echo "[entrypoint] PO token provider ready on 127.0.0.1:4416 (pid $PROVIDER_PID)"
      break
    fi
    if ! kill -0 "$PROVIDER_PID" 2>/dev/null; then
      echo "[entrypoint] ERROR: PO token provider process exited early (pid $PROVIDER_PID) — its error is printed above"
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$i" -ge 120 ]; then
    echo "[entrypoint] WARNING: PO token provider did not become ready after 120s — its logs are printed above"
  fi
else
  echo "[entrypoint] WARNING: /opt/bgutil/build/main.js missing — PO token provider not started"
fi

exec "$@"
