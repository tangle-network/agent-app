import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { buildCatalog, normalizeModelId, type RouterModel } from '../src/runtime/model-catalog'

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures-router-models.json'), 'utf-8'),
) as RouterModel[]

describe('normalizeModelId', () => {
  it('strips provider prefixes, date stamps, and :free suffixes', () => {
    expect(normalizeModelId('anthropic/claude-opus-4-5')).toBe('claude-opus-4-5')
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(normalizeModelId('gpt-5-2025-08-07')).toBe('gpt-5')
    expect(normalizeModelId('openai/gpt-oss-120b:free')).toBe('gpt-oss-120b')
  })
})

describe('buildCatalog', () => {
  const catalog = buildCatalog(fixture)
  const ids = catalog.models.map((m) => m.id)

  it('excludes non-chat endpoints (tts, embeddings, realtime, image)', () => {
    expect(ids).not.toContain('tts-1')
    expect(ids).not.toContain('text-embedding-3-large')
    expect(ids).not.toContain('gpt-realtime')
    expect(ids).not.toContain('chatgpt-image-latest')
  })

  it('dedupes dated snapshots and :free variants to one representative', () => {
    // gpt-5 and gpt-5-2025-08-07 collapse to the undated id
    expect(ids).toContain('gpt-5')
    expect(ids).not.toContain('gpt-5-2025-08-07')
    // :free and paid variants collapse to one
    const oss = ids.filter((id) => normalizeModelId(id) === 'gpt-oss-120b')
    expect(oss).toHaveLength(1)
  })

  it('keeps distinct versions as distinct models', () => {
    expect(ids).toContain('claude-opus-4-7')
    expect(ids).toContain('claude-opus-4-6')
  })

  it('features the highest version per family, in rule order', () => {
    const featured = catalog.models.filter((m) => m.featured).map((m) => m.id)
    expect(featured[0]).toBe('claude-sonnet-4-6')
    expect(featured[1]).toBe('claude-opus-4-7') // beats 4-6 and dated 4-5
    expect(featured).toContain('gpt-5.1') // beats gpt-5
    expect(featured).not.toContain('gpt-5.1-codex') // specialty suffix not featured
    expect(featured).toContain('gemini-3.1-pro-preview') // 3.1 beats 2.5
    expect(featured).toContain('grok-4.3')
    expect(featured).toContain('glm-5.1') // beats glm-5
    expect(featured.length).toBeLessThanOrEqual(12)
  })

  it('puts featured models first, then provider-tier order', () => {
    const featuredCount = catalog.models.filter((m) => m.featured).length
    const rest = catalog.models.slice(featuredCount)
    expect(rest.every((m) => !m.featured)).toBe(true)
  })

  it('picks a tool-capable featured model as default', () => {
    expect(catalog.defaultModelId).toBe('claude-sonnet-4-6')
    const def = catalog.models.find((m) => m.id === catalog.defaultModelId)
    expect(def?.supportsTools).toBe(true)
  })

  it('respects a preferred default when it survives filtering', () => {
    const pinned = buildCatalog(fixture, { preferredDefault: 'gpt-5.1' })
    expect(pinned.defaultModelId).toBe('gpt-5.1')
  })

  it('falls back to the heuristic when the preferred default is gone', () => {
    const pinned = buildCatalog(fixture, { preferredDefault: 'model-that-was-sunset' })
    expect(pinned.defaultModelId).toBe('claude-sonnet-4-6')
  })

  it('marks tool support from merged alias metadata or family knowledge', () => {
    // claude-haiku-4-5-20251001 lacks `tools` in router metadata but the
    // family is known tool-capable
    const haiku = catalog.models.find((m) => normalizeModelId(m.id) === 'claude-haiku-4-5')
    expect(haiku?.supportsTools).toBe(true)
  })
})
