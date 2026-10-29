/**
 * Git-layer tests against real repositories on local disk.
 *
 * Every remote is a bare repository in the OS temp directory, so fetch, push,
 * rebase and force-with-lease are exercised for real without a network. A
 * throwaway `git` wrapper on PATH records the argv and the non-interactive
 * environment of every call, which is how the suite proves the token is never
 * passed as an argument.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import * as git from '../lib/git.js'

const execFileAsync = promisify(execFile)
const scratch = await mkdtemp(join(tmpdir(), 'dsh-gh-aide-git-'))
const TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'

after(async () => {
  await restorePath()
  await rm(scratch, { recursive: true, force: true })
})

/** Run raw git for fixture setup (never through the module under test). */
async function rawGit(args, cwd) {
  return execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
}

/** Write a set of files into a fresh directory. */
async function makeProject(name, files = { 'README.md': '# demo\n' }) {
  const dir = join(scratch, name)
  await mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const target = join(dir, file)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return dir
}

/** Create a bare repository usable as an offline remote. */
async function makeBare(name) {
  const dir = join(scratch, `${name}.git`)
  await mkdir(dir, { recursive: true })
  await rawGit(['init', '--bare', '--initial-branch=main'], dir)
  return dir
}

/** A repo with one committed file, ready to push. */
async function makeSeededRepo(name, files = { 'README.md': '# demo\n' }) {
  const dir = await makeProject(name, files)
  await git.initRepo(dir, 'main')
  await git.configureIdentity(dir, 'Test User', 'test@example.com')
  await git.stageAll(dir)
  await git.commit(dir, 'Initial commit', true)
  return dir
}

/** Push a local commit into a bare remote through the module under test. */
async function seedRemote(bare, name, files) {
  const repo = await makeSeededRepo(name, files)
  await git.setRemote(repo, 'origin', bare)
  await git.pushBranch(repo, bare, 'main')
  return repo
}

/** Clone a bare remote with raw git, for the "other side" of a divergence. */
async function cloneRemote(bare, name) {
  const dir = join(scratch, name)
  await rawGit(['clone', bare, dir], scratch)
  await rawGit(['config', 'user.name', 'Other User'], dir)
  await rawGit(['config', 'user.email', 'other@example.com'], dir)
  return dir
}

/** The commit SHA that a ref points at, computed with raw git. */
async function revParse(cwd, ref) {
  const { stdout } = await rawGit(['rev-parse', ref], cwd)
  return stdout.trim()
}

/** Commit and push one file in a clone, moving the remote ahead. */
async function advanceRemote(bare, clone, file, content, message) {
  await writeFile(join(clone, file), content, 'utf8')
  await rawGit(['add', '--all'], clone)
  await rawGit(['commit', '--message', message], clone)
  await rawGit(['push', bare, 'HEAD:refs/heads/main'], clone)
}

// ---------------------------------------------------------- PATH interception

let savedPath = process.env.PATH
let savedTrace = process.env.GIT_TRACE_LOG
let activeWrapper = undefined

/** Locate the real git binary on the original PATH. */
async function findRealGit() {
  for (const entry of (savedPath ?? '').split(delimiter)) {
    if (entry.length === 0) continue
    const candidate = join(entry, 'git')
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // keep looking
    }
  }
  throw new Error('git was not found on PATH; these tests need a real git install')
}

/**
 * Put a logging wrapper ahead of `git` on PATH.
 * @returns {Promise<{ log: string }>} the log path and a restore hook via {@link restorePath}.
 */
