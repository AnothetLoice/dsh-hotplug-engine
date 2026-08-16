# 服务契约 v1 — dsh-hotplug-engine(**已冻结 v1,2026-08-14**)

> 文档编号:`hotplug-engine-CONTRACT-01` | 性质:**契约(权威,消费方依赖,已冻结 v1)** | 版本:1.0(2026-08-14 冻结)
> 上位约束:设计基线(私有工作笔记,未随仓库发布) §2-§5(不得偏离);机制事实以设计审计笔记(私有,未随仓库发布)为准
> 适用对象:市场/agent/宿主插件等**消费方**、引擎实现者
> 规范关键词:MUST / MUST NOT / SHOULD / SHOULD NOT / MAY(RFC 语义)
> **冻结条件已达成(2026-08-14)**:M1–M4 全量实现完成(166/166 测试全绿、typecheck 零错误、发布包实机验证通过)+ M4 冻结门双 subagent review 通过(架构:有条件通过→major M1 已修;一致性:需修正项全部修正)。冻结后:v1 内新增能力 MUST 向后兼容(旧消费方忽略新字段);契约语义变化 → 升 v2。

---

## 1. 服务身份

| 项 | 值 |
|---|---|
| 包名 | `dsh-hotplug-engine`(unscoped;发布 scope 留待发布时定) |
| 形态 | **bundle 双面插件**:声明 `dsh.bundle.patch`(官方 `dsh plugin add` 可装,进 bundles 层,首装需重启一次);之后一切插件变更走热挂 |
| 自身行 id | `hotplug-engine`(bundle patch 中固定;profile patch 可禁用之,禁用即卸载服务,消费方须可降级) |
| ctx 服务名 | `hotplugEngine`(`inject: ['hotplugEngine']` / `ctx.get('hotplugEngine')`;与社区 `pluginManager` 不冲突) |
| 契约版本化 | 本契约 v1;**v1 内只增不改**(新增字段/方法不破坏既有消费方);破坏性变更 → v2,旧版并行降级期 |

## 2. 能力总览

- **状态面**:snapshot(官方组合树/loader 树投影)、status(单行健康);
- **变更面**(全部幂等、串行、可回滚):install / uninstall / enable / disable / rollback;
- **查询面**:audit、listOperations;
- **事件面**:SSE 推送操作与条目状态变更;
- **工具面**:agent 工具(`hotplug_*`,见 §6)。

**MUST 遵守的全局不变量**:
1. 状态唯一真源 = 官方组合树/loader 树;引擎只做投影与差分,不另存真源;
2. 消费方传入的 `spec`(安装源)为不透明字符串:引擎 MUST NOT 解析其市场语义(仓库爬取/策展),只做"spec → 安全安装";
3. 任何写操作 MUST 先备份、后审计、全局串行、幂等;
4. 引擎写入 patch 的行 MUST 位于 owner managed block 内,且 MUST NOT 包含 `!!js` 表达式。

## 3. 类型定义(契约的 TS 单一来源)

> 实现侧导出 `src/contract/types.ts`,由本契约派生;消费方以本契约(或导出的类型包)为准。

