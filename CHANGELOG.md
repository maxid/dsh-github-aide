# Changelog

本仓库的 tag 与 [DeepSeek Harness 官方版本](https://github.com/deepseek-ai/deepseek-harness/releases)一一对应，命名沿用官方的 `dsh-v<版本>`。一个 tag 表示"该插件状态已在这个 DSH 版本上验证"。

## dsh-v0.2.1-rc.5 — 2026-11-02

适配 DSH `0.2.1-rc.5`，同时保留 `0.2.1-rc.3` 支持。

### 新增

- `package.json` 增加 `engines.dsh: ">=0.2.1-rc.3 <0.3.0-0"`。此前只声明 `@deepseek-ai/dsh-*` peer 依赖，DSH 不做明确的版本区间判断；现在由 `engines.dsh` 主导（DSH 的规则是：声明了 `engines.dsh` 就忽略 peer 版本判断），行为更可预期。
- README 增加「版本对应（tag）」表、按 tag 安装说明和真实 DSH 版本验证步骤。
- 新增本 CHANGELOG。

### 变更

- 版本 `0.1.0` → `0.1.1`。

### 验证

- **DSH 0.2.1-rc.5**：把插件装进独立 profile，真实启动 Web 服务。`GET /plugins/dsh-github-aide/status` 返回 `capabilities.tools/credentials/webServer = true`，说明 `apply()` 在 rc.5 上成功注册了 3 个工具、设置命名空间和 4 条路由；`dsh-github-aide/client.js` 出现在 client bundle 图中并成功加载（`slots` 注册 `sidebar.panellist` 与 `main`，`locale` 注册 `github-aide` 命名空间）。
- **DSH 0.2.1-rc.3**：当前桌面版日常使用验证，工具 `github_publish` / `github_status` / `github_configure` 与 Web 面板均可用。
- 0.2.1-rc.4 与 rc.5 之间只有 ACP 诊断输出修复（见官方 release notes），与 rc.5 行为一致。

## dsh-v0.2.1-rc.3 — 2026-11-02

当前已发布状态（`0.1.0`）在 DSH `0.2.1-rc.3` 上的验证基线，作为 rc.3 对应的 tag。

## 0.1.0 — 2026-10-29

- 合并 `dsh-github-sync` 与 `dsh-github-upload` 为 `dsh-github-aide`：一套令牌解析、一套 GitHub REST 客户端、一套 git 层、一个设置命名空间。
- 修复 Node 22 上 GitHub 请求超时定时器被 unref 导致 Promise 不结算的问题。
