/**
 * dsh-github-aide — Host half.
 *
 * One plugin for the two jobs the source plugins did separately:
 *
 * - publish a project directory (default: this session's workspace) to GitHub:
 *   read-only preflight, secret scan, `.gitignore` generation, `git init`,
 *   commit, repository creation, divergence reconciliation, and push;
 * - report what a publish would do without changing anything;
 * - verify and store the GitHub token in the DSH credential store.
 *
 * The credential never leaves this half: the model gets outcome facts, the
 * browser panel gets booleans and logins, and every echo of an error passes
 * through `redact`. The token is never part of a git argument or remote URL.
 *
 * @module dsh-github-aide
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

import { GitHubAideError, describeError, redact } from './lib/errors.js'
import {
  DEFAULTS,
  NAMESPACE,
  TOKEN_ENV_VARS,
  createTokenStore,
  normalizeConfig,
  resolveToken,
} from './lib/config.js'
import { createGitHubApi } from './lib/github.js'
import { formatUpdateNotice, readUpdateNotice } from './lib/update-notice.js'
import { preflight, publish } from './lib/publish.js'
import { workspaceRootFor, resolveProjectPath } from './lib/workspace.js'

/** Cordis plugin name; the patch entry id is the shorter `github-aide`. */
export const name = 'dsh-github-aide'

/**
 * Services required before this plugin can be applied.
 *
 * `webServer` is deliberately absent: the routes are mounted only when that
 * service exists, so a headless harness still gets the tools.
 */
export const inject = ['settings', 'credentials', 'tools']

/** Credential record holding the personal access token, under this plugin's scope. */
export const TOKEN_RECORD = credentialKey('dsh-github-aide', 'configuration')

/** How long one publish may take, including a large first push. */
const PUBLISH_TIMEOUT_MS = 600_000
/** How long one read-only status call may take. */
const STATUS_TIMEOUT_MS = 60_000

/**
 * The complete result shape every tool returns, so the output schema stays strict.
 *
 * Fields default to the honest empty value; a successful publish replaces the
 * ones it knows and leaves the rest empty rather than `undefined` (the output
 * contract forbids missing keys).
 */
const EMPTY_RESULT = {
  ok: false,
  code: 'FAILED',
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
}

/**
 * Fill in every field of a result.
 * @param {Partial<typeof EMPTY_RESULT>} partial - the fields this outcome knows.
 * @returns {typeof EMPTY_RESULT} a complete result object.
 */
function result(partial) {
  return { ...EMPTY_RESULT, ...partial }
}

/** JSON Schema for the shared result shape. */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the operation succeeded.' },
    code: { type: 'string', required: true, description: 'Machine-readable outcome code.' },
    summary: { type: 'string', required: true, description: 'One sentence describing what happened.' },
    owner: { type: 'string', required: true, description: 'Repository owner login.' },
    repo: { type: 'string', required: true, description: 'Repository name.' },
    html_url: { type: 'string', required: true, description: 'Browser URL of the repository.' },
    branch: { type: 'string', required: true, description: 'Branch that was published.' },
    commit: { type: 'string', required: true, description: 'Commit SHA at HEAD after the publish.' },
    changed_files: { type: 'integer', required: true, description: 'Working-tree entries seen before committing.' },
    pushed: { type: 'boolean', required: true, description: 'Whether commits reached the remote.' },
    token_source: { type: 'string', required: true, description: 'Where the credential came from.' },
    project_type: { type: 'string', required: true, description: 'Detected project stacks, comma separated.' },
    scanned_files: { type: 'integer', required: true, description: 'Files inspected by the preflight scan.' },
    sensitive_hits: {
      type: 'array',
      required: true,
      description: 'Suspected credential files or values found by the scan.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          kind: { type: 'string', required: true },
        },
      },
    },
    dry_run: { type: 'boolean', required: true, description: 'Whether this call changed nothing.' },
    update_notice: { type: 'string', required: true, description: 'Pending harness-update compatibility note, if any.' },
    next_step: { type: 'string', required: true, description: 'What the user should do next, when anything remains.' },
  },
}

