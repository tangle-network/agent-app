// One-time dependency migration workbench. The resulting manifest, lockfile and
// generated docs must be reviewed and committed before the normal frozen gate
// can authorize the new cohort. This script never publishes or pushes changes.
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const versions = {
  '@tangle-network/agent-eval': '0.183.0',
  '@tangle-network/agent-runtime': '0.240.0',
  '@tangle-network/sandbox': '0.43.0',
  '@tangle-network/agent-interface': '2.10.0',
  '@tangle-network/agent-integrations': '0.54.2',
  '@tangle-network/agent-gateway': '0.11.4',
}
const ranges = {
  '@tangle-network/agent-eval': '>=0.183.0 <0.184.0',
  '@tangle-network/agent-runtime': '>=0.240.0 <0.241.0',
  '@tangle-network/sandbox': '>=0.43.0 <0.44.0',
  '@tangle-network/agent-integrations': '>=0.54.2 <0.55.0',
}
for (const file of ['package.json', 'create-agent-app/template/_package.json', 'create-agent-app/template-chat/_package.json']) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(versions)) {
      if (manifest[section]?.[name]) manifest[section][name] = version
    }
  }
  for (const [name, range] of Object.entries(ranges)) {
    if (manifest.peerDependencies?.[name]) manifest.peerDependencies[name] = range
  }
  // Template Interface peers are exact installation inputs; the shell itself
  // preserves the additive Interface 2.x contract it already verifies.
  if (file !== 'package.json' && manifest.peerDependencies?.['@tangle-network/agent-interface']) {
    manifest.peerDependencies['@tangle-network/agent-interface'] = versions['@tangle-network/agent-interface']
  }
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
}
const peerTest = 'src/peer-floors/check.test.ts'
let test = readFileSync(peerTest, 'utf8')
assert.ok(test.includes("satisfiesRange('0.231.1', range!)"))
for (const [before, after] of [['0.231.0','0.239.9'],['0.231.1','0.240.0'],['0.231.9','0.240.9'],['0.232.0','0.241.0']]) {
  test = test.replace(`satisfiesRange('${before}', range!)`, `satisfiesRange('${after}', range!)`)
}
writeFileSync(peerTest, test)
