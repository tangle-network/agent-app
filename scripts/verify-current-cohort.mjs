// Temporary dependency maintenance, removed from the retained source commit.
// Consume registry artifacts only; no copied runtime source or hidden fallback.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
const versions = {
  '@tangle-network/agent-runtime': '0.247.0',
  '@tangle-network/sandbox': '0.45.0',
  '@tangle-network/agent-knowledge': '17.0.2',
  '@tangle-network/agent-eval': '0.182.0',
  '@tangle-network/agent-interface': '2.10.0',
  '@tangle-network/agent-integrations': '0.54.2',
  '@tangle-network/agent-gateway': '0.11.4',
}
const published = {}
for (const [name, version] of Object.entries(versions)) {
  const info = JSON.parse(execFileSync('pnpm', ['view', `${name}@${version}`, 'version', 'peerDependencies', '--json'], { encoding: 'utf8' }))
  assert.equal(info.version, version, `Registry identity mismatch for ${name}`)
  published[name] = info
}
writeFileSync(`${process.env.VERIFICATION_DIR}/registry.json`, JSON.stringify(published, null, 2) + '\n')
const ranges = {
  '@tangle-network/agent-runtime': '>=0.247.0 <0.248.0',
  '@tangle-network/sandbox': '>=0.45.0 <0.46.0',
  '@tangle-network/agent-integrations': '>=0.54.2 <0.55.0',
  '@tangle-network/agent-knowledge': '^17.0.2',
  '@tangle-network/agent-interface': '^2.10.0',
}
for (const file of ['package.json', 'create-agent-app/template/_package.json', 'create-agent-app/template-chat/_package.json']) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  for (const section of ['dependencies', 'devDependencies']) for (const [name, version] of Object.entries(versions)) {
    if (manifest[section]?.[name]) manifest[section][name] = version
  }
  for (const [name, range] of Object.entries(ranges)) if (manifest.peerDependencies?.[name]) manifest.peerDependencies[name] = range
  if (file !== 'package.json' && manifest.peerDependencies?.['@tangle-network/agent-interface']) {
    manifest.peerDependencies['@tangle-network/agent-interface'] = versions['@tangle-network/agent-interface']
  }
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
}
function replaceOnce(file, before, after) {
  const source = readFileSync(file, 'utf8')
  assert.equal(source.split(before).length, 2, `Source changed; review ${file} before retrying`)
  writeFileSync(file, source.replace(before, after))
}
for (const [before, after] of [['0.231.0','0.246.999'],['0.231.1','0.247.0'],['0.231.9','0.247.999'],['0.232.0','0.248.0'],['2.6.0','2.9.999'],['2.6.1','2.10.0'],['2.6.9','2.10.999']]) {
  replaceOnce('src/peer-floors/check.test.ts', `satisfiesRange('${before}', range!)`, `satisfiesRange('${after}', range!)`)
}
// Gateway input/output are inclusive totals; reasoning/tool counts are optional
// subsets. Missing subset telemetry is unknown, not a measured zero.
replaceOnce('create-agent-app/template-chat/tests/chat-turn.e2e.test.ts',
  '      tool_tokens: 0,', '      tool_tokens: null, // The producer did not report this subset.')
replaceOnce('create-agent-app/template-chat/tests/chat-turn.e2e.test.ts',
  '      maxReasoningTokens: 321,\n      maxToolTokens: 321,\n', '')
replaceOnce('create-agent-app/template-chat/tests/chat-turn.e2e.test.ts',
  '    expect(receivedLimits?.maxProviderCostUsd).toBeGreaterThan(0)',
  "    expect(receivedLimits).not.toHaveProperty('maxReasoningTokens')\n    expect(receivedLimits).not.toHaveProperty('maxToolTokens')\n    expect(receivedLimits?.maxProviderCostUsd).toBeGreaterThan(0)")
replaceOnce('create-agent-app/template-chat/src/sandbox.ts',
  `          ...(executionLimits?.maxOutputTokens !== undefined
            && executionLimits.maxReasoningTokens !== undefined
            ? {
                maxTotalOutputTokens:
                  executionLimits.maxOutputTokens + executionLimits.maxReasoningTokens,
              }
            : {}),`,
  `          // Gateway output is inclusive of reasoning. Keep the same total
          // ceiling even when a separate reasoning subset was authorized.
          ...(executionLimits?.maxOutputTokens !== undefined
            ? { maxTotalOutputTokens: executionLimits.maxOutputTokens }
            : {}),`)
