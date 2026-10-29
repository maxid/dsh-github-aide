window.__ModuleLoader__.load({
  id: 'dsh-github-aide',
  factory(require) {
    const React = require('react')
    const jsx = require('react/jsx-runtime')
    const h = React.createElement

    const STATUS_PATH = '/plugins/dsh-github-aide/status'
    const PREFLIGHT_PATH = '/plugins/dsh-github-aide/preflight'
    const PUBLISH_PATH = '/plugins/dsh-github-aide/publish'
    const CONFIG_PATH = '/plugins/dsh-github-aide/config'

    // ---------- styles (theme tokens only) ----------

    const page = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 860,
      margin: '0 auto',
      padding: '28px 24px 48px',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      color: 'var(--dsw-alias-label-primary)'
    }
    const headingRow = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexWrap: 'wrap', gap: 12
    }
    const title = { margin: 0, fontSize: 18, lineHeight: '26px', fontWeight: 600 }
    const subtitle = { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
    const button = {
      boxSizing: 'border-box', minHeight: 32, padding: '5px 14px',
      border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 16,
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      font: 'inherit', fontSize: 13, cursor: 'pointer'
    }
    const primaryButton = {
      ...button,
      border: '1px solid var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))',
      background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))',
      color: 'var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base))'
    }
    const dangerButton = { ...button, color: 'var(--dsw-alias-state-error-primary)' }
    const card = {
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: '14px 16px', border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)'
    }
    const rowBetween = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }
    const label = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
    const value = { fontSize: 14, lineHeight: '20px', fontWeight: 500 }
    const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, overflowWrap: 'anywhere' }
    const input = {
      boxSizing: 'border-box', width: '100%', minHeight: 32, padding: '5px 10px',
      border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
      background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
      font: 'inherit', fontSize: 13
    }
    const fieldRow = { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 200px', minWidth: 0 }
    const grid2 = { display: 'flex', gap: 12, flexWrap: 'wrap' }
    const errorText = { ...label, color: 'var(--dsw-alias-state-error-primary)' }
    const warnText = { ...label, color: 'var(--dsw-alias-state-warn-primary)' }
    const okText = { ...label, color: 'var(--dsw-alias-state-success-primary)' }
    const list = { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }
    const chip = {
      display: 'inline-block', padding: '1px 8px', borderRadius: 10,
      border: '1px solid var(--dsw-alias-border-l2)', fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)'
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let v = bytes, i = 0
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
      return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
    }

    // ---------- small pieces ----------

    function Kv({ k, children, style }) {
      return jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, ...style }, children: [
        jsx.jsx('span', { style: label, children: k }),
        jsx.jsx('span', { style: value, children })
      ] })
    }

    function Bullets({ items, style }) {
      if (!Array.isArray(items) || items.length === 0) return null
      return jsx.jsx('ul', { style: { ...list, ...style }, children: items.map((item, i) =>
        jsx.jsx('li', { key: i, style: label }, item)) })
    }

    function Chips({ items }) {
      if (!Array.isArray(items) || items.length === 0) return null
      return jsx.jsx('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' }, children: items.map(name =>
        jsx.jsx('span', { style: chip, key: name, children: name })) })
    }

    /** One credential finding: a path plus how it was classified. */
    function SensitiveList({ findings }) {
      if (!Array.isArray(findings) || findings.length === 0) return null
      return jsx.jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 }, children: [
        jsx.jsx('span', { style: warnText, children: `扫描到 ${findings.length} 处疑似凭据（默认会被拦下）：` }),
        jsx.jsx('ul', { style: list, children: findings.slice(0, 50).map((finding, i) =>
          jsx.jsx('li', { key: i, style: { ...mono, color: 'var(--dsw-alias-label-secondary)' }, children:
            `${finding.path}${finding.kind ? ` · ${finding.kind}` : ''}` })) })
      ] })
    }

    // ---------- main panel ----------

    function AidePage() {
      const [status, setStatus] = React.useState(undefined)
      const [path, setPath] = React.useState('')
      const [repo, setRepo] = React.useState('')
      const [owner, setOwner] = React.useState('')
      const [visibility, setVisibility] = React.useState('private')
      const [branch, setBranch] = React.useState('')
      const [allowSensitive, setAllowSensitive] = React.useState(false)
      const [dryRun, setDryRun] = React.useState(false)
      const [pre, setPre] = React.useState(undefined)
      const [result, setResult] = React.useState(undefined)
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState(undefined)
      const [tokenInput, setTokenInput] = React.useState('')
      const seq = React.useRef(0)

      const loadStatus = React.useCallback(async () => {
        try {
          const response = await fetch(STATUS_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          const body = await response.json().catch(() => undefined)
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          // Routes reply `{ ok, result }`; a flat body is still accepted.
          const info = body?.result ?? body
          setStatus(info)
          // Seed the form from the host without depending on `path`, so this
          // callback stays stable and the effect does not re-run per keystroke.
          setPath(current => current === '' && typeof info?.workspaceRoot === 'string' ? info.workspaceRoot : current)
          const defaults = info?.defaults ?? {}
          if (typeof defaults.visibility === 'string') setVisibility(defaults.visibility)
          else if (info?.defaultPrivate !== undefined) setVisibility(info.defaultPrivate === false ? 'public' : 'private')
          if (typeof defaults.branch === 'string') setBranch(defaults.branch)
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }, [])

      React.useEffect(() => { loadStatus() }, [loadStatus])

      const post = React.useCallback(async (url, payload) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload ?? {})
        })
        const body = await response.json().catch(() => undefined)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return body
      }, [])

      /** Responses are `{ ok, result }`; accept a flat result defensively. */
      const unwrap = body => body?.result ?? body

      const doPreflight = React.useCallback(async () => {
        const id = ++seq.current
        setBusy('preflight'); setError(undefined); setResult(undefined)
        try {
          const body = await post(PREFLIGHT_PATH, {
            path: path || undefined,
            repo: repo || undefined,
            owner: owner || undefined,
            visibility,
            branch: branch || undefined,
            allowSensitive
          })
          if (seq.current !== id) return
          if (body?.ok === false && body?.result === undefined) {
            setError(body?.error ?? '预检失败')
            setPre(undefined)
          } else {
            setPre(unwrap(body))
          }
        } catch (caught) {
          if (seq.current === id) setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          if (seq.current === id) setBusy('')
        }
      }, [path, repo, owner, visibility, branch, allowSensitive, post])

      const doPublish = React.useCallback(async () => {
        const id = ++seq.current
        setBusy(dryRun ? 'dry' : 'publish'); setError(undefined); setResult(undefined)
        try {
          const body = await post(PUBLISH_PATH, {
            path: path || undefined,
            repo: repo || undefined,
            owner: owner || undefined,
            visibility,
            branch: branch || undefined,
            allowSensitive,
            dryRun
          })
          if (seq.current !== id) return
          if (body?.ok === true && body?.result === undefined) {
            // No result means the host reported an error string; surface it.
            setError(body?.error ?? '发布失败')
          } else if (body?.ok === false && body?.result === undefined) {
            setError(body?.error ?? '发布失败')
          } else {
            setResult(unwrap(body))
          }
          loadStatus()
        } catch (caught) {
          if (seq.current === id) setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          if (seq.current === id) setBusy('')
        }
      }, [path, repo, owner, visibility, branch, allowSensitive, dryRun, post, loadStatus])

      const saveToken = React.useCallback(async () => {
        if (tokenInput.trim().length === 0) return
        setBusy('token'); setError(undefined)
        try {
          const body = await post(CONFIG_PATH, { token: tokenInput.trim() })
          const outcome = body?.result ?? body
          if (body?.ok === false || outcome?.ok === false) {
            setError(outcome?.error ?? outcome?.summary ?? body?.error ?? '令牌校验失败')
          } else { setTokenInput(''); await loadStatus() }
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy('')
        }
      }, [tokenInput, post, loadStatus])

      const verifyToken = React.useCallback(async () => {
        setBusy('verify'); setError(undefined)
        try {
          const body = await post(CONFIG_PATH, {})
          const outcome = body?.result ?? body
          if (body?.ok === false || outcome?.ok === false) {
            setError(outcome?.error ?? outcome?.summary ?? body?.error ?? '令牌不可用')
          }
          await loadStatus()
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy('')
        }
      }, [post, loadStatus])

      const clearToken = React.useCallback(async () => {
        setBusy('token'); setError(undefined)
        try {
          const body = await post(CONFIG_PATH, { clear: true })
          if (body?.ok === false) setError(body?.error ?? '清除失败')
          await loadStatus()
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught))
        } finally {
          setBusy('')
        }
      }, [post, loadStatus])

      const tokenConfigured = status?.tokenConfigured === true
        || status?.token?.configured === true
        || status?.token_state?.configured === true
      const login = status?.account?.login ?? status?.viewer?.login ?? status?.token?.login
      const scopes = status?.account?.scopes ?? status?.token?.scopes
      const workspaceRoot = status?.workspaceRoot ?? status?.workspace_root

      return jsx.jsxs('div', { style: page, children: [
        jsx.jsxs('div', { style: headingRow, children: [
          jsx.jsxs('div', { children: [
            jsx.jsx('h1', { style: title, children: 'GitHub Aide' }),
            jsx.jsx('p', { style: subtitle, children: '预检 → 生成 .gitignore → 提交 → 建仓库/复用 → 推送。只需要 git 与一个令牌；令牌只存在凭据存储与内存 askpass 里。' })
          ] }),
          jsx.jsx('button', { type: 'button', style: button, disabled: busy !== '', onClick: loadStatus, children: '刷新状态' })
        ] }),

        error === undefined ? null : jsx.jsx('p', { style: errorText, children: `错误：${error}` }),

        // ---- token ----
        jsx.jsxs('div', { style: card, children: [
          jsx.jsxs('div', { style: rowBetween, children: [
            jsx.jsx('span', { style: value, children: '访问令牌' }),
            jsx.jsx('span', { style: tokenConfigured ? okText : errorText, children:
              status === undefined ? '读取中…'
                : tokenConfigured
                  ? `已配置${login !== undefined ? `（${login}）` : ''}`
                  : '未配置' })
          ] }),
          jsx.jsxs('div', { style: label, children: [
            '令牌保存在 DSH 凭据存储中（环境变量 ',
            jsx.jsx('code', { style: mono, children: 'GITHUB_TOKEN' }),
            ' / ',
            jsx.jsx('code', { style: mono, children: 'GH_TOKEN' }),
            ' 优先），需要 ',
            jsx.jsx('code', { style: mono, children: 'repo' }),
            ' 权限。'
          ] }),
          scopes === undefined ? null : jsx.jsx('span', { style: label, children: `令牌权限：${scopes || '(未报告)'}` }),
          jsx.jsxs('div', { style: { ...grid2, alignItems: 'flex-end' }, children: [
            jsx.jsxs('div', { style: fieldRow, children: [
              jsx.jsx('span', { style: label, children: '新的令牌（留空则不修改）' }),
              jsx.jsx('input', {
                type: 'password', style: input, value: tokenInput,
                placeholder: 'ghp_… 或 github_pat_…',
                onChange: event => setTokenInput(event.target.value)
              })
            ] }),
            jsx.jsx('button', { type: 'button', style: primaryButton, disabled: busy !== '' || tokenInput.trim().length === 0, onClick: saveToken, children: busy === 'token' ? '保存中…' : '保存并校验' }),
            jsx.jsx('button', { type: 'button', style: button, disabled: busy !== '' || !tokenConfigured, onClick: verifyToken, children: busy === 'verify' ? '校验中…' : '校验' }),
            jsx.jsx('button', { type: 'button', style: dangerButton, disabled: busy !== '' || !tokenConfigured, onClick: clearToken, children: '清除' })
          ] })
        ] }),

        // ---- target ----
        jsx.jsxs('div', { style: card, children: [
          jsx.jsx('span', { style: value, children: '目标项目' }),
          jsx.jsxs('div', { style: fieldRow, children: [
            jsx.jsx('span', { style: label, children: '项目目录（留空用当前工作区根目录）' }),
            jsx.jsx('input', { type: 'text', style: input, value: path, placeholder: workspaceRoot ?? '/path/to/project', onChange: event => setPath(event.target.value) })
          ] }),
          jsx.jsxs('div', { style: grid2, children: [
            jsx.jsxs('div', { style: fieldRow, children: [
              jsx.jsx('span', { style: label, children: '仓库名（留空按目录名推导）' }),
              jsx.jsx('input', { type: 'text', style: input, value: repo, placeholder: 'my-project', onChange: event => setRepo(event.target.value) })
            ] }),
            jsx.jsxs('div', { style: fieldRow, children: [
              jsx.jsx('span', { style: label, children: '账号/组织（留空用令牌所属账号）' }),
              jsx.jsx('input', { type: 'text', style: input, value: owner, placeholder: 'octocat', onChange: event => setOwner(event.target.value) })
            ] }),
            jsx.jsxs('div', { style: fieldRow, children: [
              jsx.jsx('span', { style: label, children: '可见性' }),
              jsx.jsx('select', {
                style: input, value: visibility,
                onChange: event => setVisibility(event.target.value)
              }, ['private', 'public', 'internal'].map(option =>
                jsx.jsx('option', { key: option, value: option, children: option === 'private' ? '私有' : option === 'public' ? '公开' : '组织内部' })))
            ] }),
            jsx.jsxs('div', { style: fieldRow, children: [
              jsx.jsx('span', { style: label, children: '分支（留空沿用现有分支/默认 main）' }),
              jsx.jsx('input', { type: 'text', style: input, value: branch, placeholder: 'main', onChange: event => setBranch(event.target.value) })
            ] })
          ] }),
          jsx.jsxs('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' }, children: [
            jsx.jsxs('label', { style: { ...label, display: 'flex', alignItems: 'center', gap: 8 }, children: [
              jsx.jsx('input', { type: 'checkbox', checked: allowSensitive, onChange: event => setAllowSensitive(event.target.checked) }),
              '发现疑似凭据也继续（allowSensitive）'
            ] }),
            jsx.jsxs('label', { style: { ...label, display: 'flex', alignItems: 'center', gap: 8 }, children: [
              jsx.jsx('input', { type: 'checkbox', checked: dryRun, onChange: event => setDryRun(event.target.checked) }),
              '仅预演，不写入也不推送（dryRun）'
            ] })
          ] }),
          jsx.jsxs('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' }, children: [
            jsx.jsx('button', { type: 'button', style: button, disabled: busy !== '', onClick: doPreflight, children: busy === 'preflight' ? '预检中…' : '预检（只读）' }),
            jsx.jsx('button', {
              type: 'button',
              style: primaryButton,
              disabled: busy !== '',
              onClick: doPublish,
              children: busy === 'dry' || busy === 'publish'
                ? (dryRun ? '预演中…' : '发布中…')
                : (dryRun ? '预演（不推送）' : '发布到 GitHub')
            })
          ] })
        ] }),

        // ---- preflight ----
        pre === undefined ? null : jsx.jsxs('div', { style: card, children: [
          jsx.jsxs('div', { style: rowBetween, children: [
            jsx.jsx('span', { style: value, children: '预检结果' }),
            jsx.jsx('span', { style: pre.ok === true ? okText : errorText, children: pre.ok === true ? '可以发布' : '存在问题' })
          ] }),
          jsx.jsx('span', { style: label, children: pre.summary ?? '' }),
          jsx.jsxs('div', { style: grid2, children: [
            jsx.jsx(Kv, { k: '仓库', children: `${pre.owner ?? '?'}/${pre.repo ?? '?'}` }),
            jsx.jsx(Kv, { k: '分支 / 可见性', children: `${pre.branch ?? '?'} · ${pre.visibility ?? '?'}` }),
            jsx.jsx(Kv, { k: '项目', children: `${pre.project?.files ?? '?'} 个文件 · ${formatBytes(pre.project?.bytes)}` }),
            jsx.jsx(Kv, { k: 'git', children: pre.git?.isRepo === true ? `已初始化 · ${pre.git?.changed ?? 0} 个变更 · ${pre.git?.branch || '未提交'}` : '尚未初始化' }),
            jsx.jsx(Kv, {
              k: '远端仓库',
              children: pre.repoExists === true ? '已存在，将直接推送'
                : pre.repoExists === false ? '将新建'
                  : '未知（未配置令牌）'
            }),
            jsx.jsx(Kv, { k: '令牌来源', children: pre.token_source || '未配置' })
          ] }),
          jsx.jsx(Chips, { items: pre.project?.stacks }),
          pre.project?.truncated === true ? jsx.jsx('span', { style: warnText, children: '文件数量超过扫描上限，扫描结果可能不完整。' }) : null,
          pre.project?.hasGitignore === false ? jsx.jsx('span', { style: warnText, children: '项目没有 .gitignore，发布会自动生成一份。' }) : null,
          jsx.jsx(SensitiveList, { findings: pre.project?.sensitive }),
          pre.next_step ? jsx.jsx('span', { style: label, children: `下一步：${pre.next_step}` }) : null
        ] }),

        // ---- result ----
        result === undefined ? null : jsx.jsxs('div', { style: card, children: [
          jsx.jsxs('div', { style: rowBetween, children: [
            jsx.jsx('span', { style: value, children: result.dry_run === true ? '预演结果' : '发布结果' }),
            jsx.jsx('span', { style: result.ok === true ? okText : errorText, children: result.ok === true ? (result.dry_run === true ? '预演通过' : '成功') : '失败' })
          ] }),
          jsx.jsx('span', { style: label, children: result.summary ?? '' }),
          result.html_url ? jsx.jsxs('div', { style: label, children: [
            '仓库地址：',
            jsx.jsx('a', { href: result.html_url, target: '_blank', rel: 'noreferrer', style: { ...mono, color: 'var(--dsw-alias-brand-primary)' }, children: result.html_url })
          ] }) : null,
          jsx.jsxs('div', { style: grid2, children: [
            jsx.jsx(Kv, { k: '仓库', children: `${result.owner || '?'}/${result.repo || '?'}` }),
            jsx.jsx(Kv, { k: '分支', children: result.branch || '—' }),
            jsx.jsx(Kv, { k: '提交', children: result.commit ? result.commit.slice(0, 10) : '—' }),
            jsx.jsx(Kv, { k: '推送', children: result.pushed === true ? '已推送' : '未推送' }),
            jsx.jsx(Kv, { k: '变更文件', children: String(result.changed_files ?? 0) }),
            jsx.jsx(Kv, { k: '扫描文件', children: String(result.scanned_files ?? 0) }),
            jsx.jsx(Kv, { k: '项目类型', children: result.project_type || '未识别' })
          ] }),
          jsx.jsx(SensitiveList, { findings: result.sensitive_hits }),
          result.next_step ? jsx.jsx('span', { style: label, children: `下一步：${result.next_step}` }) : null
        ] })
      ] })
    }

    function PanelIcon() {
      return h('svg', {
        viewBox: '0 0 64 64', width: 20, height: 20, 'aria-hidden': true, style: { display: 'block' }
      }, [
        h('path', { d: 'M32 8v30', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round' }),
        h('path', { d: 'M20 26l12 12 12-12', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        h('path', { d: 'M14 46h36', fill: 'none', stroke: 'currentColor', 'stroke-width': 5, 'stroke-linecap': 'round' })
      ])
    }

    // ---------- plugin entry ----------

    const NS = 'github-aide'
    const dictionaries = {
      zh: { panel: 'GitHub Aide' },
      en: { panel: 'GitHub Aide' }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = key => dictionaries.zh[key] ?? key
        try {
          ctx.locale.register(NS, dictionaries)
          const bound = ctx.locale.bind(NS)
          if (typeof bound === 'function') t = key => bound(key, {})
          else if (bound !== undefined) t = key => bound(key)
        } catch (caught) {
          console.warn('[dsh-github-aide] locale unavailable, falling back to zh copy:', caught)
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'github-aide',
          order: 58,
          label: () => t('panel'),
          locale: NS
        }, PanelIcon))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'github-aide',
          locale: NS,
          inject: () => ({ t })
        }, AidePage))
      }
    }
  }
})
