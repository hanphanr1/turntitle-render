# turntitle-cloud-solver — real Chrome headful under Xvfb, node 22, dumb-init as PID 1.
FROM node:22-bookworm-slim AS node-dist

# H1 capture overlay: build capture-proxy (Linux) — chi dung khi CAPTURE=1.
FROM rust:1.98-bookworm AS capture-build
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang libclang-dev git build-essential pkg-config && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/chris124567/cfsolve /src
WORKDIR /src
RUN cargo build --release --bin capture-proxy

FROM debian:bookworm-slim

# System deps + real Chrome from Google's .deb (real Chrome beats bundled Chromium on TLS/JA3)
# + dumb-init (reaps chrome zombies, forwards SIGTERM) + Xvfb + fonts (missing fonts = container tell).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates wget gnupg dumb-init xvfb \
        fonts-liberation fonts-noto-color-emoji \
        libgl1-mesa-dri libglx-mesa0 libegl1 libgles2 libgbm1 libvulkan1 libxshmfence1 \
    debconf-utils \
    && echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
    && (sed -i 's/^Components: main$/Components: main contrib/' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true) \
    && (apt-get update && apt-get install -y --no-install-recommends ttf-mscorefonts-installer || echo "[fonts] mscorefonts skip") \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list \
    && rm -rf /var/lib/apt/lists/*

# 2026-10-19: CF flag software renderer -> thay token 'SwiftShader' (11 byte) bang 'IntelDriver'
RUN cd /opt/google/chrome && \
    FILES=$(grep -arl 'SwiftShader' . 2>/dev/null) && \
    echo "[patch] files: $FILES" && \
    [ -n "$FILES" ] && echo "$FILES" | xargs -r perl -0777 -pi -e 's/SwiftShader/IntelDriver/g' || true

# Node 22 lifted straight from the official image (no nodesource dance).
COPY --from=node-dist /usr/local/bin/node /usr/local/bin/node
COPY --from=node-dist /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ENV DISPLAY=:99 \
    NODE_ENV=production

WORKDIR /app

COPY package*.json ./
# Lockfile is committed — ci fails loudly on drift instead of silently floating versions.
RUN npm ci --omit=dev
# patchright's own chromium build — the driver is built for it; system Chrome is the fallback.
RUN npx patchright install chromium --no-shell

COPY server.js solver.js castle.browser.js entrypoint.sh ./
COPY ext ./ext
# built-in proxy pool (solver hot-reloads it; delete the file + this line to ship without)
COPY proxies.txt ./
RUN chmod +x entrypoint.sh

EXPOSE 407

# dumb-init supervises entrypoint.sh, which execs node — so SIGTERM reaches node for graceful drain.
# (never xvfb-run as PID 1: it eats SIGTERM and blocks the drain.)
COPY --from=capture-build /src/target/release/capture-proxy /usr/local/bin/capture-proxy
COPY capture-fingerprint.json /app/capture-fingerprint.json

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "entrypoint.sh"]
