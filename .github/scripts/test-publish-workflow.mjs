#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import signoffConfig from '../../signoff.config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowDirectory = path.join(root, '.github/workflows')
const workflows = fs.readdirSync(workflowDirectory)
  .filter((file) => /\.ya?ml$/.test(file))
  .sort()
  .map((file) => ({ file, text: fs.readFileSync(path.join(workflowDirectory, file), 'utf8') }))
const text = workflows.find(({ file }) => file === 'publish.yml')?.text
if (!text) throw new Error('publish.yml is missing')
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
const count = (value, pattern) => [...value.matchAll(pattern)].length
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

check(!workflows.some(({ file }) => file === 'ci.yml'), 'ci.yml duplicates release verification on main')

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
const stepWithCommand = (block, command) => {
  const blockLines = block.split('\n')
  const commandLine = blockLines.findIndex((line) => line.trim() === `run: ${command}`)
  check(commandLine >= 0, `missing workflow command: ${command}`)
  let start = commandLine
  while (start >= 0 && !/^      - /.test(blockLines[start])) start -= 1
  check(start >= 0, `command has no step: ${command}`)
  const next = blockLines.findIndex((line, index) => index > start && /^      - /.test(line))
  return blockLines.slice(start, next >= 0 ? next : undefined).join('\n')
}

const packageJob = job('package_release')
const writeJob = job('write_release')
const agentPublishJob = job('publish_agent_app')
const createPublishJob = job('publish_create_agent_app')
const safetyIssueJob = job('safety_net_issue')
const safetyClearJob = job('safety_net_clear')
check(jobs.size === 6, 'publish workflow must contain exactly six jobs')
check(/concurrency:\s*\n  group: release\s*\n  cancel-in-progress: false/.test(text), 'release concurrency changed')
check(!/^\s+tags:/m.test(triggerBlock), 'tag pushes duplicate the explicit release dispatch')
check(
  ['source_run_id', 'source_artifact_id', 'source_artifact_digest', 'source_sha']
    .every((input) => triggerBlock.includes(`${input}:`)),
  'tag dispatch lacks immutable source inputs',
)
check(
  namedStep(packageJob, 'Lock release identity').includes('[[ "$GITHUB_REF" == refs/tags/v* ]]'),
  'manual branch dispatch reports success without publishing',
)
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
    for (let cursor = index; cursor < workflowLines.length && (cursor === index || !/^      - /.test(workflowLines[cursor])); cursor += 1) {
      step.push(workflowLines[cursor])
    }
    check(step.some((line) => line.trim() === 'persist-credentials: false'), `${file} checkout persists credentials`)
  }
}

check(
  packageJob.includes('actions: read') &&
    packageJob.includes('contents: read') &&
    !packageJob.includes('contents: write') &&
    !packageJob.includes('id-token: write'),
  'package job permissions are wrong',
)
check(packageJob.includes('fetch-depth: 0'), 'release history is shallow')
check(packageJob.includes('persist-credentials: false'), 'package checkout persists credentials')
check(packageJob.includes('node-version-file: .nvmrc'), 'source verification ignores the Node pin')

const autoSteps = [
  ['Prepare release manifests', 'write-release.sh prepare'],
  ['Configure exact artifact pack runtime', 'node-version: 24.18.0'],
  ['Verify artifact pack npm', "$(npm --version) == '11.16.0'"],
  ['Pack and inspect exact tarballs', 'npm pack'],
  ['Upload release artifact', 'actions/upload-artifact@'],
]
for (const [name, command] of autoSteps) {
  const step = namedStep(packageJob, name)
  check(step.includes("if: steps.release.outputs.mode == 'auto'"), `${name} can execute during tagged publication`)
  check(step.includes(command), `${name} is missing ${command}`)
}
const sourceCommands = [
  signoffConfig.install.run,
  ...signoffConfig.steps.map(({ run }) => run),
]
for (const command of sourceCommands) {
  check(stepWithCommand(packageJob, command).includes("if: steps.release.outputs.mode == 'auto'"), `${command} can execute during tagged publication`)
  check(count(text, new RegExp(`^\\s*run: ${escapeRegex(command)}$`, 'gm')) === 1, `${command} does not run exactly once`)
}
check(count(text, /npm pack "\$source"/g) === 1, 'npm pack does not run exactly once')
check(
  packageJob.indexOf('- name: Prepare release manifests') < packageJob.indexOf('- name: Build release') &&
    packageJob.indexOf('- name: Build release') < packageJob.indexOf('- name: Test source') &&
    packageJob.indexOf('- name: Test clean generated projects') < packageJob.indexOf('- name: Pack and inspect exact tarballs') &&
    packageJob.indexOf('- name: Pack and inspect exact tarballs') < packageJob.indexOf('- name: Upload release artifact'),
  'release artifact is not built and tested before upload',
)
check(!namedStep(packageJob, 'Check release contract').includes('if:'), 'release contract does not run on both paths')
check(packageJob.includes('bash .github/scripts/test-write-release.sh'), 'release transition tests do not run')
check(packageJob.includes('Verify release tag is on main'), 'tag publishing does not check main ancestry')
check(packageJob.includes('git merge-base --is-ancestor "$TAG_SHA" "$MAIN_SHA"'), 'tag ancestry is not checked')
check(packageJob.includes('bash .github/scripts/write-release.sh validate'), 'tag release identity is not checked')
check(packageJob.includes('cp .github/scripts/read-npm-pack-filename.mjs'), 'npm pack parser is not staged')
check(packageJob.includes('pack-sha=$(sha256sum'), 'npm pack parser checksum is not captured')
check(packageJob.includes('npm pack "$source" --ignore-scripts --pack-destination "$BUNDLE" --json'), 'npm pack is not deterministic')
check(packageJob.includes('node "$BUNDLE/read-npm-pack-filename.mjs"'), 'npm pack output is parsed unsafely')

