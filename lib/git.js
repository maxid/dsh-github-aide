/**
 * Git operations for one project directory.
 *
 * Three rules shape this module:
 *
 * 1. **The token never lands on disk.** `origin` is always the clean
 *    `https://github.com/<owner>/<repo>.git` URL; the credential travels only
 *    through an in-memory askpass helper's environment, so it cannot enter
 *    `.git/config`, a command line, or the process table.
 * 2. **Git never prompts.** `GIT_TERMINAL_PROMPT=0` plus a disabled
 *    `GIT_ASKPASS` unless the helper is active, so a credential failure
 *    surfaces as an error instead of hanging on a console that does not exist.
 * 3. **Force means force-with-lease.** A URL-based push has no remote-tracking
 *    ref for git to lease against, so the expected remote SHA is read with
 *    `ls-remote` first and handed to git explicitly.
 *
 * This is a port of the sync plugin's `lib/git.js` + `lib/exec.js`, merged into
 * one module, plus the upload plugin's askpass credential injection.
 */

import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ERROR_CODES, GitHubAideError, redact } from './errors.js'

/** Upper bound on one command's collected stdout+stderr, in bytes. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
/** Deadline for local git work (init, status, commit). */
const LOCAL_TIMEOUT_MS = 60_000
/** Network-bound git operations (fetch, push, ls-remote) get a longer deadline. */
const NETWORK_TIMEOUT_MS = 180_000

/**
 * The askpass helper currently mounted on every git invocation.
 *
 * A module-level slot keeps the documented git signatures free of credential
 * plumbing: callers mount a helper with {@link createAskpassHelper}, run the
 * commands that need it, and dispose it. `null` means "no credential, and no
 * inherited askpass from the parent environment either".
 * @type {{ env: Record<string, string> } | null}
 */
let activeAskpass = null

/**
 * Build the environment for one git child.
 *
 * The inherited environment is stripped of any askpass configuration
 * unless a helper is mounted: a developer's own `GIT_ASKPASS` could otherwise
 * pop a GUI prompt on a headless harness.
 * @param {Record<string, string>} [extra] caller overrides, applied last.
 * @returns {NodeJS.ProcessEnv} environment for the child.
 */
function gitEnvironment(extra) {
  const helperEnv = activeAskpass === null ? {} : activeAskpass.env
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    ...helperEnv,
    ...(extra ?? {}),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_NOSYSTEM: '0',
  }
  if (helperEnv.GIT_ASKPASS === undefined) {
    env.GIT_ASKPASS = ''
    env.SSH_ASKPASS = ''
  }
  return env
}

/**
 * Run one executable and collect its output.
 * @param {string} file executable name or path.
 * @param {string[]} args argument vector; never a shell string.
 * @param {object} [options] execution options.
 * @param {string} [options.cwd] working directory.
 * @param {number} [options.timeoutMs] deadline for the whole call.
 * @param {AbortSignal} [options.signal] cancels the call.
 * @param {Record<string, string>} [options.env] extra environment entries.
 * @returns {Promise<{
 *   ok: boolean, code: number|string, stdout: string, stderr: string,
 *   timedOut: boolean, missing: boolean, missingCwd: boolean, aborted: boolean,
 * }>} collected result.
 */
function run(file, args, options = {}) {
  const { cwd, timeoutMs = LOCAL_TIMEOUT_MS, signal, env } = options
  /* A child cannot start in a directory that does not exist, and the OS reports
     that with the same ENOENT it uses for a missing executable. Resolving it
     here keeps "git is not installed" and "the project directory is gone" from
     being reported as each other. */
  if (typeof cwd === 'string' && !existsSync(cwd)) {
    return Promise.resolve({
      ok: false, code: 'ENOENT', stdout: '', stderr: '', timedOut: false, missing: false, missingCwd: true, aborted: false,
    })
  }
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        ...(signal ? { signal } : {}),
        env: gitEnvironment(env),
      },
      (error, stdout, stderr) => {
        const out = stdout === undefined ? '' : String(stdout)
        const err = stderr === undefined ? '' : String(stderr)
        const missing = error?.code === 'ENOENT'
        resolve({
          ok: !error,
          code: missing ? 'ENOENT' : (error?.code ?? 0),
          stdout: out,
          stderr: err,
          timedOut: error?.killed === true || error?.signal === 'SIGTERM',
          missing,
          missingCwd: false,
          aborted: error?.name === 'AbortError' || signal?.aborted === true,
        })
      },
    )
  })
}

