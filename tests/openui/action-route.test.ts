import { describe, expect, it, vi } from 'vitest'

import {
  createOpenUIActionRoute,
  describeOpenUIAction,
  validateOpenUIActionBody,
  type OpenUIActionHandler,
  type OpenUIActionRouteOptions,
  type OpenUIFormSpec,
} from '../../src/openui/index'

interface Ctx {
  workspaceId: string
}

const FORM: OpenUIFormSpec = {
  id: 'contrib',
  fields: [
    { id: 'amount', kind: 'currency', min: 0, max: 7000 },
    { id: 'catchup', kind: 'checkbox' },
  ],
}

function post(body: unknown, url = 'https://app.example/api/openui/action'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const silent = { warn: () => {}, error: () => {} }

function route(
  actions: Record<string, OpenUIActionHandler<Ctx>>,
  extra: Partial<OpenUIActionRouteOptions<Ctx>> = {},
) {
  return createOpenUIActionRoute<Ctx>({
    resolve: () => ({ ok: true, context: { workspaceId: 'w1' } }),
    actions,
    logger: silent,
    ...extra,
  })
}

describe('validateOpenUIActionBody', () => {
  it('parses a full submission', () => {
    const result = validateOpenUIActionBody({
      actionId: 'recalculate',
      formId: 'contrib',
      nodeId: 'card_1',
      artifactPath: 'ui/thread-1/contributions.json',
      values: { amount: 6500, catchup: true, tags: ['a'] },
    })
    expect(result).toEqual({
      ok: true,
      submission: {
        actionId: 'recalculate',
        formId: 'contrib',
        nodeId: 'card_1',
        artifactPath: 'ui/thread-1/contributions.json',
        values: { amount: 6500, catchup: true, tags: ['a'] },
      },
    })
  })

  it('defaults values to an empty object for a bare action', () => {
    const result = validateOpenUIActionBody({ actionId: 'refresh' })
    expect(result).toEqual({ ok: true, submission: { actionId: 'refresh', values: {} } })
  })

  it('names the reason for every rejection', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'OPENUI_ACTION_ID_MISSING'],
      [{ actionId: 'has space' }, 'OPENUI_ACTION_ID_INVALID'],
      [{ actionId: 'go', formId: 'bad id' }, 'OPENUI_FORM_ID_INVALID'],
      [{ actionId: 'go', nodeId: 'bad id' }, 'OPENUI_NODE_ID_INVALID'],
      [{ actionId: 'go', artifactPath: '../secrets' }, 'OPENUI_ARTIFACT_PATH_INVALID'],
      [{ actionId: 'go', artifactPath: '/etc/passwd' }, 'OPENUI_ARTIFACT_PATH_INVALID'],
      [{ actionId: 'go', values: [] }, 'OPENUI_VALUES_INVALID'],
      // JSON.parse produces a real own `__proto__` key, which an object literal
      // cannot — this is the shape a browser can actually POST.
      [{ actionId: 'go', values: JSON.parse('{"__proto__":1}') as unknown }, 'OPENUI_FIELD_ID_INVALID'],
      [{ actionId: 'go', values: { a: { nested: true } } }, 'OPENUI_FIELD_VALUE_INVALID'],
      [{ actionId: 'go', values: { a: [1, 2] } }, 'OPENUI_FIELD_VALUE_INVALID'],
    ]
    for (const [body, code] of cases) {
      const result = validateOpenUIActionBody(body)
      expect(result.ok, `${JSON.stringify(body)} should be rejected`).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe(code)
    }
  })
})

