# Install

minibrain is one Python package for Python 3.12 or 3.13, with the web UI built in. Running it needs no Node. The
commands below use 3.12, which the Docker image runs.

| Way | For |
|---|---|
| [Run with Docker](#run-with-docker) | Trying it on any machine with Docker, and production on Linux with NVIDIA GPUs |
| [Install from GitHub Releases](#install-from-github-releases) | The released wheel with uv, pipx or pip |
| [`uvx`](#uvx) | Trying it without installing anything |
| [`uv tool install`](#uv-tool-install) | A `minibrain` command that stays installed |
| [`pip` in a virtual environment](#pip-in-a-virtual-environment) | Machines without uv |

Releases are on [GitHub Releases](https://github.com/offbeatport/minibrain/releases) (wheel, sdist, SBOMs,
`SHA256SUMS`) and in GHCR (`ghcr.io/offbeatport/minibrain`); how they are made: [`releasing.md`](releasing.md).
minibrain is not on PyPI yet, so wherever a command below installs `minibrain`, pass the release wheel's URL instead
(see [Install from GitHub Releases](#install-from-github-releases)). Before the first release, build the wheel from
this repo with `mise run build` (or `uv build --wheel`; both need Node with pnpm) and pass the file:

```sh
uvx --python 3.12 --from dist/minibrain-0.0.0-py3-none-any.whl minibrain serve
uv tool install --python 3.12 dist/minibrain-0.0.0-py3-none-any.whl
pip install dist/minibrain-0.0.0-py3-none-any.whl
```

Verified: `uvx` and `minibrain serve` on macOS (Apple silicon) and on Linux (Debian, CPU torch); the CPU image; the
CUDA image built for amd64 and arm64 and started without a GPU; the release workflow's dry run (wheel, sdist and all
four images built). Not verified yet: native Windows, the CUDA image on a machine with an NVIDIA GPU, and a tagged
release (no image is on GHCR until the first one).

## Run with Docker

```sh
docker run --name minibrain -p 127.0.0.1:8000:8000 -v minibrain-data:/data ghcr.io/offbeatport/minibrain
```

On its first start it prints a one-time setup link, `http://127.0.0.1:8000/setup?token=…`: open it to create the admin
account. Run in the background (`-d`), read it with `docker logs minibrain | grep setup`; lost, print a new one with
`docker exec minibrain minibrain admin setup-link`. That is the CPU image: it runs wherever Docker does, Docker Desktop
on macOS (Apple silicon and Intel) and Windows included. Training on CPU suits models up to about 0.5B. Everything
minibrain writes stays in the `minibrain-data` volume. Every way to create the first admin, automated deploys
included: [First admin](#first-admin).

Images for linux/amd64 and linux/arm64, built from the release wheel:

| Tag | Image |
|---|---|
| `latest`, `<version>` (`0.1.0`) | CPU: Python 3.12 slim (Debian 13) with CPU torch, about 1.7 GB |
| `cuda`, `<version>-cuda` (`0.1.0-cuda`) | NVIDIA CUDA 13.2 (Ubuntu 24.04), about 7 GB. Linux hosts with NVIDIA GPUs |

`latest` and `cuda` move with each stable release; pre-releases (`0.2.0rc1`) get only their version tags. Pin a
version in production, or its digest (`docker inspect --format '{{index .RepoDigests 0}}' <image>` after a pull). The
images are not signed yet. For NVIDIA GPUs, the full `docker run` is under [Docker → Run](#run) and the compose file
under [Compose](#compose).

## Install from GitHub Releases

Each release carries the wheel, with the web UI inside, and an sdist. Take the URL from the
[release page](https://github.com/offbeatport/minibrain/releases); it has this form:

```sh
WHEEL=https://github.com/offbeatport/minibrain/releases/download/v0.1.0/minibrain-0.1.0-py3-none-any.whl
uv tool install --python 3.12 "$WHEEL"
pipx install --python python3.12 "$WHEEL"
pip install "$WHEEL"
uvx --python 3.12 --from "$WHEEL" minibrain serve
```

Use one of them, `pip` inside a virtual environment (below). With extras, name the package before the URL:
`"minibrain[postgres] @ $WHEEL"` (uv and pip). To check the download first:

```sh
curl -fsSLO "$WHEEL"
curl -fsSLO https://github.com/offbeatport/minibrain/releases/download/v0.1.0/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

Then install the local file the same way.

## uvx

```sh
uvx --python 3.12 minibrain serve
```

On the first start it prints a one-time setup link and opens it in the browser: create the admin account there
([First admin](#first-admin)). Later, open http://127.0.0.1:8000 and sign in. uvx keeps the environment in its cache,
so later starts are fast. With an extra:

```sh
uvx --python 3.12 --from 'minibrain[postgres]' minibrain serve
```

## uv tool install

```sh
uv tool install --python 3.12 minibrain
minibrain serve
```

With extras: `uv tool install --python 3.12 'minibrain[postgres,llamacpp]'`.

## pip in a virtual environment

Linux and macOS:

```sh
python3.12 -m venv ~/.venvs/minibrain
. ~/.venvs/minibrain/bin/activate
pip install minibrain
minibrain serve
```

Windows, in PowerShell:

```powershell
py -3.12 -m venv $HOME\.venvs\minibrain
& $HOME\.venvs\minibrain\Scripts\Activate.ps1
pip install minibrain
minibrain serve
```

## Extras

| Extra | Adds |
|---|---|
| `postgres` | psycopg, for `MINIBRAIN_DATABASE_URL=postgresql+psycopg://user:password@host/db` |
| `mlx` | The MLX engine (`mlx-lm`), Apple silicon only |
| `llamacpp` | The llama.cpp engine, for GGUF models |

## PyTorch backends

A plain install takes torch from PyPI:

| Platform | torch from PyPI |
|---|---|
| Linux, x86_64 and aarch64 | CUDA 13.2 build, about 3 GB to download. Runs on CPU when there is no GPU |
| macOS, Apple silicon | Metal (MPS) build |
| Windows | CPU only |

To pick another build, set `UV_TORCH_BACKEND` (or pass `--torch-backend`). It works with `uvx`, `uv tool install`
and `uv pip install`:

| Hardware | `UV_TORCH_BACKEND` |
|---|---|
| NVIDIA, picked from the installed driver | `auto` |
| NVIDIA, CUDA 13.2 | `cu132` |
| AMD, ROCm | `rocm7.2` |
| Intel GPU | `xpu` |
| No GPU (small download) | `cpu` |
| Apple silicon | Leave it unset |

```sh
UV_TORCH_BACKEND=auto uv tool install --python 3.12 minibrain
uvx --python 3.12 --torch-backend cpu minibrain serve
```

uv marks `--torch-backend` as experimental. `auto` reads the installed GPU driver. A machine without the GPU, such as a
build host, sets `UV_CUDA_DRIVER_VERSION` (NVIDIA) or `UV_AMD_GPU_ARCHITECTURE` (AMD) so `auto` knows what to pick;
otherwise it falls back to CPU wheels. Each backend has its own set of torch versions, so ROCm may get an older torch
than CUDA.

With pip, install torch from the PyTorch index first, then minibrain:

```sh
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install minibrain
```

Training runs on CUDA when there is a GPU, otherwise on CPU, including on Apple silicon, where the Metal GPU hangs
during LoRA training (see [`findings.md`](findings.md)). `MINIBRAIN_TRAIN_DEVICE` overrides the choice.

SGLang is not part of any install above. On Linux with NVIDIA or AMD GPUs, put it in its own environment, because it
pins its own torch, and point minibrain at that environment's Python with `MINIBRAIN_SGLANG_PYTHON`. Without it,
engines use `transformers`.

## Docker

The CUDA image is for production on Linux. Docker on macOS has no GPU access: use the CPU image there
([Run with Docker](#run-with-docker)), or a native install, which gets the Metal build of torch.

### Build

The release images are on GHCR; build your own to change a build argument or to build from a checkout:

```sh
docker build -t minibrain:cuda --build-arg COMMIT=$(git rev-parse HEAD) .
docker build -t minibrain:cpu --build-arg VARIANT=cpu .
```

| Build argument | Default | Meaning |
|---|---|---|
| `VARIANT` | `cuda` | `cuda`: NVIDIA CUDA 13.2 base (Ubuntu 24.04) with Python 3.12 from uv. `cpu`: Python 3.12 slim (Debian 13) with CPU torch, for machines without GPUs |
| `TORCH_BACKEND` | `cu132` or `cpu` | The PyTorch build to install, as in `UV_TORCH_BACKEND` |
| `INCLUDE_MYSQL` | `false` | `true` adds DuckDB's `mysql_scanner` extension (see below) |
| `COMMIT` | empty | The git commit shown in Settings → This install |

The build needs network access (PyPI, the PyTorch index, the npm registry, GitHub, extensions.duckdb.org). The image
needs none. Base images and tools are pinned by version and digest at the top of the `Dockerfile`; Python packages
come from `uv.lock` with hashes. The CUDA image is about 7 GB, most of it torch and its CUDA libraries; the CPU
image is about 1.7 GB.

The build runs the UI build and `uv build` in builder stages, installs the wheel into `/opt/minibrain`, and downloads
the DuckDB extensions for the image's platform. Build on the architecture you deploy, or use
`docker buildx build --platform linux/amd64`.

To install a wheel you already have instead of building one, pass a folder that holds only that wheel as the `wheel`
build context; the UI and wheel stages are then skipped. The release workflow builds its images this way, from the
wheel it publishes:

```sh
docker buildx build --build-context wheel=./release-wheel --build-arg VARIANT=cpu -t minibrain:cpu .
```

A CycloneDX SBOM of the built image comes from syft: [Security → Docker image](security.md#docker-image).

### Run

The host needs an NVIDIA driver that supports CUDA 13.2 (`nvidia-smi` shows CUDA Version 13.2 or higher) and the
NVIDIA Container Toolkit.

```sh
docker run -d --name minibrain --restart unless-stopped --stop-timeout 30 \
  --gpus all --shm-size 8g \
  -p 127.0.0.1:8000:8000 \
  -v minibrain-data:/data \
  -v /srv/models:/models:ro \
  ghcr.io/offbeatport/minibrain:cuda
```

The setup link for the first admin is in the container log: `docker logs minibrain | grep setup`
([First admin](#first-admin)).

- The container runs as user `minibrain` (uid 1000), not root.
- `/data` is `MINIBRAIN_HOME` and a volume. A bind mount must be writable by uid 1000:
  `sudo chown -R 1000:1000 /srv/minibrain-data`.
- PID 1 is `tini`. The entrypoint is `minibrain` and the default command is `serve --host 0.0.0.0 --port 8000`, so
  `docker run --rm ghcr.io/offbeatport/minibrain:cuda extensions` runs another command and `docker exec minibrain minibrain extensions`
  runs one in a running container.
- `--shm-size` gives PyTorch shared memory for data loading; Docker's default of 64 MB is too small.
- `--stop-timeout 30` gives main time to finish open requests on `docker stop`; it can take about 25 seconds, and
  Docker's default kills it after 10.
- Mount model weights read-only and add them with **Models → Add model → Folder**, giving the path inside the
  container, such as `/models/Qwen3-0.6B`.

### Health check

The image checks `GET /healthz` every 30 seconds. Read the result with:

```sh
docker inspect --format '{{.State.Health.Status}}' minibrain
curl -s http://127.0.0.1:8000/healthz
```

### Environment

Set in the image:

| Variable | Value | Effect |
|---|---|---|
| `MINIBRAIN_HOME` | `/data` | Everything minibrain writes |
| `MINIBRAIN_OFFLINE` | `1` | No outbound calls; the network policy is locked to Offline |
| `HF_HUB_OFFLINE`, `HF_DATASETS_OFFLINE` | `1` | Hugging Face libraries read local files only |
| `HF_HUB_DISABLE_TELEMETRY` | `1` | No Hugging Face telemetry |
| `HF_HOME` | `/data/huggingface` | The Hugging Face cache lives on the volume |
| `MINIBRAIN_DUCKDB_EXTENSION_REPOSITORY` | `/opt/duckdb-extensions` | DuckDB extensions bundled in the image |

Often added with `-e`:

| Variable | For |
|---|---|
| `MINIBRAIN_DATABASE_URL` | Metadata in Postgres (the image includes the `postgres` extra) |
| `MINIBRAIN_MODELS_S3_URL`, `AWS_*` | Models from an S3-compatible bucket |
| `MINIBRAIN_HF_ENDPOINT` | An internal Hugging Face mirror. Also set `MINIBRAIN_OFFLINE=0` and `HF_HUB_OFFLINE=0`, and allow the host in Settings → Security |
| `MINIBRAIN_TRAIN_DEVICE` | Force `cuda` or `cpu` for training |
| `MINIBRAIN_ADMIN_EMAIL`, `MINIBRAIN_ADMIN_PASSWORD_FILE` | Create the first admin on the first start, with the password in a mounted secret file ([First admin](#first-admin)) |

### DuckDB extensions

The image carries httpfs, postgres_scanner, iceberg and avro for its DuckDB version and platform, so S3, Postgres and
Iceberg sources work offline. minibrain installs each one into `/data/duckdb/extensions` the first time a source
needs it. To install them all now:

```sh
docker exec minibrain minibrain extensions install
docker exec minibrain minibrain extensions
```

`mysql_scanner` is left out by default. It links the MySQL client library, which is GPLv2 with the Universal FOSS
Exception, and its licence review is not done. Build with `--build-arg INCLUDE_MYSQL=true` to add it if your own
review allows it.

### Compose

[`compose.yaml`](../compose.yaml) runs one service on an NVIDIA host from `ghcr.io/offbeatport/minibrain:cuda`: all
GPUs reserved, the port on `127.0.0.1`, data in the `minibrain-data` volume and `./models` mounted read-only at
`/models`.

```sh
docker compose up -d
docker compose logs minibrain | grep setup
```

Put overrides in a `.env` file next to it: `MINIBRAIN_DATABASE_URL`, `MINIBRAIN_MODELS_DIR` (the host folder for
`/models`), `MINIBRAIN_IMAGE` (the image, such as `ghcr.io/offbeatport/minibrain:0.1.0-cuda` to pin a release).

The file keeps its `build:` section for local builds. `docker compose up -d --build` builds the image from the checkout
and tags it as `MINIBRAIN_IMAGE`, so set `MINIBRAIN_IMAGE=minibrain:cuda` with it, to keep a local build apart from the
release image.

### SGLang in Docker

The image serves with the `transformers` engine. To use SGLang, build an image `FROM` this one that installs SGLang into
its own virtual environment and sets `MINIBRAIN_SGLANG_PYTHON` to that environment's Python. Not verified yet.

## First admin

Everyone signs in, on loopback too. On the first start with no accounts, `minibrain serve` prints a one-time setup link
to its log; it opens it in the browser too when it runs in a desktop terminal (`--no-browser` stops that):

```text
  minibrain has no admin account yet. Create it with this one-time setup link:

    http://127.0.0.1:8000/setup?token=…
```

| Install | Find the link | A new link, voiding the old one |
|---|---|---|
| Native | The terminal that runs `minibrain serve` | `minibrain admin setup-link` |
| Docker | `docker logs minibrain \| grep setup` | `docker exec minibrain minibrain admin setup-link` |
| Compose | `docker compose logs minibrain \| grep setup` | `docker compose exec minibrain minibrain admin setup-link` |

The link works once and survives restarts until it is used. It names the address main listens on; opening minibrain
at another address or port, keep the path and the token, or pass `--url` to `minibrain admin setup-link`.

Automated deploys create the admin from the environment instead: `MINIBRAIN_ADMIN_EMAIL` and
`MINIBRAIN_ADMIN_PASSWORD_FILE`, a file that holds the password, such as a Docker or Kubernetes secret. Both are read on
the first start only and ignored once any account exists. `MINIBRAIN_ADMIN_PASSWORD` with the password itself works,
with a warning in the log. With compose, add this to `compose.yaml`, with the password in `admin_password.txt` next to
it:

```yaml
services:
  minibrain:
    environment:
      MINIBRAIN_ADMIN_EMAIL: admin@example.com
      MINIBRAIN_ADMIN_PASSWORD_FILE: /run/secrets/minibrain_admin_password
    secrets:
      - minibrain_admin_password

secrets:
  minibrain_admin_password:
    file: ./admin_password.txt
```

With `docker run`, mount the file read-only; it must be readable by uid 1000, the container's user:

```sh
docker run -d --name minibrain -p 127.0.0.1:8000:8000 -v minibrain-data:/data \
  -e MINIBRAIN_ADMIN_EMAIL=admin@example.com \
  -e MINIBRAIN_ADMIN_PASSWORD_FILE=/run/secrets/admin_password \
  -v "$PWD/admin_password.txt:/run/secrets/admin_password:ro" \
  ghcr.io/offbeatport/minibrain
```

On Kubernetes, mount a Secret as a volume and point `MINIBRAIN_ADMIN_PASSWORD_FILE` at the file. With single sign-on
and a group mapped to admin, no local admin is needed and no setup link is issued. Forgotten password:
`minibrain admin reset-password --email admin@example.com`. Details: [Security → First
admin](security.md#first-admin).

## Offline and air-gapped

minibrain makes no outbound calls with `MINIBRAIN_OFFLINE=1` (set in the image). Everything it needs is carried
across on disk.

### The app

Docker: pull the image on the connected machine, save it, and load it on the target. Pull with
`--platform linux/arm64` when the target's architecture differs.

```sh
docker pull ghcr.io/offbeatport/minibrain:0.1.0-cuda
docker save ghcr.io/offbeatport/minibrain:0.1.0-cuda | gzip > minibrain-0.1.0-cuda.tar.gz
docker load -i minibrain-0.1.0-cuda.tar.gz
```

Native: collect the wheels on a connected machine with the same OS, CPU architecture and Python 3.12 as the target,
in a checkout of the release tag, with the release wheel downloaded next to it.

```sh
uv export --frozen --no-dev --no-emit-project --extra postgres -o requirements.txt
python3.12 -m pip download --only-binary=:all: -d wheels -r requirements.txt
cp minibrain-0.1.0-py3-none-any.whl wheels/
```

On the target, Python 3.12 must already be installed. Then:

```sh
uv tool install --offline --no-index --find-links ./wheels --python 3.12 'minibrain[postgres]'
pip install --no-index --find-links ./wheels 'minibrain[postgres]'
```

Use either one. Set `MINIBRAIN_OFFLINE=1` and `HF_HUB_OFFLINE=1` in the environment that runs `minibrain serve`.

### Model weights

Download them on the connected machine, pinned to a commit (the revision Discover shows for catalogue models):

```sh
hf download Qwen/Qwen3-0.6B --revision <commit> --local-dir Qwen3-0.6B
```

Copy the folder across and add it with **Models → Add model → Folder**. In Docker, mount the folder (for example at
`/models`) first. With `HF_HUB_OFFLINE=1`, nothing tries to fetch weights from the hub.

### DuckDB extensions

The Docker image already has them. Native installs do not: the wheel leaves them out because one set is tens of MB per
platform and DuckDB release. On a connected machine with the same minibrain version, download them for the target's
platform (`linux_amd64`, `linux_arm64`, `osx_arm64`, `osx_amd64` or `windows_amd64`):

```sh
minibrain extensions download --to ./duckdb-extensions --platform linux_amd64 httpfs postgres_scanner iceberg avro
```

On the target, install them, or point minibrain at the folder so it installs each one on first use:

```sh
minibrain extensions install --from ./duckdb-extensions
export MINIBRAIN_DUCKDB_EXTENSION_REPOSITORY=/path/to/duckdb-extensions
```

DuckDB still checks each extension's signature when it loads it. `minibrain extensions` and Settings → Connections show
what is installed.

## Upgrading

Back up the data directory first: stop minibrain and copy the folder, and dump the database too if it is in Postgres.
Database migrations run when main starts. To go back to an older version, restore the backup.

| Install | Upgrade |
|---|---|
| `uvx` | `uvx --refresh --python 3.12 minibrain serve`, or pin one with `uvx --python 3.12 minibrain@<version> serve` |
| `uv tool` | `uv tool upgrade minibrain` |
| `pip` | `pip install --upgrade minibrain` |
| Docker | Pull (or build, or load) the new image, then replace the container and keep the volume (below) |
| Compose | `docker compose pull && docker compose up -d`; `docker compose up -d --build` for a local build |

Docker, with a backup of the volume on the way:

```sh
docker stop minibrain
docker run --rm --user 0 --entrypoint tar -v minibrain-data:/data -v "$PWD":/backup ghcr.io/offbeatport/minibrain:cuda \
  czf /backup/minibrain-data.tgz -C /data .
docker rm minibrain
```

Then start the new image with the same `docker run` command as before.

When an upgrade moves to a new DuckDB version, it needs that version's extensions. The new image carries them; native
installs download the set for the new version. Paths are versioned, so both sets can sit side by side.

## Where data lives

| Install | Folder |
|---|---|
| Native | `~/.minibrain`, or `MINIBRAIN_HOME` |
| Docker | `/data` in the container: the `minibrain-data` volume |

| Path | Holds |
|---|---|
| `minibrain.db` | Metadata in SQLite, unless `MINIBRAIN_DATABASE_URL` points at Postgres |
| `models/` | Downloaded and imported base models |
| `artifacts/` | Snapshots, adapters and eval results, when storage is local (Settings → Storage) |
| `minibrains/`, `staging/`, `sources/` | Per-minibrain and per-source working files |
| `secrets/` | Worker and gateway tokens. Keep it private |
| `duckdb/extensions/` | Installed DuckDB extensions |
| `huggingface/` | The Hugging Face cache, in Docker. Native installs use `~/.cache/huggingface` |
| `minibrain.yaml` | Optional settings for locked-down installs |