/**
 * Run a git subcommand and fail loudly on a non-zero exit.
 * @param {string[]} args git arguments (without the leading `git`).
 * @param {object} options execution options.
 * @param {string} options.cwd repository working directory.
 * @param {number} [options.timeoutMs] deadline.
 * @param {AbortSignal} [options.signal] cancels the call.
 * @param {string} [options.code] error code for a non-zero exit.
 * @param {string} [options.nextStep] guidance attached to that error.
 * @param {Record<string, string>} [options.env] extra environment entries.
 * @returns {Promise<{ stdout: string, stderr: string }>} captured output.
 * @throws {GitHubAideError} when git is missing, times out, or exits non-zero.
 */
async function git(args, options) {
  const { cwd, timeoutMs = LOCAL_TIMEOUT_MS, signal, code = ERROR_CODES.GIT_FAILED, nextStep, env } = options
  const result = await run('git', args, { cwd, timeoutMs, signal, env })

  if (result.aborted) signal?.throwIfAborted()
  if (result.missingCwd) {
    throw new GitHubAideError(
      ERROR_CODES.NOT_A_DIRECTORY,
      `The working directory no longer exists: ${cwd}`,
      { nextStep: 'Reopen the project folder, then retry.' },
    )
  }
  if (result.missing) {
    throw new GitHubAideError(
      ERROR_CODES.GIT_MISSING,
      'The git executable was not found on PATH.',
      { nextStep: 'Install Git and restart DSH so the new PATH is picked up.' },
    )
  }
  if (result.timedOut) {
    throw new GitHubAideError(
      code,
      `git ${args[0]} did not finish within ${Math.round(timeoutMs / 1000)}s.`,
      { nextStep: nextStep ?? 'Retry, or run the command manually in the project to see what it is waiting for.' },
    )
  }
  if (!result.ok) {
    const detail = redact(result.stderr || result.stdout).trim().split('\n').slice(-6).join('\n')
    throw new GitHubAideError(code, `git ${args[0]} failed: ${detail || `exit ${result.code}`}`, { nextStep })
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run a git subcommand, reporting failure as a value instead of throwing.
 * @param {string[]} args git arguments.
 * @param {Parameters<typeof git>[1]} options execution options; see {@link git}.
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string }>} result.
 */
async function gitTry(args, options) {
  try {
    const { stdout, stderr } = await git(args, options)
    return { ok: true, stdout, stderr }
  } catch (error) {
    const described = error instanceof GitHubAideError ? error : undefined
    return { ok: false, stdout: '', stderr: described?.message ?? String(error) }
  }
}

/**
 * The clean, token-free clone URL for a repository.
 * @param {string} owner repository owner login.
 * @param {string} repo repository name.
 * @returns {string} HTTPS clone URL.
 */
