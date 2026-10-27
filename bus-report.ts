#!/usr/bin/env -S bun run
/**
 * bus-report · BA 沟通梳理报告生成器
 *
 * 从 git 的 bus 分支（消息体即 commit message）提取 BA 之间的全部沟通，
 * 生成一份自包含的 HTML 报告，并同时输出可独立加载的 bus-data.js / bus-data.json。
 *
 * 运行时：Deno / Bun / Node 均可
 *   bun  run bus-report.ts build
 *   deno run -A bus-report.ts build
 *   node --experimental-strip-types bus-report.ts build
 *
 * 只读：对目标仓库只执行 git log / rev-parse，不写工作区、不动分支。
 * 除非显式加 --fetch，否则不执行 git fetch（那会更新 remote-tracking ref）。
 */

// ─────────────────────────────────────────────────────────── 运行时适配层

const g: any = globalThis;
const RUNTIME: "deno" | "bun" | "node" = g.Deno ? "deno" : g.Bun ? "bun" : "node";

async function readText(path: string): Promise<string> {
  if (RUNTIME === "deno") return await g.Deno.readTextFile(path);
  if (RUNTIME === "bun") return await g.Bun.file(path).text();
  const { readFile } = await import("node:fs/promises");
  return await readFile(path, "utf8");
}

