import assert from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agent-md-test-'))
process.env.DSH_HOME = home

const mod = await import('./lib/index.js')
const { readPersona, globalPath, sanitizeForHost, savePersona, createHandler, apply, pruneOldestMemory, summarizeTurn, appendMemory, weightOf, similarity, bumpWeight, numberMemoryLines, appendProfile } = mod

// 1) 空目录：不注入空段落
assert.equal(readPersona(), '')

// 2) 只有 HTML 注释：视为空
writeFileSync(globalPath(), '<!-- 还没写 -->\n')
assert.equal(readPersona(), '')

// 3) 正常正文 + 注释放 token + {{x}} 降级
writeFileSync(globalPath(), '# 你是谁\n\n<!-- 这是给我自己看的 -->\n\n说话要短，{{名字}}不用点破。\n')
const text = readPersona()
assert.ok(text.includes('# 你是谁'), '正文缺失')
assert.ok(!text.includes('这是给我自己看的'), 'HTML 注释没被剥掉')
assert.ok(text.includes('{名字}') && !text.includes('{{名字}}'), '模板变量没降级')
assert.ok(text.includes(globalPath()), '缺适用文件路径')
// 默认说话方式是插件自带的：人格 md 里一个字不写也要生效
assert.ok(text.includes('短句为主'), '缺默认短句规则')
assert.ok(text.includes('不说「作为 AI」'), '缺「不说作为 AI」默认规则')
assert.ok(text.includes('会主动抛问题接话'), '缺主动接话默认规则')
assert.ok(text.includes('用与用户相同的语言回答'), '缺同语言回答默认规则')
assert.ok(text.includes('用户明确要清单'), '缺「用户要就给」的例外')
assert.ok(text.includes('颜文字不套固定那几个'), '缺「颜文字现挑」默认规则')

// 4) 不再看项目人格：cwd 下的 AGENT.md 必须被忽略
const project = join(home, 'proj')
mkdirSync(project)
writeFileSync(join(project, 'AGENT.md'), '# 项目人格\n不该出现\n')
const routes = []
const ctx = {
  effect(fn) { fn() },
  systemPrompt: {
    context(spec) {
      const injected = spec.text({ agent: { session: { header: { cwd: project } } } })
      assert.ok(injected.includes('说话要短'), '全局人格没注入')
      assert.ok(!injected.includes('项目人格'), '项目人格仍然生效')
      assert.equal(spec.order, 260)
      return () => {}
    },
  },
  webServer: {
    register(spec) { routes.push(spec); return () => {} },
  },
}
apply(ctx)
assert.deepEqual(routes.map((r) => [r.kind, r.path]), [['prefix', '/api/agent-md']], '设置页接口没注册')

// 5) 花括号降级是纯函数
assert.equal(sanitizeForHost('a{{{b}}'), 'a{b}}')

// 6) 保存：写回文件 + 生成 .bak 备份
await savePersona('# 新版人格\n')
assert.equal(readFileSync(globalPath(), 'utf8'), '# 新版人格\n')
assert.equal(readFileSync(globalPath() + '.bak', 'utf8'), '# 你是谁\n\n<!-- 这是给我自己看的 -->\n\n说话要短，{{名字}}不用点破。\n')

// 6.5) 上限是 2 MB：多一个字节就要 413，且不动原文件
await assert.rejects(
  () => savePersona('x'.repeat(2 * 1024 * 1024 + 1)),
  (error) => error.status === 413 && error.message.includes('2 MB'),
)
assert.equal(readFileSync(globalPath(), 'utf8'), '# 新版人格\n')

