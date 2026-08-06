import { existsSync } from 'node:fs'
import type { StorybookConfig } from '@storybook/react-vite'

/*
 * TEMP until @tangle-network/brand ships `[data-theme="tangle-dark"]` (its PR
 * lands after 1.1.0): resolve named-themes.css from the LOCAL brand checkout
 * where the sibling tangle-dark PR is being written, so this Storybook picks
 * the scope up the moment it lands there instead of waiting for the release +
 * version bump. The published package has every other named theme already.
 *
 * The path is the brand repo's `feat/tangle-dark-theme` worktree — the main
 * /home/drew/code/brand checkout is on an older branch whose tree predates
 * named-themes.css entirely. Absolute and machine-local by necessity, so the
 * alias is skipped (and the published package resolves) anywhere the file is
 * absent — CI, other machines. Delete this whole block on the brand bump;
 * brand-themes.css's tangle-dark fallbacks document the pairing.
 */
const LOCAL_BRAND_NAMED_THEMES =
  '/home/drew/code/.worktrees/brand-tangle-dark-theme/packages/brand/src/styles/named-themes.css'

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: (viteConfig) => {
    if (existsSync(LOCAL_BRAND_NAMED_THEMES)) {
      viteConfig.resolve ??= {}
      viteConfig.resolve.alias = {
        ...viteConfig.resolve.alias,
        '@tangle-network/brand/styles/named-themes.css': LOCAL_BRAND_NAMED_THEMES,
      }
    }
    return viteConfig
  },
}

export default config
