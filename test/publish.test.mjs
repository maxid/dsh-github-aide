/**
 * Offline end-to-end tests for the merged publish orchestration.
 *
 * The GitHub API is a stub and every remote is a bare repository in the OS temp
 * directory: the fake repository carries `clone_url` pointing at that bare repo,
 * so the full path (scan → gitignore → init → commit → repository create → push)
 * runs without a socket. Local fixtures also prove the read-only guarantees of
 * preflight and dry-run.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import * as git from '../lib/git.js'
import { preflight, publish } from '../lib/publish.js'

const execFileAsync = promisify(execFile)
const scratch = await mkdtemp(join(tmpdir(), 'dsh-gh-aide-publish-'))
const TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'
const VIEWER = { login: 'octocat', id: 583231 }

/** The exact RESULT field set every publish outcome must carry. */
const RESULT_KEYS = [
  'ok',
  'code',
  'summary',
  'owner',
  'repo',
  'html_url',
  'branch',
  'commit',
  'changed_files',
  'pushed',
  'token_source',
  'project_type',
  'scanned_files',
  'sensitive_hits',
  'dry_run',
  'update_notice',
  'next_step',
].sort()

after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** Keep the machine's real git identity out of these fixtures. */
async function withIsolatedGitIdentity(body) {
  const emptyConfig = join(scratch, 'empty-gitconfig')
  await writeFile(emptyConfig, '', 'utf8')
  const saved = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = emptyConfig
  try {
    return await body()
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = saved
  }
}

/** A project directory from a file map. */
async function makeProject(name, files = { 'index.js': 'console.log(1)\n', 'package.json': '{}\n' }) {
  const dir = join(scratch, name)
  await mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const target = join(dir, file)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return dir
}

/** A bare repository usable as the fake GitHub remote. */
async function makeBare(name) {
  const dir = join(scratch, `${name}.git`)
  await mkdir(dir, { recursive: true })
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main'], { cwd: dir })
  return dir
}

/**
 * Fake GitHub API with an in-memory repository table.
 * `clone_url` for created repositories points at the local bare remote.
 */
function fakeApi(options = {}) {
  const repos = new Map(Object.entries(options.initial ?? {}))
  const calls = { find: [], create: [] }
  return {
    calls,
    repos,
    async findRepository(owner, repo) {
      calls.find.push([owner, repo])
      const key = `${owner}/${repo}`
      return { exists: repos.has(key), repository: repos.get(key) ?? null }
    },
    async createRepository(spec) {
      calls.create.push(spec)
      const owner = options.owner ?? VIEWER.login
      const key = `${owner}/${spec.name}`
      const repository = {
        name: spec.name,
        full_name: key,
        html_url: `https://github.com/${key}`,
        clone_url: options.cloneUrl ?? `https://github.com/${key}.git`,
      }
      repos.set(key, repository)
      return repository
    },
  }
}

/** The `input` object publish/preflight expect, with sane defaults. */
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

/** Read a config key from a repository with raw git. */
async function gitConfig(dir, key) {
  const { stdout } = await execFileAsync('git', ['config', '--get', key], { cwd: dir })
  return stdout.trim()
}

/** Whether a repo has at least one commit. */
async function headOf(dir) {
  return git.headCommit(dir)
}

/** Whether a file exists. */
function exists(path) {
  return access(path).then(() => true, () => false)
}

/** Assert a publish failure comes back as a RESULT with the expected code. */
async function assertPublishFailure(code, body) {
  const result = await body()
  assert.equal(result.ok, false)
  assert.equal(result.code, code, `expected ${code}, got ${result.code}: ${result.summary}`)
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS, 'a failure RESULT keeps the shared shape')
  return result
}

// ------------------------------------------------------------------ preflight

