/**
 * The merged orchestration: one read-only `preflight()` and one `publish()` that
 * initialises, commits, creates/finds the repository, reconciles divergence and
 * pushes.
 *
 * Both entry points take every collaborator as an injected dependency (`api`,
 * `token`, `viewer`, `signal`, `logger`), so the whole flow is exercisable
 * offline against a fake GitHub API and a local bare remote. Nothing here talks
 * to the network directly.
 *
 * The remote-URL seam is the repository object returned by the API: its
 * `clone_url` is used when present, which is exactly the cleanup-free HTTPS URL
 * GitHub returns in production and lets tests point at a `file:///` bare remote.
 */

import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ERROR_CODES, GitHubAideError, describeError, redact,
} from './errors.js'
import {
  buildGitignore, detectStacks, formatBytes, resolveIdentity, suggestRepoName,
} from './detect.js'
import { listTopLevel, scanProject } from './scan.js'
import {
  buildRemoteUrl, commit as gitCommit, configGet, configureIdentity, createAskpassHelper,
  currentBranch, fetchBranch, getRemote, headCommit, initRepo, isGitRepo, pushBranch,
  rebaseOntoFetchHead, remoteBranchExists, setRemote, setUpstream, stageAll, statusEntries,
} from './git.js'

/** Longest repository name GitHub accepts. */
const MAX_REPO_NAME = 100
/** Used when a project directory name yields no usable characters. */
const FALLBACK_REPO_NAME = 'project'
/** Fallback file budget when no normalized config was passed. */
const DEFAULT_MAX_SCAN_FILES = 8000

/**
 * Fill in every field of the shared RESULT shape.
 * @param {object} [partial] fields this outcome knows.
 * @returns {object} a complete result object.
 */
function result(partial = {}) {
  return {
    ok: false,
    code: ERROR_CODES.FAILED,
    summary: '',
    owner: '',
    repo: '',
    html_url: '',
    branch: '',
    commit: '',
    changed_files: 0,
    pushed: false,
    token_source: '',
    project_type: '',
    scanned_files: 0,
    sensitive_hits: [],
    dry_run: false,
    update_notice: '',
    next_step: '',
    ...partial,
  }
}

/**
 * Fill in every field of the preflight report shape.
 * @param {object} [partial] fields this report knows.
 * @returns {object} a complete report object.
 */
function report(partial = {}) {
  return {
    ok: false,
    code: 'OK',
    summary: '',
    root: '',
    owner: '',
    repo: '',
    branch: '',
    visibility: '',
    git: { isRepo: false, branch: '', remote: '', changed: 0, hasHead: false },
    project: { stacks: [], files: 0, bytes: 0, sensitive: [], truncated: false, hasGitignore: false },
    repoExists: null,
    html_url: '',
    viewer: null,
    token_source: '',
    update_notice: '',
    next_step: '',
    ...partial,
  }
}

/**
 * Extract the settings the flows need, with the same defaults as `lib/config.js`.
 *
 * Duplicating the defaults (rather than importing `normalizeConfig`) keeps this
 * module runnable when a caller passes a partial or no config at all; a
 * normalized config simply wins on every key.
 * @param {{ config?: object }} input flow input.
 * @returns {object} resolved settings.
 */
function settingsOf(input) {
  const config = input.config ?? {}
  return {
    owner: typeof config.owner === 'string' ? config.owner.trim() : '',
    visibility: normalizeVisibility(config.visibility) || 'private',
    branch: typeof config.branch === 'string' ? config.branch.trim() : '',
    commitMessage: typeof config.commitMessage === 'string' ? config.commitMessage.trim() : '',
    allowSensitive: config.allowSensitive === true,
    autoIgnore: config.autoIgnore !== false,
    autoInit: config.autoInit === true,
    maxScanFiles: Number.isFinite(config.maxScanFiles) && config.maxScanFiles > 0
      ? Math.floor(config.maxScanFiles)
      : DEFAULT_MAX_SCAN_FILES,
  }
}

