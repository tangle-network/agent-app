import { describe, expect, it } from 'vitest'

import {
  buildAgentMissionPlan,
  DEFAULT_MISSION_STEP_KINDS,
  parseMissionBlocks,
} from '../src/missions/index'

describe('parseMissionBlocks', () => {
  it('parses a well-formed block into title + typed steps', () => {
    const content = [
      'Here is the plan:',
      ':::mission',
      'title: Hook-pattern study',
      'collect: research | Gather 20 recent videos with metadata',
      'analyze-hooks: analyze | Extract the opening-hook patterns',
      'report: write | Deliver the findings report',
      ':::',
    ].join('\n')

    expect(parseMissionBlocks(content)).toEqual([
      {
        title: 'Hook-pattern study',
        steps: [
          { id: 'collect', kind: 'research', intent: 'Gather 20 recent videos with metadata' },
          { id: 'analyze-hooks', kind: 'analyze', intent: 'Extract the opening-hook patterns' },
          { id: 'report', kind: 'write', intent: 'Deliver the findings report' },
        ],
      },
    ])
  })

  it('drops unknown kinds and malformed step lines, and skips block-less prose', () => {
    const content = [
      ':::mission',
      'title: Mixed quality',
      'good: research | Real step',
      'bad-kind: teleport | Not a known kind',
      'no pipe separator here',
      ':::',
    ].join('\n')

    const [mission] = parseMissionBlocks(content)
    expect(mission?.steps).toEqual([{ id: 'good', kind: 'research', intent: 'Real step' }])
    expect(parseMissionBlocks('just prose, no block')).toEqual([])
  })

  it('yields nothing for a block missing a title or valid steps (never guess a plan)', () => {
    expect(parseMissionBlocks(':::mission\nstep-1: research | No title here\n:::')).toEqual([])
    expect(parseMissionBlocks(':::mission\ntitle: Steps all invalid\nx: unknown | nope\n:::')).toEqual([])
  })

  it('accepts a custom kind vocabulary as a parameter', () => {
    const content = ':::mission\ntitle: Custom kinds\ndeploy-step: deploy | Ship the artifact\n:::'
    expect(parseMissionBlocks(content)).toEqual([])
    expect(parseMissionBlocks(content, { kinds: ['deploy'] })).toEqual([
      { title: 'Custom kinds', steps: [{ id: 'deploy-step', kind: 'deploy', intent: 'Ship the artifact' }] },
    ])
    expect(DEFAULT_MISSION_STEP_KINDS).toEqual(['research', 'generate', 'analyze', 'write', 'best-effort'])
  })

  it('parses multiple blocks in one message', () => {
    const content = [
      ':::mission\ntitle: First\na: research | one\n:::',
      'between',
      ':::mission\ntitle: Second\nb: write | two\n:::',
    ].join('\n')
    expect(parseMissionBlocks(content).map((m) => m.title)).toEqual(['First', 'Second'])
  })
})

describe('buildAgentMissionPlan', () => {
  it('materializes parsed steps as pending plan steps with zero attempts', () => {
    const plan = buildAgentMissionPlan([
      { id: 'a', kind: 'research', intent: 'one' },
      { id: 'b', kind: 'best-effort', intent: 'two' },
    ])
    expect(plan).toEqual([
      { id: 'a', intent: 'one', kind: 'research', status: 'pending', attempts: 0 },
      { id: 'b', intent: 'two', kind: 'best-effort', status: 'pending', attempts: 0 },
    ])
  })

  it('rejects empty plans and duplicate step ids (fail loud)', () => {
    expect(() => buildAgentMissionPlan([])).toThrow('at least one step')
    expect(() =>
      buildAgentMissionPlan([
        { id: 'dup', kind: 'research', intent: 'one' },
        { id: 'dup', kind: 'write', intent: 'two' },
      ]),
    ).toThrow('duplicate mission step id "dup"')
  })
})
