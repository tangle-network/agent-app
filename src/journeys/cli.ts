#!/usr/bin/env node
/**
 * `agent-app-journeys` — record real-user journeys through an agent app and
 * turn them into files a reviewer can watch.
 *
 * Runs in the app's repository, which holds `journeys.config.mjs` (see
 * docs/journeys.md). Credentials arrive as environment variables named by the
 * config; this command never prints a value.
 *
 *   agent-app-journeys run <journey.ts> [args…]       run one journey script
 *   agent-app-journeys env-names                       credential variable names the config needs
 *   agent-app-journeys signin <identity>               sign in over HTTP and cache the session
 *   agent-app-journeys frames <journey> <label> [s…]   PNG frames from a full video (default: one per chapter)
 *   agent-app-journeys rebuild <journey> <label>       re-render videos after editing chapters
 *   agent-app-journeys scrub <journey>                 re-scrub raw traces and re-check for secrets
 *   agent-app-journeys index <folder> [--critic <file>] [--title <text>] [--out <file>]
 *                                                      write INDEX.md: highlights, scorecard, ranked fixes, turns, videos
 *   agent-app-journeys scoreboard <summary.json> --app <app> [--versions <file>] [--out <file>] [--legacy-ids]
 *                                                      the shared readiness board's writes for one run (JSON batch)
 *
 * Exits 0 on success, 1 on a failed run or a refused folder, 2 on a usage error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { invokedAsScript } from '../signoff/invoked-as-script.js'
import { credentialNames, loadJourneysConfig, type ResolvedJourneysConfig } from './config.js'
import { collectJourneyFiles, renderIndex, type CriticResult } from './report.js'
import { scoreboardRows, type JourneySummary } from './scoreboard.js'
import { assertNoSecrets, scrubTrace } from './scrub.js'
import { secretNeedles, storageStateFor } from './session.js'
import { extractFrames, probeSeconds, rebuildVideo } from './video.js'

const USAGE = [
  'usage: agent-app-journeys run <journey.ts> [args…]',
  '       agent-app-journeys env-names',
  '       agent-app-journeys signin <identity>',
  '       agent-app-journeys frames <journey> <label> [seconds…]',
  '       agent-app-journeys rebuild <journey> <label>',
  '       agent-app-journeys scrub <journey>',
  '       agent-app-journeys index <folder> [--critic <file>] [--title <text>] [--out <file>]',
  '       agent-app-journeys scoreboard <summary.json> --app <app> [--versions <file>] [--out <file>] [--legacy-ids]',
].join('\n')

class UsageError extends Error {}

function missingCredentials(config: ResolvedJourneysConfig): string[] {
  return credentialNames(config).filter((name) => !process.env[name]?.trim())
}

/** The journey's output folder: a path, or an id under the config's outDir. */
function journeyDir(config: ResolvedJourneysConfig, journey: string): string {
  if (isAbsolute(journey) || existsSync(journey)) return resolve(journey)
  return join(config.outDir, journey)
}