/**
 * Read one project's stack/scan facts.
 * @param {string} root project directory.
 * @param {number} maxScanFiles file budget.
 * @returns {Promise<{
 *   listing: { files: string[], dirs: string[] },
 *   stacks: { id: string, label: string, ignore: string[] }[],
 *   scan: Awaited<ReturnType<typeof scanProject>>,
 *   hasGitignore: boolean,
 * }>} project facts.
 */
async function analyzeProject(root, maxScanFiles) {
  const listing = await listTopLevel(root)
  const stacks = detectStacks(listing)
  const scan = await scanProject(root, { maxScanFiles })
  return {
    listing,
    stacks,
    scan,
    hasGitignore: listing.files.some((name) => name === '.gitignore'),
  }
}

/**
 * Resolve the repository coordinates a publish would use.
 * @param {object} input flow input.
 * @param {ReturnType<typeof settingsOf>} settings resolved settings.
 * @param {boolean} isRepo whether the project already is a git repository.
 * @param {string} repositoryBranch current branch, when it exists.
 * @returns {{ owner: string, repo: string, visibility: string, branch: string }} target names.
 */
function resolveNames(input, settings, isRepo, repositoryBranch) {
  const viewer = input.viewer ?? null
  const owner = firstNonEmpty(input.owner, settings.owner, viewer?.login) ?? ''
  const repo = slugifyRepoName(firstNonEmpty(input.repo, suggestRepoName(input.root)))
  let visibility = normalizeVisibility(input.visibility)
  if (visibility === '') {
    visibility = input.private === false ? 'public' : input.private === true ? 'private' : ''
  }
  if (visibility === '') visibility = settings.visibility
  /* Branch precedence is deliberate: an explicit per-call branch, then the
     configured branch, then whatever branch the repository is already on, then
     the default. Reusing the existing branch is what makes a second publish a
     no-op instead of a second branch. */
  const branch = firstNonEmpty(
    sanitizeBranch(input.branch),
    settings.branch,
    isRepo ? repositoryBranch : '',
    'main',
  ) ?? 'main'
  return { owner, repo, visibility, branch }
}

/**
 * Build the preflight report. Shared by `preflight()` and the dry-run path so
 * both describe the same plan.
 * @param {object} input flow input.
 * @param {Awaited<ReturnType<typeof analyzeProject>>} [precomputed] already-read project facts.
 * @returns {Promise<object>} the report.
 */
