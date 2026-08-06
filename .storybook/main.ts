import { existsSync } from 'node:fs'
import type { StorybookConfig } from '@storybook/react-vite'

/*
 * TEMP until @tangle-network/brand ships `[data-theme="tangle-dark"]` (its PR
 * lands after 1.1.0): resolve named-themes.css from the LOCAL brand checkout
 * where the sibling tangle-dark PR is being written, so this Storybook picks
 * the scope up across a restart instead of waiting for the release + version
 * bump. The published package has every other named theme already.
 *
 * The path is the brand repo's `feat/tangle-dark-theme` worktree — the main
 * /home/drew/code/brand checkout is on an older branch whose tree predates
 * named-themes.css entirely. Absolute and machine-local by necessity: where
 * the file is absent (CI, other machines) the alias is skipped and the
 * @import falls through to the published package — tangle-dark then degrades
 * to agent-dark via the probe in preview.ts. The existsSync decision runs
 * once at config load, so restart Storybook after checking the worktree out.
 * Delete this whole block on the brand bump.
 */
const LOCAL_BRAND_NAMED_THEMES =
  '/home/drew/code/.worktrees/brand-tangle-dark-theme/packages/brand/src/styles/named-themes.css'
const NAMED_THEMES_ID = '@tangle-network/brand/styles/named-themes.css'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: (viteConfig) => {
    if (!existsSync(LOCAL_BRAND_NAMED_THEMES)) return viteConfig
    console.info(`[storybook] aliasing ${NAMED_THEMES_ID} -> ${LOCAL_BRAND_NAMED_THEMES}`)
    viteConfig.resolve ??= {}
    // resolve.alias is a record OR an { find, replacement }[] list; append in
    // whichever shape is already there — spreading a list into a record would
    // corrupt every existing alias.
    const { alias } = viteConfig.resolve
    viteConfig.resolve.alias = Array.isArray(alias)
      ? [...alias, { find: NAMED_THEMES_ID, replacement: LOCAL_BRAND_NAMED_THEMES }]
      : { ...alias, [NAMED_THEMES_ID]: LOCAL_BRAND_NAMED_THEMES }
    return viteConfig
  },
}

export default config
