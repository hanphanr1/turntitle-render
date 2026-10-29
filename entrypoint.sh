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

exec node server.js