check(packageJob.includes('RELEASE_PROVENANCE'), 'release artifact lacks provenance')
check(packageJob.includes('base_sha=$BASE_SHA'), 'artifact provenance lacks source SHA')
check(packageJob.includes('source_run_id=$GITHUB_RUN_ID'), 'artifact provenance lacks source run')
check(packageJob.includes('sha256sum agent-app.tgz create-agent-app.tgz publish-packages.sh RELEASE_PROVENANCE'), 'artifact files lack internal checksums')
check(packageJob.includes('artifact-digest: ${{ steps.artifact.outputs.artifact-digest }}'), 'artifact digest is not exported')
check(packageJob.includes('UPLOAD_ARTIFACT_DIGEST: ${{ steps.upload.outputs.artifact-digest }}'), 'upload digest is discarded')
check(packageJob.includes('ARTIFACT_DIGEST=sha256:$UPLOAD_ARTIFACT_DIGEST'), 'bare upload digest is not normalized to the API format')
check(packageJob.includes('^sha256:[0-9a-f]{64}$'), 'artifact digest format is not checked')

for (const name of ['Verify source artifact identity', 'Download source artifact', 'Verify source artifact files']) {
  check(namedStep(packageJob, name).includes("if: steps.release.outputs.mode == 'tag'"), `${name} can run before tagging`)
}
check(
  packageJob.indexOf('- name: Verify source artifact identity') <
    packageJob.indexOf('- name: Download source artifact') &&
    packageJob.indexOf('- name: Download source artifact') <
      packageJob.indexOf('- name: Verify source artifact files'),
  'untrusted artifact downloads before its GitHub identity is verified',
)
const tagDownload = namedStep(packageJob, 'Download source artifact')
for (const key of ['artifact-ids:', 'github-token:', 'repository:', 'run-id:']) {
  check(tagDownload.includes(key), `tag download lacks ${key}`)
}
const artifactIdentity = namedStep(packageJob, 'Verify source artifact identity')
for (const proof of [
  '.workflow_run.id',
  '.workflow_run.head_branch',
  '.workflow_run.head_sha',
  '.digest // empty',
  ".expired' <<< \"$METADATA\") == 'false'",
]) {
  check(artifactIdentity.includes(proof), `source artifact identity lacks ${proof}`)
}
const artifactVerification = namedStep(packageJob, 'Verify source artifact files')
for (const proof of [
  'sha256sum --check SHA256SUMS',
  'cmp "$EXPECTED" RELEASE_PROVENANCE',
  'publish-packages.sh validate agent-app.tgz create-agent-app.tgz',
]) {
  check(artifactVerification.includes(proof), `source artifact verification lacks ${proof}`)
}

