/**
 * Optional HTTP probe against a running DeepSeek Harness host.
 *
 * The plugin's four routes are exercised over the loopback interface: status,
 * preflight, a read-only dry-run publish, and the token-config guard. Nothing is
 * written and no token is required.
 *
 * The probe is opt-in. With no base URL it prints a SKIP line and exits 0, so it
 * is safe to run in CI. A base URL can be passed as the first argument or via
 * `DSH_GITHUB_AIDE_URL` / `DSH_WEB_URL`:
 *
 *   node scripts/http-check.mjs http://127.0.0.1:62591 /path/to/project
 *
 * Exit codes: 0 = skipped / all checks passed; 1 = a protocol check failed.
 */

const PREFIX = '/plugins/dsh-github-aide'
const base = (process.argv[2] ?? process.env.DSH_GITHUB_AIDE_URL ?? process.env.DSH_WEB_URL ?? '')
  .trim()
  .replace(/\/+$/, '')
const projectPath = process.argv[3] ?? process.env.DSH_GITHUB_AIDE_PROJECT ?? process.cwd()

if (base.length === 0) {
  console.log('SKIPPED: no host URL (pass one as argv[2], or set DSH_GITHUB_AIDE_URL / DSH_WEB_URL).')
  process.exit(0)
}

let passed = 0
const failures = []

/** Record one check. */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Fetch with a short deadline; throws when the host is unreachable. */
async function request(pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  return { status: response.status, headers: response.headers, body, text }
}

console.log(`\ndsh-github-aide HTTP check against ${base}\n`)

let status
try {
  status = await request(`${PREFIX}/status`)
} catch (error) {
  console.log(`SKIPPED: ${base} is not reachable (${error?.cause?.code ?? error?.message ?? error}).`)
  process.exit(0)
}

if (status.status === 404) {
  console.log(`SKIPPED: the host is running but does not mount ${PREFIX}/* (plugin not loaded).`)
  process.exit(0)
}

console.log('status')

check('GET /status returns HTTP 200', status.status === 200, `HTTP ${status.status}`)
check('GET /status is JSON', status.body !== undefined, status.text.slice(0, 160))
check('GET /status declares the plugin', status.body?.result?.plugin === 'dsh-github-aide',
  JSON.stringify(status.body?.result?.plugin))
check('GET /status reports the token state', typeof status.body?.result?.token === 'object')
check('GET /status reports the resolved defaults', typeof status.body?.result?.defaults === 'object')
check('GET /status is not cached', /no-store/i.test(status.headers.get('cache-control') ?? ''),
  status.headers.get('cache-control') ?? '(no cache-control)')

console.log('\nmethod guard')
try {
  const wrongMethod = await request(`${PREFIX}/publish`)
  check('GET /publish is rejected with HTTP 405', wrongMethod.status === 405, `HTTP ${wrongMethod.status}`)
} catch (error) {
  check('GET /publish is rejected with HTTP 405', false, String(error?.message ?? error))
}

console.log('\npreflight')

try {
  const preflight = await request(`${PREFIX}/preflight`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projectPath }),
  })
  check('POST /preflight returns HTTP 200', preflight.status === 200, `HTTP ${preflight.status}`)
  check('POST /preflight returns a result object', typeof preflight.body?.result === 'object',
    JSON.stringify(preflight.body).slice(0, 160))
  const result = preflight.body?.result ?? {}
  check('preflight names the project root', result.root === undefined || typeof result.root === 'string')
  check('preflight carries the git facts', typeof result.git === 'object')
  check('preflight carries the project scan', Array.isArray(result.project?.sensitive))
  console.log(`       repo=${result.repo ?? '?'} owner=${result.owner ?? '?'} files=${result.project?.files ?? '?'} code=${result.code ?? '?'}`)
} catch (error) {
  check('POST /preflight returns HTTP 200', false, String(error?.message ?? error))
}

console.log('\ndry-run publish (read-only)')

try {
  const dry = await request(`${PREFIX}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projectPath, repo: 'probe-demo', dryRun: true }),
  })
  check('POST /publish {dryRun:true} returns HTTP 200', dry.status === 200, `HTTP ${dry.status}`)
  check('the dry run reports dry_run and no push', dry.body?.result?.dry_run === true && dry.body?.result?.pushed === false,
    JSON.stringify(dry.body?.result?.code ?? dry.body))
} catch (error) {
  check('POST /publish {dryRun:true} returns HTTP 200', false, String(error?.message ?? error))
}

console.log('\nconfig guard (no token)')

try {
  const config = await request(`${PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  check('POST /config {} returns HTTP 200 without storing a token', config.status === 200, `HTTP ${config.status}`)
  check('the config guard returns a structured outcome', typeof config.body === 'object' && config.body !== null,
    config.text.slice(0, 160))
  check('the config guard never echoes a token', !JSON.stringify(config.body).includes('ghp_'))
} catch (error) {
  check('POST /config {} returns HTTP 200 without storing a token', false, String(error?.message ?? error))
}

console.log(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exitCode = 1
