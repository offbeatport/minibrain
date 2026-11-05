# Install

minibrain is one Python package for Python 3.12 or 3.13, with the web UI built in. Running it needs no Node. The
commands below use 3.12, which the Docker image runs.

| Way | For |
|---|---|
| [Installer](#installer) | One command: the latest release with uv, or the Docker image (`--docker`) |
| [Run with Docker](#run-with-docker) | Trying it on any machine with Docker, and production on Linux with NVIDIA GPUs |
| [Install from GitHub Releases](#install-from-github-releases) | The released wheel with uv, pipx or pip |
| [`uvx`](#uvx) | Trying it without installing anything |
| [`uv tool install`](#uv-tool-install) | A `minibrain` command that stays installed |
| [`pip` in a virtual environment](#pip-in-a-virtual-environment) | Machines without uv |

Releases are on [GitHub Releases](https://github.com/offbeatport/minibrain/releases) (wheel, sdist, SBOMs,
`SHA256SUMS`, the installer and a Sigstore bundle per file) and in GHCR (`ghcr.io/offbeatport/minibrain`); how they
are made: [`releasing.md`](releasing.md). minibrain is not on PyPI yet, so wherever a command below installs
`minibrain`, pass the release wheel's URL instead (see [Install from GitHub Releases](#install-from-github-releases)).
Before the first release, build the wheel from this repo with `mise run build` (or `uv build --wheel`; both need Node
with pnpm) and pass the file:

```sh
uvx --python 3.12 --from dist/minibrain-0.0.0-py3-none-any.whl minibrain serve
uv tool install --python 3.12 dist/minibrain-0.0.0-py3-none-any.whl
pip install dist/minibrain-0.0.0-py3-none-any.whl
```

Verified: `uvx` and `minibrain serve` on macOS (Apple silicon) and on Linux (Debian, CPU torch); the CPU image; the
CUDA image built for amd64 and arm64 and started without a GPU; the release workflow's dry run (wheel, sdist and all
four images built); the installer on macOS (Apple silicon) and in clean Debian 13 and Ubuntu 24.04 containers (arm64),
against a dry run's files served from a local folder. Not verified yet: native Windows, the CUDA image on a machine
with an NVIDIA GPU, and a tagged release (no image is on GHCR until the first one), so the installer's default
download and the signature checks against a real release.

## Installer

```sh
curl -LsSf https://raw.githubusercontent.com/offbeatport/minibrain/main/install.sh | sh
```

On Linux (x86_64 or arm64, glibc) and macOS (Apple silicon), it:

1. Installs uv with uv's own installer if it is missing; `--no-install-uv` stops with instructions instead.
2. Downloads `SHA256SUMS` and the wheel of the latest GitHub Release. With cosign installed, it checks the signature
   on `SHA256SUMS` first ([Verify a release](#verify-a-release)); it always checks the wheel's SHA-256.
3. Runs `uv tool install --python 3.12` on the wheel. On Linux it sets `UV_TORCH_BACKEND=auto` unless you set it: the
   CUDA build of torch when an NVIDIA driver is installed, otherwise the small CPU build. macOS gets the Metal build.
4. Prints the next step: `minibrain serve`, which prints the one-time setup link for the first admin.

| Option | Does |
|---|---|
| `MINIBRAIN_VERSION=0.1.0`, `--version 0.1.0` | Installs that release instead of the latest |
| `--docker` | Pulls the image instead (`cuda` when `nvidia-smi` sees a GPU, else CPU; `--cpu` or `--cuda` to choose), checks its signature when cosign is installed and prints the `docker run` command |
| `MINIBRAIN_RELEASE_BASE=<url>` | Takes the files from a folder that holds one release (a mirror, or `file:///path`) instead of GitHub |
| `MINIBRAIN_IMAGE=<repository>` | Pulls the `--docker` image from a mirror |
| `UV_TORCH_BACKEND` | Another PyTorch build ([PyTorch backends](#pytorch-backends)) |

Options go after `sh -s --`:

```sh
curl -LsSf https://raw.githubusercontent.com/offbeatport/minibrain/main/install.sh | sh -s -- --docker
curl -LsSf https://raw.githubusercontent.com/offbeatport/minibrain/main/install.sh | MINIBRAIN_VERSION=0.1.0 sh
```

Each release also carries the `install.sh` it was made with, signed like its other files:
`curl -LsSf https://github.com/offbeatport/minibrain/releases/download/v0.1.0/install.sh | MINIBRAIN_VERSION=0.1.0 sh`.
To read it before it runs, download it and run `sh install.sh`. Run it again to upgrade; `uv tool uninstall minibrain`
removes minibrain. On Windows, run it in WSL or use Docker Desktop.

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
version in production, or its digest (`docker inspect --format '{{index .RepoDigests 0}}' <image>` after a pull).
Every image is signed and carries its SBOM: [Verify a release](#verify-a-release).

On a Linux host with NVIDIA GPUs, a driver for CUDA 13.2 and the NVIDIA Container Toolkit, run the CUDA image:

```sh
docker run -d --name minibrain --gpus all --shm-size 8g -p 127.0.0.1:8000:8000 -v minibrain-data:/data ghcr.io/offbeatport/minibrain:cuda
docker logs minibrain | grep setup
```

The production `docker run` is under [Docker → Run](#run) and the compose file under [Compose](#compose).

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

Then install the local file the same way. `SHA256SUMS` proves the download matches the release; its signature proves
the release came from this repository's workflow (below).

## Verify a release

Every release file has a Sigstore bundle next to it (`<file>.sigstore.json`), and every image a signature and SBOM
attestations in GHCR. All are signed keyless by the release workflow at the tag, with a short-lived certificate
recorded in Sigstore's public transparency log
([Releasing → Signing and provenance](releasing.md#signing-and-provenance)). A valid signature names:

| Flag | Value |
|---|---|
| `--certificate-identity` | `https://github.com/offbeatport/minibrain/.github/workflows/release.yml@refs/tags/v0.1.0` (the release's tag) |
| `--certificate-oidc-issuer` | `https://token.actions.githubusercontent.com` |

The commands use [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3 (tested with 3.1.4) and
release 0.1.0.

### Files

```sh
BASE=https://github.com/offbeatport/minibrain/releases/download/v0.1.0
curl -fsSL -O "$BASE/SHA256SUMS" -O "$BASE/SHA256SUMS.sigstore.json" -O "$BASE/minibrain-0.1.0-py3-none-any.whl"
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/offbeatport/minibrain/.github/workflows/release.yml@refs/tags/v0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

The signed `SHA256SUMS` covers every file of the release; on macOS, `shasum -a 256 --check --ignore-missing
SHA256SUMS`. Each file's own bundle checks it directly: `cosign verify-blob --bundle
minibrain-0.1.0-py3-none-any.whl.sigstore.json <same flags> minibrain-0.1.0-py3-none-any.whl`.

### Images

```sh
cosign verify \
  --certificate-identity https://github.com/offbeatport/minibrain/.github/workflows/release.yml@refs/tags/v0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/offbeatport/minibrain:0.1.0
cosign verify-attestation --type cyclonedx \
  --certificate-identity https://github.com/offbeatport/minibrain/.github/workflows/release.yml@refs/tags/v0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com ghcr.io/offbeatport/minibrain:0.1.0 > /dev/null
```

- Each index (`0.1.0`, `0.1.0-cuda`) and each per-architecture image is signed, so verifying the digest you run
  works too: `ghcr.io/offbeatport/minibrain@sha256:…`.
- `latest` and `cuda` move between releases: match any release tag with
  `--certificate-identity-regexp '^https://github\.com/offbeatport/minibrain/\.github/workflows/release\.yml@refs/tags/v'`
  in place of `--certificate-identity`.
- The SBOM attestations: the Python and web SBOMs on each index, the image's own SBOM (operating system packages
  included) on each per-architecture image. The same SBOMs are release files.

### Provenance

GitHub's attestations record the commit and the workflow run that built each file and image (SLSA build provenance):

```sh
gh attestation verify minibrain-0.1.0-py3-none-any.whl --repo offbeatport/minibrain
gh attestation verify oci://ghcr.io/offbeatport/minibrain:0.1.0 --repo offbeatport/minibrain
```

### Offline

Nothing above needs a network lookup once the verifier has Sigstore's trusted root: each bundle carries the
signature, the certificate, the transparency log's inclusion proof and a signed timestamp. On a connected machine,
fetch the trusted root with cosign, which checks it against the TUF root built into cosign:

```sh
cosign initialize
cp ~/.sigstore/root/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json .
```

Do not take `trusted_root.json` from the same place as the files: a forged release would bring a forged root. Carry
it across with the files and their bundles, then add `--trusted-root` to any command above:

```sh
cosign verify-blob --bundle SHA256SUMS.sigstore.json --trusted-root trusted_root.json \
  --certificate-identity https://github.com/offbeatport/minibrain/.github/workflows/release.yml@refs/tags/v0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
```

Images: save the image with its signatures and attestations on the connected machine, verify the saved copy on the
other side, then load it into the internal registry, where `cosign verify --trusted-root trusted_root.json` works too:

```sh
cosign save --dir minibrain-0.1.0 ghcr.io/offbeatport/minibrain:0.1.0
cosign verify --local-image --trusted-root trusted_root.json \
  --certificate-identity https://github.com/offbeatport/minibrain/.github/workflows/release.yml@refs/tags/v0.1.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com minibrain-0.1.0
cosign load --dir minibrain-0.1.0 registry.internal/minibrain:0.1.0
```

`docker load` cannot read the saved folder. For a Docker host without a registry, verify the image on the connected
machine and move it with `docker save` ([The app](#the-app)).

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
| `MINIBRAIN_LOG_FORMAT` | `json` for one JSON object per log line on standard output ([observability](observability.md#json-logs)) |
| `MINIBRAIN_METRICS_TOKEN`, `MINIBRAIN_METRICS_ADDRESSES` | Turn on `/metrics` for Prometheus ([observability](observability.md#prometheus)) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` | OpenTelemetry export to your collector ([observability](observability.md#opentelemetry-export)) |

### DuckDB extensions

The image carries httpfs, postgres_scanner, iceberg, avro and delta for its DuckDB version and platform, so S3,
Postgres, Iceberg and Delta Lake sources work offline. minibrain installs each one into `/data/duckdb/extensions` the
first time a source needs it. To install them all now:

```sh
docker exec minibrain minibrain extensions install
docker exec minibrain minibrain extensions
```

`mysql_scanner` is left out by default. It links the MySQL client library, which is GPLv2 with the Universal FOSS
Exception, and its licence review is not done. Build with `--build-arg INCLUDE_MYSQL=true` to add it if your own
review allows it.

delta is the largest of the set: 30.5 MB compressed on linux_amd64 and 28.3 MB on linux_arm64 (DuckDB v2.0.0), about
100 MB once installed into `/data`. It takes the default set from 54 MB to 85 MB on amd64 (50 MB to 78 MB on arm64).
It reads Delta tables from folders on the server only, so mount the table's folder into the container and add it under
Settings → Security → Folder sources ([why not S3](security.md#tls-in-duckdb-extensions)). Licences of the extensions
and what delta bundles: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

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

Docker: pull the image on the connected machine, verify it ([Verify a release](#verify-a-release)), save it, and
load it on the target. Pull with `--platform linux/arm64` when the target's architecture differs. With an internal
registry, `cosign save` and `cosign load` carry the signatures across too ([Offline](#offline)).

```sh
docker pull ghcr.io/offbeatport/minibrain:0.1.0-cuda
docker save ghcr.io/offbeatport/minibrain:0.1.0-cuda | gzip > minibrain-0.1.0-cuda.tar.gz
docker load -i minibrain-0.1.0-cuda.tar.gz
```

Native: collect the wheels on a connected machine with the same OS, CPU architecture and Python 3.12 as the target,
in a checkout of the release tag, with the release wheel downloaded next to it. Carry the wheel's `.sigstore.json`
and a trusted root along to check it on the target ([Offline](#offline)).

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
minibrain extensions download --to ./duckdb-extensions --platform linux_amd64 httpfs postgres_scanner iceberg avro delta
```

On the target, install them, or point minibrain at the folder so it installs each one on first use:

```sh
minibrain extensions install --from ./duckdb-extensions
export MINIBRAIN_DUCKDB_EXTENSION_REPOSITORY=/path/to/duckdb-extensions
```

DuckDB still checks each extension's signature when it loads it. `minibrain extensions` and Settings → Connections show
what is installed.

## Config file

`minibrain.yaml` provisions a whole install: policies, sign-in, storage, data limits, prices, the catalogue schedule
and connections. It lives at `$MINIBRAIN_HOME/minibrain.yaml` (`/data/minibrain.yaml` in Docker), or wherever
`MINIBRAIN_CONFIG` points. Without it, everything is set in the UI.

- Anything the file sets is locked in the UI: the row shows "Set by config file" and saving it is refused (409).
  Leave a setting out to keep it editable. `storage:` is all or nothing: once it is there, the UI's storage settings
  are ignored.
- `MINIBRAIN_<SECTION>_<KEY>` sets the same keys from the environment and wins over the file, such as
  `MINIBRAIN_DATA_ROW_LIMIT=500000` or `MINIBRAIN_STORAGE_BUCKET=ml-artifacts` (`storage`, `data`, `catalogue` and
  `compute.currency`). Policies keep `MINIBRAIN_POLICY_<NAME>`. The UI shows "Set by environment".
- Secrets never go in the file. Name them instead: `secret_env` (an environment variable) or `secret_file` (a file
  such as a Docker or Kubernetes secret). A `secret`, `password` or `token` key stops the start with the reason.
- main checks the file when it starts. A bad value stops it with the key named (`data.row_limit: Input should be
  greater than or equal to 100`); an unknown section or key is logged as a warning and ignored.
- `minibrain config export` prints the install's current settings in this format, with every secret named but
  never included, and a comment listing what to provide on the new server. `minibrain config export >
  minibrain.yaml` round-trips: starting on it gives the same settings, now locked.

```yaml
policy:                               # Settings > Security; every name is in docs/security.md
  network: allowlist                  # open, allowlist or offline
  allowed_hosts: [hf-mirror.internal, minio.internal]
  model_sources: approved             # approved, any or imports
  log_retention_days: 30
  session_idle_minutes: 480
  encryption: vault                   # local, vault, hsm, kms or off
  vault_address: https://vault.internal:8200

auth:                                 # Settings > Accounts
  default_role: none                  # role for people whose groups map to none
  admins: [ada@corp.example, grace]   # emails or user names that are admins; needs oidc or proxy below
  roles:                              # identity provider group -> viewer, builder or admin
    minibrain-admins: admin
    ml-team: builder
  proxy:
    addresses: [10.0.0.10/32]         # identity headers count only from these addresses
  oidc:
    issuer: https://keycloak.corp/realms/corp
    client_id: minibrain
    client_secret_file: /run/secrets/oidc   # or MINIBRAIN_OIDC_CLIENT_SECRET

logging:
  format: json                        # text or json

metrics:
  addresses: [10.0.0.20/32]           # Prometheus scrapers
  token_file: /run/secrets/metrics    # or MINIBRAIN_METRICS_TOKEN

storage:                              # Settings > Storage: where artifacts live
  kind: s3                            # local (under the home folder) or s3
  endpoint: https://minio.internal:9000
  bucket: ml-artifacts
  prefix: minibrain
  region: ""                          # empty unless the store asks for one
  access_key: AKIAEXAMPLE             # the key ID, not a secret
  secret_file: /run/secrets/s3        # or secret_env: NAME; MINIBRAIN_STORAGE_S3_SECRET by default

data:                                 # Settings > Data
  row_limit: 200000                   # most rows in one dataset version
  keep_snapshots: 5                   # unused versions kept per dataset
  checks_off: [personal_data]         # duplicates, conflicts, balance, leakage, length, personal_data
  majority_share: 0.9                 # warn when one label holds more than this share
  min_label_rows: 10                  # warn when a label has fewer rows

compute:                              # Settings > General > Compute prices
  currency: EUR
  prices:                             # per hour of one pool's GPU time, by pool name
    local: 2.5
    a100: 3.2

catalogue:
  daily_sync: true                    # look for a newer model catalogue once a day

connections:                          # Settings > Connections; keep their ids across restarts by name
  - name: Exports bucket
    kind: s3
    endpoint: https://minio.internal:9000
    bucket: exports
    access_key: AKIAEXPORTS
    secret_env: EXPORTS_S3_SECRET
  - name: Warehouse
    kind: postgres                    # or mysql
    host: db.internal
    port: 5432
    database: analytics
    user: reader
    ssl_mode: verify-full
    secret_file: /run/secrets/warehouse
```

Notes:

- Connections from the file show "Set in minibrain.yaml" and cannot be edited or deleted in the UI. Each keeps its
  id while its name stays, so sources and imports that use it keep working; renaming it in the file makes a new one.
  One removed from the file stays, marked, while sources still use it. A connection the UI made becomes managed by
  the file when the file names it.
- `auth.admins` names people who sign in with single sign-on or through the proxy; they are admins whatever their
  groups, need no setup link, and their role is locked. Without `auth.oidc` or `auth.proxy`, it is logged as a
  warning and the setup link works as before.
- Pools and machines are not in the file: machines join a pool when their worker or engine starts with `--pool`.
  Prices are set by pool name, so they apply once a machine joins.

## Upgrading

Back up the data directory first: stop minibrain and copy the folder, and dump the database too if it is in Postgres.
Database migrations run when main starts. To go back to an older version, restore the backup.

| Install | Upgrade |
|---|---|
| Installer | Run it again; `MINIBRAIN_VERSION=<version>` pins one |
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

| Path | Holds | Back up |
|---|---|---|
| `minibrain.db` | Metadata in SQLite, unless `MINIBRAIN_DATABASE_URL` points at Postgres | Yes |
| `keys/` | The local master key (encryption at rest). Back it up apart from the data | Yes, separately |
| `secrets/` | Worker and gateway tokens, the storage secret key. Keep it private | Yes |
| `models/` | Downloaded and imported base models when storage is local (Settings → Storage) | Yes |
| `artifacts/` | Uploads, dataset versions, adapters and logs, encrypted, when storage is local | Yes |
| `cache/`, `staging/`, `work/` | Unpacked artifacts, DuckDB databases built from uploads, job scratch | No: rebuilt on use |
| `gateway/`, `engines/`, `worker/` | Copies kept by the gateway, engines and the worker | No: fetched again |
| `duckdb/extensions/` | Installed DuckDB extensions | No: install again |
| `huggingface/` | The Hugging Face cache, in Docker. Native installs use `~/.cache/huggingface` | No |
| `minibrain.yaml` | Optional settings that provision the install ([Config file](#config-file)) | Yes |
