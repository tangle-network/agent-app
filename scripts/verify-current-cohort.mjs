// Temporary read-only migration workbench. Its tested changes are committed
// normally before this script is removed. No publishing or deployment occurs.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
const published = {}
for (const short of ['agent-runtime','sandbox','agent-knowledge','agent-interface','agent-integrations','agent-gateway']) {
  const name = `@tangle-network/${short}`
  // Inspect actual published stable versions, not a version read from Git main
  // or an older latest tag. These packages use numeric three-part versions.
  const available = JSON.parse(execFileSync('pnpm',['view',name,'versions','--json'],{encoding:'utf8'}))
  const stable = available.filter(version => /^\d+\.\d+\.\d+$/.test(version)).sort((a,b) => {
    const aa=a.split('.').map(Number), bb=b.split('.').map(Number)
    return aa[0]-bb[0] || aa[1]-bb[1] || aa[2]-bb[2]
  })
  assert.ok(stable.length, `No published stable version for ${name}`)
  const selector = `${name}@${stable.at(-1)}`
  const info = JSON.parse(execFileSync('pnpm',['view',selector,'version','peerDependencies','--json'],{encoding:'utf8'}))
  assert.equal(info.version,stable.at(-1),`Registry identity mismatch for ${selector}`)
  published[name]=info
  writeFileSync(`${process.env.VERIFICATION_DIR}/registry.json`,JSON.stringify(published,null,2)+'\n')
}
const versions = Object.fromEntries(Object.entries(published).map(([name,info])=>[name,info.version]))
// Preserve the current Eval family until the engine peers accept its successor.
// The normal strict install and complete source/consumer gates still apply.
versions['@tangle-network/agent-eval']='0.182.0'
const minorRange = version => { const [major,minor] = version.split('.').map(Number); return `>=${version} <${major}.${minor+1}.0` }
const ranges = {
  '@tangle-network/agent-runtime':minorRange(versions['@tangle-network/agent-runtime']),
  '@tangle-network/sandbox':minorRange(versions['@tangle-network/sandbox']),
  '@tangle-network/agent-integrations':minorRange(versions['@tangle-network/agent-integrations']),
  '@tangle-network/agent-knowledge':`^${versions['@tangle-network/agent-knowledge']}`,
}
for (const file of ['package.json','create-agent-app/template/_package.json','create-agent-app/template-chat/_package.json']) {
  const manifest=JSON.parse(readFileSync(file,'utf8'))
  for (const section of ['dependencies','devDependencies']) for (const [name,version] of Object.entries(versions)) {
    if(manifest[section]?.[name])manifest[section][name]=version
  }
  for(const [name,range] of Object.entries(ranges))if(manifest.peerDependencies?.[name])manifest.peerDependencies[name]=range
  if(file!=='package.json'&&manifest.peerDependencies?.['@tangle-network/agent-interface'])manifest.peerDependencies['@tangle-network/agent-interface']=versions['@tangle-network/agent-interface']
  writeFileSync(file,JSON.stringify(manifest,null,2)+'\n')
}
const peerTest='src/peer-floors/check.test.ts'
let test=readFileSync(peerTest,'utf8')
assert.ok(test.includes("satisfiesRange('0.231.1', range!)"))
const [major,minor]=versions['@tangle-network/agent-runtime'].split('.').map(Number)
for(const [before,after] of [['0.231.0',`${major}.${minor-1}.999`],['0.231.1',versions['@tangle-network/agent-runtime']],['0.231.9',`${major}.${minor}.999`],['0.232.0',`${major}.${minor+1}.0`]]) {
  test=test.replace(`satisfiesRange('${before}', range!)`,`satisfiesRange('${after}', range!)`)
}
writeFileSync(peerTest,test)