/** Newest raw recording folder for a journey id. */
function newestRaw(config: ResolvedJourneysConfig, id: string): string {
  const root = join(config.stateDir, 'raw')
  const runs = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith(`${id}-2`)).map((d) => join(root, d)) : []
  const newest = runs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (!newest) throw new UsageError(`no raw recording for ${id} under ${root}`)
  return newest
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const value = args[i + 1]
  if (!value || value.startsWith('--')) throw new UsageError(`${name} needs a value`)
  args.splice(i, 2)
  return value
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  const args = [...rest]
  switch (command) {
    case 'run': {
      const [script, ...scriptArgs] = args
      if (!script) throw new UsageError('run needs a journey script')
      const config = await loadJourneysConfig()
      const missing = missingCredentials(config)
      if (missing.length) {
        console.error(`agent-app-journeys: ${missing.join(', ')} unset; load them from the host's vault into this process first`)
        return 2
      }
      const run = spawnSync(process.execPath, [resolve(script), ...scriptArgs], { stdio: 'inherit' })
      return run.status ?? 1
    }
    case 'env-names': {
      const config = await loadJourneysConfig()
      console.log(credentialNames(config).join('\n'))
      return 0
    }
    case 'signin': {
      const [identity] = args
      if (!identity) throw new UsageError('signin needs an identity name from the config')
      const config = await loadJourneysConfig()
      const { user } = await storageStateFor(config, identity)
      console.log(`${identity}: signed in as user ${user.id}${user.emailVerified ? ', email verified' : ', email NOT verified'}`)
      return 0
    }
    case 'frames': {
      const [journey, label, ...times] = args
      if (!journey || !label) throw new UsageError('frames needs a journey and a context label')
      const config = await loadJourneysConfig()
      const dir = journeyDir(config, journey)
      console.log(extractFrames(join(dir, 'video', `${label}-full.mp4`), join(dir, 'video', `${label}.srt`), dir, times.map(Number)).join('\n'))
      return 0
    }
    case 'rebuild': {
      const [journey, label] = args
      if (!journey || !label) throw new UsageError('rebuild needs a journey id and a context label')
      const config = await loadJourneysConfig()
      const dir = journeyDir(config, journey)
      const raw = join(newestRaw(config, journey), label)
      rebuildVideo(raw, join(dir, 'video'), label, existsSync(join(dir, 'video', `${label}-x2.mp4`)))
      return 0
    }
    case 'scrub': {
      const [journey] = args
      if (!journey) throw new UsageError('scrub needs a journey id')
      const config = await loadJourneysConfig()
      const dir = journeyDir(config, journey)
      const run = newestRaw(config, journey)
      const needles = secretNeedles(config)
      for (const label of readdirSync(run)) {
        const raw = join(run, label, 'trace.raw.zip')
        if (existsSync(raw)) scrubTrace(raw, join(dir, 'video', `${label}-trace.zip`), [...needles.hard, ...needles.soft])
      }
      assertNoSecrets(dir, needles)
      console.log(`clean: ${dir}`)
      return 0
    }
    case 'index': {
      const out = option(args, '--out')
      const criticFile = option(args, '--critic')
      const title = option(args, '--title')
      const [folder] = args
      if (!folder) throw new UsageError('index needs the folder that holds the journeys')
      const root = resolve(folder)
      const critic = criticFile ? (JSON.parse(readFileSync(resolve(criticFile), 'utf8')) as CriticResult) : undefined
      const probe = (file: string) => {
        try {
          return probeSeconds(file)
        } catch {
          return null
        }
      }
      const markdown = renderIndex({ title: title ?? 'Recorded journeys: what to watch', critic, journeys: collectJourneyFiles(root, probe) })
      const target = out ? resolve(out) : join(root, 'INDEX.md')
      writeFileSync(target, markdown)
      console.log(target)
      return 0
    }
    case 'scoreboard': {
      const app = option(args, '--app')
      const versionsFile = option(args, '--versions')
      const out = option(args, '--out')
      const legacyAt = args.indexOf('--legacy-ids')
      const legacyIds = legacyAt >= 0
      if (legacyIds) args.splice(legacyAt, 1)
      const [summaryFile] = args
      if (!summaryFile || !app) throw new UsageError('scoreboard needs a summary.json and --app <app>')
      const summary = JSON.parse(readFileSync(resolve(summaryFile), 'utf8')) as JourneySummary
      // `versions` maps `collection/docId` to the version a read of the board's store returned.
      const versions = versionsFile ? (JSON.parse(readFileSync(resolve(versionsFile), 'utf8')) as Record<string, number>) : undefined
      let result
      try {
        result = scoreboardRows(summary, { app, legacyIds, ...(versions ? { versions } : {}) })
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error))
      }
      for (const warning of result.warnings) console.error(`scoreboard: ${warning}`)
      const json = JSON.stringify(result.writes, null, 2) + '\n'
      if (out) { writeFileSync(resolve(out), json); console.log(resolve(out)) } else process.stdout.write(json)
      return 0
    }
    case undefined:
    case '--help':
    case '-h':
      console.log(USAGE)
      return command === undefined ? 2 : 0
    default:
      throw new UsageError(`unknown command ${command}`)
  }
}

if (invokedAsScript(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof UsageError) {
        console.error(`agent-app-journeys: ${error.message}\n${USAGE}`)
        process.exit(2)
      }
      console.error(`agent-app-journeys: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    },
  )
}
