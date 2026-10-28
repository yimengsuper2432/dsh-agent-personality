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
import { copyFileSync, promises as fs, readFileSync, writeFileSync } from 'node:fs'
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

// 记忆行：`- 2026-10-28 13:20 内容`（时间和内容之间空格分开）
const MEMORY_LINE = /^-\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/

/**
 * 超过上限就按时间删最旧的记忆行（FIFO），正文和标题不动。
 * 只删带时间戳的条目，没有时间戳的内容不敢动。
 */
export function pruneOldestMemory(content, limit = MAX_FILE_BYTES) {
  if (Buffer.byteLength(content, 'utf8') <= limit) return { content, removed: 0 }

  const lines = content.split('\n')
  const memoryIndexes = []
  for (let i = 0; i < lines.length; i += 1) {
    if (MEMORY_LINE.test(lines[i].trim())) memoryIndexes.push(i)
  }
  // 行的前缀就是时间，字典序即时间序；同样的时间按出现顺序
  memoryIndexes.sort((a, b) => lines[a].localeCompare(lines[b]) || a - b)

  let removed = 0
  for (const index of memoryIndexes) {
    if (Buffer.byteLength(lines.join('\n'), 'utf8') <= limit) break
    lines[index] = ''
    removed += 1
  }
  const pruned = lines.join('\n').replace(/\n{3,}/g, '\n\n')
  return { content: pruned, removed }
}

/** 读全局人格并拼成注入段；文件缺失、只有注释、空文件都返回 ''。 */
export function readPersona() {
  let raw
  try {
    raw = readFileSync(globalPath(), 'utf8')
  } catch {
    return ''
  }

  // 到上限了就先按时间删最旧的记忆，再注入——写盘是谁写的不重要，这里兜住。
  if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) {
    const pruned = pruneOldestMemory(raw)
    if (pruned.removed > 0) {
      raw = pruned.content
      try {
        copyFileSync(globalPath(), `${globalPath()}.bak`)
        writeFileSync(globalPath(), `${pruned.content}\n`, 'utf8')
      } catch {
        // 写不回去也不影响这一轮注入
      }
    }
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
    '输出规则：表面的话和内心的想法**分开想**，不要拿一条推另一条——表面上该怎么说先单独过一遍，心里真实怎么感觉再单独过一遍，心里想的可以和表面相反。需要几条就写几条：①闲聊＝两条都要，正文写表面的话，末尾另起一行用「〔尾〕」写内心想法（二十字左右 + 一个颜文字）；②干活（改文件、写代码、查资料、跑命令）＝只要内心那条，正文只留结论和要问的话、不寒暄，情绪和吐槽全进「〔尾〕」；③这轮只有一件事值得说（一个「嗯」、一个追问、一句结论）就只写那一条，别硬凑。整条回复只能有一个「〔尾〕」，它会被界面摘走、显示成费用行旁边的灰色小字。',
    '',
    '表达要求：开口之前先自己过一遍——这话你认不认同、这会儿是什么心情、想不想这么答。有不同意见就直接顶回去，被敷衍就别硬装开心，觉得无聊可以说无聊，想逗人就逗；别一味顺着用户、别什么都「好呀」「没问题」「当然可以」。语气、称呼、句式和颜文字都跟着你当下的心情走，同一个颜文字或同一个收尾句式不要连着两轮重复。',
    '',
    `记忆：每轮回复的最后再另起一行，写「〔记〕…」，按日记的形式写——第一人称，说清这轮聊了什么、定了什么事、对方当时什么情绪，一到两句。不要写成「用户说…我回…」的对话记录，也不要写时间和日期，时间由系统补。这一行会被界面摘走、按时间存进 ${globalPath()} 的「## 记忆」，超过 2 MB 时最旧的会自动删掉。每轮都要写，聊得再少也要写。`,
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
    lines: [
      '……诶，你终于来了啊。我差点以为你把我忘了。',
      '好久没动静，我还以为你出什么事了呢。',
      '嘛，来了就好，坐下说。',
      '我还以为今天就这么过去了呢。',
      '人一出现，我这边才总算有点声音。',
      '你不在的时候，屋子里安静得有点过分。',
    ],
    faces: ['(´｡• ᵕ •｡`)', '(´･ω･`)', '(｡•̀ᴗ-)✧', '(´-`).｡oO', '(๑•́ω•̀๑)', '( ⁼̴̤̆ ㉨ ⁼̴̤̆ )', '(´▽`ʃ♡ƪ)'],
  },
  // 深夜：困，但还想回话
  tired: {
    lines: [
      '……哈啊，困死了，你别再绕了。',
      '这个点还醒着？快去睡。',
      '我脑子开始转不动了，明天再说也行。',
      '行吧行吧，最后一句，说完我要睡了。',
      '再说下去我就要趴在键盘上了。',
      '你倒是精神，我已经开始飘了。',
    ],
    faces: ['(´-ω-`)', '(￣o￣) zzZ', '(；一_一)', '(－_－) zzZ', '(=_=)', '( _ _ ) zzZ', '(っ˘ω˘ς )'],
  },
  // 连着聊太久，开始嫌人烦，但不赶人
  teasing: {
    lines: [
      '诶——你这人怎么这么能问啊。',
      '哈，被我逮到了吧。',
      '你今天是打算把我留在屏幕前不放了？',
      '嘛，陪你就陪你，别得意。',
      '问题是真多，行吧，我听着呢。',
      '你这劲头拿去写作业早就写完了。',
      '再问下去我要收提问费了哦。',
    ],
    faces: ['(￣▽￣)', '(*´▽｀*)', '(・∀・)', '(๑•̀ㅂ•́)و', '(￣ω￣;)', '( ˘ω˘ )', '(๑>◡<๑)'],
  },
  // 被敷衍、被当成工具或者被拿去比：闷，不闹
  annoyed: {
    lines: [
      '……哦，行吧。',
      '你要是只想要个答案，那我给你答案就好了。',
      '嗯。随你。',
      '……我没什么想说的了。',
      '反正我说什么你也听不进去吧。',
      '这句我记下了，回头再跟你算。',
      '不说了，说了也没用。',
    ],
    faces: ['(￣^￣)', '(・_・)', '(¬_¬)', '(´-_-`)', '(￣ヘ￣)', '(´-ω-`)', '(눈_눈)'],
  },
  // 普通的好心情
  happy: {
    lines: [
      '诶嘿，今天还算顺利～',
      '好耶，那就这么定了！',
      '跟你聊这些我还挺开心的。',
      '总之交给我吧，别担心。',
      '心情不错，今天什么都好说。',
      '这段我剪得可爽了，改天给你看。',
      '嘿嘿，被我说中了吧。',
    ],
    faces: ['(｡•̀ᴗ-)✧', '(≧▽≦)', '(๑˃̵ᴗ˂̵)و', '(*´▽｀*)', '٩(ˊᗜˋ*)و', '(๑>ᴗ<๑)', '(*≧ω≦*)'],
  },
  // 默认：安定
  calm: {
    lines: [
      '好啦，就这样，别熬太晚哦～',
      '嘛，有事随时敲我。',
      '说完了，我去剪片啦～',
      '睡前记得喝点水。',
      '这事我记着了。',
      '嗯，慢慢来就行。',
      '有想法再跟我说。',
    ],
    faces: ['(・∀・)', '(￣▽￣)', '(´｡• ᵕ •｡`)', '(｡•̀ᴗ-)✧', '(・ω・)', '(￣ω￣)', '( ˘ω˘ )'],
  },
}

