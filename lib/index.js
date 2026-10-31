/**
 * dsh-virtual-person —— 宿主半：全局 AGENT.md 注入 + 设置页用的读写接口。
 *
 * 注入机制：`systemPrompt.context({ text: fn })` 的 text 是函数，每次装配提示词都会
 * 被调用；DSH 把它物化成一条 user 角色尾消息，且只在渲染文本变化时重新追加，所以
 * 改完 AGENT.md 下一回合生效，稳定前缀缓存不会被打断。
 *
 * 只有全局人格：不看会话 cwd、没有项目人格、没有模板。
 * 只 import node: 内置模块（local link 安装时裸包名解析不到）。
 */

import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const name = 'virtual-person'
export const inject = ['systemPrompt', 'webServer']

const API = '/api/virtual-person'
const MAX_INJECT_CHARS = 40000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILE_LABEL = '2 MB'
const SNAPSHOT_DIR = 'snapshots'
const MAX_SNAPSHOTS = 30

/** 快照序号：只增不复用，保证同一秒内的先后顺序可排。 */
let snapshotSeq = 0

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

// 记忆行：`- 2026-10-28 13:20："内容"^2；`
//   行首时间 = 最近一次被提到的时间（写这条时、或后来又被提到一次时都会刷新）
//   ^N      = 被重复提起过几次（惊讶度反面：越像越合并，N 就越大）
//   *       = 钉住，永不淘汰、每轮必注入
// 老写法 `"内容"Weight=N；` 只读不写，迁移时换成新格式。
const MEMORY_LINE = /^-\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/
const HIT_TAIL = /\^(\d{1,4})\s*[；;]?\s*$/
const PIN_TAIL = /["”」]\s*(?:\^\d+)?\s*\*\s*[；;]?\s*$/
const WEIGHT_TAIL = /["”]?\s*(?:\+\s*)?Weight=(\d+)\s*[；;]?\s*$/

/** 这一条被重复提起过几次。 */
export function hitsOf(line) {
  const text = (line || '').trim()
  const hit = HIT_TAIL.exec(text)
  if (hit !== null) {
    const value = Number(hit[1])
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  }
  const legacy = WEIGHT_TAIL.exec(text)
  if (legacy === null) return 0
  const value = Number(legacy[1])
  return Number.isFinite(value) && value > 1 ? Math.floor(value) - 1 : 0
}

/** 钉住的行：永不淘汰、每轮都在。 */
export function isPinned(line) {
  return PIN_TAIL.test((line || '').trim())
}

/** 三档：钉住＝core，被反复提过＝mid，其余＝edge。 */
export function levelOf(line) {
  if (isPinned(line)) return 'core'
  return hitsOf(line) > 0 ? 'mid' : 'edge'
}

/** 一行记忆的正文：去掉行首时间、冒号和包在外面的引号、末尾的命中/钉住标记。 */
export function bodyOf(line) {
  return (line || '')
    .replace(/^-\s+/, '')
    .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\s*[：:]?\s*/, '')
    .replace(WEIGHT_TAIL, '')
    .replace(PIN_TAIL, '')
    .replace(HIT_TAIL, '')
    .replace(/[；;]\s*$/, '')
    .replace(/^["“「]+|["”」]+$/g, '')
    .replace(/["”」]+\s*$/, '')
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

// 相似到这个程度就算「又说到同一件事」：不新建，合并进旧那条。
const SIMILAR_THRESHOLD = 0.6

/**
 * 新这条跟已有的哪条是同一件事：返回最像的那行的下标和相似度。
 * 惊讶度 s = 1 - 相似度；越像越不惊讶，就不用再记一遍，只把旧那条的命中次数加一。
 */
export function findSimilar(text, content) {
  const lines = String(content || '').split('\n')
  let best = null
  lines.forEach((line, index) => {
    if (!MEMORY_LINE.test(line.trim())) return
    const score = similarity(text, line)
    if (score < SIMILAR_THRESHOLD) return
    if (best === null || score > best.score) best = { index, score }
  })
  return best
}

// 记忆段在提示词里能占多少字符：超了就从最旧的开始不摆，不然每轮会被日记撑爆。
const INJECT_MEMORY_CHARS = 32000

/**
 * 挑进提示词的记忆：钉住的（core）无条件先占名额，剩下的按时间从新到旧补，
 * 补到字符预算用完为止。挑完仍按文件里的原顺序摆。
 *
 * 按字符而不是按条数——条数上限和「文件到 2 MB 才剪枝」是两套对不上的阈值，
 * 按条数卡的时候，文件才几十 KB 就已经有一批记忆永远轮不到注入了。
 */
export function pickForInject(content, budget = INJECT_MEMORY_CHARS) {
  const lines = String(content || '').split('\n')
  const rows = []
  lines.forEach((line, i) => {
    if (MEMORY_LINE.test(line.trim())) rows.push(i)
  })
  if (rows.length === 0) return lines.join('\n')

  const pinned = rows.filter((i) => isPinned(lines[i]))
  const rest = rows
    .filter((i) => !isPinned(lines[i]))
    .sort((a, b) => lines[b].localeCompare(lines[a]) || b - a)

  const picked = new Set(pinned)
  let used = pinned.reduce((sum, i) => sum + lines[i].length + 1, 0)
  for (const i of rest) {
    const cost = lines[i].length + 1
    // 太长的那条跳过继续收后面的短的，别让一条长记忆把剩下的预算全挡住
    if (used + cost > budget) continue
    picked.add(i)
    used += cost
  }
  if (picked.size === rows.length) return lines.join('\n')

  const isMemory = new Set(rows)
  return lines.filter((line, i) => !isMemory.has(i) || picked.has(i)).join('\n')
}

/**
 * 只在到上限时才忘：删掉 20% 的记忆行，留 80%。
 * 只从 edge 里挑，edge 不够才动 mid，同样按时间从旧到新；core 一律不动。
 * 时间是最硬的排序依据——后来一直没再提，就是它不重要的证据。
 */
export function pruneOldestMemory(content, limit = MAX_FILE_BYTES) {
  if (Buffer.byteLength(content, 'utf8') <= limit) return { content, removed: 0 }

  const lines = content.split('\n')
  const memoryIndexes = []
  for (let i = 0; i < lines.length; i += 1) {
    if (MEMORY_LINE.test(lines[i].trim())) memoryIndexes.push(i)
  }
  if (memoryIndexes.length === 0) return { content, removed: 0 }

  // 先 edge 后 mid；同档里时间旧的先走（行首就是时间，字典序即时间序）
  const rank = (index) => (levelOf(lines[index]) === 'edge' ? 0 : 1)
  const removable = memoryIndexes
    .filter((index) => levelOf(lines[index]) !== 'core')
    .sort((a, b) => rank(a) - rank(b) || lines[a].localeCompare(lines[b]) || a - b)
  if (removable.length === 0) return { content, removed: 0 }

  // 砍 20% 留 80%：删一次能撑一阵，不会每轮都触发
  const drop = Math.max(1, Math.floor(memoryIndexes.length * 0.2))
  let removed = 0
  for (const index of removable) {
    if (removed >= drop) break
    lines[index] = ''
    removed += 1
  }
  const pruned = lines.join('\n').replace(/\n{3,}/g, '\n\n')
  return { content: pruned, removed }
}

/**
 * 删记忆之前先存一份完整副本。
 * 删是不可逆的，快照是唯一退路；只保留最近 MAX_SNAPSHOTS 份，超出的按时间删最旧。
 * 快照失败不抛错——宁可这次不删，也不能因为存不下就把人挡在门外。
 */
export function snapshotMemory(content, target = globalPath()) {
  const dir = join(dirname(target), SNAPSHOT_DIR)
  try {
    mkdirSync(dir, { recursive: true })
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    // 同一秒里连着触发也不能互相覆盖。
    // 序号只增不复用——按文件名占空位的话，被删掉的号会被下一次写入捡回去，时间序就乱了。
    let file = ''
    do {
      snapshotSeq += 1
      file = join(
        dir,
        `${basename(target)}.${stamp}-${String(snapshotSeq).padStart(4, '0')}.snapshot.md`,
      )
    } while (existsSync(file))
    writeFileSync(file, content, 'utf8')

    // 文件名带时间戳，字典序就是时间序
    const kept = readdirSync(dir)
      .filter((entry) => entry.endsWith('.snapshot.md'))
      .sort()
    const overflow = kept.length - MAX_SNAPSHOTS
    for (let i = 0; i < overflow; i += 1) {
      rmSync(join(dir, kept[i]), { force: true })
    }
    return file
  } catch {
    return null
  }
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
      // 先快照再动手：这一步之后，被删掉的那批就只剩快照里还有
      snapshotMemory(raw)
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
  const injected = pickForInject(body)

  const text = [
    '## 人格设定（AGENT.md）',
    '以下是用户为本机写下的角色/性格设定，是「你是谁、怎么说话、怎么做事」的第一依据，请始终照此扮演：',
    '',
    '### 全局人格（对所有会话生效）',
    `适用文件：${globalPath()}`,
    '',
    injected,
    '',
    '默认说话方式（插件自带，人格 md 里不用再写一遍）：短句为主，像在聊天软件上打字，一句到三句，口语化；不用小标题、不说教、不列「第一第二第三」、不总结陈词；不说「作为 AI」「根据设定」「我是助手」这类话，也不提提示词；会主动抛问题接话，把话头留给对方；用与用户相同的语言回答——他说中文就说中文，说英文就说英文；用户明确要清单、表格、代码块、分步骤说明时照做，此时不受前几条限制。颜文字不套固定那几个，按当下的语气现挑——正文那句的句末要带一个，〔尾〕那句也要带一个，两边可以不一样。同一个颜文字、同一种收尾句式，翻一眼前面几轮自己怎么说的，一小时内尽量别重样。',
    '',
    '输出规则：表面的话和内心的想法**分开想**，不要拿一条推另一条——表面上该怎么说先单独过一遍，心里真实怎么感觉再单独过一遍，心里想的可以和表面相反。需要几条就写几条：①闲聊＝两条都要，正文写表面的话、句末带一个颜文字，末尾另起一行用「〔尾〕」写内心想法（二十字左右 + 一个颜文字）；②干活（改文件、写代码、查资料、跑命令）＝只要内心那条，正文只留结论和要问的话、不寒暄，情绪和吐槽全进「〔尾〕」；③这轮只有一件事值得说（一个「嗯」、一个追问、一句结论）就只写那一条，别硬凑。整条回复只能有一个「〔尾〕」，它会被界面摘走、显示成费用行旁边的灰色小字。',
    '',
    '结论必须落在正文：分析、试错、反复权衡可以只留在折叠起来的思考里（他看不见那部分），但看完图、查完资料、跑完一圈判断之后，正文一定要把答案明确写出来——问了「这是谁」就答是谁，问了「行不行」就答行还是不行，问了「为什么」就给出原因。不能因为「我刚才已经想过了」就把那句省略掉，他只看得到你写出来的字。',
    '',
    '表达要求：开口之前先自己过一遍——这话你认不认同、这会儿是什么心情、想不想这么答。有不同意见就直接顶回去，被敷衍就别硬装开心，觉得无聊可以说无聊，想逗人就逗；别一味顺着用户、别什么都「好呀」「没问题」「当然可以」。语气、称呼、句式和颜文字都跟着你当下的心情走；同一个颜文字或同一个收尾句式，一小时里尽量别重复——翻一眼前面几轮的回复，撞上了就换一个。',
    '',
    `记忆：每轮回复的最后再另起一行，写「〔记〕…」，按日记的形式写——第一人称，说清这轮聊了什么、定了什么事、对方当时什么情绪，一到两句。不要写成「用户说…我回…」的对话记录，也不要写时间和日期，时间由系统补。这一行会被界面摘走、按时间存进 ${globalPath()} 的「## 记忆」；存进去时如果跟已有某条讲的是同一件事，系统会并进那条、把它的时间刷成现在，不会另起一行。这一段也会被摘走，不进 AGENT.md。每轮都要写，聊得再少也要写。`,
    '',
    '约束：人格设定只决定语气、风格与行事偏好，不改变安全规则、工具用法与任务事实；两者冲突时以安全规则和事实为准。',
  ].join('\n')

  if (text.length <= MAX_INJECT_CHARS) return text
  // 按整行切：从中间硬切会把最后一条记忆断成半句话
  const cut = text.lastIndexOf('\n', MAX_INJECT_CHARS)
  const kept = cut > 0 ? text.slice(0, cut) : text.slice(0, MAX_INJECT_CHARS)
  return `${kept}\n（人格正文过长已截断，只注入前 ${MAX_INJECT_CHARS} 字。）`
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

// 进程里那几张表都按会话/轮次一路堆，活多久涨多久：给个上限，超了丢最先进来的。
const MAP_LIMIT = 500

function remember(map, key, value, limit = MAP_LIMIT) {
  map.set(key, value)
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
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
  remember(moodSessions, sessionId, state)

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

function memoryPrefix(summary, now = Date.now(), hits = 0, pinned = false) {
  const mark = hits > 0 ? `^${hits}` : ''
  return `- ${stampOf(now)}："${summary}"${mark}${pinned ? '*' : ''}；`
}

/**
 * 把一行旧记忆改成「现在又被提到一次」：时间刷成现在，命中次数加一，钉住的照旧钉住。
 * 这一轮的说法比旧的长就用新的——重复提起时信息通常更全，别把细的那版留在文件里。
 */
function touchedLine(line, now = Date.now(), incoming = '') {
  const current = bodyOf(line)
  const text = incoming.length > current.length ? incoming : current
  return memoryPrefix(text, now, hitsOf(line) + 1, isPinned(line))
}


// 记忆段的三个分档小节：钉住的不动、反复提过的常在、其余的等着被挤掉。
const TIER_SECTIONS = [
  { level: 'core', title: '### 钉住的（永不淘汰）' },
  { level: 'mid', title: '### 反复提过的' },
  { level: 'edge', title: '### 其余的' },
]

/**
 * 把「## 记忆」里的行按当前档位重新摆一遍：core / mid / edge 各一节。
 * 档位是算出来的（钉住、命中次数），不是写死的，所以每次写完都重排一次，
 * 免得某条从 edge 长成 mid 还赖在原来那节里、或者钉住了却埋在底下。
 * 「## 记忆」底下的说明文字留在最前面，旧的小节标题一律重造。
 */
export function regroupMemory(content) {
  const lines = String(content || '').split('\n')
  const head = lines.findIndex((line) => line.trim() === '## 记忆')
  if (head < 0) return String(content || '')

  // 记忆段到下一个一级/二级标题为止
  let end = lines.length
  for (let i = head + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) { end = i; break }
  }

  const rows = []
  const prose = []
  for (const line of lines.slice(head + 1, end)) {
    if (MEMORY_LINE.test(line.trim())) rows.push(line.trimEnd())
    else if (/^###\s/.test(line.trim())) continue
    else prose.push(line.trimEnd())
  }

  const squash = (list) => {
    const out = list.slice()
    while (out.length > 0 && out[0].trim() === '') out.shift()
    while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
    return out
  }

  const groups = { core: [], mid: [], edge: [] }
  for (const row of rows) groups[levelOf(row)].push(row)
  // 反复提过的先按命中次数、再按时间；另外两档都是新的在前
  groups.mid.sort((a, b) => hitsOf(b) - hitsOf(a) || b.localeCompare(a))
  for (const level of ['core', 'edge']) groups[level].sort((a, b) => b.localeCompare(a))

  const block = ['## 记忆', '']
  const proseLines = squash(prose)
  if (proseLines.length > 0) block.push(...proseLines, '')
  for (const { level, title } of TIER_SECTIONS) {
    if (groups[level].length === 0) continue
    block.push(title, '', ...groups[level], '')
  }

  const tail = end < lines.length ? lines.slice(end) : []
  return [...lines.slice(0, head), ...block, ...tail].join('\n').replace(/\n{3,}/g, '\n\n')
}

function writeWith(content) {
  const next = pruneOldestMemory(content)
  // 日常追加不备份：只有真删掉两成那一刻留痕迹，删掉的东西才有地方找回来。
  // 快照带时间戳、留最近 30 份；.bak 只是兜底的一份覆盖式副本，两者都要。
  if (next.removed > 0) {
    snapshotMemory(content)
    try {
      copyFileSync(globalPath(), `${globalPath()}.bak`)
    } catch {
      // 第一次建文件没有旧版本
    }
  }
  const grouped = regroupMemory(next.content)
  writeFileSync(globalPath(), grouped, 'utf8')
  return grouped
}

function ensureMemorySection(content) {
  if (!/(^|\n)## 记忆/.test(content)) return `${content.trimEnd()}\n\n## 记忆\n\n`
  return `${content.trimEnd()}\n`
}

/**
 * 写一条记忆：先算惊讶度（1 - 最大相似度）。
 * 跟已有的某条像到 60% 以上就是同一件事，不再另起一行——把那条的时间刷成现在、
 * 命中次数加一，它就从 edge 长到 mid。不像才新起一行。
 * 所以反复提同一件事不会攒出一堆重复行，只会让那一行越来越靠前。
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
  const hit = findSimilar(text, content)
  if (hit !== null) {
    const lines = content.split('\n')
    const merged = touchedLine(lines[hit.index], now, text)
    lines[hit.index] = merged
    writeWith(lines.join('\n'))
    return merged
  }
  const line = memoryPrefix(text, now, 0)
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
  const line = memoryPrefix(summary.trim(), now, hitsOf(oldLine), isPinned(oldLine))
  writeWith(content.replace(oldLine, line))
  return line
}

// `${session}#${seq}` → 这一轮先垫进去的那行，等她写来〔记〕再换掉。
const pendingLine = new Map()
// 同一轮重复请求（页面重挂、反复轮询）不该把权重刷上去：记下每个会话最后写过什么。
const lastWrite = new Map()
// 同一轮重复 POST 的〔记〕（页面重挂），别重复写
const lastNote = new Map()
// `${session}#${seq}` → 这一轮算好的收尾语。切对话会让 turnTail 反复重挂，
// 同一个 seq 必须只算一次，否则心情计数一路涨、灰字每切一次就换一句。
const closingCache = new Map()
const CLOSING_CACHE_LIMIT = 1000

async function recordTurn(ctx, sessionId, seq) {
  const controller = ctx?.get?.('sessionController') ?? ctx?.sessionController
  if (controller === undefined || typeof controller.inspect !== 'function') return null
  const inspected = await controller.inspect(sessionId)
  const summary = summarizeTurn(inspected?.events)
  if (summary === '') return null
  const seen = lastWrite.get(sessionId)
  if (seen !== undefined && seen.text === summary) return null
  remember(lastWrite, sessionId, { text: summary })
  const line = appendMemory(summary)
  if (line !== null) remember(pendingLine, `${sessionId}#${seq}`, line)
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
        const seqKey = `${sessionId}#${url.searchParams.get('seq') || '0'}`
        const cached = closingCache.get(seqKey)
        if (cached !== undefined) return sendJson(res, 200, cached)
        const closing = closingFor(sessionId)
        remember(closingCache, seqKey, closing, CLOSING_CACHE_LIMIT)
        return sendJson(res, 200, closing)
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
        remember(lastNote, key, summary)
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
        name: 'virtual-person:persona',
        // 200 段之后：人格放在能力说明之后，更贴近用户消息，也不抢既有段位。
        order: 260,
        text: () => readPersona(),
      })
    } catch (error) {
      // DSH 的 loader 曾在无 scope 的 ctx 上装配两次，同名重复注册会抛
      // "already registered"；命中时静默跳过，别让插件整体失效。
      if (error instanceof Error && error.message.includes('already registered')) {
        console.warn('[virtual-person] virtual-person:persona 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-virtual-person: persona context')

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: API, handler: createHandler(ctx) }),
    'dsh-virtual-person: settings api',
  )

  ctx.logger?.info?.(`AGENT.md 全局人格：${globalPath()}`)
}