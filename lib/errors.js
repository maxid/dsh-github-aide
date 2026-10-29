/**
 * One error type and one redactor for every failure this plugin reports.
 *
 * The harness turns a thrown value into a tool failure, so `code` is the
 * machine-readable half and `message` is the sentence the model reads. A single
 * type means the tool wrapper never guesses how to describe an unexpected
 * failure, and a single redactor means no path can leak a token: git quotes the
 * remote URL back in its stderr, GitHub echoes request headers in some errors,
 * and both must pass through {@link redact} before they reach a log or a result.
 */

/** Stable, machine-readable outcome codes used across lib modules and tools. */
export const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  TOKEN_REJECTED: 'TOKEN_REJECTED',
  PERMISSION: 'PERMISSION',
  NOT_FOUND: 'NOT_FOUND',
  API_FAILED: 'API_FAILED',
  TLS_UNTRUSTED: 'TLS_UNTRUSTED',
  GIT_MISSING: 'GIT_MISSING',
  GIT_FAILED: 'GIT_FAILED',
  NOT_A_DIRECTORY: 'NOT_A_DIRECTORY',
  NOT_A_REPO: 'NOT_A_REPO',
  NO_FILES: 'NO_FILES',
  NO_CHANGES: 'NO_CHANGES',
  SENSITIVE_BLOCKED: 'SENSITIVE_BLOCKED',
  REBASE_CONFLICT: 'REBASE_CONFLICT',
  PUSH_REJECTED: 'PUSH_REJECTED',
  BAD_REQUEST: 'BAD_REQUEST',
  NO_WORKSPACE: 'NO_WORKSPACE',
  FAILED: 'FAILED',
})

/**
 * The one error type every lib module throws.
 */
export class GitHubAideError extends Error {
  /**
   * @param {string} code - stable SCREAMING_CASE identifier for this failure.
   * @param {string} message - one actionable sentence for the model.
   * @param {object} [options] - optional narrowing details.
   * @param {number} [options.status] - HTTP status when a GitHub call caused it.
   * @param {string} [options.nextStep] - what the user should do next.
   * @param {unknown} [options.cause] - the underlying failure, when there is one.
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GitHubAideError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.nextStep !== undefined) this.nextStep = options.nextStep
  }
}

/**
 * Reduce any thrown value to a `{ code, message, nextStep }` triple.
 *
 * Unknown values are reported as a generic failure rather than leaking a stack
 * trace into the transcript.
 * @param {unknown} error - whatever was thrown.
 * @returns {{ code: string, message: string, nextStep: string }} safe description.
 */
export function describeError(error) {
  if (error instanceof GitHubAideError) {
    return { code: error.code, message: error.message, nextStep: error.nextStep ?? '' }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: ERROR_CODES.FAILED, message: redact(message), nextStep: '' }
}

/* Any `scheme://user:secret@host` pair is a credential, whatever the token
   shape: git quotes the configured remote URL back in its stderr, and a
   password that does not look like a PAT would otherwise survive redaction.
   This rule runs first so it wins over the narrower agent-user patterns. */
const USERINFO = /(https?:\/\/)([^/@\s:]+:[^/@\s]+)@/g
const TOKEN_IN_URL = /(x-access-token|oauth2|git):[^@\s/]+@/gi
const CLASSIC_PAT = /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g
const FINE_GRAINED_PAT = /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g
const BEARER = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi

/**
 * Remove credential material from text that may reach a log or the transcript.
 *
 * Every token shape this plugin can see is masked, plus explicit secrets the
 * caller knows about (the in-memory token) so even an unknown format cannot
 * leak.
 * @param {unknown} value - text to scrub.
 * @param {Array<string|undefined>} [secrets] - exact secret values to mask.
 * @returns {string} the same text with credentials masked.
 */
export function redact(value, secrets = []) {
  let text = String(value ?? '')
    .replace(USERINFO, '$1[REDACTED]@')
    .replace(TOKEN_IN_URL, '$1:[REDACTED]@')
    .replace(CLASSIC_PAT, '[REDACTED]')
    .replace(FINE_GRAINED_PAT, '[REDACTED]')
    .replace(BEARER, '$1[REDACTED]')
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      text = text.split(secret).join('[REDACTED]')
    }
  }
  return text
}
