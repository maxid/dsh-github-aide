/**
 * Configuration and credential-store tests.
 *
 * The token store is exercised against a fake `ctx.credentials` port, so this
 * suite proves the record semantics (revision increments, blanking, describe)
 * without the harness or a filesystem. Environment precedence is tested by
 * setting and restoring the real `process.env` entries.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULTS,
  NAMESPACE,
  TOKEN_ENV_VARS,
  createTokenStore,
  environmentToken,
  normalizeConfig,
  resolveToken,
} from '../lib/config.js'

const RECORD_KEY = 'dsh-github-aide/configuration'

/**
 * A minimal in-memory implementation of the harness credential port.
 *
 * @param {{ failRead?: boolean, failDescribe?: boolean, record?: object }} [options]
 * @returns {{ port: object, state: object }} the port plus its observable state.
 */
function fakeCredentials(options = {}) {
  const state = { record: options.record, readonly: options.failDescribe === true, writes: [], deletes: [] }
  const port = {
    async readRecord(key) {
      if (options.failRead === true) throw new Error('credential store unavailable')
      assert.equal(key, RECORD_KEY)
      return state.record
    },
    async modifyRecord(key, mutate) {
      assert.equal(key, RECORD_KEY)
      const next = await mutate(state.record)
      state.writes.push(next)
      if (next === undefined) state.record = undefined
      else state.record = next
      return next
    },
    async describeRecord(key) {
      if (options.failDescribe === true) throw new Error('cannot describe')
      assert.equal(key, RECORD_KEY)
      const configured = state.record?.kind === 'grant' && (state.record.payload?.token ?? '').length > 0
      return { configured, writable: true }
    },
    async deleteRecord(key) {
      assert.equal(key, RECORD_KEY)
      state.deletes.push(key)
      state.record = undefined
    },
  }
  return { port, state }
}

/** Build a token store over a fake port. */
function storeWith(options) {
  const { port, state } = fakeCredentials(options)
  return { store: createTokenStore({ credentials: port }, RECORD_KEY), state }
}

// -------------------------------------------------------------- identity bits

test('the package identity matches the contract', () => {
  assert.equal(NAMESPACE, 'github-aide')
  assert.deepEqual(TOKEN_ENV_VARS, ['GITHUB_TOKEN', 'GH_TOKEN'])
})

test('DEFAULTS carries every documented key', () => {
  assert.deepEqual(DEFAULTS, {
    owner: '',
    visibility: 'private',
    autoInit: false,
    branch: '',
    commitMessage: '',
    allowSensitive: false,
    autoIgnore: true,
    timeoutMs: 600000,
    maxScanFiles: 8000,
  })
  assert.ok(Object.isFrozen(DEFAULTS))
})

// ------------------------------------------------------------ normalizeConfig

test('normalizeConfig fills every default from nothing', () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULTS })
  assert.deepEqual(normalizeConfig(null), { ...DEFAULTS })
  assert.deepEqual(normalizeConfig({}), { ...DEFAULTS })
})

test('normalizeConfig keeps valid values', () => {
  const config = normalizeConfig({
    owner: ' octocat ',
    visibility: 'public',
    autoInit: true,
    branch: 'trunk',
    commitMessage: 'feat: first',
    allowSensitive: true,
    autoIgnore: false,
    timeoutMs: 120000,
    maxScanFiles: 500,
  })
  assert.deepEqual(config, {
    owner: 'octocat',
    visibility: 'public',
    autoInit: true,
    branch: 'trunk',
    commitMessage: 'feat: first',
    allowSensitive: true,
    autoIgnore: false,
    timeoutMs: 120000,
    maxScanFiles: 500,
  })
})

test('normalizeConfig normalises the owner handle', () => {
  assert.equal(normalizeConfig({ owner: '@octocat' }).owner, 'octocat')
  assert.equal(normalizeConfig({ owner: 42 }).owner, '')
  assert.equal(normalizeConfig({ owner: '   ' }).owner, '')
})

