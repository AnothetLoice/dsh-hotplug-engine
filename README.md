# dsh-hotplug-engine

DSH 热插拔执行引擎(执行层,非市场)。把「安装→注册→应用→回滚→审计」热插拔执行链做成**任何市场 / agent / 宿主插件都能调用的可靠服务**。

- **定位**:执行层 vs 发现层分工——市场做目录/发现/策展,引擎做可靠安装/启停/回滚/审计;不拥有目录、不做市场功能。
- **机制**:只消费官方机制(配置 HMR / loader / 客户端图 / webServer / tools / 审批),绝不重写;状态唯一真源 = 官方组合树/loader 树,引擎只做投影与差分。
- **文档**:设计/契约/决策见 `docs/`(`01-contract.md` 为契约 v1 权威);实施计划见 `plans/`。

> 状态:**契约 v1 已冻结(2026-08-14)**——M1–M4 全量实现完成并经双 subagent review 通过(166/166 测试全绿、typecheck 零错误、发布包实机验证通过)。后续能力新增 MUST 向后兼容;语义变化升 v2。

---

## 安装

通过 npm 安装到目标 profile(这是 `dsh.bundle` 包,安装/卸载后需重启 profile 生效):

```bash
pnpm --dir <profile-dir> add dsh-hotplug-engine
```

或经官方插件通道 `dsh plugin add dsh-hotplug-engine`。安装后:新客户端 bundle 需刷新页面才加载。

---

## 消费方接入指南(三条路径)

### 1. host 插件注入(进程内,最强)

```ts
import { Context } from '@deepseek-ai/cordis'

export const inject = ['hotplugEngine']

export function apply(ctx: Context): void {
  const engine = ctx.hotplugEngine
  const snap = engine.snapshot()                    // 状态投影(同步)
  const r = await engine.enable('row-a')            // 写操作:resolve 时已完成(ok=true=已应用)
  const records = engine.audit({ op: 'enable' })    // 审计查询
  const off = engine.onEvent(e => { /* operation/entry 事件 */ })
}
```

- 写方法(`install/uninstall/enable/disable/rollback`)MUST 经全局串行队列执行,resolve 时操作已完成;`MutationResult.mode` 表示**本次操作**生效方式(`'hot'` 实时 / `'restart'` 需重启),引擎运行模式见 `EngineSnapshot.mode`(两轴分离,契约 §9)。
- 全部幂等;写操作前备份、后审计;失败自动回滚(观察窗口确认失败)。

### 2. 浏览器市场 / 外部工具(REST,同源)

前缀固定 `/api/dsh-hotplug`(`ctx.webServer.register` 注册,同源;v1 无 token,部署在可信网络):

| 方法 | 路径 | 请求体 | 返回 |
|---|---|---|---|
| GET | `/api/dsh-hotplug/snapshot?profile=` | — | `EngineSnapshot`(含 `auditLag?`) |
| GET | `/api/dsh-hotplug/status?entryId=&profile=` | — | `RuntimeEntry \| null` |
| POST | `/api/dsh-hotplug/install` | `{ spec, profile?, dryRun? }` | `MutationResult` |
| POST | `/api/dsh-hotplug/uninstall` | `{ name, profile? }` | `MutationResult` |
| POST | `/api/dsh-hotplug/enable` | `{ entryId, profile? }` | `MutationResult` |
| POST | `/api/dsh-hotplug/disable` | `{ entryId, profile? }` | `MutationResult` |
| POST | `/api/dsh-hotplug/rollback` | `{ handle, profile? }` | `MutationResult` |
| GET | `/api/dsh-hotplug/audit?op=&from=&limit=` | — | `AuditRecord[]` |
| GET | `/api/dsh-hotplug/operations` | — | `OperationInfo[]` |
| GET | `/api/dsh-hotplug/events` | — | SSE(`EngineEvent` 帧,连接即发 snapshot) |

```bash
curl -X POST http://127.0.0.1:3080/api/dsh-hotplug/enable \
  -H 'content-type: application/json' -d '{"entryId":"ui-task-board"}'
# → {"ok":true,"message":"enable ui-task-board succeeded (hot)","mode":"hot",...}
```

- 所有端点(含只读 GET)过同源校验(loopback peer + Host + Origin);业务错误 → HTTP 200 + `ok:false`;请求体非法 → 4xx。
- SSE 消费准则:连接即发 snapshot 帧;此后 operation/entry 帧;**以 snapshot 为最终一致源**(事件仅增量刷新)。
- **提示**:新客户端插件需刷新页面才加载;bundle 包(dsh.bundle)安装/卸载需重启后生效。

### 3. agent 工具(会话内驱动)

| 工具 | 参数 | 说明 |
|---|---|---|
| `hotplug_status` | `profile?`, `entryId?` | 只读快照/单行状态 |
| `hotplug_install` | `spec`, `profile?`, `dryRun?` | 安装(质量门/回滚/审计全走) |
| `hotplug_uninstall` | `name`, `profile?` | 卸载 + 联动清理 |
| `hotplug_toggle` | `entryId`, `enabled?`, `profile?` | 启停一行(`enabled` 缺省=当前态取反) |
| `hotplug_rollback` | `handle`, `profile?` | 按句柄回滚 |
| `hotplug_audit` | `op?`, `from?`, `limit?` | 只读审计查询 |

- 写工具 MUST 遵循现有审批策略(经 `tools/pre-execute` → `ask` → 部署的审批策略,无审批服务时 fail-closed)。
- `spec` 为不透明安装源(npm 包名 / path / git URL)——**由市场解析后传入**,引擎不猜来源。

---

## profile 语义(v1)

- 任意白名单 profile 名(`^[A-Za-z0-9._-]+$` ≤120)可管理;目录不存在 → `HOTPLUG.PROFILE.NOT_FOUND`。
- 官方 profile(web/headless)中**非宿主**者 → `HOTPLUG.PROFILE.PROTECTED`;宿主 profile 恒可管理;不可从宿主 profile 卸载引擎自身。
- **非宿主 profile 变更 = 文件/restart 语义**:写目标 profile 的 patch/manifest 等文件,`mode:'restart'` + `restartRequired:true`(目标下次启动生效),不经宿主 loader 观察窗口;非宿主 snapshot 为文件级投影(`fiberPhase:null`)。

## 安全边界

- patch 文件 = 可执行代码面(`!!js`):引擎写行白名单化、不回显不可信内容。
- 安装先过质量门(import 对账/入口/客户端 bundle);热挂后健康确认;失败自动回滚。
- 审计 JSONL(可回滚、可审计、幂等、串行);审计写失败暴露 `auditLag` 指示。
- 降级:无 HMR → `mode:'restart'`(契约不变,重启生效)。

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit(host + client)
pnpm test        # vitest
pnpm build       # host lib + client bundle
```

## License

MIT(见 `LICENSE`)
