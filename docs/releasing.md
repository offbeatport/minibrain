# Releasing

A release is a `v*` tag. Pushing one runs [`.github/workflows/release.yml`](../.github/workflows/release.yml): it
checks the tag against `pyproject.toml`, runs CI, builds the Docker images from the wheel CI built, and publishes the
images to GHCR and the files to GitHub Releases. Every file and image is signed keyless through Sigstore and carries
SLSA build provenance ([Signing and provenance](#signing-and-provenance)). Nothing goes to PyPI yet (below).

## Cut a release

1. Set the version. `uv version` writes `pyproject.toml` and `uv.lock` together; CI's `uv sync --locked` fails if
   only one changes. Pre-releases use PEP 440 (`0.2.0rc1`, `0.2.0b1`).

   ```sh
   uv version 0.1.0
   git commit -m "chore(release): v0.1.0" pyproject.toml uv.lock
   git push origin main
   ```

2. Wait for CI on that commit, then dry-run the release on it. It builds everything and publishes nothing, in about
   15 minutes:

   ```sh
   gh workflow run release.yml --ref main
   gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   ```

3. Tag the same commit and push the tag:

   ```sh
   git tag -a v0.1.0 -m "minibrain 0.1.0"
   git push origin v0.1.0
   ```

4. Watch the run as in step 2. On the first release only, make the image public (below).

A tag that does not match the version fails the first job, before anything is built. Delete it, fix the version and tag
again: `git push origin :refs/tags/v0.1.0 && git tag -d v0.1.0`. A version can be released once: GitHub refuses a
second release for the same tag, and PyPI never takes the same version twice.

### First release: make the image public

GHCR creates the `minibrain` package on the first push as private, whatever the repository's visibility, so
`docker pull` needs a login until it is public. After the first tag run: GitHub → Profile → Packages → `minibrain` →
Package settings → Danger zone → Change visibility → Public. A public package cannot be made private again. The
images' `org.opencontainers.image.source` label links the package to this repository.

## What a tag push produces

GitHub Release `v0.1.0`, with notes and these files:

| File | Holds |
|---|---|
| `minibrain-0.1.0-py3-none-any.whl` | The wheel, with the built web UI in `minibrain/web` and the commit in `minibrain/build.json` |
| `minibrain-0.1.0.tar.gz` | The sdist, with the built UI in `web/dist`, so a wheel built from it needs no Node |
| `minibrain-python.cdx.json` | CycloneDX 1.5 SBOM of the Python dependencies, from `uv.lock` ([Security → SBOM](security.md#software-sbom)) |
| `minibrain-web.cdx.json` | CycloneDX 1.6 SBOM of the web dependencies, from `web/pnpm-lock.yaml` |
| `minibrain-image-{cpu,cuda}-{amd64,arm64}.cdx.json` | CycloneDX 1.6 SBOM of each of the four images, from syft against the built image, operating system packages included |
| `install.sh` | The installer, as it is at the tag ([Install → Installer](install.md#installer)) |
| `SHA256SUMS` | The SHA-256 of every file above, for `sha256sum --check` |
| `<file>.sigstore.json` | One Sigstore bundle per file above, `SHA256SUMS` included: signature, certificate and transparency log proof, for `cosign verify-blob` online or offline |
| `minibrain-provenance.sigstore.json` | SLSA build provenance for every file above, from `actions/attest` |

Images in `ghcr.io/offbeatport/minibrain`, each a multi-arch index for linux/amd64 and linux/arm64:

| Tag | Image |
|---|---|
| `0.1.0` and `latest` | CPU (`VARIANT=cpu`) |
| `0.1.0-cuda` and `cuda` | NVIDIA CUDA 13.2 (`VARIANT=cuda`) |

A pre-release gets only its version tags (`0.2.0rc1`, `0.2.0rc1-cuda`), and the GitHub Release is marked as a
pre-release; `latest` and `cuda` stay on the last stable release. Each index and each per-architecture image is signed
and carries SBOM attestations; each index carries SLSA provenance.

The notes come from [`scripts/release_notes.py`](../scripts/release_notes.py): install lines for the version, then
every commit since the previous `v*` tag (all commits for the first release) grouped by Conventional Commit type.
Breaking changes (`type!:` or a `BREAKING CHANGE:` footer) come first; subjects that are not Conventional Commits go
under Other changes; a compare link closes them. Preview them with
`uv run python scripts/release_notes.py --version 0.1.0`. Edit the release on GitHub to add highlights.

## The jobs

| Job | Does | Token permissions |
|---|---|---|
| Version | Reads `version` from `pyproject.toml`; on a tag push, fails unless the tag is `v<version>`. A version with `a`, `b`, `rc` or `.dev` is a pre-release | `contents: read` |
| CI | All of [`ci.yml`](../.github/workflows/ci.yml), called with `workflow_call`: Python checks on 3.12 and 3.13, web checks, the wheel and sdist, the SBOMs | `contents: read` |
| Image (4) | `cpu` and `cuda`, each on an amd64 (`ubuntu-24.04`) and an arm64 (`ubuntu-24.04-arm`) runner. Installs CI's wheel; on a tag push, pushes the image by digest. Then loads the same build (all cached) into Docker and writes its SBOM with syft | `contents: read`, `packages: write` |
| Image tags | Joins each variant's two digests into one multi-arch index and tags it. Tag push only | `packages: write` |
| Release assets | Checks the wheel, sdist, SBOMs and `install.sh` are there for this version, writes `SHA256SUMS` and the notes | `contents: read` |
| Sign and attest | Signs every release file and image, attests the SBOMs and the provenance, and checks every signature ([below](#signing-and-provenance)). In a dry run, signs the files with a throwaway key only | `contents: read`, `packages: write`, `id-token: write`, `attestations: write` |
| GitHub Release | `gh release create` with the assets, their bundles and the notes. Tag push only | `contents: write` |

- The workflow's default token has no permissions; each job asks for what it needs. Only the image jobs and Sign and
  attest can write packages, only Sign and attest can request an OIDC token or write attestations, and only the last
  job can write to the repository.
- Every action is pinned to a full commit SHA of a release at least two weeks old, as in `ci.yml`. cosign and syft are
  downloaded by version and checked against a pinned SHA-256 (`COSIGN_*` and `SYFT_*` in `release.yml`). `actionlint`
  checks both workflows; the CI job Shell scripts runs ShellCheck on `install.sh` and `scripts/*.sh`.
- CI does not run on tag pushes (`push: branches: ["**"]`), since the release runs it. Its concurrency group carries
  the calling workflow's name, so a push to `main` never cancels a release's CI.

### The image is built from the release wheel

The Dockerfile's `wheel` stage is a `FROM scratch` stage that holds the wheel. A plain `docker build .` fills it from
the checkout (UI build, then `uv build`). The release passes `--build-context wheel=<folder with CI's wheel>` instead,
which replaces that stage, so the UI and wheel stages never run and the image holds the exact wheel attached to the
release: same files, same `build.json` commit and build time. Everything else comes from the same commit's
`uv.lock`, as in any build.

### Runner disk and build cache

Measured on the first dry run ([run 41705098920](https://github.com/offbeatport/minibrain/actions/runs/41705098920),
2026-11-03): the standard hosted runners have a 145 GB root disk with about 86 GB (`ubuntu-24.04`) and 107 GB
(`ubuntu-24.04-arm`) free when a job starts. A CUDA build uses about 18 GB of it and a CPU build about 5 GB, so the
image jobs free no space and need no larger runners. Each one prints `df -h /` at the end, to show if that changes.

| Image | Build, amd64 | Build, arm64 |
|---|---|---|
| CPU | 3 minutes | 2.5 minutes |
| CUDA | 6 minutes | 4 minutes |

The image SBOM comes after the build in the same job: loading the image into Docker (all cached) and scanning it
with syft take about 30 seconds each for a CPU image and 1.5 minutes each for a CUDA one, and each SBOM is about
3 MB (about 4,200 components, 1,230 to 1,280 of them packages). The CUDA amd64 job ends with 62 GB free, measured on
the dry run with signing ([run 41738301352](https://github.com/offbeatport/minibrain/actions/runs/41738301352)).

The whole run takes about 15 minutes, half of it CI. The images use no exported layer cache:

- The slow stages never run: the wheel arrives built, so the UI and wheel stages are skipped, and within a job
  BuildKit's uv cache mount serves the `extensions` and `runtime` stages from one download.
- CI's uv caches already fill the repository's 10 GB Actions cache (about 2.7 GB for each Python version and
  `uv.lock`). A layer cache for the CPU images added 1.6 GB and about a minute of export to each 2.5-minute build, and
  would be evicted by the next CI run; one for a CUDA image would be several GB per architecture.
- Caches written by a tag run can only be read by that tag, so only a dry run on `main` could warm one for the next
  tag.

### Dry run

`workflow_dispatch` runs everything except publishing: no registry login, the images are built with `push=false`,
and the Image tags and GitHub Release jobs are skipped. The checksums, image SBOMs and notes are uploaded as the run's
`release-assets` and `release-notes` artifacts, and the notes show in the run summary. It builds the version in
`pyproject.toml`, whatever it is, and checks no tag.

Sign and attest runs too, without signing anything for real: it installs cosign, fetches Sigstore's trusted root, makes
a throwaway key pair in the job and signs and checks every release file with it under a signing config with no
services, so nothing reaches Sigstore's certificate authority or transparency log. The bundles land in the run's
`release-assets-signatures` artifact. The image signatures, the SBOM attestations, the provenance and the offline
check of a saved image need the pushed images and the tag's OIDC identity, so they run only on a tag.

## PyPI: not set up yet

Publishing will use PyPI's Trusted Publishing: PyPI trusts a short-lived OIDC token from this workflow, so no API token
is stored anywhere. Steps for the account owner:

1. On pypi.org, signed in with two-factor authentication: Your account → Publishing → Add a new pending publisher →
   GitHub, with:

   | Field | Value |
   |---|---|
   | PyPI Project Name | `minibrain` |
   | Owner | `offbeatport` |
   | Repository name | `minibrain` |
   | Workflow name | `release.yml` |
   | Environment name | `pypi` |

   A pending publisher reserves nothing: the project is created by the first upload, and until then anyone can register
   the name. `minibrain` was free on PyPI on 2026-11-03. The same form on test.pypi.org gives a rehearsal target.
2. On GitHub: Settings → Environments → New environment `pypi`. Under Deployment branches and tags choose Selected
   branches and tags and add the tag rule `v*`; add yourself under Required reviewers to approve each upload.
3. Add this job to `release.yml`, after the GitHub Release, so PyPI only gets versions that were released in full:

   ```yaml
     pypi:
       name: PyPI
       needs: [version, release]
       if: needs.version.outputs.publish == 'true'
       runs-on: ubuntu-24.04
       timeout-minutes: 10
       environment:
         name: pypi
         url: https://pypi.org/p/minibrain
       permissions:
         id-token: write
       steps:
         - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
           with:
             name: minibrain-wheel
             path: dist
         - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2
           with:
             name: minibrain-sdist
             path: dist
         - uses: pypa/gh-action-pypi-publish@dc37677b2e1c63e2034f94d8a5b11f265b73ba33 # v1.14.2
   ```

   The action's default `attestations: true` signs PEP 740 attestations through Sigstore with this workflow's OIDC
   identity, the same keyless signing as the release files, so PyPI shows the provenance of each upload.
4. Drop the "not on PyPI yet" notes from [`install.md`](install.md) and the README: `uvx minibrain` and
   `pip install minibrain` then work as written.

## Signing and provenance

Signing is keyless: no private key is stored anywhere. The Sign and attest job asks GitHub for an OIDC token
(`id-token: write`), Sigstore's certificate authority (Fulcio) turns it into a certificate valid for ten minutes that
names the workflow run, and every signature goes into Sigstore's public transparency log (Rekor). The certificate's
identity is the workflow file at the tag, which is what a verifier checks:

| Field | Value |
|---|---|
| Identity (certificate SAN) | `https://github.com/offbeatport/minibrain/.github/workflows/release.yml@refs/tags/v<version>` |
| OIDC issuer | `https://token.actions.githubusercontent.com` |

| Subject | Made with | Stored |
|---|---|---|
| Every release file, `SHA256SUMS` and `install.sh` included | `cosign sign-blob --bundle` | `<file>.sigstore.json` on the release |
| Both image indexes and the four per-architecture images | `cosign sign --recursive` on each index | Next to the image in GHCR, as an OCI referrer |
| SBOMs on the images: the Python and web SBOMs on both indexes, each image SBOM on its own image | `cosign attest --type cyclonedx` | GHCR |
| SLSA build provenance of the release files | `actions/attest` | GitHub's attestations API and `minibrain-provenance.sigstore.json` on the release |
| SLSA build provenance of both image indexes | `actions/attest` with `push-to-registry` | GitHub's attestations API and GHCR |

- `scripts/sign_release.sh` does the cosign part and then checks each signature as a customer would: the identity
  above, the issuer and Sigstore's trusted root, with no network lookup for the transparency log (the bundles carry
  its inclusion proof). Last, it saves the CPU image with its signatures (`cosign save`) and checks the saved copy
  (`cosign verify --local-image`), as an air-gapped host does.
- `actions/attest` is the action `actions/attest-build-provenance` wraps since its v4. `create-storage-record: false`:
  storage records need an organization-owned repository.
- `trusted_root.json` is not attached to the release. A copy downloaded from the same place as the files proves
  nothing; a verifier gets it from Sigstore's TUF repository with cosign, whose TUF root is built in. The commands,
  online and offline: [Install → Verify a release](install.md#verify-a-release).
- A tag whose Sign and attest job fails has pushed and tagged its images but has no GitHub Release. Fix the cause,
  delete the tag and push it again: the image tags move to the new digests.
- Update bundles (the roadmap's signed offline bundles for the app and base models) will reuse the blob signing:
  one more file per bundle with its `.sigstore.json`.
