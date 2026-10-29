/**
 * Pure project inspection helpers: stack detection, `.gitignore` generation,
 * credential signatures, and the small formatting/name helpers the flows share.
 *
 * Everything here takes plain data in and returns plain data out — no `ctx`, no
 * I/O — so the whole preflight vocabulary is testable without a live harness or
 * a filesystem. This is a straight port of the upload plugin's `lib/detect.js`,
 * renamed for `dsh-github-aide` and re-pointed at the shared redactor.
 */

/** Filenames that must never be pushed without an explicit override. */
const SENSITIVE_NAMES = Object.freeze([
  /^\.env(\..+)?$/i,
  /^\.envrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.?(npmrc|pypirc|netrc|htpasswd)$/i,
  /^credentials(\.json)?$/i,
  /^service[-_]?account.*\.json$/i,
  /^\.?terraform\.tfstate.*$/i,
  /^.*\.(pem|key|pfx|p12|jks|keystore|ppk)$/i,
  /^.*\.(sqlite|sqlite3|db|mdb|dump|sql\.gz)$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
  /^\.aws$/i,
  /^\.ssh$/i,
  /^\.gnupg$/i,
  /^\.git-credentials$/i,
])

/** Content signatures that scream "credential" when found in a text file. */
const SENSITIVE_CONTENT = Object.freeze([
  { id: 'private-key-block', re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'github-pat-fine', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'generic-secret-assign', re: /(api[_-]?key|secret|passwd|password|access[_-]?token)\s*[:=]\s*["'][^"'\s]{16,}["']/i },
])

/** Noise never worth pushing; appended to every generated `.gitignore`. */
export const COMMON_IGNORES = Object.freeze([
  '.DS_Store',
  'Thumbs.db',
  '*.log',
  '*.tmp',
  '.idea/',
  '.vscode/',
  '*.swp',
])

/**
 * Stack templates. `markers` are probed against the top level of the project;
 * `dirs` are probed as directory names at the top level.
 */
export const STACKS = Object.freeze([
  {
    id: 'node',
    label: 'Node.js',
    markers: ['package.json'],
    dirs: ['node_modules'],
    ignore: ['node_modules/', 'dist/', 'build/', 'coverage/', '.npm/', '.pnpm-store/', '*.tsbuildinfo', '.env', '.env.local', '.env.*.local'],
  },
  {
    id: 'python',
    label: 'Python',
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile', 'poetry.lock'],
    dirs: ['__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache'],
    ignore: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', 'build/', 'dist/', '*.egg-info/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/'],
  },
  {
    id: 'rust',
    label: 'Rust',
    markers: ['Cargo.toml'],
    dirs: ['target'],
    ignore: ['target/', '**/*.rs.bk'],
  },
  {
    id: 'go',
    label: 'Go',
    markers: ['go.mod'],
    dirs: [],
    ignore: ['bin/', '*.test', '*.out'],
  },
  {
    id: 'java',
    label: 'Java/JVM',
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle'],
    dirs: ['target', 'build', '.gradle'],
    ignore: ['target/', 'build/', '.gradle/', '*.class', '*.jar'],
  },
  {
    id: 'dotnet',
    label: '.NET',
    markers: ['*.sln', '*.csproj'],
    dirs: ['bin', 'obj'],
    ignore: ['bin/', 'obj/', '*.user', '*.suo'],
  },
  {
    id: 'unity',
    label: 'Unity',
    markers: ['ProjectSettings', 'Assets'],
    dirs: ['Library', 'Temp', 'Logs'],
    ignore: ['Library/', 'Temp/', 'Obj/', 'Logs/', 'UserSettings/', '*.csproj', '*.sln', '*.unityproj'],
  },
  {
    id: 'godot',
    label: 'Godot',
    markers: ['project.godot'],
    dirs: ['.godot'],
    ignore: ['.godot/', '.import/', 'export_presets.cfg'],
  },
  {
    id: 'cpp',
    label: 'C/C++',
    markers: ['CMakeLists.txt', 'Makefile', 'meson.build'],
    dirs: ['build', 'cmake-build-debug'],
    ignore: ['build/', 'cmake-build-*/', '*.o', '*.obj', '*.a', '*.so', '*.dll', '*.exe'],
  },
  {
    id: 'web-static',
    label: 'Static site',
    markers: ['index.html'],
    dirs: [],
    ignore: [],
  },
])

/**
 * Detect the stacks present in a directory listing.
 * @param {{ files?: string[], dirs?: string[] }} [listing] top-level names.
 * @returns {{ id: string, label: string, ignore: string[] }[]} detected stacks.
 */
export function detectStacks(listing) {
  const files = new Set((listing?.files ?? []).map((name) => String(name).toLowerCase()))
  const dirs = new Set(listing?.dirs ?? [])
  const found = []
  for (const stack of STACKS) {
    const hitMarker = stack.markers.some((marker) => {
      const lower = marker.toLowerCase()
      if (lower.includes('*')) {
        /* Markers such as `*.csproj` match a suffix, not a literal filename. */
        const suffix = lower.slice(lower.indexOf('*') + 1)
        return [...files].some((file) => file.endsWith(suffix))
      }
      return files.has(lower)
    })
    const hitDir = stack.dirs.some((dir) => dirs.has(dir))
    if (hitMarker || hitDir) found.push({ id: stack.id, label: stack.label, ignore: [...stack.ignore] })
  }
  return found
}

