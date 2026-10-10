import { CostLedger, resolveModelPricing } from '@tangle-network/agent-eval'
import { CostLedger as retainedCostLedger } from 'agent-eval-0204'
import { CostLedger as currentLineCostLedger } from 'agent-eval-0211'
import { expect, it } from 'vitest'

const compat = process.env.AGENT_EVAL_COMPAT ?? 'agent-eval-0204'

it('executes the compat Eval package instead of the current development peer', () => {
  expect(CostLedger).toBe(compat === 'agent-eval-0211' ? currentLineCostLedger : retainedCostLedger)
})

it.runIf(compat === 'agent-eval-0211')('prices the default Router model on the 0.211 line', () => {
  expect(resolveModelPricing('gpt-6-luna')).toEqual({ input: 0.0001, output: 0.0005 })
})
