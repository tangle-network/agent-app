import { CostLedger } from '@tangle-network/agent-eval'
import { CostLedger as retainedCostLedger } from 'agent-eval-0204'
import { expect, it } from 'vitest'

it('executes the retained Eval package instead of the current development peer', () => {
  expect(CostLedger).toBe(retainedCostLedger)
})
