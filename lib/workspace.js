/**
 * Workspace and project-directory resolution.
 *
 * The Session's workspace root is the only trustworthy source for "which
 * project is this": it is the path the user chose and the path the sandbox
 * policy was resolved against. The workspace title helper from
 * `@deepseek-ai/dsh-util-workspace-path` is a display utility, not a path
 * resolver, and this module must stay dependency-free anyway — so the root comes
 * from the execution context and the repository name comes from the path.
 *
 * Every path that a tool accepts from the model is canonicalized here: `~` is
 * expanded, relative paths are resolved against the workspace root, symlinks are
 * resolved, and a non-directory is rejected with one stable code. Doing it in
 * one place is what keeps the publish flow from operating on an unexpected path.
 */
import { lstat, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { ERROR_CODES, GitHubAideError } from './errors.js'

/** Longest repository name GitHub accepts. */
const MAX_REPO_NAME = 100
/** The placeholder GitHub uses when a project directory name yields no usable characters. */
const FALLBACK_REPO_NAME = 'project'

/**
 * Resolve the real path of the workspace this tool call runs in.
 * @param {object} exec - tool execution context supplied by the harness.
 * @returns {Promise<string>} canonical absolute workspace root.
 * @throws {GitHubAideError} `NO_WORKSPACE` when the session or its directory is unusable.
 */
export async function workspaceRootFor(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new GitHubAideError(
      ERROR_CODES.NO_WORKSPACE,
      'This session has no workspace directory, so there is no project to publish.',
      { nextStep: 'Open the project folder in DSH and run this again.' },
    )
  }
  exec.signal?.throwIfAborted()
  let root
  try {
    root = await realpath(cwd)
  } catch {
    throw new GitHubAideError(
      ERROR_CODES.NO_WORKSPACE,
      `The workspace directory is not reachable: ${cwd}`,
      { nextStep: `Reopen ${cwd}, or pick another workspace.` },
    )
  }
  let info
  try {
    info = await lstat(root)
  } catch {
    throw new GitHubAideError(
      ERROR_CODES.NO_WORKSPACE,
      `The workspace directory is not reachable: ${cwd}`,
      { nextStep: `Reopen ${cwd}, or pick another workspace.` },
    )
  }
  if (!info.isDirectory()) {
    throw new GitHubAideError(ERROR_CODES.NO_WORKSPACE, `The workspace path is not a directory: ${root}`)
  }
  return root
}

/**
 * Turn any project name into a valid GitHub repository name.
 *
 * GitHub accepts letters, digits, `.`, `-` and `_`. Everything else — spaces,
 * non-ASCII directory names, path separators — collapses to a single hyphen so
 * that a project directory can always name its own repository.
 * @param {unknown} name - candidate name, usually a directory basename.
 * @returns {string} a name GitHub accepts, never empty.
 */
export function slugifyRepoName(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/[-._]{2,}/gu, '-')
    .replace(/^[-._]+|[-._]+$/gu, '')
    .slice(0, MAX_REPO_NAME)
    .replace(/^[-._]+|[-._]+$/gu, '')
  return slug.length > 0 ? slug : FALLBACK_REPO_NAME
}

/**
 * Derive the default repository name from the workspace directory name.
 * @param {string} root - canonical workspace root (or any project path).
 * @returns {string} slugified directory name, never empty.
 */
export function defaultRepoNameFor(root) {
  return slugifyRepoName(path.basename(String(root ?? '')))
}

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Tool arguments are model-generated and users copy paths from a shell, where
 * `~` expands; doing it here means `~/code/app` works even though Node's path
 * functions treat `~` as an ordinary directory name.
 * @param {string} value - path as given by the caller.
 * @returns {string} the path with `~` expanded.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the project directory a tool call asked for.
 *
 * With no input the workspace root is the project (that is the default of both
 * publish tools). Otherwise `~` is expanded, a relative path is resolved against
 * `fallbackRoot`, and the result must be an existing directory — the publish
 * flow cannot do anything sensible with a file or a missing path, so both become
 * `NOT_A_DIRECTORY` before any scan or git command runs.
 * @param {unknown} input - `path` argument, possibly empty.
 * @param {string} [fallbackRoot] - workspace root used as default and resolution base.
 * @returns {Promise<string>} canonical absolute directory path.
 * @throws {GitHubAideError} `NOT_A_DIRECTORY` when the path is missing or not a directory.
 */
export async function resolveProjectPath(input, fallbackRoot) {
  const fallback = typeof fallbackRoot === 'string' && fallbackRoot.length > 0 ? fallbackRoot : ''
  const requested = typeof input === 'string' ? input.trim() : ''
  const candidate = requested.length > 0 ? expandHome(requested) : fallback
  if (candidate.length === 0) {
    throw new GitHubAideError(
      ERROR_CODES.NOT_A_DIRECTORY,
      'No project directory was given, and this session has no workspace root to fall back to.',
      { nextStep: 'Pass the path of the project directory to publish.' },
    )
  }
  /* path.resolve ignores the base for an absolute candidate, which is exactly
     the behaviour wanted: an absolute path is never rebased onto the root. */
  const resolved = path.resolve(fallback.length > 0 ? fallback : process.cwd(), candidate)
  let real
  try {
    real = await realpath(resolved)
  } catch {
    throw new GitHubAideError(
      ERROR_CODES.NOT_A_DIRECTORY,
      `The project directory does not exist: ${resolved}`,
      { nextStep: 'Check the path, then retry with an existing directory.' },
    )
  }
  let info
  try {
    info = await stat(real)
  } catch {
    throw new GitHubAideError(
      ERROR_CODES.NOT_A_DIRECTORY,
      `The project directory is not reachable: ${resolved}`,
      { nextStep: 'Check permissions on the path, then retry.' },
    )
  }
  if (!info.isDirectory()) {
    throw new GitHubAideError(
      ERROR_CODES.NOT_A_DIRECTORY,
      `The project path is not a directory: ${real}`,
      { nextStep: 'Pass the path of the project directory, not a file.' },
    )
  }
  return real
}