/** JSON Schema for the token-configuration tool. */
const CONFIGURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, description: 'Whether the token was accepted.' },
    code: { type: 'string', required: true, description: 'Machine-readable outcome code.' },
    summary: { type: 'string', required: true, description: 'One sentence describing what happened.' },
    login: { type: 'string', required: true, description: 'Login the token authenticates as.' },
    scopes: { type: 'array', required: true, description: 'Classic scopes the token reports, if any.', items: { type: 'string' } },
    classic: { type: 'boolean', required: true, description: 'Whether this looks like a classic token.' },
    configured: { type: 'boolean', required: true, description: 'Whether a token is now stored.' },
    next_step: { type: 'string', required: true, description: 'What the user should do next, when anything remains.' },
  },
}

/**
 * Describe a result as the single text block the model reads.
 * @param {typeof EMPTY_RESULT} value - the result.
 * @returns {Array<{ type: string, text: string }>} rendered content.
 */
function renderResult(value) {
  const lines = [value.summary]
  if (value.project_type) lines.push(`Project type: ${value.project_type}`)
  if (value.html_url) lines.push(`Repository: ${value.html_url}`)
  if (value.pushed && value.branch) lines.push(`Pushed branch: ${value.branch}${value.commit ? ` (${value.commit.slice(0, 12)})` : ''}`)
  if (value.changed_files > 0) lines.push(`Changed files: ${value.changed_files}`)
  if (value.sensitive_hits.length > 0) lines.push(`Sensitive files: ${value.sensitive_hits.map((hit) => hit.path).join(', ')}`)
  if (value.dry_run) lines.push('Dry run: nothing was written and nothing was pushed.')
  if (value.update_notice) lines.push(value.update_notice)
  if (value.next_step) lines.push(`Next: ${value.next_step}`)
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

/**
 * Describe a configuration outcome as text.
 * @param {object} value - the configure result.
 * @returns {Array<{ type: string, text: string }>} rendered content.
 */
function renderConfigure(value) {
  const lines = [value.summary]
  if (value.login) lines.push(`Account: ${value.login}`)
  if (value.scopes.length > 0) lines.push(`Scopes: ${value.scopes.join(', ')}`)
  if (value.next_step) lines.push(`Next: ${value.next_step}`)
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

/**
 * Read the current resolved settings, tolerating a harness that has no settings service.
 * @param {object|null} scope - registered settings scope, when available.
 * @param {object} loaderConfig - the config the loader resolved from the patch layer.
 * @returns {object} the normalized configuration.
 */
function configReader(scope, loaderConfig) {
  return () => {
    let live = {}
    try {
      live = scope?.get() ?? {}
    } catch {
      live = {}
    }
    return normalizeConfig({ ...DEFAULTS, ...(loaderConfig ?? {}), ...live })
  }
}

/**
 * Resolve the token and the account it belongs to.
 * @param {object} ctx - Cordis context.
 * @param {object} store - token store.
 * @param {AbortSignal} signal - cancels the calls.
 * @returns {Promise<{ token: string, source: string, api: object, viewer: object }>} credential facts.
 * @throws {GitHubAideError} when no token is configured or the API rejects it.
 */
async function authenticate(ctx, store, signal) {
  const resolved = await resolveToken(store)
  if (!resolved) {
    throw new GitHubAideError(
      'NOT_CONFIGURED',
      `No GitHub token is configured. Set ${TOKEN_ENV_VARS.join(' or ')} in the environment, or store one with the github_configure tool.`,
      { nextStep: `Set ${TOKEN_ENV_VARS[0]} to a personal access token with the "repo" scope, then restart DSH.` },
    )
  }
  const api = createGitHubApi({ token: resolved.token })
  const viewer = await api.getViewer(signal)
  ctx.logger?.info?.('github-aide: authenticated as %s (token from %s)', viewer.login, resolved.source)
  return { token: resolved.token, source: resolved.source, api, viewer }
}

/**
 * Resolve the project directory a call targets.
 * @param {string|undefined} requested - explicit `path` argument.
 * @param {object} exec - tool execution context.
 * @returns {Promise<string>} canonical absolute directory.
 */
async function resolveRoot(requested, exec) {
  let fallback = process.cwd()
  try {
    fallback = await workspaceRootFor(exec)
  } catch {
    /* No session workspace: an explicit path still works, and a call without
       one fails below with the workspace error, which is the accurate one. */
    if (typeof requested !== 'string' || requested.trim().length === 0) {
      throw new GitHubAideError(
        'NO_WORKSPACE',
        'This session has no workspace directory, so there is no project to publish.',
        { nextStep: 'Pass an explicit path, or open the project folder in DSH and try again.' },
      )
    }
  }
  return resolveProjectPath(requested, fallback)
}

/**
 * Merge per-call arguments over the configured defaults.
 * @param {object} args - tool arguments.
 * @param {object} config - normalized configuration.
 * @returns {object} publish overrides.
 */
function publishOverrides(args, config) {
  return {
    repo: args.repo,
    owner: args.owner,
    description: args.description,
    visibility: args.visibility,
    branch: args.branch,
    commitMessage: args.commitMessage ?? args.commit_message,
    private: args.private,
    autoInit: args.autoInit ?? args.auto_init,
    allowSensitive: args.allowSensitive ?? args.allow_sensitive,
    autoIgnore: args.autoIgnore ?? args.auto_ignore,
    push: args.push,
    force: args.force,
    dryRun: args.dryRun ?? args.dry_run,
  }
}

/**
 * Read the pending harness-update notice, never failing the operation for it.
 * @returns {Promise<string>} the notice text, or an empty string.
 */
async function updateNotice() {
  try {
    return formatUpdateNotice(await readUpdateNotice())
  } catch {
    return ''
  }
}

/**
 * Run the read-only preflight core shared by the status tool and the routes.
 *
 * Returns the raw preflight report (the shape the browser panel renders) plus
 * the credential facts the tool maps into its flat RESULT.
 * @param {object} ctx - Cordis context.
 * @param {() => object} readConfig - current settings.
 * @param {object} args - `{ path?, repo?, owner?, visibility?, branch?, allowSensitive? }`.
 * @param {object} exec - execution context (workspace resolution + signal).
 * @returns {Promise<{ report: object, tokenSource: string, tokenProblem: string }>} preflight facts.
 */
async function runPreflightReport(ctx, readConfig, args, exec) {
  const config = readConfig()
  const store = createTokenStore(ctx, TOKEN_RECORD)
  const root = await resolveRoot(args.path, exec)

  let tokenSource = ''
  let api = null
  let viewer = null
  let tokenProblem = ''
  try {
    const resolved = await resolveToken(store)
    if (resolved) {
      tokenSource = resolved.source
      api = createGitHubApi({ token: resolved.token })
      try {
        viewer = await api.getViewer(exec.signal)
      } catch (error) {
        const described = describeError(error)
        tokenProblem = described.message
        tokenSource = ''
        api = null
      }
    }
  } catch (error) {
    tokenProblem = describeError(error).message
  }

  const notice = await updateNotice()
  const report = await preflight({
    root,
    config,
    api,
    viewer,
    tokenSource,
    update_notice: notice,
    signal: exec.signal,
    ...publishOverrides(args, config),
  })
  return { report, tokenSource, tokenProblem }
}

/**
 * Map a preflight report into the shared flat RESULT used by `github_status`.
 * @param {object} report - preflight report.
 * @param {string} tokenSource - where the credential came from.
 * @param {string} tokenProblem - token/API failure text, when there was one.
 * @returns {typeof EMPTY_RESULT} the tool result.
 */
function statusResult(report, tokenSource, tokenProblem) {
  return result({
    ok: report.ok !== false,
    code: report.code ?? (report.ok === false ? 'FAILED' : 'OK'),
    summary: report.summary ?? '',
    owner: report.owner ?? '',
    repo: report.repo ?? '',
    html_url: report.html_url ?? '',
    branch: report.branch ?? '',
    commit: report.commit ?? '',
    changed_files: Number(report.git?.changed ?? 0),
    pushed: false,
    token_source: tokenSource,
    project_type: (report.project?.stacks ?? []).join(', '),
    scanned_files: Number(report.project?.files ?? 0),
    sensitive_hits: report.project?.sensitive ?? [],
    dry_run: true,
    update_notice: report.update_notice ?? '',
    next_step: tokenProblem
      ? `${tokenProblem} Fix the token, or set ${TOKEN_ENV_VARS[0]} and restart DSH.`
      : (report.next_step ?? ''),
  })
}

/**
 * Run the read-only status tool.
 * @param {object} ctx - Cordis context.
 * @param {() => object} readConfig - current settings.
 * @param {object} args - tool arguments.
 * @param {object} exec - execution context.
 * @returns {Promise<typeof EMPTY_RESULT>} the report.
 */
async function runStatus(ctx, readConfig, args, exec) {
  const { report, tokenSource, tokenProblem } = await runPreflightReport(ctx, readConfig, args, exec)
  return statusResult(report, tokenSource, tokenProblem)
}

/**
 * Run one publish through the injected orchestration.
 * @param {object} ctx - Cordis context.
 * @param {() => object} readConfig - current settings.
 * @param {object} args - tool arguments or route body.
 * @param {object} exec - execution context.
 * @returns {Promise<typeof EMPTY_RESULT>} the outcome.
 */
async function runPublish(ctx, readConfig, args, exec) {
  const config = readConfig()
  const store = createTokenStore(ctx, TOKEN_RECORD)
  let tokenSource = ''
  try {
    const root = await resolveRoot(args.path, exec)
    const notice = await updateNotice()
    /* A dry run is a local report: it needs no credential and must not fail
       just because the user has not stored a token yet. */
    let auth = null
    try {
      auth = await authenticate(ctx, store, exec.signal)
      tokenSource = auth.source
    } catch (error) {
      if (!(args.dryRun === true || args.dry_run === true) || !(error instanceof GitHubAideError) || error.code !== 'NOT_CONFIGURED') {
        throw error
      }
      tokenSource = ''
    }
    const report = await publish({
      root,
      config,
      api: auth?.api ?? null,
      token: auth?.token ?? '',
      viewer: auth?.viewer ?? null,
      tokenSource,
      signal: exec.signal,
      logger: ctx.logger,
      ...publishOverrides(args, config),
    })
    return result({ ...report, token_source: tokenSource, update_notice: notice })
  } catch (error) {
    const described = describeError(error)
    ctx.logger?.warn?.('github-aide: publish failed; code=%s message=%s', described.code, redact(described.message))
    return result({
      ok: false,
      code: described.code,
      summary: described.message,
      token_source: tokenSource,
      next_step: described.nextStep,
      update_notice: await updateNotice(),
    })
  }
}

/**
 * Verify, store, or clear the GitHub token.
 * @param {object} ctx - Cordis context.
 * @param {object} args - `{ token?, clear? }`.
 * @returns {Promise<object>} the configuration outcome.
 */
async function runConfigure(ctx, args) {
  const store = createTokenStore(ctx, TOKEN_RECORD)
  try {
    if (args.clear === true) {
      await store.clear()
      return {
        ok: true,
        code: 'OK',
        summary: 'The stored GitHub token was removed.',
        login: '',
        scopes: [],
        classic: false,
        configured: false,
        next_step: '',
      }
    }
    const token = typeof args.token === 'string' ? args.token.trim() : ''
    if (token.length === 0) {
      throw new GitHubAideError('BAD_REQUEST', 'No token was provided.', {
        nextStep: 'Pass a personal access token with the "repo" scope, or set GITHUB_TOKEN instead.',
      })
    }
    const api = createGitHubApi({ token })
    const viewer = await api.getViewer()
    const reported = await api.getTokenScopes().catch(() => ({ scopes: [], classic: false }))
    await store.write({ token, login: viewer.login, scopes: reported.scopes })
    return {
      ok: true,
      code: 'OK',
      summary: `Stored a GitHub token for ${viewer.login}.`,
      login: viewer.login,
      scopes: reported.scopes,
      classic: reported.classic,
      configured: true,
      next_step: reported.scopes.length > 0 && !reported.scopes.includes('repo')
        ? 'This token does not report the "repo" scope; private repositories will be rejected.'
        : '',
    }
  } catch (error) {
    const described = describeError(error)
    return {
      ok: false,
      code: described.code,
      summary: described.message,
      login: '',
      scopes: [],
      classic: false,
      configured: false,
      next_step: described.nextStep,
    }
  }
}

/**
 * Build the `github_publish` tool.
 * @param {object} ctx - Cordis context.
 * @param {() => object} readConfig - reads the current resolved settings.
 * @returns {object} a registry-ready tool definition.
 */
function publishTool(ctx, readConfig) {
  return defineTool({
    name: 'github_publish',
    description: 'Publish a project directory (default: the current workspace) to GitHub. Runs a read-only preflight and secret scan, generates a .gitignore when none exists, initializes git, commits, creates the repository when missing, reconciles a diverged remote, and pushes. Set dryRun to preview without writing.',
    parameters: {
      path: { type: 'string', description: 'Project directory to publish. Defaults to the session workspace root.' },
      repo: { type: 'string', description: 'Repository name. Defaults to a slug of the project folder name.' },
      owner: { type: 'string', description: 'Account that owns the repository. Defaults to the configured owner, then the token\'s own user.' },
      description: { type: 'string', description: 'Repository description, applied only when the repository is created.' },
      visibility: { type: 'string', enum: ['private', 'public', 'internal'], description: 'Visibility for a newly created repository.' },
      private: { type: 'boolean', description: 'Compatibility shorthand: true means private, false means public.' },
      branch: { type: 'string', description: 'Branch to push. Defaults to the repository\'s current branch, then the configured branch, then main.' },
      commitMessage: { type: 'string', description: 'Commit message for this publish.' },
      autoInit: { type: 'boolean', description: 'Let GitHub create an initial commit. Defaults to false so the first push is accepted.' },
      allowSensitive: { type: 'boolean', description: 'Continue even when the secret scan finds credential-shaped files. Destroys the safety check.' },
      autoIgnore: { type: 'boolean', description: 'Generate a .gitignore when the project has none. Defaults to true.' },
      push: { type: 'boolean', description: 'Push after committing. Defaults to true; set false to commit locally only.' },
      force: { type: 'boolean', description: 'Replace the remote branch when histories conflict (always --force-with-lease). Destroys remote commits.' },
      dryRun: { type: 'boolean', description: 'Run the preflight only: no files, no commits, no repository, no push.' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => renderResult(value),
    },
    timeoutMs: PUBLISH_TIMEOUT_MS,
    /* Two concurrent git runs in one project collide on the index lock. */
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: 'Publish to GitHub', rawInput: args }),
    async execute(args, exec) {
      return runPublish(ctx, readConfig, args ?? {}, exec)
    },
  })
}

/**
 * Build the `github_status` tool.
 * @param {object} ctx - Cordis context.
 * @param {() => object} readConfig - reads the current resolved settings.
 * @returns {object} a registry-ready tool definition.
 */
function statusTool(ctx, readConfig) {
  return defineTool({
    name: 'github_status',
    description: 'Report how a GitHub publish would behave for a project: detected stack, secret-scan hits, git state, resolved repository name, and token availability. Changes nothing.',
    parameters: {
      path: { type: 'string', description: 'Project directory to inspect. Defaults to the session workspace root.' },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => renderResult(value),
    },
    timeoutMs: STATUS_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: 'Check GitHub publish', rawInput: args }),
    async execute(args, exec) {
      try {
        return await runStatus(ctx, readConfig, args ?? {}, exec)
      } catch (error) {
        const described = describeError(error)
        return result({ ok: false, code: described.code, summary: described.message, next_step: described.nextStep, dry_run: true })
      }
    },
  })
}

