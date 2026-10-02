import type { ChatGPTConnectProps } from './index'

/** Display-only examples. These are not live enrollment or connection records. */
export const gtmExample: ChatGPTConnectProps = {
  app: { name: 'gtm-example', displayName: 'GTM workspace', description: 'Work on account research and campaign tasks with your existing agent.' },
  endpoint: 'https://gtm.example.com/api/agents/mcp',
  enrollment: { enrollmentId: 'example-gtm-enrollment', agentId: 'research-agent', workspaceId: 'gtm-workspace', threadId: 'example-gtm-thread' },
  state: { status: 'not-connected' },
}

export const creativeExample: ChatGPTConnectProps = {
  app: { name: 'creative-example', displayName: 'Creative workspace', description: 'Continue creative briefs and review deliverables with your existing agent.' },
  endpoint: 'https://creative.example.com/api/agents/mcp',
  enrollment: { enrollmentId: 'example-creative-enrollment', agentId: 'creative-agent', workspaceId: 'design-studio', threadId: 'example-creative-thread' },
  state: { status: 'not-connected' },
}