export function buildRemoteUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`
}

/**
 * Whether git is available and which version is installed.
 * @returns {Promise<string>} the reported version line, or `''` when missing.
 */
export async function gitVersion() {
  const result = await run('git', ['--version'], { timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * Whether a directory is already inside a git work tree.
 * @param {string} cwd candidate directory.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<boolean>} true when git resolves a work tree.
 */
export async function isGitRepo(cwd, signal) {
  const result = await gitTry(['rev-parse', '--is-inside-work-tree'], { cwd, signal, timeoutMs: 10_000 })
  return result.ok && result.stdout.trim() === 'true'
}

/**
 * Create a repository in the project directory.
 * @param {string} cwd project root.
 * @param {string} branch initial branch name.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<void>} resolves once the repository exists.
 */
export async function initRepo(cwd, branch, signal) {
  const withBranch = await gitTry(['init', '--initial-branch', branch], { cwd, signal })
  if (withBranch.ok) return
  /* `--initial-branch` needs git 2.28+. Older git gets a plain init plus an
     explicit HEAD rewrite, which produces the same branch name. */
  await git(['init'], { cwd, signal })
  await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd, signal })
}

/**
 * Write the repository-local commit identity.
 * @param {string} cwd project root.
 * @param {string} name commit author name.
 * @param {string} email commit author email.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<void>} resolves once both keys are written.
 */
export async function configureIdentity(cwd, name, email, signal) {
  await git(['config', '--local', 'user.name', name], { cwd, signal })
  await git(['config', '--local', 'user.email', email], { cwd, signal })
}

/**
 * Read one resolved git config value.
 *
 * Not part of the sync plugin's export list, but the publish flow needs it to
 * honour an identity the user already configured before falling back to the
 * GitHub viewer.
 * @param {string} cwd project root.
 * @param {string} key config key, e.g. `user.name`.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<string>} the value, or `''` when unset.
 */
export async function configGet(cwd, key, signal) {
  const result = await gitTry(['config', '--get', key], { cwd, signal, timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * The current HEAD commit, or `''` before the first commit exists.
 * @param {string} cwd project root.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<string>} full commit SHA, or `''`.
 */
export async function headCommit(cwd, signal) {
  const result = await gitTry(['rev-parse', 'HEAD'], { cwd, signal, timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * The current branch name, or `''` on an unborn or detached HEAD.
 * @param {string} cwd project root.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<string>} branch name.
 */
export async function currentBranch(cwd, signal) {
  const result = await gitTry(['branch', '--show-current'], { cwd, signal, timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * List working-tree changes in porcelain form.
 * @param {string} cwd project root.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<string[]>} one entry per changed path.
 */
export async function statusEntries(cwd, signal) {
  const result = await gitTry(['status', '--porcelain', '--untracked-files=all'], { cwd, signal })
  if (!result.ok) return []
  return result.stdout.split('\n').map((line) => line.trimEnd()).filter((line) => line.length > 0)
}

/**
 * Stage every change in the work tree.
 * @param {string} cwd project root.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<void>} resolves once staging completes.
 */
export async function stageAll(cwd, signal) {
  await git(['add', '--all'], { cwd, signal })
}

/**
 * Commit the staged tree.
 *
 * An empty repository still needs one commit before it can be pushed, so the
 * first commit is allowed to be empty; later no-op commits are skipped by the
 * caller instead.
 * @param {string} cwd project root.
 * @param {string} message commit message.
 * @param {boolean} allowEmpty whether to create a commit with no changes.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<string>} the new commit SHA.
 */
export async function commit(cwd, message, allowEmpty, signal) {
  const args = ['commit', '--message', message]
  if (allowEmpty) args.push('--allow-empty')
  await git(args, { cwd, signal })
  return await headCommit(cwd, signal)
}

/**
 * Point a named remote at a URL, creating it when absent.
 * @param {string} cwd project root.
 * @param {string} remote remote name.
 * @param {string} url token-free remote URL.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<void>} resolves once the remote is set.
 */
export async function setRemote(cwd, remote, url, signal) {
  const existing = await gitTry(['remote', 'get-url', remote], { cwd, signal, timeoutMs: 10_000 })
  if (existing.ok) {
    await git(['remote', 'set-url', remote, url], { cwd, signal })
    return
  }
  await git(['remote', 'add', remote, url], { cwd, signal })
}

/**
 * Read a named remote's URL.
 * @param {string} cwd project root.
 * @param {string} remote remote name.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<string>} remote URL, or `''` when unset.
 */
export async function getRemote(cwd, remote, signal) {
  const result = await gitTry(['remote', 'get-url', remote], { cwd, signal, timeoutMs: 10_000 })
  return result.ok ? result.stdout.trim() : ''
}

/**
 * The SHA a remote branch currently points at.
 * @param {string} cwd project root.
 * @param {string} url remote URL.
 * @param {string} branch branch name.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<string>} remote SHA, or `''` when the branch does not exist.
 * @throws {GitHubAideError} `PUSH_REJECTED` when the remote cannot be read.
 */
async function remoteHeadSha(cwd, url, branch, signal) {
  const result = await gitTry(['ls-remote', '--heads', url, `refs/heads/${branch}`], {
    cwd, signal, timeoutMs: NETWORK_TIMEOUT_MS,
  })
  if (!result.ok) {
    const detail = redact(result.stderr).trim().split('\n').slice(-4).join('\n')
    throw new GitHubAideError(
      ERROR_CODES.PUSH_REJECTED,
      `git could not read the remote branch ${branch}: ${detail || 'ls-remote failed'}`,
      { nextStep: 'Check the network connection and that the token can read this repository, then retry.' },
    )
  }
  const line = result.stdout.trim().split('\n').find((entry) => entry.length > 0)
  return line === undefined ? '' : line.split(/\s+/)[0]
}

/**
 * Whether a branch already exists on the remote.
 * @param {string} cwd project root.
 * @param {string} url remote URL.
 * @param {string} branch branch name.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<boolean>} true when the remote already has commits there.
 */
export async function remoteBranchExists(cwd, url, branch, signal) {
  const result = await gitTry(['ls-remote', '--heads', url, `refs/heads/${branch}`], {
    cwd, signal, timeoutMs: NETWORK_TIMEOUT_MS,
  })
  return result.ok && result.stdout.trim().length > 0
}

/**
 * Fetch one remote branch into `FETCH_HEAD`.
 * @param {string} cwd project root.
 * @param {string} url remote URL.
 * @param {string} branch branch name.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<void>} resolves once the fetch completes.
 */
export async function fetchBranch(cwd, url, branch, signal) {
  await git(['fetch', '--no-tags', url, branch], {
    cwd,
    signal,
    timeoutMs: NETWORK_TIMEOUT_MS,
    nextStep: 'Check the network connection and the token permissions, then retry.',
  })
}

/**
 * Rebase the current branch onto the just-fetched `FETCH_HEAD`.
 *
 * A conflict is reported as its own error code, and the interrupted rebase is
 * always rolled back so the work tree is left exactly as it was found.
 * @param {string} cwd project root.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<void>} resolves once the branch sits on top of the remote.
 * @throws {GitHubAideError} with code `REBASE_CONFLICT` when the histories clash.
 */
export async function rebaseOntoFetchHead(cwd, signal) {
  const result = await gitTry(['rebase', '--autostash', 'FETCH_HEAD'], {
    cwd, signal, timeoutMs: NETWORK_TIMEOUT_MS,
  })
  if (result.ok) return
  await gitTry(['rebase', '--abort'], { cwd, signal, timeoutMs: 30_000 })
  throw new GitHubAideError(
    ERROR_CODES.REBASE_CONFLICT,
    'The remote branch and this project have conflicting histories, so the local commits could not be placed on top of the remote.',
    {
      nextStep: 'Resolve the conflict by hand in the project, or retry with force enabled to replace the remote history.',
    },
  )
}

/**
 * Map a failed push onto the one code the tools report for push trouble.
 * @param {{ code: number|string, stdout: string, stderr: string, timedOut: boolean }} result failed run.
 * @returns {GitHubAideError} the mapped error.
 */
function pushFailure(result) {
  const detail = redact(result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n')
  const text = detail.toLowerCase()
  const auth = /authentication failed|could not read username|permission denied|access denied|http 401|http 403|terminal prompts disabled|invalid username or password/.test(text)
  const nonFastForward = /non-fast-forward|fetch first|stale info|failed to push some refs|\[rejected\]/.test(text)
  let nextStep
  if (auth) {
    nextStep = 'The token was rejected or lacks write access to this repository. Store a token with the "repo" scope and retry.'
  } else if (nonFastForward) {
    nextStep = 'The remote branch has commits this project does not. Retry with force enabled to replace them, or pull and rebase first.'
  } else if (result.timedOut) {
    nextStep = 'The push timed out. Check the network connection and retry.'
  } else {
    nextStep = 'Retry the push; if it keeps failing, run it manually in the project to see git\'s full output.'
  }
  return new GitHubAideError(
    ERROR_CODES.PUSH_REJECTED,
    `git push failed: ${detail || `exit ${result.code}`}`,
    { nextStep },
  )
}

/**
 * Push the current commit to a branch on the remote.
 *
 * `force` is always `--force-with-lease` with an explicit expected remote SHA.
 * A URL push has no remote-tracking ref for git to lease against, so a bare
 * `--force` would be the only alternative — and that discards remote commits
 * without checking that nobody else pushed since the read.
 * @param {string} cwd project root.
 * @param {string} url token-free remote URL.
 * @param {string} branch destination branch name.
 * @param {object} [options] push options.
 * @param {boolean} [options.force] replace the remote branch if it moved.
 * @param {AbortSignal} [options.signal] cancels the call.
 * @returns {Promise<void>} resolves once the push is accepted.
 * @throws {GitHubAideError} `PUSH_REJECTED` when git refuses the push.
 */
export async function pushBranch(cwd, url, branch, { force = false, signal } = {}) {
  const args = ['push']
  if (force) {
    /* Read the expected SHA first. An empty expectation means "this branch must
       not exist", which is the correct lease for the very first push. */
    const expected = await remoteHeadSha(cwd, url, branch, signal)
    args.push(`--force-with-lease=refs/heads/${branch}:${expected}`)
  }
  args.push(url, `HEAD:refs/heads/${branch}`)
  const result = await run('git', args, { cwd, signal, timeoutMs: NETWORK_TIMEOUT_MS })
  if (result.aborted) signal?.throwIfAborted()
  if (result.missingCwd) {
    throw new GitHubAideError(ERROR_CODES.NOT_A_DIRECTORY, `The working directory no longer exists: ${cwd}`)
  }
  if (result.missing) {
    throw new GitHubAideError(
      ERROR_CODES.GIT_MISSING,
      'The git executable was not found on PATH.',
      { nextStep: 'Install Git and restart DSH so the new PATH is picked up.' },
    )
  }
  if (!result.ok) throw pushFailure(result)
}

/**
 * Record the branch's upstream so later manual `git push`/`git pull` agree with
 * the remote this plugin configured. Credentials for those later commands come
 * from the user's own git setup.
 * @param {string} cwd project root.
 * @param {string} branch local branch name.
 * @param {string} remote remote name.
 * @param {AbortSignal} [signal] cancels the call.
 * @returns {Promise<void>} resolves once both keys are written.
 */
export async function setUpstream(cwd, branch, remote, signal) {
  await gitTry(['config', `branch.${branch}.remote`, remote], { cwd, signal, timeoutMs: 10_000 })
  await gitTry(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], { cwd, signal, timeoutMs: 10_000 })
}

/** Script the askpass helper runs; it only ever reads the credential from env. */
const ASKPASS_SCRIPT = [
  '#!/usr/bin/env node',
  '// Generated per invocation by dsh-github-aide. The credential itself is never',
  '// written here; it arrives through this child process\'s environment.',
  'const prompt = String(process.argv[2] ?? \'\')',
  'const value = /username/i.test(prompt)',
  '  ? (process.env.DSH_GIT_USERNAME ?? \'\')',
  '  : (process.env.DSH_GIT_PASSWORD ?? \'\')',
  'process.stdout.write(value + \'\\n\')',
  '',
].join('\n')

/**
 * Create an in-memory askpass helper for one token.
 *
 * git runs `GIT_ASKPASS` with the prompt as `argv[1]` and reads the credential
 * from stdout. The helper therefore hands git a small script that only echoes
 * `DSH_GIT_USERNAME`/`DSH_GIT_PASSWORD`; the secret lives in the child's
 * environment alone — never in argv, never in `.git/config`, never in the
 * script file. Creating a helper mounts it as the active credential for every
 * subsequent {@link git}-backed call in this module until `dispose()`.
 *
 * POSIX-only shebang: the supported harness target is macOS/Linux. A leftover
 * helper directory (process killed before dispose) contains no secret.
 * @param {object} [credentials] credential to mount.
 * @param {string} [credentials.token] GitHub PAT.
 * @param {string} [credentials.login] GitHub login, or `x-access-token` for a PAT.
 * @returns {{
 *   env: Record<string, string>,
 *   path: string,
 *   dir: string,
 *   dispose: () => void,
 * }} the mounted helper.
 */
export function createAskpassHelper({ token, login } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-github-aide-'))
  const script = join(dir, 'askpass.cjs')
  writeFileSync(script, ASKPASS_SCRIPT, { mode: 0o700 })
  try {
    chmodSync(script, 0o700)
  } catch {
    /* Best effort: the directory is already user-private on most systems. */
  }
  const username = typeof login === 'string' && login.trim().length > 0 ? login.trim() : 'x-access-token'
  const env = {
    GIT_ASKPASS: script,
    SSH_ASKPASS: script,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    DSH_GIT_USERNAME: username,
    DSH_GIT_PASSWORD: typeof token === 'string' ? token : '',
  }
  let disposed = false
  const helper = {
    env,
    path: script,
    dir,
    dispose() {
      if (disposed) return
      disposed = true
      if (activeAskpass === helper) activeAskpass = null
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* Best effort: the temp directory contains no secret. */
      }
    },
  }
  activeAskpass = helper
  return helper
}

export { redact }
