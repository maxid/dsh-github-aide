/**
 * Offline aggregate verification for dsh-github-aide.
 *
 * A self-contained runner (its own tiny harness, no test framework, no DSH
 * packages) that exercises every layer: pure helpers, config + credential store,
 * the REST client over a stub fetch, real git against local bare repositories,
 * and the merged publish flow end to end with a fake GitHub API.
 *
 * Run from the repository root:
 *   node test/verify.mjs
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

import { buildGitignore, detectStacks, formatBytes, sensitivePathKind, suggestRepoName } from '../lib/detect.js'
import { DEFAULTS, NAMESPACE, TOKEN_ENV_VARS, createTokenStore, environmentToken, normalizeConfig, resolveToken } from '../lib/config.js'
import { DEFAULT_API_BASE_URL, GitHubApiError, createGitHubApi } from '../lib/github.js'
import { GitHubAideError, describeError, redact } from '../lib/errors.js'
import * as git from '../lib/git.js'
import { preflight, publish } from '../lib/publish.js'
import { scanProject } from '../lib/scan.js'
import { slugifyRepoName } from '../lib/workspace.js'

const execFileAsync = promisify(execFile)
const TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'
const VIEWER = { login: 'octocat', id: 583231 }

let passed = 0
let failed = 0

/**
 * Run one named check, reporting a failure without aborting the suite.
 * @param {string} label - what is being checked.
 * @param {() => any} body - the check.
 */
