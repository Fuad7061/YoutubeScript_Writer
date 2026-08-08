#!/bin/sh
set -e

# Start the bundled bgutil PO token provider on 127.0.0.1:4416 in the
# background. yt-dlp (via the bgutil-ytdlp-pot-provider plugin) fetches
# fresh PO tokens from it, which defeats YouTube's "Sign in to confirm
# you're not a bot" check on VPS datacenter IPs — with zero manual setup.
if [ -f /opt/bgutil/build/main.js ]; then
  echo "[entrypoint] starting bundled PO token provider (bgutil-ytdlp-pot-provider)…"
  node /opt/bgutil/build/main.js >/tmp/bgutil-provider.log 2>&1 &
  i=0
  # The provider's "/" route returns HTTP 400 by design when it is alive,
  # so any response (including 400) means the server is up.
  while [ "$i" -lt 60 ]; do
    if node -e "fetch('http://127.0.0.1:4416/').then(r => process.exit(r.status === 400 ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      echo "[entrypoint] PO token provider ready on 127.0.0.1:4416"
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] WARNING: PO token provider did not become ready — see /tmp/bgutil-provider.log"
  fi
else
  echo "[entrypoint] WARNING: /opt/bgutil/build/main.js missing — PO token provider not started"
fi

exec "$@"
