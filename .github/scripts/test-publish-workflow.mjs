#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowDirectory = path.join(root, '.github/workflows')
const workflows = fs.readdirSync(workflowDirectory)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => ({ file, text: fs.readFileSync(path.join(workflowDirectory, file), 'utf8') }))
const text = workflows.find(({ file }) => file === 'publish.yml')?.text
if (!text) throw new Error('publish.yml is missing')
const ciWorkflow = workflows.find(({ file }) => file === 'ci.yml')?.text
if (!ciWorkflow) throw new Error('ci.yml is missing')
const script = fs.readFileSync(path.join(root, '.github/scripts/publish-packages.sh'), 'utf8')
const releaseScript = fs.readFileSync(path.join(root, '.github/scripts/write-release.sh'), 'utf8')
const packFilenameScript = path.join(root, '.github/scripts/read-npm-pack-filename.mjs')
const lines = text.split('\n')
const triggerBlock = text.slice(0, text.indexOf('concurrency:'))
const pins = {
  'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
  'pnpm/action-setup': '0ebf47130e4866e96fce0953f49152a61190b271',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact': '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact': '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
}

const fail = (message) => {
  console.error(`publish workflow contract failed: ${message}`)
  process.exit(1)
}
const check = (condition, message) => {
  if (!condition) fail(message)
}

const jobs = new Map()
let current
for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
  const match = /^  ([a-z0-9_]+):\s*$/.exec(line)
  if (match) {
    current = match[1]
    jobs.set(current, [])
  } else if (current) {
    jobs.get(current).push(line)
  }
}
const job = (name) => {
  check(jobs.has(name), `missing ${name} job`)
  return jobs.get(name).join('\n')
}
const namedStep = (block, name) => {
  const blockLines = block.split('\n')
  const start = blockLines.findIndex((line) => line.trim() === `- name: ${name}`)
  check(start >= 0, `missing ${name} step`)
  const next = blockLines.findIndex((line, index) => index > start && /^      - /.test(line))
  return blockLines.slice(start, next >= 0 ? next : undefined).join('\n')
}

const packageJob = job('package_release')
const writeJob = job('write_release')
const agentPublishJob = job('publish_agent_app')
const createPublishJob = job('publish_create_agent_app')
check(jobs.size === 4, 'release workflow must contain exactly four jobs')
check(/concurrency:\s*\n  group: release\s*\n  cancel-in-progress: false/.test(text), 'release concurrency changed')
check(!/^\s+tags:/m.test(triggerBlock), 'tag pushes duplicate the explicit release dispatch')
check(ciWorkflow.includes('permissions:\n  contents: read'), 'CI permissions are not read-only')
// No workflow may run on a schedule: a timed job spends real model and sandbox
// money with nobody watching the bill.
check(!workflows.some(({ text: workflow }) => /^\s*-\s*cron:/m.test(workflow)), 'a workflow runs on a cron schedule')

