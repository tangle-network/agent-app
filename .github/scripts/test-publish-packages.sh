#!/usr/bin/env bash

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/.github/scripts/publish-packages.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state" "$TMP/tarballs"

sri() {
  printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$1" | base64 -w0)"
}

make_tarball() {
  local name=$1 version=$2 output=$3 dir
  dir=$(mktemp -d "$TMP/package.XXXXXX")
  mkdir -p "$dir/package"
  printf '{"name":"%s","version":"%s"}\n' "$name" "$version" > "$dir/package/package.json"
  tar --sort=name --mtime='UTC 1985-10-26' --owner=0 --group=0 -czf "$output" -C "$dir" package
  rm -rf "$dir"
}

cat > "$TMP/bin/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -euo pipefail

key() {
  case "$1" in
    @tangle-network/agent-app@*) echo root ;;
    @tangle-network/create-agent-app@*) echo create ;;
    *) exit 90 ;;
  esac
}
sri() { printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$1" | base64 -w0)"; }

command=$1
shift
if [[ "$command" == view ]]; then
  package=$(key "$1")
  echo "view|$1|${NODE_AUTH_TOKEN:-}|${CREATE_AGENT_APP_NPM_TOKEN:-}" >> "$NPM_LOG"
  [[ ! -f "$NPM_STATE/$package.outage" ]] || { echo 'npm error code EAI_AGAIN' >&2; exit 1; }
  if [[ -f "$NPM_STATE/$package.delay" ]]; then
    remaining=$(< "$NPM_STATE/$package.delay")
    if ((remaining > 0)); then
      printf '%s\n' "$((remaining - 1))" > "$NPM_STATE/$package.delay"
      echo 'npm error code E404' >&2
      exit 1
    fi
  fi
  [[ -f "$NPM_STATE/$package.integrity" ]] || { echo 'npm error code E404' >&2; exit 1; }
  cat "$NPM_STATE/$package.integrity"
  exit
fi

[[ "$command" == publish ]] || exit 91
tarball=$1
read -r name version < <(tar -xOzf "$tarball" package/package.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const p=JSON.parse(s);console.log(p.name,p.version)})")
package=$(key "$name@$version")
printf 'publish|%s@%s|%s|%s|%s|%s\n' "$name" "$version" "$tarball" "${NODE_AUTH_TOKEN:-}" "${CREATE_AGENT_APP_NPM_TOKEN:-}" "$*" >> "$NPM_LOG"
sri "$tarball" > "$NPM_STATE/$package.integrity"
FAKE_NPM
chmod +x "$TMP/bin/npm"

ROOT_TGZ="$TMP/tarballs/agent-app.tgz"
CREATE_TGZ="$TMP/tarballs/create-agent-app.tgz"
make_tarball '@tangle-network/agent-app' 1.2.3 "$ROOT_TGZ"
make_tarball '@tangle-network/create-agent-app' 1.2.3 "$CREATE_TGZ"

run() {
  env -u FORCE_COLOR -u NO_COLOR PATH="$TMP/bin:$PATH" NPM_LOG="$TMP/npm.log" NPM_STATE="$TMP/state" EXPECTED_VERSION=1.2.3 "$@"
}
reset() {
  rm -rf "$TMP/state"
  mkdir -p "$TMP/state"
  : > "$TMP/npm.log"
}
fails() {
  local message=$1
  shift
  if "$@" > "$TMP/failure.log" 2>&1; then
    echo "expected failure: $message" >&2
    exit 1
  fi
  grep -Fq "$message" "$TMP/failure.log" || { cat "$TMP/failure.log" >&2; exit 1; }
}
no_publish() {
  ! grep -q '^publish|' "$TMP/npm.log" || { echo 'unexpected publish call' >&2; exit 1; }
}

reset
run bash "$SCRIPT" validate "$ROOT_TGZ" "$CREATE_TGZ" >/dev/null
[[ ! -s "$TMP/npm.log" ]]

reset
run env NODE_AUTH_TOKEN=ambient-token bash "$SCRIPT" publish agent-app "$ROOT_TGZ" >/dev/null
[[ $(grep -c '^publish|' "$TMP/npm.log") -eq 1 ]]
grep -Fq "publish|@tangle-network/agent-app@1.2.3|$ROOT_TGZ|||" "$TMP/npm.log"
grep '^publish|' "$TMP/npm.log" | grep -Fq -- '--provenance'
grep '^publish|' "$TMP/npm.log" | grep -Fq -- '--ignore-scripts'
grep '^view|' "$TMP/npm.log" | grep -Eq '\|\|$'

