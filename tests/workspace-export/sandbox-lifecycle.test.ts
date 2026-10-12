import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
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

  it('cancels and restores an unfinished archive when a segment write fails', async () => {
    const { box, archive } = boxFixture()
    let stopped!: () => void
    let finishStop!: () => void
    const stopStarted = new Promise<void>((resolve) => { stopped = resolve })
    const stopFinished = new Promise<void>((resolve) => { finishStop = resolve })
    box.stop.mockImplementation(async () => {
      stopped()
      await stopFinished
      box.status = 'stopped'
    })
    // A large valid tar, with incompressible content, fills one 8 MiB segment
    // before the source reaches EOF. Its final bytes are deliberately withheld.
    const size = 10 * 1024 * 1024
    const header = Buffer.alloc(512)
    header.write('large.bin')
    header.write('0000644\0', 100)
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
    header.fill(32, 148, 156)
    header.write('0', 156)
    header.write('ustar\0', 257)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
    const bytes = gzipSync(Buffer.concat([header, randomBytes(size), Buffer.alloc(1024)]))
    let offset = 0
    const cancel = vi.fn()
    box.fs.openArchive.mockResolvedValue(new ReadableStream({
      pull(controller) {
        if (offset >= 9 * 1024 * 1024) return
        controller.enqueue(bytes.subarray(offset, offset + 64 * 1024))
        offset += 64 * 1024
      },
      cancel,
    }))
    const storage = createMemoryExportStorage()
    const put = storage.put.bind(storage)
    const error = new Error('segment storage failed')
    storage.put = async (key, body, options) => {
      if (key.includes('/u/')) throw error
      return put(key, body, options)
    }
    const engine = createExportEngine({ app: 'test', storage, plan: async () => ({ sources: [archive] }) })
    const job = await engine.start('ws-storage-failure', 'owner')
    let settled = false
    const advancing = engine.advance('ws-storage-failure', job.id).then((result) => { settled = true; return result })
    await stopStarted
    // Yield an event-loop turn so an incorrectly detached cancellation can
    // settle the job. No duration or machine-speed threshold is involved.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(box.stop).toHaveBeenCalledTimes(1)
    finishStop()
    const result = await advancing
    expect(result?.units[0]).toMatchObject({ status: 'pending', attempts: 1, error: error.message, entries: [] })
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledExactlyOnceWith(error)
    expect(box.status).toBe('stopped')
    expect(offset).toBeLessThan(bytes.length)
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
