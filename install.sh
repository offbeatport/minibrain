#!/bin/sh
set -eu

repo="offbeatport/minibrain"
python_version="3.12"
issuer="https://token.actions.githubusercontent.com"
workflow="https://github.com/${repo}/.github/workflows/release.yml"
workflow_pattern="^https://github\\.com/offbeatport/minibrain/\\.github/workflows/release\\.yml@refs/tags/v[0-9]"
uv_installer="https://astral.sh/uv/install.sh"

mode=native
variant=""
install_uv=yes
version="${MINIBRAIN_VERSION:-}"
image="${MINIBRAIN_IMAGE:-ghcr.io/${repo}}"
workdir=""

usage() {
    cat <<EOF
Install minibrain from its GitHub Release.

  curl -LsSf https://raw.githubusercontent.com/${repo}/main/install.sh | sh
  curl -LsSf https://raw.githubusercontent.com/${repo}/main/install.sh | sh -s -- --docker

Options:
  --docker          Pull the Docker image instead and print the command that runs it
  --cpu, --cuda     The image --docker pulls (default: cuda when nvidia-smi sees a GPU, else cpu)
  --version V       Install release V instead of the latest (same as MINIBRAIN_VERSION=V)
  --no-install-uv   Stop and explain instead of installing uv when it is missing
  -h, --help        Show this help

Environment:
  MINIBRAIN_VERSION       Release to install, such as 0.1.0 (default: the latest)
  MINIBRAIN_RELEASE_BASE  URL of a folder holding one release's files, such as a mirror (default: GitHub Releases)
  MINIBRAIN_IMAGE         Image repository for --docker (default: ghcr.io/${repo})
  UV_TORCH_BACKEND        PyTorch build for uv (default on Linux: auto, picked from the GPU driver)

The wheel is checked against the release's SHA256SUMS. When cosign is installed, SHA256SUMS
(or the image, with --docker) is also checked against its Sigstore signature from the release workflow.
EOF
}

say() {
    printf '%s\n' "$*"
}

fail() {
    printf 'minibrain install: %s\n' "$*" >&2
    exit 1
}

has() {
    command -v "$1" >/dev/null 2>&1
}

cleanup() {
    if [ -n "$workdir" ]; then
        rm -rf "$workdir"
    fi
}

