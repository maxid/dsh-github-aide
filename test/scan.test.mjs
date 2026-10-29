/**
 * Bounded filesystem walk tests.
 *
 * Every fixture lives in a fresh OS temp directory. The walk must stay inside
 * the project: it skips dependency/build directories, never follows symlinks,
 * truncates at the file budget, and reports sensitive files, directories, and
 * content signatures by path only.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SKIP_DIRS, listTopLevel, measureProject, scanProject } from '../lib/scan.js'

const scratch = await mkdtemp(join(tmpdir(), 'dsh-gh-aide-scan-'))

after(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** Create a project directory from a file map. Values are file contents. */
async function makeProject(name, files) {
  const dir = join(scratch, name)
  await mkdir(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    const target = join(dir, file)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return dir
}

/** The paths reported as sensitive, sorted for stable comparison. */
function sensitivePaths(report) {
  return report.sensitive.map(entry => entry.path).sort()
}

// ---------------------------------------------------------------- traversal

test('listTopLevel reports only immediate files and directories', async () => {
  const dir = await makeProject('listing', {
    'package.json': '{}',
    'src/index.js': 'export {}\n',
    'node_modules/pkg/index.js': 'module.exports = 1\n',
  })
  const listing = await listTopLevel(dir)
  assert.deepEqual(listing.files.sort(), ['package.json'])
  assert.deepEqual(listing.dirs.sort(), ['node_modules', 'src'])
})

test('scanProject returns the documented report shape', async () => {
  const dir = await makeProject('shape', {
    'package.json': '{"name":"demo"}\n',
    'src/index.js': 'export const answer = 42\n',
  })
  const report = await scanProject(dir)
  assert.equal(typeof report.files, 'number')
  assert.equal(typeof report.bytes, 'number')
  assert.equal(typeof report.truncated, 'boolean')
  assert.ok(Array.isArray(report.sensitive))
  assert.ok(Array.isArray(report.topLevel.files))
  assert.ok(Array.isArray(report.topLevel.dirs))
  assert.equal(report.files, 2)
  assert.ok(report.topLevel.files.includes('package.json'))
  assert.deepEqual(report.sensitive, [])
})

test('scanProject sums the byte size of the files it walks', async () => {
  const first = 'a'.repeat(10)
  const second = 'b'.repeat(25)
  const dir = await makeProject('bytes', { 'one.txt': first, 'nested/two.txt': second })
  const report = await scanProject(dir)
  assert.equal(report.files, 2)
  assert.equal(report.bytes, 35)
})

test('skip directories are never entered', async () => {
  for (const skipped of ['.git', 'node_modules', 'dist', 'build', '__pycache__', '.venv']) {
    assert.ok(SKIP_DIRS.has(skipped), `${skipped} must be in SKIP_DIRS`)
  }
  const dir = await makeProject('skips', {
    'src/index.js': 'export {}\n',
    'node_modules/pkg/index.js': 'module.exports = 1\n',
    'dist/bundle.js': 'bundle\n',
    '.git/config': 'token = ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789\n',
    '__pycache__/x.pyc': 'binary',
  })
  const report = await scanProject(dir)
  assert.equal(report.files, 1)
  assert.deepEqual(sensitivePaths(report), [])
})

test('a symlink is not followed and its target is never judged', async () => {
  const outside = await makeProject('outside', {
    'secret.txt': 'const token = "ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789"\n',
  })
  const dir = await makeProject('symlinked', { 'index.js': 'export {}\n' })
  await symlink(join(outside, 'secret.txt'), join(dir, 'linked.txt'))
  await symlink(outside, join(dir, '.ssh-target'))

  const report = await scanProject(dir)
  assert.equal(report.files, 1, 'only the real regular file is counted')
  assert.deepEqual(sensitivePaths(report), [], 'a symlink target outside the project is never read')
})

test('the walk truncates at the configured file budget', async () => {
  const files = {}
  for (let index = 0; index < 6; index += 1) files[`file-${index}.txt`] = `content ${index}\n`
  const dir = await makeProject('budget', files)

  const bounded = await scanProject(dir, { maxScanFiles: 3 })
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.files <= 3, `walked ${bounded.files} files with a budget of 3`)
  assert.ok(bounded.files >= 1)

  const full = await scanProject(dir, { maxScanFiles: 100 })
  assert.equal(full.truncated, false)
  assert.equal(full.files, 6)
})

test('scanProject on a missing directory reports nothing instead of throwing', async () => {
  const report = await scanProject(join(scratch, 'does-not-exist'))
  assert.equal(report.files, 0)
  assert.deepEqual(report.sensitive, [])
})

// --------------------------------------------------------------- sensitive data

test('sensitive filenames are reported by path and kind', async () => {
  const dir = await makeProject('sensitive-files', {
    'src/index.js': 'export {}\n',
    '.env': 'SECRET=abcdefghijklmnop\n',
    'config/.env.production': 'X=1\n',
    'deploy/id_rsa': 'key material\n',
    'certs/server.pem': 'cert\n',
  })
  const report = await scanProject(dir)
  const found = sensitivePaths(report)
  assert.deepEqual(found, ['.env', 'certs/server.pem', 'config/.env.production', 'deploy/id_rsa'])
  for (const entry of report.sensitive) assert.equal(entry.kind, 'file')
})

test('sensitive directories are reported and not walked', async () => {
  const dir = await makeProject('sensitive-dirs', {
    '.ssh/id_rsa': 'key\n',
    'home/.aws/credentials': 'aws_key\n',
    'src/index.js': 'export {}\n',
  })
  const report = await scanProject(dir)
  const dirs = report.sensitive.filter(entry => entry.kind === 'dir')
  assert.deepEqual(dirs.map(entry => entry.path).sort(), ['.ssh', 'home/.aws'])
  assert.equal(report.files, 1, 'files inside a credential directory are not walked')
})

test('secret content in an ordinary file is a content hit', async () => {
  const dir = await makeProject('sensitive-content', {
    'config.js': 'const token = "ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789"\n',
    'index.js': 'export const answer = 42\n',
  })
  const report = await scanProject(dir)
  assert.deepEqual(report.sensitive, [{ path: 'config.js', kind: 'content' }])
})

test('binary files are not content-scanned', async () => {
  const dir = await makeProject('binary-content', {
    'logo.png': 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  })
  const report = await scanProject(dir)
  assert.deepEqual(report.sensitive, [])
  assert.equal(report.files, 1, 'a binary file still counts as walked')
})

test('measureProject counts files and bytes outside the skipped directories', async () => {
  const dir = await makeProject('measure', {
    'a.txt': 'abc',
    'nested/b.txt': 'defgh',
    'node_modules/junk.txt': 'ignored',
  })
  const measured = await measureProject(dir)
  assert.equal(measured.files, 2)
  assert.equal(measured.bytes, 8)
})