test('preflight reports a fresh project and writes nothing', async () => {
  const root = await makeProject('preflight-fresh')
  const report = await preflight(inputFor(root))

  assert.equal(report.ok, true)
  assert.equal(report.root, root)
  assert.equal(report.repo, 'preflight-fresh')
  assert.equal(report.owner, '')
  assert.equal(report.git.isRepo, false)
  assert.equal(report.git.hasHead, false)
  assert.equal(report.project.hasGitignore, false)
  assert.deepEqual(report.project.sensitive, [])
  assert.equal(report.project.truncated, false)
  assert.equal(report.project.files, 2)
  assert.ok(report.project.stacks.some(entry => /node/i.test(entry)))
  assert.equal(report.repoExists, null)
  assert.ok(!report.html_url)

  assert.equal(await exists(join(root, '.git')), false)
  assert.equal(await exists(join(root, '.gitignore')), false)
})

test('preflight reports a sensitive hit and still writes nothing', async () => {
  const root = await makeProject('preflight-sensitive', {
    'index.js': 'x\n',
    '.env': 'SECRET=abcdefghijklmnop\n',
  })
  const report = await preflight(inputFor(root))
  assert.ok(report.project.sensitive.some(entry => entry.path === '.env'))
  assert.equal(await exists(join(root, '.git')), false)
  assert.equal(await exists(join(root, '.gitignore')), false)
})

test('preflight reports a missing directory as a value, not a throw', async () => {
  const report = await preflight(inputFor(join(scratch, 'missing-preflight')))
  assert.equal(report.ok, false)
  assert.equal(report.code, 'NOT_A_DIRECTORY')
})

test('preflight reports an empty directory as NO_FILES', async () => {
  const root = await makeProject('preflight-empty', {})
  const report = await preflight(inputFor(root))
  assert.equal(report.ok, false)
  assert.equal(report.code, 'NO_FILES')
})

test('preflight queries the remote when an API is supplied', async () => {
  const root = await makeProject('preflight-remote')
  const api = fakeApi({
    initial: {
      'octocat/demo': { html_url: 'https://github.com/octocat/demo', clone_url: 'https://github.com/octocat/demo.git' },
    },
  })
  const report = await preflight(inputFor(root, {
    api,
    viewer: VIEWER,
    tokenSource: 'credentials',
    repo: 'demo',
  }))
  assert.equal(report.ok, true)
  assert.equal(report.repoExists, true)
  assert.equal(report.html_url, 'https://github.com/octocat/demo')
  assert.equal(report.owner, 'octocat')
  assert.equal(report.viewer.login, 'octocat')
  assert.equal(report.token_source, 'credentials')
  assert.deepEqual(api.calls.find, [['octocat', 'demo']])
})

// ------------------------------------------------------------ local publish

test('publish with api:null and push:false initialises, ignores, and commits locally', async () => {
  const root = await makeProject('local-publish', {
    'package.json': '{"name":"demo"}\n',
    'src/index.js': 'export const answer = 42\n',
  })
  const result = await withIsolatedGitIdentity(() => publish(inputFor(root, { push: false })))

  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS)
  assert.equal(result.ok, true)
  assert.equal(result.pushed, false)
  assert.equal(result.dry_run, false)
  assert.equal(result.branch, 'main')
  assert.match(result.commit, /^[0-9a-f]{40}$/)
  assert.equal(result.project_type, 'node')
  assert.ok(result.scanned_files >= 2)
  assert.ok(result.changed_files >= 2)

  assert.equal(await git.isGitRepo(root), true)
  assert.equal(await headOf(root), result.commit)
  const ignore = await readFile(join(root, '.gitignore'), 'utf8')
  assert.match(ignore, /node_modules\//)
  assert.match(ignore, /\.DS_Store/)

  const identity = (await execFileAsync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: root })).stdout.trim()
  assert.match(identity, /@users\.noreply\.github\.com>$/)
})

test('a second publish with no changes reuses HEAD and reports zero changed files', async () => {
  const root = await makeProject('stable', { 'a.txt': 'a\n' })
  const first = await withIsolatedGitIdentity(() => publish(inputFor(root, { push: false })))
  const second = await withIsolatedGitIdentity(() => publish(inputFor(root, { push: false })))

  assert.equal(first.ok, true, first.summary)
  assert.equal(second.ok, true, second.summary)
  assert.equal(second.commit, first.commit, 'an unchanged tree keeps the same commit')
  assert.equal(second.changed_files, 0)
})

