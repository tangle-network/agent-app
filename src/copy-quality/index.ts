/**
 * `@tangle-network/agent-app/copy-quality` — deterministic checks for copy an
 * agent writes for a reader: ads, posts, subject lines, emails, landing pages.
 *
 * No model call. A scan returns findings an agent can fix before a person sees
 * the draft, and the same findings feed a product's outcome checks, so the
 * in-run feedback and the scored episode never disagree.
 *
 * Tiers follow the "AI tells" list in coreyhaines31/marketingskills (MIT,
 * revision f719a8079c694e3267d47b6b60a62aa926055f2c,
 * skills/copywriting/references/ai-tells.md):
 *   - ban: a tell on one sighting.
 *   - cap: fine once; a tell when two land in one paragraph.
 *   - weak: reported, never failing on its own.
 * Weighting follows blader/humanizer (MIT, revision
 * 225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8): staged contrasts, negation lists
 * and staged reveals count on one sighting; a dash or a curly quote in long
 * copy is weak alone. The density score mirrors the EQ-Bench Slop Score mix:
 * 60% tell-word rate, 25% contrast constructions, 15% repeated trigrams.
 *
 * Code blocks, inline code and URLs are removed before scanning: an SDK
 * snippet in a post is the product, not prose.
 */

import { canonicalizeValue, valuesInText } from '../work-product/claim-support'

export type CopySurface = 'short' | 'long'

export type CopyTellTier = 'ban' | 'cap' | 'weak'

export type CopyTellCategory =
  | 'banned-word'
  | 'cap-words'
  | 'contrast-reveal'
  | 'negation-list'
  | 'question-reveal'
  | 'colon-reveal'
  | 'opener-closer'
  | 'marketing-phrase'
  | 'puffery'
  | 'weasel-source'
  | 'chummy-opener'
  | 'hype-punctuation'
  | 'decoration'
  | 'fragment-drumbeat'
  | 'dash'
  | 'chat-wrapper'

export interface CopyTellFinding {
  tier: CopyTellTier
  category: CopyTellCategory
  /** The text that triggered the finding. */
  match: string
  /** Zero-based paragraph index, or -1 for a whole-text finding. */
  paragraph: number
  /** What to do instead, written for the agent that will fix it. */
  fix: string
}

export interface CopyScanOptions {
  /**
   * `short` = headline, subject line, ad, social post, SMS, hero, CTA: no
   * dashes at all. `long` = article, email body, page: two dashes allowed.
   * Default `long`.
   */
  surface?: CopySurface
  /** Product-specific banned words or phrases (case-insensitive, whole word). */
  extraBanned?: readonly string[]
}

export interface CopyScanResult {
  /** No ban-tier and no cap-tier findings. Weak findings never fail alone. */
  pass: boolean
  findings: CopyTellFinding[]
  counts: Record<CopyTellTier, number>
  /** 0 (clean) to 100 (dense with tells). Informational; `pass` is the gate. */
  slopScore: number
  words: number
}

/**
 * Ban-tier vocabulary: ai-tells.md "Vocabulary → Ban". Base forms; the scanner
 * also matches inflections ("leveraging", "synergies") and a hyphen written as
 * a space ("game changer"), so prompts can list each word once.
 */
export const BAN_WORDS: readonly string[] = [
  'delve', 'tapestry', 'testament to', 'realm', 'embark', 'beacon', 'multifaceted',
  'paradigm', 'synergy', 'myriad', 'plethora', 'meticulous', 'intricate', 'utilize',
  'leverage', 'supercharge', 'turbocharge', 'game-changer', 'game-changing',
  'ever-evolving landscape', 'plays a crucial role',
]

/** Cap-tier vocabulary: ai-tells.md "Vocabulary → Cap" plus empty intensifiers. Base forms. */
export const CAP_WORDS: readonly string[] = [
  'seamless', 'robust', 'streamline', 'empower', 'elevate', 'unlock', 'unleash',
  'harness', 'foster', 'enhance', 'optimize', 'cutting-edge', 'innovative',
  'revolutionary', 'transformative', 'holistic', 'comprehensive', 'pivotal', 'crucial',
  'vital', 'powerful', 'next-level', 'world-class', 'best-in-class', 'landscape',
  'navigate', 'ecosystem', 'journey',
  'truly', 'genuinely', 'incredibly', 'deeply', 'fundamentally', 'significantly',
  'simply', 'actually', 'literally', 'quietly',
]

