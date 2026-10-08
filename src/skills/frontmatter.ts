/**
 * The one `SKILL.md` frontmatter parser, in a module with no imports so
 * browser code (the profile editor) can read a skill's name and description
 * without loading the corpus loader's Node fallbacks.
 */

/** Fields a `SKILL.md` frontmatter block may declare. All optional — absent
 *  frontmatter (or an absent field within it) is legal; callers fill defaults
 *  (see {@link skillEntryFromMarkdown}). */
export interface SkillFrontmatter {
  id?: string
  name?: string
  description?: string
  author?: { name: string; url?: string }
  source?: string
  category?: string
  tags?: string[]
  tier?: string
}

/** The result of {@link parseSkillFrontmatter}: the parsed fields, the body
 *  with the frontmatter block stripped, and the original untouched text. */
export interface ParsedSkill {
  frontmatter: SkillFrontmatter
  body: string
  raw: string
}

/** Quoted values (`description: "..."`, as emitted by materialize's
 *  `normalizeSkillMd`) are JSON strings — decode with `JSON.parse` so escapes
 *  round-trip; anything else is a bare scalar, trimmed. */
function parseFrontmatterScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string
  return trimmed
}

/** THE one `SKILL.md` frontmatter parser — hand-rolled, no YAML dependency.
 *
 * Absent frontmatter (text does not open with a `---` delimiter line) is
 * legal: returns `{frontmatter: {}, body: raw, raw}`. An OPENED block with no
 * closing `---` is truncated input and throws. Inside the block: scalar
 * `key: value` lines (value optionally double-quoted, decoded via
 * `JSON.parse`); a nested `author:` block whose indented `name:`/`url:` lines
 * are the only children it accepts; `tags:` as an inline `[a, b]` list or as
 * an indented `- item` block. Unknown scalar keys are ignored (forward-compat)
 * — but a line that matches NONE of these shapes (no colon, an orphaned
 * indented line, a bad dash) throws naming the offending line. Silently
 * mis-parsed metadata is the bug class this parser exists to kill; an
 * unrecognized shape is never guessed at.
 */
export function parseSkillFrontmatter(raw: string): ParsedSkill {
  const lines = raw.split('\n')
  if ((lines[0] ?? '').trim() !== '---') {
    return { frontmatter: {}, body: raw, raw }
  }

  let closeIndex = -1
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      closeIndex = i
      break
    }
  }
  if (closeIndex === -1) {
    throw new Error(
      'parseSkillFrontmatter: opening "---" has no closing "---" — truncated frontmatter block',
    )
  }

  const blockLines = lines.slice(1, closeIndex)
  const body = lines.slice(closeIndex + 1).join('\n').replace(/^\n+/, '')
  const frontmatter: SkillFrontmatter = {}
  const scalarKeys = new Set(['id', 'name', 'description', 'source', 'category', 'tier'])
  const topLineRe = /^(\S[^:]*):\s*(.*)$/

  let i = 0
  while (i < blockLines.length) {
    const line = blockLines[i] ?? ''
    if (line.trim() === '') {
      i++
      continue
    }
    const match = line.match(topLineRe)
    if (!match) {
      throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`)
    }
    const key = (match[1] ?? '').trim()
    const rest = match[2] ?? ''

    if (key === 'author') {
      if (rest.trim() !== '') {
        throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`)
      }
      const author: { name: string; url?: string } = { name: '' }
      let sawName = false
      i++
      while (i < blockLines.length && /^\s+\S/.test(blockLines[i] ?? '')) {
        const sub = (blockLines[i] ?? '').trim()
        const subMatch = sub.match(/^(name|url):\s*(.*)$/)
        if (!subMatch) {
          throw new Error(
            `parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(blockLines[i])}`,
          )
        }
        const subKey = subMatch[1] as 'name' | 'url'
        const subValue = parseFrontmatterScalar(subMatch[2] ?? '')
        if (subKey === 'name') {
          author.name = subValue
          sawName = true
        } else {
          author.url = subValue
        }
        i++
      }
      if (sawName) frontmatter.author = author
      continue
    }

    if (key === 'tags') {
      const inline = rest.trim()
      if (inline.startsWith('[') && inline.endsWith(']')) {
        const inner = inline.slice(1, -1).trim()
        frontmatter.tags = inner === '' ? [] : inner.split(',').map((t) => parseFrontmatterScalar(t))
        i++
        continue
      }
      if (inline !== '') {
        throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(line)}`)
      }
      const tags: string[] = []
      i++
      while (i < blockLines.length && /^\s*-\s*/.test(blockLines[i] ?? '')) {
        tags.push(parseFrontmatterScalar((blockLines[i] ?? '').replace(/^\s*-\s*/, '')))
        i++
      }
      frontmatter.tags = tags
      continue
    }

    // Indented lines under a key: a block scalar (`description: |`) for a known
    // key, or a nested map (`metadata:`) under an unknown one.
    i++
    const children: string[] = []
    while (i < blockLines.length && /^(?:\s+\S|\s*$)/.test(blockLines[i] ?? '')) {
      children.push(blockLines[i] ?? '')
      i++
    }
    const indicator = rest.trim()
    if (scalarKeys.has(key)) {
      if (/^[|>][-+]?$/.test(indicator)) {
        const lines = children.map((child) => child.trim())
        ;(frontmatter as Record<string, string>)[key] = (indicator.startsWith('|')
          ? lines.join('\n')
          : lines.filter(Boolean).join(' ')).trim()
      } else if (children.some((child) => child.trim() !== '')) {
        throw new Error(`parseSkillFrontmatter: unrecognized frontmatter line: ${JSON.stringify(children.find((child) => child.trim() !== ''))}`)
      } else {
        ;(frontmatter as Record<string, string>)[key] = parseFrontmatterScalar(rest)
      }
    }
    // Unknown key and its nested lines: ignored, forward-compat.
  }

  return { frontmatter, body, raw }
}
