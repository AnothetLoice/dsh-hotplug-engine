# ADR-0003 操作模型:串行队列 + 观察窗口自动回滚

- **状态**:已接受 | **日期**:2026-08-14
- **上位约束**:hotplug-engine-design.md §5(可靠性承诺);机制事实 audit §1.4(配置 HMR 重放非可重入)

## 背景
社区三家管理器共同空白 = 热挂失败无自动回滚、无健康确认;且官方配置 HMR 的事务性重放**非可重入**(`Include.enqueue` 注释:init apply 与 HMR 刷新竞态会串扰条目)。

## 决策
1. **全局串行队列**:所有写操作(install/uninstall/enable/disable/rollback)经单例 promise 链执行,任务间不并行;入队即分配 `operationId`(可 `listOperations` 追踪);读操作不排队;
2. **观察窗口自动回滚**(默认 8s,500ms 轮询):目标行 `fiberPhase==='active'` → 成功;`'failed'` 或超时 → 自动摘除本次写入并恢复备份,审计 `rolled-back` + 错误码;**对账范围 = 本次 managed block 全行**(目标 active 但邻行 failed/级联扰动 → 视为失败,2026-08-14 review);
3. **回滚 = 备份恢复 + HMR 自动重放,分两条路径**(2026-08-14 review 修复,防整文件回滚抹掉外部并发写者的修改):每次写操作前备份(cordis.patch.yml + package.json);`rollback(handle)` 时若当前 patch hash == 操作完成时 hash → 整文件恢复;hash 不匹配(检测到外部并发修改)→ **仅增量摘除本次 managed block** + 告警;随后 HMR 重放,窗口内确认行回到先前状态;
4. **幂等 + 去重锁定**:写入 desired-state 语义;队列内相同 op+target 且仍在队列 → **返回 `HOTPLUG.OP.CONFLICT`**(不做合并,行为可预期);
5. **启动对账 / 崩溃恢复**(2026-08-14 review 新增):写操作开始时记 `status:'queued'`(未完结标记);服务 init 扫描 managed blocks 与未完结操作——孤儿 insert 块自动摘除、未完结操作标 `failed(interrupted)`(备份仍在可 rollback)、孤儿依赖告警保留;对账不阻塞启动。

## 备选
- 并行写:违反非可重入约束,排除;
- 只报错不回滚(社区现状):不满足"可靠服务"定位,排除;
- 固定回滚仅靠内存状态:重启后不可回滚,需文件备份。

## 后果
- 写操作最坏延迟 = 观察窗口(8s),UI/工具需按异步结果处理(operationId 追踪);
- 需要备份目录与审计记录持久化(`$DSH_HOME/backups|logs/hotplug-engine/`);
- 自动回滚是保守策略:超时即回滚,宁可失败不留坏状态。

## 关联
- ADR-0004(写入层)、ADR-0007(审计与降级)

## 修订(v0.1.5,2026-08-16)
- **决策 2 观察窗口结果按「loader 是否反映本次写入」三分**(经验判定,替代单一「超时即回滚」):
  - **反映成功**:enable/install 行挂载 `active`、disable 行卸载 `gone` → `mode:'hot'`(成功);
  - **反映失败**:行进入 `failed`,或 enable/install 行卡 loading/pending 超时 → 自动回滚(坏行,保守,原语义保留);
  - **未反映**:enable/install 行**从未挂载**(全程 `readFiberPhase` 返回 `undefined`)、disable 行**仍 active 未卸载** → 判 `mode:'restart'` + `restartRequired:true`,**保留写入、下次启动加载、不自动回滚**(等价于 ADR-0007 的 restart 行为;质量门仍是坏包门禁;**结果/审计 MUST 附「未在 loader 生效,可能为 restart 环境或 loader 拒绝,重启后请核对,可用 handle 回滚」警示**)。
- **经验判定动机**:`ctx.get('hmr')` 探测的是 cordis-plugin-hmr(模块级 HMR,实测 web profile `disabled:true`),与引擎 patch 行真正依赖的「配置热应用/重挂」(CLI `root:[]`)是两条独立机制,静态探测产生假阴性(v0.1.4 验收 P2-2)。改为以 loader 树真实挂载状态为唯一真源。
- 后果「宁可失败不留坏状态」仍适用于「已挂载」场景;「从未挂载」非失败而是重启语义。