test('publish leaves an existing .gitignore untouched', async () => {
  const root = await makeProject('gitignore-kept', {
    'index.js': 'x\n',
    '.gitignore': '# mine\ncustom/\n',
  })
  await withIsolatedGitIdentity(() => publish(inputFor(root, { push: false })))
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), '# mine\ncustom/\n')
})

test('dry run writes nothing, pushes nothing, and makes no mutating API call', async () => {
  const root = await makeProject('dry-run')
  const api = fakeApi()
  const result = await publish(inputFor(root, {
    api,
    viewer: VIEWER,
    tokenSource: 'credentials',
    dryRun: true,
    push: true,
  }))

  assert.equal(result.ok, true)
  assert.equal(result.dry_run, true)
  assert.equal(result.pushed, false)
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS)
  assert.equal(await exists(join(root, '.git')), false)
  assert.equal(await exists(join(root, '.gitignore')), false)
  assert.ok(api.calls.find.length <= 1, 'at most one read-only lookup may run')
  assert.deepEqual(api.calls.create, [])
})

test('publish refuses an empty project with NO_FILES and writes nothing', async () => {
  const root = await makeProject('empty-project', {})
  await assertPublishFailure('NO_FILES', () => publish(inputFor(root, { push: false })))
  assert.equal(await exists(join(root, '.git')), false)
  assert.equal(await exists(join(root, '.gitignore')), false)
})

test('publish refuses a directory whose only content is dependency output', async () => {
  const root = await makeProject('only-node-modules', {
    'node_modules/pkg/index.js': 'module.exports = 1\n',
  })
  await assertPublishFailure('NO_FILES', () => publish(inputFor(root, { push: false })))
})

test('publish refuses a missing directory with NOT_A_DIRECTORY', async () => {
  await assertPublishFailure(
    'NOT_A_DIRECTORY',
    () => publish(inputFor(join(scratch, 'missing-project'), { push: false })),
  )
})

test('publish blocks credentials with SENSITIVE_BLOCKED and writes nothing', async () => {
  const root = await makeProject('blocked', {
    'index.js': 'x\n',
    '.env': 'SECRET=abcdefghijklmnop\n',
  })
  const api = fakeApi()
  await assertPublishFailure('SENSITIVE_BLOCKED', () => publish(inputFor(root, {
    api,
    viewer: VIEWER,
    tokenSource: 'credentials',
    push: true,
  })))
  assert.equal(await exists(join(root, '.git')), false)
  assert.equal(await exists(join(root, '.gitignore')), false)
  assert.deepEqual(api.calls.find, [])
  assert.deepEqual(api.calls.create, [])
})

test('allowSensitive lets a project with credentials through', async () => {
  const root = await makeProject('allowed-sensitive', {
    'index.js': 'x\n',
    '.env': 'SECRET=abcdefghijklmnop\n',
  })
  const result = await withIsolatedGitIdentity(() => publish(inputFor(root, {
    push: false,
    allowSensitive: true,
  })))
  assert.equal(result.ok, true, result.summary)
  assert.ok(result.sensitive_hits.some(hit => hit.path === '.env'))
})

// ------------------------------------------------- remote create / reuse / push

test('publish creates the repository, points origin at it, and pushes to the bare remote', async () => {
  const bare = await makeBare('created-remote')
  const root = await makeProject('create-and-push', { 'a.txt': 'a\n', 'package.json': '{}\n' })
  const api = fakeApi({ cloneUrl: bare })

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
  assert.equal(result.token_source, 'credentials')
  assert.match(result.commit, /^[0-9a-f]{40}$/)
  assert.equal(result.changed_files, 3, 'two project files plus the generated .gitignore')

  assert.equal(api.calls.create.length, 1)
  assert.equal(api.calls.create[0].name, 'demo')
  assert.equal(api.calls.create[0].visibility, 'private')
  assert.equal(api.calls.create[0].autoInit, false)

  assert.equal(await git.getRemote(root, 'origin'), bare)
  assert.equal(await git.remoteBranchExists(root, bare, 'main'), true)
  const bareHead = (await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })).stdout.trim()
  assert.equal(bareHead, result.commit)

  const config = await readFile(join(root, '.git', 'config'), 'utf8')
  assert.ok(!config.includes(TOKEN), 'the token must never reach .git/config')
  assert.ok(!config.includes('ghp_'))
})

