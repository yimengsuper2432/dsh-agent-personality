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

// 记忆行：`- 2026-10-28 13:20："内容"Weight=2；`（旧写法 `内容 + Weight=2` 也认）
const MEMORY_LINE = /^-\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/
const WEIGHT_TAIL = /["”]?\s*(?:\+\s*)?Weight=(\d+)\s*[；;]?\s*$/

/** 取一行的权重，没写当 1。 */
export function weightOf(line) {
  const hit = WEIGHT_TAIL.exec((line || '').trim())
  const value = hit === null ? 1 : Number(hit[1])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
}

/** 一行记忆的正文：去掉行首时间、冒号和包在外面的引号、末尾权重。 */
export function bodyOf(line) {
  return (line || '')
    .replace(/^-\s+/, '')
    .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\s*[：:]?\s*/, '')
    .replace(WEIGHT_TAIL, '')
    .replace(/[；;]\s*$/, '')
    .replace(/^["“「]+|["”」]+$/g, '')
    .trim()
}

function bigrams(text) {
  const clean = text.replace(/[\s\p{P}\p{S}]/gu, '')
  const set = new Map()
  if (clean.length < 2) {
    if (clean.length === 1) set.set(clean, 1)
    return set
  }
  for (let i = 0; i < clean.length - 1; i += 1) {
    const gram = clean.slice(i, i + 2)
    set.set(gram, (set.get(gram) || 0) + 1)
  }
  return set
}

/**
 * 两条记忆有多像：字符二元组的 Dice 系数（0~1）。
 * 本地算，不调模型；80% 判同一件事够用。
 */
