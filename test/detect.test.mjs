/**
 * Pure-layer tests: stack detection, .gitignore generation, secret scanning,
 * repo-name derivation, identity resolution, and redaction.
 *
 * Nothing here touches the filesystem or the network. Every helper is a plain
 * data-in / data-out function so the whole preflight vocabulary is testable
 * without a harness.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as detect from '../lib/detect.js'
import { redact as redactErrors } from '../lib/errors.js'
import { slugifyRepoName } from '../lib/workspace.js'

const {
  buildGitignore,
  detectStacks,
  formatBytes,
  looksBinary,
  resolveIdentity,
  scanText,
  sensitivePathKind,
  stripUndefined,
  suggestRepoName,
} = detect

/**
 * The upload lineage exported its own `redact`; the merged module may re-export
 * the shared one from errors.js instead. Both must satisfy the contract.
 */
const redact = typeof detect.redact === 'function' ? detect.redact : redactErrors

// ------------------------------------------------------------- stack detection

test('detectStacks recognises a node project by package.json', () => {
  const stacks = detectStacks({ files: ['package.json', 'README.md'], dirs: [] })
  assert.deepEqual(stacks.map(stack => stack.id), ['node'])
})

test('detectStacks recognises several stacks at once', () => {
  const stacks = detectStacks({
    files: ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod'],
    dirs: [],
  })
  assert.deepEqual(stacks.map(stack => stack.id).sort(), ['go', 'node', 'python', 'rust'])
})

test('detectStacks falls back to directory evidence', () => {
  const stacks = detectStacks({ files: [], dirs: ['node_modules'] })
  assert.deepEqual(stacks.map(stack => stack.id), ['node'])
})

test('detectStacks matches glob markers', () => {
  const stacks = detectStacks({ files: ['App.csproj'], dirs: [] })
  assert.deepEqual(stacks.map(stack => stack.id), ['dotnet'])
  assert.deepEqual(detectStacks({ files: ['MyApp.sln'], dirs: [] }).map(stack => stack.id), ['dotnet'])
})

test('detectStacks returns nothing for an unknown tree', () => {
  assert.deepEqual(detectStacks({ files: ['notes.txt'], dirs: ['stuff'] }), [])
})

test('detectStacks tolerates missing input', () => {
  assert.deepEqual(detectStacks(undefined), [])
})

test('a detected stack carries a label and its ignore lines', () => {
  const [node] = detectStacks({ files: ['package.json'], dirs: [] })
  assert.equal(node.label, 'Node.js')
  assert.ok(node.ignore.includes('node_modules/'))
})

// ---------------------------------------------------------------- .gitignore