async function buildReport(input, precomputed) {
  const root = String(input.root)
  const settings = settingsOf(input)
  const signal = input.signal
  const secrets = typeof input.token === 'string' && input.token.length > 0 ? [input.token] : []
  const allowSensitive = input.allowSensitive === undefined
    ? settings.allowSensitive
    : input.allowSensitive === true
  const autoIgnore = input.autoIgnore === undefined ? settings.autoIgnore : input.autoIgnore === true
  const updateNotice = typeof input.update_notice === 'string'
    ? input.update_notice
    : typeof input.updateNotice === 'string' ? input.updateNotice : ''

  const info = await stat(root).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    return report({
      ok: false,
      code: ERROR_CODES.NOT_A_DIRECTORY,
      summary: `The project directory does not exist or is not a directory: ${root}`,
      root,
      token_source: typeof input.tokenSource === 'string' ? input.tokenSource : '',
      update_notice: updateNotice,
      next_step: 'Pass the absolute path of an existing project directory.',
    })
  }

  const analysis = precomputed ?? await analyzeProject(root, settings.maxScanFiles)
  const isRepo = await isGitRepo(root, signal)
  const repositoryBranch = isRepo ? await currentBranch(root, signal) : ''
  const names = resolveNames(input, settings, isRepo, repositoryBranch)
  const remote = isRepo ? await getRemote(root, 'origin', signal) : ''
  const changed = isRepo ? (await statusEntries(root, signal)).length : 0
  const hasHead = isRepo ? (await headCommit(root, signal)) !== '' : false

  /* Repository existence is reachability metadata, not a mutation. A failed
     lookup degrades the report to `null` instead of failing the whole status
     call: a token problem must not hide the project facts. */
  let repoExists = null
  let repository = null
  const apiNotes = []
  if (input.api && names.owner && names.repo) {
    try {
      const found = await input.api.findRepository(names.owner, names.repo, signal)
      repoExists = found?.exists === true
      repository = found?.repository ?? null
    } catch (error) {
      const described = describeError(error)
      apiNotes.push(redact(`GitHub lookup failed: ${described.message}`, secrets))
    }
  }

  const sensitive = analysis.scan.sensitive
  let code = 'OK'
  let ok = true
  if (analysis.scan.files === 0) {
    code = ERROR_CODES.NO_FILES
    ok = false
  } else if (sensitive.length > 0 && !allowSensitive) {
    code = ERROR_CODES.SENSITIVE_BLOCKED
    ok = false
  }

  const stackIds = analysis.stacks.map((stack) => stack.id)
  const target = `${names.owner ? `${names.owner}/` : ''}${names.repo}`
  const remoteState = repoExists === null
    ? (input.api ? 'remote lookup unavailable' : 'no GitHub token for a remote lookup')
    : repoExists ? 'repository exists' : 'repository will be created'
  let summary = [
    `Preflight of ${root}: ${analysis.scan.files} file(s), ${formatBytes(analysis.scan.bytes)}`,
    stackIds.length > 0 ? `stacks ${stackIds.join(', ')}` : 'no known stack',
    isRepo ? `git branch ${repositoryBranch || '(unborn)'} with ${changed} changed file(s)` : 'not a git repository yet',
    `target ${target} (${names.visibility}) on ${names.branch}`,
    remoteState,
  ].join('; ') + '.'
  if (code === ERROR_CODES.SENSITIVE_BLOCKED) {
    summary += ` ${sensitive.length} suspicious path(s) block publishing.`
  } else if (code === ERROR_CODES.NO_FILES) {
    summary += ' The directory contains no publishable files.'
  }

  const nextSteps = []
  if (code === ERROR_CODES.NO_FILES) {
    nextSteps.push('Add at least one file to the project directory, or point at another directory.')
  }
  if (code === ERROR_CODES.SENSITIVE_BLOCKED) {
    nextSteps.push('Review the flagged credential files/content and retry with allowSensitive=true only if they are safe to publish.')
  }
  if (!isRepo) nextSteps.push('Publishing will initialise a git repository in this directory.')
  if (!analysis.hasGitignore && autoIgnore) nextSteps.push('A .gitignore will be generated from the detected stacks.')
  if (!input.api) nextSteps.push('No GitHub token is available; set GITHUB_TOKEN (or GH_TOKEN) before publishing.')
  nextSteps.push(...apiNotes)
  if (repoExists === true) nextSteps.push('The repository already exists and will be reused.')
  if (repoExists === false) nextSteps.push('The repository does not exist yet and will be created.')

  return report({
    ok,
    code,
    summary,
    root,
    owner: names.owner,
    repo: names.repo,
    branch: names.branch,
    visibility: names.visibility,
    git: { isRepo, branch: repositoryBranch, remote, changed, hasHead },
    project: {
      stacks: stackIds,
      files: analysis.scan.files,
      bytes: analysis.scan.bytes,
      sensitive,
      truncated: analysis.scan.truncated,
      hasGitignore: analysis.hasGitignore,
    },
    repoExists,
    html_url: typeof repository?.html_url === 'string' ? repository.html_url : '',
    viewer: input.viewer ? { login: String(input.viewer.login ?? '') } : null,
    token_source: typeof input.tokenSource === 'string' ? input.tokenSource : '',
    update_notice: updateNotice,
    next_step: nextSteps.join(' ').trim(),
  })
}

