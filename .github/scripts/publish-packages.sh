#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT_DIR"

publish_from_dir() {
  local dir=$1
  local name=$2
  local version=$3
  local token=${4:-}

  if [[ -n "$token" ]]; then
    (cd "$dir" && NODE_AUTH_TOKEN="$token" npm publish --provenance --access public) || {
      echo "::error::npm publish failed for $name@$version. Check its npm package credentials and trusted publisher settings."
      return 1
    }
    return
  fi

  (cd "$dir" && npm publish --provenance --access public) || {
    echo "::error::npm publish failed for $name@$version. Check its npm package credentials and trusted publisher settings."
    return 1
  }
}

publish_package() {
  local dir=$1
  local name
  local version

  name=$(node -p "require('./${dir}/package.json').name")
  version=$(node -p "require('./${dir}/package.json').version")

  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "$name@$version already on registry; skipping publish"
    return
  fi

  if [[ "$dir" == "create-agent-app" ]]; then
    if [[ -z "${CREATE_AGENT_APP_NPM_TOKEN:-}" ]]; then
      echo "::error::CREATE_AGENT_APP_NPM_TOKEN is required to publish $name@$version."
      return 1
    fi

    publish_from_dir "$dir" "$name" "$version" "$CREATE_AGENT_APP_NPM_TOKEN"
    return
  fi

  publish_from_dir "$dir" "$name" "$version"
}

publish_package .
publish_package create-agent-app
