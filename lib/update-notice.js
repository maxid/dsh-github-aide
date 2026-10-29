/**
 * Surface a pending harness-upgrade notice to the assistant, and locate the DSH
 * home that both the notice and the install scripts operate on.
 *
 * `scripts/watch-dsh-update.mjs` records the harness core version and, when it
 * changes, writes a notice into the DSH home. Reading it here is what turns a
 * file on disk into something the model can act on: a plugin built against an
 * older core surface is the usual reason a plugin tree stops loading after an app
 * update.
 *
 * The home-resolution helpers live in this module (rather than a separate
 * `dsh-home.js`) so the installer, the watcher, and the runtime all probe the
 * same place without adding another module to the package surface.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default profile name a DSH desktop install uses. */
export const DEFAULT_PROFILE = 'web'

/**
 * Every DSH home this machine might be using, most specific first.
 *
 * A desktop install and a CLI install keep their state in different places, and
 * the desktop launcher exports `DSH_HOME` for whichever one is running. Probing
 * in priority order is what lets the installer and the update watcher agree on
 * one directory instead of writing to a home the application never reads.
 * @returns {string[]} candidate directories, de-duplicated.
 */
export function candidateDshHomes() {
  const candidates = []
  if (process.env.DSH_HOME) candidates.push(process.env.DSH_HOME)
  const { APPDATA, XDG_CONFIG_HOME } = process.env
  if (process.platform === 'win32' && APPDATA) {
    candidates.push(path.join(APPDATA, 'dsh-desktop', 'harness'))
  }
  if (process.platform === 'darwin') {
    candidates.push(path.join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness'))
  }
  if (XDG_CONFIG_HOME) candidates.push(path.join(XDG_CONFIG_HOME, 'dsh-desktop', 'harness'))
  candidates.push(path.join(homedir(), '.config', 'dsh-desktop', 'harness'))
  candidates.push(path.join(homedir(), '.dsh'))
  return [...new Set(candidates.filter((entry) => typeof entry === 'string' && entry.length > 0))]
}

/**
 * Resolve the DSH home to operate on.
 * @param {object} [options] - resolution options.
 * @param {string} [options.requested] - an explicit home, from `--home` or `DSH_HOME`.
 * @param {string} [options.profile] - profile name that should exist.
 * @param {boolean} [options.requireProfile] - when false, an existing home qualifies even without the profile.
 * @returns {{ home: string, reason: string }|undefined} the chosen home, or `undefined` when none qualifies.
 */
export function resolveDshHome(options = {}) {
  const profile = options.profile ?? DEFAULT_PROFILE
  const candidates = options.requested ? [path.resolve(options.requested)] : candidateDshHomes()

  const withProfile = candidates.filter((candidate) =>
    existsSync(path.join(candidate, 'profiles', profile, 'package.json')))
  if (withProfile.length > 0) return { home: withProfile[0], reason: `holds profiles/${profile}/package.json` }

  if (options.requireProfile !== false) {
    const existing = candidates.find((candidate) => existsSync(candidate))
    if (existing) return { home: existing, reason: 'exists but has no profile manifest yet' }
  }
  const existing = candidates.find((candidate) => existsSync(candidate))
  return existing ? { home: existing, reason: 'exists but has no profile manifest yet' } : undefined
}

/**
 * The path of a plugin-owned state file inside the DSH home.
 *
 * The package prefix keeps this plugin's notice and version state from colliding
 * with another plugin that uses the same file names in the shared home.
 * @param {string} home - DSH home.
 * @param {string} fileName - file name.
 * @returns {string} absolute path.
 */
export function homeFilePath(home, fileName) {
  return path.join(home, `dsh-github-aide-${fileName}`)
}

/**
 * Read the pending upgrade notice, when one exists.
 * @returns {Promise<{ from: string, to: string, request: string }|undefined>} the notice, or `undefined`.
 */
export async function readUpdateNotice() {
  const resolved = resolveDshHome({ requested: process.env.DSH_HOME })
  if (!resolved) return undefined
  const noticePath = homeFilePath(resolved.home, 'update-notice.json')
  if (!existsSync(noticePath)) return undefined
  try {
    const parsed = JSON.parse(await readFile(noticePath, 'utf8'))
    if (typeof parsed?.from !== 'string' || typeof parsed?.to !== 'string') return undefined
    return {
      from: parsed.from,
      to: parsed.to,
      request: typeof parsed.request === 'string'
        ? parsed.request
        : `DSH was updated from ${parsed.from} to ${parsed.to}. Check the installed plugins for compatibility.`,
    }
  } catch {
    /* A corrupt notice is not worth failing a status call over. */
    return undefined
  }
}

/**
 * Render a pending notice as the single sentence a result field can carry.
 * @param {{ from: string, to: string, request: string }|undefined} notice - value from {@link readUpdateNotice}.
 * @returns {string} the sentence, or `''` when no notice is pending.
 */
export function formatUpdateNotice(notice) {
  if (!notice) return ''
  return `DSH harness core was updated from ${notice.from} to ${notice.to}. ${notice.request}`.trim()
}
