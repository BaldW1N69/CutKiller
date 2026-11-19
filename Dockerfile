# CutKiller in one image: Node (planner, renderer, QA), Python workers (Whisper,
# alignment, faces, beats), FFmpeg. Models are downloaded on first use into
# /models: mount a volume there to keep them between runs.
#
#   docker run --rm -v "$PWD:/work" -v cutkiller-models:/models \
#     ghcr.io/baldw1n69/cutkiller auto interview.mp4 music.mp3 -p short -o out
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim
FROM ${NODE_IMAGE}

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fontconfig ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable

ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    CUTKILLER_MODELS=/models \
    HF_HOME=/models/hf \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

# Dependencies first (cached layer), sources after.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY fixtures/package.json ./fixtures/package.json
RUN pnpm install --frozen-lockfile

COPY workers/pyproject.toml workers/uv.lock ./workers/
RUN cd workers && uv sync --locked --no-dev --no-install-project

COPY . .
RUN cd workers && uv sync --locked --no-dev \
 && printf '#!/bin/sh\nexec /app/node_modules/.bin/tsx /app/packages/cli/src/main.ts "$@"\n' > /usr/local/bin/cutkiller \
 && chmod +x /usr/local/bin/cutkiller \
 && mkdir -p /models /work

VOLUME ["/models"]
WORKDIR /work
ENTRYPOINT ["cutkiller"]
CMD ["--help"]
