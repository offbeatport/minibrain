#!/usr/bin/env bash
set -euo pipefail

readonly ISSUER="https://token.actions.githubusercontent.com"
readonly TRUSTED_ROOT="${TUF_ROOT:-${HOME}/.sigstore/root}/tuf-repo-cdn.sigstore.dev/targets/trusted_root.json"

usage() {
  cat >&2 <<'EOF'
Usage:
  sign_release.sh identity
  sign_release.sh files <assets-dir> <bundles-dir>
  sign_release.sh images <image> <digests-dir> <sbom-dir> <variant>=<index-digest>...
  sign_release.sh saved <image>@<digest> <work-dir>

Signs keyless through Sigstore with the GitHub Actions OIDC identity of this workflow run, then checks every
signature against that identity and Sigstore's trusted root. With SIGN_KEY set (the dry run and local tests), signs
with that key and the signing config in SIGN_CONFIG instead, and checks with SIGN_PUBLIC_KEY.
EOF
  exit 2
}

signer_identity() {
  printf '%s/%s\n' "${GITHUB_SERVER_URL:-https://github.com}" "${GITHUB_WORKFLOW_REF:?GITHUB_WORKFLOW_REF is not set}"
}

sign_args=(--yes)
verify_args=()

choose_signer() {
  if [[ -n "${SIGN_KEY:-}" ]]; then
    sign_args+=(--key "${SIGN_KEY}" --signing-config "${SIGN_CONFIG:?SIGN_CONFIG is not set}")
    verify_args+=(--key "${SIGN_PUBLIC_KEY:?SIGN_PUBLIC_KEY is not set}" --insecure-ignore-tlog)
    echo "Signing with the key ${SIGN_KEY}"
  else
    cosign initialize >/dev/null
    verify_args+=(--certificate-identity "$(signer_identity)" --certificate-oidc-issuer "${ISSUER}")
    verify_args+=(--trusted-root "${TRUSTED_ROOT}")
    echo "Signing keyless as $(signer_identity)"
  fi
}

sign_files() {
  local assets=$1 bundles=$2 file bundle
  mkdir -p "${bundles}"
  for file in "${assets}"/*; do
    bundle="${bundles}/$(basename "${file}").sigstore.json"
    cosign sign-blob "${sign_args[@]}" --bundle "${bundle}" "${file}" >/dev/null
    cosign verify-blob "${verify_args[@]}" --bundle "${bundle}" "${file}"
  done
}

arch_digest() {
  local found=("$1/digest-$2-$3"/*)
  if [[ ${#found[@]} -ne 1 || ! -f "${found[0]}" ]]; then
    echo "expected one digest in $1/digest-$2-$3" >&2
    return 1
  fi
  printf 'sha256:%s\n' "$(basename "${found[0]}")"
}

attest_sbom() {
  cosign attest "${sign_args[@]}" --type cyclonedx --predicate "$2" "$1"
}

check_image() {
  cosign verify "${verify_args[@]}" "$1" >/dev/null
  cosign verify-attestation "${verify_args[@]}" --type cyclonedx "$1" >/dev/null
  echo "Verified the signature and SBOM attestation of $1"
}

sign_variant() {
  local image=$1 digests=$2 sboms=$3 variant=$4 index=$5 arch digest
  cosign sign "${sign_args[@]}" --recursive "${image}@${index}"
  attest_sbom "${image}@${index}" "${sboms}/minibrain-python.cdx.json"
  attest_sbom "${image}@${index}" "${sboms}/minibrain-web.cdx.json"
  check_image "${image}@${index}"
  for arch in amd64 arm64; do
    digest=$(arch_digest "${digests}" "${variant}" "${arch}")
    attest_sbom "${image}@${digest}" "${sboms}/minibrain-image-${variant}-${arch}.cdx.json"
    check_image "${image}@${digest}"
  done
}

sign_images() {
  local image=$1 digests=$2 sboms=$3 pair
  shift 3
  for pair in "$@"; do
    sign_variant "${image}" "${digests}" "${sboms}" "${pair%%=*}" "${pair#*=}"
  done
}

check_saved() {
  local reference=$1 layout="$2/image"
  rm -rf "${layout}"
  cosign save --dir "${layout}" "${reference}"
  cosign verify --local-image "${verify_args[@]}" "${layout}" >/dev/null
  cosign verify-attestation --local-image "${verify_args[@]}" --type cyclonedx "${layout}" >/dev/null
  echo "Verified ${reference} from a saved copy, as an air-gapped host does"
  rm -rf "${layout}"
}

main() {
  local command=${1:-}
  shift || true
  case "${command}" in
    (identity) signer_identity ;;
    (files)
      [[ $# -eq 2 ]] || usage
      choose_signer
      sign_files "$@"
      ;;
    (images)
      [[ $# -ge 4 ]] || usage
      choose_signer
      sign_images "$@"
      ;;
    (saved)
      [[ $# -eq 2 ]] || usage
      choose_signer
      check_saved "$@"
      ;;
    (*) usage ;;
  esac
}

main "$@"
