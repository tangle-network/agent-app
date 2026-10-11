/**
 * The one file a reviewer opens: INDEX.md for a folder of recorded journeys.
 *
 * It lists the highlight cuts first, the critic's scorecard, the ranked fix
 * list (verified failures by rank, each with its evidence, fix, number to beat
 * and proving test), every recorded turn with its scored outcome, every video,
 * and what stayed unproven. The renderer is pure; `collectJourneyFiles` reads
 * the folder.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { TurnRecord } from './journey.js'

/** What the skeptical critic returns; the same shape the prove-journeys workflow asks for. */
export interface CriticResult {
  headline: string
  scorecard?: { journey: string; verifiedVerdict: string; keyTiming?: string; qualityGrade?: string; topIssue: string; video?: string }[]
  verifiedFailures?: {
    rank: number
    severity: string
    what: string
    journeys?: string[]
    evidence: string
    likelyCause?: string
    fix: string
    numberToBeat: string
    test: string
  }[]
  refutedOrUnproven?: string[]
  coverageGaps?: string[]
}

export interface JourneyFiles {
  /** Folder relative to the index root, e.g. `j1-new-customer` or `j1-new-customer/r2`. */
  dir: string
  videos: { file: string; seconds: number | null }[]
  turns: Pick<TurnRecord, 'label' | 'outcome' | 'firstTextS' | 'completeS' | 'replyChars' | 'error' | 'sentAt'>[]
}

export interface IndexInput {
  title: string
  critic?: CriticResult
  journeys: JourneyFiles[]
}

const seconds = (s: number | null) => (s === null ? '?' : `${Math.round(s).toLocaleString('en-US')} s`)
const cell = (text: string | number | null | undefined) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
const firstLine = (text: string) => text.split('\n')[0]!.trim()

function videoLabel(file: string): { base: string; kind: string } {
  const name = file.split('/').pop() ?? file
  const m = /^(.*)-(highlights|full|x2)\.mp4$/.exec(name)
  return m ? { base: m[1]!, kind: m[2]! } : { base: name.replace(/\.mp4$/, ''), kind: 'other' }
}

/** Every recorded turn's outcome, counted. The denominator is every turn in the folder's timings.json files. */
export function tallyTurns(journeys: readonly JourneyFiles[]): { total: number; byOutcome: Record<string, number> } {
  const byOutcome: Record<string, number> = {}
  let total = 0
  for (const j of journeys) {
    for (const t of j.turns) {
      total += 1
      byOutcome[t.outcome] = (byOutcome[t.outcome] ?? 0) + 1
    }
  }
  return { total, byOutcome }
}