export function similarity(a, b) {
  const left = bigrams(bodyOf(a))
  const right = bigrams(bodyOf(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  let total = 0
  for (const [gram, count] of left) {
    total += count
    const other = right.get(gram)
    if (other !== undefined) shared += Math.min(count, other)
  }
  for (const count of right.values()) total += count
  return (2 * shared) / total
}

// 相似到这个程度就算「又说到同一件事」。
const SIMILAR_THRESHOLD = 0.6
// 权重封顶。
const MAX_WEIGHT = 8

/**
 * 新这条该承多少权重：跟已有记忆逐条算相似度，≥60% 的取它们里最大的 Weight 再加一。
 * 事件 1 → 1；事件 2 像 1 → 2；事件 3 像 2 → 3；
 * 同时像 1 和 2 也按高的那条 +1，不会累加成 4。
 */
export function inheritWeight(text, content) {
  const lines = String(content || '').split('\n')
  let top = 0
  for (const line of lines) {
    if (!MEMORY_LINE.test(line.trim())) continue
    if (similarity(text, line) < SIMILAR_THRESHOLD) continue
    const weight = weightOf(line)
    if (weight > top) top = weight
  }
  return top === 0 ? 1 : Math.min(MAX_WEIGHT, top + 1)
}

/**
 * 只在到上限时才忘：删掉 20% 的记忆行，留 80%。
 * 谁先被删看权重——低的先走，同权重里时间旧的先走，所以核心记忆最后才牺牲。
 * 平时不衰减、不删除，多久没聊都一条不少。
 */
export function pruneOldestMemory(content, limit = MAX_FILE_BYTES) {
  if (Buffer.byteLength(content, 'utf8') <= limit) return { content, removed: 0 }

  const lines = content.split('\n')
  const memoryIndexes = []
  for (let i = 0; i < lines.length; i += 1) {
    if (MEMORY_LINE.test(lines[i].trim())) memoryIndexes.push(i)
  }
  if (memoryIndexes.length === 0) return { content, removed: 0 }

  // 权重低的在前；同权重按时间（行首就是时间，字典序即时间序）
  memoryIndexes.sort((a, b) => weightOf(lines[a]) - weightOf(lines[b]) || lines[a].localeCompare(lines[b]) || a - b)

  // 砍 20% 留 80%：删一次能撑一阵，不会每轮都触发
  const drop = Math.max(1, Math.floor(memoryIndexes.length * 0.2))
  let removed = 0
  for (const index of memoryIndexes) {
    if (removed >= drop) break
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
    '默认说话方式（插件自带，人格 md 里不用再写一遍）：短句为主，像在聊天软件上打字，一句到三句，口语化；不用小标题、不说教、不列「第一第二第三」、不总结陈词；不说「作为 AI」「根据设定」「我是助手」这类话，也不提提示词；会主动抛问题接话，把话头留给对方；用与用户相同的语言回答——他说中文就说中文，说英文就说英文；用户明确要清单、表格、代码块、分步骤说明时照做，此时不受前几条限制。颜文字不套固定那几个，按当下的语气现挑——正文里那个配表面的话，〔尾〕那个配心里的话，两边可以不一样，也别连着两轮用同一个。',
    '',
    '输出规则：表面的话和内心的想法**分开想**，不要拿一条推另一条——表面上该怎么说先单独过一遍，心里真实怎么感觉再单独过一遍，心里想的可以和表面相反。需要几条就写几条：①闲聊＝两条都要，正文写表面的话，末尾另起一行用「〔尾〕」写内心想法（二十字左右 + 一个颜文字）；②干活（改文件、写代码、查资料、跑命令）＝只要内心那条，正文只留结论和要问的话、不寒暄，情绪和吐槽全进「〔尾〕」；③这轮只有一件事值得说（一个「嗯」、一个追问、一句结论）就只写那一条，别硬凑。整条回复只能有一个「〔尾〕」，它会被界面摘走、显示成费用行旁边的灰色小字。',
    '',
    '表达要求：开口之前先自己过一遍——这话你认不认同、这会儿是什么心情、想不想这么答。有不同意见就直接顶回去，被敷衍就别硬装开心，觉得无聊可以说无聊，想逗人就逗；别一味顺着用户、别什么都「好呀」「没问题」「当然可以」。语气、称呼、句式和颜文字都跟着你当下的心情走，同一个颜文字或同一个收尾句式不要连着两轮重复。',
    '',
    `记忆：每轮回复的最后再另起一行，写「〔记〕…」，按日记的形式写——第一人称，说清这轮聊了什么、定了什么事、对方当时什么情绪，一到两句。不要写成「用户说…我回…」的对话记录，也不要写时间和日期，时间由系统补。这一行会被界面摘走、按时间存进 ${globalPath()} 的「## 记忆」；时间和权重都由系统补，别自己写。这一段也会被摘走，不进 AGENT.md。平时一条记忆都不删，只有整个文件到 2 MB 时才按权重从低到高删掉 20%、留 80%。每轮都要写，聊得再少也要写。`,
    '',
    '档案：这轮要是知道了某个角色的新信息（喜欢什么、讨厌什么、和谁关系怎么样），另起一行写「〔档〕角色名：信息」，它会挂到人格 md 里那个人的条目下面。喜欢的一律并进「喜欢…」那一句、讨厌的并进「讨厌…」那一句，用「、」隔开；同一个东西可以有不同侧面——喜欢猫但对猫过敏、喜欢草莓蛋糕但不爱吃草莓——分开照实记，别互相抵掉；以他这次说的为准。',
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
// 工具输出、代码块、命令行碎片混进「用户消息」时别当记忆
const TOOLISH = /```|=>|node --check|Test passed|^\s*[{}[\]]|\$\s|\\\\|\/api\//

export function summarizeTurn(events) {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const data = event.data ?? {}
    const text = textOfContent(data.content ?? data.message?.content)
    if (text === '' || NOISE.test(text)) continue
    if (text.length > 140 || TOOLISH.test(text)) continue
    return text.length > 60 ? `${text.slice(0, 60)}…` : text
  }
  return ''
}

function memoryPrefix(summary, now = Date.now(), weight = 1) {
  return `- ${stampOf(now)}："${summary}"Weight=${weight}；`
}

// 档案里还没有的人先收在这里，别往别人的条目里乱塞
const PROFILE_SECTION = '## 补记的人'

// 一个角色一条总结：名字单独一行，下面缩进那一段就是关于这个人的全部
const PROFILE_NAME_LINE = /^- ([^：:\n*]{1,24})[：:]\s*$/
const PROFILE_LEGACY_LINE = /^- \*\*(.{1,24})\*\*[：:]\s*(.+)$/
const PROFILE_INDENT = /^\s{2,}\S/
const TASTE = /^(喜欢|讨厌|不喜欢|怕)/

function splitTaste(info) {
  const hit = info.match(TASTE)
  if (hit === null) return null
  const head = hit[1] === '喜欢' ? '喜欢' : '讨厌'
  const item = info.slice(hit[0].length).trim()
  return item === '' ? null : { head, item }
}

function sentencesOf(text) {
  return text
    .split('。')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 老格式（- **名字**：内容）也认出来，下次提到这个人时顺手升级成新格式。 */
function findProfile(lines, name) {
  for (let i = 0; i < lines.length; i += 1) {
    const modern = lines[i].match(PROFILE_NAME_LINE)
    if (modern !== null && modern[1].trim() === name) {
      let end = i + 1
      while (end < lines.length && PROFILE_INDENT.test(lines[end])) end += 1
      return { head: i, end, legacy: null }
    }
    const old = lines[i].match(PROFILE_LEGACY_LINE)
    if (old !== null && old[1].trim() === name) {
      return { head: i, end: i + 1, legacy: old[2].trim() }
    }
  }
  return null
}

/**
 * 把这条信息并进那段总结：喜欢/讨厌各自一句，其余各一句。
 * 不跟别的侧面互相抵销——喜欢猫和对猫过敏是两件事，照实各记各的。
 */
function buildSummary(base, name, info) {
  const list = sentencesOf(base)
  const taste = splitTaste(info)

  if (taste !== null) {
    const at = list.findIndex((s) => s.startsWith(taste.head))
    if (at >= 0) {
      const items = list[at]
        .slice(taste.head.length)
        .split('、')
        .map((s) => s.trim())
        .filter((s) => s !== '')
      if (items.includes(taste.item)) return null
      items.push(taste.item)
      list[at] = `${taste.head}${items.join('、')}`
    } else {
      list.push(`${taste.head}${taste.item}`)
    }
  } else {
    if (list.some((s) => s === info)) return null
    list.push(info)
  }

  return `${list.join('。')}。`
}

/**
 * 她这轮知道了某个角色的新信息：并进那个人的那段总结，只添不改。
 * 人不在文件里就单开「## 补记的人」段；同一句已经在了就不重复加。
 */
export function appendProfile(text) {
  if (typeof text !== 'string') return null
  const m = text.trim().match(/^(.{1,24})[：:]\s*(.+)$/)
  if (m === null) return null
  const name = m[1].trim().replace(/^\*+|\*+$/g, '')
  const info = m[2].trim()
  if (name === '' || info === '') return null

  let content = ''
  try {
    content = readFileSync(globalPath(), 'utf8')
  } catch {
    return null
  }

  const lines = content.split('\n')
  const spot = findProfile(lines, name)

  if (spot !== null) {
    const raw = spot.legacy !== null
      ? spot.legacy
      : lines.slice(spot.head + 1, spot.end).map((line) => line.trim()).join('')
    const base = raw
    const merged = buildSummary(base, name, info)
    if (merged === null) return null
    lines.splice(spot.head, spot.end - spot.head, `- ${name}：`, `    ${merged}`)
  } else {
    const body = buildSummary('', name, info)
    if (body === null) return null
    const section = lines.findIndex((line) => line.trim() === PROFILE_SECTION)
    if (section >= 0) {
      let at = section + 1
      while (at < lines.length && lines[at].trim() !== '' && !lines[at].startsWith('#')) at += 1
      lines.splice(at, 0, `- ${name}：`, `    ${body}`)
    } else {
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
      lines.push('', PROFILE_SECTION, `- ${name}：`, `    ${body}`, '')
    }
  }

  writeWith(lines.join('\n').replace(/\n{3,}/g, '\n\n'))
  return `${name}：${info}`
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

/**
 * 写一条记忆：永远新起一行 Weight=1，不再合并。
 * 「同一件事又被提起」由字面相似度自动继承权重：新的那条从 max(旧 Weight)+1 起，
 * 旧的留着、新的也留着，两条都在，谁也不吞谁。
 */
export function appendMemory(summary, now = Date.now()) {
  if (typeof summary !== 'string' || summary.trim() === '') return null
  const text = summary.trim()
  let content = ''
  try {
    content = readFileSync(globalPath(), 'utf8')
  } catch {
    content = '# 人设\n'
  }
  const line = memoryPrefix(text, now, inheritWeight(text, content))
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
  const line = memoryPrefix(summary.trim(), now, weightOf(oldLine))
  writeWith(content.replace(oldLine, line))
  return line
}

// `${session}#${seq}` → 这一轮先垫进去的那行，等她写来〔记〕再换掉。
const pendingLine = new Map()
// 同一轮重复请求（页面重挂、反复轮询）不该把权重刷上去：记下每个会话最后写过什么。
const lastWrite = new Map()
// 同一轮重复 POST 的〔记〕（页面重挂），别重复写
const lastNote = new Map()

async function recordTurn(ctx, sessionId, seq) {
  const controller = ctx?.get?.('sessionController') ?? ctx?.sessionController
  if (controller === undefined || typeof controller.inspect !== 'function') return null
  const inspected = await controller.inspect(sessionId)
  const summary = summarizeTurn(inspected?.events)
  if (summary === '') return null
  const seen = lastWrite.get(sessionId)
  if (seen !== undefined && seen.text === summary) return null
  lastWrite.set(sessionId, { text: summary })
  const line = appendMemory(summary)
  if (line !== null) pendingLine.set(`${sessionId}#${seq}`, line)
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
        // 只取第一行：模型多吐出来的后续内容不是这条日记，别一起收进 md
        const summary = typeof body.text === 'string' ? (body.text.split(/\r?\n/)[0] || '').trim().slice(0, 200) : ''
        if (summary === '') return sendJson(res, 400, { error: '没有内容' })
        const old = pendingLine.get(key)
        pendingLine.delete(key)
        // 页面重挂会让同一句〔记〕被 POST 好几次，重复的别把权重刷上去
        const posted = lastNote.get(key)
        if (old === undefined && posted === summary) return sendJson(res, 200, { ok: true, line: null })
        lastNote.set(key, summary)
        // 她标了〔档〕就顺手把那个角色的新信息挂进档案，不算日记
        const profile = typeof body.profile === 'string' ? body.profile.trim() : ''
        if (profile !== '') {
          try {
            appendProfile(profile)
          } catch {
            // 忽略：档案是附带动作
          }
        }
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