/**
 * Build the `github_configure` tool.
 * @param {object} ctx - Cordis context.
 * @returns {object} a registry-ready tool definition.
 */
function configureTool(ctx) {
  return defineTool({
    name: 'github_configure',
    description: 'Verify a GitHub personal access token and store it in the DSH credential store, or remove the stored token. The token value is never echoed back.',
    parameters: {
      token: { type: 'string', description: 'Personal access token to verify and store.' },
      clear: { type: 'boolean', description: 'Remove the stored token instead of setting one.' },
    },
    output: {
      schema: CONFIGURE_SCHEMA,
      render: (_args, value) => renderConfigure(value),
    },
    timeoutMs: STATUS_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    presentCall: () => ({ card: 'generic', kind: 'execute', title: 'Configure GitHub token' }),
    async execute(args) {
      return runConfigure(ctx, args ?? {})
    },
  })
}

/**
 * One JSON response helper for the browser routes.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 * @returns {void}
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Read a JSON body with a hard ceiling, so a stray request cannot exhaust memory.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} [limitBytes] - maximum accepted body.
 * @returns {Promise<object>} parsed body.
 */
async function readJsonBody(req, limitBytes = 256 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new GitHubAideError('BAD_REQUEST', 'The request body is too large.')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    throw new GitHubAideError('BAD_REQUEST', 'The request body was not valid JSON.')
  }
}

