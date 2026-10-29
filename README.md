# dsh-github-aide

[English](README.en.md) | 简体中文

把项目发布到 GitHub 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件 —— 一个插件同时具备两件事：

- **发布当前工作区**：创建仓库、初始化 git、提交、处理远端分叉、推送；
- **上传任意项目目录**：只读预检、凭据扫描、按技术栈生成 `.gitignore`、一次性完成建仓与推送。

它由两个插件的能力合并而来：[`s-huizhuy-u/dsh-github-sync`](https://github.com/s-huizhuy-u/dsh-github-sync)（工作区同步、凭据库 token、分叉协调）与 [`3164481170/dsh-github-upload`](https://github.com/3164481170/dsh-github-upload)（项目预检、机密扫描、`.gitignore` 生成、Web 面板）。合并后只有**一套**令牌解析、一套 GitHub REST 客户端、一套 git 层、一个设置命名空间。

```
你：   把这个项目传到 GitHub

DSH：  已把 12 个变更文件发布到 maxid/my-project（分支 main）。
       仓库：https://github.com/maxid/my-project
```

## 功能

| 能力 | 说明 |
|---|---|
| **项目预检** | 目录内容、技术栈、体积、凭据扫描、git 状态、GitHub 账号、同名仓库是否存在 |
| **机密扫描** | 命中 `.env`、私钥、`ghp_*`、`AKIA*`、`sk-*`、私钥块等特征时默认**拦截发布** |
| **`.gitignore` 生成** | 项目没有 `.gitignore` 时按识别到的技术栈生成；已有则不改动 |
| **创建仓库** | GitHub 上不存在就创建（默认私有），已存在则复用 |
| **初始化 git** | 只在还不是仓库时执行；沿用已有分支，新仓库用 `main` |
| **提交** | 暂存整棵工作树并提交；无变更时复用 `HEAD`，不报错 |
| **处理远端分叉** | 推送前先 fetch + rebase；冲突时回滚并报告 `REBASE_CONFLICT` |
| **推送** | 只把令牌交给内存中的 askpass，`origin` 始终是干净的 HTTPS URL |
| **只读预览** | `github_status` / `dryRun` 报告将要做什么，不写任何文件、不建仓库 |
| **Web 面板** | 侧边栏填写令牌与目录 → 预检 → 发布 |

## 环境要求

- DeepSeek Harness **0.2.1** 或更高（已在 `0.2.1-rc.3` 上验证加载）
- Node.js **22+**
- `PATH` 中有 `git`（不需要 `gh` CLI）
- 一个 GitHub personal access token

## 安装

推荐用 DSH 的插件命令（profile 名按你的实际环境替换）：

```bash
dsh plugin --profile desktop add "link:$PWD"
```

或把仓库目录复制进 profile 后，用附带脚本完成声明（脚本会打印每一个写入路径，可重复执行）：

```bash
node scripts/install.mjs --profile desktop
```

装完重启 DSH。脚本会把插件放到 `<profile>/.local-plugins/` 与 `<profile>/node_modules/`，加入 `dsh.profile.bundles`，并把加载行写进 `cordis.patch.yml`。

## 认证

需要一个 GitHub personal access token，按优先级三种来源：

1. **环境变量** `GITHUB_TOKEN`，其次 `GH_TOKEN`（适合 CI，不在磁盘留痕）；
2. **对话里存**：说「存一下我的 GitHub token」，助手调用 `github_configure`；
3. **面板**：侧边栏「GitHub 发布」→ 填令牌 → 保存并校验。

**权限要求：**

| token 类型 | 需要的权限 |
|---|---|
| classic | `repo`（只发公开仓库可用 `public_repo`） |
| fine-grained | **Contents: Read and write**；若让插件建仓库还需 **Administration: Read and write**（或账户级 **Repository creation**） |

存储的令牌保存在 DSH **凭据库**（`github-aide` 作用域），不会写进 `settings.yaml`。所有 token 形态在进入日志或对话前都会被遮蔽，包括 git 报错时回显 remote URL 的情况。

## 工具

### `github_publish` —— 发布

| 参数 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `path` | string | 工作区根目录 | 要发布的项目目录 |
| `repo` | string | 目录名 slug 化 | 仓库名 |
| `owner` | string | 配置值 → token 所属用户 | 仓库所有者 |
| `description` | string | — | 仓库描述（仅创建时生效） |
| `visibility` | `private` \| `public` \| `internal` | 配置值 → `private` | 新仓库可见性 |
| `private` | boolean | — | 兼容简写：`true` 私有、`false` 公开 |
| `branch` | string | 当前分支 → 配置值 → `main` | 推送分支 |
| `commitMessage` | string | 自动 | 提交信息 |
| `autoInit` | boolean | `false` | 是否让 GitHub 创建首个提交 |
| `allowSensitive` | boolean | `false` | 扫描命中仍继续（慎用） |
| `autoIgnore` | boolean | `true` | 无 `.gitignore` 时自动生成 |
| `push` | boolean | `true` | `false` 则只在本地提交 |
| `force` | boolean | `false` | 历史冲突时覆盖远端分支（始终 `--force-with-lease`） |
| `dryRun` | boolean | `false` | 只预演，不写文件、不建仓库、不推送 |

### `github_status` —— 只读预检

`github_status(path?)` 返回：解析后的仓库名/所有者/分支、项目技术栈与文件数、凭据扫描命中、git 状态、远端仓库是否存在、令牌来源，以及待处理的 harness 升级提醒。不做任何写入。

### `github_configure` —— 令牌

| 参数 | 类型 | 含义 |
|---|---|---|
| `token` | string | 校验并保存 token（永不回显） |
| `clear` | boolean | 删除已保存的 token |

## Web 面板

侧边栏「GitHub 发布」：

1. 填令牌 → 保存并校验（显示账号与 scope）；
2. 填项目目录（默认工作区根目录）；
3. **预检（只读）** 查看技术栈、扫描命中、仓库是否存在；
4. **发布**：`dryRun` 可先预演；`allowSensitive` 放行扫描命中。

面板只拿到布尔值、账号名和结果，令牌从不离开 Host。

## 设置

命名空间 **`github-aide`**，可在 **设置 → 插件** 中编辑，也可在 profile 的 `cordis.patch.yml` 里配置：

| 键 | 默认值 | 含义 |
|---|---|---|
| `owner` | 空 | 新仓库所属账号；空表示 token 自己的用户 |
| `visibility` | `private` | 新仓库可见性 |
| `autoInit` | `false` | 是否让 GitHub 创建首个提交（保持关闭，首次推送才不会被拒） |
| `branch` | 空 | 推送分支；空表示沿用当前分支，再退到 `main` |
| `commitMessage` | 空 | 提交信息；空表示新仓库 `Initial commit`、之后 `chore: publish` |
| `allowSensitive` | `false` | 允许发布扫描到凭据的项目 |
| `autoIgnore` | `true` | 无 `.gitignore` 时自动生成 |
| `timeoutMs` | `600000` | 单次发布超时（毫秒） |
| `maxScanFiles` | `8000` | 凭据扫描文件数上限 |

```yaml
- id: github-aide
  name: dsh-github-aide
  config:
    owner: maxid
    visibility: private
    timeoutMs: 600000
```

## 安全设计

- **令牌永不落盘**：`origin` 始终是 `https://github.com/<owner>/<repo>.git`，令牌只通过内存中的 `GIT_ASKPASS` 子进程环境传递，不进入 argv、`.git/config` 或任何 git 配置文件。
- **git 永不弹出提示**：每次调用都带 `GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=`、`GCM_INTERACTIVE=never`；认证失败会直接报错，而不是挂到超时。
- **凭据扫描默认拦截**：命中特征时中止，需要显式 `allowSensitive=true` 才继续；扫描不跟随符号链接。
- **远端分叉是协调，不是覆盖**：先 fetch + rebase，`force` 也只用 `--force-with-lease`。
- **日志脱敏**：错误、警告、git stderr 都先经过 `redact`，任何 URL 里的 `user:token@` 和 Bearer 都被遮蔽。
- **并发安全**：`github_publish` 声明 `isConcurrencySafe: false`，同一目录两次 git 不会撞索引锁。

## HTTP 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/plugins/dsh-github-aide/status` | 令牌状态、默认值、工作区、能力 |
| `POST` | `/plugins/dsh-github-aide/preflight` | 只读预检（`{ path? }`） |
| `POST` | `/plugins/dsh-github-aide/publish` | 发布（参数同工具） |
| `POST` | `/plugins/dsh-github-aide/config` | `{ token }` / `{ clear: true }` / `{}` 校验 |

路由只接受同源/回环请求。

## 验证

```bash
node --test test/*.test.mjs     # 128 项：纯逻辑 + 假 API + 真实 git 的离线端到端
node test/verify.mjs            # 32 项，自带的轻量断言运行器
node scripts/apply-harness.mjs  # 12 项：用假 Cordis ctx 验证 apply() 注册 3 个工具、4 条路由、1 个设置命名空间
node scripts/live-smoke.mjs     # 11 项：真实 git + 本地 bare 仓库的发布/分叉/冲突/强制推送
node scripts/http-check.mjs http://127.0.0.1:PORT  # 对已启动的 host 做 HTTP 探测（未安装时自动跳过）
```

全部离线运行，不需要 DSH 包、不联网、不需要真实 GitHub 令牌。

## 目录结构

```
index.js          Host 半：设置、3 个 agent 工具、HTTP 路由
client.js         Web 面板
lib/config.js     设置默认值 + 凭据库 token 存取
lib/github.js     最小 GitHub REST 客户端（viewer / scopes / 查仓库 / 建仓库）
lib/git.js        git 子进程封装 + 内存 askpass + force-with-lease
lib/detect.js     技术栈识别、.gitignore、凭据特征、身份推导
lib/scan.js       有界目录遍历 + 凭据扫描（不跟随符号链接）
lib/publish.js    预检与发布编排（依赖注入，可离线测）
lib/workspace.js  工作区/目录解析、仓库名 slug
lib/errors.js     统一错误类型 + 脱敏
lib/update-notice.js  harness 升级提醒
scripts/          安装、升级监视、离线冒烟、HTTP 校验
```

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `No GitHub token is configured` | 设置 `GITHUB_TOKEN`，或用 `github_configure` 存一个，然后重启 DSH |
| `HTTP 401` / `TOKEN_REJECTED` | token 过期或错误，重新签发 |
| `HTTP 403` / `PERMISSION` | 按返回的 `x-accepted-github-permissions` 补权限（fine-grained 通常是 `contents=write`、`administration=write` 或 `repository_creation=write`） |
| 自己的仓库却 404 | fine-grained token 需要勾选该仓库，并授予 Contents 写权限 |
| `SENSITIVE_BLOCKED` | 检查扫描命中的文件；确认无风险后带 `allowSensitive=true` 重试 |
| `REBASE_CONFLICT` | 在项目里手动解决冲突，或带 `force` 重跑（仅 `--force-with-lease`） |
| `PUSH_REJECTED` | 重试；`non-fast-forward` 会提示先 rebase 或用 `force` |
| `TLS_UNTRUSTED` | TLS 中间人代理/加速器：把其根证书 PEM 指给 `NODE_EXTRA_CA_CERTS` 后重启 DSH |
| `GIT_MISSING` | 安装 git 并重启 DSH，让新 `PATH` 生效 |
| 插件不出现 | 确认 `cordis.patch.yml` 有加载行、包在 profile 的 `node_modules/` 下，然后重启 |

## 许可证

MIT —— 见 [LICENSE](LICENSE)。行为与部分实现来自上述两个 MIT/开源插件，感谢原作者；见 [NOTICE](NOTICE.md)。
