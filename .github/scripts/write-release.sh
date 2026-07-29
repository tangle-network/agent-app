#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "::error::$*" >&2
  exit 1
}

[[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || die 'BASE_SHA must be a full commit SHA.'
[[ "${VERSION:-}" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || die 'VERSION must be a stable semantic version.'
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die 'GITHUB_REPOSITORY is invalid.'
[[ -n "${GITHUB_TOKEN:-}" ]] || die 'GITHUB_TOKEN is required.'
[[ -n "${GIT_DIR:-}" ]] || die 'GIT_DIR is required.'

TAG_REF="refs/tags/v$VERSION"
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agent-app-release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

remote_ref() {
  git ls-remote origin "$1" | awk 'NR == 1 { print $1 }'
}

read_manifests() {
  local commit=$1
  git show "$commit:package.json" > "$WORK/package.json"
  git show "$commit:create-agent-app/package.json" > "$WORK/create-package.json"
}

validate_release_manifests() {
  EXPECTED_VERSION="$VERSION" node - "$WORK/package.json" "$WORK/create-package.json" <<'NODE'
const fs = require('node:fs')
const [rootFile, createFile] = process.argv.slice(2)
const root = JSON.parse(fs.readFileSync(rootFile, 'utf8'))
const create = JSON.parse(fs.readFileSync(createFile, 'utf8'))
if (root.name !== '@tangle-network/agent-app') throw new Error('unexpected root package name')
if (create.name !== '@tangle-network/create-agent-app') throw new Error('unexpected create package name')
if (root.version !== process.env.EXPECTED_VERSION || create.version !== process.env.EXPECTED_VERSION) {
  throw new Error(`release manifest version mismatch: ${root.version} / ${create.version}`)
}
NODE
}

validate_existing_release() {
  local release_sha=$1
  local -a commit_line changed

  read -r -a commit_line <<< "$(git rev-list --parents -n 1 "$release_sha")"
  [[ ${#commit_line[@]} -eq 2 && "${commit_line[1]}" == "$BASE_SHA" ]] ||
    die "Existing $TAG_REF is not a one-parent release commit over $BASE_SHA."
  git merge-base --is-ancestor "$release_sha" refs/remotes/origin/main ||
    die "Existing $TAG_REF is not on origin/main."
  mapfile -t changed < <(git diff --name-only "$BASE_SHA" "$release_sha" | LC_ALL=C sort)
  [[ ${#changed[@]} -eq 2 && "${changed[0]}" == 'create-agent-app/package.json' && "${changed[1]}" == 'package.json' ]] ||
    die "Existing $TAG_REF changes files other than the two package manifests."
  [[ $(git log -1 --format=%s "$release_sha") == "chore(release): $VERSION [skip release]" ]] ||
    die "Existing $TAG_REF has an unexpected commit message."
  read_manifests "$release_sha"
  validate_release_manifests
}

create_release() {
  read_manifests "$BASE_SHA"
  EXPECTED_VERSION="$VERSION" node - "$WORK/package.json" "$WORK/create-package.json" <<'NODE'
const fs = require('node:fs')
const files = process.argv.slice(2)
const manifests = files.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
if (manifests[0].name !== '@tangle-network/agent-app' || manifests[1].name !== '@tangle-network/create-agent-app') {
  throw new Error('unexpected package names')
}
if (manifests[0].version !== manifests[1].version) throw new Error('base package versions differ')
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(manifests[0].version)
const next = match && `${match[1]}.${match[2]}.${BigInt(match[3]) + 1n}`
if (next !== process.env.EXPECTED_VERSION) throw new Error(`expected next patch ${String(next)}, found ${process.env.EXPECTED_VERSION}`)
for (let index = 0; index < files.length; index += 1) {
  manifests[index].version = process.env.EXPECTED_VERSION
  fs.writeFileSync(files[index], `${JSON.stringify(manifests[index], null, 2)}\n`)
}
NODE

  local root_blob create_blob tree commit
  root_blob=$(git hash-object -w "$WORK/package.json")
  create_blob=$(git hash-object -w "$WORK/create-package.json")
  git read-tree "$BASE_SHA^{tree}"
  git update-index --cacheinfo "100644,$root_blob,package.json"
  git update-index --cacheinfo "100644,$create_blob,create-agent-app/package.json"
  tree=$(git write-tree)
  export GIT_AUTHOR_NAME='github-actions[bot]' GIT_COMMITTER_NAME='github-actions[bot]'
  export GIT_AUTHOR_EMAIL='github-actions[bot]@users.noreply.github.com'
  export GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
  commit=$(printf 'chore(release): %s [skip release]\n' "$VERSION" | git commit-tree "$tree" -p "$BASE_SHA")
  git update-ref refs/heads/release "$commit"
  git update-ref "$TAG_REF" "$commit"

  local attempt main tag
  for attempt in 1 2 3; do
    if git push --atomic origin refs/heads/release:refs/heads/main "$TAG_REF:$TAG_REF"; then
      printf '%s' "$commit"
      return
    fi
    main=$(remote_ref refs/heads/main)
    tag=$(remote_ref "$TAG_REF")
    if [[ "$main" == "$commit" && "$tag" == "$commit" ]]; then
      printf '%s' "$commit"
      return
    fi
    if [[ "$main" != "$BASE_SHA" && -z "$tag" ]]; then
      echo "::notice::main advanced to $main; atomic push left the tag unchanged." >&2
      return 10
    fi
    [[ "$main" == "$BASE_SHA" && -z "$tag" ]] || die 'Remote refs are not atomic.'
    sleep "$attempt"
  done
  die 'Atomic release push failed 3 times.'
}

dispatch_release() {
  local response status
  response="$WORK/dispatch-response"
  status=$(curl --silent --show-error --output "$response" --write-out '%{http_code}' \
    --request POST \
    --header 'Accept: application/vnd.github+json' \
    --header "Authorization: Bearer $GITHUB_TOKEN" \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    "${GITHUB_API_URL:-https://api.github.com}/repos/$GITHUB_REPOSITORY/actions/workflows/publish.yml/dispatches" \
    --data "{\"ref\":\"v$VERSION\"}")
  if [[ "$status" != 204 ]]; then
    cat "$response" >&2
    die "Release dispatch failed with HTTP $status."
  fi
  echo "Dispatched publish.yml at v$VERSION."
}

git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
REMOTE_MAIN=$(git rev-parse refs/remotes/origin/main)
TAG_REMOTE=$(remote_ref "$TAG_REF")

if [[ -n "$TAG_REMOTE" ]]; then
  git fetch --no-tags origin "+$TAG_REF:$TAG_REF"
  RELEASE_SHA=$(git rev-parse "$TAG_REF^{commit}")
  validate_existing_release "$RELEASE_SHA"
elif [[ "$REMOTE_MAIN" == "$BASE_SHA" ]]; then
  if RELEASE_SHA=$(create_release); then
    :
  else
    status=$?
    [[ $status -eq 10 ]] && exit 0
    exit "$status"
  fi
else
  echo "::notice::main advanced from tested commit $BASE_SHA to $REMOTE_MAIN; no version or tag was written."
  exit 0
fi

dispatch_release