/**
 * Check that a request came from this machine's own UI.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {boolean} whether the Host/Origin headers are loopback.
 */
function requestTrusted(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase().split(':')[0] : ''
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
  if (!loopback) return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true
  try {
    const parsed = new URL(origin)
    const originHost = parsed.hostname.toLowerCase()
    return originHost === '127.0.0.1' || originHost === 'localhost' || originHost === '::1' || originHost === '[::1]'
  } catch {
    return false
  }
}

/**
 * Register the browser-facing routes when the harness has a web server.
 * @param {object} ctx - Cordis context.
 * @param {() => object} readConfig - live settings.
 * @returns {void}
 */
function registerRoutes(ctx, readConfig) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') {
    ctx.logger?.info?.('github-aide: no webServer service; browser routes are skipped')
    return
  }

  const disposers = []
  const route = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }
  const allowed = (req, res, method) => {
    if (req.method === method || (method === 'GET' && req.method === 'HEAD')) return true
    writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return false
  }
  const trusted = (req, res) => {
    if (requestTrusted(req)) return true
    writeJson(res, 403, { ok: false, error: 'request-not-trusted' })
    return false
  }
  const fail = (res, error) => {
    const described = describeError(error)
    writeJson(res, 200, { ok: false, error: described, code: described.code })
  }

  const status = async () => {
    const config = readConfig()
    const store = createTokenStore(ctx, TOKEN_RECORD)
    let token = { configured: false, writable: true, login: '' }
    try {
      token = await store.describe()
    } catch {
      token = { configured: false, writable: false, login: '' }
    }
    let workspaceRoot = ''
    try {
      workspaceRoot = await workspaceRootFor(fakeExec())
    } catch {
      workspaceRoot = process.cwd()
    }
    /* The panel shows the account the token belongs to; verifying here keeps
       the login out of the browser except as a display fact. */
    let tokenSource = ''
    let account
    try {
      const resolved = await resolveToken(store)
      if (resolved) {
        tokenSource = resolved.source
        const api = createGitHubApi({ token: resolved.token })
        const viewer = await api.getViewer()
        const reported = await api.getTokenScopes().catch(() => ({ scopes: [] }))
        account = { login: viewer.login, scopes: reported.scopes }
      }
    } catch {
      /* A dead token still lets the panel render its configured state. */
      account = undefined
    }
    return {
      plugin: 'dsh-github-aide',
      version: 1,
      token,
      tokenConfigured: token.configured === true,
      tokenSource,
      account,
      environment: TOKEN_ENV_VARS.filter((entry) => (process.env[entry] ?? '').trim().length > 0),
      defaults: config,
      workspaceRoot,
      capabilities: { tools: true, credentials: true, webServer: true },
      updateNotice: await updateNotice(),
    }
  }

  route('/plugins/dsh-github-aide/status', (req, res) => {
    if (!allowed(req, res, 'GET') || !trusted(req, res)) return
    status().then((body) => writeJson(res, 200, { ok: true, result: body })).catch((error) => fail(res, error))
  })

  route('/plugins/dsh-github-aide/preflight', (req, res) => {
    if (!allowed(req, res, 'POST') || !trusted(req, res)) return
    readJsonBody(req)
      .then((body) => runPreflightReport(ctx, readConfig, body, fakeExec()))
      .then(({ report, tokenProblem }) => writeJson(res, 200, {
        ok: report.ok !== false,
        result: tokenProblem === '' ? report : { ...report, token_problem: tokenProblem },
      }))
      .catch((error) => fail(res, error))
  })

  route('/plugins/dsh-github-aide/publish', (req, res) => {
    if (!allowed(req, res, 'POST') || !trusted(req, res)) return
    readJsonBody(req)
      .then((body) => runPublish(ctx, readConfig, body, fakeExec()))
      .then((outcome) => writeJson(res, 200, { ok: outcome.ok === true, result: outcome }))
      .catch((error) => fail(res, error))
  })

  route('/plugins/dsh-github-aide/config', (req, res) => {
    if (!allowed(req, res, 'POST') || !trusted(req, res)) return
    readJsonBody(req)
      .then((body) => runConfigure(ctx, body))
      .then((outcome) => writeJson(res, 200, { ok: outcome.ok === true, result: outcome }))
      .catch((error) => fail(res, error))
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.()
      } catch {
        /* already gone */
      }
    }
  }, 'github-aide: http routes')
  ctx.logger?.info?.('github-aide: mounted %d browser routes', disposers.length)
}