async function interceptGit() {
  const binDir = join(scratch, 'bin')
  await mkdir(binDir, { recursive: true })
  const realGit = await findRealGit()
  const log = join(binDir, 'calls.log')
  const script = join(binDir, 'git')
  await writeFile(
    script,
    [
      '#!/bin/sh',
      'printf \'ARGV %s\\n\' "$*" >> "$GIT_TRACE_LOG"',
      'printf \'ENV %s|%s|%s\\n\' "$GIT_TERMINAL_PROMPT" "$GCM_INTERACTIVE" "$GIT_ASKPASS" >> "$GIT_TRACE_LOG"',
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'),
    'utf8',
  )
  await chmod(script, 0o755)
  savedPath = process.env.PATH
  process.env.GIT_TRACE_LOG = log
  process.env.PATH = `${binDir}${delimiter}${savedPath}`
  activeWrapper = { log }
  return activeWrapper
}

async function restorePath() {
  if (activeWrapper === undefined) return
  process.env.PATH = savedPath
  if (savedTrace === undefined) delete process.env.GIT_TRACE_LOG
  else process.env.GIT_TRACE_LOG = savedTrace
  activeWrapper = undefined
}

/** Read the wrapper log as lines ('' before any call). */
async function traceLines() {
  if (activeWrapper === undefined) return []
  try {
    return (await readFile(activeWrapper.log, 'utf8')).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// ------------------------------------------------------------------ primitives

test('gitVersion reports an installed git', async () => {
  const version = await git.gitVersion()
  assert.match(version, /^git version \d+\./)
})

test('buildRemoteUrl builds a clean HTTPS URL that never carries a token', () => {
  const url = git.buildRemoteUrl('octocat', 'project')
  assert.equal(url, 'https://github.com/octocat/project.git')
  assert.ok(!url.includes('@'))
  assert.ok(!url.includes('ghp_'))
})

test('isGitRepo distinguishes a plain directory from a repository', async () => {
  const dir = await makeProject('plain')
  assert.equal(await git.isGitRepo(dir), false)
  await git.initRepo(dir, 'main')
  assert.equal(await git.isGitRepo(dir), true)
})

test('a fresh init lands on the requested branch with no commits', async () => {
  const dir = await makeProject('fresh-init')
  await git.initRepo(dir, 'trunk')
  assert.equal(await git.currentBranch(dir), 'trunk')
  assert.equal(await git.headCommit(dir), '')
  assert.equal(await git.isGitRepo(dir), true)
})

test('statusEntries lists changes and stageAll stages them', async () => {
  const dir = await makeProject('status', { 'a.txt': 'a\n', 'nested/b.txt': 'b\n' })
  await git.initRepo(dir, 'main')
  const entries = await git.statusEntries(dir)
  assert.ok(entries.some(line => line.endsWith('a.txt')))
  assert.ok(entries.some(line => line.endsWith('nested/b.txt')))
  await git.stageAll(dir)
  const staged = await git.statusEntries(dir)
  assert.equal(staged.length, 2)
  assert.ok(staged.every(line => !line.startsWith('??')), 'every entry must be staged')
})

test('a first commit produces a SHA and identity is configurable', async () => {
  const dir = await makeProject('commit')
  await git.initRepo(dir, 'main')
  await git.configureIdentity(dir, 'Alice', 'alice@example.com')
  assert.equal((await rawGit(['config', '--local', 'user.name'], dir)).stdout.trim(), 'Alice')
  await git.stageAll(dir)
  const first = await git.commit(dir, 'Initial commit', true)
  assert.match(first, /^[0-9a-f]{40}$/)
  assert.equal(await git.headCommit(dir), first)

  // A no-op commit is refused unless explicitly allowed.
  await assert.rejects(
    () => git.commit(dir, 'nothing changed', false),
    error => ['GIT_FAILED', 'FAILED'].includes(error.code),
  )
  const empty = await git.commit(dir, 'allowed empty', true)
  assert.match(empty, /^[0-9a-f]{40}$/)
  assert.notEqual(empty, first)
})

test('setRemote creates, then updates origin with the clean URL', async () => {
  const dir = await makeSeededRepo('remote')
  const url = 'https://github.com/octocat/remote.git'
  await git.setRemote(dir, 'origin', url)
  assert.equal(await git.getRemote(dir, 'origin'), url)
  await git.setRemote(dir, 'origin', 'https://github.com/octocat/other.git')
  assert.equal(await git.getRemote(dir, 'origin'), 'https://github.com/octocat/other.git')
  assert.equal(await git.getRemote(dir, 'nope'), '')

  const config = await readFile(join(dir, '.git', 'config'), 'utf8')
  assert.ok(!config.includes('ghp_'), 'the token must never reach .git/config')
})

// ----------------------------------------------------------------------- push

test('pushBranch publishes HEAD and remoteBranchExists sees it', async () => {
  const bare = await makeBare('push')
  const dir = await makeSeededRepo('push-work')
  assert.equal(await git.remoteBranchExists(dir, bare, 'main'), false)
  await git.pushBranch(dir, bare, 'main')
  assert.equal(await git.remoteBranchExists(dir, bare, 'main'), true)
  assert.equal(await revParse(bare, 'refs/heads/main'), await git.headCommit(dir))
})

test('setUpstream records the branch tracking configuration', async () => {
  const dir = await makeSeededRepo('upstream')
  await git.setUpstream(dir, 'main', 'origin')
  const config = await readFile(join(dir, '.git', 'config'), 'utf8')
  assert.match(config, /\[branch "main"\]/)
  assert.match(config, /remote = origin/)
  assert.match(config, /merge = refs\/heads\/main/)
})

test('a diverged remote is fetched, rebased, and fast-forwarded', async () => {
  const bare = await makeBare('diverged')
  const work = await seedRemote(bare, 'diverged-work', { 'a.txt': 'base\n' })
  const other = await cloneRemote(bare, 'diverged-other')
  await advanceRemote(bare, other, 'OTHER.md', 'other\n', 'remote-side commit')

  await writeFile(join(work, 'LOCAL.md'), 'local\n', 'utf8')
  await git.stageAll(work)
  await git.commit(work, 'local-side commit', true)

  await git.fetchBranch(work, bare, 'main')
  await git.rebaseOntoFetchHead(work)
  await git.pushBranch(work, bare, 'main')

  assert.equal(await revParse(bare, 'refs/heads/main'), await git.headCommit(work))
})

test('a plain push of diverged histories maps to PUSH_REJECTED', async () => {
  const bare = await makeBare('rejected')
  const work = await seedRemote(bare, 'rejected-work', { 'a.txt': 'base\n' })
  const other = await cloneRemote(bare, 'rejected-other')
  await advanceRemote(bare, other, 'OTHER.md', 'other\n', 'remote-side commit')

  await writeFile(join(work, 'LOCAL.md'), 'local\n', 'utf8')
  await git.stageAll(work)
  await git.commit(work, 'local-side commit', true)

  await assert.rejects(
    () => git.pushBranch(work, bare, 'main'),
    error => error.code === 'PUSH_REJECTED',
  )
})

test('force push replaces a diverged remote branch using force-with-lease', async () => {
  const bare = await makeBare('forced')
  const work = await seedRemote(bare, 'forced-work', { 'a.txt': 'base\n' })
  const other = await cloneRemote(bare, 'forced-other')
  await advanceRemote(bare, other, 'OTHER.md', 'other\n', 'remote-side commit')

  await writeFile(join(work, 'LOCAL.md'), 'local\n', 'utf8')
  await git.stageAll(work)
  await git.commit(work, 'local-side commit', true)

  await interceptGit()
  try {
    await git.pushBranch(work, bare, 'main', { force: true })
    const lines = await traceLines()
    const pushLine = lines.find(line => line.startsWith('ARGV push'))
    assert.ok(pushLine !== undefined, 'the push command must be traced')
    assert.match(pushLine, /--force-with-lease/, 'a forced push must use --force-with-lease')
    assert.ok(!pushLine.includes(TOKEN), 'the token must never appear in argv')
  } finally {
    await restorePath()
  }
  assert.equal(await revParse(bare, 'refs/heads/main'), await git.headCommit(work))
})

test('a rebase conflict is reported as REBASE_CONFLICT and rolled back', async () => {
  const bare = await makeBare('conflict')
  const work = await seedRemote(bare, 'conflict-work', { 'a.txt': 'base\n' })
  const other = await cloneRemote(bare, 'conflict-other')
  await advanceRemote(bare, other, 'a.txt', 'remote change\n', 'remote edit')

  await writeFile(join(work, 'a.txt'), 'local change\n', 'utf8')
  await git.stageAll(work)
  const localHead = await git.commit(work, 'local edit', true)

  await git.fetchBranch(work, bare, 'main')
  await assert.rejects(
    () => git.rebaseOntoFetchHead(work),
    error => error.code === 'REBASE_CONFLICT',
  )

  // The interrupted rebase must be aborted: no state left behind, HEAD restored.
  const entries = await readdir(join(work, '.git'))
  assert.ok(!entries.includes('rebase-merge'), 'no rebase state may be left behind')
  assert.ok(!entries.includes('rebase-apply'), 'no rebase state may be left behind')
  assert.equal(await git.headCommit(work), localHead)
  assert.deepEqual(await git.statusEntries(work), [])
})

// ------------------------------------------------------ token handling / askpass

test('the askpass helper never writes the token to argv, .git/config, or disk', async () => {
  const bare = await makeBare('askpass')
  const work = await makeSeededRepo('askpass-work')

  const helper = await git.createAskpassHelper({ token: TOKEN, login: 'x-access-token' })
  assert.equal(typeof helper.dispose, 'function')
  assert.equal(typeof helper.env, 'object')

  const saved = new Map()
  for (const [key, value] of Object.entries(helper.env)) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }

  await interceptGit()
  try {
    await git.pushBranch(work, bare, 'main')
    const lines = await traceLines()
    const allArgv = lines.filter(line => line.startsWith('ARGV')).join('\n')
    assert.ok(allArgv.length > 0, 'git calls must be traced')
    assert.ok(!allArgv.includes(TOKEN), 'the token must never appear in argv')
    const envLines = lines.filter(line => line.startsWith('ENV'))
    assert.ok(
      envLines.some(line => line.includes('|0|') || line.split('|')[0].includes('0')),
      'every git call must set GIT_TERMINAL_PROMPT=0',
    )
  } finally {
    await restorePath()
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const config = await readFile(join(work, '.git', 'config'), 'utf8')
  assert.ok(!config.includes(TOKEN), 'the token must never reach .git/config')

  // Whatever the helper puts on disk (an askpass script, at most) must not hold
  // the secret itself; the value only travels through the child environment.
  const askpassPath = helper.env.GIT_ASKPASS
  if (typeof askpassPath === 'string' && askpassPath.length > 0) {
    const seen = new Set()
    const stack = [askpassPath]
    while (stack.length > 0) {
      const current = stack.pop()
      if (seen.has(current)) continue
      seen.add(current)
      const text = await readFile(current, 'utf8').catch(() => '')
      assert.ok(!text.includes(TOKEN), `the askpass helper on disk must not contain the token: ${current}`)
    }
  }

  await helper.dispose()
  if (typeof askpassPath === 'string' && askpassPath.length > 0) {
    await assert.rejects(() => access(askpassPath), 'dispose() must remove the helper')
  }
})

test('every git call is non-interactive by default', async () => {
  const dir = await makeSeededRepo('noninteractive')
  await interceptGit()
  try {
    await git.statusEntries(dir)
    const envLines = (await traceLines()).filter(line => line.startsWith('ENV'))
    assert.ok(envLines.length > 0)
    for (const line of envLines) {
      const [prompt, gcm] = line.slice('ENV '.length).split('|')
      assert.equal(prompt, '0', 'GIT_TERMINAL_PROMPT must be 0')
      assert.equal(gcm, 'never', 'GCM_INTERACTIVE must be never')
    }
  } finally {
    await restorePath()
  }
})

test('a missing git executable maps to GIT_MISSING', async () => {
  const emptyBin = join(scratch, 'empty-bin')
  await mkdir(emptyBin, { recursive: true })
  const dir = await makeProject('no-git')
  savedPath = process.env.PATH
  process.env.PATH = emptyBin
  try {
    assert.equal(await git.gitVersion(), '')
    assert.equal(await git.isGitRepo(dir), false)
    await assert.rejects(
      () => git.initRepo(dir, 'main'),
      error => error.code === 'GIT_MISSING',
    )
  } finally {
    process.env.PATH = savedPath
  }
})
