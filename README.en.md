# dsh-github-aide

English | [简体中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that publishes a project to GitHub — both jobs in one plugin:

- **sync the current workspace**: create the repository, initialize git, commit, reconcile a diverged remote, push;
- **upload any project directory**: read-only preflight, secret scan, stack-aware `.gitignore` generation, repository creation and push in one call.

It merges [`s-huizhuy-u/dsh-github-sync`](https://github.com/s-huizhuy-u/dsh-github-sync) (workspace sync, credential-store token, divergence handling) and [`3164481170/dsh-github-upload`](https://github.com/3164481170/dsh-github-upload) (preflight, secret scan, `.gitignore` generation, web panel) into **one** token resolver, one GitHub REST client, one git layer, and one settings namespace.

```
You:   put this project on GitHub

DSH:  Published 12 changed files to maxid/my-project (branch main).
      Repository: https://github.com/maxid/my-project
```

## Features

| Capability | Detail |
|---|---|
| **Preflight** | directory contents, stack, size, secret scan, git state, GitHub account, whether the repository exists |
| **Secret scan** | `.env`, private keys, `ghp_*`, `AKIA*`, `sk-*`, key blocks — blocks the publish by default |
| **`.gitignore` generation** | written from the detected stack when the project has none; an existing file is never touched |
| **Repository creation** | created on demand (private by default), reused when present |
| **git initialization** | only when the directory is not a repository; keeps the current branch, `main` for a new one |
| **Commit** | stages the whole tree; when nothing changed, `HEAD` is reused instead of failing |
| **Divergence** | fetch + rebase before pushing; a conflict is rolled back and reported as `REBASE_CONFLICT` |
| **Push** | the token only ever reaches an in-memory `GIT_ASKPASS`; `origin` stays a clean HTTPS URL |
| **Read-only preview** | `github_status` / `dryRun` report what would happen without writing anything |
| **Web panel** | sidebar: token → directory → preflight → publish |

## Requirements

- DeepSeek Harness **0.2.1+** (verified on `0.2.1-rc.3`)
- Node.js **22+**
- `git` on `PATH` (no `gh` CLI needed)
- A GitHub personal access token

## Install

Prefer DSH's plugin command (profile name may differ):

```bash
dsh plugin --profile desktop add "link:$PWD"
```

Or copy the repository into a profile and run the bundled, idempotent installer (it prints every path it writes):

```bash
node scripts/install.mjs --profile desktop
```

Restart DSH afterwards. The installer copies the plugin into `<profile>/.local-plugins/` and `<profile>/node_modules/`, adds it to `dsh.profile.bundles`, and appends the loader row to `cordis.patch.yml`.

## Authentication

A GitHub personal access token, from three sources in priority order:

1. **environment** `GITHUB_TOKEN`, then `GH_TOKEN` (best for CI, leaves nothing on disk);
2. **chat** — ask the assistant to store it; it calls `github_configure`;
3. **panel** — sidebar → GitHub Aide → paste → save and verify.

**Permissions:**

| token type | required |
|---|---|
| classic | `repo` (`public_repo` is enough for public-only) |
| fine-grained | **Contents: Read and write**; **Administration: Read and write** (or account-level **Repository creation**) if the plugin should create repositories |

The token is stored in the DSH **credential store** (`github-aide` scope), never in `settings.yaml`. Every token shape is redacted before it reaches a log or the transcript — including git's habit of quoting the remote URL back in errors.

## Tools

### `github_publish`

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | workspace root | project directory to publish |
| `repo` | string | slug of the directory name | repository name |
| `owner` | string | configured → token user | repository owner |
| `description` | string | — | repository description (creation only) |
| `visibility` | `private` \| `public` \| `internal` | configured → `private` | visibility for a new repository |
| `private` | boolean | — | shorthand: `true` private, `false` public |
| `branch` | string | current → configured → `main` | branch to push |
| `commitMessage` | string | generated | commit message |
| `autoInit` | boolean | `false` | let GitHub create the first commit |
| `allowSensitive` | boolean | `false` | continue despite secret-scan hits (not recommended) |
| `autoIgnore` | boolean | `true` | generate a `.gitignore` when missing |
| `push` | boolean | `true` | `false` commits locally only |
| `force` | boolean | `false` | replace a diverged remote (always `--force-with-lease`) |
| `dryRun` | boolean | `false` | preview only: no writes, no repository, no push |

### `github_status`

`github_status(path?)` reports the resolved repository coordinates, detected stacks and file count, secret-scan hits, git state, whether the repository exists, token source, and any pending harness-update notice. It changes nothing.

### `github_configure`

| Parameter | Type | Meaning |
|---|---|---|
| `token` | string | verify and store (never echoed) |
| `clear` | boolean | remove the stored token |

## Web panel

Sidebar → **GitHub Aide**:

1. paste a token → save and verify (shows account and scopes);
2. project directory (defaults to the workspace root);
3. **Preflight (read-only)** — stacks, scan hits, repository existence;
4. **Publish** — `dryRun` previews; `allowSensitive` overrides the scan.

The browser half only ever receives booleans, logins, and result facts; the token never leaves the Host.

## Settings

Namespace **`github-aide`**, editable under **Settings → Plugins** or in the profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `owner` | empty | owner for new repositories; empty means the token's own user |
| `visibility` | `private` | visibility for new repositories |
| `autoInit` | `false` | let GitHub create the first commit (keep off so the first push is accepted) |
| `branch` | empty | branch to push; empty keeps the current branch, then `main` |
| `commitMessage` | empty | commit message; empty means `Initial commit` then `chore: publish` |
| `allowSensitive` | `false` | allow publishing a project the scan flagged |
| `autoIgnore` | `true` | generate a `.gitignore` when missing |
| `timeoutMs` | `600000` | timeout for one publish (ms) |
| `maxScanFiles` | `8000` | file budget for the secret scan |

```yaml
- id: github-aide
  name: dsh-github-aide
  config:
    owner: maxid
    visibility: private
    timeoutMs: 600000
```

## Security design

- **The token never lands on disk.** `origin` is always `https://github.com/<owner>/<repo>.git`; the token reaches git only through an in-memory `GIT_ASKPASS` child environment — never argv, `.git/config`, or any git config file.
- **git never prompts.** Every call sets `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, and `GCM_INTERACTIVE=never`; an authentication failure errors out instead of hanging on a console that does not exist.
- **Secret scan blocks by default.** A hit aborts the publish unless `allowSensitive=true`; the scan never follows symlinks.
- **Divergence is reconciliation, not overwrite.** Fetch + rebase first; `force` still uses `--force-with-lease`.
- **Logs are redacted.** Errors, warnings and git stderr pass through `redact`; `user:token@` userinfo and Bearer values are masked.
- **Concurrency-safe by contract.** `github_publish` declares `isConcurrencySafe: false`, so two git runs never collide on one index lock.

## HTTP routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/plugins/dsh-github-aide/status` | token state, defaults, workspace, capabilities |
| `POST` | `/plugins/dsh-github-aide/preflight` | read-only preflight (`{ path? }`) |
| `POST` | `/plugins/dsh-github-aide/publish` | publish (tool arguments) |
| `POST` | `/plugins/dsh-github-aide/config` | `{ token }` / `{ clear: true }` / `{}` verify |

Routes accept only same-origin/loopback requests.

## Verification

```bash
node --test test/*.test.mjs     # 128 checks: pure logic + fake API + real git, offline
node test/verify.mjs            # 32 checks, self-contained runner
node scripts/apply-harness.mjs  # 12 checks: fake Cordis ctx, apply() registers 3 tools, 4 routes, 1 settings namespace
node scripts/live-smoke.mjs     # 11 checks: real git against a local bare remote
node scripts/http-check.mjs http://127.0.0.1:PORT  # probe a running host (skips when the plugin is not mounted)
```

Everything runs offline: no DSH packages, no network, no real GitHub token.

## Layout

```
index.js          host half: settings, three agent tools, HTTP routes
client.js         web panel
lib/config.js     settings defaults + credential-store token
lib/github.js     minimal GitHub REST client (viewer / scopes / find / create)
lib/git.js        git subprocess layer + in-memory askpass + force-with-lease
lib/detect.js     stack detection, .gitignore, secret signatures, identity
lib/scan.js       bounded traversal + secret scan (never follows symlinks)
lib/publish.js    preflight + publish orchestration (dependency-injected, offline-testable)
lib/workspace.js  workspace/path resolution, repository slugs
lib/errors.js     one error type + redaction
lib/update-notice.js  harness upgrade notice
scripts/          installer, update watcher, offline smoke, HTTP check
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No GitHub token is configured` | set `GITHUB_TOKEN`, store one with `github_configure`, then restart DSH |
| `HTTP 401` / `TOKEN_REJECTED` | expired or wrong token; reissue |
| `HTTP 403` / `PERMISSION` | grant what `x-accepted-github-permissions` asks for (`contents=write`, `administration=write`, or `repository_creation=write` for fine-grained) |
| 404 for your own repository | a fine-grained token must select the repository and grant Contents write |
| `SENSITIVE_BLOCKED` | review the flagged files; retry with `allowSensitive=true` only when safe |
| `REBASE_CONFLICT` | resolve the conflict in the project, or retry with `force` (`--force-with-lease` only) |
| `PUSH_REJECTED` | retry; a non-fast-forward asks for a rebase or `force` |
| `TLS_UNTRUSTED` | TLS-interception proxy: point `NODE_EXTRA_CA_CERTS` at its root PEM and restart DSH |
| `GIT_MISSING` | install git and restart DSH so the new `PATH` applies |
| Plugin missing | check the loader row in `cordis.patch.yml` and the package under the profile's `node_modules/`, then restart |

## License

MIT — see [LICENSE](LICENSE). Behaviour and parts of the implementation come from the two upstream plugins; see [NOTICE](NOTICE.md).
