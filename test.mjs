import assert from 'node:assert'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'virtual-person-test-'))
process.env.DSH_HOME = home

const mod = await import('./lib/index.js')
const { readPersona, globalPath, sanitizeForHost, savePersona, createHandler, apply, pruneOldestMemory, summarizeTurn, appendMemory, hitsOf, isPinned, levelOf, bodyOf, findSimilar, similarity, pickForInject, regroupMemory } = mod

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
assert.deepEqual(routes.map((r) => [r.kind, r.path]), [['prefix', '/api/virtual-person']], '设置页接口没注册')

// 5) 花括号降级是纯函数
assert.equal(sanitizeForHost('a{{{b}}'), 'a{b}}')

// 6) 保存：写回文件，且不偷偷留 .bak
await savePersona('# 新版人格\n')
assert.equal(readFileSync(globalPath(), 'utf8'), '# 新版人格\n')
assert.ok(!existsSync(globalPath() + '.bak'), '保存不该再生成 .bak')

// 6.5) 上限是 2 MB：多一个字节就要 413，且不动原文件
await assert.rejects(
  () => savePersona('x'.repeat(2 * 1024 * 1024 + 1)),
  (error) => error.status === 413 && error.message.includes('2 MB'),
)
assert.equal(readFileSync(globalPath(), 'utf8'), '# 新版人格\n')

// 6.6) 超过上限先删 edge 里最旧的，edge 不够才动 mid；钉住的 core 一条都不碰
const filler = 'x'.repeat(300)
const memoryDoc = [
  '# 人设',
  '正文不该被删。',
  '- 2026-10-20 09:00："最旧的一条记忆' + filler + '"；',
  '- 2026-10-26 22:10："中间的一条记忆' + filler + '"；',
  '- 2026-10-21 08:00："钉住的老记忆' + filler + '"*；',
  '结尾说明也不该被删。',
].join('\n')
const pruned = pruneOldestMemory(memoryDoc, 500)
// 到上限就砍 20%：3 条 → 至少砍 1 条，edge 里最旧的那条先走
assert.equal(pruned.removed, 1, '应该按 20% 砍掉 1 条')
assert.ok(!pruned.content.includes('最旧的一条记忆'), '最旧的 edge 没删')
assert.ok(pruned.content.includes('中间的一条记忆'), '只砍 20%，第二条该留着')
assert.ok(pruned.content.includes('钉住的老记忆'), 'core 不该被删')
assert.ok(pruned.content.includes('正文不该被删'), '正文被误删')
assert.ok(pruned.content.includes('结尾说明也不该被删'), '结尾被误删')
assert.equal(pruneOldestMemory(memoryDoc, 10 * 1024 * 1024).removed, 0, '没超上限不该动')
// mid 排在 edge 后面：只要还有 edge，就轮不到 mid 先走
{
  const mixed = [
    '- 2026-10-20 09:00："重复提过的' + filler + '"^3；',
    '- 2026-10-21 09:00："乙' + filler + '"；',
    '- 2026-10-22 09:00："丙' + filler + '"；',
    '- 2026-10-23 09:00："丁' + filler + '"；',
    '- 2026-10-24 09:00："戊' + filler + '"；',
  ].join('\n')
  const out = pruneOldestMemory(mixed, 700)
  assert.ok(!out.content.includes('乙'), 'edge 里最旧的该先走')
  assert.ok(out.content.includes('重复提过的'), 'mid 不该先于 edge 被删')
}
// 6.7) 剪枝不留快照：整套备份机制已经拆了，别再偷偷写 snapshots/
{
  const home = mkdtempSync(join(tmpdir(), 'virtual-person-nosnap-'))
  const target = join(home, 'AGENT.md')
  writeFileSync(target, 'x', 'utf8')
  assert.ok(!existsSync(join(home, 'snapshots')), '不该再建 snapshots 目录')
  assert.equal(mod.snapshotMemory, undefined, 'snapshotMemory 该已经删了')
  rmSync(home, { recursive: true, force: true })
}

