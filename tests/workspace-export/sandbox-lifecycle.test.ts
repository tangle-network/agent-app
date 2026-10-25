import { describe, expect, it, vi } from 'vitest'
import { createExportEngine, createMemoryExportStorage, sandboxArchive, sandboxFiles } from '../../src/workspace-export'

function boxFixture(status = 'stopped') {
  const box = {
    status,
    resume: vi.fn(async () => { box.status = 'running' }),
    stop: vi.fn(async () => { box.status = 'stopped' }),
    waitFor: vi.fn(async () => {}),
    fs: {
      openArchive: vi.fn(async () => new Blob(['archive']).stream() as ReadableStream<Uint8Array>),
      read: vi.fn(async () => 'document'),
    },
  }
  const archive = sandboxArchive({ name: 'box', getBox: async () => box })
  return { box, archive }
}

describe('sandbox source restoration', () => {
  it.each(['archive', 'files'])('restores a resumed %s box when readiness fails, retaining the error', async (kind) => {
    const { box, archive } = boxFixture()
    const error = new Error('readiness timed out')
    box.waitFor.mockRejectedValue(error)
    box.stop.mockImplementation(() => { throw new Error('cleanup also failed') })
    const result = kind === 'archive'
      ? archive.open()
      : sandboxFiles({ name: 'docs', getBox: async () => box, list: async () => [{ path: 'one', boxPath: 'one' }] }).files()[Symbol.asyncIterator]().next()
    await expect(result).rejects.toBe(error)
    expect(box.resume).toHaveBeenCalledTimes(1)
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.fs.openArchive).not.toHaveBeenCalled()
    expect(box.fs.read).not.toHaveBeenCalled()
  })

  it('does not stop a box whose resume was refused', async () => {
    const { box, archive } = boxFixture()
    const error = new Error('resume refused')
    box.resume.mockRejectedValue(error)
    await expect(archive.open()).rejects.toBe(error)
    expect(box.stop).not.toHaveBeenCalled()
    expect(box.waitFor).not.toHaveBeenCalled()
  })

  it('restores exactly once when opening the archive fails, retaining the original error', async () => {
    const { box, archive } = boxFixture()
    const error = new Error('open failed')
    box.fs.openArchive.mockRejectedValue(error)
    box.stop.mockRejectedValue(new Error('cleanup also failed'))
    await expect(archive.open()).rejects.toBe(error)
    expect(box.stop).toHaveBeenCalledTimes(1)
  })

  it('restores once after a successful archive and preserves its bytes', async () => {
    const { box, archive } = boxFixture()
    const stream = await archive.open()
    expect(await new Response(stream).text()).toBe('archive')
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.status).toBe('stopped')
  })

  it('restores once when the archive stream errors, retaining the stream error', async () => {
    const { box, archive } = boxFixture()
    const error = new Error('stream failed')
    box.fs.openArchive.mockResolvedValue(new ReadableStream({ start(controller) { controller.error(error) } }))
    box.stop.mockRejectedValue(new Error('cleanup also failed'))
    const stream = await archive.open()
    await expect(new Response(stream).arrayBuffer()).rejects.toBe(error)
    expect(box.stop).toHaveBeenCalledTimes(1)
  })

  it('cancels an active archive read and restores exactly once with the original cancellation reason', async () => {
    const { box, archive } = boxFixture()
    const cancel = vi.fn()
    box.fs.openArchive.mockResolvedValue(new ReadableStream({ cancel }))
    const stream = await archive.open()
    const reader = stream!.getReader()
    const pending = reader.read()
    const reason = new Error('owner cancelled')
    await reader.cancel(reason)
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason)
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.status).toBe('stopped')
  })

  it('restores on cancellation even if source cancellation rejects, retaining that error', async () => {
    const { box, archive } = boxFixture()
    const error = new Error('source cancel failed')
    box.fs.openArchive.mockResolvedValue(new ReadableStream({ cancel() { throw error } }))
    box.stop.mockRejectedValue(new Error('cleanup also failed'))
    const stream = await archive.open()
    await expect(stream!.cancel('cancelled')).rejects.toBe(error)
    expect(box.stop).toHaveBeenCalledTimes(1)
  })

  it.each(['complete', 'error', 'cancel'])('keeps an already-running box running on archive %s', async (exit) => {
    const { box, archive } = boxFixture('running')
    if (exit === 'error') box.fs.openArchive.mockResolvedValue(new ReadableStream({ start(c) { c.error(new Error('failed')) } }))
    if (exit === 'cancel') box.fs.openArchive.mockResolvedValue(new ReadableStream())
    const stream = await archive.open()
    if (exit === 'cancel') await stream!.cancel()
    else if (exit === 'error') await expect(new Response(stream).text()).rejects.toThrow('failed')
    else expect(await new Response(stream).text()).toBe('archive')
    expect(box.resume).not.toHaveBeenCalled()
    expect(box.stop).not.toHaveBeenCalled()
    expect(box.status).toBe('running')
  })
})

describe('file request bounds', () => {
  it('counts null opens against the 200-file cap and continues without reopening them', async () => {
    const open = vi.fn(async () => null)
    const engine = createExportEngine({
      app: 'test',
      storage: createMemoryExportStorage(),
      plan: async () => ({
        sources: [{
          kind: 'files', name: 'gone', dataClass: 'knowledge',
          async *files() {
            for (let index = 0; index < 401; index += 1) yield { path: `${index}.txt`, open }
          },
        }],
      }),
    })
    const job = await engine.start('ws-bounds', 'owner')
    for (const count of [200, 400]) {
      const progress = await engine.advance('ws-bounds', job.id)
      expect(progress?.units[0]).toMatchObject({ status: 'pending', cursor: count, entries: [] })
      expect(open).toHaveBeenCalledTimes(count)
    }
    const complete = await engine.advance('ws-bounds', job.id)
    expect(complete?.status).toBe('complete')
    expect(complete?.units[0]).toMatchObject({ status: 'empty', files: 0 })
    expect(open).toHaveBeenCalledTimes(401)
  })
})
