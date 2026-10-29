/**
 * Apply-harness: run the real `index.js` `apply()` against a fake Cordis context
 * and fake `@deepseek-ai/*` adapters.
 *
 * The repository ships without harness packages installed (they are peer
 * dependencies), so importing `index.js` directly would fail with
 * ERR_MODULE_NOT_FOUND. To exercise the actual wiring instead of a copy of it,
 * this script copies the plugin's host files into a temp directory and creates
 * minimal stand-in packages there: `schemastery` (chainable schema builder),
 * `dsh-tools` (`defineTool`), and `dsh-credentials` (`credentialKey`). The
 * `apply()` body itself is never reimplemented here.
 *
 * It then asserts the harness contract:
 *   - one settings namespace registration (`github-aide`, applies: 'live'),
 *   - three tools (`github_publish`, `github_status`, `github_configure`),
 *   - four `webServer` routes under `/plugins/dsh-github-aide/`,
 *   - effect-scoped disposers that unregister every route,
 *   - graceful degradation when `webServer` or `settings` is absent.
 *
 * Usage: node scripts/apply-harness.mjs
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

let failures = 0
let checks = 0

/** Report one assertion without aborting the run. */
function check(label, body) {
  checks += 1
  try {
    body()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}`)
    console.log(`       ${error?.message ?? error}`)
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'dsh-gh-aide-harness-'))

/**
 * Write the stand-in packages the plugin imports from the harness.
 * @param {string} appDir - temp copy of the plugin.
 */
async function writeHarnessStubs(appDir) {
  const packages = {
    '@deepseek-ai/schemastery': `
/** Minimal chainable schema builder: only the surface index.js uses. */
function schema(kind) {
  const state = { kind, defaultValue: undefined, description: '' }
  const node = {
    kind,
    default(value) { state.defaultValue = value; return node },
    description(text) { state.description = text; return node },
  }
  return node
}
const z = {
  string: () => schema('string'),
  boolean: () => schema('boolean'),
  number: () => schema('number'),
  any: () => schema('any'),
  const: (value) => {
    const node = schema('const')
    node.value = value
    return node
  },
  enum: (values) => {
    const node = schema('enum')
    node.values = values
    return node
  },
  union: (options) => {
    const node = schema('union')
    node.options = options
    return node
  },
  object: (shape) => {
    const node = schema('object')
    node.shape = shape
    return node
  },
  resolve: (value) => value,
}
export default z
export { z }
`,
    '@deepseek-ai/dsh-tools': `
/** defineTool is an identity adapter in the real package as far as this wiring is concerned. */
export function defineTool(definition) {
  if (definition === null || typeof definition !== 'object') {
    throw new TypeError('defineTool expects a tool definition object')
  }
  return definition
}
`,
    '@deepseek-ai/dsh-credentials': `
/** Stable credential-record key, same shape the harness uses. */
export function credentialKey(owner, id) {
  return owner + ':' + id
}
`,
  }
  for (const [name, source] of Object.entries(packages)) {
    const dir = join(appDir, 'node_modules', ...name.split('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.0.0-test',
      type: 'module',
      main: './index.js',
      exports: { '.': './index.js' },
    }), 'utf8')
    await writeFile(join(dir, 'index.js'), source, 'utf8')
  }
}

/**
 * Copy the host half of the plugin into a directory with stubs resolvable.
 * @returns {Promise<{ appDir: string, mode: string }>} the importable copy.
 */
async function prepareApp() {
  const appDir = join(scratch, 'app')
  await mkdir(appDir, { recursive: true })
  await cp(join(repoRoot, 'lib'), join(appDir, 'lib'), { recursive: true })
  await cp(join(repoRoot, 'index.js'), join(appDir, 'index.js'))
  await cp(join(repoRoot, 'package.json'), join(appDir, 'package.json'))
  await cp(join(repoRoot, 'client.js'), join(appDir, 'client.js'))
  await writeHarnessStubs(appDir)
  return { appDir, mode: 'temp copy with stubbed @deepseek-ai adapters' }
}

/**
 * Build a fake Cordis context instrumented with every registration the plugin makes.
 * @param {{ withWebServer?: boolean, withSettings?: boolean }} [options]
 */
function fakeContext(options = {}) {
  const withWebServer = options.withWebServer !== false
  const withSettings = options.withSettings !== false
  const log = []
  const settings = []
  const tools = []
  const routes = []
  const effects = []
  const disposers = []
  const services = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {
          definition.disposed = true
        }
      },
    },
    credentials: {
      records: new Map(),
      async readRecord(key) {
        return this.records.get(key)
      },
      async modifyRecord(key, mutate) {
        const next = await mutate(this.records.get(key))
        if (next === undefined) this.records.delete(key)
        else this.records.set(key, next)
        return next
      },
      async describeRecord() {
        return { configured: false, writable: true }
      },
      async deleteRecord(key) {
        this.records.delete(key)
      },
    },
  }
  if (withSettings) {
    services.settings = {
      register(namespace, schema, opts) {
        if (settings.some(entry => entry.namespace === namespace)) {
          throw new Error(`settings namespace "${namespace}" is already registered`)
        }
        settings.push({ namespace, schema, opts })
        return {
          get: () => ({}),
          update: async () => {},
          replace: async () => {},
          watch: () => () => {},
        }
      },
    }
  }
  if (withWebServer) {
    services.webServer = {
      register(route) {
        const entry = { ...route, disposed: false }
        routes.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    }
  }
  const ctx = {
    // Real Cordis exposes injected services as own properties on the context.
    tools: services.tools,
    credentials: services.credentials,
    ...(services.settings === undefined ? {} : { settings: services.settings }),
    ...(services.webServer === undefined ? {} : { webServer: services.webServer }),
    logger: {
      info(...args) { log.push(['info', args]) },
      warn(...args) { log.push(['warn', args]) },
      error(...args) { log.push(['error', args]) },
    },
    get(name) {
      return services[name]
    },
    on() {
      return () => {}
    },
    effect(fn, label) {
      effects.push(label)
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push({ label, disposer })
      return disposer
    },
  }
  return { ctx, settings, tools, routes, effects, disposers, log, services }
}

/** A tiny project directory for tool-execution smoke checks. */
async function makeSampleProject() {
  const dir = join(scratch, 'sample')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), '{"name":"sample"}\n', 'utf8')
  await writeFile(join(dir, 'index.js'), 'export const answer = 42\n', 'utf8')
  return dir
}

console.log('\ndsh-github-aide apply-harness\n')

let mod
try {
  const { appDir, mode } = await prepareApp()
  mod = await import(new URL(`file://${join(appDir, 'index.js')}`).href)
  console.log(`loaded      : index.js (${mode})`)
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.log('SKIPPED: index.js could not be imported and DSH packages are not installed.')
    console.log(`         ${error.message}`)
    await rm(scratch, { recursive: true, force: true })
    process.exit(0)
  }
  console.error('index.js failed to load:')
  console.error(error)
  await rm(scratch, { recursive: true, force: true })
  process.exit(1)
}