// 三档判定
assert.equal(levelOf('- 2026-10-28 10:00："普通"；'), 'edge')
assert.equal(levelOf('- 2026-10-28 10:00："提过"^2；'), 'mid')
assert.equal(levelOf('- 2026-10-28 10:00："钉住"*；'), 'core')
assert.equal(levelOf('- 2026-10-28 10:00："老权重"Weight=4；'), 'mid', '老格式按 Weight>1 算 mid')
assert.equal(hitsOf('- 2026-10-28 10:00："没提过"；'), 0)
assert.equal(hitsOf('- 2026-10-28 10:00："提过"^3；'), 3)
assert.equal(hitsOf('- 2026-10-28 10:00："老权重"Weight=4；'), 3, '老 Weight 换算成命中次数')
assert.equal(isPinned('- 2026-10-28 10:00："钉住"*；'), true)
assert.equal(isPinned('- 2026-10-28 10:00："钉住还提过"^2*；'), true)
assert.equal(isPinned('- 2026-10-28 10:00："普通"；'), false)
// 正文：新老尾巴都要剥干净
assert.equal(bodyOf('- 2026-10-28 10:00："内容"^2；'), '内容')
assert.equal(bodyOf('- 2026-10-28 10:00："内容"*；'), '内容')
assert.equal(bodyOf('- 2026-10-28 10:00："内容"Weight=5；'), '内容')
// 老格式还能读（只读不写）：Weight=N 当成被提过 N-1 次
assert.equal(hitsOf('- 2026-10-28 10:00 没写权重'), 0)
assert.equal(hitsOf('- 2026-10-28 10:00：`"写了`"Weight=4；'), 3)

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
const memoryRows = () => readFileSync(globalPath(), 'utf8').split('\n').filter((l) => l.startsWith('- 2026-'))
const line1 = appendMemory('记忆格式改成这轮的总结', new Date('2026-10-28T14:20:00+08:00').getTime())
assert.equal(line1, '- 2026-10-28 14:20："记忆格式改成这轮的总结"；')
const written = readFileSync(globalPath(), 'utf8')
assert.ok(written.includes('## 记忆'), '没有自动补出「## 记忆」一节')
assert.ok(written.includes('正文。'), '正文被动了')
assert.ok(written.includes(line1 ?? ''), '记忆没写进文件')

// 6.8) 同一件事再提不另起一行：并进旧那条，时间刷成现在、命中次数加一
const t2 = new Date('2026-10-28T16:06:00+08:00').getTime()
assert.ok(similarity('记忆格式改成这轮的总结', '记忆格式改成这轮对话的总结') >= 0.8, '这条字面很像')
const added = appendMemory('记忆格式改成这轮对话的总结', t2)
assert.equal(added, '- 2026-10-28 16:06："记忆格式改成这轮对话的总结"^1；')
assert.equal(memoryRows().length, 1, '同一件事不该攒出第二行')
assert.equal(memoryRows()[0], added, '旧那条被就地改写')
assert.equal(levelOf(added), 'mid', '提过一次就升到 mid')

// 再提一次 → 命中次数接着涨，还是那一条
const third = appendMemory('记忆格式改成这轮对话里的总结', new Date('2026-10-28T17:00:00+08:00').getTime())
assert.ok(String(third).includes('^2；'), '第三条应该把它顶到 ^2')
assert.equal(memoryRows().length, 1, '还是只有一条')
// 完全不像的一条照常另起一行，从 edge 起
const fresh = appendMemory('他今天带了把蓝格子伞', new Date('2026-10-28T18:00:00+08:00').getTime())
assert.equal(fresh, '- 2026-10-28 18:00："他今天带了把蓝格子伞"；')
assert.equal(levelOf(fresh), 'edge', '新写的一条是 edge')
assert.equal(memoryRows().length, 2)


