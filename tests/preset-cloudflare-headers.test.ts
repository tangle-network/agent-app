import { describe, expect, it } from 'vitest'
import { renderCloudflareHeadersFile } from '../src/preset-cloudflare/headers'

describe('renderCloudflareHeadersFile', () => {
  it('renders multiple native static-asset header rules deterministically', () => {
    expect(
      renderCloudflareHeadersFile([
        {
          pattern: '/*',
          headers: {
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'",
          },
        },
        {
          pattern: '/assets/*',
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        },
      ]),
    ).toBe(
      "/*\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: default-src 'self'\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
    )
  })

  it.each([
    {
      name: 'an empty rule set',
      rules: [],
    },
    {
      name: 'a pattern that can inject another rule',
      rules: [{ pattern: '/*\n/admin/*', headers: { 'X-Test': 'safe' } }],
    },
    {
      name: 'a malformed header name',
      rules: [{ pattern: '/*', headers: { 'Bad Header': 'value' } }],
    },
    {
      name: 'a header value that can inject another header',
      rules: [{ pattern: '/*', headers: { 'X-Test': 'safe\n  X-Evil: injected' } }],
    },
    {
      name: 'a rule without headers',
      rules: [{ pattern: '/*', headers: {} }],
    },
  ])('rejects $name', ({ rules }) => {
    expect(() => renderCloudflareHeadersFile(rules)).toThrow()
  })
})
