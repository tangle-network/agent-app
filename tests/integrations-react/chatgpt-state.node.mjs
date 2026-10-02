import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHATGPT_PLUGINS_URL, chatGPTView } from '../../src/integrations-react/chatgpt-state.ts'

// Synthetic display fixtures only. These IDs are not registration or hosted proof.
const enrollment = { enrollmentId: 'fixture-enrollment', agentId: 'fixture-agent', workspaceId: 'fixture-workspace', threadId: 'fixture-thread' }
const base = { app: { name: 'Fixture app' }, enrollment, endpoint: 'https://fixture.example/api/agents/mcp' }
const registration = { connectionId: 'asdk_app_fixture', endpoint: base.endpoint }
const connected = { status: 'connected', registration, enrollment }

const project = connection => chatGPTView({ ...base, connection })

test('setup and registration do not imply connection', () => {
  assert.equal(project().status, 'setup')
  assert.equal(project({ status: 'setup' }).status, 'setup')
  const registered = project({ status: 'registered', registration })
  assert.equal(registered.status, 'registered')
  assert.match(registered.description, /alone does not confirm/)
  assert.equal(project(connected).status, 'connected')
})

for (const prefix of ['asdk_app_', 'plugin_asdk_app_', 'connector_', 'templated_apps_']) {
  test(`displays supplied ${prefix} registration without constructing an install URL`, () => {
    const connectionId = `${prefix}fixture_1-test`
    assert.equal(project({ status: 'registered', registration: { ...registration, connectionId } }).connectionId, connectionId)
    assert.equal(CHATGPT_PLUGINS_URL, 'https://chatgpt.com/plugins')
  })
}

for (const key of Object.keys(enrollment)) {
  test(`a changed ${key} invalidates connected display and hides the stale ID`, () => {
    const view = chatGPTView({ ...base, enrollment: { ...enrollment, [key]: 'another' }, connection: connected })
    assert.equal(view.status, 'error')
    assert.equal(view.connectionId, undefined)
    assert.match(view.description, /different agent or conversation/)
  })
  test(`an empty ${key} cannot present a valid enrollment`, () => {
    const view = chatGPTView({ ...base, enrollment: { ...enrollment, [key]: ' ' }, connection: connected })
    assert.equal(view.status, 'unavailable')
    assert.equal(view.action, null)
  })
}

test('the same ID on a different endpoint is not reused', () => {
  for (const status of ['registered', 'connected']) {
    const view = project({ ...connected, status, registration: { ...registration, endpoint: 'https://other.example/mcp' } })
    assert.equal(view.status, 'error')
    assert.equal(view.connectionId, undefined)
  }
})

test('normalizes standard HTTPS URL spelling without changing the resource path', () => {
  const view = project({ status: 'registered', registration: { ...registration, endpoint: 'https://FIXTURE.example:443/api/agents/mcp' } })
  assert.equal(view.status, 'registered')
  assert.equal(view.endpoint, base.endpoint)
  assert.equal(project({ status: 'registered', registration: { ...registration, endpoint: `${base.endpoint}/` } }).status, 'error')
})

test('invalid, credential-bearing and non-HTTPS endpoints are never displayed', () => {
  for (const endpoint of ['', 'javascript:alert(1)', 'http://localhost/mcp', 'https://user:secret@fixture.example/mcp',
    'https://fixture.example/mcp?token=private', 'https://fixture.example/mcp#private', 'https://fixture.example/\\mcp', 'https://fixture.example/mcp\n']) {
    const view = chatGPTView({ ...base, endpoint, connection: connected })
    assert.equal(view.status, 'unavailable', endpoint)
    assert.equal(view.endpoint, null)
    assert.equal(view.action, null)
    assert.equal(view.connectionId, undefined)
  }
})

test('malformed or missing host observations fail closed without reflecting raw errors', () => {
  for (const connection of [
    { status: 'connected', registration },
    { status: 'registered' },
    { status: 'registered', registration: { ...registration, connectionId: 'https://chatgpt.com/plugins/fake' } },
    { status: 'registered', registration: { ...registration, connectionId: 'asdk_app_' } },
    { status: 'installed', token: 'private' },
    { status: 'error', message: 'Bearer private' },
  ]) {
    const view = project(connection)
    assert.equal(view.status, 'error')
    assert.equal(view.connectionId, undefined)
    assert.doesNotMatch(JSON.stringify(view), /Bearer|private|fake/)
  }
})

test('checking and errors replace a previously confirmed observation', () => {
  assert.equal(project(connected).status, 'connected')
  assert.equal(project({ status: 'checking' }).status, 'checking')
  assert.equal(project({ status: 'checking' }).action, null)
  assert.equal(project({ status: 'error' }).status, 'error')
  assert.equal(project({ status: 'error' }).connectionId, undefined)
  assert.equal(project(connected).status, 'connected')
})

test('projection does not mutate native identity or registration', () => {
  const freeze = value => {
    Object.values(value).forEach(item => { if (item && typeof item === 'object') freeze(item) })
    return Object.freeze(value)
  }
  const props = freeze(structuredClone({ ...base, connection: connected }))
  const before = JSON.stringify(props)
  assert.equal(chatGPTView(props).status, 'connected')
  assert.equal(JSON.stringify(props), before)
})
