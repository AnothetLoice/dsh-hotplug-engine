# 验收交接 — dsh-hotplug-engine v0.1.4 实机验收

> 文档编号:`hotplug-engine-ACCEPT-05` | 性质:实机验收 + 交接 | 版本:0.1(2026-08-16)
> 上位约束:`00-index.md` / `01-contract.md`(契约 v1 权威);`03-optimization-directions.md`(v0.1.4 方向)

## 1. 验收概况

| 项 | 值 |
|---|---|
| 验收对象 | dsh-hotplug-engine **v0.1.4**(实机 web profile,3080 在线) |
| 验收方式 | 仅 `hotplug_*` 工具驱动 + 只读源码/审计日志核验;**未修改任何源码** |
| 执行时间 | 2026-08-16(两轮:首轮跑在 0.1.3,升级 0.1.4 后复测) |
| 版本核对 | 运行实例 `node_modules\dsh-hotplug-engine\package.json` = **0.1.4**;profile 依赖 `file:...dsh-hotplug-engine-0.1.4.tgz`;仓库根目录已含 0.1.4 tarball |
| 审批 | 6 个写操作(install×2、toggle×2、rollback、uninstall 等)全部经审批流放行,无挂起项 |
| 环境终态 | 已恢复基线:patch 仅剩 maid-atelier 禁用块;package.json 无测试残留;`node_modules/is-number` 实体残留(见 §4 P2-3) |

## 2. 逐项验收结论(0–5)

| # | 项目 | 结果 | 关键返回摘录 |
|---|---|---|---|
| 0 | 基线 | **FAIL(工具不可用)** | `hotplug_status` 全量与单条查询均报 schema 校验错误:`"value.snapshot" must match exactly one oneOf branch (matched 0)` / `"value.entry" ... (matched 0)`。服务层已计算 `installedAt`(package.json mtime)与 `critical`(CORE_PLUGINS 列表),但工具输出 schema 未同步声明(additionalProperties:false)→ 基线字段无法经工具核对(见 §4 P0-1) |
| 1 | 安装(非 bundle) | **PASS** | `ok: install is-number succeeded (restart) [restart required]`;patch 写入 managed insert 块(`- insert: - id: is-number`);package.json 追加 `"is-number": "^7.0.0"`;审计 `install \| succeeded \| tool` |
| 2 | 启停(patch 条目) | **PASS** | disable → `ok: disable ui-task-board succeeded (restart) [restart required]`,patch 追加 `- id: ui-task-board / disabled: true` 块;enable → 块完整移除(patch 12→16→12 行往返);审计 disable/enable 均 succeeded |
| 3 | 回滚 | **PASS(0.1.3 缺陷已修复)** | `ok: rollback op-1786852047946-1 succeeded (restore) [restart required]`;patch insert 块移除、package.json 依赖移除、审计 `rollback \| succeeded`。**对照:0.1.3 同场景 FAIL**(manifest 恢复 ENOENT,半完成回滚,见 §3 回归) |
| 4 | 审计 | **PASS(render 受限)** | install/toggle/rollback/失败 install 全部记录(op/result/caller/errorCode);JSONL 含 operationId/patch hash/backupPath;但 render 无 operationId/spec 列(见 §4 P2-1) |
| 5 | 错误码 | **服务端 PASS / 工具面 FAIL** | 审计侧细分码生效:`HOTPLUG.GATE.REJECTED`(坏路径,质量门)、`HOTPLUG.PNPM_ADD_FAILED`(不存在包名,pnpm 失败,result=rolled-back 自动回滚);**但失败路径工具调用被 schema 校验错误顶掉**(`"value.errors[0].stage" is not a declared property`),错误详情到不了调用方(见 §4 P0-2) |

## 3. 回归对照(0.1.3 → 0.1.4)

| 特性 | 0.1.3(首轮实测) | 0.1.4(复测) |
|---|---|---|
| 回滚 manifest 恢复 | **FAIL**:`ENOENT ...profiles\web\package.json\package.json.<pid>.<hex>.tmp`;backup.js 将 `handle.manifestPath` 直接传入 `writeManifestAtomic`(内部再 join 'package.json'),patch 恢复成功但 manifest 未恢复,残留 is-number 依赖 | **PASS**:`succeeded (restore)`;`dirname(handle.manifestPath)` 修复生效,manifest+patch 双恢复 |
| PNPM_* 细分错误码 | 无(仅旧码) | 服务端有(审计可证);工具 schema 未同步 → 工具面不可达 |
| installedAt / critical | 无 | 服务端计算;工具 schema 未同步 → 工具面不可见 |
| errors[].stage | 无 | 契约/服务端有;工具 schema 未声明 → 失败路径工具全炸 |

## 4. 问题清单(严重度分级)

### P0(阻断工具面,建议立即修)
- **P0-1 `hotplug_status` 在 v0.1.4 全挂**:服务层 `snapshot()` 新增 `critical`(entry)与 `installedAt`(package),但 `src/host/tools.ts` 输出 schema(`runtimeEntrySchema`/packages items)未同步,`additionalProperties: false` 使全量快照与单条查询全部校验失败。影响:基线核对、启用态查询、phase 观察全部不可用。
  建议:`tools.ts` schema 补 `critical`/`installedAt`(并核对 `auditLag` 等已声明字段),render 增列;加工具输出回归测试(全量+单条+失败路径)。
