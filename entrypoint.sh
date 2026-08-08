#!/bin/sh
set -e

# Start the bundled bgutil PO token provider when ENABLE_POT != "0".
# It listens on 127.0.0.1:4416; the bgutil-ytdlp-pot-provider plugin (installed in
# the venv) fetches tokens from it, which unlocks real formats on a flagged IP.
# Set ENABLE_POT=0 in Coolify to skip it entirely (e.g. on a clean IP).
if [ "${ENABLE_POT:-1}" != "0" ] && [ -f /opt/bgutil/build/main.js ]; then
  echo "[entrypoint] starting PO token provider (bgutil-ytdlp-pot-provider)…"
  cd /opt/bgutil
  node build/main.js >/tmp/bgutil-provider.log 2>&1 &
  PROVIDER_PID=$!
  i=0
  # The provider's /ping route returns 200 JSON when alive (present in every
  # version, unlike "/" which older builds lack).
  while [ "$i" -lt 120 ]; do
    if node -e "fetch('http://127.0.0.1:4416/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      echo "[entrypoint] PO token provider ready on 127.0.0.1:4416 (pid $PROVIDER_PID)"
      break
    fi
    if ! kill -0 "$PROVIDER_PID" 2>/dev/null; then
      echo "[entrypoint] ERROR: PO token provider exited early — see /tmp/bgutil-provider.log"
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  if [ "$i" -ge 120 ]; then
    echo "[entrypoint] WARNING: PO token provider not ready after 120s — see /tmp/bgutil-provider.log"
  fi
fi

exec "$@"
