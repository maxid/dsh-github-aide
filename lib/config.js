/**
 * Configuration defaults, validation, and credential-record storage.
 *
 * Two data classes live here on purpose and they are stored in different
 * places. Non-secret settings belong to the harness settings namespace, where
 * `ctx.settings` owns the schema and the YAML file. The personal access token
 * belongs to `ctx.credentials`, because a settings field is written verbatim
 * into `settings.yaml` and a secret there is a secret in a plain file. Keeping
 * the split inside one module is what stops a future edit from "simplifying"
 * the token into the settings object.
 *
 * The environment still wins over both stores: CI cannot reach the credential
 * file, and a user who would rather not persist a token at all can export one
 * for the session.
 *
 * This module is dependency-free (Node builtins only) so the test suite can
 * import it with plain `node --test`; the DSH `credentialKey` helper is applied
 * by `index.js`, which is why {@link createTokenStore} takes the record key as
 * an argument instead of importing it.
 */
import { ERROR_CODES, GitHubAideError } from './errors.js'

/** Settings namespace owned by this plugin. */
export const NAMESPACE = 'github-aide'

/**
 * Environment variables consulted before the stored token, in priority order.
 *
 * `GITHUB_TOKEN` is the name most tooling exports; `GH_TOKEN` is the GitHub
 * CLI's name and is honoured second so a machine already set up for `gh` works
 * without duplicating the secret.
 */
export const TOKEN_ENV_VARS = Object.freeze(['GITHUB_TOKEN', 'GH_TOKEN'])

/**
 * Non-secret defaults, all optional.
 *
 * `autoInit` defaults to `false` on purpose: a repository created with an
 * initial commit already contains a commit the workspace does not have, which
 * makes the very first push a non-fast-forward rejection.
 *
 * `timeoutMs` is the outer budget for one publish call (default ten minutes);
 * `maxScanFiles` bounds the preflight walk so a huge `node_modules` or build
 * tree cannot make a read-only status call hang.
 */
export const DEFAULTS = Object.freeze({
  owner: '',
  visibility: 'private',
  autoInit: false,
  branch: '',
  commitMessage: '',
  allowSensitive: false,
  autoIgnore: true,
  timeoutMs: 600_000,
  maxScanFiles: 8000,
})

/** Repository visibilities GitHub understands. */
const VISIBILITIES = new Set(['private', 'public', 'internal'])
/** Longest name GitHub accepts for a user or organization login. */
const MAX_OWNER_LENGTH = 100
/** Longest branch name we will forward to git. */
const MAX_BRANCH_LENGTH = 255
/** Bounds for the publish timeout; below a second it is useless, above an hour it is a hang. */
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 3_600_000
/** Bounds for the preflight scan limit. */
const MIN_SCAN_FILES = 1
const MAX_SCAN_FILES = 1_000_000

/**
 * Coerce a value to a trimmed string, or the empty string.
 * @param {unknown} value - candidate value.
 * @returns {string} a string, never nullish.
 */
function asString(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * Honor a boolean only when it is actually a boolean.
 *
 * `Config` from schemastery has already coerced its inputs; accepting `'true'`
 * or `1` here would make the direct (test/lib) path disagree with the harness
 * path about what "false" means.
 * @param {unknown} value - candidate value.
 * @param {boolean} fallback - default when the value is not a boolean.
 * @returns {boolean} the resolved flag.
 */
function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize a repository owner login.
 * @param {unknown} value - candidate owner, possibly `@octocat`.
 * @returns {string} a trimmed login without the leading `@`.
 */
function normalizeOwner(value) {
  return asString(value).trim().replace(/^@+/u, '').slice(0, MAX_OWNER_LENGTH)
}

/**
 * Normalize a branch name into something git and GitHub both accept.
 *
 * An invalid branch is not worth throwing over during a publish: the caller can
 * fall back to the repository's current branch when this returns `''`. The
 * characters `git check-ref-format` forbids (spaces, `~^:?*[`, backslash,
 * control characters) are removed rather than replaced, because replacing a
 * space with `-` would silently change `feature x` into a different branch name
 * instead of failing to match one.
 * @param {unknown} value - candidate branch name.
 * @returns {string} a safe branch name, or `''` to mean "not specified".
 */
function normalizeBranch(value) {
  const cleaned = asString(value)
    .trim()
    .replace(/[\u0000-\u0020~^:?*\[\\]/gu, '')
    .replace(/\.{2,}/gu, '.')
    .replace(/\/{2,}/gu, '/')
    .replace(/^[./]+|[./]+$/gu, '')
    .slice(0, MAX_BRANCH_LENGTH)
    .replace(/[./]+$/gu, '')
  return cleaned.length > 0 ? cleaned : ''
}

/**
 * Clamp the outer publish timeout.
 * @param {unknown} value - candidate timeout in milliseconds.
 * @returns {number} a finite timeout within {@link MIN_TIMEOUT_MS}..{@link MAX_TIMEOUT_MS}.
 */
function normalizeTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULTS.timeoutMs
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)))
}

