#!/usr/bin/env node
// knowledge:ingest — the build-loop entry (NOT the act-gate; see KNOWLEDGE.md).
//
// This runs in Node (it touches the filesystem), never on the Worker edge path.
// It enumerates the domain docs you dropped under ./knowledge and the research
// sources declared in agent.config.ts, then drives the knowledge acquisition
// loop. By default it runs in DRY mode — it reports what WOULD be ingested so you
// can verify the inputs before spending model calls. Wire a real model-backed
// driver/decider (see the createKnowledgeLoop block below) and pass --run to
// execute the loop.
//
// Why a script and not a route: agent-knowledge owns disk I/O over a KB `root`;
// the acquisition loop proposes knowledge pages that a confidence gate accepts or
// drops. Grounding (sources) is always recorded; a low-confidence PROPOSAL is
// dropped — propose, don't apply. Tune the gate in KNOWLEDGE.md.

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KNOWLEDGE_DIR = join(ROOT, 'knowledge')
const RUN = process.argv.includes('--run')

async function listDocs(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await listDocs(join(dir, entry.name))))
    else if (/\.(md|txt|json)$/i.test(entry.name)) out.push(join(dir, entry.name))
  }
  return out
}

// Read agent.config.ts as text to discover declared sources without a TS runtime.
async function readDeclaredSources() {
  const cfgPath = join(ROOT, 'agent.config.ts')
  if (!existsSync(cfgPath)) return []
  const text = await readFile(cfgPath, 'utf8')
  // Pull `{ uri: '…', kind: '…' }` literals out of the knowledge.sources block.
  const sources = []
  const re = /\{\s*uri:\s*['"]([^'"]+)['"](?:\s*,\s*kind:\s*['"]([^'"]+)['"])?\s*\}/g
  let m
  while ((m = re.exec(text))) sources.push({ uri: m[1], kind: m[2] ?? 'unknown' })
  return sources
}

async function main() {
  const docs = await listDocs(KNOWLEDGE_DIR)
  const sources = await readDeclaredSources()

  console.log('knowledge:ingest')
  console.log(`  local docs (./knowledge): ${docs.length}`)
  for (const d of docs) console.log(`    - ${d.slice(ROOT.length + 1)}`)
  console.log(`  declared sources (agent.config.ts): ${sources.length}`)
  for (const s of sources) console.log(`    - [${s.kind}] ${s.uri}`)

  if (!RUN) {
    console.log('')
    console.log('DRY run. Pass --run to drive the acquisition loop.')
    console.log('Wire a model-backed driver + decider first — see the commented block in this file and KNOWLEDGE.md.')
    return
  }

  // To actually run the loop, install @tangle-network/agent-knowledge +
  // @tangle-network/agent-runtime (peers), give the loop a KB `root` on disk and
  // a model-backed driver, then:
  //
  //   import { createKnowledgeLoop } from '@tangle-network/agent-app/knowledge-loop'
  //   import { config } from '../agent.config.ts'  // via a TS loader / tsx
  //   const loop = createKnowledgeLoop(config.knowledge, {
  //     root: KNOWLEDGE_DIR,
  //     driver: async ({ systemPrompt, userMessage }) => ({ finalText: await callModel(systemPrompt, userMessage) }),
  //     defaultMinConfidence: config.knowledge.loop?.minConfidence ?? 0.7,
  //   })
  //   const result = await loop.run()
  //   console.log('applied:', result.applied)
  //
  throw new Error('--run requires a wired model-backed driver. See KNOWLEDGE.md before enabling.')
}

main().catch((err) => {
  console.error(`knowledge:ingest: ${err.message}`)
  process.exit(1)
})
