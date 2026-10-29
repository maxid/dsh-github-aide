/**
 * GitHub REST calls for the publish flow.
 *
 * This client is deliberately small and self-contained: four calls is all the
 * plugin needs (the viewer, the token scopes, a repository lookup, a repository
 * creation). It talks to the API over `fetch` — not over the harness
 * `connection` service, which is a route registry for the plugin's own HTTP
 * surface, not an outbound HTTP client.
 *
 * Two properties matter more than feature coverage:
 *
 * 1. The token is never observable. It appears only in the `authorization`
 *    header, never in a URL, and every message built here goes through
 *    {@link redact} with the token as an explicit secret, so a GitHub error that
 *    echoes a header cannot leak it into a transcript.
 * 2. `fetchImpl` is injectable. The test suite runs offline and must still see
 *    the exact request URL, method, headers, and body this client sends.
 */
import { ERROR_CODES, GitHubAideError, redact } from './errors.js'

/** The public GitHub REST API. Tests inject another base URL to prove it is honoured. */
export const DEFAULT_API_BASE_URL = 'https://api.github.com'

/** REST API version this client is written against (sent as a header). */
const API_VERSION = '2022-11-28'
/** Default user agent; the REST API rejects requests without one. */
const DEFAULT_USER_AGENT = 'dsh-github-aide'
/** Default per-request timeout: long enough for a slow create, short enough to surface a hang. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * An HTTP or transport failure from the GitHub API.
 *
 * A subclass (rather than a bare `GitHubAideError`) so callers can tell "GitHub
 * said no" from "the local git flow failed" without inspecting codes. `code`
 * and `status` are the two facts {@link describeError} and the tools report.
 */
export class GitHubApiError extends GitHubAideError {
  /**
   * @param {string} code - one of the `TOKEN_REJECTED`/`PERMISSION`/`NOT_FOUND`/`API_FAILED`/`TLS_UNTRUSTED` codes.
   * @param {string} message - one actionable sentence; must already be redacted.
   * @param {object} [options] - optional details.
   * @param {number} [options.status] - HTTP status, when there was a response.
   * @param {string} [options.nextStep] - what the user should do next.
   * @param {unknown} [options.cause] - the underlying transport failure.
   */
  constructor(code, message, options = {}) {
    super(code, message, options)
    this.name = 'GitHubApiError'
  }
}

/**
 * Build the header set for one call.
 * @param {string} token - GitHub personal access token, empty when unauthenticated.
 * @param {Record<string, string>} [extra] - additional or overriding headers.
 * @returns {Record<string, string>} request headers.
 */
function headersFor(token, extra) {
  return {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': DEFAULT_USER_AGENT,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  }
}

/**
 * Whether a transport failure looks like a TLS trust problem.
 *
 * This deserves its own code. Behind a TLS-inspecting proxy or a GitHub
 * accelerator, the interception certificate is trusted by the operating system
 * but not by Node's bundled CA list, so the connection fails before a request is
 * sent. Reporting "fetch failed" there sends the user hunting for a network
 * fault that does not exist.
 * @param {unknown} error - the thrown fetch error.
 * @returns {boolean} true when the cause points at certificate verification.
 */
function looksLikeTlsFailure(error) {
  const cause = error?.cause
  const code = String(cause?.code ?? error?.code ?? '')
  const text = `${cause?.message ?? ''} ${error?.message ?? ''}`
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|_SSL_|ERR_TLS/iu.test(code)
    || /certificate|self[- ]signed|unable to verify/iu.test(text)
}

/**
 * Whether a transport failure was the client refusing to follow a redirect.
 * @param {unknown} error - the thrown fetch error.
 * @returns {boolean} true when undici reported an unexpected redirect.
 */
function looksLikeRedirectFailure(error) {
  const cause = error?.cause
  const text = `${error?.message ?? ''} ${cause?.message ?? ''} ${cause?.code ?? ''}`
  return /redirect/iu.test(text)
}

/**
 * Read one response header whether the response exposes `Headers` or a plain map.
 * @param {any} headers - `response.headers`.
 * @param {string} name - lower-case header name.
 * @returns {string|null} the header value, or `null`.
 */
function readHeader(headers, name) {
  if (!headers) return null
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return value === null || value === undefined ? null : String(value)
  }
  const value = headers[name] ?? headers[name.toLowerCase()]
  return value === undefined || value === null ? null : String(value)
}

