# 实施计划总览 — dsh-hotplug-engine

> 文档编号:`hotplug-engine-PLAN-00` | 性质:实施计划(总览) | 版本:0.1(2026-08-14)
> 上位约束:02-design §12(M1–M4 顺序)、01-contract v1(契约)、adr/ 决策;机制事实以设计审计笔记为据(私有,未随仓库发布)
> 规范关键词:MUST / MUST NOT / SHOULD / SHOULD NOT / MAY

---

## 1. 阶段与里程碑总览

| 里程碑 | 名称 | 核心产出 | 依赖 | 验收摘要 |
|---|---|---|---|---|
| **M1** | 最小闭环 | patch.ts / manifest.ts / queue.ts / backup.ts / health.ts(最小)/ service.ts → **enable/disable/rollback 可用** | 项目骨架、contract/types.ts | typecheck/build/test 全绿;陷阱用例全覆盖;实机对既有行启停+回滚复原 |
| **M2** | 安装闭环 | installer.ts / quality.ts / health.ts(完整)→ **install/uninstall 可用** | M1 | 前置核对(hmr 服务名/pkgMeta);非 bundle 热挂 + bundle restart;观察窗口自动回滚实测;质量门拒坏包 |
| **M3** | 对外面 | rest.ts / events.ts / tools.ts / client 最小 UI → **契约全量可消费** | M2 | REST 10 端点 + SSE + 6 工具 + 管理面板;实机 3080 验证 |
| **M4** | 加固与冻结 | audit 完善 / 多 profile / 降级验证 / 崩溃对账 / **契约 v1 冻结** | M3 | 全量契约 hot/restart 两模式验证;双 subagent review 通过;发布准备 |
| **M5** | 安全与健壮性整改 | security-crash-review.md 整改(2 高/3 中/5 低):H2 handle 校验、M1 别名拒绝、M2 输出清洗、M3 readPatch 防御、L1 调优、L2 crypto tmp、L5 响应兜底、H1 可选 token 门禁 | M4 冻结后 | 见 plans/05-M5-security-hardening.md 验收条件(A 类全修+单测全绿、H1 决策落地、文档回填) |
| **M6** | 优化方向(A–H,v0.1.4) | docs/03-optimization-directions.md 的 A–H(pnpm 定位/Windows 可执行性/bundle 热加载编排/错误诊断/看板搜索/排序/状态色彩/高危停用警告) | M5 后(v1 冻结 + 加固) | 见 plans/06-M6-optimization.md 验收条件(typecheck 零错误、测试全绿、演练实机) |

## 2. 阶段间依赖与顺序

```
M1(启停回滚) ─→ M2(安装) ─→ M3(对外) ─→ M4(加固+冻结)
   ├ 先能"安全改 patch + 可回滚"   ├ 再能"装新插件"
   ├ 再能"启停既有行"             ├ 质量门/观察窗口/自动回滚
   └ 为 M2 提供 queue/backup 基础   └ 为 M3 提供完整 service
```

- M1 必须先于 M2:enable/disable/rollback 是 install 自动回滚的前置能力(同一 queue/backup/health 栈);
- M3 依赖 M2:install 是对外面(市场/agent)的核心方法;
- M4 冻结依赖全部:契约 v1 冻结条件 = M1–M4 全量完成 + 双 subagent review(01-contract §10)。

## 3. 风险登记(跨阶段)

| 风险 | 影响 | 缓解 | 处置里程碑 |
|---|---|---|---|
| `ctx.get('hmr')` 服务注册名未核实(CLI 程序化重挂) | 引擎模式探测假阴性 → 误判 restart | **M2 开工前实机核对**(设计 §9.1) | M2 前置 |
| pkgMeta 负判定缓存(曾扫为非客户端包) | 客户端插件热挂不生效 | install 结果提示"需重启或换包名"(设计 §3.1 注) | M2 |
| 观察窗口 8s 对重客户端不足 | 误回滚/漏检 | M2 起记录命中率校准默认值(设计 §5.3) | M2–M4 |
| Windows spawn pnpm(.cmd) | install 不可用 | cmd.exe /c + 数组参数策略(设计 §3.6) | M1 骨架/M2 实现 |
| 官方 preview 机制变动(hmr 重挂/bundles reconcile) | 契约语义漂移 | 先更新 audit.md 依据再评估契约(01-contract §10) | 全程 |
| 外部并发写 cordis.patch.yml | 回滚覆盖他人修改 | 按块回滚 + hash 对账(设计 §5.2/ADR-0003) | M1 |
| 崩溃中断残留(孤儿行/孤儿依赖) | 下次启动 fail-loud | 启动对账(设计 §5.4) | M1 基础/M2 完善 |

## 4. 测试总策略(跨阶段)

1. **路径要求**(AGENTS.md 原则 5):单元/集成测试 MUST 走真实生产路径——patch 写入用**真实临时文件 + 真实解析**;安装/回滚 e2e 用演练夹具(自备);禁止直调内部函数绕过;全绿 ≠ 路径真实;
2. **分层测试矩阵**:

| 层 | 工具 | 夹具 | 说明 |
|---|---|---|---|
| 单元 | vitest | 临时目录/内存 | patch/manifest/queue/backup/quality 纯逻辑 |
| 集成 | vitest + 假 loader/webServer | 注入 cordis 上下文 | health 观察窗口、service 方法、REST 路由 |
| e2e | vitest + 实机 | 演练 profile(web 或临时) | install→3080 ping→rollback;验证后清理 |
| 契约一致性 | 人工对照(review 项) | — | `src/contract/types.ts` vs `01-contract.md` §3 |

3. **安全用例必含**:恶意包名(含 `'`/`:`)、`!!js` 注入样本、GATE detail 转义、slugify 碰撞;
4. **每个里程碑交付时**:`pnpm typecheck` 零错误 + `pnpm test` 全绿 + 写操作在演练 profile 实机验证后回填设计审计笔记(私有,未随仓库发布)实测记录。

## 5. 验收总表(各里程碑详细 checklist 见对应计划)

| 里程碑 | 关键验收(必达) |
|---|---|
| M1 | enable/disable/rollback 端到端可用;陷阱用例全覆盖;实机启停+回滚复原 profile |
| M2 | install/uninstall 双形态(热挂/restart)可用;质量门拒坏包;观察窗口自动回滚实测;前置核对完成 |
| M3 | 契约 §5/§6/§7 全量可消费;实机面板/SSE/工具可用;写操作审批门禁生效 |
| M4 | hot/restart 两模式全量验证;多 profile;崩溃对账实测;双 review 通过 → 冻结契约 v1;发布包可装 |

## 6. 变更流程(本计划)

- 计划变更:先改本计划(或对应 0X-*.md)→ 评估对契约/设计影响 → 走 ADR(如涉决策);
- 每个里程碑开工前,读对应计划 + 02-design 相关小节 + 01-contract 相关小节;
- 每个里程碑收尾时:验收 checklist 逐项打勾,未过项 MUST NOT 进入下一里程碑;实测发现回填 audit.md。

---

*对应详细计划:`plans/01-M1-min-closed-loop.md`、`plans/02-M2-install-loop.md`、`plans/03-M3-external-surface.md`、`plans/04-M4-hardening-freeze.md`、`plans/05-M5-security-hardening.md`、`plans/06-M6-optimization.md`。*
