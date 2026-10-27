# dsh-bus-viewer · DSH 插件

把 bus-report 看板挂进 DeepSeek Harness 的 Web GUI：**侧边栏一枚图标 + 一个独立主面板**。
点图标，主栏就从对话切到看板；再点对话图标切回去。

## 它是怎么接进去的

DSH 的 Web 客户端用 slot 组合界面，侧边栏图标和主面板是**同一套机制的两个 slot**，
用同一个 id 串起来（内置的「Schedules」面板就是这个做法）：

| slot | 作用 | 本插件注册 |
|---|---|---|
| `sidebar.panellist`（list, root） | 侧边栏里的图标行 | id `bus-report`、order `40`、label「Bus 沟通」 |
| `main`（keyed, root） | 主栏的整页内容 | key `bus-report` → `BusViewerPanel` |

宿主半边是空的（`apply() {}`）——插件不需要任何服务端能力，只需要在 Loader 树里
占一行，浏览器 bundle 才会经 `/plugins` 被提供。所以它**不碰模型上下文**，
也不影响 token。

## 依赖

1. **DSH**：web profile（`dsh web`），0.2.x。
2. **数据服务**：bus-report 的本地服务得在跑（插件只负责显示）：

   ```sh
   cd <bus-report 仓库>
   bun run bus-report.ts serve --remote <git-remote-url> --out ./out --all-generations
   ```

   默认地址 `http://127.0.0.1:8787/ba-bus-communication.html`，面板顶部地址栏可以改
   （存在 localStorage），点「刷新」会让服务端再增量 fetch 一次 bus。

## 安装

插件目录就是 `dsh-plugin/`。DSH 从 **profile 的 node_modules** 解析插件包，
所以要让 `dsh-bus-viewer` 在那里可解析。

### 方式 A：dsh 插件命令（同盘时最省事）

```sh
dsh plugin --profile web add file:<绝对路径>/dsh-plugin
```

`file:` 会**复制**一份到 profile，之后改代码要重新 add。
注意 pnpm 的 `file:` 路径是相对 profile 目录解析的，**跨盘符会失败**。

### 方式 B：目录联接（跨盘 / 开发时推荐）

```powershell
# Windows：把插件目录 junction 进 profile 的 node_modules
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-bus-viewer" `
  -Target "<bus-report 仓库>\dsh-plugin"
```

```sh
# macOS / Linux
ln -s <bus-report 仓库>/dsh-plugin ~/.dsh/profiles/web/node_modules/dsh-bus-viewer
```

联接的好处：改 `lib/client.js` 立即生效（配合 HMR 甚至不用重启 DSH）。

### 启用

在 profile 的 `cordis.patch.yml` 末尾追加一条 **insert**（注意不是普通覆盖条目）：

```yaml
- insert:
    - id: bus-viewer
      name: dsh-bus-viewer
```

> 普通条目（`- id: xxx` + `name:`）是**覆盖已有条目**用的；目标不存在时 dsh 只打一行
> `patch: entry "xxx" not found` 就跳过，盒子就永远不会出现。

刷新页面，侧边栏应出现「Bus 沟通」图标。

### 验证配置层

```sh
dsh --profile web --dump-config | grep -A1 bus-viewer
```

### 停用 / 回滚

```sh
# 停用：删掉 cordis.patch.yml 里那条 insert
# 卸载：删掉 node_modules/dsh-bus-viewer（联接或副本），再删 insert 条目
```

## 已知限制

- **iframe 跨端口**：面板嵌的是 `127.0.0.1:8787`，和 GUI（`127.0.0.1:3080`）不同源。
  看板本身不需要 cookie，所以没问题；如果将来给看板加了鉴权，需要改成同源路由。
- **需要单独跑数据服务**：插件不含 git 逻辑。要做成"一个进程全搞定"，
  下一步是把 bus-report 的解析/取数搬进宿主半边，用 `ctx.webServer.register()`
  注册一条同源路由，面板直接吃那条路由。
- **大仓库首次刷新慢**：3 代 × 3000+ 条消息，`/api/bus?refresh=1` 约 20–25 s；
  之后有 `--ttl` 缓存。

## 文件

```
dsh-plugin/
├── package.json     # dsh.client 声明：platform=web + inject 的插件包顺序
├── lib/index.js     # 宿主半边：空 apply，只为让 Loader 有一行
└── lib/client.js    # 浏览器半边：__ModuleLoader__.load({id, factory})
                     #   里注册 sidebar.panellist + main 两个 slot
```
