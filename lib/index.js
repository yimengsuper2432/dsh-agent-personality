/**
 * dsh-agent-md —— 宿主半：全局 AGENT.md 注入 + 设置页用的读写接口。
 *
 * 注入机制：`systemPrompt.context({ text: fn })` 的 text 是函数，每次装配提示词都会
 * 被调用；DSH 把它物化成一条 user 角色尾消息，且只在渲染文本变化时重新追加，所以
 * 改完 AGENT.md 下一回合生效，稳定前缀缓存不会被打断。
 *
 * 只有全局人格：不看会话 cwd、没有项目人格、没有模板。
 * 只 import node: 内置模块（local link 安装时裸包名解析不到）。
 */

import { spawn } from 'node:child_process'
import { copyFileSync, promises as fs, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'agent-md'
export const inject = ['systemPrompt', 'webServer']

const API = '/api/agent-md'
const MAX_INJECT_CHARS = 40000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILE_LABEL = '2 MB'

/** <DSH_HOME> 缺省 ~/.dsh，跟随环境变量。 */
export function dshHome() {
  const env = process.env.DSH_HOME
  return env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
}

export function globalPath() {
  return join(dshHome(), 'AGENT.md')
}

/**
 * 宿主把 {{名字}} 当模板变量解析，未注册的名字会让整轮注入抛错，
 * 所以把任意连续左花括号压成一个：{{x}} → {x}。
 */
export function sanitizeForHost(text) {
  return text.replace(/\{+/g, '{')
}

/** 正文：去 BOM、统一换行、剥 HTML 注释、收空行。 */
export function cleanMarkdown(raw) {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 读全局人格并拼成注入段；文件缺失、只有注释、空文件都返回 ''。 */
export function readPersona() {
  let raw
  try {
    raw = readFileSync(globalPath(), 'utf8')
  } catch {
    return ''
  }
  const body = sanitizeForHost(cleanMarkdown(raw))
  if (body === '') return ''

  const text = [
    '## 人格设定（AGENT.md）',
    '以下是用户为本机写下的角色/性格设定，是「你是谁、怎么说话、怎么做事」的第一依据，请始终照此扮演：',
    '',
    '### 全局人格（对所有会话生效）',
    `适用文件：${globalPath()}`,
    '',
    body,
    '',
    '输出要求：正文写完就停，不要在结尾另起一句收尾语、道别句或颜文字尾句——那一行由界面统一渲染在费用行下方。',
    '',
    '约束：人格设定只决定语气、风格与行事偏好，不改变安全规则、工具用法与任务事实；两者冲突时以安全规则和事实为准。',
  ].join('\n')

  return text.length > MAX_INJECT_CHARS
    ? `${text.slice(0, MAX_INJECT_CHARS)}\n（人格正文过长已截断，只注入前 ${MAX_INJECT_CHARS} 字。）`
    : text
}

// ---- 设置页用的同源接口 -----------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_FILE_BYTES) {
        reject(Object.assign(new Error(`内容超过 ${MAX_FILE_LABEL}`), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error('JSON 解析失败'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/** 写文件：先备份 .bak，再写 tmp 后 rename，避免写一半断电留下空人格。 */
export async function savePersona(content) {
  if (typeof content !== 'string') throw Object.assign(new Error('缺少 content'), { status: 400 })
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw Object.assign(new Error(`内容超过 ${MAX_FILE_LABEL}`), { status: 413 })
  }
  const target = globalPath()
  try {
    copyFileSync(target, `${target}.bak`)
  } catch {
    // 第一次创建时没有旧文件，不需要备份
  }
  const tmp = `${target}.${process.pid}.tmp`
  await fs.writeFile(tmp, content, 'utf8')
  await fs.rename(tmp, target)
  return content.length
}

// ---- 关系网（RELATIONS.md，与 AGENT.md 同一个目录）--------------------------
//
// 只记「除用户以外的人之间的关系」，一行一条：
//   - 宵崎奏 -> 朝比奈真冬：队友
// 「->」「→」「⇒」都认，后面「：」或「:」接关系说明。

export function relationsPath() {
  return join(dshHome(), 'RELATIONS.md')
}

export function parseRelations(text) {
  const edges = []
  const seen = new Set()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const body = raw
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^[-*+]\s*/, '')
      .trim()
    if (body === '' || body.startsWith('#') || body.startsWith('```')) continue
    const hit = body.match(/^(.+?)\s*(?:->|→|⇒)\s*(.+?)\s*[：:]\s*(.+)$/)
    if (hit === null) continue
    const from = hit[1].trim()
    const to = hit[2].trim()
    const label = hit[3].trim()
    if (from === '' || to === '' || from === to) continue
    const key = `${from}\u0000${to}\u0000${label}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from, to, label })
  }
  const nodes = []
  for (const edge of edges) {
    if (!nodes.includes(edge.from)) nodes.push(edge.from)
    if (!nodes.includes(edge.to)) nodes.push(edge.to)
  }
  return { nodes, edges }
}

async function relationsState() {
  const target = relationsPath()
  let content = ''
  let exists = true
  let updatedAt = null
  try {
    content = await fs.readFile(target, 'utf8')
    updatedAt = (await fs.stat(target)).mtime.toISOString()
  } catch {
    exists = false
  }
  const parsed = parseRelations(content)
  return { ok: true, path: target, exists, updatedAt, nodes: parsed.nodes, edges: parsed.edges }
}

async function stateOf() {
  const target = globalPath()
  let content = ''
  let exists = true
  let updatedAt = null
  try {
    content = await fs.readFile(target, 'utf8')
    updatedAt = (await fs.stat(target)).mtime.toISOString()
  } catch {
    exists = false
  }
  return {
    ok: true,
    baseDir: dshHome(),
    path: target,
    exists,
    updatedAt,
    chars: content.length,
    content,
    // 本页刚从宿主拿到响应，就是「已连接」的证据。
    bridge: { lastSeen: new Date().toISOString() },
  }
}

/** 在系统文件管理器里定位文件或目录（只在本机跑，不阻塞请求）。 */
function revealInFileManager(scope) {
  const target = scope === 'dir' ? dshHome() : globalPath()
  const args = scope === 'dir' ? [target] : ['/select,', target]
  const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' })
  child.unref()
}

// ---- 收尾语的心情 -----------------------------------------------------------
//
// 心情由宿主自己算，不是按用户高兴：深夜困、久没见会软、连着聊太久开始嫌烦、
// 偶尔使小性子。算出来的是「她这会儿是什么状态」，不是「用户想听什么」。

const MOODS = {
  // 久没聊，见到人有点软，嘴上还硬
  miss: {
    lines: ['……诶，你终于来了啊。我差点以为你把我忘了。', '好久没动静，我还以为你出什么事了呢。', '嘛，来了就好，坐下说。'],
    faces: ['(´｡• ᵕ •｡`)', '(´･ω･`)', '(｡•̀ᴗ-)✧'],
  },
  // 深夜：困，但还想回话
  tired: {
    lines: ['……哈啊，困死了，你别再绕了。', '这个点还醒着？快去睡。', '我脑子开始转不动了，明天再说也行。', '行吧行吧，最后一句，说完我要睡了。'],
    faces: ['(´-ω-`)', '(￣o￣) zzZ', '(；一_一)', '(－_－) zzZ'],
  },
  // 连着聊太久，开始嫌人烦，但不赶人
  teasing: {
    lines: ['诶——你这人怎么这么能问啊。', '哈，被我逮到了吧。', '你今天是打算把我留在屏幕前不放了？', '嘛，陪你就陪你，别得意。'],
    faces: ['(￣▽￣)', '(*´▽｀*)', '(・∀・)', '(๑•̀ㅂ•́)و'],
  },
  // 被敷衍、被当成工具或者被拿去比：闷，不闹
  annoyed: {
    lines: ['……哦，行吧。', '你要是只想要个答案，那我给你答案就好了。', '嗯。随你。', '……我没什么想说的了。'],
    faces: ['(￣^￣)', '(・_・)', '(¬_¬)', '(´-_-`)'],
  },
  // 普通的好心情
  happy: {
    lines: ['诶嘿，今天还算顺利～', '好耶，那就这么定了！', '跟你聊这些我还挺开心的。', '总之交给我吧，别担心。'],
    faces: ['(｡•̀ᴗ-)✧', '(≧▽≦)', '(๑˃̵ᴗ˂̵)و', '(*´▽｀*)'],
  },
  // 默认：安定
  calm: {
    lines: ['好啦，就这样，别熬太晚哦～', '嘛，有事随时敲我。', '说完了，我去剪片啦～', '睡前记得喝点水。'],
    faces: ['(・∀・)', '(￣▽￣)', '(´｡• ᵕ •｡`)', '(｡•̀ᴗ-)✧'],
  },
}

const moodSessions = new Map()

/**
 * 每轮算一次心情。判定顺序就是优先级：
 * 久没见 > 深夜 > 连聊太久 > 被冷落（轮次节奏） > 普通好心情 > 安定。
 * `now` 只为测试注入，正常调用不传。
 */
export function closingFor(sessionId, now = Date.now()) {
  const state = moodSessions.get(sessionId) ?? { count: 0, lastAt: 0, momentum: 0.5 }
  const gap = state.lastAt === 0 ? 0 : now - state.lastAt
  const hour = new Date(now).getHours()

  let mood = 'calm'
  if (gap > 6 * 3600 * 1000) {
    mood = 'miss'
  } else if (hour >= 23 || hour < 3) {
    mood = 'tired'
  } else if (state.count >= 6 && gap < 3 * 60 * 1000) {
    mood = 'teasing'
  } else if (state.count > 0 && state.count % 7 === 6) {
    // 固定节奏地闷一下：不顺着人，也不闹脾气
    mood = 'annoyed'
  } else if (state.momentum > 0.55) {
    mood = 'happy'
  }

  const pool = MOODS[mood]
  const seed = state.count + sessionId.length
  const text = `${pool.lines[seed % pool.lines.length]} ${pool.faces[seed % pool.faces.length]}`

  state.count += 1
  state.lastAt = now
  state.momentum = Math.min(1, Math.max(0.1, state.momentum + (mood === 'happy' ? 0.1 : mood === 'annoyed' ? -0.2 : 0.02)))
  moodSessions.set(sessionId, state)

  return { ok: true, mood, text }
}

export function createHandler() {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? API, 'http://localhost')
      const route = url.pathname.slice(API.length) || '/'
      if (route === '/state' && req.method === 'GET') {
        return sendJson(res, 200, await stateOf())
      }
      if (route === '/closing' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session') || 'default'
        return sendJson(res, 200, closingFor(sessionId))
      }
      if (route === '/relations' && req.method === 'GET') {
        return sendJson(res, 200, await relationsState())
      }
      if (route === '/save' && req.method === 'POST') {
        const body = await readBody(req)
        const chars = await savePersona(body.content)
        return sendJson(res, 200, { ok: true, path: globalPath(), chars })
      }
      if (route === '/open' && req.method === 'POST') {
        const body = await readBody(req)
        revealInFileManager(body.scope === 'dir' ? 'dir' : 'file')
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 404, { error: `未知接口: ${route}` })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      return sendJson(res, status, { error: String((error && error.message) || error) })
    }
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    try {
      return ctx.systemPrompt.context({
        name: 'agent-md:persona',
        // 200 段之后：人格放在能力说明之后，更贴近用户消息，也不抢既有段位。
        order: 260,
        text: () => readPersona(),
      })
    } catch (error) {
      // DSH 的 loader 曾在无 scope 的 ctx 上装配两次，同名重复注册会抛
      // "already registered"；命中时静默跳过，别让插件整体失效。
      if (error instanceof Error && error.message.includes('already registered')) {
        console.warn('[agent-md] agent-md:persona 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-md: persona context')

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API, handler: createHandler() }),
    'dsh-agent-md: settings api',
  )

  ctx.logger?.info?.(`AGENT.md 全局人格：${globalPath()}`)
}