#!/usr/bin/env node
/**
 * Give every relative specifier in the emitted declarations an explicit `.js` path.
 *
 * `tsc` keeps authored specifiers in `.d.ts` output, and the source uses bundler
 * resolution (`./chat-message-types`). A NodeNext consumer resolves none of those,
 * so `export * from './chat-message-types'` exported nothing and named re-exports
 * became TS2305. Each specifier is resolved against the emitted tree: `./x` names
 * `./x.js` when `x.d.ts` exists, or `./x/index.js` when `x/index.d.ts` does.
 * A relative specifier that matches neither fails the build.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', process.argv[2] ?? 'dist')
const specifier = /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g
const explicit = /\.(?:js|mjs|cjs|json|css)$/

const declarations = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  if (entry.isDirectory()) return declarations(path)
  return entry.name.endsWith('.d.ts') ? [path] : []
})

const unresolved = []
let rewritten = 0
for (const file of declarations(dist)) {
  const before = readFileSync(file, 'utf8')
  const after = before.replace(specifier, (match, lead, quote, spec) => {
    if (explicit.test(spec)) return match
    const base = resolve(dirname(file), spec)
    const target = existsSync(`${base}.d.ts`) ? `${spec}.js`
      : existsSync(join(base, 'index.d.ts')) ? `${spec.replace(/\/$/, '')}/index.js`
      : null
    if (target === null) {
      unresolved.push(`${relative(dist, file)}: ${spec}`)
      return match
    }
    rewritten += 1
    return `${lead}${quote}${target}${quote}`
  })
  if (after !== before) writeFileSync(file, after)
}
if (unresolved.length > 0) {
  console.error(`unresolved relative declaration specifiers:\n  ${unresolved.join('\n  ')}`)
  process.exit(1)
}
console.log(`declarations: ${rewritten} relative specifiers made explicit`)