async function check(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok   ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

const scratch = await mkdtemp(path.join(tmpdir(), 'dsh-github-aide-verify-'))

/** Write a project fixture. */
async function makeProject(name, files) {
  const dir = path.join(scratch, name)
  await mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file)
    await mkdir(path.join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return dir
}

/** Create a bare repository to act as an offline remote. */
async function makeBare(name) {
  const dir = path.join(scratch, `${name}.git`)
  await mkdir(dir, { recursive: true })
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main'], { cwd: dir })
  return dir
}

/** Keep the machine's git identity out of fixtures that should use the fallback. */
async function withIsolatedGitIdentity(body) {
  const empty = path.join(scratch, 'empty-gitconfig')
  await writeFile(empty, '', 'utf8')
  const saved = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = empty
  try {
    return await body()
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = saved
  }
}

/** Fake GitHub API whose created repository points at a local bare remote. */
function fakeApi(cloneUrl) {
  const repos = new Map()
  const calls = { find: [], create: [] }
  return {
    calls,
    async findRepository(owner, repo) {
      calls.find.push([owner, repo])
      return { exists: repos.has(`${owner}/${repo}`), repository: repos.get(`${owner}/${repo}`) ?? null }
    },
    async createRepository(spec) {
      calls.create.push(spec)
      const key = `${VIEWER.login}/${spec.name}`
      const repository = { name: spec.name, html_url: `https://github.com/${key}`, clone_url: cloneUrl ?? `https://github.com/${key}.git` }
      repos.set(key, repository)
      return repository
    },
  }
}

/** The input object publish/preflight expect. */
function inputFor(root, overrides = {}) {
  return {
    root,
    config: normalizeConfig({}),
    api: null,
    tokenSource: '',
    viewer: null,
    logger: { info() {}, warn() {} },
    ...overrides,
  }
}

console.log('\ndsh-github-aide verify\n')

// ---------------------------------------------------------------- pure helpers

console.log('helpers')

await check('the package identity matches the contract', () => {
  assert.equal(NAMESPACE, 'github-aide')
  assert.deepEqual(TOKEN_ENV_VARS, ['GITHUB_TOKEN', 'GH_TOKEN'])
  assert.equal(DEFAULT_API_BASE_URL, 'https://api.github.com')
  assert.equal(DEFAULTS.visibility, 'private')
  assert.equal(DEFAULTS.autoInit, false)
})

await check('slugifyRepoName produces names GitHub accepts', () => {
  assert.equal(slugifyRepoName('My Project'), 'my-project')
  assert.equal(slugifyRepoName('DSH插件'), 'dsh')
  assert.equal(slugifyRepoName('  ..weird//name..  '), 'weird-name')
  assert.equal(slugifyRepoName(''), 'project')
  assert.equal(slugifyRepoName('a'.repeat(200)).length, 100)
})

await check('detectStacks recognises stacks by marker and directory', () => {
  assert.deepEqual(detectStacks({ files: ['package.json'], dirs: [] }).map(stack => stack.id), ['node'])
  assert.deepEqual(
    detectStacks({ files: ['Cargo.toml', 'go.mod', 'requirements.txt'], dirs: [] }).map(stack => stack.id).sort(),
    ['go', 'python', 'rust'],
  )
  assert.deepEqual(detectStacks({ files: [], dirs: ['node_modules'] }).map(stack => stack.id), ['node'])
})

await check('buildGitignore includes detected ignores and the common tail', () => {
  const text = buildGitignore(detectStacks({ files: ['package.json'], dirs: [] }))
  assert.match(text, /node_modules\//)
  assert.match(text, /\.DS_Store/)
  assert.equal(text.split('\n').filter(line => line === 'node_modules/').length, 1)
})

await check('sensitivePathKind classifies credential files and directories', () => {
  assert.equal(sensitivePathKind('.env'), 'file')
  assert.equal(sensitivePathKind('certs/server.pem'), 'file')
  assert.equal(sensitivePathKind('.ssh/x'), 'dir')
  assert.equal(sensitivePathKind('src/index.js'), undefined)
})

await check('formatBytes renders a human size', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB')
})

await check('suggestRepoName never returns an empty name', () => {
  assert.equal(suggestRepoName('C:\\work\\My Project!'), 'my-project')
  assert.equal(suggestRepoName('!!!'), 'my-project')
})

await check('redact masks every token shape it may echo', () => {
  const masked = redact(`fatal: https://x-access-token:${TOKEN}@github.com/o/r.git`)
  assert.ok(!masked.includes(TOKEN))
  assert.match(masked, /\[REDACTED\]/)
  assert.ok(!redact('token github_pat_' + '11ABCDEFG0abcdefghijkl_rest').includes('github_pat_'))
  assert.ok(!redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').includes('abcdefghijklmnopqrstuvwxyz'))
  assert.equal(redact('git push origin main'), 'git push origin main')
})

await check('describeError normalizes known and unknown failures', () => {
  const known = describeError(new GitHubAideError('NOT_CONFIGURED', 'nope', { nextStep: 'do it' }))
  assert.deepEqual(known, { code: 'NOT_CONFIGURED', message: 'nope', nextStep: 'do it' })
  assert.equal(describeError(new Error('boom')).code, 'FAILED')
})

// ------------------------------------------------------------------- config

console.log('\nconfig and credential store')

await check('normalizeConfig fills defaults and clamps invalid values', () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULTS })
  assert.equal(normalizeConfig({ visibility: 'secret' }).visibility, 'private')
  assert.equal(normalizeConfig({ visibility: 'public' }).visibility, 'public')
  assert.equal(normalizeConfig({ timeoutMs: 0 }).timeoutMs, 600000)
  assert.equal(normalizeConfig({ timeoutMs: 10 }).timeoutMs, 1000)
  assert.equal(normalizeConfig({ maxScanFiles: 0 }).maxScanFiles, 8000)
  assert.equal(normalizeConfig({ maxScanFiles: 2.5 }).maxScanFiles, 2)
  assert.equal(normalizeConfig({ autoInit: 'true' }).autoInit, false)
  assert.equal(normalizeConfig({ evil: 1 }).evil, undefined)
})

