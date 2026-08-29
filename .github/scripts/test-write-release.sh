#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/.github/scripts/write-release.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ORIGIN="$TMP/origin.git"
SEED="$TMP/seed"
mkdir -p "$TMP/bin" "$TMP/empty-hooks"

cat > "$TMP/bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
output=''
payload=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --data) payload=$2; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$output" ]]
: > "$output"
printf '%s\n' "$payload" >> "$DISPATCH_LOG"
printf '204'
FAKE_CURL
chmod +x "$TMP/bin/curl"

git init --bare --quiet "$ORIGIN"
git init --quiet "$SEED"
git -C "$SEED" config core.hooksPath "$TMP/empty-hooks"
git -C "$SEED" config user.name test
git -C "$SEED" config user.email test@example.com
mkdir -p "$SEED/create-agent-app"
printf '{"name":"@tangle-network/agent-app","version":"1.2.3","description":"app"}\n' > "$SEED/package.json"
printf '{"name":"@tangle-network/create-agent-app","version":"1.2.3","description":"create"}\n' > "$SEED/create-agent-app/package.json"
git -C "$SEED" add package.json create-agent-app/package.json
git -C "$SEED" commit --quiet -m base
git -C "$SEED" branch -M main
git -C "$SEED" remote add origin "$ORIGIN"
git -C "$SEED" push --quiet origin main
BASE=$(git -C "$SEED" rev-parse HEAD)
DISPATCH_LOG="$TMP/dispatch.log"
export DISPATCH_LOG

run_release() {
  local name=$1 git_dir="$TMP/$1.git"
  git init --bare --quiet "$git_dir"
  git --git-dir="$git_dir" config core.hooksPath "$TMP/empty-hooks"
  git --git-dir="$git_dir" remote add origin "$ORIGIN"
  env \
    PATH="$TMP/bin:$PATH" \
    RUNNER_TEMP="$TMP" \
    GIT_DIR="$git_dir" \
    GIT_INDEX_FILE="$TMP/$name.index" \
    BASE_SHA="$BASE" \
    VERSION="${2:-1.2.4}" \
    GITHUB_REPOSITORY='owner/repo' \
    GITHUB_TOKEN='test-token' \
    GITHUB_API_URL='https://api.example.test' \
    SOURCE_RUN_ID='123' \
    SOURCE_ARTIFACT_ID='456' \
    SOURCE_ARTIFACT_DIGEST='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    SOURCE_SHA="$BASE" \
    bash "$SCRIPT"
}

run_validate() {
  local name=$1 version=$2 release_sha=$3 git_dir="$TMP/$1.git"
  git init --bare --quiet "$git_dir"
  git --git-dir="$git_dir" config core.hooksPath "$TMP/empty-hooks"
  git --git-dir="$git_dir" remote add origin "$ORIGIN"
  git --git-dir="$git_dir" fetch --quiet --no-tags origin +refs/heads/main:refs/remotes/origin/main
  env \
    RUNNER_TEMP="$TMP" \
    GIT_DIR="$git_dir" \
    BASE_SHA="$BASE" \
    VERSION="$version" \
    RELEASE_SHA="$release_sha" \
    bash "$SCRIPT" validate
}