// 注入：钉住的先占名额，其余按时间从新到旧补，补到字符预算用完；没挑中的还在文件里
{
  const rows = []
  for (let i = 0; i < 40; i += 1) {
    const hh = String(Math.floor(i / 60)).padStart(2, '0')
    const mm = String(i % 60).padStart(2, '0')
    rows.push(`- 2026-01-01 ${hh}:${mm}："第${i}条"；`)
  }
  rows[3] = '- 2025-01-01 02:00："钉住的老记忆"*；'
  const all = ['## 记忆', '', ...rows].join('\n')
  // 一条三十来个字符，给 300 字预算只放得下十来条
  const picked = pickForInject(all, 300)
  const kept = picked.split('\n').filter((l) => l.startsWith('- 20'))
  assert.ok(kept.length > 0 && kept.length < rows.length, '按字符预算只挑了一部分')
  assert.ok(picked.includes('钉住的老记忆'), '钉住的一定留下')
  assert.ok(!picked.includes('"第0条"'), '最旧的被挤掉')
  assert.ok(picked.includes('"第39条"'), '最新的留下')
  assert.ok(picked.includes('## 记忆'), '小节标题不能被删')
  const order = kept.map((l) => rows.indexOf(l))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), '挑完仍按原来的顺序摆')
  assert.ok(pickForInject(all, 1e9).split('\n').filter((l) => l.startsWith('- 20')).length === rows.length, '预算够就一条不丢')
}

// 记忆按档位分节摆：钉住的一节、反复提过的一节、其余的一节；档位变了要自己换节
{
  const sample = [
    '# 人设',
    '',
    '## 记忆',
    '',
    '记忆说明放这里，别看漏了。',
    '',
    '- 2026-01-01 00:00："新写的一条"；',
    '- 2025-01-01 00:00："老的一条，被提过好几次"^5；',
    '- 2024-01-01 00:00："钉住的那条"*；',
    '',
  ].join('\n')
  const grouped = regroupMemory(sample)
  assert.ok(grouped.includes('### 钉住的（永不淘汰）'), '钉住的那节没出来')
  assert.ok(grouped.includes('### 反复提过的'), '反复提过的那节没出来')
  assert.ok(grouped.includes('### 其余的'), '其余的那节没出来')
  assert.ok(grouped.includes('记忆说明放这里，别看漏了。'), '说明文字被吃了')
  const at = (needle) => grouped.indexOf(needle)
  assert.ok(at('### 钉住的（永不淘汰）') < at('### 反复提过的'), '钉住的该排最前')
  assert.ok(at('### 反复提过的') < at('### 其余的'), '反复提过的该在其余的上面')
  assert.equal(
    grouped.split('\n').filter((line) => line.startsWith('- 20')).length,
    3,
    '分节把记忆行弄丢了',
  )
  assert.equal(regroupMemory(grouped), grouped, '重排一次和重排两次该一模一样')

  // 从 edge 长成 mid 的那条，下一次重排要挪到「反复提过的」里去
  const grown = regroupMemory(sample.replace('"新写的一条"；', '"新写的一条"^2；'))
  const midChunk = grown.slice(grown.indexOf('### 反复提过的'), grown.indexOf('### 其余的'))
  assert.ok(midChunk.includes('新写的一条'), '长成 mid 的还赖在其余那节')
  assert.ok(!grown.slice(grown.indexOf('### 其余的')).includes('新写的一条'), '两节里都留了一份')
}

// 相似度只用来判「是不是同一件事」：不累加、也不封顶
{
  const base = '## 记忆\n\n- 2026-01-01 00:00："遥那张卡面翻出来看了半天，浅蓝头发白蝴蝶结"^7；\n'
  const hit = findSimilar('遥那张卡面翻出来看了半天，浅蓝头发白蝴蝶结', base)
  assert.equal(hit?.index, 2, '该认出是同一件事')
  assert.ok(hit.score > 0.9, '同一句相似度该很高')
  assert.equal(findSimilar('他今天带了把蓝格子伞', base), null, '不像的不合并')
}