await check('the token store writes, preserves, clears, and describes', async () => {
  let record
  const key = 'dsh-github-aide/configuration'
  const store = createTokenStore({
    credentials: {
      async readRecord() { return record },
      async modifyRecord(requested, mutate) {
        assert.equal(requested, key)
        record = await mutate(record)
        return record
      },
      async describeRecord() { return { configured: Boolean(record?.payload?.token), writable: true } },
      async deleteRecord() { record = undefined },
    },
  }, key)

  assert.deepEqual(await store.read(), { revision: 0, token: '', login: '', scopes: [] })
  const first = await store.write({ token: 'ghp_one', login: 'octocat', scopes: ['repo'] })
  assert.equal(first.revision, 1)
  const second = await store.write({ token: 'ghp_two' })
  assert.equal(second.revision, 2)
  assert.equal(second.login, 'octocat')
  assert.deepEqual(await store.describe(), { configured: true, writable: true, login: 'octocat' })
  await store.clear()
  assert.deepEqual(await store.read(), { revision: 0, token: '', login: '', scopes: [] })
  assert.equal((await store.describe()).configured, false)
})

await check('environmentToken and resolveToken prefer environment over the store', async () => {
  const saved = TOKEN_ENV_VARS.map(name => [name, process.env[name]])
  for (const name of TOKEN_ENV_VARS) delete process.env[name]
  try {
    const store = {
      read: async () => ({ revision: 1, token: 'ghp_stored', login: 'octocat', scopes: [] }),
    }
    assert.equal(environmentToken(), undefined)
    assert.deepEqual(await resolveToken(store), { token: 'ghp_stored', source: 'credentials' })
    process.env.GH_TOKEN = 'ghp_env'
    assert.deepEqual(environmentToken(), { token: 'ghp_env', source: 'GH_TOKEN' })
    assert.deepEqual(await resolveToken(store), { token: 'ghp_env', source: 'GH_TOKEN' })
    delete process.env.GH_TOKEN
    assert.equal(await resolveToken({ read: async () => ({ token: '' }) }), undefined)
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

// -------------------------------------------------------------- GitHub client

console.log('\nGitHub REST client (stub fetch)')

/** Build a fake fetch returning one canned response. */
function stubFetch(body, status = 200, headers = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  }
  return { impl, calls }
}

await check('getViewer sends the documented headers', async () => {
  const stub = stubFetch({ login: 'octocat', id: 583231 })
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  assert.deepEqual(await api.getViewer(), { login: 'octocat', id: 583231 })
  assert.equal(stub.calls[0].url, 'https://api.github.com/user')
  assert.equal(stub.calls[0].init.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(stub.calls[0].init.headers['user-agent'], 'dsh-github-aide')
  assert.equal(stub.calls[0].init.redirect, 'error')
})

await check('getTokenScopes separates classic from fine-grained tokens', async () => {
  const classic = createGitHubApi({ token: TOKEN, fetchImpl: stubFetch({ login: 'octocat', id: 1 }, 200, { 'x-oauth-scopes': 'repo, read:user' }).impl })
  assert.deepEqual(await classic.getTokenScopes(), { scopes: ['repo', 'read:user'], classic: true })
  const fine = createGitHubApi({ token: TOKEN, fetchImpl: stubFetch({ login: 'octocat', id: 1 }).impl })
  assert.deepEqual(await fine.getTokenScopes(), { scopes: [], classic: false })
})

await check('findRepository and createRepository map the REST protocol', async () => {
  const find = stubFetch({ name: 'demo', html_url: 'https://github.com/octocat/demo' })
  const api = createGitHubApi({ token: TOKEN, fetchImpl: find.impl })
  const found = await api.findRepository('octocat', 'demo')
  assert.equal(found.exists, true)
  assert.equal(find.calls[0].url, 'https://api.github.com/repos/octocat/demo')

  const missing = createGitHubApi({ token: TOKEN, fetchImpl: stubFetch({ message: 'Not Found' }, 404).impl })
  assert.deepEqual(await missing.findRepository('octocat', 'gone'), { exists: false, repository: null })

  const create = stubFetch({ name: 'demo', html_url: 'https://github.com/octocat/demo' }, 201)
  await createGitHubApi({ token: TOKEN, fetchImpl: create.impl }).createRepository({
    name: 'demo',
    visibility: 'private',
    autoInit: false,
  })
  assert.deepEqual(JSON.parse(create.calls[0].init.body), { name: 'demo', private: true, auto_init: false })
})

await check('HTTP failures map to stable codes', async () => {
  const unauthorised = createGitHubApi({ token: TOKEN, fetchImpl: stubFetch({ message: `Bad ${TOKEN}` }, 401).impl })
  const authError = await unauthorised.getViewer().catch(error => error)
  assert.equal(authError.code, 'TOKEN_REJECTED')
  assert.ok(!authError.message.includes(TOKEN))

  const forbidden = createGitHubApi({ token: TOKEN, fetchImpl: stubFetch({ message: 'nope' }, 403, { 'x-accepted-github-permissions': 'administration=write' }).impl })
  const permissionError = await forbidden.createRepository({ name: 'demo', visibility: 'private' }).catch(error => error)
  assert.equal(permissionError.code, 'PERMISSION')
  assert.match(permissionError.nextStep, /administration=write/)

  const server = createGitHubApi({ token: TOKEN, fetchImpl: stubFetch({ message: 'boom' }, 500).impl })
  assert.equal((await server.getViewer().catch(error => error)).code, 'API_FAILED')
  assert.ok((await server.getViewer().catch(error => error)) instanceof GitHubApiError)
})

await check('a TLS failure is its own condition', async () => {
  const impl = async () => {
    const failure = new TypeError('fetch failed')
    failure.cause = Object.assign(new Error('unable to verify the first certificate'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })
    throw failure
  }
  const error = await createGitHubApi({ token: TOKEN, fetchImpl: impl }).getViewer().catch(problem => problem)
  assert.equal(error.code, 'TLS_UNTRUSTED')
  assert.match(error.nextStep, /NODE_EXTRA_CA_CERTS/)
})

// ----------------------------------------------------------------- filesystem

console.log('\nscan')

await check('the walk skips dependency directories and never follows symlinks', async () => {
  const outside = await makeProject('verify-outside', { 'secret.txt': `ghp_${'a'.repeat(36)}` })
  const dir = await makeProject('verify-scan', {
    'package.json': '{}',
    '.env': 'SECRET=abcdefghijklmnop\n',
    'config.js': `const token = "${TOKEN}"\n`,
    'node_modules/pkg/index.js': 'module.exports = 1\n',
  })
  const { symlink } = await import('node:fs/promises')
  await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'linked.txt'))
  const report = await scanProject(dir)
  assert.equal(report.files, 3)
  assert.ok(report.sensitive.some(entry => entry.path === '.env' && entry.kind === 'file'))
  assert.ok(report.sensitive.some(entry => entry.path === 'config.js' && entry.kind === 'content'))
  assert.ok(!report.sensitive.some(entry => entry.path === 'linked.txt'))
  assert.equal(report.truncated, false)
  assert.ok(report.topLevel.files.includes('package.json'))
})

await check('the walk truncates at the file budget', async () => {
  const files = {}
  for (let index = 0; index < 5; index += 1) files[`f-${index}.txt`] = 'x\n'
  const dir = await makeProject('verify-budget', files)
  const report = await scanProject(dir, { maxScanFiles: 2 })
  assert.equal(report.truncated, true)
  assert.ok(report.files <= 2)
})

// ----------------------------------------------------------------------- git

console.log('\ngit (local bare remote)')

const bare = await makeBare('verify-remote')

await check('a fresh repository initialises on the requested branch', async () => {
  const dir = await makeProject('verify-git', { 'README.md': '# demo\n' })
  assert.equal(await git.isGitRepo(dir), false)
  await git.initRepo(dir, 'main')
  assert.equal(await git.isGitRepo(dir), true)
  assert.equal(await git.currentBranch(dir), 'main')
  assert.equal(await git.headCommit(dir), '')
})

await check('identity, staging, and commit produce a SHA', async () => {
  const dir = path.join(scratch, 'verify-git')
  await git.configureIdentity(dir, 'octocat', '583231+octocat@users.noreply.github.com')
  assert.deepEqual(await git.statusEntries(dir), ['?? README.md'])
  await git.stageAll(dir)
  const sha = await git.commit(dir, 'Initial commit', true)
  assert.match(sha, /^[0-9a-f]{40}$/)
})

await check('the clean remote URL is what gets persisted', async () => {
  const dir = path.join(scratch, 'verify-git')
  const url = git.buildRemoteUrl('octocat', 'project')
  assert.equal(url, 'https://github.com/octocat/project.git')
  await git.setRemote(dir, 'origin', url)
  assert.equal(await git.getRemote(dir, 'origin'), url)
  const config = await readFile(path.join(dir, '.git', 'config'), 'utf8')
  assert.ok(!config.includes('x-access-token'))
})

await check('push reaches the bare remote', async () => {
  const dir = path.join(scratch, 'verify-git')
  await git.pushBranch(dir, bare, 'main')
  assert.equal(await git.remoteBranchExists(dir, bare, 'main'), true)
  const { stdout } = await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })
  assert.equal(stdout.trim(), await git.headCommit(dir))
})

