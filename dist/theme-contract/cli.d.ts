#!/usr/bin/env node
/**
 * agent-app-theme-check — CI guard against the invisible-surface incident class.
 *
 * A consumer app runs this over its own source; it fails (exit 1) when a
 * component references a theme token — `var(--popover)` or a preset-mapped
 * utility like `bg-surface-container-high` — that the app's shipped CSS never
 * defines, which would paint that surface transparent with no error at runtime.
 *
 *   agent-app-theme-check --src src --src packages/ui/src \
 *     --extra-css src/app-tokens.css
 *
 * Flags (all repeatable except --tokens):
 *   --src <dir>         source dir to scan for token references (required, 1+)
 *   --extra-css <file>  extra CSS whose --name: definitions also count as defined
 *   --tokens <file>     override the base tokens.css (defaults to the one
 *                       agent-app ships as `@tangle-network/agent-app/styles`)
 *   --allow <--var>     suppress a token name from the missing report
 *
 * Wire it as a CI step: `"theme-check": "agent-app-theme-check --src src"`.
 */
export {};