// 不像的照常另起一行
const unrelated = appendMemory('他要去上课了，把话头留着', t2)
assert.equal(hitsOf(unrelated), 0, '不像的那条没有命中标记')
assert.ok(memoryRows().some((l) => l.includes('他要去上课了')), '不该并到别的行里去')

// 日常追加也不碰任何备份：整份文件旁边不该多出任何东西
{
  const before = readdirSync(dirname(globalPath())).filter((entry) => entry.startsWith('AGENT.md'))
  appendMemory('备份测试：这一句只是日常追加', new Date('2026-10-28T19:30:00+08:00').getTime())
  const after = readdirSync(dirname(globalPath())).filter((entry) => entry.startsWith('AGENT.md'))
  assert.deepEqual(after.sort(), before.sort(), '写入不该多出 .bak 之类的文件')
}


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
// 清成干净的一页：这里要证明的是「垫一句 +1、同一轮重复不 +1」，别被前面的残留搅了
writeFileSync(globalPath(), '# 人设\n\n正文。\n', 'utf8')
const memoryLines = () => readFileSync(globalPath(), 'utf8').trim().split('\n').filter((l) => l.startsWith('- 2026-')).length
const beforeClosing = memoryLines()
const closingRes = await hit(memHandler, { url: '/api/virtual-person/closing?session=mem-test&seq=1', method: 'GET', on() {}, destroy() {} })
assert.equal(closingRes.status, 200)
const afterFirst = memoryLines()
const repeatRes = await hit(memHandler, { url: '/api/virtual-person/closing?session=mem-test&seq=1', method: 'GET', on() {}, destroy() {} })
assert.equal(memoryLines(), afterFirst, '同一轮重复记了')
assert.equal(repeatRes.body.text, closingRes.body.text, '同一个 seq 的灰字每请求一次就换一句')
assert.equal(afterFirst, beforeClosing + 1, '记忆条数不对')

// 她写来〔记〕：把这一轮先垫的那行换成真正的总结，不该多出一条
const { Readable } = await import('node:stream')
const noteBody = JSON.stringify({ session: 'mem-test', seq: 1, text: '把记忆格式改成她写总结，宿主只落盘' })
const noteStream = Readable.from([Buffer.from(noteBody, 'utf8')])
const noteRes = await hit(memHandler, {
  url: '/api/virtual-person/memory',
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
  url: '/api/virtual-person/memory',
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
const stateRes = await call({ url: '/api/virtual-person/state', method: 'GET', on() {}, destroy() {} })
assert.equal(stateRes.status, 200)
assert.equal(stateRes.body.content, '# 新版人格\n')
assert.equal(stateRes.body.chars, 7)

const missing = await call({ url: '/api/virtual-person/nope', method: 'GET', on() {}, destroy() {} })
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
assert.equal(loaded.id, 'dsh-virtual-person')
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
assert.equal(settings.id, 'virtual-person')
assert.equal(typeof settings.label, 'function')
const tail = slots.filter((m) => m.name === 'conversation.chat.turnTail')[0]
assert.equal(tail.order, 11, '收尾语要排在费用行（order 10）之后')

rmSync(home, { recursive: true, force: true })
console.log('ok: 全部断言通过（全局注入 / 注释剥离 / 模板降级 / 忽略项目人格 / 接口注册 / 保存不备份 / 2 MB 上限 / 三档分层与按时间淘汰 / 剪枝不留快照 / 相似就并进原来那条 / 注入按字符预算挑且钉住优先 / 记忆按档位分节 / state 接口 / 心情判定 / 收尾语不重样 / 设置页与收尾语插槽）')