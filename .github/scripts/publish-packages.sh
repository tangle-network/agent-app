#!/usr/bin/env bash

set -euo pipefail

REGISTRY=${NPM_REGISTRY_URL:-https://registry.npmjs.org}
ROOT_NAME='@tangle-network/agent-app'
CREATE_NAME='@tangle-network/create-agent-app'
REGISTRY_VERIFY_ATTEMPTS=${REGISTRY_VERIFY_ATTEMPTS:-12}
REGISTRY_VERIFY_DELAY_SECONDS=${REGISTRY_VERIFY_DELAY_SECONDS:-5}

die() {
  echo "::error::$*" >&2
  exit 1
}

[[ -n "${EXPECTED_VERSION:-}" ]] || die 'EXPECTED_VERSION is required.'
[[ "$REGISTRY_VERIFY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die 'REGISTRY_VERIFY_ATTEMPTS must be a positive integer.'
[[ "$REGISTRY_VERIFY_DELAY_SECONDS" =~ ^[0-9]+$ ]] || die 'REGISTRY_VERIFY_DELAY_SECONDS must be a non-negative integer.'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

tarball_version() {
  local tarball=$1 expected_name=$2 key=$3
  local listing="$TMP/$key.list" manifest="$TMP/$key.json"

  [[ -f "$tarball" && ! -L "$tarball" ]] || die "malformed tarball for $expected_name: expected a regular file at $tarball."
  tar -tzf "$tarball" > "$listing" 2>/dev/null || die "malformed tarball for $expected_name: unreadable gzip tar archive."
  ! grep -Evq '^package(/|$)' "$listing" || die "malformed tarball for $expected_name: entry outside package/."
  ! grep -Eq '(^|/)\.\.(/|$)' "$listing" || die "malformed tarball for $expected_name: unsafe archive path."
  [[ $(grep -Fxc 'package/package.json' "$listing" || true) -eq 1 ]] || die "malformed tarball for $expected_name: expected one package/package.json."
  [[ $(tar -tvzf "$tarball" package/package.json 2>/dev/null | head -c 1) == '-' ]] || die "malformed tarball for $expected_name: package.json is not a regular file."
  tar -xOzf "$tarball" package/package.json > "$manifest" 2>/dev/null || die "malformed tarball for $expected_name: unreadable package.json."

  node - "$manifest" "$expected_name" <<'NODE'
const fs = require('node:fs')
const [file, expectedName] = process.argv.slice(2)
let manifest
try {
  manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch {
  console.error(`malformed tarball for ${expectedName}: invalid package.json.`)
  process.exit(1)
}
if (manifest.name !== expectedName) {
  console.error(`package name mismatch: expected ${expectedName}, found ${String(manifest.name)}.`)
  process.exit(1)
}
if (manifest.private === true || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  console.error(`malformed tarball for ${expectedName}: invalid publish metadata.`)
  process.exit(1)
}
process.stdout.write(manifest.version)
NODE
}

integrity() {
  node - "$1" <<'NODE'
const crypto = require('node:crypto')
const fs = require('node:fs')
const hash = crypto.createHash('sha512').update(fs.readFileSync(process.argv[2])).digest('base64')
process.stdout.write(`sha512-${hash}`)
NODE
}

npm_command() {
  env -u CREATE_AGENT_APP_NPM_TOKEN -u NODE_AUTH_TOKEN npm "$@"
}

registry_integrity() {
  local name=$1 version=$2 key=$3 value
  if value=$(npm_command view "$name@$version" dist.integrity --registry="$REGISTRY" --prefer-online 2> "$TMP/$key.stderr"); then
    [[ "$value" =~ ^sha512-[A-Za-z0-9+/]+={0,2}$ ]] || die "registry lookup failed for $name@$version: malformed integrity."
    printf '%s' "$value"
    return
  fi
  if grep -Eq '(^|[^[:alnum:]_])E404([^[:alnum:]_]|$)' "$TMP/$key.stderr"; then return 44; fi
  cat "$TMP/$key.stderr" >&2
  die "registry lookup failed for $name@$version; refusing to publish after an unknown error."
}

wait_for_registry_integrity() {
  local name=$1 version=$2 key=$3
  local attempt value status

  for ((attempt = 1; attempt <= REGISTRY_VERIFY_ATTEMPTS; attempt += 1)); do
    if value=$(registry_integrity "$name" "$version" "$key"); then
      printf '%s' "$value"
      return
    else
      status=$?
      [[ $status -eq 44 ]] || return "$status"
    fi
    if ((attempt < REGISTRY_VERIFY_ATTEMPTS)); then
      sleep "$REGISTRY_VERIFY_DELAY_SECONDS"
    fi
  done
  return 44
}

publish_one() {
  local tarball=$1 name=$2 version=$3 key=$4
  local local_sri remote_sri status
  local args=(publish "$tarball" --provenance --access public --ignore-scripts --registry="$REGISTRY")
  local_sri=$(integrity "$tarball")

  if remote_sri=$(registry_integrity "$name" "$version" "$key"); then
    [[ "$remote_sri" == "$local_sri" ]] || die "registry tarball mismatch for $name@$version."
    echo "$name@$version already on registry; skipping publish"
    return
  else
    status=$?
    [[ $status -eq 44 ]] || exit "$status"
  fi

  if ! npm_command "${args[@]}"; then
    if remote_sri=$(registry_integrity "$name" "$version" "$key") && [[ "$remote_sri" == "$local_sri" ]]; then
      echo "$name@$version exact tarball already published by a concurrent run"
      return
    fi
    die "npm publish failed for $name@$version."
  fi
  if remote_sri=$(wait_for_registry_integrity "$name" "$version" "$key"); then
    :
  else
    status=$?
    [[ $status -eq 44 ]] || exit "$status"
    die "published $name@$version but it was not visible after $REGISTRY_VERIFY_ATTEMPTS registry checks."
  fi
  [[ "$remote_sri" == "$local_sri" ]] || die "published tarball mismatch for $name@$version."
  echo "$name@$version published and confirmed"
}

command=${1:-}
shift || true
case "$command" in
  validate)
    [[ $# -eq 2 ]] || die "usage: EXPECTED_VERSION=x.y.z $0 validate <agent-app.tgz> <create-agent-app.tgz>"
    root_version=$(tarball_version "$1" "$ROOT_NAME" root)
    create_version=$(tarball_version "$2" "$CREATE_NAME" create)
    [[ "$root_version" == "$create_version" ]] || die "tarball version mismatch: $root_version != $create_version."
    [[ "$root_version" == "$EXPECTED_VERSION" ]] || die "tarball version mismatch: expected $EXPECTED_VERSION, found $root_version."
    echo "validated exact tarballs for version $root_version"
    ;;
  publish)
    [[ $# -eq 2 ]] || die "usage: EXPECTED_VERSION=x.y.z $0 publish <agent-app|create-agent-app> <package.tgz>"
    case "$1" in
      agent-app)
        [[ -z "${CREATE_AGENT_APP_NPM_TOKEN:-}" ]] || die 'CREATE_AGENT_APP_NPM_TOKEN must not be exposed to the agent-app publisher.'
        name=$ROOT_NAME
        ;;
      create-agent-app)
        [[ -z "${CREATE_AGENT_APP_NPM_TOKEN:-}" ]] || die 'CREATE_AGENT_APP_NPM_TOKEN must not be exposed to the OIDC publisher.'
        name=$CREATE_NAME
        ;;
      *) die "unknown package selector: $1" ;;
    esac
    version=$(tarball_version "$2" "$name" "$1")
    [[ "$version" == "$EXPECTED_VERSION" ]] || die "tarball version mismatch: expected $EXPECTED_VERSION, found $version."
    publish_one "$2" "$name" "$version" "$1"
    ;;
  *) die "usage: EXPECTED_VERSION=x.y.z $0 <validate|publish> ..." ;;
esac