/**
 * A minimal execution context for HTTP calls: no session workspace, no signal.
 * Routes always receive an explicit path from the panel, or fall back to the
 * process working directory.
 * @returns {{ signal: AbortSignal, agent: { session: { header: { cwd: string } } } }} execution context.
 */
function fakeExec() {
  return { signal: new AbortController().signal, agent: { session: { header: { cwd: process.cwd() } } } }
}

/**
 * Register the plugin: one settings namespace, three tools, and (when present)
 * the browser routes.
 * @param {object} ctx - Cordis context.
 * @param {object} [loaderConfig] - resolved config from the patch layer.
 * @returns {void}
 */
export function apply(ctx, loaderConfig) {
  /* One registration, one owner scope: registering the same namespace twice is a
     hard failure in the settings service. */
  let scope = null
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  if (settings && typeof settings.register === 'function') {
    scope = settings.register(NAMESPACE, Config, { applies: 'live' })
  } else {
    ctx.logger?.warn?.('github-aide: no settings service; using patch-layer defaults only')
  }
  const readConfig = configReader(scope, loaderConfig)

  ctx.tools.register(publishTool(ctx, readConfig))
  ctx.tools.register(statusTool(ctx, readConfig))
  ctx.tools.register(configureTool(ctx))

  registerRoutes(ctx, readConfig)

  ctx.logger?.info?.('github-aide: ready (namespace=%s)', NAMESPACE)
}