test('publish reuses an existing repository instead of creating another', async () => {
  const bare = await makeBare('reused-remote')
  const root = await makeProject('reuse-project', { 'a.txt': 'a\n' })
  const api = fakeApi({
    cloneUrl: bare,
    initial: {
      'octocat/reused': {
        name: 'reused',
        full_name: 'octocat/reused',
        html_url: 'https://github.com/octocat/reused',
        clone_url: bare,
      },
    },
  })
  const result = await withIsolatedGitIdentity(() => publish(inputFor(root, {
    api,
    viewer: VIEWER,
    tokenSource: 'credentials',
    repo: 'reused',
    push: true,
  })))

  assert.equal(result.ok, true, result.summary)
  assert.equal(result.html_url, 'https://github.com/octocat/reused')
  assert.equal(api.calls.create.length, 0)
  assert.deepEqual(api.calls.find, [['octocat', 'reused']])
  assert.equal(result.pushed, true)
  assert.equal(await git.remoteBranchExists(root, bare, 'main'), true)
})

test('push:false creates the repository but never touches the remote', async () => {
  const bare = await makeBare('push-false-remote')
  const root = await makeProject('push-false-project', { 'a.txt': 'a\n' })
  const api = fakeApi({ cloneUrl: bare })
  const result = await withIsolatedGitIdentity(() => publish(inputFor(root, {
    api,
    viewer: VIEWER,
    tokenSource: 'credentials',
    repo: 'demo',
    push: false,
  })))

  assert.equal(result.ok, true, result.summary)
  assert.equal(result.pushed, false)
  assert.equal(result.html_url, '')
  // push:false is the local-only mode: no remote lookup and no repository creation.
  assert.equal(api.calls.find.length, 0)
  assert.equal(api.calls.create.length, 0)
  assert.equal(await git.remoteBranchExists(root, bare, 'main'), false)
  assert.equal(await git.getRemote(root, 'origin'), 'https://github.com/octocat/demo.git')
})

test('a diverged remote is rebased before a normal push', async () => {
  const bare = await makeBare('rebase-remote')
  const root = await makeProject('rebase-project', { 'a.txt': 'base\n' })
  const api = fakeApi({ cloneUrl: bare })
  const base = { api, viewer: VIEWER, tokenSource: 'credentials', repo: 'demo', push: true }

  const first = await withIsolatedGitIdentity(() => publish(inputFor(root, base)))
  assert.equal(first.ok, true, first.summary)

  // Move the remote ahead through a clone, then change a different local file.
  const other = join(scratch, 'rebase-other')
  await execFileAsync('git', ['clone', bare, other])
  await writeFile(join(other, 'OTHER.md'), 'other\n', 'utf8')
  await execFileAsync('git', ['config', 'user.name', 'Other'], { cwd: other })
  await execFileAsync('git', ['config', 'user.email', 'other@example.com'], { cwd: other })
  await execFileAsync('git', ['add', '--all'], { cwd: other })
  await execFileAsync('git', ['commit', '--message', 'remote side'], { cwd: other })
  await execFileAsync('git', ['push', bare, 'HEAD:refs/heads/main'], { cwd: other })

  await writeFile(join(root, 'LOCAL.md'), 'local\n', 'utf8')
  const second = await withIsolatedGitIdentity(() => publish(inputFor(root, base)))
  assert.equal(second.ok, true, second.summary)
  assert.equal(second.pushed, true)
  const bareHead = (await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })).stdout.trim()
  assert.equal(bareHead, second.commit)
})

