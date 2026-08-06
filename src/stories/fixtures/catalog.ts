/**
 * Model-catalog fixtures: the catalogue the chat surfaces price per-message
 * cost against and the composer model picker lists. Same shapes the playground
 * ships, typed against the package's own `CatalogModel`.
 */

import type { CatalogModel } from '../../web-react'

export const catalogModels: CatalogModel[] = [
  {
    id: 'anthropic/claude-opus-4',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    description: 'Most capable Anthropic model',
    contextLength: 1_000_000,
    pricing: { prompt: '0.000015', completion: '0.000075' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    description: 'OpenAI flagship',
    contextLength: 400_000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supportsTools: true,
    supportsReasoning: true,
    featured: true,
  },
  {
    id: 'anthropic/claude-haiku-4',
    name: 'Claude Haiku 4',
    provider: 'anthropic',
    contextLength: 200_000,
    pricing: { prompt: '0.000001', completion: '0.000005' },
    supportsTools: true,
    supportsReasoning: false,
    featured: false,
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    contextLength: 2_000_000,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
    supportsTools: true,
    supportsReasoning: true,
    featured: false,
  },
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek Chat',
    provider: 'deepseek',
    contextLength: 128_000,
    pricing: { prompt: '0.00000027', completion: '0.0000011' },
    supportsTools: false,
    supportsReasoning: false,
    featured: false,
  },
]
