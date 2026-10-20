import { ToolInputError } from '../tools/errors'
import { defineAppTool, type AppToolDefinition } from '../tools/registry'
import type { AppToolContext } from '../tools/types'
import { indexArtifactValues } from './claim-support'
import { requireScopeKey, resolveDraft, unwrap } from './draft-tool-context'
import { summarizeArtifactAgreement, summarizeClaimSupport, summarizeQuoteVerification, summarizeTargetCorrectness } from './evidence-verification'
import { stampProvenance } from './provenance'
import type { WorkProductService } from './service'
import { ARTIFACT_AGREEMENT_CHECK, CLAIM_SUPPORT_CHECK, EVIDENCE_COVERAGE_CHECK, QUOTE_VERIFICATION_CHECK, TARGET_CORRECTNESS_CHECK, type WorkProductToolConfig } from './tool-config'
import { parseAgentCheckInput, parseArtifactInput, unresolvedBlockingExceptions, type EvidenceEntry, type QualityCheck } from './types'

/** Register the terminal submission, preserving the ordered platform checks before ready. */
export function buildSubmissionTool(config: WorkProductToolConfig, service: WorkProductService): AppToolDefinition {
  return defineAppTool({
    name: 'submit_work_product',
    description:
      'Submit the finished work product for professional review — the terminal call after evidence and exceptions are recorded. Refused while a blocking exception is unresolved, or when a material target lacks evidence. Include your own quality checks in `checks`.',
    parameters: {
      type: 'object',
      properties: {
        scopeKey: { type: 'string', description: 'Engagement key for this work product.' },
        artifact: {
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'Artifact kind from the product vocabulary.' },
            title: { type: 'string' },
            path: { type: 'string', description: 'Vault/object-store ref of the rendered document.' },
            content: { type: 'string', description: 'Inline body when small (markdown/JSON).' },
            mediaType: { type: 'string' },
            baseline: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              description: 'For diff-first artifacts: the source document being redlined.',
            },
            fields: { type: 'object', description: 'Structured field map lineage targets anchor to.' },
          },
          required: ['kind', 'title'],
        },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              passed: { type: 'boolean' },
              detail: { type: 'string' },
            },
            required: ['id', 'name', 'passed'],
          },
          description: 'Your own quality self-checks (recorded as agent-sourced).',
        },
      },
      required: ['scopeKey', 'artifact'],
    },
    async execute(args: Record<string, unknown>, ctx: AppToolContext) {
      const scopeKey = requireScopeKey(args)
      const parsedArtifact = parseArtifactInput(args.artifact)
      if (!parsedArtifact.ok) throw new ToolInputError('invalid_artifact', `${parsedArtifact.field}: ${parsedArtifact.error}`)
      const artifact = parsedArtifact.value
      if (!config.artifactKinds.includes(artifact.kind)) {
        throw new ToolInputError('invalid_artifact', `artifact.kind: must be one of: ${config.artifactKinds.join(', ')}`)
      }
      const agentChecks: QualityCheck[] = []
      if (args.checks !== undefined) {
        if (!Array.isArray(args.checks)) throw new ToolInputError('invalid_checks', 'checks must be an array when present.')
        for (let index = 0; index < args.checks.length; index += 1) {
          const parsed = parseAgentCheckInput(args.checks[index], `checks[${index}]`)
          if (!parsed.ok) throw new ToolInputError('invalid_checks', `${parsed.field}: ${parsed.error}`)
          agentChecks.push({ ...parsed.value, source: 'agent' })
        }
      }

      const draft = await resolveDraft(service, config, scopeKey, ctx)
      const blocking = unresolvedBlockingExceptions(draft.exceptions)
      if (blocking.length > 0) {
        throw new ToolInputError(
          'blocking_exceptions_unresolved',
          `Cannot submit: ${blocking.length} unresolved blocking exception(s) (${blocking.map((entry) => entry.id).join(', ')}). Resolve each via flag_exception with resolved:true, or downgrade its severity with a resolutionNote justifying why it does not block.`,
          409,
        )
      }

      // Platform check one: every persisted quote still occurs in the source
      // it names. The upsert gate stops NEW fabrication; this stops a package
      // whose evidence predates the gate from reaching a reviewer. Recorded on
      // the row AND rejected fail-loud — the same discipline as coverage.
      const checks: QualityCheck[] = [...agentChecks]
      const quotes = await summarizeQuoteVerification(config, draft.evidence, ctx)
      if (quotes) {
        const quoted = quotes.verified + quotes.failed.length
        checks.unshift({
          id: QUOTE_VERIFICATION_CHECK,
          name: QUOTE_VERIFICATION_CHECK,
          passed: quotes.failed.length === 0,
          detail:
            quotes.failed.length === 0
              ? `${quotes.verified}/${quoted} quoted evidence entries verified against their source (${quotes.spanAnchored} platform-sliced from a source span, ${quotes.verified - quotes.spanAnchored} model-quoted and proved to occur); ${quotes.withoutQuote} recorded without a quote`
              : `Unverifiable quotes on: ${quotes.failed.join(', ')}`,
          source: 'platform',
        })
        if (quotes.failed.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'quote_verification_failed',
            `Cannot submit: ${quotes.failed.length} evidence entr${quotes.failed.length === 1 ? 'y quotes' : 'ies quote'} text that does not occur in the source named (${quotes.failed.join(', ')}). Re-emit each with a quote copied character-for-character from that document, or without locator.quote if the value is computed.`,
          )
        }
      }

      // Platform check two: every citation's text carries the figure it
      // claims. Recorded AND rejected, like the other two — a citation that
      // points at real text supporting nothing is the failure a reviewer is
      // least able to catch by eye, because it looks exactly like a good one.
      if (config.verifyClaimSupport !== false) {
        const support = summarizeClaimSupport(draft.evidence)
        if (support.checkable > 0) checks.unshift({
          id: CLAIM_SUPPORT_CHECK,
          name: 'Cited numeric values',
          passed: support.unsupported.length === 0,
          detail:
            support.unsupported.length > 0
              ? `Cited text does not contain the claimed figure on: ${support.unsupported.join(', ')}`
              : `${support.supported}/${support.checkable} value-bearing citations anchor to text containing the claimed figure; does not verify prose claims`,
          source: 'platform',
        })
        if (support.unsupported.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'claim_not_supported',
            `Cannot submit: ${support.unsupported.length} evidence entr${support.unsupported.length === 1 ? 'y cites' : 'ies cite'} text that does not contain the figure claimed (${support.unsupported.join(', ')}). Re-emit each with locator.find set to the value exactly as it appears in the document, or without a locator if the figure was computed rather than read.`,
          )
        }
      }

      // Legacy rows carry whatever target spelling was current when they were
      // written, so every submit-time check folds on READ as well as ingest.
      const targetOf = (entry: EvidenceEntry): string =>
        config.normalizeTarget ? config.normalizeTarget(entry.target) : entry.target

      // Platform check three: every citation's line belongs to the target it
      // is attached to. Recorded AND rejected — a crossed citation is real
      // text carrying the real figure, so it is invisible to every gate above.
      if (config.confusableTargets && config.confusableTargets.length > 0) {
        const crossing = summarizeTargetCorrectness(draft.evidence, config.confusableTargets, targetOf)
        checks.unshift({
          id: TARGET_CORRECTNESS_CHECK,
          name: TARGET_CORRECTNESS_CHECK,
          passed: crossing.crossed.length === 0,
          detail:
            crossing.crossed.length > 0
              ? `Citations attached to the wrong target: ${crossing.crossed.map((item) => item.detail).join('; ')}`
              : crossing.checkable === 0
                ? 'No citation lands on a line this product can tell apart from a sibling target — nothing to check'
                : `${crossing.correct}/${crossing.checkable} citations land on a line belonging to their own target`,
          source: 'platform',
        })
        if (crossing.crossed.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'target_crossed',
            `Cannot submit: ${crossing.crossed.length} evidence entr${crossing.crossed.length === 1 ? 'y cites' : 'ies cite'} a line belonging to a different target — ${crossing.crossed.map((item) => item.detail).join('; ')}. Re-emit each against the target whose line it actually cites, or cite the line that belongs to the target it is attached to.`,
          )
        }
      }

      // Platform check four: the evidence and the artifact must agree about
      // what each line holds. This is the pass that catches a package whose
      // crossed evidence predates the artifact it decorates — every entry was
      // recorded turns before there was an artifact to compare it to.
      const artifactValues = indexArtifactValues(artifact.fields, config.normalizeTarget)
      if (config.verifyArtifactAgreement !== false && artifactValues.size > 0) {
        const agreement = summarizeArtifactAgreement(draft.evidence, artifactValues, targetOf)
        checks.unshift({
          id: ARTIFACT_AGREEMENT_CHECK,
          name: ARTIFACT_AGREEMENT_CHECK,
          passed: agreement.contradicting.length === 0,
          detail:
            agreement.contradicting.length > 0
              ? `Evidence contradicts the artifact on: ${agreement.contradicting.map((item) => item.detail).join('; ')}`
              : agreement.checkable === 0
                ? 'No evidence claim states a figure the artifact also states — nothing to check'
                : `${agreement.agreeing}/${agreement.checkable} evidence claims agree with the artifact field they support`,
          source: 'platform',
        })
        if (agreement.contradicting.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'contradicts_artifact',
            `Cannot submit: ${agreement.contradicting.length} evidence entr${agreement.contradicting.length === 1 ? 'y contradicts' : 'ies contradict'} the artifact they support — ${agreement.contradicting.map((item) => item.detail).join('; ')}. Move each citation to the target it actually supports, or correct the artifact. The package cannot state both.`,
          )
        }
      }

      // Platform check five: every material target has ≥1 evidence row. A
      // failing coverage check is BOTH recorded on the row (visible to the
      // queue) and rejected fail-loud — a lineage-free package can never reach
      // a reviewer.
      if (config.materialTargets) {
        // Both sides of the join fold to the canonical spelling: an artifact
        // field written `line_3a` and an evidence row written `f1040.line_3a`
        // are one line, and a coverage check that read them as two would
        // report a miss on a target that IS evidenced.
        const targets = [
          ...new Set(
            config.materialTargets(artifact).map((target) => (config.normalizeTarget ? config.normalizeTarget(target) : target)),
          ),
        ]
        const covered = new Set(draft.evidence.map(targetOf))
        const missing = targets.filter((target) => !covered.has(target))
        // How each covered target is BACKED, not merely that a row exists.
        // A coverage count that cannot distinguish a platform-sliced citation
        // from a bare assertion is the number that let 13 invented quotes read
        // as "13/13 evidenced" on the row a reviewer then opened.
        const anchoredTargets = new Set(
          draft.evidence.filter((entry) => entry.locator.quoteBasis !== undefined).map(targetOf),
        )
        const spanTargets = new Set(
          draft.evidence.filter((entry) => entry.locator.quoteBasis === 'span').map(targetOf),
        )
        const present = targets.filter((target) => covered.has(target))
        const unanchored = present.filter((target) => !anchoredTargets.has(target))
        const spanCount = present.filter((target) => spanTargets.has(target)).length
        const breakdown = `${spanCount} span-anchored, ${present.length - spanCount - unanchored.length} quote-verified, ${unanchored.length} claim-only`
        const coverage: QualityCheck = {
          id: EVIDENCE_COVERAGE_CHECK,
          name: EVIDENCE_COVERAGE_CHECK,
          passed: missing.length === 0 && !(config.requireAnchoredEvidence && unanchored.length > 0),
          detail:
            missing.length > 0
              ? `Missing evidence for: ${missing.join(', ')}`
              : config.requireAnchoredEvidence && unanchored.length > 0
                ? `No source anchor for: ${unanchored.join(', ')}`
              : `${targets.length}/${targets.length} material targets evidenced (${breakdown}); checks declared evidence links, does not verify prose claims or artifact completeness`,
          source: 'platform',
        }
        checks.unshift(coverage)
        if (missing.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'evidence_coverage_failed',
            `Cannot submit: material targets lack evidence: ${missing.join(', ')}. Add upsert_evidence entries targeting each, then resubmit.`,
          )
        }
        if (config.requireAnchoredEvidence && unanchored.length > 0) {
          await unwrap(() => service.recordChecks(draft.id, checks), 'checks_rejected')
          throw new ToolInputError(
            'evidence_not_anchored',
            `Cannot submit: these material targets have an evidence row but no source anchor: ${unanchored.join(', ')}. Re-emit each with locator.find — the value exactly as it appears in the document. The platform locates it and writes the quote itself, so you never retype source text or count characters.`,
          )
        }
      }

      const provenance = stampProvenance(config.provenance(ctx), config.now)
      const record = await unwrap(
        () => service.submit(draft.id, { artifact, checks, provenance }),
        'submit_rejected',
      )
      await config.onReady?.(record, ctx)
      return {
        workProductId: record.id,
        version: record.version,
        status: record.status,
        checks: record.checks.map((check) => ({ name: check.name, passed: check.passed, source: check.source, detail: check.detail })),
      }
    },
  })

}
