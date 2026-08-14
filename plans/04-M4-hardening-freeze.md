# M4 详细计划 — 加固与契约冻结

> 计划编号:`hotplug-engine-PLAN-04` | 里程碑:M4 | 目标:可靠性加固 + 全量验证 + 契约 v1 冻结 + 发布准备
> 上位约束:01-contract §10(冻结条件);02-design §5.4(启动对账)/§6(审计)/§9(模式);ADR-0007(范围与降级)

---

## 1. 目标与范围

**做**:
- audit.ts 完善(审计滞后指示:`audit()`/`status` 暴露);
- 多 profile 支持(profileDir 模式;官方 profile 与自身宿主 profile 保护;snapshot/install 等 `profile?` 参数全支持);
- 降级路径验证(restart 模式:模拟无 hmr 环境,契约不变性;两轴分离行为核对);
- 崩溃对账实测(模拟 install 中断 → 残留 → 启动对账恢复);
- 观察窗口命中率校准(以 M2-M4 数据定默认值,必要时改设计/ADR);
- **契约 v1 冻结**:全量实现(M1-M4)完成 + 双 subagent review 通过 → 01-contract.md 标注「已冻结 v1」;
- 发布准备:README(消费方接入指南)/ LICENSE / 发布流程验证(打包 → 本地安装 → 实机可用)。

**不做(边界)**:市场功能(永久 Non-Goal);v2 契约特性(token/审批钩子等,登记候选);官方机制重写。

## 2. 前置条件

1. M3 全部验收通过(A3.1-A3.8);
2. 观察窗口命中率数据积累(M2 起)足够判断默认值;
3. 双 subagent review 授权(冻结前)。

## 3. 任务拆分(文件级)

| # | 任务 | 产出 | 说明 | 依赖 |
|---|---|---|---|---|
| T4.1 | 审计完善 | `src/host/audit.ts` | 滞后指示(写失败 → `audit()`/`status` 暴露);JSONL 结构终检 | M3 |
| T4.2 | 多 profile | `src/host/service.ts` + manifest/backup 参数化 | `profile?` 全方法支持;官方/宿主 profile 保护(ADR-0007);M1-M3 的"仅当前 profile"限制解除 | M3 |
| T4.3 | 降级验证 | 测试 + 实机 | 模拟无 hmr(注入假 ctx);hot/restart 两轴分离行为核对(契约 §9);restart 下非 bundle → 写行 + restartRequired | M3 |
| T4.4 | 崩溃对账实测 | `tests/` e2e | 模拟 install 中断(杀进程/抛错)→ 残留 → 启动对账摘孤儿/标 interrupted/告警 | M3 |
| T4.5 | 观察窗口校准 | 统计 + 设计/ADR(如改) | 命中/超时/回滚率决定默认值;若改 8s → 更新 01-contract/02-design/ADR-0003 | M2-M4 数据 |
| T4.6 | 契约冻结 | 01-contract.md「已冻结 v1」 | 全量实现完成 + 双 subagent review(架构 + 一致性)通过;`types.ts` 与契约人工对照;遗留待办(00-index §4)全部关闭或明确降级 | 全部 |
| T4.7 | 发布准备 | README / LICENSE / 打包验证 | 消费方接入指南(host 注入/REST/工具三路径示例);npm pack → 临时 profile 安装 → 实机可用;发布 scope 决策 | T4.6 |

## 4. 实施顺序

1. T4.1-T4.2(加固)→ T4.3-T4.4(验证,测试先行);
2. T4.5 校准(数据驱动);
3. T4.6 冻结(先双 review 再标注冻结);
4. T4.7 发布准备(最后,发布 scope 定案)。

## 5. 测试设计(本里程碑新增)

| 层 | 用例 | 夹具 | 路径要求 |
|---|---|---|---|
| audit 单元 | JSONL 行结构;滞后指示(写失败暴露);查询过滤 | 临时目录 | 真实文件 |
| 多 profile 集成 | 管理非宿主 profile(snapshot/install/enable);官方 profile 拒(PROTECTED);宿主 profile 自保护(不可 uninstall 自身) | 多临时 profile | 真实文件 |
| 降级集成 | 无 hmr 环境(注入):install 非 bundle → restartRequired;enable → 行写入 + restartRequired;契约字段行为不变 | 假 cordis 上下文 | 生产路径 |
| 崩溃对账 e2e | install 中断 → 残留(孤儿行/孤儿依赖/未完结 op)→ init 对账:摘孤儿/标 interrupted/告警;备份可 rollback | 演练 profile + 模拟中断 | 实机 |
| 观察窗口统计 | 命中率聚合输出(供 T4.5 决策) | 集成测试数据 | — |
| 契约对照 | types.ts vs 01-contract §3 全字段(人工 review 项) | — | 双 review |
| 发布验证 | npm pack → 临时 profile `dsh plugin add` → boot 可用(服务注册/工具/UI) | 临时 profile | 实机,验证后清理 |

