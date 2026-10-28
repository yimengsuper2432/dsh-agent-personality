# dsh-agent-md（全局人格版）

把 `<DSH_HOME>/AGENT.md` 注入 DSH 的系统提示，并在设置里提供一个**只编辑全局人格**的页面。
版式沿用 0.2.0（头部、生效横幅、文件条、编辑器、操作栏），内容只剩一份全局人格。

- 文件：`<DSH_HOME>/AGENT.md`（`DSH_HOME` 缺省 `~/.dsh`）
- 开关：`<DSH_HOME>/agent-md.json` 的 `enabled`，关掉就不注入
- 生效：保存后**下一个回合**生效，不用重启
- 写法：Markdown；`<!-- -->` 注释不会进上下文；`{{x}}` 会自动降级成 `{x}`
- 空文件 / 只有注释 = 不注入任何内容
- 保存时先备份 `.bak`，再写临时文件后 rename，避免写一半留下空人格

## 界面

设置 → **人格**：

- 头部：「已启用 / 已停用」开关
- 生效横幅：本会话当前生效的是哪份文件、多少字；右侧是「文本占用 / 2 MB」进度条 + 连接状态
- 编辑器：文件条（路径 + 上次改动）、正文、保存 / 打开原文件 / 重新载入

## 收尾语

正文不再写收尾语：注入里明确要求「正文写完就停」，改由 client 半注册 `conversation.chat.turnTail`
（order 11，排在 dsh-cost-meter 之后）渲染一句。

**心情由宿主算，不顺着用户**（`lib/index.js` 的 `closingFor`）：

| 心情 | 触发 |
| --- | --- |
| `miss` | 距上一轮超过 6 小时 |
| `tired` | 本地时间 23 点–3 点 |
| `teasing` | 连聊 6 轮以上且间隔小于 3 分钟 |
| `annoyed` | 每第 7 轮固定闷一次 |
| `happy` / `calm` | 其余按 momentum 走 |

心情决定句子和颜文字，句尾一定带一个表情。`GET /api/agent-md/closing?session=` 返回；
宿主还没这版接口时前端退回本地几句（`FALLBACK`），不留空。

费用行是 `<details><summary>本轮费用 ≈ ¥0.0063</summary></details>`，「本轮费用」和金额常是同一个
文本节点，插不进文本内部，所以收尾语作为**费用行的最后一个子节点**追加，落在金额之后、同一行；
找不到费用行时才退化成自己一行灰字（`.am-tail-block`）。金额是异步回来的，用 `MutationObserver`
盯着，被挤到中间就挪回末尾。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/agent-md/state` | 路径、是否存在、上次改动、字数、正文、启用状态 |
| GET | `/api/agent-md/closing` | 本轮心情 + 收尾语 |
| POST | `/api/agent-md/save` | 写入全局人格（备份 + 原子写，上限 2 MB） |
| POST | `/api/agent-md/config` | 切换 `enabled` |
| POST | `/api/agent-md/open` | 在资源管理器里定位文件或目录 |

## 自检

```powershell
node test.mjs
```

10 组断言：全局注入、注释剥离、模板变量降级、忽略项目目录里的 AGENT.md、接口注册、保存与备份、
state 接口、心情判定（困 / 软 / 嫌烦 / 闷）、设置页与收尾语插槽。

## 安装

以本地 link 装进 profile（`dependencies` 与 `dsh.profile.bundles` 都要有一行）。改 host 代码要重启 DSH；
只改 `lib/client.js` 刷新页面即可。