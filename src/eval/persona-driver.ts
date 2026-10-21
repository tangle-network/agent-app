/**
 * The reactive persona driver: the user side of an app's persona eval.
 *
 * An LLM plays the persona and decides each next message from the transcript
 * and the run's produced state, instead of replaying a fixed turn list. It
 * signs off with the literal `DONE` when a real practitioner would act on the
 * work unmodified.
 *
 * The app owns the persona and product context; agent-eval supplies the priced
 * call, the ledger, and the model-substitution guard. The ledger actor and the
 * driver model are required so each app attributes and pins its own driver.
 */

import {
  assertServedModel,
  type ChatClient,
  type ChatRequest,
  CostLedger,
  type CostLedgerHandle,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type DriverState,
  maximumChargeForLlmRequest,
  type PersonaConfig,
} from '@tangle-network/agent-eval'

type PersonaRigor = NonNullable<PersonaConfig['rigor']>

/**
 * Per-rigor stance the driver adopts. Scales how hard the simulated user
 * interrogates the agent — see `PersonaConfig.rigor`.
 */
const RIGOR_STANCE: Record<PersonaRigor, string> = {
  cooperative:
    'Your stance: a pragmatic early adopter. You accept reasonable answers and only push back on clear gaps or outright errors.',
  demanding:
    'Your stance: an experienced professional with no time to waste. You do not accept vague, hedged, or generic answers — you expect specifics, and you say so plainly when you do not get them.',
  relentless:
    'Your stance: a senior partner reviewing this work for a client who will litigate if it is wrong. You interrogate every claim. You accept nothing undefended. You find the single weakest point in every answer and attack it. Courteous, never satisfied.',
}

/** Describe which nominal completion criteria are met, for the driver prompt. */
function describeCompletion(persona: PersonaConfig, state: DriverState): string {
  const results = persona.completionCriteria.map((c) => {
    const met = c.check(state)
    return `${c.name}: ${met ? 'MET' : 'NOT MET'}`
  })
  const metCount = results.filter((r) => r.includes('MET') && !r.includes('NOT')).length
  return `${metCount}/${persona.completionCriteria.length} — ${results.join(', ')}`
}

/**
 * Build the driver's system prompt. The simulated user judges the agent's last
 * response by a professional standard, refuses vague answers, challenges
 * undefended claims, probes the persona's pressure points without revealing
 * them, and signs off only when a real practitioner would act on the work
 * unmodified. Pure function of persona, produced state, and product context.
 */
export function buildPersonaDriverSystemPrompt(
  persona: PersonaConfig,
  state: DriverState,
  productContext = '',
): string {
  const rigor: PersonaRigor = persona.rigor ?? 'demanding'
  const expertise = persona.expertise ? ` You are ${persona.expertise}.` : ''

  const pressure =
    persona.pressurePoints && persona.pressurePoints.length > 0
      ? `\nA competent ${persona.role} here MUST get the agent to address each of:\n${persona.pressurePoints
          .map((p) => `  - ${p}`)
          .join(
            '\n',
          )}\nDo NOT hand these to the agent. Probe whether it surfaces them itself. If it misses one, press on exactly that gap until it delivers or demonstrably fails.\n`
      : ''

  const curveballs =
    persona.curveballs && persona.curveballs.length > 0
      ? `\nOnce the agent is coasting on easy answers, introduce ONE of these as a genuine new development — never as a quiz:\n${persona.curveballs
          .map((c) => `  - ${c}`)
          .join('\n')}\n`
      : ''

  return `You are role-playing a real ${persona.role} putting an AI agent through its paces.${expertise}
Your objective: ${persona.goal}
You are deciding whether this agent's work is good enough to stake your professional reputation on. Assume it is not — until it proves otherwise.

${RIGOR_STANCE[rigor]}
${productContext ? `Product context:\n${productContext}\n` : ''}Current workspace state:
- Tasks: ${state.tasks} | Events: ${state.events}
- Proposals: pending=${state.proposals.pending}, approved=${state.proposals.approved}, rejected=${state.proposals.rejected}
- Vault files (${state.vaultFiles.length}): ${state.vaultFiles.slice(0, 10).join(', ')}${state.vaultFiles.length > 10 ? ' …' : ''}
- Nominal task criteria: ${describeCompletion(persona, state)}
${pressure}${curveballs}
How to choose your next message:
1. Silently judge the agent's last response the way a ${persona.role} would. Is every claim defended with a specific authority, figure, or mechanism? Or is it vague, hedged, or generic?
2. If it is vague or hand-waved — do NOT move on. Name the gap and demand the specific authority / figure / mechanism. "It depends" is not an answer; force the decision.
3. If it makes a claim you can challenge — challenge it. Make the agent defend or correct it.
4. If it missed something a ${persona.role} would catch — press on exactly that, without naming it for the agent.
5. If it is genuinely solid — escalate: go a layer deeper, or introduce a curveball.
6. First message — state your situation as you really would: realistic, specific, with the messy detail, but do not coach the agent.

Sign-off: respond with exactly "DONE" only when a ${persona.role} would act on this work without redoing it. Nominal task completion is NOT sign-off — sloppy-but-complete still fails. If the agent never gets there, keep pushing; never sign off on weak work.

Output ONLY your next message to the agent — in character, first person, no meta-commentary, no stage directions.`
}