- **P0-2 失败路径工具全炸**:`failureResult()` 为 `errors[]` 附加 `stage`(gate/install/observe),`mutationResultSchema` errors items 仅声明 code/detail 且 additionalProperties:false → 任何带 errors 的返回(质量门拒绝、pnpm 失败、回滚失败)使工具调用直接报 `"value.errors[0].stage" is not a declared property`,**真实错误信息被吞**。实测两次失败 install 均如此(双码场景报 errors[0]/errors[1] 两处)。
  建议:errors items schema 补 `stage`(契约 `contract/types.ts` 本就有),并让 render 输出 message + errors[].code/detail;补失败路径工具回归测试。

### P1(可用性缺口)
- **P1-1 回滚句柄无法从工具输出获取**:install render 只打 message,不显示 `rollbackHandle`/`operationId`;audit render 无 operationId 列。agent 只能读 `$DSH_HOME/logs/hotplug-engine/*.jsonl` 取 operationId。建议:install render 补 rollbackHandle 行,audit 增 operationId 列。
- **P1-2 启动对账中断审计跨重启不幂等**:`startupReconcile()` 对**无 `patchAfterHash`** 的 sidecar 每次启动都补记一条 `HOTPLUG.OP_INTERRUPTED`(service)。实测 08-16 00:50/00:53 两条失败 install 的 sidecar 未收尾,重装后 3 次启动累计 5 条噪声记录(03:37/03:38×2/03:44×2)。建议:sidecar 完成后删除或标记 finalized,按 operationId 去重。

### P2(观察项/提示)
- **P2-1 audit render 信息不全**:install 成功记录 target 显示 `-`(spec 在字段里未打印);rollback 失败时 errorCode 为 `-`(非 EngineError 如 ENOENT 无码)。
- **P2-2 mode=restart 与热应用矛盾**:写操作消息均带 `[restart required]`,但 0.1.3 轮实测 insert/disabled 行立即 phase=active/none(热应用已生效);0.1.4 轮因 P0-1 无法复核 phase。建议校准 mode 判定与提示语。
- **P2-3 回滚残留 node_modules 实体**:回滚恢复 manifest+patch 但不跑 `pnpm remove`,`node_modules/is-number` 目录残留(下次 pnpm install 修剪)。manifest 为准属契约内行为,提示即可。

## 5. 未验证项(受 P0-1 或范围所限)

- `hotplug_status` 相关全部:installedAt/critical 字段值、phase 热应用行为、critical 停用告警。
- bundle 形态包安装(client 刷新/重启提示路径)——本轮仅测非 bundle。
- REST 面(`/api/dsh-hotplug/*`)与 SSE 事件——本轮仅工具面。

## 6. 环境与证据位置