export function renderIndex(input: IndexInput): string {
  const out: string[] = [`# ${input.title}`, '']
  const { critic } = input
  const tally = tallyTurns(input.journeys)
  if (critic?.headline) out.push(`**Result.** ${critic.headline}`, '')
  if (tally.total) {
    const parts = Object.entries(tally.byOutcome).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`)
    out.push(`**Turns, as scored by the recorder:** ${parts.join(', ')}, of ${tally.total} recorded turns (source: each journey's timings.json).`, '')
  }

  const all = input.journeys.flatMap((j) => j.videos.map((v) => ({ ...v, dir: j.dir, path: j.dir ? `${j.dir}/${v.file}` : v.file })))
  const highlights = all.filter((v) => videoLabel(v.file).kind === 'highlights')
  const scoreVideos = (critic?.scorecard ?? []).map((s) => s.video ?? '').filter(Boolean)
  const rankOf = (path: string) => {
    const i = scoreVideos.findIndex((v) => v.endsWith(path))
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  highlights.sort((a, b) => rankOf(a.path) - rankOf(b.path) || a.path.localeCompare(b.path))
  if (highlights.length) {
    out.push('## Start here: highlights, at most 3 minutes each', '')
    highlights.forEach((v, i) => {
      const card = critic?.scorecard?.find((s) => s.video?.endsWith(v.path))
      out.push(`${i + 1}. \`${v.path}\` (${seconds(v.seconds)})${card ? `. ${card.journey}: ${firstLine(card.topIssue)}` : ''}`)
    })
    out.push('')
  }

  if (critic?.scorecard?.length) {
    out.push('## Scorecard', '', '| Journey | Verdict | Key timing | Output | Top issue |', '|---|---|---|---|---|')
    for (const s of critic.scorecard) out.push(`| ${cell(s.journey)} | ${cell(s.verifiedVerdict)} | ${cell(s.keyTiming)} | ${cell(s.qualityGrade)} | ${cell(s.topIssue)} |`)
    out.push('')
  }

  const fixes = [...(critic?.verifiedFailures ?? [])].sort((a, b) => a.rank - b.rank)
  if (fixes.length) {
    out.push('## Ranked fixes (verified failures, customer impact first)', '')
    for (const f of fixes) {
      out.push(`${f.rank}. **${firstLine(f.what)}** (${f.severity}${f.journeys?.length ? `; ${f.journeys.join(', ')}` : ''})`)
      const rest = f.what.split('\n').slice(1).join(' ').trim()
      if (rest) out.push(`   ${rest}`)
      out.push(`   - Evidence: ${cell(f.evidence)}`)
      if (f.likelyCause) out.push(`   - Likely cause: ${cell(f.likelyCause)}`)
      out.push(`   - Fix: ${cell(f.fix)}`, `   - Number to beat: ${cell(f.numberToBeat)}`, `   - Proving test: ${cell(f.test)}`)
    }
    out.push('')
  }

  const turns = input.journeys.flatMap((j) => j.turns.map((t) => ({ ...t, dir: j.dir })))
  if (turns.length) {
    out.push('## Every recorded turn', '', '| Journey | Context | Sent | Outcome | First text | End | Reply chars | What went wrong |', '|---|---|---|---|---|---|---|---|')
    for (const t of turns) {
      out.push(`| ${cell(t.dir || '.')} | ${cell(t.label)} | ${cell(t.sentAt.slice(11, 19))}Z | ${cell(t.outcome)} | ${seconds(t.firstTextS)} | ${seconds(t.completeS)} | ${t.replyChars.toLocaleString('en-US')} | ${cell(t.error ?? '')} |`)
    }
    out.push('')
  }

  if (all.length) {
    out.push('## Every video', '')
    const dirs = [...new Set(all.map((v) => v.dir))]
    for (const dir of dirs) {
      out.push(`### \`${dir || '.'}\``, '')
      const byBase = new Map<string, typeof all>()
      for (const v of all.filter((x) => x.dir === dir)) {
        const { base } = videoLabel(v.file)
        byBase.set(base, [...(byBase.get(base) ?? []), v])
      }
      for (const [base, vids] of byBase) {
        const order = ['highlights', 'full', 'x2', 'other']
        vids.sort((a, b) => order.indexOf(videoLabel(a.file).kind) - order.indexOf(videoLabel(b.file).kind))
        out.push(`- ${base}: ${vids.map((v) => `\`${v.file}\` (${seconds(v.seconds)})`).join(', ')}`)
      }
      out.push('')
    }
  }

  const unproven = [...(critic?.refutedOrUnproven ?? []), ...(critic?.coverageGaps ?? [])]
  if (unproven.length) {
    out.push('## Refuted, unproven and not covered', '')
    for (const u of unproven) out.push(`- ${cell(u)}`)
    out.push('')
  }
  return out.join('\n')
}

/**
 * Every journey folder under `root`: one that holds a `timings.json` or a
 * `video/` folder, at any depth. `probe` returns a video's duration in seconds.
 */
export function collectJourneyFiles(root: string, probe: (file: string) => number | null): JourneyFiles[] {
  const found: JourneyFiles[] = []
  const visit = (dir: string, depth: number) => {
    const timings = join(dir, 'timings.json')
    const videoDir = join(dir, 'video')
    const hasVideo = existsSync(videoDir) && statSync(videoDir).isDirectory()
    if (existsSync(timings) || hasVideo) {
      const videos = hasVideo
        ? readdirSync(videoDir).filter((f) => f.endsWith('.mp4')).sort().map((f) => ({ file: `video/${f}`, seconds: probe(join(videoDir, f)) }))
        : []
      let turns: JourneyFiles['turns'] = []
      if (existsSync(timings)) {
        try {
          turns = ((JSON.parse(readFileSync(timings, 'utf8')) as { turns?: JourneyFiles['turns'] }).turns ?? [])
        } catch {
          turns = []
        }
      }
      found.push({ dir: relative(root, dir), videos, turns })
    }
    if (depth >= 4) return
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      if (name === 'video' || name === 'turns' || name.startsWith('.')) continue
      if (statSync(path).isDirectory()) visit(path, depth + 1)
    }
  }
  visit(root, 0)
  return found
}