// 6.6) 超过上限先删权重最低的，同权重删最旧的；正文和没时间戳的内容都不动
const filler = 'x'.repeat(300)
const memoryDoc = [
  '# 人设',
  '正文不该被删。',
  '- 2026-10-20 09:00 最旧的一条记忆 ' + filler + ' + Weight=1',
  '- 2026-10-26 22:10 中间的一条记忆 ' + filler + ' + Weight=1',
  '- 2026-10-21 08:00 权重高的老记忆 ' + filler + ' + Weight=3',
  '结尾说明也不该被删。',
].join('\n')
const pruned = pruneOldestMemory(memoryDoc, 500)
// 到上限就砍 20%：3 条 → 至少砍 1 条，权重最低的先走
assert.equal(pruned.removed, 1, '应该按 20% 砍掉权重最低的那条')
assert.ok(!pruned.content.includes('最旧的一条'), '最低权重的没删')
assert.ok(pruned.content.includes('中间的一条'), '只砍 20%，第二条该留着')
assert.ok(pruned.content.includes('权重高的老记忆'), '高权重的不该先删')
assert.ok(pruned.content.includes('正文不该被删'), '正文被误删')
assert.ok(pruned.content.includes('结尾说明也不该被删'), '结尾被误删')
assert.equal(pruneOldestMemory(memoryDoc, 10 * 1024 * 1024).removed, 0, '没超上限不该动')
// 权重一样时才看时间
const sameWeight = ['- 2026-10-26 22:10 乙 ' + filler, '- 2026-10-20 09:00 甲 ' + filler].join('\n')
const samePruned = pruneOldestMemory(sameWeight, 400)
assert.ok(samePruned.content.includes('乙') && !samePruned.content.includes('甲'), '同权重应按时间删旧的')
// 权重解析：没写当 1
assert.equal(weightOf('- 2026-10-28 10:00 没写权重'), 1)
assert.equal(weightOf('- 2026-10-28 10:00：`"写了`"Weight=4；'), 4)

// 6.7) 记忆自动落盘：兜底只写用户真打的那句（跳过宿主塞进去的大块上下文和工具输出），
//      她自己写来的〔记〕再把那一行换成真正的总结
const turnEvents = [
  { type: 'turn/start', data: {} },
  { type: 'user/message', data: { content: [{ type: 'text', text: 'Current runtime context. 一大坨宿主上下文' }] } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '记忆格式改成这轮的总结' }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '行，改成你写〔记〕我落盘。' }] } } },
]
assert.equal(summarizeTurn(turnEvents), '记忆格式改成这轮的总结')
assert.equal(summarizeTurn([]), '')
assert.equal(summarizeTurn([{ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } }]), '你好')
assert.equal(
  summarizeTurn([{ type: 'user/message', data: { content: [{ type: 'text', text: 'node --check lib/index.js' }] } }]),
  '',
  '工具碎片不该当记忆',
)

// client 端的标记识别规则：标记只在行首算数（与 client.js 的 findLineMark 一致）。
// 正文里讲到这个符号是讲规矩，不能把后面整段话收成日记——英文分析混进 AGENT.md 就是这么来的。
function markValueOf(text, mark) {
  const esc = mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(^|\\n)([ \\t\\u3000]*)' + esc, 'g')
  let m
  let hit = null
  while ((m = re.exec(text)) !== null) hit = m
  if (hit === null) return null
  const rest = text.slice(hit.index + hit[0].length)
  const nl = rest.search(/[\r\n]/)
  const value = (nl >= 0 ? rest.slice(0, nl) : rest).trim()
  return value === '' ? null : value
}
const NOTE = '〔记〕'
assert.equal(markValueOf('聊完了，她在正文末尾写〔记〕加一句总结', NOTE), null, '行内提到的标记不算')
assert.equal(markValueOf('聊完了。\n〔记〕他今天来得很晚', NOTE), '他今天来得很晚')
assert.equal(markValueOf('  〔记〕他今天来得很晚', NOTE), '他今天来得很晚', '段首有空格也算行首')
assert.equal(
  markValueOf('〔记〕他今天来得很晚\nit works but that is not a summary', NOTE),
  '他今天来得很晚',
  '只取标记那一行',
)
assert.equal(markValueOf('〔记〕English only summary', NOTE), 'English only summary', '英文照样记')

writeFileSync(globalPath(), '# 人设\n\n正文。\n', 'utf8')
const line1 = appendMemory('记忆格式改成这轮的总结', new Date('2026-10-28T14:20:00+08:00').getTime())
assert.equal(line1, '- 2026-10-28 14:20："记忆格式改成这轮的总结"Weight=1；')
const written = readFileSync(globalPath(), 'utf8')
assert.ok(written.includes('## 记忆'), '没有自动补出「## 记忆」一节')
assert.ok(written.includes('正文。'), '正文被动了')
assert.ok(written.includes(line1 ?? ''), '记忆没写进文件')