check(
  writeJob.includes('contents: write') &&
    writeJob.includes('actions: write') &&
    !writeJob.includes('id-token: write'),
  'write job permissions are wrong',
)
check(writeJob.includes('needs: package_release'), 'write job does not wait for packaging')
check(!writeJob.includes('uses:'), 'write job invokes an action')
check(writeJob.includes('git init --bare'), 'write job uses a checkout')
check(writeJob.includes('git show "$BASE_SHA:.github/scripts/write-release.sh"'), 'write job does not load the tested release script')
check(writeJob.includes('CONTROL_SHA') && writeJob.includes('sha256sum'), 'write job does not authenticate the release script')
for (const input of ['SOURCE_RUN_ID', 'SOURCE_ARTIFACT_ID', 'SOURCE_ARTIFACT_DIGEST', 'SOURCE_SHA']) {
  check(writeJob.includes(`${input}:`), `write job does not pass ${input}`)
}
for (const command of [
  'git push --atomic',
  'git merge-base --is-ancestor',
  'git diff --name-only',
  'git rev-list --parents',
  'build_expected_release_tree',
  'prepare_release_manifests',
  'actions/workflows/publish.yml/dispatches',
  'source_artifact_digest',
]) {
  check(releaseScript.includes(command), `release script is missing ${command}`)
}

const forbiddenPublisherWork = [
  'actions/checkout@',
  'pnpm/action-setup@',
  'pnpm install',
  'npm install',
  'npm pack',
  'pnpm run build',
  'pnpm run typecheck',
  'pnpm run test',
]
for (const [name, block] of [
  ['write_release', writeJob],
  ['publish_agent_app', agentPublishJob],
  ['publish_create_agent_app', createPublishJob],
]) {
  const commands = block.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  for (const value of forbiddenPublisherWork) check(!commands.includes(value), `${name} contains repeated work: ${value}`)
}

for (const [name, block] of [
  ['publish_agent_app', agentPublishJob],
  ['publish_create_agent_app', createPublishJob],
]) {
  check(block.includes("needs.package_release.outputs.mode == 'tag'"), `${name} can publish outside a tagged run`)
  check(block.includes('actions: read'), `${name} cannot download the source artifact`)
  check(block.includes('node-version: 24.18.0'), `${name} runtime is not exact`)
  check(block.includes("$(npm --version) == '11.16.0'"), `${name} npm version is not checked`)
  check(block.includes('artifact-ids: ${{ needs.package_release.outputs.artifact-id }}'), `${name} does not select the exact artifact`)
  check(block.includes('run-id: ${{ needs.package_release.outputs.artifact-run-id }}'), `${name} does not select the source run`)
  check(block.includes('github-token: ${{ github.token }}') && block.includes('repository: ${{ github.repository }}'), `${name} cannot download across runs`)
  check(block.includes('sha256sum --check SHA256SUMS') && block.includes('CONTROL_SHA'), `${name} does not verify the artifact`)
}
check(agentPublishJob.includes('id-token: write') && !agentPublishJob.includes('contents: write'), 'Agent App publisher permissions are wrong')
check(!agentPublishJob.includes('secrets.') && !agentPublishJob.includes('CREATE_AGENT_APP_NPM_TOKEN'), 'Agent App publisher receives a long-lived secret')
check(!agentPublishJob.includes('registry-url:'), 'Agent App publisher receives token npm configuration')
check(agentPublishJob.includes('publish agent-app agent-app.tgz') && !agentPublishJob.includes('create-agent-app.tgz'), 'Agent App publisher can publish the wrong tarball')
check(createPublishJob.includes('id-token: write') && !createPublishJob.includes('contents: write'), 'create-agent-app publisher permissions are wrong')
check(createPublishJob.includes('CREATE_AGENT_APP_NPM_TOKEN: ${{ secrets.CREATE_AGENT_APP_NPM_TOKEN }}'), 'create-agent-app publisher lacks its token')
check(createPublishJob.includes('registry-url: https://registry.npmjs.org'), 'create-agent-app publisher lacks npm token configuration')
check(createPublishJob.includes('publish create-agent-app create-agent-app.tgz') && !createPublishJob.includes('publish agent-app '), 'create-agent-app publisher can publish the wrong tarball')

for (const [name, block] of [['safety_net_issue', safetyIssueJob], ['safety_net_clear', safetyClearJob]]) {
  check(block.includes('issues: write'), `${name} cannot maintain the rolling issue`)
  check(block.includes("github.event_name == 'push'") && block.includes("github.ref == 'refs/heads/main'"), `${name} can run outside main pushes`)
}
check(safetyIssueJob.includes("needs.package_release.result == 'failure'"), 'failed verification does not open the rolling issue')
check(safetyClearJob.includes("needs.package_release.result == 'success'"), 'successful verification does not clear the rolling issue')

check(script.includes('--provenance') && script.includes('--ignore-scripts'), 'publish command lacks provenance or allows lifecycle scripts')

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