parse_args() {
    while [ "$#" -gt 0 ]; do
        case "$1" in
            (--docker) mode=docker ;;
            (--cpu) variant=cpu ;;
            (--cuda) variant=cuda ;;
            (--version)
                [ "$#" -ge 2 ] || fail "--version needs a value"
                version=$2
                shift
                ;;
            (--version=*) version=${1#--version=} ;;
            (--no-install-uv) install_uv=no ;;
            (-h | --help)
                usage
                exit 0
                ;;
            (*) fail "unknown option: $1 (see --help)" ;;
        esac
        shift
    done
    version=${version#v}
    check_version "$version"
}

check_version() {
    case "$1" in
        (*[!0-9A-Za-z._+]*) fail "not a version: $1" ;;
    esac
}

detect_platform() {
    case "$(uname -s)" in
        (Linux) os=linux ;;
        (Darwin) os=macos ;;
        (MINGW* | MSYS* | CYGWIN*) fail "on Windows, run this in WSL, use Docker Desktop, or pip (docs/install.md)" ;;
        (*) fail "unsupported operating system: $(uname -s)" ;;
    esac
    case "$(uname -m)" in
        (x86_64 | amd64) arch=x86_64 ;;
        (aarch64 | arm64) arch=arm64 ;;
        (*) fail "unsupported CPU: $(uname -m) (x86_64 and arm64 are supported)" ;;
    esac
}

check_native_platform() {
    if [ "$os" = macos ] && [ "$arch" = x86_64 ]; then
        fail "PyTorch has no builds for Intel Macs: use Docker instead (install.sh --docker)"
    fi
    if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
        fail "PyTorch has no builds for musl (Alpine): use Docker or a glibc distribution"
    fi
}

fetch() {
    case "$1" in
        (https://*) curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1" ;;
        (*) curl -fsSL -o "$2" "$1" ;;
    esac
}

release_base() {
    if [ -n "${MINIBRAIN_RELEASE_BASE:-}" ]; then
        printf '%s' "${MINIBRAIN_RELEASE_BASE%/}"
    elif [ -n "$version" ]; then
        printf 'https://github.com/%s/releases/download/v%s' "$repo" "$version"
    else
        printf 'https://github.com/%s/releases/latest/download' "$repo"
    fi
}

wheel_in() {
    awk '{ name = $2; sub(/^\*/, "", name) } name ~ /^minibrain-[^-]+-py3-none-any\.whl$/ { print name; exit }' "$1"
}

sha256_in() {
    awk -v file="$2" '{ name = $2; sub(/^\*/, "", name) } name == file { print $1; exit }' "$1"
}

sha256_of() {
    if has sha256sum; then
        sha256sum "$1" | awk '{ print $1 }'
    elif has shasum; then
        shasum -a 256 "$1" | awk '{ print $1 }'
    elif has openssl; then
        openssl dgst -sha256 -r "$1" | awk '{ print $1 }'
    else
        fail "needs sha256sum, shasum or openssl to check the download"
    fi
}

verify_checksums_signature() {
    if ! has cosign; then
        say "cosign is not installed, so only the SHA-256 is checked. With cosign, this also checks the signature."
        return 0
    fi
    fetch "$1/SHA256SUMS.sigstore.json" "$workdir/SHA256SUMS.sigstore.json" ||
        fail "the release has no SHA256SUMS.sigstore.json to check the signature with"
    if ! cosign verify-blob --bundle "$workdir/SHA256SUMS.sigstore.json" \
        --certificate-identity "${workflow}@refs/tags/v$2" --certificate-oidc-issuer "$issuer" \
        "$workdir/SHA256SUMS" >"$workdir/cosign.log" 2>&1; then
        cat "$workdir/cosign.log" >&2
        fail "SHA256SUMS does not carry a valid signature from ${workflow}@refs/tags/v$2"
    fi
    say "Signature checked: SHA256SUMS was signed by ${workflow}@refs/tags/v$2"
}

verify_wheel() {
    expected=$(sha256_in "$workdir/SHA256SUMS" "$1")
    actual=$(sha256_of "$workdir/$1")
    [ -n "$expected" ] || fail "SHA256SUMS does not list $1"
    [ "$expected" = "$actual" ] || fail "$1 does not match SHA256SUMS (expected $expected, got $actual)"
    say "SHA-256 checked: $1"
}

find_uv() {
    if has uv; then
        command -v uv
        return 0
    fi
    for candidate in "${XDG_BIN_HOME:-$HOME/.local/bin}/uv" "$HOME/.local/bin/uv" "${CARGO_HOME:-$HOME/.cargo}/bin/uv"; do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

install_uv_tool() {
    if [ "$install_uv" = no ]; then
        fail "uv is not installed. Install it (https://docs.astral.sh/uv/getting-started/installation/), for example with
  curl -LsSf ${uv_installer} | sh
then run this installer again."
    fi
    say "uv is not installed: installing it with its own installer (${uv_installer})" >&2
    fetch "$uv_installer" "$workdir/uv-install.sh"
    sh "$workdir/uv-install.sh" </dev/null >&2
    find_uv || fail "uv was installed but cannot be found; open a new shell and run this installer again"
}

default_torch_backend() {
    if [ "$os" = linux ] && [ -z "${UV_TORCH_BACKEND:-}" ]; then
        UV_TORCH_BACKEND=auto
        export UV_TORCH_BACKEND
    fi
}

print_native_next_steps() {
    bin_dir=$("$1" tool dir --bin)
    say ""
    say "minibrain $2 is installed: ${bin_dir}/minibrain"
    case ":$PATH:" in
        (*":${bin_dir}:"*) ;;
        (*)
            say ""
            say "${bin_dir} is not on PATH yet. Add it with"
            say "  $1 tool update-shell"
            say "and open a new shell, or run ${bin_dir}/minibrain."
            ;;
    esac
    say ""
    say "Start it:"
    say "  minibrain serve"
    say ""
    say "On first start it prints a one-time setup link: open it to create the admin account."
    say "The UI is at http://127.0.0.1:8000. To upgrade, run this installer again."
}

install_native() {
    check_native_platform
    has curl || fail "needs curl"
    uv=$(find_uv) || uv=$(install_uv_tool)
    base=$(release_base)
    say "Downloading minibrain${version:+ $version} from ${base}"
    fetch "$base/SHA256SUMS" "$workdir/SHA256SUMS" || fail "cannot download ${base}/SHA256SUMS"
    wheel=$(wheel_in "$workdir/SHA256SUMS")
    [ -n "$wheel" ] || fail "SHA256SUMS at ${base} lists no minibrain wheel"
    release=${wheel#minibrain-}
    release=${release%-py3-none-any.whl}
    check_version "$release"
    if [ -n "$version" ] && [ "$version" != "$release" ]; then
        fail "asked for $version, but ${base} holds $release"
    fi
    verify_checksums_signature "$base" "$release"
    fetch "$base/$wheel" "$workdir/$wheel" || fail "cannot download ${base}/${wheel}"
    verify_wheel "$wheel"
    default_torch_backend
    say "Installing minibrain $release with uv (Python ${python_version}${UV_TORCH_BACKEND:+, PyTorch backend $UV_TORCH_BACKEND})"
    "$uv" tool install --force --python "$python_version" "$workdir/$wheel" </dev/null
    print_native_next_steps "$uv" "$release"
}

pick_variant() {
    if [ -n "$variant" ]; then
        return 0
    fi
    variant=cpu
    if [ "$os" = linux ] && has nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
        variant=cuda
    fi
}

image_tag() {
    if [ -n "$version" ] && [ "$variant" = cuda ]; then
        printf '%s-cuda' "$version"
    elif [ -n "$version" ]; then
        printf '%s' "$version"
    elif [ "$variant" = cuda ]; then
        printf 'cuda'
    else
        printf 'latest'
    fi
}

verify_image() {
    if ! has cosign; then
        say "cosign is not installed, so the image signature is not checked. With cosign, this checks it."
        return 0
    fi
    if [ -n "$version" ]; then
        set -- --certificate-identity "${workflow}@refs/tags/v${version}"
    else
        set -- --certificate-identity-regexp "$workflow_pattern"
    fi
    if ! cosign verify "$@" --certificate-oidc-issuer "$issuer" "$pinned" >"$workdir/cosign.log" 2>&1; then
        cat "$workdir/cosign.log" >&2
        fail "$pinned does not carry a valid signature from ${workflow}"
    fi
    say "Signature checked: $pinned was signed by ${workflow}"
}

print_docker_next_steps() {
    gpu=""
    if [ "$variant" = cuda ]; then
        gpu=" --gpus all --shm-size 8g"
    fi
    say ""
    say "Pulled $pinned"
    say ""
    say "Start it:"
    say "  docker run -d --name minibrain --restart unless-stopped --stop-timeout 30${gpu} \\"
    say "    -p 127.0.0.1:8000:8000 -v minibrain-data:/data ${image}:${tag}"
    say ""
    say "Then docker logs minibrain shows the one-time setup link: open it to create the admin account."
    say "The UI is at http://127.0.0.1:8000. Data stays in the minibrain-data volume."
}

install_docker() {
    has docker || fail "needs Docker: https://docs.docker.com/get-started/get-docker/"
    docker info >/dev/null 2>&1 || fail "cannot reach the Docker daemon (is it running, and may this user use it?)"
    pick_variant
    if [ "$variant" = cuda ] && [ "$os" = macos ]; then
        fail "Docker on macOS has no GPU access: use --cpu"
    fi
    tag=$(image_tag)
    say "Pulling ${image}:${tag}"
    docker pull "${image}:${tag}" </dev/null
    pinned=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${image}:${tag}" | grep -F "${image}@" | head -n 1)
    [ -n "$pinned" ] || fail "cannot find the digest of ${image}:${tag}"
    verify_image
    print_docker_next_steps
}

main() {
    parse_args "$@"
    detect_platform
    workdir=$(mktemp -d)
    trap cleanup EXIT
    trap 'exit 1' INT TERM
    if [ "$mode" = docker ]; then
        install_docker
    else
        install_native
    fi
}

main "$@"
