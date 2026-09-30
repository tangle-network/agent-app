// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceAppDataHost, WorkspaceAppDataConflict } from './data-bridge'

const previewUrl = 'https://sandbox-123-4000.tangle.sh/'
const app = { id: 'notes', previewUrl, status: 'ready' as const }
const protocol = 'tangle.workspace-app-data.v1'
const hosts: Array<{ dispose(): void }> = []
afterEach(() => { for (const host of hosts.splice(0)) host.dispose() })

function setup() {
  const frame = document.createElement('iframe')
  frame.src = previewUrl
  document.body.append(frame)
  const reply = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => undefined)
  const read = vi.fn(async () => ({ value: 'saved', revision: 3 }))
  const write = vi.fn(async () => ({ revision: 4 }))
  const remove = vi.fn(async () => undefined)
  hosts.push(createWorkspaceAppDataHost({ app, frame, read, write, remove }))
  const send = (data: Record<string, unknown>, origin = new URL(previewUrl).origin, source: MessageEventSource | null = frame.contentWindow) => {
    window.dispatchEvent(new MessageEvent('message', {
      data: { protocol, appId: app.id, requestId: 'request_1', ...data }, origin, source,
    }))
  }
  return { frame, reply, read, write, remove, send }
}

describe('workspace app data host boundary', () => {
  it('ignores another frame, preview origin, or app ID', async () => {
    const { frame, reply, read, send } = setup()
    send({ action: 'read', key: 'notes' }, 'https://attacker.example')
    send({ action: 'read', key: 'notes' }, new URL(previewUrl).origin, window)
    send({ action: 'read', key: 'notes', appId: 'other-app' })
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
    frame.remove()
  })

  it('limits values and keys, then passes revision-checked writes once', async () => {
    const { frame, reply, write, send } = setup()
    send({ action: 'write', key: '../cross-app', value: 'data', expectedRevision: null })
    send({ action: 'write', key: 'notes', value: '💾'.repeat(20_000), expectedRevision: null })
    expect(write).not.toHaveBeenCalled()
    send({ action: 'write', key: 'notes', value: 'durable', expectedRevision: 3 })
    await vi.waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith('notes', 'durable', 3))
    expect(reply).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, revision: 4 }), new URL(previewUrl).origin)
    frame.remove()
  })

  it('returns a bounded conflict without leaking storage errors', async () => {
    const { frame, reply, write, send } = setup()
    write.mockRejectedValueOnce(new WorkspaceAppDataConflict())
    send({ action: 'write', key: 'notes', value: 'new', expectedRevision: 2 })
    await vi.waitFor(() => expect(reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ok: false, error: 'conflict' }), new URL(previewUrl).origin,
    ))
    frame.remove()
  })
})

it('limits message floods from the registered frame', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  try {
    const { frame, reply, send } = setup()
    for (let index = 0; index < 65; index += 1) send({ action: 'ready' })
    expect(reply).toHaveBeenCalledTimes(64)
    frame.remove()
  } finally { clock.mockRestore() }
})
