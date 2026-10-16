#!/usr/bin/env bash
set -euo pipefail
proof_dir=/home/drew/.local/state/agent-work/agent-app/dedupe-10198
export PROOF_RUN_DIR="$proof_dir/runs/$(git rev-parse HEAD)"
mkdir -p "$PROOF_RUN_DIR"
printf '%s\n' "$PROOF_RUN_DIR" > "$proof_dir/latest-run.txt"
printf 'Proof run: %s\n' "$PROOF_RUN_DIR"
pnpm typecheck
paths=(src/web-react/action-dialog.tsx src/web-react/api-access-panel.tsx src/web-react/async/async-view.tsx src/web-react/agent-profile-form-kit.tsx src/web-react/record-grid.tsx src/web-react/index.tsx src/stories/app-shell/SharedPrimitives.stories.tsx)
restore_sources() { git restore --source=HEAD -- "${paths[@]}"; }
cleanup() {
 if [[ -n ${sb_pid:-} ]]; then kill -- "-$sb_pid" 2>/dev/null || true; fi
 restore_sources
}
trap cleanup EXIT
git restore --source=3fb3521d4d7c15355cb0dca9986e49177e4b77b7 -- "${paths[@]}"
setsid pnpm exec storybook dev --ci --port 6198 --no-open > "$PROOF_RUN_DIR/before-storybook.log" 2>&1 &
sb_pid=$!
node "$proof_dir/capture.mjs" before
kill -- "-$sb_pid" || true
wait "$sb_pid" || true
restore_sources
setsid pnpm exec storybook dev --ci --port 6198 --no-open > "$PROOF_RUN_DIR/after-storybook.log" 2>&1 &
sb_pid=$!
node "$proof_dir/capture.mjs" after
kill -- "-$sb_pid" || true
wait "$sb_pid" || true
git diff --exit-code
