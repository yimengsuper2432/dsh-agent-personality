/**
 * dsh-agent-md —— 浏览器半：设置里的「人格」页，只编辑全局 AGENT.md。
 *
 * 手写 __ModuleLoader__ bundle（无构建工具）：宿主给 react，前端只走同源 fetch。
 * 版式沿用 0.2.0：头部 + 生效横幅 + 编辑器（文件条 / 正文 / 操作）+ 底部路径，
 * 内容只有一份全局人格。
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-md',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var Component = React.Component
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState
    var useRef = React.useRef

    var API = '/api/agent-md'

    // ---- 同源 API ---------------------------------------------------------

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }
    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var err = new Error(data && data.error ? data.error : ('HTTP ' + res.status))
          err.status = res.status
          throw err
        }
        return data
      })
    }
    function reason(err) {
      return String((err && err.message) || err)
    }

    // ---- 小工具 -----------------------------------------------------------

    // 固定格式：2026-10-27 23:07（不写相对时间，回退时看的就是确切时刻）
    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }

    function timeLabel(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      var d = new Date(iso)
      var t = d.getTime()
      if (isNaN(t)) return '—'
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    function charLabel(n) {
      var v = typeof n === 'number' ? n : 0
      return v + ' 字'
    }

    function byteLabel(n) {
      var v = typeof n === 'number' ? n : 0
      if (v < 1024) return v + ' B'
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
      return (v / (1024 * 1024)).toFixed(2) + ' MB'
    }

    // 人格文本上限：写盘和进度条共用同一个数。
    var LIMIT_BYTES = 2 * 1024 * 1024

    function byteLength(text) {
      var s = typeof text === 'string' ? text : ''
      try {
        return new TextEncoder().encode(s).length
      } catch (e) {
        return s.length * 3
      }
    }

    function Icon(props) {
      var size = props.size || 15
      var common = {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', flex: '0 0 auto' },
      }
      var paths
      if (props.name === 'folder') {
        paths = [h('path', { key: 'a', d: 'M3.5 7.5a2 2 0 0 1 2-2h3.2l1.8 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z' })]
      } else if (props.name === 'save') {
        paths = [
          h('path', { key: 'a', d: 'M5 4.5h10l4 4v11H5z' }),
          h('path', { key: 'b', d: 'M8.5 4.5v5h7v-5' }),
          h('path', { key: 'c', d: 'M8.5 14.5h7v5h-7z' }),
        ]
      } else if (props.name === 'refresh') {
        paths = [
          h('path', { key: 'a', d: 'M19 12a7 7 0 1 1-2.1-5' }),
          h('path', { key: 'b', d: 'M19.5 4v4.2h-4.2' }),
        ]
      } else if (props.name === 'file') {
        paths = [
          h('path', { key: 'a', d: 'M6 3.5h7l5 5v12H6z' }),
          h('path', { key: 'b', d: 'M13 3.5v5h5' }),
        ]
      } else {
        paths = [h('circle', { key: 'a', cx: 12, cy: 12, r: 8 })]
      }
      return h('svg', common, paths)
    }

    function ActionButton(props) {
      return h('button', {
        type: 'button',
        className: 'am-btn' + (props.primary ? ' am-btn-primary' : ''),
        onClick: props.onClick,
        disabled: props.disabled === true,
        title: props.title || '',
      }, [
        props.icon ? h(Icon, { key: 'i', name: props.icon }) : null,
        h('span', { key: 't' }, props.children),
      ])
    }

    /**
     * 错误边界必须是 class：React 只认 class 的 getDerivedStateFromError。
     * 页面炸了也要看得见原因，而不是整块白掉。
     */
    class AgentMdErrorBoundary extends Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error('[dsh-agent-md] 设置页渲染失败：', error) } catch (e) { /* 静默 */ }
      }
      render() {
        if (this.state.error !== null) {
          var msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'am-root' }, [
            h('div', { key: 'h', className: 'am-h1' }, '虚拟记忆'),
            h('div', { key: 'e', className: 'am-error' }, '这个设置页渲染时出错了：' + String(msg)),
            h('div', { key: 'd', className: 'am-muted' }, '记忆注入本身不受影响（注入发生在宿主侧）。把上面这段报错发给我即可定位。'),
          ])
        }
        return this.props.children
      }
    }

    function AgentMdSection() {
      var [loading, setLoading] = useState(true)
      var [error, setError] = useState('')
      var [state, setState] = useState(null)
      var [draft, setDraft] = useState('')
      var [dirty, setDirty] = useState(false)
      var [busy, setBusy] = useState('')
      var [toast, setToast] = useState(null)
      var [seenAt, setSeenAt] = useState(0)

      var reload = useCallback(async function () {
        try {
          var data = await apiGet('/state')
          setState(data)
          setSeenAt(Date.now())
          setDraft(data.content || '')
          setDirty(false)
          setError('')
        } catch (err) {
          setError(reason(err))
        }
        setLoading(false)
      }, [])

      useEffect(function () { reload() }, [reload])

      // 提示条只是「刚刚发生了什么」，4 秒后自己消失，不留一个绿框赖在页面上。
      useEffect(function () {
        if (toast === null) return undefined
        var timer = setTimeout(function () { setToast(null) }, 4000)
        return function () { clearTimeout(timer) }
      }, [toast])

      async function doSave() {
        setBusy('save')
        try {
          await apiPost('/save', { content: draft })
          setDirty(false)
          setToast({ kind: 'ok', text: '已保存 · 下一个回合生效' })
          await reload()
        } catch (err) {
          setToast({ kind: 'err', text: '保存失败：' + reason(err) })
        }
        setBusy('')
      }

      async function doOpen(scope) {
        setBusy('open')
        try {
          await apiPost('/open', { scope: scope })
        } catch (err) {
          setToast({ kind: 'err', text: '打开失败：' + reason(err) })
        }
        setBusy('')
      }

      if (loading) {
        return h('div', { className: 'am-root' }, h('div', { className: 'am-loading' }, '正在读取虚拟记忆…'))
      }

      if (error !== '') {
        return h('div', { className: 'am-root' }, [
          h('div', { key: 'h', className: 'am-h1' }, '虚拟记忆'),
          h('div', { key: 'e', className: 'am-error' }, '读取失败：' + error),
          h('div', { key: 'r', className: 'am-actions' },
            h(ActionButton, { icon: 'refresh', onClick: function () { setLoading(true); reload() } }, '重试')),
        ])
      }

      var path = state.path || ''
      var exists = state.exists === true
      var empty = (draft || '').trim() === ''
      var charCount = draft.length

      // 这一版 /state 刚返回过，连上是事实；不再依赖宿主回传的 bridge 字段
      // （老宿主没有这个字段，会永远显示「等待连接宿主」）。
      var bridgeFresh = seenAt > 0 && (Date.now() - seenAt) < 60000

      // 路径不再重复显示（编辑器文件条里已经有了）：这一行中间直接给出占用进度。
      var usedBytes = byteLength(draft)
      var usedPct = Math.max(0, Math.min(100, (usedBytes / LIMIT_BYTES) * 100))

      var bannerBody = h('span', { key: 'v', className: 'am-banner-body' }, [
        empty
          ? h('span', {
            key: 'w',
            className: 'am-val-warn',
          }, '尚未写入记忆（写一份即生效）')
          : h('span', {
            key: 'm',
            className: 'am-meter',
            title: byteLabel(usedBytes) + ' / 2 MB（上限）· ' + charLabel(charCount),
          }, h('span', {
            key: 'f',
            className: 'am-meter-fill',
            // 蓝→红的渐变色铺满整条，再用 clip 露出左边的使用比例，颜色不会被压扁
            style: { clipPath: 'inset(0 ' + (100 - usedPct).toFixed(2) + '% 0 0)' },
          })),
        h('span', { key: 'l', className: 'am-limit' }, '2 MB'),
      ])

      var resolvedBanner = h('div', { className: 'am-resolved' }, [
        h('div', { key: 'l', className: 'am-resolved-line' }, [
          bannerBody,
          bridgeFresh
            ? h('span', { key: 'b', className: 'am-live', title: timeLabel(new Date(seenAt).toISOString()) + ' 拿到宿主响应' }, '本页已连接宿主')
            : h('span', { key: 'b', className: 'am-live am-live-stale', title: '这次加载还没拿到宿主响应' }, '等待连接宿主'),
        ]),
      ])

      return h('div', { className: 'am-root' }, [
        h('div', { key: 'head', className: 'am-head' }, [
          h('div', { key: 'lt', className: 'am-head-left' }, [
            h('div', { key: 't', className: 'am-h1' }, '虚拟记忆'),
            h('div', { key: 's', className: 'am-sub' }, '使用MarkDown书写虚拟人物的性格与记忆，可直接操作源文件。'),
          ]),
        ]),

        resolvedBanner,

        h('div', { key: 'editor', className: 'am-editor' }, [
          h('div', { key: 'bar', className: 'am-bar' }, [
            h('div', { key: 'stat', className: 'am-stat' }, [
              h('span', { key: 'c', className: 'am-stat-num' }, String(charCount)),
              h('span', { key: 'l', className: 'am-stat-unit' }, ' 字'),
              dirty ? h('span', { key: 'd', className: 'am-dirty' }, '· 未保存') : null,
            ]),
          ]),

          path !== ''
            ? h('div', { key: 'path', className: 'am-filebar' }, [
              h('span', { key: 'i', className: 'am-filebar-icon' }, h(Icon, { name: 'file' })),
              h('span', { key: 'p', className: 'am-filebar-path', title: path }, path),
              h('span', { key: 'm', className: 'am-filebar-meta' },
                exists
                  ? (state.updatedAt ? ('上次改动 ' + timeLabel(state.updatedAt)) : '上次改动 · 宿主未上报（重启后可见）')
                  : '文件尚未创建'),
            ])
            : null,

          !exists || empty
            ? h('div', { key: 'empty', className: 'am-empty' }, [
              h('div', { key: 't', className: 'am-empty-title' }, exists ? '这份记忆还是空的' : '这份记忆还没创建'),
              h('div', { key: 'd', className: 'am-empty-desc' }, '直接在下面开始写，保存后下一个回合生效。'),
            ])
            : null,

          h('textarea', {
            key: 'ta',
            className: 'am-textarea',
            value: draft,
            spellCheck: false,
            placeholder: '# 你是谁\n\n# 语气与风格\n\n- 中文回答，先给结论再给理由\n\n# 行事偏好\n\n- 动手前先确认关键歧义',
            onChange: function (e) {
              setDraft(e.target.value)
              setDirty(true)
            },
          }),

          h('div', { key: 'act', className: 'am-actions' }, [
            h(ActionButton, {
              key: 's', icon: 'save', primary: true, onClick: doSave,
              disabled: busy === 'save' || !dirty,
            }, dirty ? '保存' : '已保存'),
            h(ActionButton, {
              key: 'o', icon: 'folder', onClick: function () { doOpen('file') }, disabled: busy === 'open',
            }, '打开原文件'),
            h(ActionButton, {
              key: 'r', icon: 'refresh', onClick: function () { reload() }, disabled: busy === 'refresh',
            }, '重新载入'),
            h('div', { key: 'f', className: 'am-flex' }),
            h('span', {
              key: 'st', className: 'am-muted',
              style: { fontSize: '11.5px', alignSelf: 'center' },
            }, dirty ? '有未保存的改动' : '已同步磁盘'),
          ]),
        ]),

        toast !== null
          ? h('div', { key: 'toast', className: 'am-toast am-toast-' + toast.kind }, toast.text)
          : null,
      ])
    }

    // 每轮回复的收尾语：正文里不写，渲染在费用行里的灰字。
    // 文案与心情都由宿主算（见 lib/index.js 的 closingFor）：深夜会困、久没见会软、
    // 连聊太久会嫌烦、偶尔使小性子——不顺着用户来。这里只负责把它塞进费用行。

    // 宿主 /closing 拿不到时的兜底（宿主没重启、接口还没上线）。
    var FALLBACK = [
      '……好啦，就这样，别熬太晚哦～ (・∀・)',
      '嘛，有事随时敲我。 (｡•̀ᴗ-)✧',
      '说完了，我去剪片啦～ (￣▽￣)',
      '总之，交给我吧！ (๑•̀ㅂ•́)و',
      '睡前记得喝点水。 (´｡• ᵕ •｡`)',
    ]

    /**
     * 费用行是一行 `<details><summary>本轮费用 ≈ ¥0.0063</summary></details>`，
     * 「本轮费用」和金额常常是同一个文本节点，插不进文本内部——所以把收尾语作为
     * 费用行的最后一个子节点追加进去，永远落在金额之后、同一行。
     * 找不到就退化成自己一行灰字，绝不抛错。
     */
    function isCostRow(node) {
      if (node === null || node === undefined) return false
      var tag = node.tagName
      if (tag !== 'SUMMARY' && tag !== 'DETAILS') return false
      var content = node.textContent || ''
      if (content.length > 160) return false
      return content.indexOf('本轮费用') >= 0 || content.indexOf('Turn cost') >= 0
    }

    /** 从自己往前找本轮的费用行；只认 summary，塞进 details 就会掉到下一行。 */
    function findCostRow(box) {
      try {
        var cursor = box
        while (cursor !== null && cursor !== undefined) {
          var sib = cursor.previousElementSibling
          while (sib !== null && sib !== undefined) {
            if (isCostRow(sib)) {
              if (sib.tagName === 'SUMMARY') return sib
              var summary = sib.querySelector('summary')
              if (summary !== null) return summary
              return null
            }
            sib = sib.previousElementSibling
          }
          cursor = cursor.parentElement
        }
      } catch (e) {
        return null
      }
      return null
    }

    // 她自己在正文末尾留的收尾标记：〔尾〕一句心里话
    var TAIL_MARK = '〔尾〕'

    /** 从一段文字里取出标记后面那句；没有标记返回 null。 */
    function parseTail(text) {
      if (typeof text !== 'string') return null
      var at = text.lastIndexOf(TAIL_MARK)
      if (at < 0) return null
      var tail = text.slice(at + TAIL_MARK.length).trim()
      return tail === '' ? null : tail
    }

    /** 在页面里找出正文中的标记，取出那句话并把标记从正文里摘掉（从后往前，只摘一处）。 */
    function takeTailFromDom(scope) {
      try {
        var root = scope !== null && scope !== undefined ? scope : document.body
        var walker = document.createTreeWalker(root, 4) // NodeFilter.SHOW_TEXT
        var nodes = []
        while (walker.nextNode()) nodes.push(walker.currentNode)
        for (var i = nodes.length - 1; i >= 0; i -= 1) {
          var node = nodes[i]
          var text = node.nodeValue || ''
          var at = text.lastIndexOf(TAIL_MARK)
          if (at < 0) continue
          var tail = parseTail(text)
          if (tail === null) continue
          node.nodeValue = text.slice(0, at).replace(/[\s　]+$/, '')
          return tail
        }
      } catch (e) {
        return null
      }
      return null
    }

    function ClosingLine(props) {
      var boxRef = useRef(null)
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      var seq = props.turn && props.turn.start && typeof props.turn.start.seq === 'number' ? props.turn.start.seq : 0

      useEffect(function () {
        var box = boxRef.current
        if (box === null) return undefined

        var span = null
        var observer = null
        var cancelled = false
        var timer = null
        var scanTimer = null
        var attempts = 0
        var scans = 0
        var inline = false

        // 费用行是异步渲染出来的：这一帧找不到就等，等到 5 秒还没出现才退回下一行。
        function settle(text) {
          if (cancelled) return
          if (inline) return

          var host = findCostRow(box)
          if (host === null) {
            attempts += 1
            if (attempts >= 20) {
              box.className = 'am-tail am-tail-block'
              if (span !== null && box.parentNode !== null && box.firstChild === null) box.appendChild(span)
              return
            }
            timer = setTimeout(function () { settle(text) }, 250)
            return
          }

          inline = true
          if (span === null) {
            span = document.createElement('span')
            span.className = 'am-tail-inline'
            span.textContent = text
          }
          box.className = 'am-tail'
          host.appendChild(span)

          // 金额是异步取回来的，React 之后还会往 summary 里塞节点，把我们挤到中间。
          // 盯着这一行：只要收尾语不在末尾就再挪到最后。
          observer = new MutationObserver(function () {
            if (span.parentNode !== host || host.lastChild !== span) host.appendChild(span)
          })
          observer.observe(host, { childList: true, characterData: true, subtree: true })
        }

        // 首选：她这轮自己在正文末尾写的那句（真按当下语境想的），取出后把标记抹掉。
        // 10 秒没等到（或者老版本还在写死句）才退回宿主的词库。
        function scan() {
          if (cancelled || inline) return
          var tail = takeTailFromDom(document.body)
          if (tail !== null) {
            settle(tail)
            return
          }
          scans += 1
          if (scans < 50) {
            scanTimer = setTimeout(scan, 200)
            return
          }
          apiGet('/closing?session=' + encodeURIComponent(sessionId) + '&seq=' + seq)
            .then(function (data) {
              if (data !== null && typeof data.text === 'string' && data.text !== '') settle(data.text)
            })
            .catch(function () {
              // 宿主还没这版接口（没重启）时也别空着：退回本地几句，至少不突兀。
              settle(FALLBACK[(Math.abs(seq) + sessionId.length) % FALLBACK.length])
            })
        }

        scan()

        return function () {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
          if (scanTimer !== null) clearTimeout(scanTimer)
          if (observer !== null) observer.disconnect()
          if (span !== null && span.parentNode !== null) span.parentNode.removeChild(span)
        }
      }, [sessionId, seq])

      return h('div', { ref: boxRef, className: 'am-tail' })
    }

    function apply(ctx) {
      // 样式只在挂载时注入一次，卸载时摘掉，避免热重载留一堆同 id 的 <style>。
      ctx.effect(function () {
        var id = 'dsh-agent-md:styles'
        var el = document.getElementById(id)
        if (el === null) {
          var style = document.createElement('style')
          style.id = id
          style.textContent = CSS + FULL_PATH_CSS
          document.head.appendChild(style)
        }
        return function () {
          var node = document.getElementById(id)
          if (node !== null && node.parentNode !== null) node.parentNode.removeChild(node)
        }
      }, 'dsh-agent-md: styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'agent-md',
          order: 46,
          label: function () { return '虚拟人物' },
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          return h(AgentMdErrorBoundary, null, h(AgentMdSection, p))
        })
      })

      // 轮次尾巴：排在 dsh-cost-meter（order 10）之后，显示在这一轮费用行下方。
      ctx.slots.inject('conversation.chat.turnTail', function () {
        return ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'agent-md-closing',
          order: 11,
        }, function (props) {
          return h(ClosingLine, props !== null && props !== undefined ? props : {})
        })
      })
    }

    // ---- 样式（沿用 0.2.0 原样） ------------------------------------------

    // 备份里的文件条是单行省略号，路径会被截断成「C:\Users\…」；本地路径要看得全，放开换行。
    var FULL_PATH_CSS = [
      '.am-filebar{flex-wrap:wrap;}',
      '.am-filebar-path{white-space:normal;overflow:visible;text-overflow:clip;word-break:break-all;}',
      '.am-filebar-meta{margin-left:auto;}',
      '.am-tail{display:block;margin:0;padding:0;}',
      '.am-tail-block{display:block;margin-top:4px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);opacity:.85;}',
      '.am-tail-inline{display:inline;margin-left:10px;font-size:12px;color:var(--dsw-alias-label-secondary);opacity:.85;}',
    ].join('')

    var CSS = [
      ".am-root{",
      "--am-fg:var(--dsw-alias-label-primary,#1f1c18);",
      "--am-muted:var(--dsw-alias-label-secondary,#6f6558);",
      "--am-faint:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed,#8a7f6e));",
      "--am-card:var(--dsw-alias-bg-layer-1,#fffdf8);",
      "--am-bar:var(--dsw-alias-bg-layer-2,#f4efe4);",
      "--am-field:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fbf7ef));",
      "--am-line:var(--dsw-alias-border-l2,#e3daca);",
      "--am-line-soft:var(--dsw-alias-border-l1,#ece5d8);",
      "--am-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));",
      "--am-brand:var(--dsw-alias-brand-primary,var(--dsw-alias-button-primary-fill,#1f1c18));",
      "--am-brand-fg:var(--dsw-alias-label-primary-foreground,#fffdf8);",
      "--am-ok:var(--dsw-alias-state-success-primary,#2f6b46);",
      "--am-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);",
      "--am-err:var(--dsw-alias-state-error-primary,#a83a2c);",
      "--am-err-bg:color-mix(in srgb, var(--am-err) 10%, transparent);",
      "--am-err-line:color-mix(in srgb, var(--am-err) 35%, transparent);",
      "font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif));",
      "color:var(--am-fg);display:flex;flex-direction:column;gap:14px;padding:2px;box-sizing:border-box;max-width:100%;}",
      ".am-head{display:flex;align-items:flex-start;gap:16px;}",
      ".am-head-left{flex:1 1 auto;min-width:0;}",
      ".am-h1{font-size:15px;font-weight:650;letter-spacing:.2px;line-height:1.4;}",
      ".am-sub{font-size:12.5px;color:var(--am-muted);margin-top:4px;line-height:1.6;}",
      ".am-resolved{background:var(--am-bar);border:1px solid var(--am-line-soft);border-radius:10px;padding:11px 13px;display:flex;flex-direction:column;gap:7px;}",
      ".am-resolved-line{display:flex;gap:10px;font-size:12.5px;line-height:1.5;align-items:center;}",
      ".am-banner-body{flex:1 1 auto;display:flex;align-items:center;gap:9px;min-width:0;align-self:center;}",
      ".am-limit{flex:0 0 auto;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;color:var(--am-faint);white-space:nowrap;}",
      ".am-val-warn{color:var(--am-warn);}",
      ".am-warn{border:1px solid var(--am-err-line);background:var(--am-err-bg);color:var(--am-err);font-size:12px;border-radius:10px;padding:9px 12px;line-height:1.6;}",
      ".am-log{font-size:11.5px;color:var(--am-faint);line-height:1.6;word-break:break-all;}",
      ".am-ws{display:flex;flex-direction:column;border-bottom:1px solid var(--am-line-soft);}",
      ".am-ws .am-row{border-bottom:0;}",
      ".am-input{flex:1 1 auto;min-width:0;font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;border:1px solid var(--am-line-soft);background:var(--am-field);color:var(--am-fg);}",
      ".am-live{margin-left:auto;flex:0 0 auto;font-size:11px;color:var(--am-ok);white-space:nowrap;display:inline-flex;align-items:center;gap:7px;}",
      ".am-meter{display:block;flex:1 1 auto;position:relative;height:6px;min-width:80px;border-radius:3px;background:var(--am-line-soft);overflow:hidden;align-self:center;}",
      ".am-meter-fill{position:absolute;inset:0;border-radius:3px;background:linear-gradient(90deg,#3b82f6 0%,#ef4444 100%);}",
      ".am-meter[title]{cursor:help;}",
      ".am-live-stale{color:var(--am-warn);}",
      ".am-hint{display:flex;align-items:center;gap:7px;flex-wrap:nowrap;font-size:11.5px;color:var(--am-faint);overflow:hidden;}",
      ".am-hint-step{border:1px solid var(--am-line-soft);border-radius:6px;padding:2px 7px;white-space:nowrap;color:var(--am-muted);}",
      ".am-hint-note{margin-left:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--am-faint);}",
      ".am-arrow{color:var(--am-faint);opacity:.7;}",
      ".am-editor{background:var(--am-card);border:1px solid var(--am-line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;}",
      ".am-bar{display:flex;align-items:center;gap:12px;padding:9px 12px;border-bottom:1px solid var(--am-line-soft);background:var(--am-bar);}",
      ".am-tabs{display:flex;gap:4px;}",
      ".am-pill{border:1px solid transparent;background:transparent;color:var(--am-muted);font:inherit;font-size:12.5px;padding:4px 11px;border-radius:7px;cursor:pointer;transition:background-color .15s ease,color .15s ease;}",
      ".am-pill:hover:not(:disabled){background:var(--am-hover);color:var(--am-fg);}",
      ".am-pill-on,.am-pill-on:hover{background:var(--am-brand);border-color:transparent;color:var(--am-brand-fg);font-weight:600;}",
      ".am-stat{font-size:11.5px;color:var(--am-faint);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);white-space:nowrap;font-variant-numeric:tabular-nums;}",
      ".am-stat-num{color:var(--am-fg);font-weight:600;}",
      ".am-dirty{color:var(--am-warn);}",
      ".am-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--am-line-soft);}",
      ".am-row-label{font-size:12.5px;color:var(--am-faint);flex:0 0 auto;}",
      ".am-select{flex:1 1 auto;min-width:0;max-width:100%;font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;border:1px solid var(--am-line-soft);background:var(--am-field);color:var(--am-fg);}",
      ".am-filebar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--am-line-soft);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;color:var(--am-faint);}",
      ".am-filebar-icon{display:inline-flex;flex:0 0 auto;color:var(--am-faint);}",
      ".am-filebar-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--am-fg);}",
      ".am-filebar-meta{flex:0 0 auto;color:var(--am-faint);}",
      ".am-empty{padding:18px 16px;text-align:center;border-bottom:1px solid var(--am-line-soft);display:flex;flex-direction:column;align-items:center;gap:8px;}",
      ".am-empty-title{font-size:13px;font-weight:600;color:var(--am-fg);}",
      ".am-empty-desc{font-size:12px;color:var(--am-muted);line-height:1.6;}",
      ".am-textarea{width:100%;box-sizing:border-box;min-height:320px;height:44vh;resize:vertical;border:0;border-bottom:1px solid var(--am-line-soft);background:var(--am-field);color:var(--am-fg);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,\"Cascadia Mono\",monospace);font-size:13px;line-height:1.78;padding:14px 15px;tab-size:2;outline:none;}",
      ".am-textarea::placeholder{color:var(--am-faint);opacity:.8;}",
      ".am-actions{display:flex;align-items:center;gap:8px;padding:10px 12px;flex-wrap:nowrap;}",
      ".am-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;padding:5px 11px;border-radius:8px;border:1px solid var(--am-line-soft);background:var(--am-card);color:var(--am-fg);cursor:pointer;white-space:nowrap;transition:background-color .15s ease,border-color .15s ease;}",
      ".am-btn:hover:not(:disabled){background:var(--am-hover);border-color:var(--am-line);}",
      ".am-btn:disabled{opacity:.45;cursor:default;}",
      ".am-btn-primary,.am-btn-primary:hover:not(:disabled){background:var(--am-brand);border-color:var(--am-brand);color:var(--am-brand-fg);font-weight:600;}",
      ".am-btn-primary:disabled{opacity:.5;}",
      ".am-flex{flex:1 1 auto;}",
      ".am-opts{background:var(--am-card);border:1px solid var(--am-line);border-radius:12px;padding:4px 13px;}",
      ".am-toggle{display:flex;align-items:flex-start;gap:9px;padding:9px 0;cursor:pointer;border-bottom:1px solid var(--am-line-soft);}",
      ".am-toggle:last-child{border-bottom:0;}",
      ".am-toggle input{margin-top:2px;accent-color:var(--am-brand);cursor:pointer;flex:0 0 auto;}",
      ".am-toggle-body{display:flex;flex-direction:column;gap:3px;min-width:0;}",
      ".am-toggle-title{font-size:12.5px;color:var(--am-fg);}",
      ".am-toggle-hint{font-size:11.5px;color:var(--am-muted);line-height:1.55;}",
      ".am-foot{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--am-faint);padding-top:2px;}",
      ".am-code{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;background:var(--am-bar);border:1px solid var(--am-line-soft);border-radius:6px;padding:2px 7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%;color:var(--am-muted);}",
      ".am-muted{color:var(--am-muted);}",
      ".am-loading{font-size:12.5px;color:var(--am-muted);padding:20px 0;}",
      ".am-error{color:var(--am-err);background:var(--am-err-bg);border:1px solid var(--am-err-line);font-size:12.5px;border-radius:10px;padding:11px 13px;line-height:1.6;}",
      ".am-toast{display:flex;align-items:center;gap:8px;font-size:12.5px;padding:10px 13px;border-radius:10px;border:1px solid var(--am-line);background:var(--am-bar);color:var(--am-fg);}",
      ".am-toast-ok::before{content:\"\";width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--am-ok);}",
      ".am-toast-err{color:var(--am-err);border-color:var(--am-err-line);background:var(--am-err-bg);}",
      ".am-toast-err::before{content:\"\";width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:var(--am-err);}",
      "@supports not (color:var(--dsw-alias-label-primary)){.am-root{--am-fg:#241f18;--am-muted:#6f6558;--am-faint:#9a9084;--am-card:#fffdf8;--am-bar:#f6f2ea;--am-field:#fbf8f2;--am-line:#e0d7c8;--am-line-soft:#ece5d8;--am-hover:rgba(0,0,0,.05);--am-brand:#241f18;--am-brand-fg:#fffdf8;--am-ok:#2f6b46;--am-warn:#8a6a2f;--am-err:#a83a2c}}",
    ].join('')

    module.exports = {
      name: 'agent-md',
      inject: ['slots'],
      apply: apply,
    }
    // 自检脚本从这儿拿纯函数（认收尾标记），运行时没有别的作用。
    module.exports.parseTail = parseTail
    return module.exports
  },
})
