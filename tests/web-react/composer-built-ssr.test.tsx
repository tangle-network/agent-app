// @vitest-environment node
import { Writable } from 'node:stream'
import type { ComponentType } from 'react'
import { describe, expect, it } from 'vitest'
import { renderToPipeableStream } from 'react-dom/server'

import type { ChatComposerProps } from '../../src/web-react/chat-composer'

const SSR_RENDER_TIMEOUT_MS = 15_000

async function renderAfterLazyModules(): Promise<string> {
  const builtEntry = new URL('../../dist/web-react/index.js', import.meta.url).href
  const { ChatComposer } = (await import(builtEntry)) as {
    ChatComposer: ComponentType<ChatComposerProps>
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(Buffer.from(chunk))
        done()
      },
    })
    const timeout = setTimeout(() => {
      renderer.abort()
      reject(new Error('built composer server render timed out'))
    }, SSR_RENDER_TIMEOUT_MS)
    output.once('finish', () => {
      clearTimeout(timeout)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    output.once('error', reject)

    const renderer = renderToPipeableStream(
      <ChatComposer
        onSend={() => {}}
        placeholder="Write a message"
        mention={{ fetchItems: async () => [] }}
      />,
      {
        onAllReady() {
          renderer.pipe(output)
        },
        onShellError: reject,
        onError: reject,
      },
    )
  })
}

describe('built ChatComposer server output', () => {
  it('contains one enabled message input after the lazy editor module resolves', async () => {
    const html = await renderAfterLazyModules()
    const inputTags = html.match(/<textarea\b[^>]*aria-label="Message input"[^>]*>/g) ?? []

    expect(inputTags).toHaveLength(1)
    expect(inputTags[0]).not.toMatch(/\sdisabled(?:[=>\s])/)
  }, SSR_RENDER_TIMEOUT_MS)
})
