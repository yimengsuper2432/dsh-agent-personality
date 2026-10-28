import assert from 'node:assert'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'agent-md-test-'))
process.env.DSH_HOME = home

const mod = await import('./lib/index.js')
const { readPersona, globalPath, sanitizeForHost, savePersona, createHandler, apply } = mod

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

rmSync(home, { recursive: true, force: true })
console.log('ok: 11 组断言通过（全局注入 / 注释剥离 / 模板降级 / 忽略项目人格 / 接口注册 / 保存与备份 / 2 MB 上限 / state 接口 / 心情判定 / 设置页与收尾语插槽）')