interface PhraseRule {
  readonly pattern: RegExp
  readonly category: CopyTellCategory
  readonly fix: string
}

const rule = (category: CopyTellCategory, fix: string) => (pattern: RegExp): PhraseRule => ({ pattern, category, fix })

const CONTRAST_FIX = 'State the real point directly with its reason; do not stage a denial first.'

const PHRASE_RULES: readonly PhraseRule[] = [
  ...[
    /\bin today'?s (?:fast-paced |digital |modern )?(?:world|landscape|market|age)\b/i,
    /\bwhether you'?re an? [^,.]{1,40},? or an? /i,
    /(?:^|[.!?]\s+)imagine\b/i,
    /\bwhen it comes to\b/i,
    /\bhere'?s the thing\b|\bthe truth is\b|\blet me be clear\b|\bhere'?s what nobody tells you\b/i,
    /\bin this (?:guide|post|article),? we'?ll\b|\blet'?s dive in(?:to)?\b/i,
    /\bin conclusion\b|\bat the end of the day\b/i,
    /(?:^|[.!?]\s+)(?:it'?s worth noting|moreover|additionally|importantly|ultimately)\b/i,
  ].map(rule('opener-closer', 'Delete the wind-up and start with the point.')),
  ...[
    /\bsay (?:goodbye|hello) to\b/i,
    /\b(?:unlock|unleash) the (?:full )?power of\b/i,
    /\b\w+, (?:reimagined|redefined)\b/i,
    /\bto the next level\b/i,
    /\btransform the way you\b/i,
    /\bthe \w+ you deserve\b/i,
    /\bthe future of [\w ]{1,30} is here\b/i,
    /\bbuilt for teams (?:who|that) move fast\b/i,
    /\beverything you need to\b|\ball-in-one\b/i,
    /\beffortless(?:ly)?\b|\bin just a few clicks\b/i,
    /\bjoin (?:thousands|millions|hundreds) of\b/i,
    /\bchanges everything\b/i,
    /\bexperience the power of\b/i,
  ].map(rule('marketing-phrase', 'Replace with the concrete outcome, number or workflow.')),
  rule('puffery', 'State the fact; let the reader judge it.')(/\b(?:marks|represents) a pivotal moment\b|\bredefines the category\b/i),
  rule('weasel-source', 'Name the source or the customer, or cut the claim.')(/\bexperts agree\b|\bstudies show\b|\btrusted by (?:industry )?leaders\b/i),
  rule('chummy-opener', 'Cut the chummy opener.')(/^(?:great question|let'?s be honest|we get it)\b/im),
  rule('contrast-reveal', CONTRAST_FIX)(
    /\bit'?s not (?:just )?[^.,;!?]{1,60}[,;.]\s*it'?s\b|\b(?:this|that) isn'?t [^.;!?]{1,60}\.\s*(?:this|that|it) is\b|\bnot just [^.;!?]{1,60},? but\b|\bnot because [^.;!?]{1,60}\.\s*because\b|\bless [a-z]+, more [a-z]+\b|\bthe question isn'?t\b|\?\s*think again\b/i,
  ),
  rule('contrast-reveal', CONTRAST_FIX)(/(?:^|[.!?]\s+)Not [^.;!?]{1,40}\.\s+[A-Z][^.;!?]{1,60}\./),
  rule('negation-list', 'Say what does happen. One plain "No card required" beside the CTA is fine.')(
    /\bno [a-z-]+(?: [a-z-]+)?[,.]\s*no [a-z-]+/i,
  ),
  rule('question-reveal', 'Delete the question and keep the answer.')(
    /\bthe (?:result|catch|best part|secret|kicker|twist|answer|difference|outcome|upshot)\?\s+\S/i,
  ),
  rule('colon-reveal', 'Write it as a normal sentence.')(
    /\b(?:the best part|here'?s the (?:secret|thing|kicker|catch)|one word|the result|the truth|the secret)\s*:\s/i,
  ),
  rule('hype-punctuation', 'Remove the stacked punctuation.')(/[!?]{2,}/),
  rule('decoration', 'Remove decorative unicode letters and emoji bullets.')(
    /[\u{1D400}-\u{1D7FF}]|^\s*(?:[-*•]\s*)?[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/mu,
  ),
]

const CHAT_WRAPPERS: readonly RegExp[] = [
  /^\s*(?:sure|certainly|absolutely|of course|great)[!,.]/i,
  /^\s*here(?:'s| is| are) (?:a|an|the|your|my) (?:draft|version|post|email|ad|headline|copy|subject|options?|revised)/i,
  /\bi hope (?:this|that) helps\b/i,
  /\blet me know if you(?:'d like| want| need)\b/i,
  /\b(?:want|would you like) me to\b/i,
  /\bfeel free to (?:adjust|tweak|edit)\b/i,
]

// An em dash anywhere; an en dash, double hyphen or single hyphen used as a
// dash between words. A range like 10–20 has no spaces and is not a dash.
const DASH = /—|(?<=\S)[ \t]+(?:–|--?)[ \t]+(?=\S)/g
const CURLY = /[‘’“”]/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Inflections of one word: "leverage" → leverages, leveraged, leveraging. */
function inflected(word: string): string {
  const stem = escapeRegExp(word)
  if (/e$/.test(word)) return `${stem.slice(0, -1)}(?:e|es|ed|ing|ely)`
  if (/[^aeiou]y$/.test(word)) return `${stem.slice(0, -1)}(?:y|ies|ied|ying|ily)`
  return `${stem}(?:s|es|ed|ing|ly)?`
}

/**
 * A whole-word matcher for a term. A single word (hyphenated or not) also
 * matches its inflections; a phrase matches as written. Hyphens and spaces in
 * a term match either, and a space matches any run of whitespace.
 */
function termRegex(term: string): RegExp {
  const body = /\s/.test(term.trim())
    ? escapeRegExp(term.trim())
    : inflected(term.trim())
  return new RegExp(`(?<![\\w-])${body.replace(/-|\s+/g, '[-\\s]+')}(?![\\w-])`, 'gi')
}

const BAN_REGEXES = BAN_WORDS.map((word) => ({ word, regex: termRegex(word) }))
const CAP_REGEXES = CAP_WORDS.map((word) => ({ word, regex: termRegex(word) }))

/** The prose a reader reads: code, URLs and quote styles normalized away. */
export function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '\n\n')
    .replace(/`[^`\n]*`/g, 'code')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
}

function paragraphsOf(prose: string): string[] {
  return prose.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
}

function wordCount(text: string): number {
  return (text.match(/[A-Za-z0-9][\w'-]*/g) ?? []).length
}

function repeatedTrigramRate(prose: string): number {
  const words = prose.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []
  if (words.length < 12) return 0
  const seen = new Map<string, number>()
  for (let i = 0; i + 2 < words.length; i += 1) {
    const key = `${words[i]} ${words[i + 1]} ${words[i + 2]}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  let repeats = 0
  for (const count of seen.values()) if (count > 1) repeats += count - 1
  return repeats / (words.length - 2)
}

/** Scan copy for AI tells. Deterministic and cheap; run it on every draft. */
export function scanCopy(text: string, options: CopyScanOptions = {}): CopyScanResult {
  const surface = options.surface ?? 'long'
  const prose = proseOf(text)
  const paragraphs = paragraphsOf(prose)
  const banned = [...BAN_REGEXES, ...(options.extraBanned ?? []).map((word) => ({ word, regex: termRegex(word) }))]
  const findings: CopyTellFinding[] = []
  let contrastParagraphs = 0
  let tellWords = 0

  paragraphs.forEach((paragraph, index) => {
    for (const { word, regex } of banned) {
      for (const match of paragraph.matchAll(regex)) {
        tellWords += 1
        findings.push({ tier: 'ban', category: 'banned-word', match: match[0], paragraph: index, fix: `Replace "${word}" with the fact it stands in for.` })
      }
    }
    const capMatches = CAP_REGEXES.flatMap(({ regex }) => [...paragraph.matchAll(regex)].map((match) => match[0]))
    tellWords += capMatches.length
    if (capMatches.length >= 2) {
      findings.push({ tier: 'cap', category: 'cap-words', match: capMatches.join(', '), paragraph: index, fix: 'Two cap-tier words in one paragraph: rewrite it from the facts.' })
    }
    let contrast = false
    for (const { pattern, category, fix } of PHRASE_RULES) {
      const match = paragraph.match(pattern)
      if (!match) continue
      if (category === 'contrast-reveal') {
        if (contrast) continue
        contrast = true
      }
      findings.push({ tier: 'ban', category, match: match[0].trim(), paragraph: index, fix })
    }
    if (contrast) contrastParagraphs += 1
    let run = 0
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      const count = wordCount(sentence)
      run = count > 0 && count <= 3 ? run + 1 : 0
      if (run === 3) {
        findings.push({ tier: 'cap', category: 'fragment-drumbeat', match: sentence, paragraph: index, fix: 'Merge the fragments into one sentence that carries a fact.' })
        break
      }
    }
  })

  const dashes = prose.match(DASH)?.length ?? 0
  if (dashes > 0) {
    const tier: CopyTellTier = surface === 'short' ? 'ban' : dashes > 2 ? 'cap' : 'weak'
    const fix = surface === 'short'
      ? 'Short copy uses no dashes between words: use a period, comma or colon.'
      : 'Long copy allows two dashes per page at most; prefer a period or comma.'
    findings.push({ tier, category: 'dash', match: `${dashes} dash${dashes === 1 ? '' : 'es'}`, paragraph: -1, fix })
  }
  if (CURLY.test(text)) {
    findings.push({ tier: 'weak', category: 'decoration', match: 'curly quotes', paragraph: -1, fix: 'Weak alone: use the quote style the target format uses.' })
  }
  const wrapper = chatWrapperIn(text)
  if (wrapper !== null) {
    findings.push({ tier: 'ban', category: 'chat-wrapper', match: wrapper, paragraph: -1, fix: 'Return only the deliverable, with no chat around it.' })
  }

  const counts: Record<CopyTellTier, number> = { ban: 0, cap: 0, weak: 0 }
  for (const finding of findings) counts[finding.tier] += 1
  const words = wordCount(prose)
  // Saturates at 40 tell words per 1,000, a contrast in every paragraph, and 10% repeated trigrams.
  const wordRate = Math.min(1, (tellWords * 1000) / Math.max(1, words) / 40)
  const contrastRate = paragraphs.length === 0 ? 0 : contrastParagraphs / paragraphs.length
  const trigramRate = Math.min(1, repeatedTrigramRate(prose) * 10)
  const slopScore = Math.round(100 * (0.6 * wordRate + 0.25 * contrastRate + 0.15 * trigramRate))
  return { pass: counts.ban === 0 && counts.cap === 0, findings, counts, slopScore, words }
}

/** The chat wrapper around a deliverable ("Here's a draft…", "Hope this helps"), or null. */
export function chatWrapperIn(text: string): string | null {
  const prose = proseOf(text)
  for (const pattern of CHAT_WRAPPERS) {
    const match = prose.match(pattern)
    if (match) return match[0].trim()
  }
  return null
}

/**
 * Banned words and phrases for prompts that list them: base forms, lowercased,
 * deduplicated, product extras first. The scanner matches their inflections.
 */
export function bannedCopyVocabulary(extra: readonly string[] = []): string[] {
  return [...new Set([...extra, ...BAN_WORDS].map((word) => word.toLowerCase()))]
}

export interface MetricClaim {
  /** The figure as written, e.g. "$0.02/hr", "40%", "10x", "300ms". */
  text: string
  /** Canonical value used to match it against sources (claim-support rules). */
  value: string
}

// A figure a reader takes as a measured fact: money, a percentage, a multiple,
// a duration or size with its unit, a scaled count, or a grouped number.
// Bare small integers ("3 steps") and years are not metrics.
const METRIC =
  /[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?[kKmMbB]\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|×|ms\b|s\b|sec\b|secs\b|seconds?\b|mins?\b|minutes?\b|hrs?\b|hours?\b|days?\b|[kKmMbB]\+?(?=\s|$|[.,;])|[KMGT]B\b|rps\b|qps\b|tokens?\b)|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g

/** Every figure in `text` a reader would take as a measured fact. */
export function metricClaims(text: string): MetricClaim[] {
  const claims: MetricClaim[] = []
  for (const match of proseOf(text).matchAll(METRIC)) {
    const numeric = match[0].match(/[$€£¥₹]?\s?\d[\d,]*(?:\.\d+)?/)?.[0]
    const value = numeric ? canonicalizeValue(numeric) : null
    if (value !== null) claims.push({ text: match[0].trim(), value })
  }
  return claims
}

/**
 * Metric claims in `copy` whose value appears in none of `sources`: figures
 * the writer cannot point to. Values match with claim-support's
 * canonicalization, so "$1,200" in copy matches "1200.00" in a source.
 */
export function unsourcedMetrics(copy: string, sources: readonly string[]): MetricClaim[] {
  const known = new Set(sources.flatMap((source) => valuesInText(source)))
  return metricClaims(copy).filter((claim) => !known.has(claim.value))
}
