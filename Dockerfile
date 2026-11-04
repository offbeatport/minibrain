ARG VARIANT=cuda
ARG PYTHON_VERSION=3.12.15
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
ARG PYTHON_IMAGE=python:3.12.15-slim-trixie@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
ARG CUDA_IMAGE=nvidia/cuda:13.2.1-base-ubuntu24.04@sha256:7be56e69d8ae7c3648b8fca009fa35980ecd9c6eefaafbff3ee8c224e0043eb5

FROM ${UV_IMAGE} AS uv

FROM ${NODE_IMAGE} AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN corepack enable && corepack install
RUN --mount=type=cache,id=minibrain-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY web/ ./
RUN pnpm build

FROM ${PYTHON_IMAGE} AS python
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy

FROM python AS lock
WORKDIR /src
COPY pyproject.toml uv.lock ./
RUN mkdir /lock \
    && export_lock() { uv export --frozen --no-dev --no-emit-project --extra postgres --no-header --no-annotate "$@"; } \
    && export_lock --no-hashes -o /lock/all.txt \
    && export_lock --no-hashes --prune torch -o /lock/without-torch.txt \
    && grep -vxFf /lock/without-torch.txt /lock/all.txt > /lock/torch.txt \
    && export_lock --prune torch -o /lock/requirements.txt \
    && uv export --frozen --only-group dev --no-emit-project --no-header --no-annotate --no-hashes -o /lock/build.txt \
    && rm /lock/all.txt /lock/without-torch.txt

FROM python AS wheel-build
WORKDIR /src
COPY --from=lock /lock/build.txt /lock/build.txt
COPY LICENSE hatch_build.py pyproject.toml ./
COPY samples/ samples/
COPY minibrain/ minibrain/
COPY --from=web /src/web/dist/ web/dist/
ARG COMMIT=""
RUN --mount=type=cache,id=minibrain-uv,target=/root/.cache/uv \
    MINIBRAIN_BUILD_COMMIT="${COMMIT}" uv build --wheel --out-dir /dist --build-constraint /lock/build.txt

FROM scratch AS wheel
COPY --from=wheel-build /dist/ /

FROM python AS extensions
ENV VIRTUAL_ENV=/opt/venv PATH=/opt/venv/bin:${PATH}
RUN --mount=type=cache,id=minibrain-uv,target=/root/.cache/uv \
    --mount=type=bind,from=lock,source=/lock/requirements.txt,target=/lock/requirements.txt \
    uv venv /opt/venv && uv pip install --require-hashes --no-deps --requirement /lock/requirements.txt
RUN --mount=type=bind,from=wheel,target=/dist uv pip install --no-deps /dist/minibrain-*.whl
ARG INCLUDE_MYSQL=false
RUN set -- httpfs postgres_scanner iceberg avro delta \
    && if [ "${INCLUDE_MYSQL}" = "true" ]; then set -- "$@" mysql_scanner; fi \
    && MINIBRAIN_HOME=/tmp/minibrain minibrain extensions download --to /extensions "$@"

FROM ${CUDA_IMAGE} AS base-cuda
ARG PYTHON_VERSION
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_PYTHON_PREFERENCE=only-managed UV_LINK_MODE=copy
RUN uv python install "${PYTHON_VERSION}" && uv venv --python "${PYTHON_VERSION}" /opt/minibrain
ARG TORCH_BACKEND=cu132
ENV UV_TORCH_BACKEND=${TORCH_BACKEND}

FROM python AS base-cpu
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
RUN uv venv --python /usr/local/bin/python3 /opt/minibrain
ARG TORCH_BACKEND=cpu
ENV UV_TORCH_BACKEND=${TORCH_BACKEND}

FROM base-${VARIANT} AS runtime
ENV VIRTUAL_ENV=/opt/minibrain PATH=/opt/minibrain/bin:${PATH} UV_COMPILE_BYTECODE=1
RUN if id ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
    && useradd --uid 1000 --user-group --create-home --shell /usr/sbin/nologin minibrain \
    && install -d -o minibrain -g minibrain /data
RUN --mount=type=cache,id=minibrain-uv,target=/root/.cache/uv \
    --mount=type=bind,from=lock,source=/lock/torch.txt,target=/lock/torch.txt \
    uv pip install --constraint /lock/torch.txt torch
RUN --mount=type=cache,id=minibrain-uv,target=/root/.cache/uv \
    --mount=type=bind,from=lock,source=/lock/requirements.txt,target=/lock/requirements.txt \
    uv pip install --require-hashes --no-deps --requirement /lock/requirements.txt
COPY --from=extensions /extensions /opt/duckdb-extensions
RUN --mount=type=bind,from=wheel,target=/dist \
    uv pip install --no-deps /dist/minibrain-*.whl
ENV MINIBRAIN_HOME=/data \
    MINIBRAIN_OFFLINE=1 \
    MINIBRAIN_DUCKDB_EXTENSION_REPOSITORY=/opt/duckdb-extensions \
    HF_HOME=/data/huggingface \
    HF_HUB_OFFLINE=1 \
    HF_DATASETS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    PYTHONUNBUFFERED=1
USER minibrain
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import urllib.request as r; r.build_opener(r.ProxyHandler({})).open('http://127.0.0.1:8000/healthz', timeout=4)"]
ENTRYPOINT ["tini", "--", "minibrain"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8000"]
ARG COMMIT=""
LABEL org.opencontainers.image.title="minibrain" \
      org.opencontainers.image.description="Private platform for small, task-specific models" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/offbeatport/minibrain" \
      org.opencontainers.image.revision="${COMMIT}"
