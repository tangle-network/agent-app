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
printf '{"name":"@tangle-network/agent-app","version":"1.2.3"}\n' > "$SEED/package.json"
printf '{"name":"@tangle-network/create-agent-app","version":"1.2.3"}\n' > "$SEED/create-agent-app/package.json"
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
    bash "$SCRIPT"
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

run_release initial >/dev/null
MAIN=$(git --git-dir="$ORIGIN" rev-parse refs/heads/main)
TAG=$(git --git-dir="$ORIGIN" rev-parse refs/tags/v1.2.4)
[[ "$MAIN" == "$TAG" ]]
[[ $(git --git-dir="$ORIGIN" rev-parse "$TAG^") == "$BASE" ]]
[[ $(git --git-dir="$ORIGIN" show "$TAG:package.json" | node -p "JSON.parse(require('fs').readFileSync(0)).version") == 1.2.4 ]]
[[ $(wc -l < "$DISPATCH_LOG") -eq 1 ]]
grep -Fxq '{"ref":"v1.2.4"}' "$DISPATCH_LOG"

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

git -C "$SEED" tag v1.2.5 "$BASE"
git -C "$SEED" push --quiet origin refs/tags/v1.2.5
fails 'is not a one-parent release commit' run_release invalid 1.2.5
[[ $(wc -l < "$DISPATCH_LOG") -eq 3 ]]

run_release advanced-no-tag 1.2.6 > "$TMP/advanced.log"
grep -Fq 'main advanced from tested commit' "$TMP/advanced.log"
[[ $(wc -l < "$DISPATCH_LOG") -eq 3 ]]

echo 'write release script: ok (5 cases)'