const actionRefs = workflows.flatMap(({ file, text: workflow }) =>
  [...workflow.matchAll(/uses:\s*([^@\s]+)@([^\s#]+)/g)]
    .map((match) => ({ file, name: match[1], ref: match[2] })),
)
check(actionRefs.every(({ ref }) => /^[0-9a-f]{40}$/.test(ref)), 'every action must use an exact commit SHA')
for (const [name, pin] of Object.entries(pins)) {
  const refs = actionRefs.filter((action) => action.name === name)
  check(refs.length > 0 && refs.every(({ ref }) => ref === pin), `${name} does not use the required pin`)
}

for (const { file, text: workflow } of workflows) {
  const workflowLines = workflow.split('\n')
  for (let index = 0; index < workflowLines.length; index += 1) {
    if (!/^      - uses: actions\/checkout@/.test(workflowLines[index])) continue
    const step = []
    for (let cursor = index; cursor < workflowLines.length && (cursor === index || !/^      - /.test(workflowLines[cursor])); cursor += 1) step.push(workflowLines[cursor])
    check(step.some((line) => line.trim() === 'persist-credentials: false'), `${file} checkout persists credentials`)
  }
}

const restricted = {
  write_release: writeJob,
  publish_agent_app: agentPublishJob,
  publish_create_agent_app: createPublishJob,
}
const forbidden = [
  'actions/checkout@',
  'pnpm/action-setup@',
  'pnpm install',
  'npm install',
  'npm pack',
  'npm publish',
  'npm version',
  'pnpm run build',
  'pnpm run typecheck',
  'pnpm run test',
]
for (const [name, block] of Object.entries(restricted)) {
  const commands = block.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  for (const value of forbidden) check(!commands.includes(value), `${name} contains forbidden work: ${value}`)
}

check(packageJob.includes('contents: read') && !packageJob.includes('contents: write') && !packageJob.includes('id-token: write'), 'package job is not read-only')
for (const command of [
  'pnpm install --frozen-lockfile',
  'pnpm run typecheck',
  'pnpm run test',
  'pnpm run build',
  'pnpm run test:generated',
  'npm pack',
]) {
  check(packageJob.includes(command), `package job is missing ${command}`)
}
const artifactPackRuntimeStep = namedStep(packageJob, 'Configure exact artifact pack runtime')
const artifactPackNpmStep = namedStep(packageJob, 'Verify artifact pack npm')
check(artifactPackRuntimeStep.includes('node-version: 24.18.0'), 'artifact pack Node version is not exact')
check(artifactPackNpmStep.includes("$(npm --version) == '11.16.0'"), 'artifact pack npm version is not checked')
check(packageJob.indexOf('pnpm run build') < packageJob.indexOf('Configure exact artifact pack runtime') && packageJob.indexOf('Configure exact artifact pack runtime') < packageJob.indexOf('npm pack'), 'artifact pack runtime is configured outside the pack boundary')
check(
  packageJob.indexOf('pnpm run build') < packageJob.indexOf('pnpm run test:generated') &&
    packageJob.indexOf('pnpm run test:generated') < packageJob.indexOf('npm pack') &&
    packageJob.indexOf('npm pack') < packageJob.indexOf('actions/upload-artifact@'),
  'artifact is uploaded before build, generated-project tests, and pack complete',
)
check(packageJob.includes('persist-credentials: false'), 'package checkout persists credentials')
check(!packageJob.includes('npm version'), 'auto mode mutates package manifests before the tagged run')
check(packageJob.includes('fetch-depth: 0'), 'release history is shallow')
check(packageJob.includes('publish-control-sha:') && packageJob.includes('release-control-sha:'), 'release scripts are not anchored before dependency install')
check(packageJob.indexOf('id: control') < packageJob.indexOf('pnpm install'), 'publish script is anchored after dependency install')
check(packageJob.includes('cp .github/scripts/read-npm-pack-filename.mjs'), 'npm pack parser is not staged before install')
check(packageJob.indexOf('cp .github/scripts/read-npm-pack-filename.mjs') < packageJob.indexOf('pnpm install'), 'npm pack parser is staged after dependency install')
check(packageJob.includes('pack-sha=$(sha256sum'), 'npm pack parser checksum is not captured before install')
check(packageJob.includes('PACK_CONTROL_SHA:') && packageJob.includes('sha256sum "$BUNDLE/read-npm-pack-filename.mjs"'), 'npm pack parser checksum is not verified before use')
check(packageJob.includes('npm pack "$source" --ignore-scripts --pack-destination "$BUNDLE" --json'), 'npm pack does not request structured output')
check(packageJob.includes('node "$BUNDLE/read-npm-pack-filename.mjs"'), 'npm pack filename is not parsed by the staged parser')
check(packageJob.includes('bash .github/scripts/test-write-release.sh'), 'release transition tests do not run')
check(packageJob.includes('actions/upload-artifact@'), 'tested tarballs are not uploaded')
check(packageJob.includes('Verify release tag is on main'), 'tag publishing does not check main ancestry')
check(packageJob.includes('+refs/heads/main:refs/remotes/origin/main'), 'tag check does not fetch main')
check(packageJob.includes('git merge-base --is-ancestor "$TAG_SHA" "$MAIN_SHA"'), 'tag commit ancestry is not checked')
check(packageJob.indexOf('Verify release tag is on main') < packageJob.indexOf('pnpm install'), 'invalid tags are rejected after dependency install')
check(packageJob.includes('bash .github/scripts/write-release.sh validate'), 'tag release identity is not checked')
check(packageJob.indexOf('bash .github/scripts/write-release.sh validate') < packageJob.indexOf('pnpm install'), 'tag release identity is checked after dependency install')
for (const name of [
  'Configure exact artifact pack runtime',
  'Verify artifact pack npm',
  'Pack and inspect exact tarballs',
  'Upload release artifact',
]) {
  check(
    namedStep(packageJob, name).includes("if: steps.release.outputs.mode == 'tag'"),
    `${name} can run outside tagged releases`,
  )
}

check(writeJob.includes('contents: write') && writeJob.includes('actions: write') && !writeJob.includes('id-token: write'), 'write job permissions are wrong')
check(writeJob.includes('needs: package_release'), 'write job does not wait for packaging')
check(!writeJob.includes('uses:'), 'write job invokes an action')
check(writeJob.includes('git init --bare'), 'write job uses a checkout')
check(writeJob.includes('git show "$BASE_SHA:.github/scripts/write-release.sh"'), 'write job does not load the tested release script')
check(writeJob.includes('CONTROL_SHA') && writeJob.includes('sha256sum'), 'write job does not authenticate the release script')
check(writeJob.includes('bash "$RUNNER_TEMP/write-release.sh"'), 'write job does not execute the release script')
for (const command of [
  'git push --atomic',
  'git merge-base --is-ancestor',
  'git diff --name-only',
  'git rev-list --parents',
  'build_expected_release_tree',
  'actual_tree',
  'actions/workflows/publish.yml/dispatches',
]) {
  check(releaseScript.includes(command), `release script is missing ${command}`)
}

for (const [name, block] of [['publish_agent_app', agentPublishJob], ['publish_create_agent_app', createPublishJob]]) {
  check(block.includes("needs.package_release.outputs.mode == 'tag'"), `${name} can publish outside a tagged run`)
  check(!block.includes('write_release'), `${name} depends on the pre-tag run`)
  check(block.includes('actions: read'), `${name} cannot download the artifact`)
  check(block.includes('node-version: 24.18.0'), `${name} runtime is not exact`)
  check(block.includes("$(npm --version) == '11.16.0'"), `${name} npm version is not checked`)
  check(block.includes('artifact-ids: ${{ needs.package_release.outputs.artifact-id }}'), `${name} does not select the exact artifact`)
  check(block.includes('sha256sum --check SHA256SUMS') && block.includes('CONTROL_SHA'), `${name} does not verify the artifact`)
}
check(agentPublishJob.includes('id-token: write') && !agentPublishJob.includes('contents: write'), 'Agent App publisher permissions are wrong')
check(!agentPublishJob.includes('secrets.') && !agentPublishJob.includes('CREATE_AGENT_APP_NPM_TOKEN'), 'Agent App publisher receives a long-lived secret')
check(!agentPublishJob.includes('registry-url:'), 'Agent App publisher receives token-based npm configuration')
check(agentPublishJob.includes('publish agent-app agent-app.tgz') && !agentPublishJob.includes('create-agent-app.tgz'), 'Agent App publisher is not limited to its tarball')
check(createPublishJob.includes('id-token: write') && !createPublishJob.includes('contents: write'), 'create-agent-app publisher permissions are wrong')
check(createPublishJob.includes('CREATE_AGENT_APP_NPM_TOKEN: ${{ secrets.CREATE_AGENT_APP_NPM_TOKEN }}'), 'create-agent-app publisher lacks its token')
check(createPublishJob.includes('registry-url: https://registry.npmjs.org'), 'create-agent-app publisher lacks npm token configuration')
check(createPublishJob.includes('publish create-agent-app create-agent-app.tgz') && !createPublishJob.includes('publish agent-app '), 'create-agent-app publisher is not limited to its tarball')
check(script.includes('--provenance') && script.includes('--ignore-scripts'), 'publish command lacks provenance or allows lifecycle scripts')
check(text.includes("startsWith(github.ref, 'refs/tags/v')") && text.includes("github.event_name == 'workflow_dispatch'"), 'manual tag publishing changed')

const parsePackFilename = (input) => spawnSync(process.execPath, [packFilenameScript], { input, encoding: 'utf8' })
const validPack = parsePackFilename(JSON.stringify([{ filename: 'tangle-network-agent-app-0.44.44.tgz', files: Array.from({ length: 500 }, (_, index) => ({ path: `dist/${index}.js` })) }]))
check(validPack.status === 0, `npm pack parser rejected valid JSON: ${validPack.stderr.trim()}`)
check(validPack.stdout === 'tangle-network-agent-app-0.44.44.tgz', 'npm pack parser returned the wrong filename')
for (const [name, input] of [
  ['lifecycle output', 'build complete\n[{"filename":"package.tgz"}]'],
  ['multiple results', '[{"filename":"one.tgz"},{"filename":"two.tgz"}]'],
  ['path traversal', '[{"filename":"../package.tgz"}]'],
  ['missing filename', '[{}]'],
]) {
  check(parsePackFilename(input).status !== 0, `npm pack parser accepted ${name}`)
}

console.log('publish workflow contract: ok')
