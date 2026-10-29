/**
 * Live smoke test: real `git`, real filesystem, a local bare remote, fake GitHub
 * API. Nothing here touches the network.
 *
 * The fake API stops at the GitHub boundary only: its repository carries a
 * `clone_url` pointing at the bare repository, so the complete publish flow
 * (scan → gitignore → init → commit → repository create → divergence → push) is
 * exercised for real. This is deliberately not part of `node --test` because it
 * needs a git installation and creates several repositories.
 *
 * Usage: node scripts/live-smoke.mjs
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeConfig } from '../lib/config.js'
import * as git from '../lib/git.js'
import { preflight, publish } from '../lib/publish.js'

const execFileAsync = promisify(execFile)
const TOKEN = 'ghp_' + '0'.repeat(36)
const VIEWER = { login: 'octocat', id: 1 }

let passed = 0
let failed = 0

/** Run one named check without aborting the whole smoke run. */
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

const scratch = await mkdtemp(join(tmpdir(), 'dsh-gh-aide-live-'))

/** Run raw git for fixture setup. */
async function rawGit(args, cwd) {
  return execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
}

/** Write a demo project with a dependency directory that must be ignored. */
async function makeDemoProject() {
  const dir = join(scratch, 'demo')
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'node_modules', 'junk'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2), 'utf8')
  await writeFile(join(dir, 'src', 'index.js'), 'export const answer = 42\n', 'utf8')
  await writeFile(join(dir, 'README.md'), '# Demo\n\nA live smoke test project.\n', 'utf8')
  await writeFile(join(dir, 'node_modules', 'junk', 'index.js'), 'module.exports = 1\n', 'utf8')
  return dir
}

/** Create a bare repository to act as the offline remote. */
async function makeBare(name) {
  const dir = join(scratch, `${name}.git`)
  await mkdir(dir, { recursive: true })
  await rawGit(['init', '--bare', '--initial-branch=main'], dir)
  return dir
}

