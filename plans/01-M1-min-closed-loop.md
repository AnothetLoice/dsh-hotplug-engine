# M1 详细计划 — 最小闭环(enable/disable/rollback)

> 计划编号:`hotplug-engine-PLAN-01` | 里程碑:M1 | 目标:patch 安全写入 + 启停 + 回滚端到端可用
> 上位约束:02-design §2(写入层)/§3.6(profile 定位)/§5(备份回滚)/§8(队列);01-contract §4 的 enable/disable/rollback/snapshot/status

---

## 1. 目标与范围

**做**:
- 项目骨架(bundle 双面声明 + 双 tsconfig + tsdown + vitest + 自身 cordis.patch.yml);
- `src/contract/types.ts`(契约类型派生,单一来源);
- 写入层 patch.ts(managed block / npm 规范白名单 / 原子写 / YAML 陷阱 / slugify 碰撞);
- manifest.ts(profile manifest 读写 + in-box 保护 + 原子写);
- queue.ts(串行 promise 链 + operationId + CONFLICT 去重);
- backup.ts(备份 / 回滚句柄 / 路径 A/B 按块恢复);
- health.ts **最小版**(观察窗口轮询,供 enable/disable 确认);
- service.ts **最小面**(snapshot / status / enable / disable / rollback / listOperations / onEvent + init 启动对账基础);
- host 入口 index.ts(注册 `hotplugEngine` 服务;**不注册 REST/tools/UI,M3 做**)。

**不做(边界)**:
- install/uninstall(M2);REST/SSE/工具/UI(M3);多 profile 与降级完整验证(M4);
- 不实现任何官方机制(热应用/图/patch 语义/loader)。

## 2. 前置条件

1. 01-contract.md / 02-design.md / adr/ 已定稿(2026-08-14 已过双 review);
2. 演练夹具就绪:`harness-research/hotplug-drill/`(非 bundle 双面插件,供 e2e);
3. pnpm 可用(`harness-research\.tools\bin\pnpm.cmd`);Node ^22.19。

## 3. 任务拆分(文件级)

| # | 任务 | 产出 | 说明 | 依赖 |
|---|---|---|---|---|
| T1.0 | 项目骨架 | `package.json`、`tsconfig.host.json`、`tsconfig.client.json`、`tsdown.config.ts`、`tsdown.client.config.ts`、`vitest.config.ts`、`cordis.patch.yml`、`.gitignore`、`LICENSE`、`README.md`(stub) | 参照 02-design §7 声明;自身行 id `hotplug-engine` | — |
| T1.1 | 契约类型 | `src/contract/types.ts` | 由 01-contract §3 派生:全类型 + 错误码常量(`HOTPLUG.*`);导出供消费方 | T1.0 |
| T1.2 | 写入层 | `src/host/patch.ts` | managed block 读写(行级解析)/ npm 规范白名单 / 原子写 tmp+rename / 写后 YAML 校验 / `[]` 空文档与注释-only 陷阱 / `@` 引号 / 禁 `!!js` / slugify + 碰撞短哈希 | T1.1 |
| T1.3 | manifest | `src/host/manifest.ts` | 读 profile package.json(bundles/deps);写 bundles(追加/摘除)+ in-box 保护;原子写;profileDir 解析与自身宿主探测(02-design §3.6) | T1.1 |
| T1.4 | 备份/回滚 | `src/host/backup.ts` | `$DSH_HOME/backups/hotplug-engine/`;操作前快照(patch+manifest);回滚句柄;恢复路径 A(整文件)/ B(按块摘除 + 并发告警) | T1.2, T1.3 |
| T1.5 | 串行队列 | `src/host/queue.ts` | 单例 promise 链;operationId(UUIDv7/`op-ts-seq`);同 op+target 在队 → CONFLICT | T1.1 |
| T1.6 | 观察窗口(最小) | `src/host/health.ts` | 轮询 loader 树目标行 phase;active 成功 / failed 回滚 / 超时回滚;全行对账(同块邻行 failed 视为失败) | T1.1 |
| T1.7 | 服务最小面 | `src/host/service.ts` | `HotplugEngineService extends Service`:snapshot/status/enable/disable/rollback/listOperations/onEvent;init 启动对账基础(未完结操作标记) | T1.2-T1.6 |
| T1.8 | 插件入口 | `src/host/index.ts` | name/inject/apply;注册服务;`inject: ['webServer','loader','tools']`(tools 可选) | T1.7 |
| T1.9 | 测试 | `tests/`(见 §5) | 全陷阱/全路径/集成 | T1.2-T1.8 |

## 4. 实施顺序

1. T1.0 骨架 → `pnpm typecheck`/`pnpm build` 空跑通过;
2. T1.1 types → T1.2 patch(核心,先写测试再实现或 TDD 并行);
3. T1.3 manifest → T1.4 backup → T1.5 queue → T1.6 health;
4. T1.7 service 组装 → T1.8 入口;
5. T1.9 测试全绿 → 实机验收(§6 A1.10)→ 回填实测记录。

## 5. 测试设计(本里程碑新增)