## 6. 验收条件(M4 完成判定,逐项 MUST 满足)

- [x] A4.1 M1-M3 验收全保留(回归);typecheck/test 全绿;✅ 164/164 全绿 + host/client typecheck 0 + build 0(含 M4 终审前最终复核);
- [x] A4.2 审计:JSONL 完整 + 滞后指示暴露;✅ T4.1:EngineSnapshot.auditLag(可选字段)+ auditLag() 方法;tests/audit.spec.ts 6 项(JSONL 往返/过滤/坏行跳过/写失败 sticky/服务面暴露);
- [x] A4.3 多 profile:非宿主 profile 可管理;官方/宿主 profile 保护生效(PROTECTED);✅ T4.2:resolveProfile M4 语义(白名单/官方非宿主 PROTECTED/缺失 NOT_FOUND/宿主恒可管);非宿主 = 文件/restart 语义(写文件 + restartRequired,无 loader 观察);不可卸载引擎自身(自保护);patch.ts readInsertRows 捕获 disabled;契约 §4/设计 §3.6 同步;service.spec 25 项(含 4 项新增多 profile/自保护);
- [x] A4.4 降级:hot/restart 两轴分离全量核对(契约 §9);restart 下行为可预期且契约字段不变;✅ 既有覆盖:service.spec 两轴(§9.1/§9.2)+ install.spec restart 模式非 bundle 写行 + restartRequired + bundle restart + hot 模式对照;
- [x] A4.5 崩溃对账实测通过:孤儿残留被处理,可回滚,profile 不 fail-loud;✅ 既有覆盖:install.spec startup reconcile 3 项(孤儿 insert 块摘除/中断 sidecar 审计 OP_INTERRUPTED/孤儿依赖告警)+ backup.spec 回滚;
- [x] A4.6 观察窗口默认值定案:✅ 保持 8s(无 M2-M4 聚合命中率数据支撑改值;observationStats() 已可观测,校准数据留 v2/后续;改动将同步 01-contract/02-design/ADR-0003);
- [x] A4.7 **双 subagent review 通过**(架构 + 一致性;含契约一致性人工对照);✅ 2026-08-14 冻结门终审:一致性「基本一致需修正」→ I1/I2(落款陈旧)/O1(复选框)/O2(audit.ts 死代码)全部修正;**契约 §3 类型逐字段零不一致**;架构「有条件通过」→ major M1(引擎自身行 enable/disable 自毁)已修 + 回归测试,minor M2/M6(自保护边界)已文档化 ADR-0007/设计 §3.6、M3(非宿主 snapshot.mode=restart)已修 + 测试、M4(readInsertRows 多行块)已修 + 测试、M5 流程项随 A4.8 执行;遗留待办(00-index §4)全部关闭/明确降级;
- [x] A4.8 01-contract.md 标注「已冻结 v1」;✅ 2026-08-14:标题 + 头部冻结注记 + 落款同步(版本 1.0);
- [x] A4.9 发布包可装可用;✅ T4.7:README 消费方指南(三路径示例/安全边界/profile 语义)就绪;`pnpm pack` tarball 38 项完整(lib/ + cordis.patch.yml + README + LICENSE);**tarball → 临时 profile `pnpm add` → bundles → 独立宿主 boot 验证通过**(snapshot 140 条目 + auditLag 字段透出 + client.js 200);演练 profile/tgz 已清理;
- [x] A4.10 实测记录全部回填;✅ 设计审计笔记(私有,未随仓库发布) §7.1(M3 对外面实机)/§7.2(M4 发布包验证)已回填;上下文笔记(私有,未随仓库发布) §2.5(引擎项目冻结状态)/§4/§5(机制事实)已更新;真实 web profile 全程未触碰(模板原样、3080 在线)。

## 7. 风险与回退

- 多 profile 引入范围膨胀:仅实现契约已暴露的 `profile?` 语义,不新增管理能力;
- 降级验证需模拟无 hmr:用假 ctx 注入(不真改官方),行为核对以契约字段为准;
- 冻结后发现契约缺陷:按契约变更流程(升 v2 或修订 + 重审),不硬冻结;
- 任一验收不过:按 AGENTS.md 修复规则;两次修复未过则暂停报告用户。

---

*M4 完成 = 契约 v1 冻结 = 首版实现交付。后续(v2 候选)见 01-contract §10 与 ADR-0006 遗留项(token/审批钩子等)。*