reset
printf '2\n' > "$TMP/state/root.delay"
run env REGISTRY_VERIFY_ATTEMPTS=3 REGISTRY_VERIFY_DELAY_SECONDS=0 bash "$SCRIPT" publish agent-app "$ROOT_TGZ" > "$TMP/delayed.log"
[[ $(grep -c '^publish|' "$TMP/npm.log") -eq 1 ]]
[[ $(grep -c '^view|' "$TMP/npm.log") -eq 3 ]]
grep -Fq '@tangle-network/agent-app@1.2.3 published and confirmed' "$TMP/delayed.log"

reset
printf '10\n' > "$TMP/state/root.delay"
fails 'not visible after 2 registry checks' run env REGISTRY_VERIFY_ATTEMPTS=2 REGISTRY_VERIFY_DELAY_SECONDS=0 bash "$SCRIPT" publish agent-app "$ROOT_TGZ"
[[ $(grep -c '^publish|' "$TMP/npm.log") -eq 1 ]]

reset
run env CREATE_AGENT_APP_NPM_TOKEN=scaffold-token bash "$SCRIPT" publish create-agent-app "$CREATE_TGZ" >/dev/null
[[ $(grep -c '^publish|' "$TMP/npm.log") -eq 1 ]]
grep -Fq "publish|@tangle-network/create-agent-app@1.2.3|$CREATE_TGZ|scaffold-token||" "$TMP/npm.log"
grep '^publish|' "$TMP/npm.log" | grep -Fq -- '--provenance'
grep '^publish|' "$TMP/npm.log" | grep -Fq -- '--ignore-scripts'
grep '^view|' "$TMP/npm.log" | grep -Eq '\|\|$'

reset
sri "$ROOT_TGZ" > "$TMP/state/root.integrity"
sri "$CREATE_TGZ" > "$TMP/state/create.integrity"
run bash "$SCRIPT" publish agent-app "$ROOT_TGZ" > "$TMP/rerun.log"
run env CREATE_AGENT_APP_NPM_TOKEN=scaffold-token bash "$SCRIPT" publish create-agent-app "$CREATE_TGZ" >> "$TMP/rerun.log"
no_publish
[[ $(grep -c 'already on registry; skipping publish' "$TMP/rerun.log") -eq 2 ]]

reset
sri "$ROOT_TGZ" > "$TMP/state/root.integrity"
run env CREATE_AGENT_APP_NPM_TOKEN=scaffold-token bash "$SCRIPT" publish create-agent-app "$CREATE_TGZ" >/dev/null
[[ $(grep -c '^publish|' "$TMP/npm.log") -eq 1 ]]
grep -Fq 'publish|@tangle-network/create-agent-app@1.2.3' "$TMP/npm.log"

reset
sri "$CREATE_TGZ" > "$TMP/state/create.integrity"
run bash "$SCRIPT" publish agent-app "$ROOT_TGZ" >/dev/null
[[ $(grep -c '^publish|' "$TMP/npm.log") -eq 1 ]]
grep -Fq 'publish|@tangle-network/agent-app@1.2.3' "$TMP/npm.log"

BAD_VERSION="$TMP/tarballs/create-1.2.4.tgz"
make_tarball '@tangle-network/create-agent-app' 1.2.4 "$BAD_VERSION"
reset
fails 'version mismatch' run bash "$SCRIPT" validate "$ROOT_TGZ" "$BAD_VERSION"
no_publish

BAD_NAME="$TMP/tarballs/wrong-name.tgz"
make_tarball '@tangle-network/wrong' 1.2.3 "$BAD_NAME"
fails 'package name mismatch' run bash "$SCRIPT" publish agent-app "$BAD_NAME"

printf 'not a tarball\n' > "$TMP/tarballs/malformed.tgz"
fails 'malformed tarball' run bash "$SCRIPT" publish agent-app "$TMP/tarballs/malformed.tgz"

reset
touch "$TMP/state/root.outage"
fails 'registry lookup failed' run bash "$SCRIPT" publish agent-app "$ROOT_TGZ"
no_publish

reset
printf 'sha512-YWJj' > "$TMP/state/root.integrity"
fails 'registry tarball mismatch' run bash "$SCRIPT" publish agent-app "$ROOT_TGZ"
no_publish

reset
fails 'CREATE_AGENT_APP_NPM_TOKEN is required' run bash "$SCRIPT" publish create-agent-app "$CREATE_TGZ"
no_publish

reset
fails 'must not be exposed' run env CREATE_AGENT_APP_NPM_TOKEN=wrong-job bash "$SCRIPT" publish agent-app "$ROOT_TGZ"
no_publish

echo 'publish package script: ok (15 cases)'
