#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == dismiss ]]; then
  proof_dir=/home/drew/.local/state/agent-work/agent-app/dedupe-10198
  source_sha=$(git rev-parse HEAD)
  helper_sha=$(sha256sum "$proof_dir/capture.mjs"); helper_sha=${helper_sha%% *}
  export PROOF_RUN_DIR="$proof_dir/runs/$source_sha/dismiss-${helper_sha:0:12}"
  [[ ! -e "$PROOF_RUN_DIR/dismiss/receipt.json" ]] || { echo 'Refusing to overwrite retained dismiss attempt' >&2; exit 1; }
  mkdir -p "$PROOF_RUN_DIR"
  printf '%s\n' "$source_sha" > "$PROOF_RUN_DIR/source-sha.txt"
  printf '%s\n' "$PROOF_RUN_DIR" > "$proof_dir/latest-dismiss-run.txt"
  cp "$proof_dir/capture.mjs" "$PROOF_RUN_DIR/capture-used.mjs"
  cp "$proof_dir/gate-proof.sh" "$PROOF_RUN_DIR/gate-used.sh"
  node --input-type=module <<'IDENTITY'
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(process.cwd()+'/package.json');
const ui=JSON.parse(readFileSync('node_modules/@tangle-network/ui/package.json','utf8'));
const brand=JSON.parse(readFileSync('node_modules/@tangle-network/brand/package.json','utf8'));
if(ui.version!=='11.38.1'||brand.version!=='1.25.1')throw new Error('Installed cohort differs from checked dismissal release');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const files=Object.fromEntries(['@tangle-network/ui/styles/presentation.css','@tangle-network/brand/styles/presentation.css','@tangle-network/brand/styles/legacy-light.css'].map(id=>[id,{sha256:hash(require.resolve(id))}]));
files.surfaceMotion={sha256:hash('node_modules/@tangle-network/ui/src/lib/surface-motion.tsx')};
const publicStyle=readFileSync('dist/theme/tokens.css','utf8');
for(const name of ['tangle-surface-present','tangle-surface-absent'])if(!publicStyle.includes('@keyframes '+name))throw new Error('Public theme build omitted '+name);
files.publicTheme={sha256:hash('dist/theme/tokens.css'),presenceKeyframes:true};
writeFileSync(process.env.PROOF_RUN_DIR+'/identity.json',JSON.stringify({ui:ui.version,brand:brand.version,files,ownerReleaseSource:'bfd032ec40d578b42bf738b92ffd56df9300968e',target:'Actual agent-app ActionDialog and CommandPalette consumer fixture; no published agent-app proof'},null,2)+'\n');
IDENTITY
  pnpm typecheck
  cleanup_dismiss() { if [[ -n ${sb_pid:-} ]]; then kill -- "-$sb_pid" 2>/dev/null || true; fi; }
  trap cleanup_dismiss EXIT
  setsid pnpm exec storybook dev --ci --port 6198 --no-open > "$PROOF_RUN_DIR/storybook.log" 2>&1 &
  sb_pid=$!
  node "$proof_dir/capture.mjs" dismiss
  git diff --exit-code
  printf 'Dismiss proof run: %s\n' "$PROOF_RUN_DIR"
  exit 0
fi
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
