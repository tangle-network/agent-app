import { describe, expect, it, vi } from 'vitest'
import {
  createExportEngine,
  createMemoryExportStorage,
  sandboxFiles,
  type ArchivableBox,
} from '../../src/workspace-export'

const WS = 'ws-sandbox-files'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(count: number, initialStatus = 'stopped') {
  const listed = Array.from({ length: count }, (_, index) => ({
    path: `document-${index}.txt`,
    boxPath: `.vault/objects/${index}`,
  }))
  const contents = new Map(listed.map((file) => [file.boxPath, `Content for ${file.path}`]))
  const box = {
    status: initialStatus,
    resume: vi.fn(async () => { box.status = 'running' }),
    stop: vi.fn(async () => { box.status = 'stopped' }),
    waitFor: vi.fn(async () => {}),
    fs: {
      openArchive: vi.fn(async () => new ReadableStream<Uint8Array>()),
      read: vi.fn(async function (this: ArchivableBox['fs'], path: string) {
        if (this !== box.fs) throw new Error('lost filesystem receiver')
        if (box.status !== 'running') throw new Error('cannot read a stopped box')
        const text = contents.get(path)
        if (text === undefined) throw new Error('file no longer exists')
        return text
      }),
    },
  }
  const source = sandboxFiles({ name: 'documents', getBox: async () => box, list: async () => listed })
  const engine = createExportEngine({
    app: 'test',
    storage: createMemoryExportStorage(),
    plan: async () => ({ sources: [source] }),
  })
  return { box, contents, engine, listed, source }
}