```ts
/** 一次安装/启停的返回(所有变更方法统一信封) */
interface MutationResult {
  ok: boolean
  message: string
  operationId?: string          // 变更操作的跟踪 id(串行队列入队即分配)
  mode?: 'hot' | 'restart'      // 本次生效方式:hot=配置 HMR 实时;restart=需重启
  restartRequired?: boolean     // mode==='restart' 时为 true
  installed?: string[]          // install/uninstall 实际安装/移除的包名
  rollbackHandle?: string       // 回滚句柄(备份引用),可传给 rollback()
  errors?: { code: string; detail: string; stage?: 'gate' | 'install' | 'observe' }[]  // stage 为 v0.1.4 新增可选字段(失败阶段归类)
}

/** 运行时条目(官方树投影的一行) */
interface RuntimeEntry {
  entryId: string               // 稳定 include-row id(可 patch 定位);loader 随机 8-hex id 不可定位
  moduleName: string            // 包名
  source: 'bundle' | 'insert' | 'user'   // 来源分类(见 §3 注)
  enabled: boolean
  patchTargetable: boolean      // 是否可用稳定 id 做 enable/disable
  fiberPhase: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  managed: boolean              // 是否处于引擎 managed block 内
  critical?: boolean            // 官方核心插件分类(高危停用警告用;v0.1.4 新增,可选字段)
}

/** 已安装包视图 */
interface InstalledPackage {
  name: string
  isBundle: boolean             // 在 dsh.profile.bundles 层
  version?: string
  installedAt?: string
}

/** 快照(状态面) */
interface EngineSnapshot {
  profile: string
  mode: 'hot' | 'restart'       // 引擎运行模式(降级路径,§9)
  entries: RuntimeEntry[]
  packages: InstalledPackage[]
  insertRows: { id: string; name: string; managed: boolean }[]
  auditLag?: boolean            // 审计滞后指示:某次 JSONL 写失败后为 true(2026-08-14 M4 T4.1 新增,可选字段)
}

/** 操作记录 */
interface OperationInfo {
  operationId: string
  op: 'install' | 'uninstall' | 'enable' | 'disable' | 'rollback'
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled-back'
  target?: string
  startedAt?: string
  finishedAt?: string
  result?: MutationResult
}

/** 审计记录(JSONL 一行) */
interface AuditRecord {
  ts: string                    // ISO-8601 UTC
  operationId: string
  op: string
  target?: string
  spec?: string
  mode: 'hot' | 'restart'
  result: 'succeeded' | 'failed' | 'rolled-back'
  errorCode?: string
  caller: 'service' | 'rest' | 'tool'
  patchBeforeHash?: string      // 变更前 patch 文件 sha1(短 12)
  patchAfterHash?: string
  backupPath?: string           // 变更前备份引用
}

/** 事件帧(SSE data 行,JSON) */
type EngineEvent =
  | { type: 'operation'; operationId: string; op: string; status: OperationInfo['status']; ts: string }
  | { type: 'entry'; entryId: string; phase: RuntimeEntry['fiberPhase']; ts: string }
  | { type: 'snapshot'; rev: string; ts: string }
```

> 注 1(来源分类):包在 `dsh.profile.bundles` → `bundle`;在引擎 managed insert block → `insert`;其余 → `user`。
> 注 2(术语):`entryId` = include-row 稳定 id(enable/disable 的定位目标);install 生成的 insert 行内 `id` 字段称 `rowId`,与其挂载后的 `RuntimeEntry.entryId` 同值——对外契约统一称 `entryId`。loader 随机 8-hex id 不可 patch 定位,`patchTargetable:false`。
> 注 3(投影):`InstalledPackage` 聚合「npm manifest 依赖 + bundles 层」是**投影视图**(npm deps 不全是插件),不代表独立安装态;引擎不另存安装态真源。
> 注 4(installedAt 语义,v0.1.4):`InstalledPackage.installedAt` 为**近似安装时间**(ISO-8601),取值 node_modules/<name>/package.json 的 mtime;缺失时为 undefined(可选字段,JSON 序列化省略)。非精确审计时间,仅用于看板排序展示。

## 4. 方法契约(host 服务 `ctx.hotplugEngine`)

```ts
snapshot(profile?: string): EngineSnapshot            // 只读,不入队
status(entryId?: string, profile?: string): RuntimeEntry | undefined  // 只读
install(spec: string, opts?: { profile?: string; dryRun?: boolean }): Promise<MutationResult>
uninstall(name: string, opts?: { profile?: string }): Promise<MutationResult>
enable(entryId: string, opts?: { profile?: string }): Promise<MutationResult>  // 队列执行完(含观察窗口确认)后 resolve
disable(entryId: string, opts?: { profile?: string }): Promise<MutationResult>
rollback(handle: string, opts?: { profile?: string }): Promise<MutationResult>
audit(query?: { op?: string; from?: string; limit?: number }): AuditRecord[]
auditLag(): boolean             // 审计滞后指示(2026-08-14 M4 T4.1 新增,增量方法):JSONL 写失败后为 true
listOperations(): OperationInfo[]
onEvent(listener: (e: EngineEvent) => void): () => void
```