await check('a diverged remote is fetched, rebased, and pushed', async () => {
  const other = path.join(scratch, 'verify-other')
  await execFileAsync('git', ['clone', bare, other], { cwd: scratch })
  await writeFile(path.join(other, 'OTHER.md'), 'other\n', 'utf8')
  await execFileAsync('git', ['config', 'user.name', 'Other'], { cwd: other })
  await execFileAsync('git', ['config', 'user.email', 'other@example.com'], { cwd: other })
  await execFileAsync('git', ['add', '--all'], { cwd: other })
  await execFileAsync('git', ['commit', '--message', 'remote side'], { cwd: other })
  await execFileAsync('git', ['push', bare, 'HEAD:refs/heads/main'], { cwd: other })

  const dir = path.join(scratch, 'verify-git')
  await writeFile(path.join(dir, 'LOCAL.md'), 'local\n', 'utf8')
  await git.stageAll(dir)
  await git.commit(dir, 'local side', true)
  await git.fetchBranch(dir, bare, 'main')
  await git.rebaseOntoFetchHead(dir)
  await git.pushBranch(dir, bare, 'main')
  const { stdout } = await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })
  assert.equal(stdout.trim(), await git.headCommit(dir))
})

await check('the askpass helper keeps the token off disk and argv', async () => {
  const helper = await git.createAskpassHelper({ token: TOKEN, login: 'x-access-token' })
  try {
    const dir = path.join(scratch, 'verify-git')
    const saved = new Map()
    for (const [key, value] of Object.entries(helper.env)) {
      saved.set(key, process.env[key])
      process.env[key] = value
    }
    try {
      await git.pushBranch(dir, bare, 'main')
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const config = await readFile(path.join(dir, '.git', 'config'), 'utf8')
    assert.ok(!config.includes(TOKEN))
    if (typeof helper.env.GIT_ASKPASS === 'string') {
      const script = await readFile(helper.env.GIT_ASKPASS, 'utf8').catch(() => '')
      assert.ok(!script.includes(TOKEN))
    }
  } finally {
    await helper.dispose()
  }
})

await check('gitVersion reports an installed git', async () => {
  assert.match(await git.gitVersion(), /^git version \d+\./)
})

// ------------------------------------------------------------------- publish

console.log('\npublish (fake API + local bare remote)')

await check('preflight is read-only', async () => {
  const root = await makeProject('verify-preflight', { 'index.js': 'x\n', 'package.json': '{}' })
  const report = await preflight(inputFor(root))
  assert.equal(report.ok, true)
  assert.equal(report.git.isRepo, false)
  assert.equal(report.project.hasGitignore, false)
  assert.equal(report.repoExists, null)
  assert.equal(await readFile(path.join(root, 'index.js'), 'utf8'), 'x\n')
  assert.equal((await git.isGitRepo(root)), false)
})

await check('publish creates the repository, commits, and pushes offline', async () => {
  const remote = await makeBare('verify-publish-remote')
  const root = await makeProject('verify-publish', {
    'package.json': '{"name":"demo"}\n',
    'src/index.js': 'export const answer = 42\n',
  })
  const api = fakeApi(remote)
  const result = await withIsolatedGitIdentity(() => publish(inputFor(root, {
    api,
    viewer: VIEWER,
    tokenSource: 'credentials',
    repo: 'demo',
    push: true,
  })))

  assert.equal(result.ok, true, result.summary)
  assert.equal(result.owner, 'octocat')
  assert.equal(result.repo, 'demo')
  assert.equal(result.html_url, 'https://github.com/octocat/demo')
  assert.equal(result.pushed, true)
  assert.equal(result.project_type, 'node')
  assert.match(result.commit, /^[0-9a-f]{40}$/)
  assert.equal(result.changed_files, 3, 'two project files plus the generated .gitignore')
  assert.equal(result.token_source, 'credentials')
  assert.equal(api.calls.create.length, 1)
  assert.equal(await git.getRemote(root, 'origin'), remote)
  const ignore = await readFile(path.join(root, '.gitignore'), 'utf8')
  assert.match(ignore, /node_modules\//)
  const { stdout } = await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote })
  assert.equal(stdout.trim(), result.commit)
})

