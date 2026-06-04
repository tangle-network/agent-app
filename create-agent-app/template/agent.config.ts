/**
 * agent.config.ts — the DATA surface of this agent product.
 *
 * This is the ONE file you fill to define who the agent is, what it may propose,
 * what knowledge gates its loop, and which integrations it connects. It is plain
 * data consumed by `@tangle-network/agent-app`'s modules through typed seams —
 * NOT behavior. Do not put control flow here; that lives in `src/` (the chat
 * route + composer). See CUSTOMIZE.md for the ordered fill-checklist and AGENTS.md
 * for the layering contract.
 *
 * Every field below is stubbed with a placeholder. Replace the placeholders; keep
 * the shape. `pnpm typecheck` proves the shape; `pnpm test` proves the wiring.
 */

import { defineAgentApp } from '@tangle-network/agent-app/config'

export const config = defineAgentApp({
  // ① IDENTITY — who is the agent? (Discovery: "Whose job does this do, in whose
  //    voice, under what hard rules?")
  identity: {
    name: '__PROJECT_NAME__',
    persona:
      'You are an operations partner for <DOMAIN>. You automate the standing ' +
      'workflows, stay grounded in real records, and route every regulated or ' +
      'client-facing step to a named human for approval. Replace this paragraph ' +
      'with the real persona — it is the spine of the system prompt.',
    // Standing workflows, hard rules, tone — appended verbatim after the persona.
    systemPromptFragments: [
      'Never fabricate a figure (price, coverage, identifier, regulatory clause). ' +
        'Cite a real record or say NOT ON FILE.',
    ],
    // Named disclaimers the UI / chat pipeline can select by id.
    disclaimers: {
      'not-advice':
        'This assistant prepares proposals for a licensed human to review and ' +
        'approve. It does not itself give regulated advice or take regulated action.',
    },
  },

  // ② TAXONOMY — what can the agent PROPOSE, and which proposals are regulated?
  //    (Discovery: "Which actions change client state or are legally gated, so a
  //    certified human must approve before they execute?")
  //    `regulatedTypes` MUST be a subset of `proposalTypes`. Regulated proposals
  //    CANNOT execute without a named certified approver — this is the
  //    human-in-the-loop invariant. Keep regulated steps regulated.
  taxonomy: {
    proposalTypes: ['contact_lead', 'client_outreach', 'policy_change'],
    regulatedTypes: ['policy_change'],
  },

  // ③ KNOWLEDGE — what must the agent KNOW before it acts, and where does it learn?
  //    (Discovery: "What facts gate the loop — what's the minimum the agent must
  //    have grounded before it's allowed to propose?")
  //    `requirements` are declarative gates scored from workspace state by the
  //    Cloudflare preset's KnowledgeStateAccessor (config-set or rows-exist rules).
  //    `sources` are what the acquisition loop may read. `loop` tunes the gate.
  knowledge: {
    sources: [
      // Domain docs you drop in ./knowledge are read as `vault://` sources.
      { uri: 'vault://knowledge', kind: 'vault' },
      // Add web / regulation / integration sources the researcher may pull from.
      // { uri: 'https://example.gov/regulation', kind: 'regulation' },
    ],
    requirements: [
      {
        id: 'workspace-profile-set',
        description: 'The workspace has a configured business profile.',
        category: 'company_specific',
        acquisitionMode: 'ask_user',
        importance: 'blocking',
        freshness: 'static',
        // Satisfied when a config dot-path is set on the workspace.
        satisfiedBy: { config: 'profile.businessName', nonEmpty: true },
      },
      {
        id: 'has-client-records',
        description: 'At least one client/lead record exists to ground outreach.',
        category: 'domain_specific',
        acquisitionMode: 'query_connector',
        importance: 'high',
        freshness: 'daily',
        // Satisfied when >= 1 row exists in a workspace-scoped table.
        satisfiedBy: { table: 'knowledge', minRows: 1 },
      },
    ],
    loop: {
      goal: 'Ground every client-facing claim against a real record before proposing.',
      minConfidence: 0.7,
      freshness: 'session',
    },
  },

  // ⑤ INTEGRATIONS — what systems does the agent read/write through?
  //    (Discovery: "Which CRMs / data sources / messaging channels does the
  //    workflow touch?") These are @tangle-network/agent-integrations catalog
  //    kinds. Reads run immediately; writes return approval-required → a proposal.
  integrations: {
    enabled: [
      // 'lead-crm',
      // 'whatsapp',
    ],
  },

  // UI — may the agent emit generated views (render_ui)? Optional.
  ui: {
    generatedUi: true,
  },

  // MODEL — omit to resolve from env (TANGLE_API_KEY) at boot via
  // resolveTangleModelConfig. Pin here only if you need a fixed model.
})

export type Config = typeof config
