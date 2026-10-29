#!/bin/sh
# Xvfb on :99 with a real 1920x1080x24 screen (Chrome window/screen must match it), then node.
# Xvfb runs as a side child; node is the process dumb-init supervises and signals.
set -e

Xvfb :99 -screen 0 1536x864x24 -nolisten tcp &

# wait for the X socket to appear (cap ~5s) instead of a blind sleep
i=0
while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 50 ]; do
    sleep 0.1
    i=$((i + 1))
done
sleep 0.5
[ -S /tmp/.X11-unix/X99 ] || echo "[entrypoint] warn: /tmp/.X11-unix/X99 never appeared"

if [ "$CAPTURE_MITM" = "1" ]; then
  mkdir -p /app/captures
  /usr/local/bin/capture-proxy \
    --fingerprint /app/capture-fingerprint.json \
    --site https://accounts.x.ai/ \
    --listen 127.0.0.1:8888 \
    --ca-dir /app/proxy-ca \
    --out /app/captures &
  echo $! > /tmp/capture-proxy.pid
  # cho CA kip sinh roi cai vao he thong (Chrome moi tin MITM cert)
  i=0; while [ ! -f /app/proxy-ca/ca-cert.pem ] && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i+1)); done
  if [ -f /app/proxy-ca/ca-cert.pem ]; then
    cp /app/proxy-ca/ca-cert.pem /usr/local/share/ca-certificates/proxy-ca.crt
    update-ca-certificates 2>/dev/null || true
    export PROXY_LAUNCH_ARGS="--proxy-server=http://127.0.0.1:8888"
    echo "[entrypoint] CAPTURE ON: chrome -> 127.0.0.1:8888, out=/app/captures"
  else
    echo "[entrypoint] WARN: proxy CA khong xuat hien — capture OFF"
  fi
fi

exec node server.js