/**
 * Read-only inspection of a project: what would be scanned, committed, created
 * and pushed. Never writes a file, never runs a mutating git command and never
 * calls a mutating API method.
 *
 * A bad or empty directory is reported (`ok: false` plus a code) rather than
 * thrown, because this is the call a status view makes: it must always produce
 * a report.
 * @param {object} input flow input; see the module header and `INTERFACE.md`.
 * @param {string} input.root absolute project directory (required).
 * @param {object} [input.config] `normalizeConfig()` output.
 * @param {object|null} [input.api] GitHub API instance, or null without a token.
 * @param {string} [input.tokenSource] where the credential came from.
 * @param {{ login: string, id?: number }|null} [input.viewer] authenticated account.
 * @param {AbortSignal} [input.signal] cancels the calls.
 * @param {object} [input.logger] optional `{ info, warn }`.
 * @returns {Promise<object>} the report.
 */
export async function preflight(input = {}) {
  input.signal?.throwIfAborted()
  const root = typeof input.root === 'string' ? input.root.trim() : ''
  if (root.length === 0) {
    return report({
      ok: false,
      code: ERROR_CODES.BAD_REQUEST,
      summary: 'A project directory is required.',
      token_source: typeof input.tokenSource === 'string' ? input.tokenSource : '',
      update_notice: typeof input.update_notice === 'string'
        ? input.update_notice
        : typeof input.updateNotice === 'string' ? input.updateNotice : '',
      next_step: 'Pass the absolute path of the project directory to inspect.',
    })
  }
  return buildReport({ ...input, root })
}

/**
 * Log one progress line through the injected logger, never echoing a secret.
 * @param {object} input flow input carrying `logger` and `token`.
 * @param {'info'|'warn'} level log level.
 * @param {string} message text to emit.
 * @returns {void}
 */
function emit(input, level, message) {
  const secrets = typeof input.token === 'string' && input.token.length > 0 ? [input.token] : []
  try {
    input.logger?.[level]?.(redact(message, secrets))
  } catch {
    /* A logger failure must never fail a publish. */
  }
}

/**
 * The commit message for this publish.
 * @param {object} input flow input.
 * @param {ReturnType<typeof settingsOf>} settings resolved settings.
 * @param {boolean} hasHead whether the repository already has a commit.
 * @returns {string} the message to use.
 */
function commitMessageFor(input, settings, hasHead) {
  const explicit = firstNonEmpty(input.commitMessage, settings.commitMessage)
  if (explicit !== undefined) return explicit
  return hasHead ? 'chore: publish project' : 'Initial commit'
}

/**
 * The remote URL to store as `origin`.
 *
 * Prefers the URL the API returned (`clone_url`), which is the credential-free
 * HTTPS URL in production; strips any userinfo defensively so a proxy or a fake
 * API can never plant a token in `.git/config`.
 * @param {object|null} repository repository JSON from the API.
 * @param {string} owner repository owner login.
 * @param {string} repo repository name.
 * @returns {string} clean remote URL.
 */
function remoteUrlFor(repository, owner, repo) {
  const cloneUrl = typeof repository?.clone_url === 'string' ? repository.clone_url.trim() : ''
  if (cloneUrl.length === 0) return buildRemoteUrl(owner, repo)
  return cloneUrl.replace(/(:\/\/)[^/@\s]*:[^/@\s]*@/, '$1')
}

/** The browser URL of a repository, for the `html_url` result field. */
function webUrlFor(repository, owner, repo) {
  if (typeof repository?.html_url === 'string' && repository.html_url.length > 0) return repository.html_url
  return owner && repo ? `https://github.com/${owner}/${repo}` : ''
}

/**
 * Publish a project directory to GitHub.
 *
 * Order is the contract: reject a bad/empty project, block sensitive hits, honour
 * a dry run (before any write or mutating API call), resolve names, create or
 * reuse the remote repository, initialise git, generate `.gitignore` only when
 * absent, configure a fallback identity, stage/commit (or reuse HEAD), set the
 * clean `origin`, then reconcile divergence and push.
 * @param {object} input flow input; see the module header and `INTERFACE.md`.
 * @param {string} input.root absolute project directory (required).
 * @param {object} [input.config] `normalizeConfig()` output.
 * @param {object|null} [input.api] GitHub API instance; required for a real push.
 * @param {string} [input.token] raw GitHub PAT, used only through the in-memory askpass.
 * @param {string} [input.tokenSource] where the credential came from.
 * @param {{ login: string, id?: number }|null} [input.viewer] authenticated account.
 * @param {AbortSignal} [input.signal] cancels the calls.
 * @param {object} [input.logger] optional `{ info, warn }`.
 * @returns {Promise<object>} the complete RESULT; expected
 *   failures come back as `ok: false` plus a `code` rather than a throw.
 */
