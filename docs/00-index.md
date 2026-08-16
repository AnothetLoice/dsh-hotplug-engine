# 文档索引 — dsh-hotplug-engine

> 文档编号:`hotplug-engine-INDEX-00` | 性质:索引 + 决策总览 | 版本:0.1(2026-08-14)
> 上位约束:AGENTS.md(文档层级);设计基线(私有工作笔记,未随仓库发布)

## 1. 文档清单

| 文档 | 性质 | 内容 |
|---|---|---|
| `AGENTS.md` | 项目守则 | 红线/原则/推进流程/经验沉淀/防线(供 agent 工具) |
| `01-contract.md` | **契约(权威)** | 服务身份、类型定义、方法/REST/工具/事件契约、错误模型、降级模式、版本化 |
| `02-design.md` | 详细设计 | 模块布局、写入层规范、安装/回滚流程、质量门、观察窗口、审计、并发、构建、测试、M1-M4 实施顺序 |
| `03-optimization-directions.md` | **优化方向(非契约/非计划)** | 引擎基础 A–D(pnpm 定位/Windows 可执行性/bundle 热加载编排/错误诊断)+ 看板 UI E–H(搜索/排序/状态色彩/高危停用警告);验收标准与计划制定指引;实施计划见 `plans/06-M6-optimization.md`(v0.1.4) |
| `04-dynamic-assembly-eval.md` | 评估文档(v2 候选) | 动态服务装配评估:纯客户端 bundle 免重启可行性,结论"不升 v2"(v0.1.4 方向 C) |
| `adr/ADR-0001-package-shape.md` | 决策记录 | 包形态与挂载(bundle 双面) |
| `adr/ADR-0002-service-identity.md` | 决策记录 | 服务身份与契约版本化(ctx.hotplugEngine, v1 只增不改) |
| `adr/ADR-0003-operation-model.md` | 决策记录 | 操作模型(串行队列 + 观察窗口自动回滚 + 按块回滚 + 启动对账) |
| `adr/ADR-0004-managed-block.md` | 决策记录 | 写入层契约(owner managed block + npm 命名规范白名单 + 原子写 + 禁 !!js) |
| `adr/ADR-0005-quality-gate-install.md` | 决策记录 | 质量门与安装执行(pnpm 直装 + 等价性举证 + in-box 保护 + 卸载联动) |
| `adr/ADR-0006-rest-tools-events.md` | 决策记录 | 对外接口(REST /api/dsh-hotplug + hotplug_* 工具 + SSE 事件) |
| `adr/ADR-0007-audit-degradation-scope.md` | 决策记录 | 审计 JSONL + 降级路径(hot/restart 两轴) + profile 定位与 Non-Goals |

## 2. 锁定决策总览(2026-08-14)

| # | 决策 | 结论 | ADR |
|---|---|---|---|
| D1 | 包形态 | **bundle 双面插件**,自身行 id `hotplug-engine`;首装需重启一次,此后全部热挂 | 0001 |
| D2 | 服务身份 | `ctx.hotplugEngine`;契约 v1 **只增不改**;`src/contract/types.ts` 由契约文档派生 | 0002 |
| D3 | 操作模型 | 全局串行队列 + operationId;**观察窗口 8s 自动回滚**;回滚=备份恢复+HMR 重放;幂等 | 0003 |
| D4 | 写入层 | owner managed block(绝不整文件重写)+ 行级解析 + 白名单 + 原子写 + **禁 !!js** | 0004 |
| D5 | 安装执行 | **pnpm 直装不经 dsh CLI**;装前质量门(入口/import 对账/客户端 bundle);in-box 保护;卸载联动清理;按包形态分派 hot/restart | 0005 |
| D6 | 对外接口 | REST `/api/dsh-hotplug/*`(同源,v1 无 token);工具 `hotplug_*`;SSE 事件 | 0006 |
| D7 | 审计/降级/范围 | 审计 JSONL;hmr 缺失 → restart 模式(契约不变);自身宿主 profile 只读保护;Non-Goals 锁定(无市场功能) | 0007 |

## 3. 阅读顺序

消费方(市场/agent):`01-contract.md`(契约即全部所需)。
实现者:`AGENTS.md` → `01-contract.md` → `02-design.md` → `adr/`(按需)。

## 4. Review 记录(2026-08-14 双 subagent review)

| 视角 | 结论 | 修复 |
|---|---|---|
| 架构 | **有条件通过**(4 major + 若干 minor) | 已修复:模式双轴分离(契约 §9/设计 §9)、按块回滚 + 并发 hash 对账(设计 §5.2/ADR-0003)、启动对账(设计 §5.4/ADR-0003)、包名 npm 规范白名单(设计 §2.2/ADR-0004)、profileDir 定位与自身探测(设计 §3.6/ADR-0007)、Windows spawn 策略(设计 §3.6)、bundles 等价性举证(ADR-0005)、slugify 碰撞(设计 §3.3)、队列去重锁定 CONFLICT(设计 §8)、GATE detail 转义/审计滞后指示/pnpm 探测等 minor |
| 一致性 | **基本一致需修正**(3 major + 8 minor,无 blocker) | 已修复:冻结里程碑三处统一(M1–M4 全量 + 双 review)、02-design §9 stale 分支删除、上位文档 7 处同步(来源枚举/status(entryId)/pnpm 直装/文件备份/同源 POST/工具名/ADR 真实文件名) |

**遗留待办(全部关闭/明确降级,2026-08-14 M4 T4.6)**:① 实机核对 `ctx.get('hmr')` 服务注册名 → ✅ 已核对(cordis-plugin-hmr 以 `"hmr"` 注册,服务构造探测精确);② pkgMeta 负缓存对 install 的影响 → ✅ 已闭环(install 结果消息携带"曾扫描为非客户端包需重启"提示);③ 观察窗口命中率校准 8s → ✅ 定案保留 8s(数据驱动校准留 v2,`observationStats()` 可观测);④ REST 写端点 token/审批钩子 → ✅ 明确登记 v2 候选(ADR-0006 §后果,不阻塞 v1 冻结)。

## 5. 变更流程

- 契约变更:先改 `01-contract.md` → 再改 `src/contract/types.ts` → 走 ADR(破坏性变更升 v2);
- 设计变更:先改 `02-design.md` → 实现;偏离既有 ADR 时新增 ADR 记录;
- 官方机制事实变化:先更新设计审计笔记(私有,未随仓库发布)→ 再评估本文档影响。

---

*✅ 全量首版实现(M1–M4)完成,**契约 v1 已冻结**(2026-08-14,01-contract.md 版本 1.0,双 review 通过)。后续 v2 候选见 §4/ADR-0006。*