| 层 | 用例 | 夹具 | 路径要求 |
|---|---|---|---|
| patch 单元 | 追加/摘除/原位刷新 managed block;空文档 `[]` 双文档;`@` 前缀引号;注释-only → null 恢复模板;`!!js` 禁入;恶意包名(含 `'`/`:` 注入样本)拒;slugify 碰撞加哈希;幂等(重复写同 id);原子写读回比对;写后 YAML 校验失败恢复备份 | 真实临时文件 | 真实解析路径,不直调内部函数 |
| manifest 单元 | bundles 追加/摘除;in-box 保护(装/卸后 base/web-app/headless 原位);原子写;profileDir 非法名拒 | 真实临时 profile 目录 | 真实文件 |
| queue 单元 | 串行性(乱序入队按序执行);CONFLICT 去重;operationId 唯一 | 内存 | — |
| backup 单元 | 路径 A 整文件恢复;路径 B(hash 不匹配)仅摘块 + 告警;句柄不存在 → ROLLBACK.NOT_FOUND | 真实临时文件 | 真实文件 |
| health 集成 | 目标行 active/failed/超时三分支;全行对账(目标 active 邻行 failed → 失败) | 注入假 loader 树 | 真实轮询循环 |
| service 集成 | enable/disable 在真实 cordis 上下文 + 假 loader 下 `ok:true`=已应用(含观察窗口);rollback 后行状态复原;listOperations 追踪 | 注入 cordis + 假 loader | 生产路径 |
| e2e | 实机:引擎装入演练 profile → 对既有行(如 `ui-task-board`)disable→enable→rollback,profile 复原;3080 观测 | 演练 profile(web 或临时) | 实机,验证后清理 |

## 6. 验收条件(M1 完成判定,逐项 MUST 满足)

- [ ] A1.1 `pnpm typecheck` 零错误(host+client 双 Program);✅ 2026-08-14 通过;
- [ ] A1.2 `pnpm build` 产出 `lib/index.js` + `lib/client.js`(client 可为最小占位);
- [ ] A1.3 `pnpm test` 全绿(§5 全部用例,含安全与陷阱用例);
- [ ] A1.4 patch.ts 行为与 02-design §2 逐条一致(白名单/陷阱/原子写/禁 `!!js`);
- [ ] A1.5 manifest in-box 保护与 profileDir 安全(非法名拒)单测通过;
- [ ] A1.6 queue 串行 + CONFLICT 语义符合 02-design §8;
- [ ] A1.7 backup 路径 A/B 与启动对账基础行为正确(ADR-0003);
- [ ] A1.8 service 的 `ok:true` 语义 = 已应用(含观察窗口确认),非"已入队"(01-contract §4);
- [ ] A1.9 演练级集成验证通过(2026-08-14 实测:临时 profile + 真实 cordis Context + 假 loader 模拟 HMR 重放,enable/disable/rollback 对 user/insert/bundle 三类行生效且 patch 复原,61/61 测试全绿);**真实 3080 宿主端到端验证依赖引擎对外通道(REST, M3)与服务重启,标记为 M3 验收项(本里程碑受限)**;
- [ ] A1.10 实测发现(如有)已回填 `harness-research/hotplug-dev-audit.md`;
- [ ] A1.11 未实现项未越界(无 install/REST/UI/官方机制重写)。

## 7. Review 记录(2026-08-14 M1 代码双 review)

| 视角 | 结论 | 修复 |
|---|---|---|
| 架构 | **有条件通过**(3 major + 1 Windows major + 若干 minor) | 已修复:模式两轴 + restartRequired(契约 §9.2)、managed-insert disable↔enable 往返(kind-aware 块操作)、嵌套 `disabled` 误伤(2 空格直接子级正则)、Windows rename 重试、`HEALTH_FAILED` 错误码、`rolled-back` 操作状态、rollback operationId、`ensureUniqueRowId` 截断、死分支清理 |
| 一致性 | **基本一致需修正**(0 blocker / 4 major / 7 minor) | 已修复:全行对账 `waitForHealthWithBlock` 接入 enable + 邻行失败用例、用户行路径 B 行级撤销、契约类型经 `lib/index.js` re-export、`!!js` 禁入与 listOperations 测试补全 |

**已记录(推迟/接受)**:读方法(snapshot/status)同步抛 EngineError(文档化,M3 REST 包装);client types 与实际 bundle 语义差异(M3 UI 时修正);`detectHostProfile` 判定过宽与 `'web'` 缺省(M4 多 profile 收紧);健康轮询无取消生命周期(单操作 ≤8s,可接受);崩溃对账完整版(M2 T2.5);`phaseOf` state 4→null 映射(机制事实,web-plugin-manager 同款)。

## 8. 风险与回退

- **hmr 探测服务名未核实**:M1 若需 `mode` 探测先按 `ctx.get('hmr')` 实现并打日志,M2 前实机核对修正;
- **Windows spawn**:M1 暂不 spawn pnpm(无 install),策略在 T1.0 骨架中预置常量,验证在 M2;
- **观察窗口在测试环境抖动**:测试用短窗口(如 200ms)注入,默认值仍 8s;
- 任一验收不过:按 AGENTS.md 修复规则(先定位根因,可走 diagnose;代码修复后双 review)。