/**
 * Decode a response body as JSON, tolerating a bodyless response.
 *
 * The fake `fetchImpl` used by tests exposes `json()` only, while a real
 * `Response` exposes `text()`; supporting both keeps the client honest without
 * forcing test fakes to be `Response` instances.
 * @param {any} response - fetch response.
 * @returns {Promise<{ body: any, text: string, parsed: boolean }>} decoded body.
 */
async function decodeBody(response) {
  if (typeof response?.text === 'function') {
    const text = await response.text()
    if (text.length === 0) return { body: undefined, text: '', parsed: true }
    try {
      return { body: JSON.parse(text), text, parsed: true }
    } catch {
      return { body: undefined, text, parsed: false }
    }
  }
  if (typeof response?.json === 'function') {
    try {
      return { body: await response.json(), text: '', parsed: true }
    } catch {
      return { body: undefined, text: '', parsed: false }
    }
  }
  return { body: undefined, text: '', parsed: true }
}

/**
 * Build a GitHub API client bound to one token and base URL.
 *
 * Options are read once so a request cannot accidentally mix two tokens. The
 * token is closure state, never a property of the returned object, so a caller
 * that logs or serializes the client cannot leak it either.
 * @param {object} [options] - client options.
 * @param {string} [options.token] - GitHub personal access token; empty means unauthenticated.
 * @param {string} [options.baseUrl] - API base URL, default {@link DEFAULT_API_BASE_URL}.
 * @param {string} [options.userAgent] - user agent to send.
 * @param {number} [options.timeoutMs] - per-request timeout in milliseconds.
 * @param {typeof fetch} [options.fetchImpl] - injectable fetch for tests.
 * @returns {{ getViewer: Function, getTokenScopes: Function, findRepository: Function, createRepository: Function }} the client.
 * @throws {GitHubApiError} when `fetchImpl` is not callable.
 */