test('normalizeConfig clamps visibility to the three accepted values', () => {
  assert.equal(normalizeConfig({ visibility: 'internal' }).visibility, 'internal')
  assert.equal(normalizeConfig({ visibility: 'PUBLIC' }).visibility, 'public')
  assert.equal(normalizeConfig({ visibility: 'secret' }).visibility, 'private')
  assert.equal(normalizeConfig({ visibility: 7 }).visibility, 'private')
})

test('normalizeConfig does not coerce non-boolean flags', () => {
  assert.equal(normalizeConfig({ autoInit: 'true' }).autoInit, false)
  assert.equal(normalizeConfig({ allowSensitive: 1 }).allowSensitive, false)
  assert.equal(normalizeConfig({ autoIgnore: 'no' }).autoIgnore, true)
  assert.equal(normalizeConfig({ autoInit: true }).autoInit, true)
})

test('normalizeConfig clamps the timeout and file budget', () => {
  assert.equal(normalizeConfig({ timeoutMs: -5 }).timeoutMs, 600000)
  assert.equal(normalizeConfig({ timeoutMs: 0 }).timeoutMs, 600000)
  assert.equal(normalizeConfig({ timeoutMs: Number.NaN }).timeoutMs, 600000)
  assert.equal(normalizeConfig({ timeoutMs: 10 }).timeoutMs, 1000)
  assert.equal(normalizeConfig({ timeoutMs: 99_000_000 }).timeoutMs, 3_600_000)
  assert.equal(normalizeConfig({ timeoutMs: 12_345.9 }).timeoutMs, 12_345)

  assert.equal(normalizeConfig({ maxScanFiles: 0 }).maxScanFiles, 8000)
  assert.equal(normalizeConfig({ maxScanFiles: -1 }).maxScanFiles, 8000)
  assert.equal(normalizeConfig({ maxScanFiles: Number.POSITIVE_INFINITY }).maxScanFiles, 8000)
  assert.equal(normalizeConfig({ maxScanFiles: 0.5 }).maxScanFiles, 1)
  assert.equal(normalizeConfig({ maxScanFiles: 9_999_999 }).maxScanFiles, 1_000_000)
})

test('normalizeConfig sanitises a branch name', () => {
  assert.equal(normalizeConfig({ branch: ' feature/new ' }).branch, 'feature/new')
  assert.equal(normalizeConfig({ branch: 'a b' }).branch, 'ab')
  assert.equal(normalizeConfig({ branch: 'a..b' }).branch, 'a.b')
  assert.equal(normalizeConfig({ branch: '~bad^' }).branch, 'bad')
  assert.equal(normalizeConfig({ branch: 42 }).branch, '')
})

test('normalizeConfig drops unknown keys and returns a fresh object', () => {
  const config = normalizeConfig({ evil: true, visibility: 'public' })
  assert.equal('evil' in config, false)
  config.visibility = 'internal'
  assert.equal(DEFAULTS.visibility, 'private')
})

// ---------------------------------------------------------------- token store

test('createTokenStore rejects a missing record key', () => {
  const ctx = { credentials: {} }
  for (const bad of [undefined, null, '', '   ', 42]) {
    assert.throws(() => createTokenStore(ctx, bad), error => error.code === 'BAD_REQUEST')
  }
})

test('read() reports an empty record when nothing is stored', async () => {
  const { store } = storeWith({})
  assert.deepEqual(await store.read(), { revision: 0, token: '', login: '', scopes: [] })
})

test('read() only accepts a grant record with a string token', async () => {
  const { store } = storeWith({
    record: { kind: 'credential', payload: { revision: 3, token: 'ghp_x', login: 'octocat', scopes: ['repo'] } },
  })
  assert.deepEqual(await store.read(), { revision: 0, token: '', login: '', scopes: [] })

  const { store: grant } = storeWith({
    record: { kind: 'grant', payload: { revision: 3, token: 'ghp_x', login: 'octocat', scopes: ['repo'] } },
  })
  assert.deepEqual(await grant.read(), { revision: 3, token: 'ghp_x', login: 'octocat', scopes: ['repo'] })
})