test('a conflicting rebase is reported as REBASE_CONFLICT and leaves the remote untouched', async () => {
  const bare = await makeBare('conflict-remote')
  const root = await makeProject('conflict-project', { 'a.txt': 'base\n' })
  const api = fakeApi({ cloneUrl: bare })
  const base = { api, viewer: VIEWER, tokenSource: 'credentials', repo: 'demo', push: true }

  const first = await withIsolatedGitIdentity(() => publish(inputFor(root, base)))
  assert.equal(first.ok, true, first.summary)

  const other = join(scratch, 'conflict-other')
  await execFileAsync('git', ['clone', bare, other])
  await writeFile(join(other, 'a.txt'), 'remote change\n', 'utf8')
  await execFileAsync('git', ['config', 'user.name', 'Other'], { cwd: other })
  await execFileAsync('git', ['config', 'user.email', 'other@example.com'], { cwd: other })
  await execFileAsync('git', ['add', '--all'], { cwd: other })
  await execFileAsync('git', ['commit', '--message', 'remote edit'], { cwd: other })
  await execFileAsync('git', ['push', bare, 'HEAD:refs/heads/main'], { cwd: other })
  const remoteBefore = (await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })).stdout.trim()

  await writeFile(join(root, 'a.txt'), 'local change\n', 'utf8')
  await assertPublishFailure('REBASE_CONFLICT', () => withIsolatedGitIdentity(() => publish(inputFor(root, base))))

  const remoteAfter = (await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })).stdout.trim()
  assert.equal(remoteAfter, remoteBefore, 'a failed publish must not rewrite the remote')
  const entries = await readdirSafe(join(root, '.git'))
  assert.ok(!entries.includes('rebase-merge'))
  assert.ok(!entries.includes('rebase-apply'))
})

test('a forced publish replaces a diverged remote branch', async () => {
  const bare = await makeBare('force-remote')
  const root = await makeProject('force-project', { 'a.txt': 'base\n' })
  const api = fakeApi({ cloneUrl: bare })
  const base = { api, viewer: VIEWER, tokenSource: 'credentials', repo: 'demo', push: true }

  const first = await withIsolatedGitIdentity(() => publish(inputFor(root, base)))
  assert.equal(first.ok, true, first.summary)

  const other = join(scratch, 'force-other')
  await execFileAsync('git', ['clone', bare, other])
  await writeFile(join(other, 'OTHER.md'), 'other\n', 'utf8')
  await execFileAsync('git', ['config', 'user.name', 'Other'], { cwd: other })
  await execFileAsync('git', ['config', 'user.email', 'other@example.com'], { cwd: other })
  await execFileAsync('git', ['add', '--all'], { cwd: other })
  await execFileAsync('git', ['commit', '--message', 'remote side'], { cwd: other })
  await execFileAsync('git', ['push', bare, 'HEAD:refs/heads/main'], { cwd: other })

  await writeFile(join(root, 'LOCAL.md'), 'local\n', 'utf8')
  const forced = await withIsolatedGitIdentity(() => publish(inputFor(root, { ...base, force: true })))
  assert.equal(forced.ok, true, forced.summary)
  assert.equal(forced.pushed, true)
  const bareHead = (await execFileAsync('git', ['rev-parse', 'refs/heads/main'], { cwd: bare })).stdout.trim()
  assert.equal(bareHead, forced.commit)
})

test('publish reports NOT_CONFIGURED when a real push has no API', async () => {
  const root = await makeProject('no-api')
  await assertPublishFailure('NOT_CONFIGURED', () => publish(inputFor(root, { push: true })))
})

test('a token passed to publish never appears in the local git config', async () => {
  const bare = await makeBare('token-remote')
  const root = await makeProject('token-project', { 'a.txt': 'a\n' })
  const api = fakeApi({ cloneUrl: bare })
  const result = await withIsolatedGitIdentity(() => publish(inputFor(root, {
    api,
    viewer: VIEWER,
    tokenSource: 'credentials',
    token: TOKEN,
    repo: 'demo',
    push: true,
  })))
  assert.equal(result.ok, true, result.summary)
  const config = await readFile(join(root, '.git', 'config'), 'utf8')
  assert.ok(!config.includes(TOKEN))
  assert.ok(!result.summary.includes(TOKEN))
})

/** readdir that tolerates a missing directory. */
async function readdirSafe(path) {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}