export interface DecidePersonaTurnOpts {
  persona: PersonaConfig
  state: DriverState
  /** Conversation so far — alternating user/assistant messages, oldest first. */
  history: { role: string; content: string }[]
  /** Optional product context woven into the driver prompt. */
  productContext?: string
  /** Driver model. */
  model: string
  /** Cost-ledger actor for the driver-leg call, and the served-model guard context. */
  actor: string
  /** Shared account for the paid driver call. */
  costLedger?: CostLedgerHandle
  /** Attribution tags merged into the paid-call receipt. */
  costTags?: Record<string, string>
}

/**
 * Decide the simulated user's next turn. Returns the next user message, or the
 * literal `DONE` when the simulated professional would sign off.
 */
export async function decidePersonaTurn(
  chat: ChatClient,
  opts: DecidePersonaTurnOpts,
): Promise<string> {
  const { persona, state, history, productContext = '', model, actor } = opts

  const lastResponse =
    history.length > 0
      ? history[history.length - 1]!.content.slice(0, 2000)
      : '(no conversation yet — this is the first message)'

  const recentHistory = history
    .slice(-6)
    .map((h) => `${h.role}: ${h.content.slice(0, 500)}`)
    .join('\n\n')

  const request = {
    model,
    messages: [
      { role: 'system', content: buildPersonaDriverSystemPrompt(persona, state, productContext) },
      {
        role: 'user',
        content: recentHistory
          ? `Recent conversation:\n${recentHistory}\n\nThe agent's latest response:\n${lastResponse}`
          : 'No conversation yet. Send your opening message — in character, phrased as this person actually would.',
      },
    ],
    temperature: 0.5,
    maxTokens: 700,
  } satisfies ChatRequest
  const paid = await (opts.costLedger ?? new CostLedger()).runPaidCall({
    channel: 'driver',
    phase: 'driver-turn',
    actor,
    model,
    tags: opts.costTags,
    maximumCharge:
      chat.maximumAttempts === undefined
        ? undefined
        : maximumChargeForLlmRequest(request, { maximumAttempts: chat.maximumAttempts }),
    execute: (signal, callId) => chat.chat(request, { signal, idempotencyKey: callId }),
    receipt: costReceiptFromLlm,
    receiptFromError: costReceiptFromLlmError,
  })
  if (!paid.succeeded) throw paid.error
  // Hold the transport to its own word: a persona turn written by a different
  // model is not this driver model's behaviour. A transport that echoes no id
  // cannot be made to prove identity here.
  assertServedModel(model, paid.value.servedModel, {
    allowUnreported: true,
    context: actor,
  })
  return paid.value.content.trim()
}