test('buildGitignore always carries the common tail and dedupes', () => {
  const stacks = detectStacks({ files: ['package.json'], dirs: [] })
  const text = buildGitignore(stacks)
  assert.match(text, /node_modules\//)
  assert.match(text, /\.DS_Store/)
  assert.ok(text.endsWith('\n'))
  assert.equal(text.split('\n').filter(line => line === 'node_modules/').length, 1)
})

test('buildGitignore accepts extra lines', () => {
  const text = buildGitignore([], ['*.secret'])
  assert.match(text, /\*\.secret/)
})

test('buildGitignore is valid for an empty stack list', () => {
  const text = buildGitignore([])
  assert.match(text, /\.DS_Store/)
  assert.ok(text.length > 0)
})

// --------------------------------------------------------- sensitive patterns

test('sensitivePathKind flags credential filenames', () => {
  for (const path of [
    '.env',
    '.env.local',
    'config/.env.production',
    'deploy/id_rsa',
    'certs/server.pem',
    'app/keystore.jks',
    'secrets.yaml',
    '.npmrc',
    '.netrc',
    'service-account.json',
    'terraform.tfstate.backup',
    '.git-credentials',
  ]) {
    assert.equal(sensitivePathKind(path), 'file', `${path} must be sensitive`)
  }
})

test('sensitivePathKind flags credential directories', () => {
  assert.equal(sensitivePathKind('.ssh/x'), 'dir')
  assert.equal(sensitivePathKind('home/.aws/x'), 'dir')
  assert.equal(sensitivePathKind('home/.gnupg/x'), 'dir')
})

test('sensitivePathKind leaves ordinary files alone', () => {
  assert.equal(sensitivePathKind('src/index.js'), undefined)
  assert.equal(sensitivePathKind('README.md'), undefined)
  assert.equal(sensitivePathKind('env.js'), undefined)
  assert.equal(sensitivePathKind('package.json'), undefined)
})

test('scanText finds every credential signature family', () => {
  assert.ok(scanText('-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIE...').includes('private-key-block'))
  assert.ok(scanText('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----').includes('private-key-block'))
  assert.ok(scanText('const token = "ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789";').includes('github-token'))
  assert.ok(scanText('token github_pat_' + '11ABCDEFG0abcdefghijkl_rest').includes('github-pat-fine'))
  assert.ok(scanText('aws_access_key_id = AKIA' + 'IOSFODNN7EXAMPLE').includes('aws-access-key'))
  assert.ok(scanText('xoxb-' + '1234567890-abcdefghijkl').includes('slack-token'))
  assert.ok(scanText('key = "sk-' + 'abcdefghijklmnopqrstuvwx"').includes('openai-key'))
  assert.ok(scanText('api_key = "' + 'abcdefghijklmnopqrstuvwx"').includes('generic-secret-assign'))
})

test('scanText reports nothing for clean content', () => {
  assert.deepEqual(scanText('export const answer = 42;'), [])
})

test('scanText does not carry regex state between calls', () => {
  const text = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'
  assert.deepEqual(scanText(text), scanText(text))
})

test('looksBinary skips extensions that would never carry a token', () => {
  assert.equal(looksBinary('logo.png'), true)
  assert.equal(looksBinary('archive.tar.gz'), true) // the ported list includes .gz
  assert.equal(looksBinary('app.wasm'), true)
  assert.equal(looksBinary('src/index.js'), false)
})

// --------------------------------------------------------------- repo naming

test('suggestRepoName normalizes a project folder name', () => {
  assert.equal(suggestRepoName('C:\\work\\My Project!'), 'my-project')
  assert.equal(suggestRepoName('/home/u/dsh-sysmon'), 'dsh-sysmon')
  assert.equal(suggestRepoName('UPPER_CASE'), 'upper_case')
  assert.equal(suggestRepoName('__weird__'), 'weird')
})

test('suggestRepoName never returns an empty name', () => {
  assert.equal(suggestRepoName('!!!'), 'my-project')
  assert.equal(suggestRepoName(undefined), 'my-project')
})

test('suggestRepoName truncates to the GitHub limit', () => {
  assert.ok(suggestRepoName('x'.repeat(300)).length <= 100)
})

test('slugifyRepoName produces names GitHub accepts', () => {
  assert.equal(slugifyRepoName('My Project'), 'my-project')
  assert.equal(slugifyRepoName('DSH插件'), 'dsh')
  assert.equal(slugifyRepoName('  ..weird//name..  '), 'weird-name')
  assert.equal(slugifyRepoName(''), 'project')
  assert.equal(slugifyRepoName('a'.repeat(200)).length, 100)
  assert.match(slugifyRepoName('Fancy_Name.v2'), /^[a-z0-9._-]+$/)
})

// ------------------------------------------------------------------ identity

test('resolveIdentity prefers explicit options over everything', () => {
  const identity = resolveIdentity({
    options: { gitUserName: 'Alice', gitUserEmail: 'alice@example.com' },
    gitConfig: { name: 'Bob', email: 'bob@example.com' },
    profile: { login: 'carol', id: 7 },
  })
  assert.deepEqual(identity, { name: 'Alice', email: 'alice@example.com' })
})

test('resolveIdentity falls back to git config', () => {
  const identity = resolveIdentity({
    options: {},
    gitConfig: { name: 'Bob', email: 'bob@example.com' },
  })
  assert.deepEqual(identity, { name: 'Bob', email: 'bob@example.com' })
})

test('resolveIdentity derives a noreply address from the GitHub profile', () => {
  const identity = resolveIdentity({ options: {}, gitConfig: {}, profile: { login: 'carol', id: 42 } })
  assert.equal(identity.email, '42+carol@users.noreply.github.com')
  assert.equal(identity.name, 'carol')
})

test('resolveIdentity ignores blank strings and falls back to the plugin identity', () => {
  const identity = resolveIdentity({ options: { gitUserName: '   ' }, gitConfig: { name: '' } })
  assert.equal(identity.name, 'dsh-github-aide')
  assert.match(identity.email, /@users\.noreply\.github\.com$/)
})

// ------------------------------------------------------------------ redaction

test('redact removes an exact known secret', () => {
  assert.equal(redact('tok=secretvalue123', ['secretvalue123']), 'tok=[REDACTED]')
})

test('redact masks a classic PAT by shape', () => {
  const masked = redact('remote: https://ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789@github.com')
  assert.ok(!masked.includes('ghp_'))
  assert.match(masked, /\[REDACTED\]/)
})

test('redact masks a fine-grained PAT by shape', () => {
  const masked = redact('token github_pat_' + '11ABCDEFG0abcdefghijkl_rest')
  assert.ok(!masked.includes('github_pat_'))
  assert.match(masked, /\[REDACTED\]/)
})

test('redact masks credentials embedded in a URL userinfo', () => {
  const masked = redact('fatal: could not read from https://x-access-token:ghp_' + 'abcdefghijklmnopqrst@github.com/o/r.git')
  assert.ok(!masked.includes('ghp_abc'))
  assert.match(masked, /https:\/\/[^@\s]*\[REDACTED\][^@\s]*@github\.com/)

  const generic = redact('https://user:pass@github.com/x/y.git')
  assert.ok(!generic.includes('pass'))
  assert.match(generic, /https:\/\/\[REDACTED\]@github\.com/)
})

test('redact masks a Bearer header', () => {
  const masked = redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789')
  assert.ok(!masked.includes('abcdefghijklmnopqrstuvwxyz'))
})

test('redact leaves ordinary text intact', () => {
  assert.equal(redact('git push origin main'), 'git push origin main')
})

// ------------------------------------------------------------------- helpers

test('formatBytes renders a human size', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB')
  assert.equal(formatBytes(undefined), '—')
})

test('stripUndefined removes absent object fields, keeps known falsey values', () => {
  assert.deepEqual(stripUndefined({ a: 1, b: undefined }), { a: 1 })
  assert.deepEqual(stripUndefined({ a: null, b: false, c: 0, d: '' }), { a: null, b: false, c: 0, d: '' })
})

test('stripUndefined recurses through nested objects and arrays', () => {
  assert.deepEqual(
    stripUndefined({ rows: [{ id: 1, note: undefined }, { nested: { deep: undefined, keep: 'x' } }] }),
    { rows: [{ id: 1 }, { nested: { keep: 'x' } }] },
  )
})

test('stripUndefined survives a JSON round trip', () => {
  const input = { ok: true, owner: undefined, github: { login: undefined, scopes: undefined, repoExists: false } }
  const json = JSON.stringify(stripUndefined(input))
  assert.equal(json, JSON.stringify(JSON.parse(json)))
})