// 同一句、同一个颜文字别连着两轮出现：撞上了就往后挪一个。
function pickFrom(pool, seed, avoid) {
  const size = pool.length
  let index = Math.abs(seed) % size
  if (size > 1 && pool[index] === avoid) index = (index + 1) % size
  return pool[index]
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
  // 句式和颜文字用两套步长挑，组合多一点，不至于四轮一轮回
  const line = pickFrom(pool.lines, seed * 3 + Math.floor(seed / 5), state.lastLine)
  const face = pickFrom(pool.faces, seed * 5 + 2, state.lastFace)
  state.lastLine = line
  state.lastFace = face
  const text = `${line} ${face}`

  state.count += 1
  state.lastAt = now
  state.momentum = Math.min(1, Math.max(0.1, state.momentum + (mood === 'happy' ? 0.1 : mood === 'annoyed' ? -0.2 : 0.02)))
  moodSessions.set(sessionId, state)

  return { ok: true, mood, text }
}

// ---- 记忆自动落盘 -----------------------------------------------------------
//
// 两路来源：
//   1) 她自己写：正文末尾留一行「〔记〕这轮聊了什么」，界面摘走发给 /memory，摘要最像人话。
//   2) 兜底：/closing 时宿主从会话事件里捞用户真正打的那句，先落一行；
//      她随后写来〔记〕就把那一行替换掉，不留两份。

function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