/** Live plugin configuration, edited under Settings → Plugins. */
export const Config = z.object({
  owner: z.string().default(DEFAULTS.owner)
    .description('GitHub account that owns new repositories. Empty means the token\'s own user.'),
  visibility: z.union([z.const('private'), z.const('public'), z.const('internal')])
    .default(DEFAULTS.visibility)
    .description('Visibility for newly created repositories.'),
  autoInit: z.boolean().default(DEFAULTS.autoInit)
    .description('Let GitHub create an initial commit. Keep this off so the first push is accepted.'),
  branch: z.string().default(DEFAULTS.branch)
    .description('Branch to push. Empty keeps the repository\'s current branch, then main.'),
  commitMessage: z.string().default(DEFAULTS.commitMessage)
    .description('Commit message. Empty uses "Initial commit" for a new repository and "chore: publish" afterwards.'),
  allowSensitive: z.boolean().default(DEFAULTS.allowSensitive)
    .description('Allow publishing when the secret scan finds credential-shaped files. Not recommended.'),
  autoIgnore: z.boolean().default(DEFAULTS.autoIgnore)
    .description('Write a generated .gitignore when the project has none.'),
  timeoutMs: z.number().default(DEFAULTS.timeoutMs)
    .description('Timeout for one publish (milliseconds).'),
  maxScanFiles: z.number().default(DEFAULTS.maxScanFiles)
    .description('Maximum files inspected by the credential scan.'),
})