**语义要点**:
- 写方法(`install/uninstall/enable/disable/rollback`)MUST 经**全局串行队列**执行(配置 HMR 重放非可重入),全部返回 Promise,resolve 时操作已完成(`enable/disable` 含观察窗口确认);`ok:true` 表示**已应用**,不是"已入队";队列进度可在 `listOperations` 追踪;
- 全部幂等:重复执行结果一致(desired-state 写入);
- `enable/disable` 的 `entryId` MUST 是稳定 include-row id;随机 loader id 传入 → 返回 `HOTPLUG.PATCH.UNSAFE_TARGET`;
- 写方法 opts MAY 携带内部 `caller`(`'rest' | 'tool'`,审计 provenance;REST/工具传输层注入,缺省 `'service'`);消费方无需关心(2026-08-14 M3 review 新增,`AuditRecord.caller` 三值可达);
- `install` 生效方式按包形态分派(§9.2),引擎运行模式见 `EngineSnapshot.mode`(§9.1)——两轴不混用;
- `dryRun: true` 只过质量门并返回预测(不落盘),与真实路径共用同一解析逻辑(不得另写一套);
- `profile?` 参数 v1 语义(M4 定案,2026-08-14):任意白名单 profile 名(`^[A-Za-z0-9._-]+$` ≤120,ADR-0007 §3)可管理;目录不存在 → `HOTPLUG.PROFILE.NOT_FOUND`;官方 profile(web/headless)中**非宿主**者 → `HOTPLUG.PROFILE.PROTECTED`(宿主 profile 恒可管理);**不可从宿主 profile 卸载引擎自身**(PROTECTED);非宿主 profile 的变更走**文件/restart 语义**(写 patch/manifest 等文件,`MutationResult.mode:'restart'` + `restartRequired:true`,目标 profile 下次启动生效;宿主 loader 观察窗口只适用于宿主 profile);

## 5. REST 契约(浏览器/外部同源)

前缀固定 `/api/dsh-hotplug`(`ctx.webServer.register` 注册,同源)。

| 方法 | 路径 | 请求体 | 返回 |
|---|---|---|---|
| GET | `/api/dsh-hotplug/snapshot?profile=` | — | `EngineSnapshot` |
| GET | `/api/dsh-hotplug/status?entryId=&profile=` | — | `RuntimeEntry \| null` |
| POST | `/api/dsh-hotplug/install` | `{ spec, profile?, dryRun? }` | `MutationResult` |
| POST | `/api/dsh-hotplug/uninstall` | `{ name, profile? }` | `MutationResult` |
| POST | `/api/dsh-hotplug/enable` | `{ entryId, profile? }` | `MutationResult` |
| POST | `/api/dsh-hotplug/disable` | `{ entryId, profile? }` | `MutationResult` |
| POST | `/api/dsh-hotplug/rollback` | `{ handle, profile? }` | `MutationResult` |
| GET | `/api/dsh-hotplug/audit?op=&from=&limit=` | — | `AuditRecord[]` |
| GET | `/api/dsh-hotplug/operations` | — | `OperationInfo[]` |
| GET | `/api/dsh-hotplug/events` | — | SSE(`EngineEvent` 帧) |

- 只读端点 GET 无需额外权限(同源即足够,2026-08-14 M3 复核:与官方 webServer loopback 围栏对称,**所有端点**均过同源校验,只读端点不追加其他门禁);
- 写端点(POST)MUST 校验同源;v1 不做 token 鉴权(见 ADR-0006),SHOULD 部署在可信网络内;
- **可选写端点 token 门禁(M5 H1,加法式 opt-in,2026-08-14)**:宿主可通过构造 options `restToken`(或环境变量 `DSH_HOTPLUG_REST_TOKEN` 经 index.ts 传入)启用;启用后 5 个写端点(POST install/uninstall/enable/disable/rollback)在通过同源校验后,MUST 再携带 `Authorization: Bearer <token>`(crypto.timingSafeEqual 常量时间比较),否则 403 `HOTPLUG.REST.FORBIDDEN`。**未配置时行为 = 现状(同源即可),v1 兼容不变**;只读 GET 不受 token 门禁影响。生产环境 SHOULD 配置 token(见 ADR-0006 更新);
- 错误返回:HTTP 200 + `MutationResult.ok=false`(业务错误)或 4xx(请求体非法/路径非法)。

