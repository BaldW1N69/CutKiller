# CutKiller in one image: Node (planner, renderer, QA), Python workers (Whisper,
# alignment, faces, beats), FFmpeg. Models are downloaded on first use into
# /models: mount a volume there to keep them between runs.
#
#   docker run --rm -v "$PWD:/work" -v cutkiller-models:/models \
#     ghcr.io/baldw1n69/cutkiller auto interview.mp4 music.mp3 -p short -o out
ARG NODE_IMAGE=node:22-bookworm-slim
ARG BASE_IMAGE=ubuntu:24.04
FROM ${NODE_IMAGE} AS node

# Ubuntu 24.04: FFmpeg 6.1 from the distribution (Debian 12 only has 5.1).
FROM ${BASE_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/

RUN ln -s /usr/local/lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg fontconfig ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_LINK_MODE=copy \
    UV_NO_CACHE=1 \
    CUTKILLER_MODELS=/models \
    HF_HOME=/models/hf \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

# Dependencies first (cached layers), sources after. Each install cleans its
# cache in the same layer: the image ships no package store.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY fixtures/package.json ./fixtures/package.json
RUN pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store && rm -rf /tmp/pnpm-store /root/.cache

COPY workers ./workers
RUN cd workers && uv sync --locked --no-dev && rm -rf /root/.cache

COPY . .
RUN printf '#!/bin/sh\nexec /app/node_modules/.bin/tsx /app/packages/cli/src/main.ts "$@"\n' > /usr/local/bin/cutkiller \
 && chmod +x /usr/local/bin/cutkiller \
 && useradd --create-home --uid 10001 cutkiller \
 && mkdir -p /models /work \
 && chmod 1777 /models /work

# Not root: a flaw in a decoder reached through a crafted video gets an
# unprivileged user. Run with -u "$(id -u):$(id -g)" so files written to a
# mounted folder belong to you; /models and /work accept any user.
ENV UV_NO_SYNC=1 \
    HOME=/home/cutkiller
USER cutkiller

VOLUME ["/models"]
WORKDIR /work
ENTRYPOINT ["cutkiller"]
CMD ["--help"]
