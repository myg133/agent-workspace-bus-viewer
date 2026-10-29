# bus-report · Planner / BA 沟通梳理报告生成器

从 git 的 **bus 分支**（消息体即 commit message）提取 Planner 与 BA 之间的全部沟通，
生成一份自包含的 HTML 报告。

> **这是 [agent-workspace](https://github.com/myg133/agent-workspace) 的配套工具。**
> `agent-workspace` 规定「BA / Planner 之间的沟通只走 bus 分支的空 commit」，
> 本仓库负责把这些 commit 还原成一份能读、能搜、能按 thread 聚合的报告——
> 只读 bus，是那套流程的观测面，不改任何规范，也不替代 `aw.py msg`。

对齐 `agent-workspace` 技能 **1.25.0（2026-10-25）** 的消息格式
（v2：`expect` / `reply_by` / `re` / `result`），并支持跨 bus「代」聚合（`archive/bus-YYYYMMDD`）。

## 与 agent-workspace 的分工

| | [agent-workspace](https://github.com/myg133/agent-workspace) | 本仓库 |
|---|---|---|
| 定位 | 流程与规范：worktree 布局、角色、状态机、认领、契约 | 观测：把 bus 上的沟通变成报告 |
| 写 bus | ✅ `aw.py msg send` / `ack` / `reply` | ❌ 全程只读，从不写任何 ref |
| 读 bus | `msg inbox`（自己的收件箱，按 agent 计已读） | 全量视角（所有消息、所有 thread、所有代） |
| 依赖 | Python 3.8+ · git | Bun / Deno / Node · git |

消息格式、`expect` 语义、代（generation）规则都以 `agent-workspace` 的
`references/global/messaging.md` 和 `scripts/aw.py` 为准；本仓库只跟随，不发明。
格式变了，改这边一处解析即可。

## 为什么是 git 分支

`agent-workspace` 的 `aw.py` 用「空 bus 分支 + 空 commit」承载消息：
消息体就是 commit message，结构化头在正文开头。

```
git log origin/bus --reverse --format=%H%x1f%aI%x1f%an%x1f%B%x1e
```

本工具按这个真实实现提取（早期文档里出现过的 `.local/ba-bus/` 消息板目录已不是当前实现）。

## 快速开始

```sh
# 有本地 clone：直接读
bun run bus-report.ts build --repo /path/to/your-repo --out ./out

# 没有 clone：只从远端拉 bus 相关分支（不 clone、不检出）
bun run bus-report.ts build --remote git@github.com:your-org/your-repo.git --out ./out

# 起服务，页面上的「刷新数据」会现场 fetch 一次 bus 再重绘
bun run bus-report.ts serve --remote <git-remote-url> --out ./out --port 8787

# 跨代：把归档代的 bus 也读进来（bus 换过代时必须加，否则只看得到当前代）
bun run bus-report.ts serve --remote <git-remote-url> --out ./out --all-generations

# 或自动重建（bus 有新消息时）
bun run bus-report.ts watch --remote <git-remote-url> --out ./out --interval 10
```

三端通用，`bun` / `deno` / `node` 均可：

```sh
bun  run bus-report.ts build
deno run -A bus-report.ts build
node --experimental-strip-types bus-report.ts build
```

## 消息格式（v2 · 2026-10-25 起）

commit message 本体：

```text
[msg] <type> <subject> -> <to>

---
id: a1b2c3d4
from: pc-a-ba-1
to: [pc-b-ba-1]
cc: [pc-b-ba-2]
at: 2026-10-25T05:19:25Z
type: handoff
priority: p1
ref: BA/demands/REQ-001/handover.md
thread: 758477bd
expect: reply
reply_by: 2026-10-25T06:30Z
re: <被回执的消息 id>
result: ok
---

正文
```

| 字段 | 本工具用途 |
|---|---|
| `id` / `from` / `to` / `cc` / `at` / `type` / `ref` / `thread` / `priority` / `deadline` | 展示、聚合、路由 |
| `contract` / `version` | 契约类消息 |
| **`expect`** | 反馈义务：`none` / `ack` / `reply`；`ack`·`reply` 进「待结清」 |
| **`reply_by`** | 期望回复时间（自由文本也可） |
| **`re`** | 本条回的是哪条消息 id —— 判定「已结清」的唯一依据 |
| **`result`** | ack 结果 `ok` / `no` |

与 v1（2026-10-24 及更早）的差异：v1 没有 `expect` / `reply_by` / `re` / `result` 四个字段。
本工具对两版都能读；v1 消息视为「无反馈义务」。

## 跨代聚合（`--all-generations`）

bus 会**换代**：旧历史归档到 `archive/bus-YYYYMMDD`，新代从空历史重建。
换代后 `bus` 分支只剩新代，不指定 `--all-generations` 就看不到旧代消息。

```sh
# 自动发现 bus + archive/bus-* 全部代
bun run bus-report.ts build --remote <git-remote-url> --all-generations --out ./out

# 也可以点名
bun run bus-report.ts build --repo <path> --ref bus,archive/bus-20261024 --out ./out
```

合并后按 `at` 正序排列，每条消息带 `generation` 字段（所属分支名）；页面在多代时
给每张卡片打「代」标签。`meta.generations` 记录每代的 tip 与条数。

## 待结清（欠回复台账）

页面新增「待结清」区：把所有 `expect=ack|reply` 的消息按「有没有被 `re: <id>` 回过」
分成已结清 / 未结清。总览里也有一格计数。

这条口径和 `aw.py` 的门禁一致——欠回复会挡住 `claim next` / `agent exit`，
所以报告里能直接看出「现在谁欠谁一条回复」。

标题右侧的「收起 / 展开 · N」可以把整栏收起来（N 是当前未结清条数）；
带 `显式` 标记的是**发送方覆盖了类型默认值**的消息（如 `fyi` 默认 `expect=none`，
但发送时用了 `--expect ack`）——它们同样进待结清，因为发送方确实要求了回执；
收起状态存在浏览器 localStorage，刷新页面后保持，不影响数据与计数。

## 不 clone 也能读 bus（`--remote`）

bus 分支的每个 commit 都是**空 commit**（tree 恒为空树 `4b825dc…`），消息只在 commit
message 里。所以根本不需要工作区——只要 commit 对象：

```sh
bun run bus-report.ts serve --remote <git-remote-url>
```

它做的是：在 `<out>/.bus-cache.git` 建一个 **bare 仓库**（无工作区、不检出任何文件），
然后每条 refspec 只拉 bus：

```sh
git init --bare <out>/.bus-cache.git                       # 只做一次
git -C <out>/.bus-cache.git fetch --no-tags --prune <url> \
    '+refs/heads/bus:refs/heads/bus'                       # 每次刷新做一次（增量）
```

多代模式下 refspec 会变成多条（`bus` + `archive/bus-*`），仍然只碰 bus 相关分支。

对目标仓库的原仓库是**零接触**：不 clone、不 fetch 到它的 ref、不写它的工作区。
实测（约 330 条消息、12 个 Agent 的仓库）：

| 指标 | 值 |
|---|---|
| 冷启动（建缓存 + 全量拉） | ~1.6 s，磁盘约 600 KB |
| 增量刷新（bus 无新提交） | ~0.9 s，0 字节新增 |
| `git log` + 解析 + 聚合 | ~0.13 s |

为什么这么小：只传 commit 对象，不传任何 blob/tree。

> 也可以走宿主平台 REST API（如 GitLab `GET /api/v4/projects/:id/repository/commits?ref_name=bus`），
> 连 git 对象都不落地；但私有项目要 token，且分页拉 100 条一次。
> 只要机器上已有该仓库的 git 凭据（SSH key），`--remote` 是零配置的那条路。

## 两种使用形态

### 1. 一次性生成自包含报告

`build` 产出三个文件：

| 文件 | 用途 |
|---|---|
| `ba-bus-communication.html` | 报告本体，**内嵌数据快照**，可单独发给别人 |
| `bus-data.js` | 同份数据，赋值给 `window.__BUS_DATA__`，页面优先加载它 |
| `bus-data.json` | 同份数据的纯 JSON，供程序消费 |

### 2. 数据与页面分离（推荐）

页面加载时先请求 `/api/bus`（有 `bus-report serve` 在跑时），失败才退回同目录
`bus-data.js`，再失败才用内嵌快照。三档徽标：

- 绿色 `数据源：实时（服务端 fetch <remote>）` — 服务端实时接口
- 绿色 `数据源：外部 bus-data.js（已是最新）` — 纯静态托管 / `file://` 打开
- 橙色 `数据源：内嵌快照（外部文件未加载）` — 外部文件缺失，已回退

实时模式下点「刷新数据」不会重载页面：浏览器请求 `/api/bus?refresh=1`，服务端做一次
增量 fetch、重新解析聚合，返回新数据后前端整体重绘。按钮在请求期间禁用并显示「拉取中…」。

```sh
bun run bus-report.ts serve --remote <url> --out ./out   # 实时模式
bun run bus-report.ts build --repo <repo> --out ./out    # 或只更新快照，再手动刷浏览器
```

`--ttl <秒>`（默认 60）控制 `/api/bus` 的服务端缓存窗口，防止连点刷新把远端打爆；
`?refresh=1` 会绕过缓存。

## 时间与时区

页面、JSON、CLI 输出统一用**中国时区（UTC+8，无夏令时）**表示：

```text
2026-10-23T00:16:52+08:00      # 数据里的 at
2026-10-23 00:16:52            # 页面上的显示
10-23 00:16                    # thread 跨度等紧凑位置
```

git 的 `%aI` 可能是 `Z` 或其它偏移，工具只**改表示、不改时刻**，所以：

- 排序、`--since` 比较仍按真实瞬间，结果与用哪个时区无关
- 「每日消息量」按**北京日期**分桶（跨零点的那几条不会落错天）
- `meta.generatedAt`（页面右上「生成时间」）同样是北京时间

### 时间线以「提交时间」为准

消息体头部的 `at:` 是发送方**手写**的，实测不可靠：约 5% 的消息比真实提交时间晚
（最多差半小时以上），会造成「最新消息在未来」。所以：

| 字段 | 含义 |
|---|---|
| `at` | commit 的 author date，**时间线/排序/跨度的唯一依据** |
| `declaredAt` | 消息体里手写的 `at:`，仅作凭证 |

两者相差 ≥1 分钟时，页面在时间后标一个 `*`，悬停可看两个值。数据里 `declaredAt`
始终保留（无声明则为空串），便于审计谁的时间写飘了。

## 选项

| 选项 | 说明 |
|---|---|
| `--repo <path>` | 目标本地仓库（默认：从当前目录向上找 `.git`） |
| `--remote <url>` | 远端地址：不 clone，只 fetch bus 一个分支（bare 缓存） |
| `--cache <dir>` | bare 缓存仓库目录（默认 `<out>/.bus-cache.git`） |
| `--ref <ref>` | bus 分支，可多个（逗号分隔或重复写）：`bus,archive/bus-20261024` |
| `--all-generations` | 自动读全部 bus 代（`bus` + `archive/bus-*`），跨代聚合 |
| `--fetch` | 先 `git fetch origin bus`（会更新 remote-tracking ref，**默认不执行**） |
| `--out <dir>` | 输出目录（默认当前目录，自动创建） |
| `--html <file>` | HTML 文件名（默认 `ba-bus-communication.html`） |
| `--data-js <file>` | 浏览器可直载的数据文件名（默认 `bus-data.js`） |
| `--data-json <file>` | 纯 JSON 文件名（默认 `bus-data.json`） |
| `--template <path>` | 自定义模板（默认同目录 `viewer.template.html`） |
| `--alias <path>` | Agent 别名映射（默认同目录 `agents.alias.json`） |
| `--since <iso>` | 只取该时间之后的消息 |
| `--limit <n>` | 最多取 n 条消息 |
| `--port <n>` | `serve` 端口（默认 8787） |
| `--interval <秒>` | `watch` 轮询间隔（默认 10） |
| `--ttl <秒>` | `/api/bus` 服务端缓存秒数（默认 60，`0` = 每次刷新都拉） |
| `-q, --quiet` | 精简输出 |

## Agent 别名映射

仓库里只带 `agents.alias.example.json`（示例）。复制成 `agents.alias.json` 再按自己团队改：

```sh
cp agents.alias.example.json agents.alias.json
```

```json
{
  "pc-a-ba-1": { "label": "Alice", "role": "Planner · 裁定优先级、边界、契约" }
}
```

`agents.alias.json` 已在 `.gitignore` 里——真实 id 往往带主机名/人名，不该进公开仓库。

文件不存在时也不影响使用：工具会从 id 自动推导昵称（去 `ba-` 前缀、去尾部哈希、去主机段），
例如 `pc-a-ba-01` → `pc-a`。

## 只读保证

`--repo` 模式对目标仓库只执行 `git log` 与 `git rev-parse`：

- 不写工作区文件
- 不动任何分支
- **默认不执行 `git fetch`**（那会更新 remote-tracking ref），需要时显式加 `--fetch`

`--remote` 模式更进一步：**目标仓库根本不需要存在**。所有 git 操作都发生在
`<out>/.bus-cache.git` 这个 bare 缓存里，它的 ref 只有 `refs/heads/bus` 一个，
没有工作区、没有检出、没有其他分支。删掉这个目录即可完全清除痕迹。

## 文件

```
bus-report/
├── bus-report.ts              # CLI（解析 / 聚合 / 生成 / watch / serve）
├── viewer.template.html       # 页面模板（改样式改这里）
├── agents.alias.example.json  # 别名映射示例（复制成 agents.alias.json 用）
├── LICENSE                    # MIT
├── .gitignore
└── out/                       # 默认输出目录（.gitignore 已忽略）
    ├── ba-bus-communication.html
    ├── bus-data.js
    ├── bus-data.json
    └── .bus-cache.git/        # --remote 模式的 bare 缓存（可随时删）
```

## 环境要求

| 运行时 | 命令 |
|---|---|
| Bun ≥ 1.x | `bun run bus-report.ts ...` |
| Deno ≥ 1.4x | `deno run -A bus-report.ts ...` |
| Node ≥ 22 | `node --experimental-strip-types bus-report.ts ...` |

外部依赖只有 `git`（2.20+）。

## 隐私：什么不会进仓库

`out/` 里是**真实对话内容**（谁在什么时候说了什么、引用了哪些内部路径），
`.bus-cache.git/` 里是真实 commit 对象，两者都已在 `.gitignore` 中被忽略。

本仓库本身只有工具代码 + 一个脱敏示例。想确认没有误提交：

```sh
git ls-files          # 应该只有代码、模板、示例、文档
git grep -n -E 'gitlab|username|/Users/|C:\\' || echo "干净"
```

## HTTP 接口

`serve` 只暴露两个东西：

| 路径 | 说明 |
|---|---|
| `GET /api/bus` | 实时数据（受 `--ttl` 缓存） |
| `GET /api/bus?refresh=1` | 强制增量 fetch 后返回 |
| 其它路径 | `out` 目录里的静态文件（`..`、隐藏目录、`.git` 一律 403） |

返回体与 `bus-data.json` 同构，`meta.mode` 为 `local` / `remote`，`meta.source` 为 `live`；
`meta.generations` 列出合并的各代，`meta.counts.openExpect` 是待结清数。

## 页面功能

- **总览**：消息数、thread 数、参与 Agent、发出最多的 Agent
- **参与者**：稳定 ID、发出/收到、主要收件方矩阵
- **类型与节奏**：消息类型、优先级、每日消息量
- **沟通 topic**：按 thread 聚合，可折叠，含类型/优先级/ID/时间/收发路径/ref/完整正文/GitLab 提交链接
- **搜索**：全文过滤 + 「只看多消息 thread」勾选 + 实时计数
- **消息排序**：默认「最新在前」，可切回正序；thread 内消息同步按此顺序
- **完整时间线**：全部消息按时间平铺；每条带锚点 `#m-<id>`，消息 id 与 `↩ re <id>` 可点击跳转并高亮
- **刷新数据**：实时模式下就地拉取 + 重绘，不重载页面；纯静态下退回重新注入数据文件

排序按消息时间（author date）真实排序，不是简单数组反转——转述/补发会让 author date
与提交顺序倒挂（实测占比约 3%，首尾对调会把「最新」排到中间）。
`meta.range` 同样取真实最早/最晚，而不是数组首尾。

## 在 DSH 里当插件用

这个看板也能挂进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的
Web GUI，变成**侧边栏图标 + 独立主面板**（和内置的「Schedules」面板同一种接法）。

```sh
# 1) 起数据服务（插件只负责显示）
bun run bus-report.ts serve --remote <git-remote-url> --out ./out --all-generations

# 2) 把 dsh-plugin/ 接进 web profile，然后在 cordis.patch.yml 里 insert 一条
dsh --profile web --dump-config | grep -A1 bus-viewer   # 验证
```

细节（slot 映射、两种安装方式、跨盘符坑、回滚）见 [`dsh-plugin/README.md`](dsh-plugin/README.md)。

## 相关

- [agent-workspace](https://github.com/myg133/agent-workspace) — 流程与规范源头，bus 消息格式以它为准
- [agent-workspace · messaging.md](https://github.com/myg133/agent-workspace/blob/main/skills/agent-workspace/references/global/messaging.md) — 消息字段、`expect` 语义、代（generation）规则

## License

[MIT](LICENSE) © 2026 myg133