## 6. agent 工具契约(`ctx.tools`)

| 工具名 | 参数 | 说明 |
|---|---|---|
| `hotplug_status` | `profile?`, `entryId?` | 只读快照/单行状态(模型面简洁摘要) |
| `hotplug_install` | `spec`, `profile?`, `dryRun?` | 安装(质量门/回滚/审计全走) |
| `hotplug_uninstall` | `name`, `profile?` | 卸载 + 联动清理 |
| `hotplug_toggle` | `entryId`, `enabled?`, `profile?` | 启停一行(`enabled` 缺省=当前态取反) |
| `hotplug_rollback` | `handle`, `profile?` | 按句柄回滚 |
| `hotplug_audit` | `op?`, `from?`, `limit?` | 只读审计查询 |

- 工具名 MUST 使用 `hotplug_*` 前缀(避免与社区 `plugin_*`(web-plugin-manager)冲突);
- 写工具 MUST 遵循现有审批策略(与沙箱/审批同源的门禁);
- 工具描述 MUST 注明:客户端新插件需刷新页面才加载;bundle 包安装需重启。

## 7. 事件契约

- SSE 端点 `/api/dsh-hotplug/events`,帧为 `EngineEvent` 的 JSON data 行(`data: {...}\n\n`);
- 订阅语义:连接即发当前 `snapshot` 帧;此后推送 `operation`(队列状态变化)与 `entry`(被管理条目 fiber phase 变化);
- 消费方(市场 UI)SHOULD 以事件刷新列表,以 `snapshot` 为最终一致源。

## 8. 错误模型

统一错误码 `<DOMAIN>.<SUBJECT>.<REASON>`:

| 码 | 场景 |
|---|---|
| `HOTPLUG.PROFILE.UNSAFE` | profile 名不合法(白名单正则/长度) |
| `HOTPLUG.PROFILE.PROTECTED` | 官方 profile / 自身宿主 profile 的受保护操作 |
| `HOTPLUG.PROFILE.NOT_FOUND` | profile 不存在 |
| `HOTPLUG.PATCH.INVALID` | 写后 patch 文件解析失败/结构非法 |
| `HOTPLUG.PATCH.UNSAFE_TARGET` | entryId 不可 patch 定位(随机 id)/含非法字符 |
| `HOTPLUG.PATCH.UNSAFE_VALUE` | 待写入值(包名等)不过白名单 |
| `HOTPLUG.GATE.REJECTED` | 质量门拒绝(附 detail:原因清单) |
| `HOTPLUG.HEALTH.FAILED` | 观察窗口/健康确认失败(激活失败/超时,已自动回滚)——2026-08-14 M1 review 新增,区别于 PATCH.INVALID |
| `HOTPLUG.PNPM_NOT_FOUND` | pnpm 未找到(PATH/corepack/常见位置均无,附搜索清单与安装指引;v0.1.4 新增) |
| `HOTPLUG.PNPM_NOT_EXECUTABLE` | pnpm 候选不可执行(shim/权限/ENOENT;v0.1.4 新增) |
| `HOTPLUG.PNPM_ADD_FAILED` | pnpm add 非零退出(保留退出码;v0.1.4 新增) |
| `HOTPLUG.INSTALL.FAILED` | 安装命令失败(附 exitCode/output;**保留为兼容码**,以新码为准、仅供兼容识别;v0.1.4 起细分至 PNPM_*) |
| `HOTPLUG.INSTALL.NOT_FOUND` | 安装后无法解析实际包名 |
| `HOTPLUG.ROLLBACK.NOT_FOUND` | 回滚句柄不存在/已消费 |
| `HOTPLUG.ROLLBACK.FAILED` | 回滚执行失败 |
| `HOTPLUG.ROLLBACK.INVALID` | 回滚句柄格式非法(非 op-<ts>-<seq>,M5 H2 路径穿越防线;2026-08-14 M5 新增) |
| `HOTPLUG.OP.CONFLICT` | 串行队列冲突(理论上不发生,防御) |
| `HOTPLUG.OP.INTERRUPTED` | 启动对账:未完结操作被重启打断(2026-08-14 M2 review 新增) |
| `HOTPLUG.SPEC.UNSAFE` | install spec 含命令注入元字符(2026-08-14 M2 review 新增) |
| `HOTPLUG.HMR.UNAVAILABLE` | 降级判定:hmr 服务不可用(模式=restart)。**保留码**:当前引擎以 `EngineSnapshot.mode` 表达降级,M3 REST/工具面按需使用 |
| `HOTPLUG.REST.INVALID_BODY` | 请求体非法/缺必填字段/参数非法(4xx;2026-08-14 M3 新增,REST 传输层) |
| `HOTPLUG.REST.FORBIDDEN` | 写端点同源校验失败,或配置 token 后 Bearer 缺失/不匹配(403;2026-08-14 M3 新增,M5 扩展) |
| `HOTPLUG.REST.METHOD_NOT_ALLOWED` | 方法不匹配(405;2026-08-14 M3 新增) |
| `HOTPLUG.REST.INTERNAL` | REST 处理器意外异常(500;防御性;2026-08-14 M3 新增) |