/**
 * Clamp the preflight scan limit.
 *
 * A positive fraction is still a request to scan, so it floors up to one file
 * rather than falling back to the default; zero, negatives, NaN, and infinity
 * are treated as "not specified".
 * @param {unknown} value - candidate maximum file count.
 * @returns {number} a finite limit within {@link MIN_SCAN_FILES}..{@link MAX_SCAN_FILES}.
 */
function normalizeScanLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULTS.maxScanFiles
  return Math.min(MAX_SCAN_FILES, Math.max(MIN_SCAN_FILES, Math.floor(value)))
}

/**
 * Fill in every configuration field, validating the enum and clamping numerics.
 *
 * Unknown keys are dropped rather than merged: the returned object is what the
 * publish flow uses, and an unexpected key slipping through would let a tool
 * argument override behaviour the interface never promised.
 * @param {unknown} [raw] - partial configuration from settings or a tool call.
 * @returns {typeof DEFAULTS} the complete, validated configuration.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const visibility = asString(source.visibility).trim().toLowerCase()
  return {
    owner: normalizeOwner(source.owner),
    visibility: VISIBILITIES.has(visibility) ? visibility : DEFAULTS.visibility,
    autoInit: booleanOr(source.autoInit, DEFAULTS.autoInit),
    branch: normalizeBranch(source.branch),
    commitMessage: asString(source.commitMessage).trim(),
    allowSensitive: booleanOr(source.allowSensitive, DEFAULTS.allowSensitive),
    autoIgnore: booleanOr(source.autoIgnore, DEFAULTS.autoIgnore),
    timeoutMs: normalizeTimeout(source.timeoutMs),
    maxScanFiles: normalizeScanLimit(source.maxScanFiles),
  }
}

/** The empty credential payload, used before anything is stored. */
function emptyRecord() {
  return { revision: 0, token: '', login: '', scopes: [] }
}

/**
 * Narrow a stored credential record to the payload this plugin understands.
 *
 * The credentials service is a shared registry: another plugin (or an older
 * version of this one) may have written a record of a different kind under the
 * same key. Anything that is not our `grant` shape is treated as "no token"
 * instead of surfacing a confusing parse error.
 * @param {any} record - record returned by `ctx.credentials.readRecord`.
 * @returns {{ revision: number, token: string, login: string, scopes: string[] }} the normalized payload.
 */
function normalizeRecord(record) {
  if (!record || record.kind !== 'grant' || typeof record.payload?.token !== 'string') return emptyRecord()
  const payload = record.payload
  return {
    revision: Number.isSafeInteger(payload.revision) ? payload.revision : 0,
    token: payload.token,
    login: typeof payload.login === 'string' ? payload.login : '',
    scopes: Array.isArray(payload.scopes) ? payload.scopes.filter((entry) => typeof entry === 'string') : [],
  }
}

/**
 * Read and write the stored personal access token.
 *
 * `recordKey` is passed in rather than imported so this module stays free of
 * DSH packages; `index.js` supplies `credentialKey('dsh-github-aide',
 * 'configuration')`.
 * @param {object} ctx - Cordis context providing `credentials`.
 * @param {string} recordKey - credential record key owned by this plugin.
 * @returns {{ read: Function, write: Function, clear: Function, describe: Function }} token store.
 * @throws {GitHubAideError} when the credential service or record key is missing.
 */