test('write() stores a payload and bumps the revision', async () => {
  const { store, state } = storeWith({})
  const first = await store.write({ token: 'ghp_one', login: 'octocat', scopes: ['repo'] })
  assert.deepEqual(first, { revision: 1, token: 'ghp_one', login: 'octocat', scopes: ['repo'] })
  assert.equal(state.record.kind, 'grant')

  const second = await store.write({ token: 'ghp_two' })
  assert.equal(second.revision, 2)
  assert.equal(second.token, 'ghp_two')
  // Omitted fields keep their previous values (`??` semantics).
  assert.equal(second.login, 'octocat')
  assert.deepEqual(second.scopes, ['repo'])
  assert.deepEqual(await store.read(), second)
})

test('write() rejects a non-string token without touching the record', async () => {
  const { store, state } = storeWith({})
  await assert.rejects(() => store.write({ token: 42 }), error => error.code === 'BAD_REQUEST')
  assert.equal(state.writes.length, 0)
  assert.equal(state.record, undefined)
})

test('clear() blanks the record but keeps it present', async () => {
  const { store, state } = storeWith({})
  await store.write({ token: 'ghp_one', login: 'octocat', scopes: ['repo'] })
  await store.clear()
  assert.deepEqual(await store.read(), { revision: 0, token: '', login: '', scopes: [] })
  assert.notEqual(state.record, undefined)
  assert.equal(state.record.kind, 'grant')
  const described = await store.describe()
  assert.deepEqual(described, { configured: false, writable: true, login: '' })
})

test('describe() reports a stored token and tolerates a broken port', async () => {
  const { store } = storeWith({})
  await store.write({ token: 'ghp_one', login: 'octocat' })
  assert.deepEqual(await store.describe(), { configured: true, writable: true, login: 'octocat' })

  const brokenRead = storeWith({ failRead: true }).store
  assert.deepEqual(await brokenRead.describe(), { configured: false, writable: false, login: '' })

  const brokenDescribe = storeWith({ failDescribe: true }).store
  assert.deepEqual(await brokenDescribe.describe(), { configured: false, writable: false, login: '' })
})

// ------------------------------------------------------------- env precedence

/** Run `body` with the token env vars restored afterwards. */
async function withCleanTokenEnv(body) {
  const saved = TOKEN_ENV_VARS.map(name => [name, process.env[name]])
  for (const name of TOKEN_ENV_VARS) delete process.env[name]
  try {
    return await body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('environmentToken() returns undefined when nothing is set', async () => {
  await withCleanTokenEnv(() => {
    assert.equal(environmentToken(), undefined)
  })
})

test('environmentToken() prefers GITHUB_TOKEN over GH_TOKEN and trims', async () => {
  await withCleanTokenEnv(() => {
    process.env.GH_TOKEN = 'ghp_gh'
    assert.deepEqual(environmentToken(), { token: 'ghp_gh', source: 'GH_TOKEN' })
    process.env.GITHUB_TOKEN = '  ghp_github  '
    assert.deepEqual(environmentToken(), { token: 'ghp_github', source: 'GITHUB_TOKEN' })
    process.env.GITHUB_TOKEN = '   '
    assert.deepEqual(environmentToken(), { token: 'ghp_gh', source: 'GH_TOKEN' })
  })
})

test('resolveToken() lets the environment win over the stored record', async () => {
  await withCleanTokenEnv(async () => {
    const { store } = storeWith({})
    await store.write({ token: 'ghp_stored', login: 'octocat' })
    assert.deepEqual(await resolveToken(store), { token: 'ghp_stored', source: 'credentials' })

    process.env.GH_TOKEN = 'ghp_env'
    assert.deepEqual(await resolveToken(store), { token: 'ghp_env', source: 'GH_TOKEN' })
  })
})

test('resolveToken() returns undefined when no token exists anywhere', async () => {
  await withCleanTokenEnv(async () => {
    const { store } = storeWith({})
    assert.equal(await resolveToken(store), undefined)
  })
})