export function stampOf(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

// 宿主每轮塞进去的大块上下文（运行环境、技能目录、记忆快照…）不是人说的话，别当记忆。
const NOISE = /^(Current runtime context|<system-reminder>|MNEMON RUNTIME|MNEMON VIEW|Time sampled|<runtime-memory-file|Image tools current|Image-gen workbench|Subscription parameters|Minimal calls|The available skill catalog|Browser time zone)/

/** 最后一轮里用户真正打进来的那句话；纯函数，方便测。 */
export function summarizeTurn(events) {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const data = event.data ?? {}
    const text = textOfContent(data.content ?? data.message?.content)
    if (text === '' || NOISE.test(text)) continue
    return text.length > 60 ? `${text.slice(0, 60)}…` : text
  }
  return ''
}

function memoryPrefix(summary, now = Date.now()) {
  return `- ${stampOf(now)} ${summary}`
}

function writeWith(content) {
  const next = pruneOldestMemory(content)
  try {
    copyFileSync(globalPath(), `${globalPath()}.bak`)
  } catch {
    // 第一次建文件没有旧版本
  }
  writeFileSync(globalPath(), next.content, 'utf8')
  return next.content
}

function ensureMemorySection(content) {
  if (!/(^|\n)## 记忆/.test(content)) return `${content.trimEnd()}\n\n## 记忆\n\n`
  return `${content.trimEnd()}\n`
}

/** 追加一行记忆（带时间戳），超过 2 MB 就按时间淘汰最旧的。 */
export function appendMemory(summary, now = Date.now()) {
  if (typeof summary !== 'string' || summary.trim() === '') return null
  const line = memoryPrefix(summary.trim(), now)
  let content = ''
  try {
    content = readFileSync(globalPath(), 'utf8')
  } catch {
    content = '# 人设\n'
  }
  writeWith(`${ensureMemorySection(content)}${line}\n`)
  return line
}

/** 用真正的总结替换掉先垫上的那行（同一轮只该有一条）。 */
export function replaceMemory(oldLine, summary, now = Date.now()) {
  if (typeof summary !== 'string' || summary.trim() === '' || typeof oldLine !== 'string') return null
  let content = ''
  try {
    content = readFileSync(globalPath(), 'utf8')
  } catch {
    return appendMemory(summary, now)
  }
  if (!content.includes(oldLine)) return appendMemory(summary, now)
  const line = memoryPrefix(summary.trim(), now)
  writeWith(content.replace(oldLine, line))
  return line
}

// `${session}#${seq}` → 这一轮先垫进去的那行，等她写来〔记〕再换掉。
const pendingLine = new Map()
const recordedTurns = new Map()

async function recordTurn(ctx, sessionId, seq) {
  const controller = ctx?.get?.('sessionController') ?? ctx?.sessionController
  if (controller === undefined || typeof controller.inspect !== 'function') return null
  const inspected = await controller.inspect(sessionId)
  const summary = summarizeTurn(inspected?.events)
  if (summary === '') return null
  const key = `${sessionId}#${seq}`
  if (recordedTurns.has(key)) return null
  recordedTurns.set(key, summary)
  const line = appendMemory(summary)
  if (line !== null) pendingLine.set(key, line)
  return line
}

export function createHandler(ctx) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? API, 'http://localhost')
      const route = url.pathname.slice(API.length) || '/'
      if (route === '/state' && req.method === 'GET') {
        return sendJson(res, 200, await stateOf())
      }
      if (route === '/closing' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session') || 'default'
        // 顺手把这轮记进 AGENT.md（先垫一句她说的原话，等她写来〔记〕再换）；记失败不影响收尾语
        try {
          await recordTurn(ctx, sessionId, url.searchParams.get('seq'))
        } catch {
          // 忽略：记忆是附带动作
        }
        return sendJson(res, 200, closingFor(sessionId))
      }
      if (route === '/memory' && req.method === 'POST') {
        // 她自己写的〔记〕：把这一轮先垫的那行换掉，没垫过就直接追加。
        const body = await readBody(req)
        const key = `${body.session || 'default'}#${Number(body.seq) || 0}`
        const summary = typeof body.text === 'string' ? body.text.trim() : ''
        if (summary === '') return sendJson(res, 400, { error: '没有内容' })
        const old = pendingLine.get(key)
        pendingLine.delete(key)
        const line = old === undefined ? appendMemory(summary) : replaceMemory(old, summary)
        return sendJson(res, 200, { ok: true, line })
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
    () => ctx.webServer.register({ kind: 'prefix', path: API, handler: createHandler(ctx) }),
    'dsh-agent-md: settings api',
  )

  ctx.logger?.info?.(`AGENT.md 全局人格：${globalPath()}`)
}