export async function publish(input = {}) {
  const secrets = typeof input.token === 'string' && input.token.length > 0 ? [input.token] : []
  const context = {
    owner: '',
    repo: '',
    html_url: '',
    branch: '',
    commit: '',
    changed_files: 0,
    token_source: typeof input.tokenSource === 'string' ? input.tokenSource : '',
    project_type: '',
    scanned_files: 0,
    sensitive_hits: [],
    dry_run: input.dryRun === true,
    update_notice: typeof input.update_notice === 'string'
      ? input.update_notice
      : typeof input.updateNotice === 'string' ? input.updateNotice : '',
  }
  try {
    return await runPublish(input, context)
  } catch (error) {
    /* Expected failures come back as data: the tool surface and every route map
       the same RESULT shape whether the publish succeeded or not. */
    if (error instanceof GitHubAideError) {
      return result({
        ...context,
        ok: false,
        code: error.code,
        summary: redact(error.message, secrets),
        next_step: error.nextStep ?? '',
      })
    }
    throw error
  }
}

/**
 * The publish body; `context` accumulates the fields a failure RESULT still reports.
 * @param {object} input flow input.
 * @param {object} context mutable result context.
 * @returns {Promise<object>} the RESULT.
 */
async function runPublish(input, context) {
  input.signal?.throwIfAborted()
  const root = typeof input.root === 'string' ? input.root.trim() : ''
  if (root.length === 0) {
    throw new GitHubAideError(
      ERROR_CODES.BAD_REQUEST,
      'A project directory is required.',
      { nextStep: 'Pass the absolute path of the project directory to publish.' },
    )
  }
  const settings = settingsOf(input)
  const signal = input.signal
  const allowSensitive = input.allowSensitive === undefined
    ? settings.allowSensitive
    : input.allowSensitive === true
  const autoIgnore = input.autoIgnore === undefined ? settings.autoIgnore : input.autoIgnore === true
  const autoInit = input.autoInit === undefined ? settings.autoInit : input.autoInit === true
  const shouldPush = input.push !== false
  const force = input.force === true

  /* 1. The target must be an existing directory. */
  const info = await stat(root).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new GitHubAideError(
      ERROR_CODES.NOT_A_DIRECTORY,
      `The project directory does not exist or is not a directory: ${root}`,
      { nextStep: 'Pass the absolute path of an existing project directory.' },
    )
  }

  /* 2. Scan before anything is created: a credential must never reach a remote. */
  const analysis = await analyzeProject(root, settings.maxScanFiles)
  context.project_type = analysis.stacks.map((stack) => stack.id).join(', ')
  context.scanned_files = analysis.scan.files
  context.sensitive_hits = analysis.scan.sensitive
  emit(input, 'info', `scanning ${root}: ${analysis.scan.files} file(s), ${analysis.scan.sensitive.length} sensitive hit(s)`)
  if (analysis.scan.files === 0) {
    throw new GitHubAideError(
      ERROR_CODES.NO_FILES,
      `The directory contains no publishable files: ${root}`,
      { nextStep: 'Add at least one file, or point at another project directory.' },
    )
  }
  if (analysis.scan.sensitive.length > 0 && !allowSensitive) {
    throw new GitHubAideError(
      ERROR_CODES.SENSITIVE_BLOCKED,
      `The scan found ${analysis.scan.sensitive.length} suspicious credential path(s) in ${root}.`,
      {
        nextStep: 'Review the flagged files/content, then retry with allowSensitive=true only if they are safe to publish.',
      },
    )
  }

  /* 3. A dry run is a report, not a rehearsal: no writes, no mutations. */
  if (input.dryRun === true) {
    return dryRunResult({ ...input, root }, analysis)
  }

  /* 4. Resolve the repository coordinates from explicit input, config, viewer, repo. */
  const isRepo = await isGitRepo(root, signal)
  const repositoryBranch = isRepo ? await currentBranch(root, signal) : ''
  const names = resolveNames(input, settings, isRepo, repositoryBranch)
  context.owner = names.owner
  context.repo = names.repo
  context.branch = names.branch
  emit(input, 'info', `publishing ${root} to ${names.owner ? `${names.owner}/` : ''}${names.repo} (${names.visibility}) on ${names.branch}`)

  if (shouldPush && !input.api) {
    throw new GitHubAideError(
      ERROR_CODES.NOT_CONFIGURED,
      'No GitHub API client is available, so the remote repository cannot be prepared.',
      { nextStep: 'Store a GitHub token with the github_configure tool, or set GITHUB_TOKEN, then retry.' },
    )
  }

  /* 5. Create the repository when absent, reuse it when present. */
  let repository = null
  if (shouldPush) {
    const found = await input.api.findRepository(names.owner, names.repo, signal)
    if (found?.exists === true) {
      repository = found.repository ?? null
      emit(input, 'info', `reusing repository ${names.owner}/${names.repo}`)
    } else {
      repository = await input.api.createRepository({
        name: names.repo,
        description: typeof input.description === 'string' && input.description.trim().length > 0
          ? input.description.trim()
          : undefined,
        visibility: names.visibility,
        autoInit,
      }, signal)
      emit(input, 'info', `created repository ${names.owner}/${names.repo} (${names.visibility})`)
    }
    context.html_url = webUrlFor(repository, names.owner, names.repo)
  }

  /* 6. Initialise git, then add the generated .gitignore only when absent. */
  if (!isRepo) {
    await initRepo(root, names.branch, signal)
    emit(input, 'info', `initialised git repository on branch ${names.branch}`)
  }
  if (!analysis.hasGitignore && autoIgnore) {
    await writeFile(join(root, '.gitignore'), buildGitignore(analysis.stacks), 'utf8')
    emit(input, 'info', `generated .gitignore for ${analysis.stacks.length} detected stack(s)`)
  }

  /* 7. Prefer an identity the user already configured; fall back to the viewer.
        Never fail because git config is absent — resolveIdentity always yields one. */
  const gitConfig = {
    name: await configGet(root, 'user.name', signal),
    email: await configGet(root, 'user.email', signal),
  }
  const identity = resolveIdentity({ options: {}, gitConfig, profile: input.viewer })
  if (gitConfig.name.length === 0 || gitConfig.email.length === 0) {
    await configureIdentity(root, identity.name, identity.email, signal)
    emit(input, 'info', `configured commit identity ${identity.name} <${identity.email}>`)
  }

  /* 8. Stage and commit; an unchanged existing tree reuses HEAD instead of failing. */
  const entries = await statusEntries(root, signal)
  context.changed_files = entries.length
  const head = await headCommit(root, signal)
  if (entries.length === 0 && head === '') {
    throw new GitHubAideError(
      ERROR_CODES.NO_FILES,
      `Nothing in ${root} is staged for a first commit.`,
      { nextStep: 'Check the existing .gitignore; every file may be ignored.' },
    )
  }
  await stageAll(root, signal)
  let commit = head
  if (entries.length > 0 || head === '') {
    commit = await gitCommit(root, commitMessageFor(input, settings, head !== ''), head === '', signal)
    emit(input, 'info', `committed ${entries.length} changed file(s) as ${commit.slice(0, 7)}`)
  } else {
    emit(input, 'info', 'no changes to commit; reusing HEAD')
  }
  context.commit = commit

  /* 9. origin always carries the clean URL; the credential only exists in the
        askpass helper's environment for the duration of the network commands. */
  const remoteUrl = remoteUrlFor(repository, names.owner, names.repo)
  await setRemote(root, 'origin', remoteUrl, signal)
  let pushed = false
  let askpass
  try {
    if (shouldPush) {
      if (typeof input.token === 'string' && input.token.length > 0) {
        askpass = createAskpassHelper({ token: input.token, login: input.viewer?.login })
      }
      /* An existing remote branch means the histories must be reconciled before
         the push, otherwise git rejects it as non-fast-forward. */
      if (await remoteBranchExists(root, remoteUrl, names.branch, signal)) {
        await fetchBranch(root, remoteUrl, names.branch, signal)
        await rebaseOntoFetchHead(root, signal)
        commit = await headCommit(root, signal)
        emit(input, 'info', `rebased onto the remote ${names.branch}`)
      }
      await pushBranch(root, remoteUrl, names.branch, { force, signal })
      await setUpstream(root, names.branch, 'origin', signal)
      pushed = true
      emit(input, 'info', `pushed ${names.branch} to ${names.owner}/${names.repo}`)
    }
  } finally {
    askpass?.dispose()
  }
  context.commit = commit

  /* 10. Report exactly the shared RESULT shape. */
  const summary = pushed
    ? `Published ${entries.length} changed file(s) to ${names.owner}/${names.repo} on branch ${names.branch}.`
    : `Committed ${entries.length} changed file(s) locally in ${root}; the push was skipped.`
  return result({
    ...context,
    ok: true,
    code: 'OK',
    summary,
    html_url: shouldPush ? webUrlFor(repository, names.owner, names.repo) : '',
    pushed,
    commit,
    next_step: shouldPush
      ? ''
      : 'The push was skipped (push=false); run publish again with push enabled, or push the branch manually once the repository exists.',
  })
}