describe('createOpenUIActionRoute', () => {
  it('runs the registered handler and returns its payload', async () => {
    const handled = route({
      recalculate: ({ submission, context }) => ({
        ok: true,
        message: 'Recalculated.',
        data: { total: Number(submission.values.amount) * 2, workspaceId: context.workspaceId },
      }),
    })
    const response = await handled.handle(post({ actionId: 'recalculate', values: { amount: 100 } }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      actionId: 'recalculate',
      message: 'Recalculated.',
      data: { total: 200, workspaceId: 'w1' },
    })
  })

  it('returns a replacement page and corrected values', async () => {
    const handled = route({
      recalculate: () => ({
        ok: true,
        values: { amount: 7000 },
        schema: [{ type: 'stat', label: 'Total', value: '$7,000' }],
      }),
    })
    const response = await handled.handle(post({ actionId: 'recalculate', values: { amount: 9999 } }))
    expect(await response.json()).toEqual({
      ok: true,
      actionId: 'recalculate',
      values: { amount: 7000 },
      schema: [{ type: 'stat', label: 'Total', value: '$7,000' }],
    })
  })

  it('404s an action id nobody registered instead of doing nothing', async () => {
    const handled = route({ recalculate: () => ({ ok: true }) })
    const response = await handled.handle(post({ actionId: 'sign_and_file' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ ok: false, code: 'OPENUI_ACTION_UNKNOWN', actionId: 'sign_and_file' })
  })

  it('does not treat an inherited object key as a registered action', async () => {
    const handled = route({ recalculate: () => ({ ok: true }) })
    const response = await handled.handle(post({ actionId: 'toString' }))
    expect(response.status).toBe(404)
  })

  it('refuses an unknown action before running the product authorizer', async () => {
    const resolve = vi.fn(() => ({ ok: true as const, context: { workspaceId: 'w1' } }))
    const handled = route({ known: () => ({ ok: true }) }, { resolve })
    await handled.handle(post({ actionId: 'unknown' }))
    expect(resolve).not.toHaveBeenCalled()
  })

  it('short-circuits with the product authorizer response', async () => {
    const handled = route(
      { recalculate: () => ({ ok: true }) },
      { resolve: () => ({ ok: false, response: new Response('nope', { status: 401 }) }) },
    )
    const response = await handled.handle(post({ actionId: 'recalculate' }))
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('nope')
  })

  it('checks values against the named form and reports field issues', async () => {
    const handler = vi.fn(() => ({ ok: true as const }))
    const handled = route({ recalculate: handler }, { forms: { contrib: FORM } })
    const response = await handled.handle(
      post({ actionId: 'recalculate', formId: 'contrib', values: { amount: 9999 } }),
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      ok: false,
      code: 'OPENUI_VALUES_REJECTED',
      issues: [{ fieldId: 'amount', code: 'range' }],
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('hands the handler the checked values, not the raw body', async () => {
    const seen: Array<Record<string, unknown>> = []
    const handled = route(
      {
        recalculate: ({ submission }) => {
          seen.push(submission.values)
          return { ok: true }
        },
      },
      { forms: { contrib: FORM } },
    )
    await handled.handle(post({ actionId: 'recalculate', formId: 'contrib', values: { amount: 100 } }))
    expect(seen).toEqual([{ amount: 100 }])
  })

  it('leaves checking to the handler when the form is not registered', async () => {
    const handled = route({ recalculate: () => ({ ok: true }) }, { forms: { other: FORM } })
    const response = await handled.handle(
      post({ actionId: 'recalculate', formId: 'contrib', values: { anything: 'goes' } }),
    )
    expect(response.status).toBe(200)
  })

  it('passes a handler failure through with its code and status', async () => {
    const handled = route({
      file: () => ({ ok: false, code: 'RETURN_LOCKED', message: 'This return is already filed.', status: 409 }),
    })
    const response = await handled.handle(post({ actionId: 'file' }))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'RETURN_LOCKED',
      error: 'This return is already filed.',
      actionId: 'file',
    })
  })

  it('turns a thrown handler into a 500 rather than a silent success', async () => {
    const error = vi.fn()
    const handled = route(
      {
        boom: () => {
          throw new Error('db down')
        },
      },
      { logger: { warn: () => {}, error } },
    )
    const response = await handled.handle(post({ actionId: 'boom' }))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false, code: 'OPENUI_ACTION_FAILED' })
    expect(error).toHaveBeenCalled()
  })

  it('rejects a non-POST request', async () => {
    const handled = route({ recalculate: () => ({ ok: true }) })
    const response = await handled.handle(new Request('https://app.example/a', { method: 'GET' }))
    expect(response.status).toBe(405)
  })

  it('rejects a body that is not a JSON object', async () => {
    const handled = route({ recalculate: () => ({ ok: true }) })
    const bad = new Request('https://app.example/a', { method: 'POST', body: 'not json' })
    const response = await handled.handle(bad)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'OPENUI_BODY_INVALID' })
  })

  it('records the agent-facing note after a success, without starting anything', async () => {
    const recordForAgent = vi.fn()
    const handled = route({ recalculate: () => ({ ok: true }) }, { recordForAgent })
    await handled.handle(post({ actionId: 'recalculate', formId: 'contrib', values: { amount: 6500 } }))
    expect(recordForAgent).toHaveBeenCalledTimes(1)
    expect(recordForAgent.mock.calls[0]?.[0]).toMatchObject({
      note: 'User pressed "recalculate" on form "contrib" with amount=6500.',
      context: { workspaceId: 'w1' },
    })
  })

  it('does not record a note for a refused action', async () => {
    const recordForAgent = vi.fn()
    const handled = route({ nope: () => ({ ok: false, code: 'X', message: 'no' }) }, { recordForAgent })
    await handled.handle(post({ actionId: 'nope' }))
    expect(recordForAgent).not.toHaveBeenCalled()
  })

  it('still succeeds when recording the note fails', async () => {
    const warn = vi.fn()
    const handled = route(
      { recalculate: () => ({ ok: true }) },
      {
        recordForAgent: () => {
          throw new Error('thread gone')
        },
        logger: { warn, error: () => {} },
      },
    )
    const response = await handled.handle(post({ actionId: 'recalculate' }))
    expect(response.status).toBe(200)
    expect(warn).toHaveBeenCalled()
  })
})

describe('describeOpenUIAction', () => {
  it('writes one line the next turn can read', () => {
    expect(
      describeOpenUIAction({ actionId: 'recalculate', formId: 'contrib', values: { amount: 6500, catchup: true } }),
    ).toBe('User pressed "recalculate" on form "contrib" with amount=6500, catchup=true.')
  })

  it('handles a bare action and a multi-select', () => {
    expect(describeOpenUIAction({ actionId: 'refresh', values: {} })).toBe('User pressed "refresh".')
    expect(describeOpenUIAction({ actionId: 'apply', values: { tags: ['a', 'b'] } })).toBe(
      'User pressed "apply" with tags=a, b.',
    )
  })
})