// 6.8) 同一件事再提也不合并：旧的留着、新的另起一条 Weight=1，
//      模型标了〔重提〕编号才给旧那条 +1
const t1 = new Date('2026-10-28T14:20:00+08:00').getTime()
const t2 = new Date('2026-10-28T16:06:00+08:00').getTime()
assert.ok(similarity('记忆格式改成这轮的总结', '记忆格式改成这轮对话的总结') >= 0.8, '这条字面很像')
const added = appendMemory('记忆格式改成这轮对话的总结', t2)
assert.equal(added, '- 2026-10-28 16:06："记忆格式改成这轮对话的总结"Weight=1；')
const memoryRows = () => readFileSync(globalPath(), 'utf8').split('\n').filter((l) => l.startsWith('- 2026-'))
assert.equal(memoryRows().length, 2, '再像也留两条，不再合并')
assert.equal(memoryRows()[1], added, '新的是 Weight=1')

// 重提：模型标〔重提〕1 → 第 1 条 +1
assert.equal(bumpWeight(1), 2)
assert.equal(weightOf(memoryRows()[0]), 2)
assert.equal(weightOf(memoryRows()[1]), 1, '新的那条不该被动')
// 编号越界/非法：什么都不做
assert.equal(bumpWeight(99), null)
assert.equal(bumpWeight(0), null)
assert.equal(bumpWeight('x'), null)
// 封顶 8
for (let i = 0; i < 10; i += 1) bumpWeight(1)
assert.equal(weightOf(memoryRows()[0]), 8, '权重该封顶 8')

// 注入时给记忆行编号（只改注入文本，不动文件）
assert.equal(
  numberMemoryLines('- 2026-10-28 10:00："x"Weight=1；\n正文'),
  '[1] - 2026-10-28 10:00："x"Weight=1；\n正文',
)

// 不像的也新起一条 Weight=1
appendMemory('他要去上课了，把话头留着', t2)
assert.equal(memoryRows().length, 3, '每条都独立')

// 走一遍真实接口：/closing 会顺手把这一轮记下来
async function hit(handler, req) {
  const result = { status: 0, body: null }
  const res = {
    writeHead(status) { result.status = status },
    end(text) { result.body = JSON.parse(text) },
  }
  await handler(req, res)
  return result
}
const memHandler = createHandler({
  get: (name) => (name === 'sessionController'
    ? { inspect: async () => ({ events: turnEvents }) }
    : undefined),
})
const closingRes = await hit(memHandler, { url: '/api/agent-md/closing?session=mem-test&seq=1', method: 'GET', on() {}, destroy() {} })
assert.equal(closingRes.status, 200)
const memoryLines = () => readFileSync(globalPath(), 'utf8').trim().split('\n').filter((l) => l.startsWith('- 2026-')).length
const afterFirst = memoryLines()
await hit(memHandler, { url: '/api/agent-md/closing?session=mem-test&seq=1', method: 'GET', on() {}, destroy() {} })
assert.equal(memoryLines(), afterFirst, '同一轮重复记了')
assert.equal(afterFirst, 4, '记忆条数不对')

// 她写来〔记〕：把这一轮先垫的那行换成真正的总结，不该多出一条
const { Readable } = await import('node:stream')
const noteBody = JSON.stringify({ session: 'mem-test', seq: 1, text: '把记忆格式改成她写总结，宿主只落盘' })
const noteStream = Readable.from([Buffer.from(noteBody, 'utf8')])
const noteRes = await hit(memHandler, {
  url: '/api/agent-md/memory',
  method: 'POST',
  on: noteStream.on.bind(noteStream),
  destroy() {},
})
assert.equal(noteRes.status, 200)
const afterNote = readFileSync(globalPath(), 'utf8')
assert.ok(afterNote.includes('把记忆格式改成她写总结，宿主只落盘'), '〔记〕没写进去')
assert.equal(memoryLines(), afterFirst, '〔记〕应该替换那行，而不是多一条')

// 英文的〔记〕照样收：不能假设用户只写中文，脏不脏靠「只取第一行」挡
const enBody = JSON.stringify({
  session: 'mem-test',
  seq: 1,
  text: 'Talked about the memory rewrite.\nExtra line that is not the summary.',
})
const enStream = Readable.from([Buffer.from(enBody, 'utf8')])
const enRes = await hit(memHandler, {
  url: '/api/agent-md/memory',
  method: 'POST',
  on: enStream.on.bind(enStream),
  destroy() {},
})
assert.equal(enRes.status, 200, '英文也该记')
const enFile = readFileSync(globalPath(), 'utf8')
assert.ok(enFile.includes('Talked about the memory rewrite.'), '英文没落盘')
assert.ok(!enFile.includes('Extra line that is not the summary'), '第二行不该收进去')