/**
 * Build the RESULT for a dry run from the same report `preflight()` produces.
 * @param {object} input flow input.
 * @param {Awaited<ReturnType<typeof analyzeProject>>} analysis already-read project facts.
 * @returns {Promise<object>} the dry-run RESULT.
 */
async function dryRunResult(input, analysis) {
  const view = await buildReport({ ...input, root: String(input.root) }, analysis)
  const target = `${view.owner ? `${view.owner}/` : ''}${view.repo}`
  return result({
    ok: view.ok,
    code: view.code,
    summary: view.ok
      ? `Dry run: ${view.root} would be published to ${target} on branch ${view.branch} with ${view.git.changed} changed file(s); nothing was written or pushed.`
      : view.summary,
    owner: view.owner,
    repo: view.repo,
    html_url: view.html_url,
    branch: view.branch,
    commit: '',
    changed_files: view.git.changed,
    pushed: false,
    token_source: view.token_source,
    project_type: view.project.stacks.join(', '),
    scanned_files: view.project.files,
    sensitive_hits: view.project.sensitive,
    dry_run: true,
    update_notice: view.update_notice,
    next_step: view.next_step,
  })
}

/**
 * Return the first non-blank string.
 * @param {...(string|undefined)} values candidates, best first.
 * @returns {string|undefined} the first usable value.
 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Validate a visibility value.
 * @param {unknown} value candidate.
 * @returns {'private'|'public'|'internal'|''} the value, or `''` when invalid.
 */
function normalizeVisibility(value) {
  return value === 'private' || value === 'public' || value === 'internal' ? value : ''
}

/**
 * Turn any name into a valid GitHub repository name (port of the core helper).
 * @param {string} name candidate name.
 * @returns {string} a name GitHub accepts, never empty.
 */
function slugifyRepoName(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/[-._]{2,}/gu, '-')
    .replace(/^[-._]+|[-._]+$/gu, '')
    .slice(0, MAX_REPO_NAME)
    .replace(/^[-._]+|[-._]+$/gu, '')
  return slug.length > 0 ? slug : FALLBACK_REPO_NAME
}

/**
 * Keep a branch name usable by git.
 * @param {unknown} value candidate branch.
 * @returns {string|undefined} sanitized branch, or undefined when blank.
 */
function sanitizeBranch(value) {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().replace(/[^A-Za-z0-9._/-]/g, '-').replace(/^[.-]+/, '')
  return cleaned.length > 0 ? cleaned : undefined
}