describe('sandboxFiles lifecycle and continuation', () => {
  it('reads each of 401 files once across advances, even if earlier files disappear', async () => {
    const { box, contents, engine, listed } = fixture(401)
    const job = await engine.start(WS, 'owner')
    const first = await engine.advance(WS, job.id)
    expect(first?.units[0]).toMatchObject({ status: 'pending', cursor: 200 })
    expect(box.fs.read.mock.calls.map(([path]) => path)).toEqual(listed.slice(0, 200).map((file) => file.boxPath))
    expect(box.status).toBe('stopped')
    contents.delete(listed[0]!.boxPath)

    const second = await engine.advance(WS, job.id)
    expect(second?.units[0]).toMatchObject({ status: 'pending', cursor: 400 })
    expect(box.fs.read.mock.calls.map(([path]) => path)).toEqual(listed.slice(0, 400).map((file) => file.boxPath))
    expect(box.status).toBe('stopped')

    const complete = await engine.advance(WS, job.id)
    expect(complete?.status).toBe('complete')
    expect(complete?.units[0]).toMatchObject({ status: 'done', files: 401 })
    expect(complete?.units[0]?.entries.map((entry) => entry.path)).toEqual(listed.map((file) => `files/documents/${file.path}`))
    expect(box.fs.read.mock.calls.map(([path]) => path)).toEqual(listed.map((file) => file.boxPath))
    expect(box.resume).toHaveBeenCalledTimes(3)
    expect(box.stop).toHaveBeenCalledTimes(3)
    expect(box.status).toBe('stopped')
  })

  it.each([1, 2, 3, 4, 5, 7])('keeps the box running through a %i-file export, including the tail chunk', async (count) => {
    const { box, engine } = fixture(count)
    const job = await engine.start(WS, 'owner')
    const complete = await engine.advance(WS, job.id)
    expect(complete?.status).toBe('complete')
    expect(complete?.units[0]?.files).toBe(count)
    expect(box.fs.read).toHaveBeenCalledTimes(count)
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.status).toBe('stopped')
  })

  it('resumes at the saved cursor after the request deadline without rereading its first chunk', async () => {
    const { box, source, listed } = fixture(7)
    let now = 0
    const originalRead = box.fs.read.getMockImplementation()!
    box.fs.read.mockImplementation(async function (path) {
      const text = await originalRead.call(box.fs, path)
      if (path === listed[3]!.boxPath) now = 100
      return text
    })
    const engine = createExportEngine({
      app: 'test', storage: createMemoryExportStorage(), now: () => now,
      plan: async () => ({ sources: [source] }),
    })
    const job = await engine.start(WS, 'owner')
    const first = await engine.advance(WS, job.id, 10)
    expect(first?.units[0]).toMatchObject({ status: 'pending', cursor: 4 })
    expect(box.fs.read).toHaveBeenCalledTimes(4)
    expect(box.status).toBe('stopped')
    expect((await engine.advance(WS, job.id, 10))?.status).toBe('complete')
    expect(box.fs.read.mock.calls.map(([path]) => path)).toEqual(listed.map((file) => file.boxPath))
    expect(box.stop).toHaveBeenCalledTimes(2)
  })

  it('restores a resumed box when the SDK cannot read files', async () => {
    const { box, engine } = fixture(1)
    delete (box.fs as ArchivableBox['fs']).read
    const job = await engine.start(WS, 'owner')
    const result = await engine.advance(WS, job.id)
    expect(result?.units[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      error: 'workspace-export: this sandbox client cannot read files',
    })
    expect(box.resume).toHaveBeenCalledTimes(1)
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.status).toBe('stopped')
  })

  it('restores the box after a read error and retries from the last committed chunk', async () => {
    const { box, contents, engine, listed } = fixture(7)
    const missing = listed[4]!.boxPath
    const text = contents.get(missing)!
    contents.delete(missing)
    const job = await engine.start(WS, 'owner')
    const failed = await engine.advance(WS, job.id)
    expect(failed?.units[0]).toMatchObject({ status: 'pending', cursor: 4, error: 'file no longer exists' })
    expect(failed?.units[0]?.entries).toHaveLength(4)
    expect(box.status).toBe('stopped')
    contents.set(missing, text)
    const complete = await engine.advance(WS, job.id)
    expect(complete?.status).toBe('complete')
    expect(complete?.units[0]?.files).toBe(7)
    expect(box.fs.read.mock.calls.filter(([path]) => path === listed[0]!.boxPath)).toHaveLength(1)
    expect(box.stop).toHaveBeenCalledTimes(2)
    expect(box.status).toBe('stopped')
  })

  it('restores a resumed box when file iteration is cancelled without opening the file', async () => {
    const { box, source } = fixture(2)
    const iterator = source.files()[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    expect(box.fs.read).not.toHaveBeenCalled()
    await iterator.return?.()
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.status).toBe('stopped')
  })

  it('waits for an opened file before restoring a cancelled iterator', async () => {
    const { box, source } = fixture(2)
    const read = deferred<string>()
    box.fs.read.mockImplementationOnce(() => read.promise)
    const iterator = source.files()[Symbol.asyncIterator]()
    const first = await iterator.next()
    if (first.done) throw new Error('expected a file')
    const opening = first.value.open()
    const closing = iterator.return?.()
    await Promise.resolve()
    expect(box.stop).not.toHaveBeenCalled()
    expect(box.status).toBe('running')
    read.resolve('Opened before cancellation')
    await expect(opening).resolves.toBe('Opened before cancellation')
    await closing
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.status).toBe('stopped')
  })

  it.each([1, 2, 3])('waits for a delayed %i-file tail before stopping the box', async (count) => {
    const { box, engine } = fixture(count)
    const read = deferred<string>()
    const started = deferred<void>()
    box.fs.read.mockImplementation(async () => {
      started.resolve()
      await read.promise
      if (box.status !== 'running') throw new Error('box stopped during read')
      return 'finished reading'
    })
    const job = await engine.start(WS, 'owner')
    const advancing = engine.advance(WS, job.id)
    await started.promise
    await Promise.resolve()
    expect(box.stop).not.toHaveBeenCalled()
    read.resolve('ready')
    expect((await advancing)?.status).toBe('complete')
    expect(box.fs.read).toHaveBeenCalledTimes(count)
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.status).toBe('stopped')
  })

  it('waits for all four admitted reads after one fails, without committing the partial chunk', async () => {
    const { box, engine } = fixture(5)
    const read = deferred<string>()
    const allStarted = deferred<void>()
    box.fs.read
      .mockImplementationOnce(() => read.promise)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce('third')
      .mockImplementationOnce(async () => { allStarted.resolve(); return 'fourth' })
    const job = await engine.start(WS, 'owner')
    const advancing = engine.advance(WS, job.id)
    await allStarted.promise
    expect(box.stop).not.toHaveBeenCalled()
    expect(box.status).toBe('running')
    read.resolve('first')
    const result = await advancing
    expect(result?.units[0]).toMatchObject({ status: 'pending', attempts: 1, error: 'read failed', entries: [] })
    expect(result?.units[0]?.cursor).toBeUndefined()
    expect(box.fs.read).toHaveBeenCalledTimes(4)
    expect(box.stop).toHaveBeenCalledTimes(1)
    expect(box.status).toBe('stopped')
  })

  it('drains admitted work when listing fails before a chunk fills', async () => {
    const read = deferred<string>()
    const listingFailed = deferred<void>()
    let settled = false
    const engine = createExportEngine({
      app: 'test',
      storage: createMemoryExportStorage(),
      plan: async () => ({
        sources: [{
          kind: 'files',
          name: 'documents',
          dataClass: 'knowledge',
          async *files() {
            yield { path: 'one.txt', open: () => read.promise }
            listingFailed.resolve()
            throw new Error('listing failed')
          },
        }],
      }),
    })
    const job = await engine.start(WS, 'owner')
    const advancing = engine.advance(WS, job.id).then((result) => { settled = true; return result })
    await listingFailed.promise
    await Promise.resolve()
    expect(settled).toBe(false)
    read.resolve('first')
    const result = await advancing
    expect(result?.units[0]).toMatchObject({ status: 'pending', attempts: 1, error: 'listing failed', entries: [] })
  })

  it('leaves an already-running box running after a successful export', async () => {
    const { box, engine } = fixture(3, 'running')
    const job = await engine.start(WS, 'owner')
    expect((await engine.advance(WS, job.id))?.status).toBe('complete')
    expect(box.resume).not.toHaveBeenCalled()
    expect(box.stop).not.toHaveBeenCalled()
    expect(box.status).toBe('running')
  })
})