async function writeText(path: string, content: string): Promise<void> {
  if (RUNTIME === "deno") {
    await g.Deno.writeTextFile(path, content);
    return;
  }
  if (RUNTIME === "bun") {
    await g.Bun.write(path, content);
    return;
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    if (RUNTIME === "deno") {
      await g.Deno.stat(path);
      return true;
    }
    if (RUNTIME === "bun") return await g.Bun.file(path).exists();
    const { stat } = await import("node:fs/promises");
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 确保目录存在（递归创建）。 */
async function ensureDir(path: string): Promise<void> {
  if (await exists(path)) return;
  if (RUNTIME === "deno") {
    await g.Deno.mkdir(path, { recursive: true });
    return;
  }
  if (RUNTIME === "bun") {
    // Bun.spawn 的 mkdir 在 Windows 上也可用，但直接用 fs 更稳
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: true });
    return;
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 执行一个命令（不经 shell，避免引号与转义问题）。 */
async function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  if (RUNTIME === "deno") {
    const out = await new g.Deno.Command(cmd, {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  }
  if (RUNTIME === "bun") {
    const proc = g.Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { code: await proc.exited, stdout, stderr };
  }
  const { spawn } = await import("node:child_process");
  return await new Promise<RunResult>((resolve) => {
    const p = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

// ─────────────────────────────────────────────────────────── 类型

interface BusMessage {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  at: string;
  type: string;
  thread: string;
  priority: string;
  ref: string;
  contract: string;
  version: string;
  deadline: string;
  /** 反馈义务：none / ack / reply（v2 新增） */
  expect: string;
  /** 期望回复时间（自由文本或 ISO） */
  reply_by: string;
  /** 本条消息回的是哪条消息 id（ack/reply 用） */
  re: string;
  /** ack 结果：ok / no */
  result: string;
  /** 由谁结清：引用本条 id 的那条消息的 id */
  settledBy: string;
  /** 所属 bus 代（分支名），用于跨代聚合 */

  generation: string;
  subject: string;
  body: string;
  sha: string;
  url: string;
  order: number;
  /** 消息体里手写的 at:（凭证用，不作为时间线依据）。 */
  declaredAt: string;
}

interface AgentInfo {
  id: string;
  label: string;
  role: string;
  sent: number;
  received: number;
  primary: { id: string; count: number }[];
}

interface BusData {
  meta: {
    generatedAt: string;
    runtime: string;
    repo: string;
    remote: string;
    mode: "local" | "remote";
    ref: string;
    tip: string;
    gitBaseUrl: string;
    range: { from: string; to: string };
    counts: { messages: number; threads: number; agents: number; openExpect: number };
    /** 合并的 bus 代（分支）列表，多代时用于页面标注 */
    generations: { label: string; ref: string; tip: string; count: number }[];
    source: "external" | "embedded" | "live";
    dataFile: string;
  };
  agents: AgentInfo[];
  messages: BusMessage[];
}

// ─────────────────────────────────────────────────────────── 常量

const TYPE_CN: Record<string, string> = {
  // agent-workspace 现行 7 种（aw.py MSG_TYPES）
  fyi: "知会",
  question: "提问",
  blocker: "阻塞",
  handoff: "交付交接",
  decision: "裁决",
  "contract-change": "契约变更",
  "contract-ack": "契约确认",
  // 历史代里出现过、现版本已不再产出的类型，保留以便跨代聚合可读
  status: "状态",
  "decision-request": "裁决请求",
  registration: "注册",
  offer: "接单意向",
  unknown: "未分类",
};

/** 反馈义务（v2 消息格式）。 */
const EXPECT_CN: Record<string, string> = {
  none: "无需回复",
  ack: "需回执",
  reply: "需回复",
  "": "—",
};

const PRI_CN: Record<string, string> = {
  p0: "P0 最高",
  p1: "P1",
  p2: "P2",
  p3: "P3",
  "": "—",
};

const LIST_FIELDS = new Set(["to", "cc"]);
const KNOWN_FIELDS = new Set([
  "id", "from", "to", "cc", "at", "type", "thread",
  "priority", "ref", "contract", "version", "deadline",
  // v2 消息格式（agent-workspace 2026-10-25 起）
  "expect", "reply_by", "re", "result",
]);

// ─────────────────────────────────────────────────────────── 时区
//
// 统一按中国时区（UTC+8，无夏令时）表示：输出形如 2026-10-22T22:05:00+08:00。
// git 的 %aI 可能是 Z 或其他偏移，这里只改表示、不改时刻。

const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 把任意 ISO 时间折算成 UTC+8 的 ISO 字符串；无法解析时原样返回。 */
function toChinaIso(input: string): string {
  const t = Date.parse(input);
  if (Number.isNaN(t)) return input;
  const d = new Date(t + CN_OFFSET_MS); // 平移后用 UTC 字段读，即北京墙上时间
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+08:00`
  );
}

/** 当前时刻（中国时区 ISO）。 */
function nowChinaIso(): string {
  return toChinaIso(new Date().toISOString());
}

// ─────────────────────────────────────────────────────────── 参数解析

interface Options {
  command: "build" | "watch" | "serve";
  repo: string | null;
  /** 远端地址（URL 或本地路径）。给了它就不需要任何本地 clone。 */
  remote: string | null;
  /** bare 缓存仓库目录（仅 --remote 模式使用）。 */
  cache: string | null;
  /** 要读的 bus 分支（可多个：不同 bus 代）。空 = 默认 origin/bus。 */
  refs: string[];
  /** 自动发现 bus + archive/bus-* 全部代。 */
  allGenerations: boolean;
  out: string;
  html: string;
  dataJs: string;
  dataJson: string;
  template: string | null;
  alias: string | null;
  since: string | null;
  limit: number | null;
  port: number;
  interval: number;
  /** /api/bus 结果的缓存秒数，避免连点刷新打爆远端。 */
  ttl: number;
  fetch: boolean;
  quiet: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = {
    command: "build",
    repo: null,
    remote: null,
    cache: null,
    refs: [],
    allGenerations: false,
    out: ".",
    html: "ba-bus-communication.html",
    dataJs: "bus-data.js",
    dataJson: "bus-data.json",
    template: null,
    alias: null,
    since: null,
    limit: null,
    port: 8787,
    interval: 10,
    ttl: 5,
    fetch: false,
    quiet: false,
    help: false,
  };

  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-h": case "--help": o.help = true; break;
      case "--repo": o.repo = next(); break;
      case "--remote": o.remote = next(); break;
      case "--cache": o.cache = next(); break;
      case "--ref": for (const r of String(next() ?? "").split(",")) {
          const t = r.trim();
          if (t) o.refs.push(t);
        } break;
      case "--all-generations": o.allGenerations = true; break;
      case "--out": o.out = next(); break;
      case "--html": o.html = next(); break;
      case "--data-js": o.dataJs = next(); break;
      case "--data-json": o.dataJson = next(); break;
      case "--template": o.template = next(); break;
      case "--alias": o.alias = next(); break;
      case "--since": o.since = next(); break;
      case "--limit": o.limit = Number(next()); break;
      case "--port": o.port = Number(next()); break;
      case "--interval": o.interval = Number(next()); break;
      case "--ttl": o.ttl = Number(next()); break;
      case "--fetch": o.fetch = true; break;
      case "-q": case "--quiet": o.quiet = true; break;
      default:
        if (!a.startsWith("-") && o.command === "build" &&
            ["build", "watch", "serve"].includes(a)) {
          o.command = a as Options["command"];
        } else {
          rest.push(a);
        }
    }
  }
  return o;
}

function usage(): string {
  return `bus-report · 从 git bus 分支生成 BA 沟通梳理 HTML

用法
  bus-report build [选项]        生成报告（默认命令）
  bus-report watch [选项]        轮询 bus ref，变化时自动重建
  bus-report serve [选项]        本地服务：页面 + /api/bus 实时接口

选项
  --repo <path>     本地目标仓库（默认：从当前目录向上找 .git）
  --remote <url>    远端地址：不需要任何本地 clone，只拉 bus 一个分支
  --cache <dir>     bare 缓存仓库目录（默认 <out>/.bus-cache.git）
  --ref <ref>       bus 分支，可多个（逗号分隔或重复写）：bus,archive/bus-20261024
  --all-generations 自动读全部 bus 代（bus + archive/bus-*），跨代聚合
  --fetch           先 git fetch（会更新 remote-tracking ref，默认不执行）
  --out <dir>       输出目录（默认当前目录）
  --html <file>     HTML 文件名（默认 ba-bus-communication.html）
  --data-js <file>  浏览器可直载的数据文件名（默认 bus-data.js）
  --data-json <f>   纯 JSON 数据文件名（默认 bus-data.json）
  --template <path> 自定义模板（默认脚本同目录 viewer.template.html）
  --alias <path>    Agent 别名/角色映射 JSON（默认脚本同目录 agents.alias.json）
  --since <iso>     只取该时间之后的消息
  --limit <n>       最多取 n 条消息
  --port <n>        serve 端口（默认 8787）
  --interval <秒>   watch 轮询间隔（默认 10）
  --ttl <秒>        /api/bus 缓存秒数（默认 5，0 = 每次刷新都拉）
  -q, --quiet       精简输出

两种数据来源
  A) --repo <本地仓库>   直接读本地 ref（最快，需要已有 clone）
  B) --remote <远端地址> 在缓存目录建一个 bare 仓库，只 fetch bus 相关分支。
                        没有工作区、不检出文件、不碰目标仓库，bus 的 commit
                        全是空 commit（tree 恒为空树），一代 300 条约 600 KB。

消息格式
  现行（agent-workspace 2026-10-25+）：id/from/to/cc/at/type/priority/ref/
  contract/version/deadline/thread/expect/reply_by/re/result
  · expect=none|ack|reply 表示反馈义务；被 re: <id> 引用即视为已结清
  · 旧代没有 expect/re，按「无反馈义务」处理

说明
  · 只读目标仓库：仅 git log / git rev-parse / git fetch，不写工作区、不动分支。
  · serve 模式下页面刷新按钮会请求 /api/bus，由服务端现场（增量）fetch 后返回，
    页面无需重载；拿不到接口时自动退回同目录 data-js 快照。
`;
}

// ─────────────────────────────────────────────────────────── 仓库定位

async function findRepo(start: string): Promise<string | null> {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const gitPath = dir + (dir.includes("\\") || dir.includes("/") ? "/" : "") + ".git";
    if (await exists(gitPath)) return dir;
    const parent = dir.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 把用户写的 ref 归一成短名：origin/bus → bus，refs/heads/x → x。 */
function refLabel(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/origin\//, "")
    .replace(/^origin\//, "");
}

async function resolveRef(repo: string, want: string): Promise<string> {
  const short = refLabel(want);
  const candidates = want === "origin/bus" || want === "bus"
    ? ["origin/bus", "bus", "refs/remotes/origin/bus", "refs/heads/bus"]
    : [want, `origin/${short}`, `refs/remotes/origin/${short}`, `refs/heads/${short}`];
  for (const c of candidates) {
    const r = await run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", c]);
    if (r.code === 0 && r.stdout.trim()) return c;
  }
  throw new Error(
    `找不到 bus ref「${want}」。已尝试：${candidates.join(", ")}\n` +
    `可用 --ref 指定其它分支（多个用逗号分隔），或加 --fetch 先拉取。`,
  );
}

// ─────────────────────────────────────────────────────────── 数据来源
//
// 两种模式：
//   local  —— 已有 clone，直接读本地 ref（默认，最快）
//   remote —— 没有 clone：在 <cache> 建一个 bare 仓库，只 fetch bus 相关分支。
//             不检出工作区、不碰目标仓库，bus 的 commit 全部指向空树，
//             所以只传输 commit 对象本身（典型 300~600 KB/代）。
//
// bus 会「换代」：旧代归档到 archive/bus-YYYYMMDD，新代从空历史重建。
// --all-generations 会把所有代一起读进来。

interface SourceRef {
  /** 实际传给 git log 的 ref */
  ref: string;
  /** 展示用短名，如 bus / archive/bus-20261024 */
  label: string;
}

interface Source {
  /** 执行 git -C 的目录。remote 模式下是 bare 缓存仓库。 */
  repo: string;
  refs: SourceRef[];
  mode: "local" | "remote";
  remote: string;
}

async function isGitRepo(dir: string): Promise<boolean> {
  return (await exists(`${dir}/.git`)) || (await exists(`${dir}/HEAD`));
}

async function ensureBareCache(cacheDir: string, o: Options): Promise<void> {
  if (await isGitRepo(cacheDir)) return;
  await ensureDir(cacheDir);
  const init = await run("git", ["init", "--bare", "-q", cacheDir]);
  if (init.code !== 0) {
    throw new Error(`初始化缓存仓库失败（${cacheDir}）：${init.stderr.trim()}`);
  }
  if (!o.quiet) console.log(`  · 新建 bare 缓存：${cacheDir}`);
}

/** 远端有哪些 bus 代：bus + archive/bus-* */
async function discoverRemoteGenerations(cacheDir: string, remote: string): Promise<string[]> {
  const r = await run("git", [
    "-C", cacheDir, "ls-remote", "--heads", remote,
    "refs/heads/bus", "refs/heads/archive/bus-*",
  ]);
  if (r.code !== 0) {
    throw new Error(`git ls-remote 失败：${r.stderr.trim() || "未知错误"}`);
  }
  const names = r.stdout.split("\n").map((l) => l.split("\t")[1]?.trim()).filter(Boolean) as string[];
  return names.map(refLabel).sort();
}

/** 本地有哪些 bus 代（优先 remote-tracking）。 */
async function discoverLocalGenerations(repo: string): Promise<string[]> {
  const r = await run("git", [
    "-C", repo, "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes/origin/bus", "refs/remotes/origin/archive/bus*",
    "refs/heads/bus", "refs/heads/archive/bus*",
  ]);
  if (r.code !== 0) return [];
  const names = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  // remote-tracking 优先，同名去重
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const label = refLabel(n);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out.sort();
}

/** 只拉指定的 bus 分支，绝不把业务分支拖下来。 */
async function fetchRefs(
  cacheDir: string,
  remote: string,
  labels: string[],
  o: Options,
): Promise<void> {
  const spec = labels.map((l) => `+refs/heads/${l}:refs/heads/${l}`);
  const f = await run("git", [
    "-C", cacheDir, "fetch", "--no-tags", "--prune", remote, ...spec,
  ]);
  if (f.code !== 0) {
    throw new Error(
      `git fetch 失败：${f.stderr.trim() || "未知错误"}\n` +
      `  远端：${remote}\n  分支：${labels.join(", ")}\n  缓存：${cacheDir}`,
    );
  }
}

async function prepareSource(o: Options): Promise<Source> {
  if (o.remote) {
    const cacheDir = o.cache ?? `${o.out}/.bus-cache.git`;
    await ensureBareCache(cacheDir, o);

    let labels = o.refs.map(refLabel);
    if (o.allGenerations) {
      labels = await discoverRemoteGenerations(cacheDir, o.remote);
    }
    if (labels.length === 0) labels = ["bus"];

    await fetchRefs(cacheDir, o.remote, labels, o);
    return {
      repo: cacheDir,
      mode: "remote",
      remote: o.remote,
      refs: labels.map((label) => ({ ref: `refs/heads/${label}`, label })),
    };
  }

  const repo = o.repo ?? (await findRepo(process.cwd()));
  if (!repo) {
    throw new Error(
      "定位不到目标仓库。请用 --repo <path> 指定本地仓库，" +
      "或用 --remote <url> 直接从远端读（不需要 clone）。",
    );
  }
  if (o.fetch) {
    const f = await run("git", ["-C", repo, "fetch", "origin", "bus"]);
    if (f.code !== 0 && !o.quiet) {
      console.warn(`  ! git fetch 未成功（${f.stderr.trim()}），继续使用本地已有 ref`);
    }
  }

  const refs: SourceRef[] = [];
  if (o.allGenerations) {
    for (const label of await discoverLocalGenerations(repo)) {
      try {
        const ref = await resolveRef(repo, label);
        refs.push({ ref, label });
      } catch {
        /* 本地没有这一代，忽略 */
      }
    }
  } else {
    for (const want of o.refs.length ? o.refs : ["origin/bus"]) {
      const ref = await resolveRef(repo, want);
      refs.push({ ref, label: refLabel(ref) });
    }
  }
  if (refs.length === 0) {
    throw new Error("没有可读的 bus 分支。用 --ref 指定，或检查本地是否 fetch 过。");
  }
  return { repo, refs, mode: "local", remote: "" };
}

// ─────────────────────────────────────────────────────────── 提取与解析

/** 从 bus 分支读取全部提交，按记录分隔符切成结构化消息。 */
async function extractMessages(
  repo: string,
  ref: string,
): Promise<{ messages: BusMessage[]; tip: string }> {
  const log = await run("git", [
    "-C", repo, "log", "--reverse",
    "--format=%H%x1f%aI%x1f%an%x1f%B%x1e", ref,
  ]);
  if (log.code !== 0) {
    throw new Error(`git log 失败：${log.stderr.trim() || "未知错误"}`);
  }

  const tipRes = await run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref]);
  const tip = tipRes.stdout.trim();

  // 记录分隔符 U+001E，字段分隔符 U+001F —— commit body 不含这两个控制字符
  const records = log.stdout.split("\u001e").filter((r) => r.trim().length > 0);
  const messages: BusMessage[] = [];

  records.forEach((rec, index) => {
    const fields = rec.split("\u001f");
    if (fields.length < 4) return;
    const sha = fields[0].trim();
    const committedAt = fields[1].trim();
    const body = fields.slice(3).join("\u001f").replace(/^\n+/, "");
    messages.push(parseCommit(sha, committedAt, body, index));
  });

  return { messages, tip };
}

/** 解析单条 commit message 的结构化头与正文。 */
function parseCommit(
  sha: string,
  committedAt: string,
  rawBody: string,
  order: number,
): BusMessage {
  const body = rawBody.replace(/\r\n/g, "\n");
  const lines = body.split("\n");

  const msg: BusMessage = {
    id: "",
    from: "",
    to: [],
    cc: [],
    at: committedAt,
    type: "",
    thread: "",
    priority: "",
    ref: "",
    contract: "",
    version: "",
    deadline: "",
    expect: "",
    reply_by: "",
    re: "",
    result: "",
    settledBy: "",
    generation: "",
    subject: "",
    body: "",
    sha,
    url: "",
    order,
    declaredAt: "",
  };

  // 头部两种布局：
  //   A) "[msg] <type> <subject> -> <to>" 空行 "---" 字段 "---" 正文
  //   B) 字段直接在开头，单个 "---" 作分隔，正文随后
  const dashes: number[] = [];
  lines.forEach((l, i) => {
    if (l.trim() === "---") dashes.push(i);
  });

  const applyFields = (from: number, to: number) => {
    for (const line of lines.slice(from, to)) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      if (LIST_FIELDS.has(key)) {
        const inner = val.replace(/^\[|\]$/g, "");
        const list = inner.split(",").map((s) => s.trim()).filter(Boolean);
        (msg as any)[key] = list;
      } else if (key === "at") {
        // 消息体里的 at 是发送方手写的，实测常比真实提交时间晚几分钟到半小时
        // （26/572 条，最多 +37 分钟，会出现「未来消息」）。时间线一律以 commit
        // 的 author date 为准，这里只把它留作 declaredAt 凭证。
        msg.declaredAt = val;
      } else if (KNOWN_FIELDS.has(key)) {
        (msg as any)[key] = val;
      }
    }
  };

  let textStart = 0;
  if (dashes.length >= 2) {
    applyFields(dashes[0] + 1, dashes[1]);
    textStart = dashes[1] + 1;
  } else if (dashes.length === 1 && lines[0]?.includes(":")) {
    applyFields(0, dashes[0]);
    textStart = dashes[0] + 1;
  } else {
    textStart = 0;
  }

  msg.body = lines.slice(textStart).join("\n").trim();

  // subject：取首行 "[msg] ..." 去掉前缀
  const firstLine = lines[0] ?? "";
  const m = firstLine.match(/^\[msg\]\s*(?:(\S+)\s+)?(.*)$/);
  if (m) {
    if (!msg.type) msg.type = m[1] ?? "";
    msg.subject = (m[2] ?? "").trim();
  } else {
    msg.subject = firstLine.trim();
  }
  if (!msg.type) msg.type = "unknown";
  if (!msg.from) msg.from = "unknown";
  if (!msg.id) msg.id = sha.slice(0, 8);
  if (!msg.at) msg.at = committedAt;

  return msg;
}

// ─────────────────────────────────────────────────────────── 别名映射

type AliasMap = Record<string, { label?: string; role?: string }>;

/** 从 agent id 推导可读标签：去前缀、去尾部哈希、去主机段。 */
function deriveLabel(id: string): string {
  let s = id;
  s = s.replace(/^(ba|role)[-:]/, "");
  s = s.replace(/-[0-9a-f]{6,10}$/, "");
  s = s.replace(/-\d{1,3}$/, "");
  s = s.replace(/-(homepc|mac|macbook|windows|linux|workstation|pc)$/i, "");
  return s || id;
}

async function loadAliases(path: string | null): Promise<AliasMap> {
  const candidates = path
    ? [path]
    : ["./agents.alias.json", "./agents.alias.jsonc"];
  for (const c of candidates) {
    if (await exists(c)) {
      try {
        return JSON.parse(await readText(c));
      } catch (e) {
        throw new Error(`别名映射文件解析失败：${c}（${(e as Error).message}）`);
      }
    }
  }
  return {};
}

// ─────────────────────────────────────────────────────────── 聚合

function aggregate(
  messages: BusMessage[],
  aliases: AliasMap,
): { agents: AgentInfo[]; threads: number } {
  const sent = new Map<string, number>();
  const received = new Map<string, number>();
  const edges = new Map<string, Map<string, number>>();
  const threads = new Set<string>();

  for (const m of messages) {
    sent.set(m.from, (sent.get(m.from) ?? 0) + 1);
    if (m.thread) threads.add(m.thread);
    for (const r of [...m.to, ...m.cc]) {
      received.set(r, (received.get(r) ?? 0) + 1);
      if (r !== m.from) {
        if (!edges.has(m.from)) edges.set(m.from, new Map());
        const e = edges.get(m.from)!;
        e.set(r, (e.get(r) ?? 0) + 1);
      }
    }
  }

  // all / role:xxx 是广播寻址，不是实体 agent；unknown 是解析兜底 —— 都不进参与者表
  const isEntity = (id: string) =>
    id && id !== "unknown" && id !== "all" && !id.startsWith("role:");

  const ids = new Set<string>(
    [...sent.keys(), ...received.keys()].filter(isEntity),
  );
  const agents: AgentInfo[] = [...ids].map((id) => {
    const a = aliases[id] ?? {};
    const primary = [...(edges.get(id) ?? new Map()).entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([rid, count]) => ({ id: rid, count }));
    return {
      id,
      label: a.label ?? deriveLabel(id),
      role: a.role ?? "",
      sent: sent.get(id) ?? 0,
      received: received.get(id) ?? 0,
      primary,
    };
  }).sort((a, b) => b.sent - a.sent || b.received - a.received);

  return { agents, threads: threads.size };
}

function remoteToBaseUrl(url: string): string {
  const m = url.match(/^(?:ssh:\/\/)?git@([^:]+):(.+?)(?:\.git)?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  const h = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (h) return `https://${h[1]}/${h[2]}`;
  return "";
}

async function gitBaseUrl(repo: string): Promise<string> {
  const r = await run("git", ["-C", repo, "remote", "get-url", "origin"]);
  if (r.code !== 0) return "";
  const url = r.stdout.trim();
  return remoteToBaseUrl(url) || url;
}

// ─────────────────────────────────────────────────────────── 输出

function jsonForHtml(json: string): string {
  // 内嵌进 <script type="application/json"> 时的 HTML 解析安全转义。
  // 只处理 "</" 不够：消息体里可能贴了整页 HTML（实测有），其中的 "<script>"、"<!--"
  // 会让解析器进入 script data escaped / double escaped 状态，<script> 元素的边界
  // 就不再是字面量能推断的了。把 < > & 全转成 \uXXXX（JSON 结构字符不受影响）。
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderTemplate(
  template: string,
  data: BusData,
  opts: { dataFile: string },
): string {
  // 注意：替换值必须用「函数」形式。String.replaceAll 的字符串替换会解释
  // $& / $` / $' / $$ 等模式——消息体里一旦出现 $'，就会把模板的剩余部分
  // 整段塞进 JSON 里（实测发生过）。用函数即按字面量替换。
  const literal = (v: string) => () => v;
  return template
    .replaceAll("{{TITLE}}", literal("BA Bus 沟通梳理"))
    .replaceAll("{{GENERATED_AT}}", literal(data.meta.generatedAt))
    .replaceAll("{{SOURCE_REF}}", literal(`${data.meta.ref} @ ${data.meta.tip.slice(0, 12)}`))
    .replaceAll("{{DATA_FILE}}", literal(opts.dataFile))
    .replaceAll("{{EMBEDDED_JSON}}", literal(jsonForHtml(JSON.stringify(data))));
}

interface BuildResult {
  data: BusData;
  htmlPath: string;
  dataJsPath: string;
  dataJsonPath: string;
}

interface CollectResult {
  data: BusData;
  source: Source;
}

/** 采集并聚合数据（不落盘）。build / serve / watch 共用。 */
async function collect(
  o: Options,
  aliases: AliasMap,
  src?: Source,
): Promise<CollectResult> {
  const source = src ?? (await prepareSource(o));

  // 逐代读取并合并（bus 会换代：archive/bus-YYYYMMDD + 当前 bus）
  const merged: BusMessage[] = [];
  const generations: BusData["meta"]["generations"] = [];
  const seen = new Set<string>();
  for (const r of source.refs) {
    const { messages, tip } = await extractMessages(source.repo, r.ref);
    generations.push({ label: r.label, ref: r.ref, tip, count: messages.length });
    for (const m of messages) {
      m.generation = r.label;
      if (seen.has(m.sha)) continue; // 同一 commit 出现在两代里时只留一份
      seen.add(m.sha);
      merged.push(m);
    }
  }

  // 统一折算成中国时区（只改表示，不改时刻；排序/比较仍按真实瞬间）
  for (const m of merged) {
    m.at = toChinaIso(m.at);
    if (m.declaredAt) m.declaredAt = toChinaIso(m.declaredAt);
  }

  // 合代后按时间正序（稳定：同一时刻保持原提交顺序）
  merged.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || a.order - b.order);
  merged.forEach((m, i) => (m.order = i));

  let filtered = merged;
  if (o.since) {
    const since = Date.parse(o.since);
    if (Number.isNaN(since)) throw new Error(`--since 时间无法解析：${o.since}`);
    filtered = filtered.filter((m) => {
      const t = Date.parse(m.at);
      return Number.isNaN(t) ? true : t >= since;
    });
  }
  if (o.limit && o.limit > 0) filtered = filtered.slice(-o.limit);

  // 反馈义务结清情况：谁发了 expect=ack/reply，有没有人用 re: <id> 回过
  const byId = new Map<string, BusMessage>();
  for (const m of filtered) if (m.id && !byId.has(m.id)) byId.set(m.id, m);
  for (const m of filtered) {
    if (!m.re) continue;
    const target = byId.get(m.re);
    if (target && !target.settledBy) target.settledBy = m.id;
  }

  const { agents, threads } = aggregate(filtered, aliases);
  const baseUrl = source.mode === "remote"
    ? remoteToBaseUrl(source.remote)
    : await gitBaseUrl(source.repo);
  for (const m of filtered) {
    m.url = baseUrl ? `${baseUrl}/-/commit/${m.sha}` : m.sha;
  }

  // 时间跨度取真实的最早/最晚（author date 与提交顺序可能不一致，不能只看首尾）
  let earliest: BusMessage | undefined;
  let latest: BusMessage | undefined;
  for (const m of filtered) {
    const t = Date.parse(m.at);
    if (Number.isNaN(t)) continue;
    if (!earliest || t < Date.parse(earliest.at)) earliest = m;
    if (!latest || t > Date.parse(latest.at)) latest = m;
  }

  const open = filtered.filter(
    (m) => m.expect && m.expect !== "none" && !m.settledBy,
  );

  const data: BusData = {
    meta: {
      generatedAt: nowChinaIso(),
      runtime: RUNTIME,
      repo: source.repo,
      remote: source.remote,
      mode: source.mode,
      ref: generations.map((g) => g.label).join(" + "),
      tip: generations.find((g) => g.label === "bus")?.tip ??
        generations[generations.length - 1]?.tip ?? "",
      gitBaseUrl: baseUrl,
      generations,
      range: {
        from: earliest?.at ?? "",
        to: latest?.at ?? "",
      },
      counts: {
        messages: filtered.length,
        threads,
        agents: agents.length,
        openExpect: open.length,
      },
      source: "embedded",
      dataFile: o.dataJs,
    },
    agents,
    messages: filtered,
  };

  return { data, source };
}

async function build(o: Options, aliases: AliasMap): Promise<BuildResult> {
  const { data } = await collect(o, aliases);

  const templatePath = o.template ?? "./viewer.template.html";
  if (!(await exists(templatePath))) {
    throw new Error(`找不到模板文件：${templatePath}（用 --template 指定）`);
  }
  const template = await readText(templatePath);

  const outDir = o.out;
  await ensureDir(outDir);
  const htmlPath = `${outDir}/${o.html}`;
  const dataJsPath = `${outDir}/${o.dataJs}`;
  const dataJsonPath = `${outDir}/${o.dataJson}`;

  await writeText(htmlPath, renderTemplate(template, data, { dataFile: o.dataJs }));
  await writeText(dataJsonPath, JSON.stringify(data, null, 1));
  await writeText(
    dataJsPath,
    `/* bus-report 自动生成 · ${data.meta.generatedAt}\n` +
      `   本文件可被页面以 <script src="./${o.dataJs}"> 直接加载 */\n` +
      `window.__BUS_DATA__ = ${JSON.stringify(data)};\n`,
  );

  return { data, htmlPath, dataJsPath, dataJsonPath };
}

// ─────────────────────────────────────────────────────────── serve / watch

interface Reply {
  body: string;
  type: string;
  code: number;
  noStore?: boolean;
}

async function serve(o: Options, aliases: AliasMap): Promise<void> {
  const dir = o.out;
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".css": "text/css; charset=utf-8",
  };

  // 首次启动：没有页面就先建一份（同时把 bus-data.js 快照写好作为兜底）
  if (!(await exists(`${dir}/${o.html}`))) {
    if (!o.quiet) console.log("  · 首次启动，先构建页面…");
    await build(o, aliases);
  }

  // ── 实时数据：带 TTL 缓存 + 并发去重，避免连点刷新打爆远端
  let cached: BusData | null = null;
  let cachedAt = 0;
  let inflight: Promise<BusData> | null = null;

  const live = async (force: boolean): Promise<BusData> => {
    const fresh = cached && Date.now() - cachedAt < Math.max(0, o.ttl) * 1000;
    if (!force && fresh) return cached!;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { data } = await collect(o, aliases);
        data.meta.source = "live";
        cached = data;
        cachedAt = Date.now();
        if (!o.quiet) {
          console.log(
            `  ↻ /api/bus → ${data.meta.counts.messages} 条 · ` +
            `tip ${data.meta.tip.slice(0, 12)}`,
          );
        }
        return data;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  const api = async (url: URL): Promise<Reply> => {
    try {
      const force = url.searchParams.get("refresh") === "1" ||
        url.searchParams.get("force") === "1";
      const data = await live(force);
      return {
        body: JSON.stringify(data),
        type: "application/json; charset=utf-8",
        code: 200,
        noStore: true,
      };
    } catch (e) {
      return {
        body: JSON.stringify({ error: (e as Error).message }),
        type: "application/json; charset=utf-8",
        code: 502,
        noStore: true,
      };
    }
  };

  const staticFile = async (pathname: string): Promise<Reply> => {
    const clean = pathname.replace(/^\/+/, "") || o.html;
    // 只暴露 out 目录里的普通产物，挡掉缓存仓库和上级目录
    if (clean.includes("..") || clean.startsWith(".") || clean.includes(".git")) {
      return { body: `403 · ${clean} 不可访问`, type: "text/plain; charset=utf-8", code: 403 };
    }
    const full = `${dir}/${clean}`;
    if (!(await exists(full))) {
      return { body: `404 · ${clean} 不存在`, type: "text/plain; charset=utf-8", code: 404 };
    }
    const ext = clean.slice(clean.lastIndexOf("."));
    return {
      body: await readText(full),
      type: mime[ext] ?? "text/plain; charset=utf-8",
      code: 200,
    };
  };

  const handler = async (url: URL): Promise<Reply> => {
    const p = url.pathname;
    if (p === "/api/bus" || p === "/api/bus/") return api(url);
    return staticFile(p);
  };

  const headers = (r: Reply): Record<string, string> => {
    const h: Record<string, string> = {
      "content-type": r.type,
      "access-control-allow-origin": "*",
    };
    if (r.noStore) h["cache-control"] = "no-store";
    return h;
  };

  const port = o.port;
  if (RUNTIME === "deno") {
    g.Deno.serve({ port }, async (req: any) => {
      const r = await handler(new URL(req.url));
      return new Response(r.body, { status: r.code, headers: headers(r) });
    });
  } else if (RUNTIME === "bun") {
    g.Bun.serve({
      port,
      // 大仓库的 /api/bus?refresh=1 要现拉 bus + 解析上千条消息，会超过默认 10s
      idleTimeout: 120,
      fetch: async (req: any) => {
        const r = await handler(new URL(req.url));
        return new Response(r.body, { status: r.code, headers: headers(r) });
      },
    });
  } else {
    const { createServer } = await import("node:http");
    createServer(async (req: any, res: any) => {
      const r = await handler(new URL(req.url, `http://localhost:${port}`));
      res.writeHead(r.code, headers(r));
      res.end(r.body);
    }).listen(port);
  }

  const srcDesc = o.remote
    ? `remote ${o.remote}（bare 缓存：${o.cache ?? `${o.out}/.bus-cache.git`}）`
    : `local ${o.repo ?? "(自动定位)"}`;
  console.log(`bus-report serve → http://localhost:${port}/${o.html}`);
  console.log(`  数据源  ${srcDesc}`);
  console.log(
    `  分支    ${o.allGenerations ? "全部代（bus + archive/bus-*）" : (o.refs.length ? o.refs.join(", ") : "origin/bus")}`,
  );
  console.log(`  实时接口 /api/bus?refresh=1（页面刷新按钮就是打它）`);
  console.log(`  数据目录 ${dir}（Ctrl+C 结束）`);
}

async function watch(o: Options, aliases: AliasMap): Promise<void> {
  let source = await prepareSource(o);
  let last = "";
  const tick = async () => {
    try {
      if (source.mode === "remote") {
        // 每次轮询都增量 fetch（bus 只有 commit 对象，增量为空时 <1s）
        await fetchRefs(
          source.repo,
          source.remote,
          source.refs.map((r) => r.label),
          o,
        );
      }
      const tips: string[] = [];
      for (const r of source.refs) {
        const res = await run("git", ["-C", source.repo, "rev-parse", "--verify", "--quiet", r.ref]);
        tips.push(res.stdout.trim());
      }
      const sha = tips.join(",");
      if (sha && sha !== last) {
        if (last) console.log(`  [${nowChinaIso()}] 检测到 bus 变化，重建…`);
        last = sha;
        const res = await build(o, aliases);
        console.log(
          `  ✓ ${res.data.meta.counts.messages} 条消息 · ` +
          `${res.data.meta.counts.threads} thread · ` +
          `${res.data.meta.counts.openExpect} 待结清 → ${res.htmlPath}`,
        );
      }
    } catch (e) {
      console.error(`  ✗ 重建失败：${(e as Error).message}`);
    }
  };
  await tick();
  console.log(
    `watch ${source.refs.map((r) => r.label).join(" + ")}，每 ${o.interval}s 轮询一次（Ctrl+C 结束）`,
  );
  setInterval(tick, Math.max(2, o.interval) * 1000);
}

// ─────────────────────────────────────────────────────────── 入口

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || o.command === undefined) {
    console.log(usage());
    return;
  }

  const aliases = await loadAliases(o.alias);

  if (o.command === "serve") {
    await serve(o, aliases);
    return;
  }

  if (o.command === "watch") {
    await watch(o, aliases);
    return;
  }

  const res = await build(o, aliases);
  const c = res.data.meta.counts;
  const m = res.data.meta;
  if (!o.quiet) {
    console.log(`✓ bus-report 生成完成（${RUNTIME}）`);
    console.log(`  仓库      ${m.mode === "remote" ? m.remote : m.repo}`);
    if (m.mode === "remote") console.log(`  缓存      ${m.repo}`);
    console.log(`  来源      ${m.ref} @ ${m.tip.slice(0, 12)}`);
    console.log(`  消息      ${c.messages} 条 / ${c.threads} thread / ${c.agents} 个 Agent`);
    console.log(`  待结清    ${c.openExpect} 条带 expect=ack/reply 且尚未被 re 回执`);
    if (m.generations.length > 1) {
      console.log(`  代        ${m.generations.map((g) => `${g.label}(${g.count})`).join(" + ")}`);
    }
    console.log(`  时间跨度  ${m.range.from} → ${m.range.to}`);
    console.log(`  HTML      ${res.htmlPath}`);
    console.log(`  数据      ${res.dataJsPath}（页面优先加载它）`);
    console.log(`            ${res.dataJsonPath}`);
  }
}

main().catch((e) => {
  console.error(`bus-report 失败：${(e as Error).message}`);
  process.exit(1);
});