/**
 * Build `.gitignore` text from detected stacks; always includes the common tail.
 * @param {{ label: string, ignore?: string[] }[]} [stacks] detected stacks.
 * @param {string[]} [extra] extra lines to append.
 * @returns {string} file contents, newline-terminated.
 */
export function buildGitignore(stacks, extra = []) {
  const lines = []
  const seen = new Set()
  const push = (line) => {
    if (line === '' || seen.has(line)) return
    seen.add(line)
    lines.push(line)
  }
  for (const stack of stacks ?? []) {
    push(`# ${stack.label}`)
    for (const line of stack.ignore ?? []) push(line)
    lines.push('')
  }
  push('# Common')
  for (const line of COMMON_IGNORES) push(line)
  for (const line of extra ?? []) push(line)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

/**
 * Classify a repo-relative path as credential-looking, if it is.
 * @param {string} path repo-relative path, `/`-separated or native.
 * @returns {'file'|'dir'|undefined} why the path is suspicious, else undefined.
 */
export function sensitivePathKind(path) {
  const normalized = String(path).replace(/\\/g, '/')
  const segments = normalized.split('/')
  const base = segments[segments.length - 1]
  if (SENSITIVE_NAMES.some((re) => re.test(base))) return 'file'
  if (segments.some((segment) => segment === '.ssh' || segment === '.aws' || segment === '.gnupg')) return 'dir'
  return undefined
}

/**
 * Scan text content for credential signatures.
 * @param {string} text file contents.
 * @returns {string[]} matched signature ids.
 */
export function scanText(text) {
  const hits = []
  for (const signature of SENSITIVE_CONTENT) {
    /* The patterns have no `g` flag today, but resetting keeps a future edit
       from making the result depend on how often this function was called. */
    signature.re.lastIndex = 0
    if (signature.re.test(text)) hits.push(signature.id)
  }
  return hits
}

/**
 * Whether a path looks binary-by-extension and should skip content scanning.
 * @param {string} path repo-relative path.
 * @returns {boolean} true when the file should not be read as text.
 */
export function looksBinary(path) {
  return /\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tgz|7z|rar|xz|bz2|exe|dll|so|dylib|bin|dat|wasm|mp[34]|wav|ogg|webm|mov|avi|ttf|otf|woff2?|db|sqlite3?|gpk|jsc|pak|unity3d|assets)$/i
    .test(String(path))
}

/**
 * Human-readable byte size.
 * @param {number} bytes size in bytes.
 * @returns {string} e.g. `1.5 MB`, or an em dash when the size is unknown.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Normalize a project folder name into a valid GitHub repository name.
 * @param {string} [dir] directory path or name.
 * @returns {string} a GitHub-safe name, never empty.
 */
export function suggestRepoName(dir) {
  const base = String(dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? ''
  const cleaned = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '')
    .slice(0, 100)
  return cleaned.length > 0 ? cleaned : 'my-project'
}

/**
 * Pick a commit identity from explicit options, git facts, or a GitHub profile.
 *
 * The order matters: an identity the user already configured must win over the
 * GitHub account, otherwise a push would silently rewrite their authorship.
 * @param {object} [input] identity sources.
 * @param {{ gitUserName?: string, gitUserEmail?: string }} [input.options] explicit values.
 * @param {{ name?: string, email?: string }} [input.gitConfig] resolved git config.
 * @param {{ login?: string, id?: number }} [input.profile] authenticated viewer.
 * @returns {{ name: string, email: string }} a usable identity.
 */
export function resolveIdentity({ options, gitConfig, profile } = {}) {
  const name = firstNonEmpty(
    options?.gitUserName,
    gitConfig?.name,
    profile?.login,
    'dsh-github-aide',
  )
  const email = firstNonEmpty(
    options?.gitUserEmail,
    gitConfig?.email,
    profile?.id !== undefined && profile?.login !== undefined
      ? `${profile.id}+${profile.login}@users.noreply.github.com`
      : undefined,
    'dsh-github-aide@users.noreply.github.com',
  )
  return { name, email }
}

/** @param {Array<string|undefined>} values candidate strings, best first. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Re-export the shared redactor so one module owns the mask shapes.
 *
 * The upload plugin carried its own redactor; this plugin has exactly one, in
 * `lib/errors.js`, so every module masks credentials identically.
 */
export { redact } from './errors.js'

/**
 * Drop every `undefined` value from a result tree.
 *
 * Tool results must be lossless JSON, and `undefined` is not a JSON value: a
 * single absent optional field would make the whole call fail validation. The
 * result shapes here legitimately carry absent optionals (an unconfigured token
 * has no login, a fresh project has no remote), so absent means "omit" rather
 * than "null" — a null would falsely claim the value is known to be empty.
 * @template T
 * @param {T} value tree to clean.
 * @returns {T} the tree without undefined members.
 */
export function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (value !== null && typeof value === 'object') {
    const output = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      output[key] = stripUndefined(entry)
    }
    return output
  }
  return value
}
