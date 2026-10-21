/**
 * Prelaunch knowledge audit: build the workspace knowledge index, validate it,
 * score it against the product's readiness specs, and write one JSON report.
 *
 * Server-side only (node:fs plus `@tangle-network/agent-knowledge`). A product's
 * `scripts/prelaunch-knowledge-audit.ts` supplies its id and policy and calls
 * {@link runPrelaunchKnowledgeAudit}; with `--strict` the process exits 1 when
 * validation fails or a blocking requirement is missing.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  buildEvalKnowledgeBundle,
  buildKnowledgeIndex,
  initKnowledgeBase,
  inspectKnowledgeIndex,
  validateKnowledgeIndex,
  type KnowledgeReadinessSpec,
} from '@tangle-network/agent-knowledge'

export interface PrelaunchKnowledgeAuditConfig {
  /** Product id, used in the task id, the report and the failure message. */
  product: string
  /** Readiness policy recorded in the bundle metadata. */
  policy: string
}

/** Run the audit, write the report, and exit 1 under `--strict` when it fails. */
export async function runPrelaunchKnowledgeAudit(config: PrelaunchKnowledgeAuditConfig): Promise<void> {
  const { product, policy } = config
  const strict = process.argv.includes('--strict')
  const knowledgeRoot = process.env.KNOWLEDGE_ROOT ?? '.'
  const reportPath = process.env.KNOWLEDGE_AUDIT_REPORT ?? join('.knowledge-readiness', `${product}-report.json`)
  try {
    await initKnowledgeBase(knowledgeRoot)
    const specs = JSON.parse(
      await readFile(join(knowledgeRoot, 'knowledge', 'readiness-specs.json'), 'utf8'),
    ) as KnowledgeReadinessSpec[]
    const index = await buildKnowledgeIndex(knowledgeRoot)
    const validation = validateKnowledgeIndex(index, { strict: true })
    const inspection = inspectKnowledgeIndex(index)
    const readiness = buildEvalKnowledgeBundle({
      taskId: `${product}:prelaunch-knowledge`,
      index,
      specs,
      searchLimit: 8,
      metadata: { product, policy },
    })

    const missing = readiness.report.blockingMissingRequirements
    const ok = validation.ok && missing.length === 0
    const output = {
      product,
      generatedAt: new Date().toISOString(),
      knowledgeRoot,
      ok,
      strict,
      summary: {
        readinessScore: readiness.report.readinessScore,
        sourceCount: inspection.sourceCount,
        pageCount: inspection.pageCount,
        findingCount: inspection.findingCount,
        blockingFindingCount: inspection.blockingFindingCount,
        blockingMissingRequirements: missing.length,
      },
      report: readiness.report,
      findings: validation.findings,
      missingRequirementIds: missing.map((requirement) => requirement.id),
    }

    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`)
    console.log(JSON.stringify(output.summary, null, 2))
    if (strict && !ok) {
      console.error(`${product} knowledge readiness failed; see ${reportPath}`)
      process.exit(1)
    }
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}