run_prepare() {
  local work="$TMP/prepare"
  git clone --quiet "$ORIGIN" "$work"
  git -C "$work" config core.hooksPath "$TMP/empty-hooks"
  git -C "$work" checkout --quiet --detach "$BASE"
  (
    cd "$work"
    BASE_SHA="$BASE" VERSION='1.2.4' bash "$SCRIPT" prepare >/dev/null
  )
  mapfile -t changed < <(git -C "$work" diff --name-only | LC_ALL=C sort)
  [[ ${#changed[@]} -eq 2 && "${changed[0]}" == 'create-agent-app/package.json' && "${changed[1]}" == 'package.json' ]]
  [[ $(node -p "require('$work/package.json').version") == 1.2.4 ]]
  [[ $(node -p "require('$work/create-agent-app/package.json').version") == 1.2.4 ]]
  git -C "$work" restore package.json create-agent-app/package.json
  printf 'unexpected\n' > "$work/unexpected.txt"
  git -C "$work" add unexpected.txt
  if (
    cd "$work"
    BASE_SHA="$BASE" VERSION='1.2.4' bash "$SCRIPT" prepare
  ) > "$TMP/prepare-dirty.log" 2>&1; then
    echo 'expected staged changes to block release preparation' >&2
    exit 1
  fi
  grep -Fq 'tracked changes before release preparation' "$TMP/prepare-dirty.log"
}

forge_release() {
  local name=$1 mutation=$2 work="$TMP/forge-$1"
  git clone --quiet --no-checkout "$ORIGIN" "$work"
  git -C "$work" config core.hooksPath "$TMP/empty-hooks"
  git -C "$work" config user.name test
  git -C "$work" config user.email test@example.com
  git -C "$work" checkout --quiet --detach "$BASE"
  MUTATION="$mutation" node - "$work/package.json" "$work/create-agent-app/package.json" <<'NODE'
const fs = require('node:fs')
const [rootFile, createFile] = process.argv.slice(2)
const root = JSON.parse(fs.readFileSync(rootFile, 'utf8'))
const create = JSON.parse(fs.readFileSync(createFile, 'utf8'))
root.version = '1.2.4'
create.version = '1.2.4'
if (process.env.MUTATION === 'extra') root.files = ['internal-release-data']
if (process.env.MUTATION === 'remove') delete root.description
if (process.env.MUTATION === 'modify') create.description = 'redirected package'
fs.writeFileSync(rootFile, `${JSON.stringify(root, null, 2)}\n`)
fs.writeFileSync(createFile, `${JSON.stringify(create, null, 2)}\n`)
NODE
  git -C "$work" add package.json create-agent-app/package.json
  git -C "$work" commit --quiet -m 'chore(release): 1.2.4 [skip release]'
  local forged
  forged=$(git -C "$work" rev-parse HEAD)
  git --git-dir="$ORIGIN" fetch --quiet "$work" "$forged"
  git --git-dir="$ORIGIN" update-ref refs/heads/main "$forged"
  git --git-dir="$ORIGIN" update-ref refs/tags/v1.2.4 "$forged"
  printf '%s' "$forged"
}

fails() {
  local expected=$1
  shift
  if "$@" > "$TMP/failure.log" 2>&1; then
    echo "expected failure: $expected" >&2
    exit 1
  fi
  grep -Fq "$expected" "$TMP/failure.log" || { cat "$TMP/failure.log" >&2; exit 1; }
}

run_source_failure() {
  local name=$1 expected=$2 git_dir="$TMP/source-$1.git"
  shift 2
  git init --bare --quiet "$git_dir"
  fails "$expected" env \
    PATH="$TMP/bin:$PATH" \
    RUNNER_TEMP="$TMP" \
    GIT_DIR="$git_dir" \
    GIT_INDEX_FILE="$TMP/source-$name.index" \
    BASE_SHA="$BASE" \
    VERSION='1.2.4' \
    GITHUB_REPOSITORY='owner/repo' \
    GITHUB_TOKEN='test-token' \
    SOURCE_RUN_ID='123' \
    SOURCE_ARTIFACT_ID='456' \
    SOURCE_ARTIFACT_DIGEST='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
    SOURCE_SHA="$BASE" \
    "$@" \
    bash "$SCRIPT"
}

run_source_failure run-id 'SOURCE_RUN_ID must be a positive integer' SOURCE_RUN_ID='0'
run_source_failure artifact-id 'SOURCE_ARTIFACT_ID must be a positive integer' SOURCE_ARTIFACT_ID='../456'
run_source_failure digest 'SOURCE_ARTIFACT_DIGEST must be a SHA-256 digest' SOURCE_ARTIFACT_DIGEST='sha256:nope'
run_source_failure source-sha 'SOURCE_SHA must match BASE_SHA' SOURCE_SHA='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
run_prepare
run_release initial >/dev/null
MAIN=$(git --git-dir="$ORIGIN" rev-parse refs/heads/main)
TAG=$(git --git-dir="$ORIGIN" rev-parse refs/tags/v1.2.4)
[[ "$MAIN" == "$TAG" ]]
[[ $(git --git-dir="$ORIGIN" rev-parse "$TAG^") == "$BASE" ]]
[[ $(git --git-dir="$ORIGIN" show "$TAG:package.json" | node -p "JSON.parse(require('fs').readFileSync(0)).version") == 1.2.4 ]]
[[ $(wc -l < "$DISPATCH_LOG") -eq 1 ]]
grep -Fxq "{\"ref\":\"v1.2.4\",\"inputs\":{\"source_run_id\":\"123\",\"source_artifact_id\":\"456\",\"source_artifact_digest\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"source_sha\":\"$BASE\"}}" "$DISPATCH_LOG"

run_release rerun >/dev/null
[[ $(git --git-dir="$ORIGIN" rev-parse refs/heads/main) == "$TAG" ]]
[[ $(wc -l < "$DISPATCH_LOG") -eq 2 ]]

ADVANCE="$TMP/advance"
git clone --quiet --branch main "$ORIGIN" "$ADVANCE"
git -C "$ADVANCE" config core.hooksPath "$TMP/empty-hooks"
git -C "$ADVANCE" config user.name test
git -C "$ADVANCE" config user.email test@example.com
printf 'advanced\n' > "$ADVANCE/advanced.txt"
git -C "$ADVANCE" add advanced.txt
git -C "$ADVANCE" commit --quiet -m advanced
git -C "$ADVANCE" push --quiet origin main
run_release ancestor >/dev/null
[[ $(wc -l < "$DISPATCH_LOG") -eq 3 ]]
run_validate direct-valid 1.2.4 "$TAG" >/dev/null

git -C "$SEED" tag v1.2.5 "$BASE"
git -C "$SEED" push --quiet origin refs/tags/v1.2.5
fails 'is not a one-parent release commit' run_release invalid 1.2.5
[[ $(wc -l < "$DISPATCH_LOG") -eq 3 ]]

FORGED_EXTRA=$(forge_release extra extra)
fails 'does not exactly match' run_validate validate-extra 1.2.4 "$FORGED_EXTRA"
fails 'does not exactly match' run_release release-extra 1.2.4
[[ $(wc -l < "$DISPATCH_LOG") -eq 3 ]]

FORGED_REMOVE=$(forge_release remove remove)
fails 'does not exactly match' run_validate validate-remove 1.2.4 "$FORGED_REMOVE"
[[ $(wc -l < "$DISPATCH_LOG") -eq 3 ]]

FORGED_MODIFY=$(forge_release modify modify)
fails 'does not exactly match' run_validate validate-modify 1.2.4 "$FORGED_MODIFY"
[[ $(wc -l < "$DISPATCH_LOG") -eq 3 ]]

run_release advanced-no-tag 1.2.6 > "$TMP/advanced.log"
grep -Fq 'main advanced from tested commit' "$TMP/advanced.log"
[[ $(wc -l < "$DISPATCH_LOG") -eq 3 ]]

echo 'write release script: ok (16 cases)'
