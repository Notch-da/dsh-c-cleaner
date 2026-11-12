/**
 * C盘清理 · Client half.
 *
 * 在左侧栏注册一个面板图标，并在主区域渲染清理面板：
 * 磁盘占用、逐项垃圾列表、勾选清理、大文件排查。
 * 数据全部来自 Host 的 /api/dsh-cleaner/*（见 index.js）。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-cleaner',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-cleaner'
    const PANEL_ID = 'dsh-cleaner'
    const API = '/api/dsh-cleaner'
    const DEFAULT_MIN_MB = 200

    /* -------------------------------------------------------------- */
    /* 文案                                                             */
    /* -------------------------------------------------------------- */

    const zh = {
      'nav.title': 'C盘清理',
      'panel.title': 'C盘清理',
      'panel.desc': '扫描系统垃圾与缓存，清理前逐项预览；个人文件不会被触碰',
      'action.scan': '扫描',
      'action.scanning': '扫描中…',
      'action.rescan': '重新扫描',
      'action.clean': '清理选中',
      'action.cleaning': '清理中…',
      'action.cancel': '取消',
      'action.confirm': '确认清理',
      'tab.junk': '垃圾清理',
      'tab.big': '大文件',
      'col.item': '清理项目',
      'col.files': '文件',
      'col.size': '大小',
      'col.state': '状态',
      'state.ready': '可清理',
      'state.admin': '需管理员',
      'state.empty': '无内容',
      'state.info': '仅提示',
      'disk.label': 'C: 系统盘',
      'disk.free': '可用',
      'disk.used': '已用',
      'disk.cleanable': '可清理',
      'disk.loading': '正在读取磁盘信息…',
      'sum.none': '尚未选择要清理的项目',
      'sum.selected': '已选择 {n} 项 · 预计释放 {size}',
      'sum.hint': '被程序占用的文件会自动跳过，不会强制删除',
      'report.title': '清理完成，释放 {size}',
      'report.skipped': '{n} 个文件被占用或无权限，已跳过',
      'error.title': '操作失败',
      'error.retry': '重试',
      'confirm.title': '确认清理',
      'confirm.body': '即将清理 {n} 个项目，预计释放 {size}。',
      'confirm.note': '被占用的文件会自动跳过；回收站清空后无法恢复。',
      'big.min': '最小体积',
      'big.unit': 'MB',
      'big.scan': '扫描大文件',
      'big.scanning': '扫描中…',
      'big.hint': '扫描 C 盘中体积较大的文件，用于排查空间去向',
      'big.empty': '还没有结果 — 选择体积后开始扫描（整盘扫描约需 10~20 秒）',
      'big.none': '没有找到符合条件的文件',
      'big.reveal': '打开位置',
      'big.col.size': '大小',
      'big.col.name': '文件名',
      'big.col.dir': '所在目录',
      'big.count': '共 {n} 个文件',
      'loading.scan': '正在扫描，请稍候…',
    }

    const en = {
      'nav.title': 'C Drive Cleaner',
      'panel.title': 'C Drive Cleaner',
      'panel.desc': 'Scan system junk and caches with a per-item preview; personal files are never touched',
      'action.scan': 'Scan',
      'action.scanning': 'Scanning…',
      'action.rescan': 'Rescan',
      'action.clean': 'Clean selected',
      'action.cleaning': 'Cleaning…',
      'action.cancel': 'Cancel',
      'action.confirm': 'Clean now',
      'tab.junk': 'Junk files',
      'tab.big': 'Large files',
      'col.item': 'Item',
      'col.files': 'Files',
      'col.size': 'Size',
      'col.state': 'Status',
      'state.ready': 'Cleanable',
      'state.admin': 'Needs admin',
      'state.empty': 'Empty',
      'state.info': 'Info only',
      'disk.label': 'C: system drive',
      'disk.free': 'Free',
      'disk.used': 'Used',
      'disk.cleanable': 'Cleanable',
      'disk.loading': 'Reading disk information…',
      'sum.none': 'Nothing selected yet',
      'sum.selected': '{n} selected · {size} to free',
      'sum.hint': 'Files in use are skipped instead of forced',
      'report.title': 'Cleaned up {size}',
      'report.skipped': '{n} files were in use or protected',
      'error.title': 'Action failed',
      'error.retry': 'Retry',
      'confirm.title': 'Confirm cleanup',
      'confirm.body': 'About to clean {n} items, around {size}.',
      'confirm.note': 'Files in use are skipped; emptied Recycle Bin items cannot be recovered.',
      'big.min': 'Minimum size',
      'big.unit': 'MB',
      'big.scan': 'Scan large files',
      'big.scanning': 'Scanning…',
      'big.hint': 'Find the largest files on C: to see where the space went',
      'big.empty': 'No results yet — pick a size and start scanning (about 10-20 seconds)',
      'big.none': 'No files matched',
      'big.reveal': 'Show',
      'big.col.size': 'Size',
      'big.col.name': 'File name',
      'big.col.dir': 'Folder',
      'big.count': '{n} files',
      'loading.scan': 'Scanning, please wait…',
    }

    /* -------------------------------------------------------------- */
    /* 样式（只用主题令牌）                                             */
    /* -------------------------------------------------------------- */

    const CSS = `
.cc-page{height:100%;box-sizing:border-box;overflow-y:auto;overflow-x:hidden;padding:26px 30px 44px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
.cc-inner{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.cc-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.cc-title{margin:0;font-size:20px;font-weight:600;letter-spacing:.2px}
.cc-desc{margin:6px 0 0;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.cc-actions{display:flex;gap:8px;flex-shrink:0}
.cc-btn{appearance:none;height:32px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;transition:background .15s ease,filter .15s ease}
.cc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.cc-btn:disabled{opacity:.45;cursor:not-allowed}
.cc-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:500}
.cc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.08)}
.cc-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
.cc-disk-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.cc-disk-label{font-weight:600}
.cc-disk-meta{color:var(--dsw-alias-label-secondary);font-size:12.5px;font-variant-numeric:tabular-nums}
.cc-bar{margin:10px 0 8px;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.cc-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.cc-disk-foot{display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary);font-size:12px}
.cc-disk-foot b{color:var(--dsw-alias-label-primary);font-weight:600}
.cc-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.cc-tab{appearance:none;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;padding:8px 10px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.cc-tab:hover{color:var(--dsw-alias-label-primary)}
.cc-tab.is-on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.cc-list{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.cc-row{display:grid;grid-template-columns:34px minmax(0,1fr) 74px 98px 86px;align-items:center;gap:8px;padding:11px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.cc-row:first-child{border-top:none}
.cc-rowhead{padding:8px 14px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.2px}
.cc-row:not(.cc-rowhead):hover{background:var(--dsw-alias-bg-layer-2)}
.cc-check{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.cc-check:disabled{cursor:default;opacity:.4}
.cc-name{font-size:13px}
.cc-sub{margin-top:2px;font-size:11.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cc-files{text-align:right;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.cc-size{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.cc-state{text-align:right}
.cc-muted .cc-name{color:var(--dsw-alias-label-secondary)}
.cc-muted .cc-size{color:var(--dsw-alias-label-secondary);font-weight:500}
.cc-pill{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.cc-pill.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.cc-pill.warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.cc-pill.idle{color:var(--dsw-alias-state-idle-primary);border-color:var(--dsw-alias-border-l1)}
.cc-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:0 2px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.cc-foot b{color:var(--dsw-alias-label-primary);font-weight:600}
.cc-banner{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12.5px}
.cc-banner.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.cc-banner.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.cc-banner span{color:var(--dsw-alias-label-secondary)}
.cc-banner .cc-btn{margin-left:auto;height:26px;padding:0 10px;font-size:12px}
.cc-empty{padding:40px 16px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px;border:1px dashed var(--dsw-alias-border-l1);border-radius:12px}
.cc-mask{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.34)}
.cc-modal{width:380px;max-width:calc(100vw - 40px);border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);padding:20px;box-shadow:0 18px 48px rgba(0,0,0,.28)}
.cc-modal h3{margin:0 0 8px;font-size:15px;font-weight:600}
.cc-modal p{margin:0 0 8px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.cc-modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.cc-bigbar{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.cc-select{height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:0 8px}
.cc-bigrow{grid-template-columns:96px minmax(0,1fr) minmax(0,.9fr) 96px}
.cc-mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
`

    /* -------------------------------------------------------------- */
    /* 工具                                                             */
    /* -------------------------------------------------------------- */

    function formatBytes(input) {
      const value = Number(input) || 0
      if (value >= 1024 * 1024 * 1024 * 1024) return (value / 1024 ** 4).toFixed(2) + ' TB'
      if (value >= 1024 * 1024 * 1024) return (value / 1024 ** 3).toFixed(2) + ' GB'
      if (value >= 1024 * 1024) return (value / 1024 ** 2).toFixed(1) + ' MB'
      if (value >= 1024) return Math.round(value / 1024) + ' KB'
      return value + ' B'
    }

    function formatCount(value) {
      const number = Number(value) || 0
      return number > 0 ? number.toLocaleString() : '—'
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      ))
    }

    async function post(endpoint, body) {
      const response = await fetch(API + '/' + endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || !data || data.ok === false) {
        const detail = data && data.error ? data.error : 'HTTP ' + response.status
        throw new Error(detail)
      }
      return data
    }

    /* -------------------------------------------------------------- */
    /* 侧边栏图标                                                       */
    /* -------------------------------------------------------------- */

    function SidebarIcon(props) {
      const size = props && Number(props.size) > 0 ? Number(props.size) : 20
      const active = Boolean(props && props.active)
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M15.4 6.4a7.1 7.1 0 1 0 0 11.2',
          stroke,
          strokeWidth: 1.9,
          strokeLinecap: 'round',
        }),
        h('circle', { cx: 17.8, cy: 5.6, r: 1.55, fill: stroke, opacity: active ? 0.95 : 0.8 }),
      )
    }

    /* -------------------------------------------------------------- */
    /* 主面板                                                           */
    /* -------------------------------------------------------------- */

    function createPanel(bindLocale, isEnglish) {
      const t = (key, values) => {
        let text = key
        try {
          text = bindLocale()(key)
          if (typeof text !== 'string' || text === '') text = key
        } catch {
          text = key
        }
        return values ? fill(text, values) : text
      }

      return function CleanerPanel() {
        const [snapshot, setSnapshot] = React.useState(null)
        const [selected, setSelected] = React.useState({})
        const [phase, setPhase] = React.useState('scanning')
        const [error, setError] = React.useState('')
        const [report, setReport] = React.useState(null)
        const [confirming, setConfirming] = React.useState(false)
        const [tab, setTab] = React.useState('junk')
        const [bigs, setBigs] = React.useState(null)
        const [bigMin, setBigMin] = React.useState(DEFAULT_MIN_MB)

        const busy = phase !== 'idle'

        const refresh = React.useCallback(async (resetSelection) => {
          setPhase('scanning')
          setError('')
          try {
            const data = await post('scan')
            setSnapshot(data)
            setSelected(previous => {
              const next = {}
              for (const item of data.items) {
                const usable = Boolean(item.cleanable) && (!item.requiresAdmin || data.admin)
                const prior = resetSelection ? undefined : previous[item.id]
                next[item.id] = usable && (prior === undefined ? Boolean(item.defaultOn) : Boolean(prior))
              }
              return next
            })
          } catch (failure) {
            setError(String((failure && failure.message) || failure))
          } finally {
            setPhase('idle')
          }
        }, [])

        React.useEffect(() => {
          refresh(true)
        }, [refresh])

        const items = React.useMemo(() => {
          if (!snapshot || !Array.isArray(snapshot.items)) return []
          return [...snapshot.items].sort((left, right) => {
            if (Boolean(left.cleanable) !== Boolean(right.cleanable)) return left.cleanable ? -1 : 1
            return (right.bytes || 0) - (left.bytes || 0)
          })
        }, [snapshot])

        const selectableItems = items.filter(item => item.cleanable && (!item.requiresAdmin || (snapshot && snapshot.admin)))
        const chosen = selectableItems.filter(item => selected[item.id])
        const chosenBytes = chosen.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)
        const allChosen = selectableItems.length > 0 && chosen.length === selectableItems.length

        const disk = snapshot && snapshot.disk ? snapshot.disk : { total: 0, free: 0 }
        const usedBytes = Math.max(0, (disk.total || 0) - (disk.free || 0))
        const usedRatio = disk.total > 0 ? Math.min(1, usedBytes / disk.total) : 0
        const cleanableBytes = items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0)

        const toggle = id => setSelected(previous => ({ ...previous, [id]: !previous[id] }))
        const toggleAll = () => {
          const next = { ...selected }
          for (const item of selectableItems) next[item.id] = !allChosen
          setSelected(next)
        }

        const runClean = async () => {
          const ids = chosen.map(item => item.id)
          if (ids.length === 0) return
          setConfirming(false)
          setPhase('cleaning')
          setError('')
          setReport(null)
          try {
            const data = await post('clean', { ids })
            setReport(data)
            await refresh(true)
          } catch (failure) {
            setError(String((failure && failure.message) || failure))
            setPhase('idle')
          }
        }

        const scanBig = async () => {
          setPhase('bigscan')
          setError('')
          try {
            const data = await post('big', { minMb: Number(bigMin) || DEFAULT_MIN_MB })
            setBigs(Array.isArray(data.items) ? data.items : [])
          } catch (failure) {
            setError(String((failure && failure.message) || failure))
          } finally {
            setPhase('idle')
          }
        }

        const reveal = async path => {
          try {
            await post('reveal', { path })
          } catch (failure) {
            setError(String((failure && failure.message) || failure))
          }
        }

        const nameOf = item => (isEnglish() && item.nameEn ? item.nameEn : item.name)
        const descOf = item => (isEnglish() && item.descEn ? item.descEn : item.desc)

        const statusOf = item => {
          const admin = Boolean(snapshot && snapshot.admin)
          if (!item.cleanable) return { text: t('state.info'), kind: 'idle' }
          if (item.error === 'notfound' || ((item.bytes || 0) <= 0 && (item.files || 0) <= 0)) {
            return { text: t('state.empty'), kind: 'idle' }
          }
          if (item.requiresAdmin && !admin) return { text: t('state.admin'), kind: 'warn' }
          return { text: t('state.ready'), kind: 'ok' }
        }

        const header = h(
          'div',
          { className: 'cc-head' },
          h(
            'div',
            null,
            h('h1', { className: 'cc-title' }, t('panel.title')),
            h('p', { className: 'cc-desc' }, t('panel.desc')),
          ),
          h(
            'div',
            { className: 'cc-actions' },
            h(
              'button',
              { type: 'button', className: 'cc-btn', onClick: () => refresh(false), disabled: busy },
              phase === 'scanning' ? t('action.scanning') : t('action.rescan'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'cc-btn cc-btn-primary',
                onClick: () => setConfirming(true),
                disabled: busy || chosen.length === 0,
              },
              chosen.length > 0 ? t('action.clean') + ' · ' + formatBytes(chosenBytes) : t('action.clean'),
            ),
          ),
        )

        const diskCard = h(
          'div',
          { className: 'cc-card' },
          h(
            'div',
            { className: 'cc-disk-top' },
            h('span', { className: 'cc-disk-label' }, t('disk.label')),
            h(
              'span',
              { className: 'cc-disk-meta' },
              snapshot
                ? t('disk.free') + ' ' + formatBytes(disk.free) + ' / ' + formatBytes(disk.total)
                : t('disk.loading'),
            ),
          ),
          h('div', { className: 'cc-bar' }, h('div', { className: 'cc-bar-fill', style: { width: Math.round(usedRatio * 100) + '%' } })),
          h(
            'div',
            { className: 'cc-disk-foot' },
            h('span', null, t('disk.used') + ' ' + Math.round(usedRatio * 100) + '% · ' + formatBytes(usedBytes)),
            h('span', null, t('disk.cleanable') + ' ', h('b', null, formatBytes(cleanableBytes))),
          ),
        )

        const tabs = h(
          'div',
          { className: 'cc-tabs' },
          h(
            'button',
            {
              type: 'button',
              className: 'cc-tab' + (tab === 'junk' ? ' is-on' : ''),
              onClick: () => setTab('junk'),
            },
            t('tab.junk'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'cc-tab' + (tab === 'big' ? ' is-on' : ''),
              onClick: () => setTab('big'),
            },
            t('tab.big'),
          ),
        )

        const banners = []
        if (error) {
          banners.push(h(
            'div',
            { className: 'cc-banner err', key: 'error' },
            h('span', null, t('error.title') + '：' + error),
            h('button', { type: 'button', className: 'cc-btn', onClick: () => refresh(false), disabled: busy }, t('error.retry')),
          ))
        }
        if (report) {
          const skipped = Number(report.failed) || 0
          banners.push(h(
            'div',
            { className: 'cc-banner ok', key: 'report' },
            h('b', null, fill(t('report.title'), { size: formatBytes(report.freed) })),
            skipped > 0 ? h('span', null, fill(t('report.skipped'), { n: skipped })) : null,
            h('button', { type: 'button', className: 'cc-btn', onClick: () => setReport(null) }, t('action.cancel')),
          ))
        }

        let body = null
        if (tab === 'junk') {
          const rows = []
          rows.push(h(
            'div',
            { className: 'cc-row cc-rowhead', key: '__head' },
            h('span', null, h('input', {
              type: 'checkbox',
              className: 'cc-check',
              checked: allChosen,
              onChange: toggleAll,
              disabled: busy || selectableItems.length === 0,
              'aria-label': t('col.item'),
            })),
            h('span', null, t('col.item')),
            h('span', { className: 'cc-files' }, t('col.files')),
            h('span', { className: 'cc-size' }, t('col.size')),
            h('span', { className: 'cc-state' }, t('col.state')),
          ))

          if (!snapshot) {
            rows.push(h('div', { className: 'cc-empty', key: '__loading' }, t('loading.scan')))
          } else {
            for (const item of items) {
              const status = statusOf(item)
              const usable = Boolean(item.cleanable) && (!item.requiresAdmin || Boolean(snapshot.admin))
              const on = Boolean(selected[item.id]) && usable
              rows.push(h(
                'div',
                { className: 'cc-row' + (usable ? '' : ' cc-muted'), key: item.id },
                h('span', null, h('input', {
                  type: 'checkbox',
                  className: 'cc-check',
                  checked: on,
                  disabled: !usable || busy,
                  onChange: () => toggle(item.id),
                  'aria-label': nameOf(item),
                })),
                h(
                  'div',
                  null,
                  h('div', { className: 'cc-name' }, nameOf(item)),
                  h('div', { className: 'cc-sub', title: descOf(item) }, descOf(item)),
                ),
                h('span', { className: 'cc-files' }, formatCount(item.files)),
                h('span', { className: 'cc-size' }, (item.bytes || 0) > 0 ? formatBytes(item.bytes) : '—'),
                h('span', { className: 'cc-state' }, h('span', { className: 'cc-pill ' + status.kind }, status.text)),
              ))
            }
          }

          body = h(
            React.Fragment,
            null,
            h('div', { className: 'cc-list' }, rows),
            h(
              'div',
              { className: 'cc-foot' },
              h('span', null, chosen.length > 0
                ? h('b', null, fill(t('sum.selected'), { n: chosen.length, size: formatBytes(chosenBytes) }))
                : t('sum.none')),
              h('span', null, t('sum.hint')),
            ),
          )
        } else {
          const rows = []
          if (bigs && bigs.length > 0) {
            rows.push(h(
              'div',
              { className: 'cc-row cc-bigrow cc-rowhead', key: '__bighead' },
              h('span', { className: 'cc-size' }, t('big.col.size')),
              h('span', null, t('big.col.name')),
              h('span', null, t('big.col.dir')),
              h('span', { className: 'cc-state' }, ''),
            ))
            for (const file of bigs) {
              const segments = String(file.path || '').split('\\')
              const base = segments.pop() || ''
              const folder = segments.join('\\')
              rows.push(h(
                'div',
                { className: 'cc-row cc-bigrow', key: file.path },
                h('span', { className: 'cc-size' }, formatBytes(file.size)),
                h('span', { className: 'cc-mono' }, base),
                h('span', { className: 'cc-mono', title: folder }, folder),
                h('span', { className: 'cc-state' },
                  h('button', {
                    type: 'button',
                    className: 'cc-btn',
                    onClick: () => reveal(file.path),
                    disabled: busy,
                  }, t('big.reveal'))),
              ))
            }
          }

          body = h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'cc-card' },
              h(
                'div',
                { className: 'cc-bigbar' },
                h('span', null, t('big.min')),
                h(
                  'select',
                  {
                    className: 'cc-select',
                    value: String(bigMin),
                    onChange: event => setBigMin(Number(event.target.value) || DEFAULT_MIN_MB),
                    disabled: busy,
                  },
                  [100, 200, 500, 1024].map(size => h('option', { key: size, value: String(size) }, String(size))),
                ),
                h('span', null, t('big.unit')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'cc-btn',
                    onClick: scanBig,
                    disabled: busy,
                    style: { marginLeft: '4px' },
                  },
                  phase === 'bigscan' ? t('big.scanning') : t('big.scan'),
                ),
                h('span', { style: { marginLeft: 'auto' } }, bigs && bigs.length > 0 ? fill(t('big.count'), { n: bigs.length }) : t('big.hint')),
              ),
            ),
            bigs === null
              ? h('div', { className: 'cc-empty' }, t('big.empty'))
              : (bigs.length === 0
                ? h('div', { className: 'cc-empty' }, t('big.none'))
                : h('div', { className: 'cc-list' }, rows)),
          )
        }

        const modal = confirming ? h(
          'div',
          { className: 'cc-mask', onClick: event => { if (event.target === event.currentTarget) setConfirming(false) } },
          h(
            'div',
            { className: 'cc-modal', role: 'dialog', 'aria-modal': 'true' },
            h('h3', null, t('confirm.title')),
            h('p', null, fill(t('confirm.body'), { n: chosen.length, size: formatBytes(chosenBytes) })),
            h('p', null, t('confirm.note')),
            h(
              'div',
              { className: 'cc-modal-foot' },
              h('button', { type: 'button', className: 'cc-btn', onClick: () => setConfirming(false) }, t('action.cancel')),
              h('button', { type: 'button', className: 'cc-btn cc-btn-primary', onClick: runClean }, t('action.confirm')),
            ),
          ),
        ) : null

        return h(
          'div',
          { className: 'cc-page' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'cc-inner' },
            header,
            diskCard,
            tabs,
            ...banners,
            body,
          ),
          modal,
        )
      }
    }

    /* -------------------------------------------------------------- */
    /* 入口                                                             */
    /* -------------------------------------------------------------- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const detectEnglish = () => {
          try {
            const snapshot = ctx.locale.getLocale()
            const id = String((snapshot && (snapshot.id || snapshot.locale)) || '')
            return id.toLowerCase().startsWith('en')
          } catch {
            return false
          }
        }

        try {
          ctx.locale.register(NS, { zh, en })
        } catch (failure) {
          console.error('[dsh-cleaner] dictionary registration failed', failure)
        }

        const bindLocale = () => ctx.locale.bind(NS)
        const Panel = createPanel(bindLocale, detectEnglish)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel))

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 25,
          locale: NS,
          label: () => {
            try {
              return ctx.locale.bind(NS)('nav.title')
            } catch {
              return 'C盘清理'
            }
          },
        }, SidebarIcon))
      },
    }
  },
})