console.log(`plugin name : ${mod.name}`)
console.log(`inject      : ${JSON.stringify(mod.inject)}`)
console.log(`Config is   : ${typeof mod.Config}`)

// ---------------------------------------------------------------- full wiring

const wired = fakeContext()
let applyError
try {
  await mod.apply(wired.ctx, {})
} catch (error) {
  applyError = error
}

check('apply() completes without throwing', () => {
  if (applyError !== undefined) throw applyError
})

check('apply() registers exactly one settings namespace', () => {
  if (wired.settings.length !== 1) {
    throw new Error(`expected 1 settings registration, got ${wired.settings.length}`)
  }
  const [entry] = wired.settings
  if (entry.namespace !== 'github-aide') throw new Error(`unexpected namespace: ${entry.namespace}`)
  if (entry.schema === undefined) throw new Error('the settings registration carries no schema')
  if (entry.opts?.applies !== 'live') throw new Error(`expected applies:'live', got ${entry.opts?.applies}`)
  if (entry.opts?.applies === 'restart') throw new Error('the namespace must not require a restart')
})

check('apply() registers the three documented tools', () => {
  if (wired.tools.length !== 3) throw new Error(`expected 3 tools, got ${wired.tools.length}`)
  const names = wired.tools.map(tool => tool.name).sort()
  const expected = ['github_configure', 'github_publish', 'github_status']
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected tool names: ${JSON.stringify(names)}`)
  }
  for (const tool of wired.tools) {
    if (typeof tool.execute !== 'function') throw new Error(`${tool.name} has no execute()`)
    if (tool.parameters === null || typeof tool.parameters !== 'object') {
      throw new Error(`${tool.name} has no parameters object`)
    }
    if (tool.output?.schema?.type !== 'object') throw new Error(`${tool.name} has no output object schema`)
    if (tool.name === 'github_publish' && tool.isConcurrencySafe?.() !== false) {
      throw new Error('github_publish must not be concurrency safe')
    }
    if ((tool.name === 'github_status' || tool.name === 'github_configure') && tool.isConcurrencySafe?.() !== true) {
      throw new Error(`${tool.name} must be concurrency safe`)
    }
    if (tool.timeoutMs !== 600000 && tool.timeoutMs !== 60000) {
      throw new Error(`${tool.name} has an unexpected timeout: ${tool.timeoutMs}`)
    }
  }
})

check('apply() mounts the four documented webServer routes', () => {
  const paths = wired.routes.map(route => route.path).sort()
  const expected = [
    '/plugins/dsh-github-aide/config',
    '/plugins/dsh-github-aide/preflight',
    '/plugins/dsh-github-aide/publish',
    '/plugins/dsh-github-aide/status',
  ]
  if (JSON.stringify(paths) !== JSON.stringify(expected)) {
    throw new Error(`unexpected route paths: ${JSON.stringify(paths)}`)
  }
  for (const route of wired.routes) {
    if (route.kind !== 'exact') throw new Error(`${route.path} is not an exact route`)
    if (typeof route.handler !== 'function') throw new Error(`${route.path} has no handler`)
    if (route.disposed !== false) throw new Error(`${route.path} was already disposed before cleanup`)
  }
})

check('an effect-scoped disposer unregisters every route', () => {
  if (wired.effects.length < 1) throw new Error('apply() registered no effects')
  if (wired.disposers.length < 1) throw new Error('the effect returned no disposer')
  for (const { disposer } of wired.disposers) disposer()
  const leftover = wired.routes.filter(route => route.disposed === false)
  if (leftover.length !== 0) {
    throw new Error(`${leftover.length} route(s) still mounted after cleanup: ${leftover.map(route => route.path).join(', ')}`)
  }
})

check('the tool cleanup path leaves definitions intact', () => {
  for (const tool of wired.tools) {
    if (tool.disposed === true) throw new Error(`${tool.name} was disposed by the route cleanup`)
  }
})

// --------------------------------------------------------- graceful degradation

const headless = fakeContext({ withWebServer: false })
let headlessError
try {
  await mod.apply(headless.ctx, { visibility: 'public' })
} catch (error) {
  headlessError = error
}

check('apply() still registers the tools without a webServer service', () => {
  if (headlessError !== undefined) throw headlessError
  if (headless.tools.length !== 3) throw new Error(`expected 3 tools, got ${headless.tools.length}`)
  if (headless.routes.length !== 0) throw new Error('routes must not be mounted without webServer')
  if (headless.settings.length !== 1) throw new Error('the settings namespace must still be registered')
})

const noSettings = fakeContext({ withSettings: false })
let noSettingsError
try {
  await mod.apply(noSettings.ctx, {})
} catch (error) {
  noSettingsError = error
}

check('apply() degrades gracefully without a settings service', () => {
  if (noSettingsError !== undefined) throw noSettingsError
  if (noSettings.tools.length !== 3) throw new Error(`expected 3 tools, got ${noSettings.tools.length}`)
  if (noSettings.routes.length !== 4) throw new Error(`expected 4 routes, got ${noSettings.routes.length}`)
})

check('two contexts can be applied independently', async () => {
  const first = fakeContext()
  const second = fakeContext()
  await mod.apply(first.ctx, {})
  await mod.apply(second.ctx, {})
  if (first.tools.length !== 3 || second.tools.length !== 3) throw new Error('tool registration is not per-context')
  if (first.settings.length !== 1 || second.settings.length !== 1) throw new Error('settings registration is not per-context')
})

// ----------------------------------------------------- tool execution wiring

check('github_status executes through the host wiring', async () => {
  const project = await makeSampleProject()
  const tool = wired.tools.find(entry => entry.name === 'github_status')
  const outcome = await tool.execute({ path: project }, {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: project } } },
  })
  if (outcome === null || typeof outcome !== 'object') throw new Error('status returned no result object')
  if (typeof outcome.ok !== 'boolean') throw new Error('status result has no ok flag')
  if (typeof outcome.code !== 'string') throw new Error('status result has no code')
  if (typeof outcome.summary !== 'string') throw new Error('status result has no summary')
  if (!Array.isArray(outcome.sensitive_hits)) throw new Error('status result has no sensitive_hits array')
})

check('github_configure rejects an empty call without a token', async () => {
  const tool = wired.tools.find(entry => entry.name === 'github_configure')
  const outcome = await tool.execute({}, { signal: new AbortController().signal })
  if (outcome.ok !== false) throw new Error('an empty configure call must not report success')
  if (outcome.code !== 'BAD_REQUEST') throw new Error(`expected BAD_REQUEST, got ${outcome.code}`)
  if (JSON.stringify(outcome).includes('undefined')) throw new Error('configure result contains undefined')
})

check('github_configure clear:true reaches the credential store', async () => {
  const tool = wired.tools.find(entry => entry.name === 'github_configure')
  const outcome = await tool.execute({ clear: true }, { signal: new AbortController().signal })
  if (outcome.ok !== true) throw new Error(`clear failed: ${outcome.summary}`)
  if (outcome.configured !== false) throw new Error('clear must report configured:false')
  const records = wired.services.credentials.records
  if (records.size !== 1) throw new Error(`expected the record to be blanked, got ${records.size} record(s)`)
})

await rm(scratch, { recursive: true, force: true })

console.log(`\n${checks - failures} passed, ${failures} failed\n`)
process.exitCode = failures === 0 ? 0 : 1