export function createGitHubApi(options = {}) {
  const token = typeof options.token === 'string' ? options.token : ''
  const baseUrlOption = typeof options.baseUrl === 'string' ? options.baseUrl.trim() : ''
  const baseUrl = (baseUrlOption.length > 0 ? baseUrlOption : DEFAULT_API_BASE_URL).replace(/\/+$/u, '')
  const userAgent = typeof options.userAgent === 'string' && options.userAgent.trim().length > 0
    ? options.userAgent.trim()
    : DEFAULT_USER_AGENT
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS
  if (options.fetchImpl !== undefined && typeof options.fetchImpl !== 'function') {
    throw new GitHubApiError(ERROR_CODES.BAD_REQUEST, 'The injected fetch implementation must be a function.')
  }
  const fetchImpl = options.fetchImpl

  /* Report the host, not the full URL: a misconfigured base URL may carry
     userinfo, and no error message may ever grow a credential. */
  let apiHost = 'the GitHub API'
  try {
    const parsed = new URL(baseUrl)
    apiHost = parsed.host || apiHost
  } catch {
    /* A non-URL base URL is the user's choice (a local proxy, a test stub);
       the fetch implementation will report the failure. */
  }

  /**
   * Perform one API call and decode its body.
   * @param {string} path - API path beginning with `/`.
   * @param {object} [init] - fetch options (`method`, `body`, `headers`).
   * @param {AbortSignal} [signal] - cancels the call.
   * @returns {Promise<{ status: number, body: any, headers: any }>} decoded response.
   * @throws {GitHubApiError} on transport failure, redirect, or any non-2xx status.
   */
  async function call(path, init = {}, signal) {
    const doFetch = fetchImpl ?? globalThis.fetch
    if (typeof doFetch !== 'function') {
      throw new GitHubApiError(
        ERROR_CODES.API_FAILED,
        'No fetch implementation is available, so the GitHub API cannot be reached.',
        { nextStep: 'Run this on Node 22 or later, where global fetch exists.' },
      )
    }

    /* The per-request timeout is separate from the tool timeout on purpose: a
       tool may retry and still fit its budget, while one hung socket must not
       consume the whole call. The timer is a real (ref'd) `setTimeout` rather
       than `AbortSignal.timeout`: on Node 22 the built-in timer is unref'd, so
       a pending request could let the process exit before the timeout fires. */
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new DOMException('The operation timed out', 'TimeoutError'))
    }, timeoutMs)
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal

    try {
      let response
      try {
        response = await doFetch(`${baseUrl}${path}`, {
          ...init,
          /* Redirects are refused rather than followed: the Authorization header
             must not be replayed to whatever host a compromised proxy names. */
          redirect: 'error',
          headers: { ...headersFor(token, init.headers), 'user-agent': userAgent },
          signal: combined,
        })
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted()
        if (looksLikeTlsFailure(error)) {
          throw new GitHubApiError(
            ERROR_CODES.TLS_UNTRUSTED,
            `The TLS certificate presented for ${apiHost} is not trusted by the runtime, so the connection was refused before any request was sent.`,
            {
              nextStep: 'A TLS-inspecting proxy or a GitHub accelerator is intercepting the connection. Point NODE_EXTRA_CA_CERTS at its root certificate in PEM form and restart DSH.',
              cause: error,
            },
          )
        }
        if (looksLikeRedirectFailure(error)) {
          throw new GitHubApiError(
            ERROR_CODES.API_FAILED,
            `${apiHost} answered with a redirect, which this client refuses to follow.`,
            { nextStep: 'Check the configured API base URL; it should reach the GitHub API directly.', cause: error },
          )
        }
        const reason = error?.name === 'TimeoutError'
          ? 'the request timed out'
          : redact(error?.message ?? 'unknown error', [token])
        throw new GitHubApiError(
          ERROR_CODES.API_FAILED,
          `Could not reach ${apiHost}: ${reason}`,
          { nextStep: 'Check the network connection or proxy, then retry.', cause: error },
        )
      }

      if (!response || typeof response.status !== 'number') {
        throw new GitHubApiError(ERROR_CODES.API_FAILED, `${apiHost} returned an unreadable response.`)
      }

      /* undici reports a 3xx as a rejection because of `redirect: 'error'`, but a
         fake fetch may simply return the response; both paths must refuse it. */
      if (response.status >= 300 && response.status < 400) {
        throw new GitHubApiError(
          ERROR_CODES.API_FAILED,
          `${apiHost} answered with a redirect (HTTP ${response.status}), which this client refuses to follow.`,
          { status: response.status, nextStep: 'Check the configured API base URL; it should reach the GitHub API directly.' },
        )
      }

      const { body, text, parsed } = await decodeBody(response)
      if (!response.ok) {
        const detail = parsed && body && typeof body.message === 'string'
          ? redact(body.message, [token])
          : redact(text, [token]).slice(0, 300)
        /* GitHub names the exact permission a rejected call needed. For a
           fine-grained token this header is the only actionable answer available,
           since such tokens report no OAuth scope list. Surface it verbatim. */
        const permissionHint = readHeader(response.headers, 'x-accepted-github-permissions')
        const scopeHint = readHeader(response.headers, 'x-accepted-oauth-scopes')
        let code
        let nextStep
        if (response.status === 401) {
          code = ERROR_CODES.TOKEN_REJECTED
          nextStep = 'Save a new personal access token with the "repo" scope, or set GITHUB_TOKEN.'
        } else if (response.status === 403) {
          code = ERROR_CODES.PERMISSION
          nextStep = permissionHint
            ? `The token needs these permissions: ${permissionHint}.`
            : scopeHint
              ? `The token needs these scopes: ${scopeHint}.`
              : 'Check the token permissions and your access to the account.'
        } else if (response.status === 404) {
          code = ERROR_CODES.NOT_FOUND
          nextStep = 'Check the repository owner and name, and that the token can see them.'
        } else {
          code = ERROR_CODES.API_FAILED
          nextStep = 'Retry the call; if it keeps failing, check the token and GitHub status.'
        }
        throw new GitHubApiError(
          code,
          `GitHub rejected the request (HTTP ${response.status}): ${detail}`,
          { status: response.status, nextStep },
        )
      }

      return { status: response.status, body, headers: response.headers }
    } finally {
      /* A finished request must not leave a timer behind keeping the loop alive. */
      clearTimeout(timer)
    }
  }

  /**
   * Read the authenticated user behind the token.
   * @param {AbortSignal} [signal] - cancels the call.
   * @returns {Promise<{ login: string, id: number }>} the viewer.
   * @throws {GitHubApiError} when GitHub rejects the token.
   */
  async function getViewer(signal) {
    const { body } = await call('/user', {}, signal)
    if (!body || typeof body.login !== 'string' || body.login.length === 0) {
      throw new GitHubApiError(ERROR_CODES.API_FAILED, 'GitHub returned an unexpected user payload for this token.')
    }
    return { login: body.login, id: typeof body.id === 'number' ? body.id : 0 }
  }

  /**
   * Read the OAuth scopes a classic token carries.
   *
   * Fine-grained tokens report no `x-oauth-scopes` header, so an empty list
   * means "not a classic token", not "no permissions" — hence `classic`.
   * @param {AbortSignal} [signal] - cancels the call.
   * @returns {Promise<{ scopes: string[], classic: boolean }>} scope facts.
   * @throws {GitHubApiError} when GitHub rejects the token.
   */
  async function getTokenScopes(signal) {
    const { headers } = await call('/user', {}, signal)
    const raw = readHeader(headers, 'x-oauth-scopes')
    if (raw === null) return { scopes: [], classic: false }
    return { scopes: raw.split(',').map((entry) => entry.trim()).filter(Boolean), classic: true }
  }

  /**
   * Look up one repository.
   *
   * A missing repository is a normal answer to the publish flow, so 404 is
   * returned as data rather than thrown.
   * @param {string} owner - repository owner login.
   * @param {string} repo - repository name.
   * @param {AbortSignal} [signal] - cancels the call.
   * @returns {Promise<{ exists: boolean, repository: object|null }>} lookup result.
   * @throws {GitHubApiError} on any failure that is not "not found".
   */
  async function findRepository(owner, repo, signal) {
    try {
      const { body } = await call(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {},
        signal,
      )
      return { exists: true, repository: body }
    } catch (error) {
      if (error instanceof GitHubAideError && error.status === 404) return { exists: false, repository: null }
      throw error
    }
  }

  /**
   * Create a repository for the authenticated user.
   * @param {object} spec - repository specification.
   * @param {string} spec.name - repository name.
   * @param {string} [spec.description] - optional description.
   * @param {'private'|'public'|'internal'} [spec.visibility] - repository visibility, default `private`.
   * @param {boolean} [spec.autoInit] - whether GitHub should create an initial commit.
   * @param {AbortSignal} [signal] - cancels the call.
   * @returns {Promise<object>} the created repository JSON.
   * @throws {GitHubApiError} when the name is missing or GitHub refuses creation.
   */
  async function createRepository(spec = {}, signal) {
    const name = typeof spec.name === 'string' ? spec.name.trim() : ''
    if (name.length === 0) {
      throw new GitHubApiError(ERROR_CODES.BAD_REQUEST, 'A repository name is required to create a GitHub repository.')
    }
    const visibility = spec.visibility === 'public' || spec.visibility === 'internal' ? spec.visibility : 'private'
    const payload = {
      name,
      /* `private` is the field a personal account honours; `visibility` is sent
         as well so an organization can be given `internal`. */
      private: visibility !== 'public',
      auto_init: spec.autoInit === true,
    }
    if (visibility === 'internal') payload.visibility = 'internal'
    if (typeof spec.description === 'string' && spec.description.trim().length > 0) {
      payload.description = spec.description.trim()
    }
    const { body } = await call('/user/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, signal)
    return body
  }

  return { getViewer, getTokenScopes, findRepository, createRepository }
}
