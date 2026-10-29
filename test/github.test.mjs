/**
 * GitHub REST client tests against a fake `fetchImpl`.
 *
 * Nothing here opens a socket: every request is served by an in-process stub, so
 * the suite proves the URL, headers, body mapping, and error translation without
 * a token or network access.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { redact } from '../lib/errors.js'
import {
  DEFAULT_API_BASE_URL,
  GitHubApiError,
  createGitHubApi,
} from '../lib/github.js'
import { GitHubAideError } from '../lib/errors.js'

const TOKEN = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Build a JSON Response the client will decode. */
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * A fake fetch that records every call and delegates to `handler`.
 * @param {(url: URL, init: object, call: number) => Response|Promise<Response>} handler
 */
function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(new URL(String(url)), init, calls.length)
  }
  return { impl, calls }
}

/** The sensible default stub used by most tests. */
function githubStub(overrides = {}) {
  return fakeFetch((url, init) => {
    if (overrides[url.pathname]) return overrides[url.pathname](url, init)
    if (url.pathname === '/user') {
      return jsonResponse({ login: 'octocat', id: 583231, name: 'The Octocat' })
    }
    return jsonResponse({ message: `unexpected ${init.method ?? 'GET'} ${url.pathname}` }, 500)
  })
}

/** The error a rejected promise carried, for assertions on its shape. */
async function rejection(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected the call to reject')
}

// ------------------------------------------------------------------ constants

test('the default API base URL is GitHub dot com', () => {
  assert.equal(DEFAULT_API_BASE_URL, 'https://api.github.com')
})

// -------------------------------------------------------------------- viewers

