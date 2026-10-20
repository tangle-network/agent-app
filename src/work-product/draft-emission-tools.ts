import { ToolInputError } from '../tools/errors'
import { defineAppTool, type AppToolDefinition } from '../tools/registry'
import type { AppToolContext } from '../tools/types'
import { requireBatch, requireScopeKey, resolveDraft, unwrap } from './draft-tool-context'
import { assertClaimsSupported, assertTargetsNotCrossed, resolveEvidenceQuotes } from './evidence-verification'
import type { WorkProductService } from './service'
import { MAX_WORK_PRODUCT_BATCH, type WorkProductToolConfig } from './tool-config'
import { parseEvidenceInput, parseExceptionInput, unresolvedBlockingExceptions, type EvidenceEntry, type ExceptionEntry } from './types'

/** Register the incremental evidence and exception writes that accumulate a draft. */
export function buildDraftEmissionTools(config: WorkProductToolConfig, service: WorkProductService): AppToolDefinition[] {
  const canResolveTextLocators = config.readSourceText !== undefined
  const locatorProperties = {
    page: { type: 'number' },
    range: { type: 'string', description: "Free-form location: 'L120-L134' | 'B7' | '¶4'." },
    ...(canResolveTextLocators ? {
      find: {
        type: 'string',
        description:
          'PREFERRED — use this whenever the value was READ from a document. The value exactly as it appears in the source (for example "128,450.00"), or a short distinctive phrase from the supporting line. The platform LOCATES it, cites the whole line it sits on, and returns that line to you. You do not retype the quote and you do not compute character offsets — so the citation can neither be invented nor land on the wrong line. If the value is not in the document, the entry is refused.',
      },
      findOccurrence: {
        type: 'integer',
        minimum: 1,
        description: 'Which occurrence of `find` to cite when the value appears more than once. Defaults to the first.',
      },
      span: {
        type: 'object',
        description:
          'Only when you have exact character offsets from a tool that computed them. Absolute offsets into the whole document: start is the first character, end is one past the last. Prefer `find` — offsets computed by hand land on the wrong line.',
        properties: {
          start: { type: 'integer', minimum: 0 },
          end: { type: 'integer', minimum: 1 },
        },
        required: ['start', 'end'],
        additionalProperties: false,
      },
    } : {}),
    quote: {
      type: 'string',
      description: canResolveTextLocators
        ? 'Fallback for sources that cannot give you character offsets: the supporting text copied character-for-character. The platform checks it occurs in the document and REFUSES the entry if it does not. Prefer span. For a value you COMPUTED rather than read, omit both and state the computation in claim.'
        : 'Supporting text copied character-for-character from the source. This deployment cannot locate values or resolve character spans. For a value you COMPUTED rather than read, omit the locator and state the computation in claim.',
    },
  }

  const upsertEvidence = defineAppTool({
    name: 'upsert_evidence',
    description: canResolveTextLocators
      ? 'Record source→field lineage for the current work product, incrementally as you find it. Each entry links a source document (sourceRef + locator) to one artifact target and states the claim it supports. Cite by locator.find — the value exactly as it appears in the document — and the platform locates it and writes the supporting quote for you. Re-emitting an entry id replaces that entry. Address the work product by scopeKey; the first call creates the draft.'
      : 'Record source→field lineage for the current work product, incrementally as you find it. Each entry links a source document (sourceRef + locator) to one artifact target and states the claim it supports. Cite with locator.quote when the source states the claim. This deployment cannot locate values or resolve character spans. Re-emitting an entry id replaces that entry. Address the work product by scopeKey; the first call creates the draft.',
    parameters: {
      type: 'object',
      properties: {
        scopeKey: { type: 'string', description: 'Engagement key for this work product.' },
        entries: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_WORK_PRODUCT_BATCH,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable entry id — re-emit to replace.' },
              sourceRef: { type: 'string', description: 'Vault path / attachment id of the SOURCE document.' },
              locator: {
                type: 'object',
                properties: locatorProperties,
                additionalProperties: false,
              },
              target: { type: 'string', description: 'Artifact field/claim this evidence supports.' },
              claim: { type: 'string', description: 'The value/assertion at the target.' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
            },
            required: ['id', 'sourceRef', 'target', 'claim'],
          },
        },
      },
      required: ['scopeKey', 'entries'],
    },
    async execute(args: Record<string, unknown>, ctx: AppToolContext) {
      const scopeKey = requireScopeKey(args)
      const raw = requireBatch(args, 'entries')
      const entries: EvidenceEntry[] = []
      for (let index = 0; index < raw.length; index += 1) {
        const parsed = parseEvidenceInput(raw[index], `entries[${index}]`)
        if (!parsed.ok) throw new ToolInputError('invalid_evidence', `${parsed.field}: ${parsed.error}`)
        // Fold to the product's canonical target spelling at INGEST, so the
        // row never carries two names for one line. Every downstream check —
        // coverage, deduplication, artifact agreement, the confusable-target
        // groups — joins on this string.
        if (config.normalizeTarget) parsed.value.target = config.normalizeTarget(parsed.value.target)
        entries.push(parsed.value)
      }
      // Fail-loud source resolution: lineage can never point at nothing.
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!
        if (!(await config.resolveSourceRef(entry.sourceRef, ctx))) {
          throw new ToolInputError(
            'unknown_source_ref',
            `entries[${index}].sourceRef: "${entry.sourceRef}" does not resolve to an existing source document.`,
          )
        }
      }
      // Fail-loud quote verification: a quote must occur in the document the
      // entry names. Rejected BEFORE the draft is resolved, so a batch with a
      // fabricated quote persists nothing — the model corrects and re-sends
      // rather than leaving a half-written row behind.
      await resolveEvidenceQuotes(config, entries, ctx)
      // ...and the text that resolution produced must carry the figure the
      // entry claims. Same batch, same fail-before-persist discipline: an
      // entry citing the payer line for a wage figure never reaches the draft.
      assertClaimsSupported(config, entries)
      // ...and that line must belong to the target it is attached to. A
      // citation carrying the right figure on a sibling's line passes every
      // gate above it and misleads a reviewer more effectively than a
      // fabricated one, because it survives being clicked.
      assertTargetsNotCrossed(config, entries)
      // NOTE: artifact agreement is deliberately NOT checked here. See
      // `summarizeArtifactAgreement` — comparing an incoming citation to a
      // STALE artifact deadlocks the one correction order an agent can take.
      const draft = await resolveDraft(service, config, scopeKey, ctx)
      const record = await unwrap(() => service.upsertEvidence(draft.id, entries), 'evidence_rejected')
      return {
        workProductId: record.id,
        version: record.version,
        evidenceCount: record.evidence.length,
        // Echo what was actually STORED for the entries in this call. A span
        // citation's quote is produced here, not sent here, so the model must
        // be able to see the text its offsets selected — that is how it
        // notices an off-by-a-line span without a second read.
        entries: entries.map((entry) => ({
          id: entry.id,
          target: entry.target,
          ...(entry.locator.quote === undefined ? {} : { quote: entry.locator.quote }),
          ...(entry.locator.quoteBasis === undefined ? {} : { quoteBasis: entry.locator.quoteBasis }),
        })),
      }
    },
  })

  const flagException = defineAppTool({
    name: 'flag_exception',
    description:
      'Flag problems with the current work product (missing documents, inconsistent sources, …). An unresolved blocking exception parks the work product until it is resolved; re-emit the same id with resolved:true to release it. Address by scopeKey.',
    parameters: {
      type: 'object',
      properties: {
        scopeKey: { type: 'string', description: 'Engagement key for this work product.' },
        exceptions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_WORK_PRODUCT_BATCH,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable entry id — re-emit to replace.' },
              severity: { type: 'string', enum: ['blocking', 'material', 'advisory'] },
              kind: { type: 'string', description: 'Exception kind from the product vocabulary.' },
              message: { type: 'string' },
              targets: { type: 'array', items: { type: 'string' } },
              resolved: { type: 'boolean' },
              resolutionNote: { type: 'string' },
            },
            required: ['id', 'severity', 'kind', 'message'],
          },
        },
      },
      required: ['scopeKey', 'exceptions'],
    },
    async execute(args: Record<string, unknown>, ctx: AppToolContext) {
      const scopeKey = requireScopeKey(args)
      const raw = requireBatch(args, 'exceptions')
      const entries: ExceptionEntry[] = []
      for (let index = 0; index < raw.length; index += 1) {
        const parsed = parseExceptionInput(raw[index], `exceptions[${index}]`)
        if (!parsed.ok) throw new ToolInputError('invalid_exception', `${parsed.field}: ${parsed.error}`)
        if (!config.exceptionKinds.includes(parsed.value.kind)) {
          throw new ToolInputError(
            'invalid_exception',
            `exceptions[${index}].kind: must be one of: ${config.exceptionKinds.join(', ')}`,
          )
        }
        // An agent resolving its own exception is tagged as such; the reviewer
        // tag is reserved for the verdict route.
        if (parsed.value.resolved && parsed.value.resolvedBy === undefined) parsed.value.resolvedBy = 'agent'
        entries.push(parsed.value)
      }
      const draft = await resolveDraft(service, config, scopeKey, ctx)
      const record = await unwrap(() => service.upsertExceptions(draft.id, entries), 'exception_rejected')
      return {
        workProductId: record.id,
        version: record.version,
        status: record.status,
        unresolvedBlocking: unresolvedBlockingExceptions(record.exceptions).length,
      }
    },
  })

  return [upsertEvidence, flagException]
}