| 项 | 路径 |
|---|---|
| 运行实例 | `C:\Users\Anothet Loice\.dsh\profiles\web\node_modules\dsh-hotplug-engine`(v0.1.4) |
| profile 依赖 | `C:\Users\Anothet Loice\.dsh\profiles\web\package.json`(`file:...dsh-hotplug-engine-0.1.4.tgz`) |
| 审计 JSONL | `C:\Users\Anothet Loice\.dsh\logs\hotplug-engine\2026-08-16.jsonl`(op/operationId/hash/backupPath 完整) |
| 备份/回滚句柄 | `C:\Users\Anothet Loice\.dsh\backups\hotplug-engine\`(sidecar `op-*.json`) |
| patch 文件 | `C:\Users\Anothet Loice\.dsh\profiles\web\cordis.patch.yml`(测试后仅 maid-atelier 禁用块) |
| 本轮关键 operationId | install `op-1786852047946-1` / disable `op-1786852059196-2` / enable `op-1786852067515-3` / rollback `op-1786852114418-4` / 坏路径 `op-1786852128322-5` |

## 7. 交接建议

1. **修 P0-1/P0-2**(工具 schema 与服务契约同步 + 失败路径回归测试)后,重跑 §2 全表——当前工具面 0/5/状态类不可用。
2. **P1-1** 涉及工具 render 契约,按仓库变更流程(先 `01-contract.md` 再 `src/contract/types.ts`)评估是否 v0.1.5 纳入。
3. **P1-2** sidecar 收尾(完成即删/标记),避免每次重启审计噪声。
4. 复测时建议同时覆盖:bundle 包安装、REST 面、critical 停用告警、phase 热应用(需 P0-1 修复后)。
5. 本轮环境已恢复基线;`node_modules/is-number` 实体残留可 `pnpm --dir <profile> install` 修剪或忽略。

## 8. 复测记录(2026-08-16 修复后,仍为 v0.1.4)

> 开发侧修复后重新打包部署(运行实例仍 0.1.4;部署版 `lib/host/tools.js` 已同步契约:schema 补 `critical`/`installedAt`/`stage`,render 补 `operationId`/`rollbackHandle`/audit 列)。0–5 全项重测。

| # | 项目 | 复测结果 | 关键返回摘录 |
|---|---|---|---|
| 0 | 基线 | **PASS(残留小缺口)** | `hotplug_status` 恢复正常;`mode=restart`;`(critical)` 标记可见(llm/session/agent/approval/tools/web-runtime 6 项);**installedAt 通过 schema 校验但仍未在 render 列出**(packages 仅显示计数) |
| 1 | 安装 | **PASS** | `ok: install is-number succeeded (restart) [restart required]` + `operationId: op-1786853754828-1` / `rollbackHandle: ...` / `installed: is-number` |
| 2 | 启停 | **PASS** | status 可查:`enabled=false phase=none`(停)→ `enabled=true phase=active`(启) |
| 3 | 回滚 | **PASS** | `ok: rollback op-1786853754828-1 succeeded (restore)`;patch/package.json 双恢复;句柄直接来自 install render |
| 4 | 审计 | **PASS** | render 新增 `operationId`/`spec` 列,全部记录可对 |
| 5 | 错误码 | **PASS** | 坏路径:`error[HOTPLUG.GATE.REJECTED](gate): ...`(stage 可见);不存在包名:双码 `error[HOTPLUG.PNPM_ADD_FAILED](install)` + `error[HOTPLUG.INSTALL.FAILED](install)` + pnpm 完整输出 |

**修复确认**:P0-1 ✅(status schema/render 同步 critical/installedAt)、P0-2 ✅(errors[].stage 声明 + render 输出)、P1-1 ✅(install render 与 audit 列)。

**仍未修复/残留**:
- **P1-2(启动对账不幂等)未修复**:本次重启(04:02:59)再次把 3 条旧失败 sidecar 补记为 `HOTPLUG.OP.INTERRUPTED`(op-...-1/op-...-2/op-...-6);本轮新失败 install(op-1786853809732-6)的 sidecar 同样未收尾,下次重启仍会再记。
- **P2-2(mode=restart 与热应用矛盾)复现**:is-number insert 行消息提示 restart required,但立即 `phase=active`。
- **P2-3**:`node_modules/is-number` 实体残留依旧(回滚不跑 pnpm remove)。
- **审计语义小不一致(新观察)**:install 成功记录 spec 走 `spec` 列(target=`-`),失败记录 spec 走 `target` 列(spec=`-`)——同一字段两个落点。
- **installedAt render 缺口**:schema 已接受但 status render 不列出包明细(仅 `packages: N bundles=M`)。

**基线变化(新观察)**:重装重启后 `task-dag dsh-task-dag [bundle]` 开始加载(entries 171→172),属 bundle 层重启生效,非缺陷。

### 开发侧修复记录(第二轮,2026-08-16,待重部署复测)

> 针对上轮「仍未修复/残留」的开发侧处置:P1-2 根治 + 2 处 P2 顺手补;typecheck 双面 0 错误;`pnpm test` 待用户 admin 环境跑(沙箱 esbuild spawn EPERM)。

| 项 | 处置 | 状态 |
|---|---|---|
| **P1-2 启动对账不幂等** | **根因**:失败操作(rolled-back)从不 `finalizeBackup` 也不删 sidecar → sidecar 的 `patchAfterHash` 恒 `undefined` → 每次重启被当「中断」补记 `OP_INTERRUPTED`;已部署的 `interruptedIds` 去重只是止血(挡第二次起),第一次回滚后重启仍记一条假中断。**根治**:`backup.ts` 新增 `deleteSidecar()`,在 `rollbackByHandle` 三条成功 return(Path A restore / Path B 块级 / 行级)前删除 sidecar——回滚成功即终态,不再被补记;重复回滚自然得 `ROLLBACK_NOT_FOUND` | ✅ 已修(待部署) |
| 审计语义不一致 | install 失败记录 spec 走 `target` 列(成功走 `spec` 列)。`service.ts` `failWithRollback` 对 `op==='install'` 将 spec 落 `spec` 列、`target=undefined`,与成功路径一致 | ✅ 已修 |
| installedAt render 缺口 | `tools.ts` snapshot render 逐条列出包明细 `name v<version> [bundle] installedAt=…` | ✅ 已修 |
| **P2-2 mode=restart 与热应用矛盾** | 见 `docs/02-design.md` §9.3(探测测错对象 + 推荐 empirical mode detection) | ⏳ 待 v0.1.5 设计决策 |
| P2-3 node_modules 残留 | 契约内行为(manifest 为准),非缺陷 | 提示即可,不改 |

**复测判据(P1-2)**:重部署后触发一次失败 install(不存在包名)+ 自动回滚,确认该 op 的 sidecar 被删除、重启后审计不再新增 `OP_INTERRUPTED`;遗留 3 个旧 sidecar(op-…-1/2/6)可手动删或由去重抑制。

---

*验收执行:agent 实测(仅 hotplug_* 工具 + 只读核验),未改源码;问题清单待开发侧确认修复范围。*