await check('a second publish with no changes reuses HEAD', async () => {
  const root = path.join(scratch, 'verify-publish')
  const remote = path.join(scratch, 'verify-publish-remote.git')
  const api = fakeApi(remote)
  const first = await withIsolatedGitIdentity(() => publish(inputFor(root, {
    api, viewer: VIEWER, tokenSource: 'credentials', repo: 'demo', push: true,
  })))
  const second = await withIsolatedGitIdentity(() => publish(inputFor(root, {
    api, viewer: VIEWER, tokenSource: 'credentials', repo: 'demo', push: true,
  })))
  assert.equal(first.ok, true, first.summary)
  assert.equal(second.ok, true, second.summary)
  assert.equal(second.commit, first.commit)
  assert.equal(second.changed_files, 0)
})

await check('a sensitive project is blocked before any write', async () => {
  const root = await makeProject('verify-blocked', { 'index.js': 'x\n', '.env': 'SECRET=abcdefghijklmnop\n' })
  const error = await publish(inputFor(root, { push: false })).catch(problem => problem)
  assert.equal(error.code, 'SENSITIVE_BLOCKED')
  assert.equal(await git.isGitRepo(root), false)
})

await check('a dry run writes nothing and makes no mutating API call', async () => {
  const root = await makeProject('verify-dry', { 'a.txt': 'a\n' })
  const api = fakeApi()
  const result = await publish(inputFor(root, { api, viewer: VIEWER, dryRun: true, push: true }))
  assert.equal(result.ok, true)
  assert.equal(result.dry_run, true)
  assert.equal(result.pushed, false)
  assert.equal(await git.isGitRepo(root), false)
  assert.ok(api.calls.find.length <= 1, 'at most one read-only repository lookup may run')
  assert.deepEqual(api.calls.create, [])
})

await check('a missing directory is reported as NOT_A_DIRECTORY', async () => {
  const error = await publish(inputFor(path.join(scratch, 'not-here'), { push: false })).catch(problem => problem)
  assert.equal(error.code, 'NOT_A_DIRECTORY')
})

await rm(scratch, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed === 0 ? 0 : 1