test('getViewer sends the documented headers and returns login plus id', async () => {
  const stub = githubStub()
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const viewer = await api.getViewer()
  assert.deepEqual(viewer, { login: 'octocat', id: 583231 })

  assert.equal(stub.calls.length, 1)
  const [{ url, init }] = stub.calls
  assert.equal(url, 'https://api.github.com/user')
  assert.equal(init.headers.accept, 'application/vnd.github+json')
  assert.equal(init.headers['x-github-api-version'], '2022-11-28')
  assert.equal(init.headers['user-agent'], 'dsh-github-aide')
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`)
})

test('a missing token produces no Authorization header', async () => {
  const stub = githubStub()
  const api = createGitHubApi({ token: '', fetchImpl: stub.impl })
  await api.getViewer()
  assert.equal(stub.calls[0].init.headers.authorization, undefined)
})

test('the user agent can be overridden', async () => {
  const stub = githubStub()
  const api = createGitHubApi({ token: TOKEN, userAgent: 'probe/1.0', fetchImpl: stub.impl })
  await api.getViewer()
  assert.equal(stub.calls[0].init.headers['user-agent'], 'probe/1.0')
})

test('a custom base URL is honoured and trailing slashes are stripped', async () => {
  const stub = fakeFetch(() => jsonResponse({ login: 'octocat', id: 1 }))
  const api = createGitHubApi({
    token: TOKEN,
    baseUrl: 'https://ghe.example/api/v3/',
    fetchImpl: stub.impl,
  })
  await api.getViewer()
  assert.equal(stub.calls[0].url, 'https://ghe.example/api/v3/user')
})

test('redirects are refused, not followed', async () => {
  const stub = fakeFetch(() => new Response('', {
    status: 302,
    headers: { location: 'https://evil.example/steal', 'content-type': 'application/json' },
  }))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const error = await rejection(api.getViewer())
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].init.redirect, 'error')
  assert.equal(error.code, 'API_FAILED')
  assert.match(error.message, /redirect/i)
})

// --------------------------------------------------------------------- scopes

test('getTokenScopes decodes a classic token scope list', async () => {
  const stub = fakeFetch(() => jsonResponse(
    { login: 'octocat', id: 1 },
    200,
    { 'x-oauth-scopes': 'repo, read:user,workflow' },
  ))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  assert.deepEqual(await api.getTokenScopes(), {
    scopes: ['repo', 'read:user', 'workflow'],
    classic: true,
  })
})

test('getTokenScopes marks a fine-grained token as non-classic', async () => {
  const stub = fakeFetch(() => jsonResponse({ login: 'octocat', id: 1 }))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  assert.deepEqual(await api.getTokenScopes(), { scopes: [], classic: false })
})

// ---------------------------------------------------------------- repositories

test('findRepository reports an existing repository', async () => {
  const repository = {
    name: 'demo',
    full_name: 'octocat/demo',
    html_url: 'https://github.com/octocat/demo',
    clone_url: 'https://github.com/octocat/demo.git',
    private: true,
  }
  const stub = fakeFetch(() => jsonResponse(repository))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const found = await api.findRepository('octocat', 'demo')
  assert.equal(found.exists, true)
  assert.deepEqual(found.repository, repository)
  assert.equal(stub.calls[0].url, 'https://api.github.com/repos/octocat/demo')
})

test('findRepository encodes owner and repo path segments', async () => {
  const stub = fakeFetch(() => jsonResponse({}))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  await api.findRepository('odd owner', 'a/b')
  assert.equal(stub.calls[0].url, 'https://api.github.com/repos/odd%20owner/a%2Fb')
})

test('findRepository reports null for an absent repository', async () => {
  const stub = fakeFetch(() => jsonResponse({ message: 'Not Found' }, 404))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  assert.deepEqual(await api.findRepository('octocat', 'missing'), {
    exists: false,
    repository: null,
  })
})

test('createRepository sends the documented private/public body', async () => {
  const created = { name: 'demo', html_url: 'https://github.com/octocat/demo' }
  const stub = fakeFetch(() => jsonResponse(created, 201))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const repository = await api.createRepository({
    name: 'demo',
    description: 'A demo',
    visibility: 'private',
    autoInit: false,
  })
  assert.deepEqual(repository, created)

  const [{ url, init }] = stub.calls
  assert.equal(url, 'https://api.github.com/user/repos')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['content-type'], 'application/json')
  const body = JSON.parse(init.body)
  assert.deepEqual(body, { name: 'demo', private: true, auto_init: false, description: 'A demo' })
})

test('createRepository maps public and internal visibility correctly', async () => {
  const publicStub = fakeFetch(() => jsonResponse({ name: 'demo' }, 201))
  await createGitHubApi({ token: TOKEN, fetchImpl: publicStub.impl }).createRepository({
    name: 'demo',
    visibility: 'public',
    autoInit: true,
  })
  assert.deepEqual(JSON.parse(publicStub.calls[0].init.body), {
    name: 'demo',
    private: false,
    auto_init: true,
  })

  const internalStub = fakeFetch(() => jsonResponse({ name: 'demo' }, 201))
  await createGitHubApi({ token: TOKEN, fetchImpl: internalStub.impl }).createRepository({
    name: 'demo',
    visibility: 'internal',
    autoInit: false,
  })
  assert.deepEqual(JSON.parse(internalStub.calls[0].init.body), {
    name: 'demo',
    private: true,
    auto_init: false,
    visibility: 'internal',
  })
})

// ------------------------------------------------------------------ HTTP errors

test('a 401 becomes TOKEN_REJECTED without echoing the token', async () => {
  const stub = fakeFetch(() => jsonResponse(
    { message: `Bad credentials for ${TOKEN}` },
    401,
    { 'x-oauth-scopes': 'repo' },
  ))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const error = await rejection(api.getViewer())
  assert.ok(error instanceof GitHubApiError)
  assert.ok(error instanceof GitHubAideError)
  assert.equal(error.code, 'TOKEN_REJECTED')
  assert.equal(error.status, 401)
  assert.ok(!error.message.includes(TOKEN), 'the token must never be echoed')
  assert.ok(!redact(error.message).includes(TOKEN))
})

test('a 403 becomes PERMISSION and surfaces the accepted permissions header', async () => {
  const permissions = 'administration=write; repository_creation=write'
  const stub = fakeFetch(() => jsonResponse(
    { message: 'Resource not accessible by personal access token' },
    403,
    { 'x-accepted-github-permissions': permissions },
  ))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const error = await rejection(api.createRepository({ name: 'demo', visibility: 'private' }))
  assert.equal(error.code, 'PERMISSION')
  assert.equal(error.status, 403)
  assert.match(error.nextStep, /administration=write/)
  assert.match(error.nextStep, /repository_creation=write/)
})

test('a 404 on a mutating call becomes NOT_FOUND', async () => {
  const stub = fakeFetch(() => jsonResponse({ message: 'Not Found' }, 404))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const error = await rejection(api.createRepository({ name: 'demo', visibility: 'private' }))
  assert.equal(error.code, 'NOT_FOUND')
  assert.equal(error.status, 404)
})

test('any other HTTP failure becomes API_FAILED with the status attached', async () => {
  const stub = fakeFetch(() => jsonResponse({ message: 'boom' }, 500))
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const error = await rejection(api.getViewer())
  assert.equal(error.code, 'API_FAILED')
  assert.equal(error.status, 500)
})

test('a redirect-shaped transport failure is not reported as a TLS problem', async () => {
  const stub = fakeFetch(() => {
    const failure = new TypeError('fetch failed')
    failure.cause = new Error('redirect count exceeded')
    throw failure
  })
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const error = await rejection(api.getViewer())
  assert.equal(error.code, 'API_FAILED')
})

// --------------------------------------------------------------------- TLS

test('a certificate-verification failure becomes TLS_UNTRUSTED', async () => {
  const stub = fakeFetch(() => {
    const failure = new TypeError('fetch failed')
    failure.cause = Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    })
    throw failure
  })
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const error = await rejection(api.getViewer())
  assert.equal(error.code, 'TLS_UNTRUSTED')
  assert.match(error.nextStep, /NODE_EXTRA_CA_CERTS/)
})

// ----------------------------------------------------------------- timing/abort

test('the client refuses a non-function fetchImpl at creation', () => {
  assert.throws(
    () => createGitHubApi({ token: TOKEN, fetchImpl: 'not a function' }),
    error => error.code === 'BAD_REQUEST',
  )
})

test('a caller abort is rethrown instead of being mapped to an API error', async () => {
  const controller = new AbortController()
  controller.abort()
  const stub = fakeFetch((_url, init) => {
    if (init.signal?.aborted) throw init.signal.reason
    return jsonResponse({ login: 'octocat', id: 1 })
  })
  const api = createGitHubApi({ token: TOKEN, fetchImpl: stub.impl })
  const error = await rejection(api.getViewer(controller.signal))
  assert.equal(error.name, 'AbortError')
})

test('a request timeout is reported as API_FAILED, not an unhandled rejection', async () => {
  const stub = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }, { once: true })
  }))
  const api = createGitHubApi({ token: TOKEN, timeoutMs: 25, fetchImpl: stub.impl })
  const error = await rejection(api.getViewer())
  assert.equal(error.code, 'API_FAILED')
})