// 测完把文件恢复，后面 /state 的断言还指望原内容
writeFileSync(globalPath(), '# 新版人格\n', 'utf8')

// 7) GET /state 走真实 handler
const handler = createHandler()
async function call(req) {
  const result = { status: 0, body: null }
  const res = {
    writeHead(status) { result.status = status },
    end(text) { result.body = JSON.parse(text) },
  }
  await handler(req, res)
  return result
}
const stateRes = await call({ url: '/api/agent-md/state', method: 'GET', on() {}, destroy() {} })
assert.equal(stateRes.status, 200)
assert.equal(stateRes.body.content, '# 新版人格\n')
assert.equal(stateRes.body.chars, 7)

const missing = await call({ url: '/api/agent-md/nope', method: 'GET', on() {}, destroy() {} })
assert.equal(missing.status, 404)

// 8) 心情：宿主自己算，不顺着用户
const { closingFor } = mod
const at = (h) => new Date(2026, 9, 27, h, 30, 0).getTime()

// 第一次见她：普通心情
const first = closingFor('mood-calm', at(14))
assert.equal(first.mood, 'calm')
assert.ok(first.text.length > 4, '收尾语不能是空的')
assert.ok(/[（(]/.test(first.text), '句尾要带颜文字')

// 深夜：困
assert.equal(closingFor('mood-night', at(1)).mood, 'tired')
assert.equal(closingFor('mood-night-2', at(23)).mood, 'tired')

// 隔了 7 小时没聊：会软一下
closingFor('mood-miss', at(10))
assert.equal(closingFor('mood-miss', at(17)).mood, 'miss')

// 连着聊 6 轮以上、间隔很短：开始嫌烦
let teasing = ''
for (let i = 0; i < 7; i += 1) teasing = closingFor('mood-chat', at(14) + i * 60 * 1000).mood
assert.equal(teasing, 'teasing', '连聊太久应该切到嫌人烦的心情')

// 第 7 轮固定闷一下：不顺着人
let annoyed = ''
for (let i = 0; i < 7; i += 1) annoyed = closingFor('mood-annoyed', at(12) + i * 60 * 60 * 1000).mood
assert.equal(annoyed, 'annoyed')

// 8.5) 别太单一：同一心情连说 6 轮，句子/颜文字都要变，且不跟上一轮重样
const said = []
for (let i = 0; i < 6; i += 1) said.push(closingFor('mood-vary', at(14) + i * 5 * 60 * 1000).text)
assert.ok(new Set(said).size >= 4, `换着说才对，实际只有 ${new Set(said).size} 种：${said.join(' | ')}`)
for (let i = 1; i < said.length; i += 1) assert.notEqual(said[i], said[i - 1], '连着两轮说了同一句')
assert.ok(said.every((t) => /[（(].*[）)]/.test(t)), '每条都要带颜文字')

// 9) client 半：能在假 window 里注册 settings.section，且组件是函数
const { readFileSync: readClient } = await import('node:fs')
const vm = await import('node:vm')
const source = readClient(new URL('./lib/client.js', import.meta.url), 'utf8')
let loaded = null
const fakeReact = {
  createElement: () => null,
  Component: class {},
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
  useState: (v) => [v, () => {}],
}
const sandbox = {
  window: { __ModuleLoader__: { load: (config) => { loaded = config } } },
  document: { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
  fetch: () => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') }),
  console,
}
sandbox.globalThis = sandbox
vm.runInNewContext(source, sandbox)
assert.equal(loaded.id, 'dsh-agent-md')
const clientExports = loaded.factory((name) => {
  assert.equal(name, 'react')
  return fakeReact
})
assert.deepEqual(clientExports.inject, ['slots'])
// 收尾语是她自己在正文末尾写的：认〔尾〕标记，取后面那句
assert.equal(clientExports.parseTail('正文\n〔尾〕困死了 (´-ω-`)'), '困死了 (´-ω-`)')
assert.equal(clientExports.parseTail('没有标记的正文'), null)
assert.equal(clientExports.parseTail('〔尾〕   '), null)
const slots = []
const injected = []
clientExports.apply({
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => {
      injected.push(name)
      fn()
    },
    register: (meta) => {
      assert.equal(typeof meta.id, 'string')
      slots.push(meta)
      return () => {}
    },
  },
})
assert.deepEqual(injected.sort(), ['conversation.chat.turnTail', 'settings.section'], '插了两个槽')
const settings = slots.filter((m) => m.name === 'settings.section')[0]
assert.equal(settings.id, 'agent-md')
assert.equal(typeof settings.label, 'function')
const tail = slots.filter((m) => m.name === 'conversation.chat.turnTail')[0]
assert.equal(tail.order, 11, '收尾语要排在费用行（order 10）之后')

// 档案：说到某个角色的新信息，挂到那个人的条目下面，只添不改
writeFileSync(
  globalPath(),
  ['# 人设', '', '- **桃井爱莉**：原偶像。嘴上凶。', '- **桐谷遥**：冷静自持。', '', '## 记忆', ''].join('\n'),
)
const readRaw = () => readFileSync(globalPath(), 'utf8')

// 喜欢归一行、讨厌归另一行
assert.equal(appendProfile('桃井爱莉：喜欢草莓蛋糕'), '桃井爱莉：喜欢草莓蛋糕')
assert.equal(appendProfile('桃井爱莉：喜欢布丁'), '桃井爱莉：喜欢布丁')
assert.equal(appendProfile('桃井爱莉：讨厌被人说可爱'), '桃井爱莉：讨厌被人说可爱')
let raw = readRaw()
assert.ok(raw.includes('  - 喜欢草莓蛋糕、布丁'), '喜欢的没并到同一行')
assert.ok(raw.includes('  - 讨厌被人说可爱'), '讨厌的没单独一行')
assert.equal(raw.split('\n').filter((line) => line.includes('喜欢')).length, 1, '喜欢占了不止一行')

// 不同侧面各记各的：喜欢草莓蛋糕 ≠ 喜欢草莓，谁也不抵掉谁
assert.equal(appendProfile('桃井爱莉：不喜欢草莓'), '桃井爱莉：不喜欢草莓')
assert.equal(appendProfile('桃井爱莉：对猫过敏'), '桃井爱莉：对猫过敏')
raw = readRaw()
assert.ok(raw.includes('  - 喜欢草莓蛋糕、布丁'), '喜欢那行不该被动')
assert.ok(raw.includes('  - 讨厌被人说可爱、草莓'), '不喜欢的没进讨厌行')
assert.ok(raw.includes('  - 对猫过敏'), '过敏该单独一行')

// 喜欢猫 + 对猫过敏：两个侧面并存
assert.equal(appendProfile('桃井爱莉：喜欢猫'), '桃井爱莉：喜欢猫')
raw = readRaw()
assert.ok(raw.includes('  - 喜欢草莓蛋糕、布丁、猫'), '喜欢猫没并进同一行')
assert.ok(raw.includes('  - 对猫过敏'), '过敏不该因为喜欢猫被抹掉')

// 重复的不加第二次
assert.equal(appendProfile('桃井爱莉：喜欢布丁'), null, '同一项不该加两次')

// 普通信息仍然一件一行
assert.equal(appendProfile('桃井爱莉：弟弟叫彰人'), '桃井爱莉：弟弟叫彰人')
raw = readRaw()
assert.ok(raw.includes('  - 弟弟叫彰人'), '普通信息没挂上')
assert.ok(raw.indexOf('弟弟叫彰人') < raw.indexOf('**桐谷遥**'), '插到别人头上去了')

// 档案里还没有的人：单开一段，不往别人条目里塞
assert.equal(appendProfile('朝比奈真冬：喜欢安静'), '朝比奈真冬：喜欢安静')
raw = readRaw()
assert.ok(raw.includes('## 补记的人'), '缺补记段落')
assert.ok(raw.includes('- **朝比奈真冬**：喜欢安静'), '补记条目不对')
assert.equal(appendProfile('格式不对'), null, '没有冒号的不该收')


rmSync(home, { recursive: true, force: true })
console.log('ok: 14 组断言通过（全局注入 / 注释剥离 / 模板降级 / 忽略项目人格 / 接口注册 / 保存与备份 / 2 MB 上限 / 记忆按时间淘汰 / state 接口 / 心情判定 / 收尾语不重样 / 设置页与收尾语插槽 / 角色档案追加）')