## 9. 模式:引擎运行模式 vs 单次生效方式(两轴分离)

> 修复说明(2026-08-14 双 review):`MutationResult.mode` 只表示**本次操作的生效方式**;引擎运行模式是引擎级状态,由 `EngineSnapshot.mode` 暴露——**两轴不混用**。

### 9.1 引擎运行模式(`EngineSnapshot.mode`,引擎级)
- `'hot'` = 配置热应用可用(写 patch 行后 loader 实时重挂);`'restart'` = 变更只落盘、需重启生效(引擎仍按契约执行);
- 引擎运行模式是引擎级状态,由 `EngineSnapshot.mode` 暴露;MUST NOT 写入 `MutationResult.mode`;
- **判定方式(经验判定,v0.1.5 修订)**:不再静态探测 `ctx.get('hmr')`(v0.1.4 验收 P2-2 证实其假阴性——它测的是模块级 HMR 插件,与「配置热应用/重挂」是两条独立机制)。改为懒更新:服务初始 `'restart'`,首次写操作观察窗口确认目标行被 loader 挂载后置 `'hot'` 并保持(见 ADR-0007 修订)。

### 9.2 单次操作生效方式(`MutationResult.mode`,操作级)
- 只表示**本次变更**如何生效,由包形态与**观察结果**共同决定(经验判定,v0.1.5 修订):
  - 目标包声明 `dsh.bundle` → 写 `dsh.profile.bundles` → `mode:'restart'` + `restartRequired:true`(任何引擎模式下);
  - 目标包不声明 `dsh.bundle` → pnpm 装依赖 + managed insert 行 → 观察窗口内目标行被 loader 挂载且 `active` → `mode:'hot'`;行**从未挂载** → **仍写 insert 行**但 `mode:'restart'` + `restartRequired:true`(重启后由 patch 层加载生效——与机制一致:HMR 只省重启,不改变 boot 消费 insert 行的事实);
  - enable/disable(patch 行写)→ 行挂载 `active`(enable)/ 卸载 `gone`(disable)→ `mode:'hot'`;行未反映(enable 从未挂载 / disable 仍 active)→ `mode:'restart'` + `restartRequired:true`(保留写入、下次启动生效);
- 两种路径都 MUST 过质量门、in-box bundles 保护、卸载联动清理;「未反映」结果 MUST 附警示(未在 loader 生效,可能 restart 环境或 loader 拒绝,重启后核对);
- 客户端新插件:任何模式下,`MutationResult` MUST 携带「新客户端 bundle 需刷新页面」提示。

## 10. 版本与兼容

- 本契约 v1 冻结于**全量首版实现(M1–M4 完成)并经双 subagent review 通过**;v1 内新增能力 MUST 向后兼容(旧消费方忽略新字段);
- 官方内核(preview)行为变化时:先更新设计审计笔记(私有,未随仓库发布)依据,再评估契约影响;契约语义变化 → 升 v2;
- 契约文档为本仓库 `docs/01-contract.md`(本文件);类型实现派生文件 MUST 与本文件一致(不一致时以本文件为权威,先改本文件)。

---

*✅ 本契约已冻结 v1(2026-08-14):全量实现(M1–M4)+ 双 subagent review 通过。后续变更:v1 内新增能力 MUST 向后兼容;语义变化 → 升 v2。*