export function createTokenStore(ctx, recordKey) {
  /* Validate the caller's own argument first: a missing key is a programming
     error in this plugin, while a missing credential service is an environment
     problem, and reporting the environment problem for a missing argument sends
     the reader in the wrong direction. */
  if (typeof recordKey !== 'string' || recordKey.trim().length === 0) {
    throw new GitHubAideError(
      ERROR_CODES.BAD_REQUEST,
      'The token store needs the credential record key it owns.',
    )
  }
  if (!ctx || typeof ctx.credentials?.readRecord !== 'function') {
    throw new GitHubAideError(
      ERROR_CODES.NOT_CONFIGURED,
      'The DSH credential store is not available, so a GitHub token cannot be read or saved.',
      { nextStep: 'Run this inside DeepSeek Harness with the credentials service enabled.' },
    )
  }

  /**
   * Read the stored token record.
   * @returns {Promise<{ revision: number, token: string, login: string, scopes: string[] }>} the payload, or the empty record.
   */
  async function read() {
    return normalizeRecord(await ctx.credentials.readRecord(recordKey))
  }

  /**
   * Store a token, preserving the login/scopes of the record it replaces.
   *
   * The revision is bumped inside the modify callback so two concurrent writers
   * cannot leave the same revision stamped on different tokens.
   * @param {object} [input] - values to store.
   * @param {string} input.token - the personal access token.
   * @param {string} [input.login] - the login the token authenticated as.
   * @param {string[]} [input.scopes] - scopes the token reported.
   * @returns {Promise<{ revision: number, token: string, login: string, scopes: string[] }>} the stored payload.
   */
  async function write(input = {}) {
    if (typeof input.token !== 'string') {
      throw new GitHubAideError(ERROR_CODES.BAD_REQUEST, 'A GitHub token string is required to save credentials.')
    }
    let stored = emptyRecord()
    await ctx.credentials.modifyRecord(recordKey, (record) => {
      const before = normalizeRecord(record)
      stored = {
        revision: before.revision + 1,
        token: input.token,
        login: typeof input.login === 'string' ? input.login : before.login,
        scopes: Array.isArray(input.scopes)
          ? input.scopes.filter((entry) => typeof entry === 'string')
          : before.scopes,
      }
      return { kind: 'grant', payload: stored }
    })
    return stored
  }

  /**
   * Blank the stored token while keeping the record itself.
   *
   * Deleting the record would lose the `last written` facts the credentials
   * service reports; an empty payload is the same "not configured" state to
   * every caller here.
   * @returns {Promise<void>} resolves once the record is blanked.
   */
  async function clear() {
    await ctx.credentials.modifyRecord(recordKey, () => ({ kind: 'grant', payload: emptyRecord() }))
  }

  /**
   * Describe the record for a status/config surface.
   * @returns {Promise<{ configured: boolean, writable: boolean, login: string }>} record facts.
   */
  async function describe() {
    let stored = emptyRecord()
    try {
      stored = await read()
    } catch {
      return { configured: false, writable: false, login: '' }
    }
    let writable = true
    try {
      writable = (await ctx.credentials.describeRecord(recordKey)).writable === true
    } catch {
      writable = false
    }
    return { configured: stored.token.length > 0, writable, login: stored.login }
  }

  return { read, write, clear, describe }
}

/**
 * Read the first non-empty environment token.
 * @returns {{ token: string, source: string }|undefined} the environment token, when present.
 */
export function environmentToken() {
  for (const name of TOKEN_ENV_VARS) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim().length > 0) return { token: value.trim(), source: name }
  }
  return undefined
}

/**
 * Resolve the token this plugin should authenticate with.
 *
 * The environment wins: it is the only source that works on a machine where the
 * credential file does not exist (CI), and it is the explicit choice when a
 * user exports a token rather than storing one.
 * @param {{ read: () => Promise<{ token: string }> }} store - token store from {@link createTokenStore}.
 * @returns {Promise<{ token: string, source: string }|undefined>} the resolved token, or `undefined` when unconfigured.
 */
export async function resolveToken(store) {
  const fromEnvironment = environmentToken()
  if (fromEnvironment) return fromEnvironment
  const stored = await store.read()
  if (stored.token.length > 0) return { token: stored.token, source: 'credentials' }
  return undefined
}
