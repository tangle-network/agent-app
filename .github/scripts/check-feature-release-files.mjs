#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const base=`origin/${process.env.GITHUB_BASE_REF||'main'}`
const show=(p)=>execFileSync('git',['show',`${base}:${p}`],{encoding:'utf8'})
const pairs=[['package.json',JSON.parse],['create-agent-app/package.json',JSON.parse]]
for(const [path,parse] of pairs){
  const before=parse(show(path)).version
  const after=parse(readFileSync(path,'utf8')).version
  if(before!==after) throw new Error(`feature PR changed ${path} version ${before} -> ${after}; release workflow owns versions`)
}
const changed=execFileSync('git',['diff','--name-only',`${base}...HEAD`],{encoding:'utf8'}).trim().split('\n').filter(Boolean)
if(changed.includes('CHANGELOG.md')) throw new Error('feature PR changed CHANGELOG.md; release workflow owns changelog generation')
console.log('feature release files clean')
