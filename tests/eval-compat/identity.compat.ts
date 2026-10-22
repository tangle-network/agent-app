import { CostLedger, resolveModelPricing } from '@tangle-network/agent-eval'
import { CostLedger as retainedCostLedger } from 'agent-eval-0204'
import { CostLedger as currentLineCostLedger } from 'agent-eval-0211'
import { CostLedger as nextLineCostLedger } from 'agent-eval-0217'
import { CostLedger as previousFloorCostLedger } from 'agent-eval-0218'
import { CostLedger as candidateCostLedger } from 'agent-eval-0219'
import { expect, it } from 'vitest'

const compat = process.env.AGENT_EVAL_COMPAT ?? 'agent-eval-0204'
const compatCostLedger: Record<string, unknown> = {
  'agent-eval-0204': retainedCostLedger,
  'agent-eval-0211': currentLineCostLedger,
  'agent-eval-0217': nextLineCostLedger,
  'agent-eval-0218': previousFloorCostLedger,
  'agent-eval-0219': candidateCostLedger,
}

it('executes the compat Eval package instead of the current development peer', () => {
  expect(CostLedger).toBe(compatCostLedger[compat])
})

it.runIf(compat === 'agent-eval-0211')('prices the default Router model on the 0.211 line', () => {
  expect(resolveModelPricing('gpt-6-luna')).toEqual({ input: 0.0001, output: 0.0005 })
})
