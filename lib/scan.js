/**
 * Bounded filesystem walk + credential scan.
 *
 * The walk is deliberately conservative: it skips build/VCS directories, obeys a
 * hard file budget, never follows symlinks, and stops reading a file once the
 * per-file byte ceiling is reached. Nothing here can walk out of the project
 * root, so a scan is safe to run on any directory the user points at.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { looksBinary, scanText, sensitivePathKind } from './detect.js'

/** Directories that never belong in a published project. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build',
  '.next', '.nuxt', '.cache', '.gradle', '.idea', '.vscode', 'Library', 'Temp', 'obj',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'coverage', '.pnpm-store', '.npm',
  'bin', 'out', '.godot', '.import', 'cmake-build-debug', 'vendor', 'Pods',
])

/** Deepest directory nesting a scan will enter; deeper trees are truncated. */
const MAX_DEPTH = 12
/** Files above this size are counted and name-checked but not read for content. */
const MAX_BYTES_PER_FILE = 512 * 1024

/**
 * Top-level names, used for stack detection and the `.gitignore` decision.
 * @param {string} projectDir project directory.
 * @returns {Promise<{ files: string[], dirs: string[] }>} direct children by kind.
 */
export async function listTopLevel(projectDir) {
  const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => [])
  const files = []
  const dirs = []
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(entry.name)
    else if (entry.isFile()) files.push(entry.name)
  }
  return { files, dirs }
}

/**
 * Walk a project and report what publishing it would touch.
 *
 * `sensitive` carries one entry per finding: `kind: 'file'` for a filename that
 * matches a credential pattern, `'dir'` for a credential directory (which is not
 * descended into), and `'content'` for a text file whose bytes matched a secret
 * signature. Symlinks are neither followed nor counted: their target may sit
 * outside the project and must not be judged or uploaded by accident.
 *
 * @param {string} projectDir project directory.
 * @param {object} [limits] traversal bounds.
 * @param {number} [limits.maxScanFiles] file budget; scanning stops (truncated) past it.
 * @param {number} [limits.maxDepth] directory depth budget.
 * @param {number} [limits.maxBytesPerFile] per-file content-read ceiling.
 * @returns {Promise<{
 *   files: number,
 *   bytes: number,
 *   sensitive: { path: string, kind: 'file'|'dir'|'content' }[],
 *   truncated: boolean,
 *   topLevel: { files: string[], dirs: string[] },
 * }>} scan report.
 */
export async function scanProject(projectDir, limits = {}) {
  const maxScanFiles = Number.isFinite(limits.maxScanFiles) && limits.maxScanFiles > 0
    ? Math.floor(limits.maxScanFiles)
    : 8000
  const maxDepth = Number.isFinite(limits.maxDepth) ? limits.maxDepth : MAX_DEPTH
  const maxBytesPerFile = Number.isFinite(limits.maxBytesPerFile)
    ? limits.maxBytesPerFile
    : MAX_BYTES_PER_FILE

  const topLevel = await listTopLevel(projectDir)
  /** @type {{ path: string, kind: 'file'|'dir'|'content' }[]} */
  const sensitive = []
  let files = 0
  let bytes = 0
  let truncated = false

  /** @type {{ dir: string, depth: number }[]} */
  const queue = [{ dir: projectDir, depth: 0 }]

  walk: while (queue.length > 0) {
    if (files >= maxScanFiles) {
      truncated = true
      break
    }
    const { dir, depth } = queue.shift()
    if (depth > maxDepth) {
      truncated = true
      continue
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files >= maxScanFiles) {
        truncated = true
        break walk
      }
      const absolute = join(dir, entry.name)
      const relPath = relative(projectDir, absolute).split(sep).join('/')

      if (entry.isSymbolicLink()) continue

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue
        /* A credential directory (.ssh, .aws, .gnupg) is reported whole and not
           descended into: listing its contents would leak key names for no gain. */
        if (sensitivePathKind(`${relPath}/x`) === 'dir') {
          sensitive.push({ path: relPath, kind: 'dir' })
          continue
        }
        queue.push({ dir: absolute, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue

      files += 1
      if (sensitivePathKind(relPath) !== undefined) sensitive.push({ path: relPath, kind: 'file' })

      /* Size is measured before the binary/size short-circuit so `bytes` still
         describes the project, not just the part that was read. */
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined) continue
      bytes += info.size
      if (looksBinary(relPath) || info.size > maxBytesPerFile) continue

      const content = await readFile(absolute).catch(() => undefined)
      if (content === undefined) continue
      // A NUL byte in the first block means binary regardless of extension.
      if (content.subarray(0, 8000).includes(0)) continue
      if (scanText(content.toString('utf8')).length > 0) sensitive.push({ path: relPath, kind: 'content' })
    }
  }

  return { files, bytes, sensitive, truncated, topLevel }
}

/**
 * Total size of a directory tree, bounded by a file budget.
 *
 * Used when a caller only needs the project size and not the credential scan;
 * it follows the same skip list so both numbers describe the same tree.
 * @param {string} projectDir project directory.
 * @param {number} [maxFiles] file budget.
 * @returns {Promise<{ files: number, bytes: number }>} size facts.
 */
export async function measureProject(projectDir, maxFiles = 60000) {
  let bytes = 0
  let files = 0
  const queue = [projectDir]
  while (queue.length > 0 && files < maxFiles) {
    const dir = queue.shift()
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files >= maxFiles) break
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.git')) continue
        queue.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(join(dir, entry.name)).catch(() => undefined)
      if (info === undefined) continue
      bytes += info.size
      files += 1
    }
  }
  return { files, bytes }
}

export { SKIP_DIRS }