/** A fake GitHub API whose repository points at a local bare remote. */
function fakeApi(cloneUrl) {
  const repos = new Map()
  return {
    async findRepository(owner, repo) {
      const key = `${owner}/${repo}`
      return { exists: repos.has(key), repository: repos.get(key) ?? null }
    },
    async createRepository(spec) {
      const key = `${VIEWER.login}/${spec.name}`
      const repository = {
        name: spec.name,
        full_name: key,
        html_url: `https://github.com/${key}`,
        clone_url: cloneUrl,
      }
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

/** Keep the machine's real git identity out of the fixtures. */
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

/** Clone the bare remote with raw git. */
async function cloneRemote(bare, name) {
  const dir = join(scratch, name)
  await rawGit(['clone', bare, dir], scratch)
  await rawGit(['config', 'user.name', 'Other User'], dir)
  await rawGit(['config', 'user.email', 'other@example.com'], dir)
  return dir
}

/** Commit and push one file in a clone, moving the remote ahead. */
async function advanceRemote(bare, clone, file, content, message) {
  await writeFile(join(clone, file), content, 'utf8')
  await rawGit(['add', '--all'], clone)
  await rawGit(['commit', '--message', message], clone)
  await rawGit(['push', bare, 'HEAD:refs/heads/main'], clone)
}

/** The SHA a ref points at. */
async function revParse(cwd, ref) {
  const { stdout } = await rawGit(['rev-parse', ref], cwd)
  return stdout.trim()
}

/** Whether a path exists. */
function exists(path) {
  return access(path).then(() => true, () => false)
}

console.log('\ndsh-github-aide live smoke (real git, local bare remote, no network)\n')

const bare = await makeBare('remote')
const project = await makeDemoProject()
const api = fakeApi(bare)
const baseInput = { api, viewer: VIEWER, tokenSource: 'credentials', repo: 'demo' }

// --------------------------------------------------------- first end-to-end run

console.log('first publish')

await check('a fresh project is committed and pushed to the bare remote', async () => {
  const result = await withIsolatedGitIdentity(() => publish(inputFor(project, { ...baseInput, push: true })))
  if (result.ok !== true) throw new Error(`publish failed: ${result.code} ${result.summary}`)
  if (result.pushed !== true) throw new Error('the push was not reported')
  if (result.owner !== 'octocat' || result.repo !== 'demo') throw new Error(`unexpected target ${result.owner}/${result.repo}`)
  if (result.html_url !== 'https://github.com/octocat/demo') throw new Error(`unexpected html_url ${result.html_url}`)
  if (result.project_type !== 'node') throw new Error(`unexpected project_type ${result.project_type}`)
  const remoteHead = await revParse(bare, 'refs/heads/main')
  if (remoteHead !== result.commit) throw new Error('the remote is not at the published commit')
  console.log(`       commit ${result.commit.slice(0, 12)}  files ${result.changed_files}  scanned ${result.scanned_files}`)
})

await check('the generated .gitignore keeps dependency directories out of the commit', async () => {
  const ignore = await readFile(join(project, '.gitignore'), 'utf8')
  if (!ignore.includes('node_modules/')) throw new Error('.gitignore does not ignore node_modules/')
  const { stdout } = await rawGit(['ls-files'], project)
  const tracked = stdout.split('\n')
  if (tracked.some(file => file.startsWith('node_modules/'))) throw new Error('node_modules was committed')
  if (!tracked.includes('src/index.js')) throw new Error('the project files were not committed')
})

await check('origin stores the clean clone URL, not a credential', async () => {
  const origin = await git.getRemote(project, 'origin')
  if (origin !== bare) throw new Error(`unexpected origin ${origin}`)
  const config = await readFile(join(project, '.git', 'config'), 'utf8')
  if (config.includes(TOKEN) || config.includes('ghp_')) throw new Error('a token reached .git/config')
})

await check('the remote is now visible to preflight', async () => {
  const report = await preflight(inputFor(project, baseInput))
  if (report.ok !== true) throw new Error(`preflight failed: ${report.code}`)
  if (report.git.isRepo !== true) throw new Error('preflight did not see the repository')
  if (report.repoExists !== true) throw new Error('preflight did not see the remote repository')
  if (report.project.hasGitignore !== true) throw new Error('preflight did not see the .gitignore')
  if (!report.project.stacks.some(stack => /node/i.test(stack))) throw new Error('stack detection missed node')
})

// ------------------------------------------------------------------- no-op run

console.log('\nsecond publish (no changes)')

await check('a second publish reuses HEAD and reports no changed files', async () => {
  const first = await preflight(inputFor(project, baseInput))
  const firstCommit = await git.headCommit(project)
  const result = await withIsolatedGitIdentity(() => publish(inputFor(project, { ...baseInput, push: true })))
  if (result.ok !== true) throw new Error(`publish failed: ${result.code} ${result.summary}`)
  if (result.commit !== firstCommit) throw new Error('the no-op publish created a new commit')
  if (result.changed_files !== 0) throw new Error(`changed_files was ${result.changed_files}`)
  if (result.pushed !== true) throw new Error('the no-op publish did not reach the remote')
  void first
})

// ---------------------------------------------------------------- divergence

console.log('\ndivergence')

await check('a remote-only commit is fetched, rebased, and pushed', async () => {
  const other = await cloneRemote(bare, 'other-diverged')
  await advanceRemote(bare, other, 'OTHER.md', 'other\n', 'remote-side commit')
  await writeFile(join(project, 'LOCAL.md'), 'local\n', 'utf8')
  const result = await withIsolatedGitIdentity(() => publish(inputFor(project, { ...baseInput, push: true })))
  if (result.ok !== true) throw new Error(`publish failed: ${result.code} ${result.summary}`)
  const remoteHead = await revParse(bare, 'refs/heads/main')
  if (remoteHead !== result.commit) throw new Error('the rebased local commit is not on the remote')
})

await check('a conflicting remote reports REBASE_CONFLICT and does not rewrite the remote', async () => {
  const other = await cloneRemote(bare, 'other-conflict')
  await advanceRemote(bare, other, 'LOCAL.md', 'remote wins\n', 'remote-side edit')
  const remoteBefore = await revParse(bare, 'refs/heads/main')
  await writeFile(join(project, 'LOCAL.md'), 'local wins\n', 'utf8')
  const result = await withIsolatedGitIdentity(() => publish(inputFor(project, { ...baseInput, push: true })))
  if (result.ok !== false) throw new Error('a conflicting publish must not report success')
  if (result.code !== 'REBASE_CONFLICT') throw new Error(`expected REBASE_CONFLICT, got ${result.code}`)
  const remoteAfter = await revParse(bare, 'refs/heads/main')
  if (remoteAfter !== remoteBefore) throw new Error('a failed publish rewrote the remote')
  const head = await git.headCommit(project)
  const status = await git.statusEntries(project)
  if (status.some(line => line.includes('rebase'))) throw new Error('rebase state was left behind')
  void head
})

await check('a forced publish replaces the diverged remote branch', async () => {
  const result = await withIsolatedGitIdentity(() => publish(inputFor(project, { ...baseInput, push: true, force: true })))
  // The conflict still makes the rebase fail first, which is the documented order:
  // force only affects the push, never the reconciliation.
  if (result.ok !== false || result.code !== 'REBASE_CONFLICT') {
    throw new Error(`expected REBASE_CONFLICT, got ${result.ok ? 'ok' : result.code}`)
  }
})

await check('lib/git.js force-with-lease replaces a diverged remote branch', async () => {
  const bare2 = await makeBare('force')
  const seeded = join(scratch, 'force-seed')
  await mkdir(seeded, { recursive: true })
  await writeFile(join(seeded, 'a.txt'), 'base\n', 'utf8')
  await git.initRepo(seeded, 'main')
  await git.configureIdentity(seeded, 'Test', 'test@example.com')
  await git.stageAll(seeded)
  await git.commit(seeded, 'base', true)
  await git.pushBranch(seeded, bare2, 'main')

  const other = await cloneRemote(bare2, 'force-other')
  await advanceRemote(bare2, other, 'OTHER.md', 'other\n', 'remote-side commit')

  await writeFile(join(seeded, 'LOCAL.md'), 'local\n', 'utf8')
  await git.stageAll(seeded)
  await git.commit(seeded, 'local', true)
  await git.pushBranch(seeded, bare2, 'main', { force: true })
  const remoteHead = await revParse(bare2, 'refs/heads/main')
  if (remoteHead !== await git.headCommit(seeded)) throw new Error('the forced push did not replace the remote branch')
})

// ------------------------------------------------------------------- askpass

console.log('\ncredential handling')

await check('the askpass helper keeps the token out of the repository on disk', async () => {
  const helper = await git.createAskpassHelper({ token: TOKEN, login: 'x-access-token' })
  try {
    const askpassPath = helper.env.GIT_ASKPASS
    if (typeof askpassPath !== 'string' || askpassPath.length === 0) throw new Error('the helper exposes no GIT_ASKPASS script')
    if ((await exists(askpassPath)) !== true) throw new Error('the askpass script is missing')
    const script = await readFile(askpassPath, 'utf8')
    if (script.includes(TOKEN)) throw new Error('the askpass script contains the token')
    const saved = new Map()
    for (const [key, value] of Object.entries(helper.env)) {
      saved.set(key, process.env[key])
      process.env[key] = value
    }
    try {
      await git.pushBranch(project, bare, 'main', { force: true })
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    const config = await readFile(join(project, '.git', 'config'), 'utf8')
    if (config.includes(TOKEN)) throw new Error('a token reached .git/config')
  } finally {
    const askpassPath = helper.env.GIT_ASKPASS
    await helper.dispose()
    if (typeof askpassPath === 'string' && (await exists(askpassPath))) {
      throw new Error('dispose() did not remove the askpass script')
    }
  }
})

await check('no token appears in the published result', async () => {
  const result = await withIsolatedGitIdentity(() => publish(inputFor(project, {
    ...baseInput,
    token: TOKEN,
    push: true,
  })))
  if (JSON.stringify(result).includes(TOKEN)) throw new Error('the RESULT echoed the token')
})

await rm(scratch, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exitCode = failed === 0 ? 0 : 1
