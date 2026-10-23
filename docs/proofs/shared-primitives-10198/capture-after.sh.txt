#!/usr/bin/env bash
set -euo pipefail
proof_dir=/home/drew/.local/state/agent-work/agent-app/dedupe-10198
source_sha=$(git rev-parse HEAD)
helper_sha=$(sha256sum "$proof_dir/capture.mjs")
helper_sha=${helper_sha%% *}
export PROOF_RUN_DIR="$proof_dir/runs/$source_sha/geometry-${helper_sha:0:12}"
[[ ! -e "$PROOF_RUN_DIR/after/receipt.json" ]] || { echo 'Refusing to overwrite retained attempt' >&2; exit 1; }
mkdir -p "$PROOF_RUN_DIR"
cp -a "$proof_dir/runs/de38bbc50b93167e1f35c479db058102cdb9db79/before" "$PROOF_RUN_DIR/before"
cat > "$PROOF_RUN_DIR/before-provenance.json" <<'JSON'
{"gate":"beelink1-d99b99491d1d43913a8d93b2bc23958b","source":"de38bbc50b93167e1f35c479db058102cdb9db79","rendererFixture":"3fb3521d4d7c15355cb0dca9986e49177e4b77b7","helperSha256":"4e9b9686caec11d05e5c7a4712ebade51c15c45da5a0fedf8ac1fbb6d11521a9","result":"4 normal baseline cases PASS","reuseReason":"Source, installed cohort, viewport/theme and baseline fixture unchanged; reduced-check correction applies only to after phase. Originals copied unchanged, failed after attempt retained separately."}
JSON
printf '%s\n' "$source_sha" > "$PROOF_RUN_DIR/source-sha.txt"
printf '%s\n' "$PROOF_RUN_DIR" > "$proof_dir/latest-run.txt"
printf 'Proof run: %s\n' "$PROOF_RUN_DIR"
cp "$proof_dir/capture.mjs" "$PROOF_RUN_DIR/capture-used.mjs"
cleanup() { if [[ -n ${sb_pid:-} ]]; then kill -- "-$sb_pid" 2>/dev/null || true; fi; }
trap cleanup EXIT
setsid pnpm exec storybook dev --ci --port 6198 --no-open > "$PROOF_RUN_DIR/after-storybook.log" 2>&1 &
sb_pid=$!
node "$proof_dir/capture.mjs" after
kill -- "-$sb_pid" || true
wait "$sb_pid" || true
git diff --exit-code
