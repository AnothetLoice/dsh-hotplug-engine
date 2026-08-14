# M2 详细计划 — 安装闭环(install/uninstall)

> 计划编号:`hotplug-engine-PLAN-02` | 里程碑:M2 | 目标:安装/卸载双形态可用,含质量门与观察窗口自动回滚
> 上位约束:02-design §3(安装流程)/§4(质量门)/§5.3-5.4(观察窗口与启动对账);01-contract §9.2(生效方式)/ADR-0005(等价性)

---

## 1. 目标与范围

**做**:
- quality.ts(装前质量门:入口/import 对账/客户端 bundle;Loader 提供集合锁定 0.1.0-rc.6;GATE detail 转义);
- installer.ts(pnpm 探测 / spawn 数组参数 / Windows cmd / 包形态判定 / install-uninstall 执行 / in-box 保护复用);
- health.ts **完整版**(install 观察窗口 + 全行对账 + 自动回滚 + 命中率统计);
- service.install / service.uninstall(串行队列内;dryRun 同路径;pkgMeta 负缓存提示);
- 启动对账完善(孤儿 insert 块 / 未完结操作 / 孤儿依赖);
- **M2 前置核对**:`ctx.get('hmr')` 服务注册名实机核对;记录观察窗口基线。

**不做(边界)**:REST/SSE/工具/UI(M3);多 profile(M4);bundles 对拍测试的官方 CLI 集成仅做 fixture 级(不依赖 PATH 上的 dsh)。

## 2. 前置条件

1. M1 全部验收通过(A1.1-A1.11);
2. 官方机制未定点核对完成:hmr 服务名、pkgMeta 负缓存影响(设计 §9.1/§3.1 注);
3. pnpm 二进制可用(探测路径确认)。

## 3. 任务拆分(文件级)

| # | 任务 | 产出 | 说明 | 依赖 |
|---|---|---|---|---|
| T2.0 | 前置核对 | 核对记录(写入 00-index §4 遗留项更新) | 实机核对 `ctx.get('hmr')` 服务名;确认 pkgMeta 负缓存对 install 的影响;观察窗口基线采集 | — |
| T2.1 | 质量门 | `src/host/quality.ts` | 02-design §4 五项;Loader 提供集合锁定到官方 0.1.0-rc.6 平台表(漂移防 护);GATE.REJECTED detail HTML 转义 | M1 |
| T2.2 | 安装执行 | `src/host/installer.ts` | pnpm 探测(pnpm/pnpm.cmd/`hotplugEngine.pnpmPath`);spawn 数组参数;Windows `cmd.exe /c pnpm.cmd`;包形态判定(dsh.bundle);install/uninstall 主流程;in-box 保护 | T2.1 |
| T2.3 | 观察窗口完整 | `src/host/health.ts` 扩展 | install 窗口:目标行 + 本次块全行对账;自动回滚(摘块 + pnpm remove + 恢复备份);命中率统计(校准 8s) | M1 health |
| T2.4 | 服务扩展 | `src/host/service.ts` | `install(spec, {profile?, dryRun?})` / `uninstall(name)`;dryRun 与真实路径共用同一解析;pkgMeta 负缓存命中 → 提示"需重启或换新包名";mode 按 §9.2(两轴分离) | T2.2, T2.3 |
| T2.5 | 启动对账完善 | `src/host/service.ts` init + `src/host/reconcile.ts`(或并入 backup/health) | 孤儿 insert 块自动摘除;未完结操作标 interrupted;孤儿依赖告警;对账结果入审计 | T2.4 |
| T2.6 | 测试 + e2e | `tests/`(见 §5) | 质量门好坏包夹具;installer spawn 注入;观察窗口三分支;e2e 演练 | T2.1-T2.5 |

## 4. 实施顺序

1. T2.0 前置核对(先做,结果决定 service 探测实现);
2. T2.1 quality → T2.2 installer(先测试后实现,spawn 用注入假 pnpm);
3. T2.3 health 扩展 → T2.4 service → T2.5 启动对账;
4. T2.6 测试全绿 → e2e 实机(§5)→ 回填实测记录。

## 4.1 实现进度(2026-08-14)

- **T2.0 前置核对完成**:① `cordis-plugin-hmr` 服务名确为 `"hmr"`(`super(ctx, "hmr")` 源码核对)——`ctx.get('hmr')` 探测精确,假阴性风险排除;② pkgMeta 负判定缓存事实确认(audit §1.1)——install 结果已带"需重启或换新包名"提示;③ 观察窗口命中率统计已实现(`observationStats()`);
- **T2.1-T2.5 实现完成**:quality.ts(入口/import 对账/客户端 bundle,LOADER_PROVIDED 锁 0.1.0-rc.6)、installer.ts(pnpm 探测/spawn/包形态)、service.install/uninstall(dryRun 同路径、按包形态分派 hot/restart、pkgMeta 提示)、启动对账(孤儿块摘除/未完结 sidecar 审计/孤儿依赖告警)、观察统计;
- **Windows spawn 关键结论(实测)**:Node 直接 spawn .cmd → EINVAL;裸命令名 → ENOENT;`cmd /d /s /c ""<cmd>" <args>""` + `windowsVerbatimArguments:true` 可行——**已用真实 pnpm 做 e2e 验证**(临时 profile 安装 hotplug-drill 成功,`scripts/real-pnpm-e2e.cjs` 保留为手动验证工具);
- **测试**:新增 quality 8 + installer 7 + install 15 用例(含 fake pnpm 集成、hot/restart 双模式、bundle 安装、观察失败自动回滚无残留、pnpm 失败、质量门转义、启动对账),全量 **98/98 通过**;typecheck/build 零错误;
- **双 subagent review 完成(§8 记录),全部问题已修复并补回归测试**;
- **待办**:e2e 演练 profile 实机验证(A2.7)——真实 pnpm spawn 已由 `scripts/real-pnpm-e2e.cjs` 验证,服务级端到端经 fake pnpm 集成覆盖;真实 3080 宿主验证依赖引擎对外通道(M3)。

## 5. 测试设计(本里程碑新增)

| 层 | 用例 | 夹具 | 路径要求 |
|---|---|---|---|
| quality 单元 | 好包过;缺入口拒;裸导入(未声明且非 Loader 提供)拒;缺 client bundle 拒 | `harness-research/hotplug-drill/` + 构造坏包夹具(真实临时包目录) | 真实包解析路径 |
| service 集成(转义) | GATE detail 含 HTML 特殊字符 → 已转义(escapeHtml 在 service 层,2026-08-14 复核修正矩阵位置) | 坏包夹具 + fake pnpm | install.spec 真实路径 |
| installer 单元 | pnpm 探测(缺 pnpm → 明确错误);spawn 数组参数(注入假 pnpm 捕获 argv,验证无 shell 拼接);Windows 分支(cmd.exe /c);包形态判定(bundle/非 bundle) | 注入假 pnpm 可执行脚本 | 真实 spawn 路径 |
| install 流程集成 | 非 bundle:装依赖→挂行→观察窗口 active 成功;failed→自动回滚;超时→自动回滚;bundle:写 bundles + restartRequired(不写 insert 行) | 临时 profile + 假 loader | 真实文件 + 真实 pnpm(或假 pnpm) |
| uninstall 集成 | 摘 bundles + 联动清理 insert 块 + in-box 保护;孤儿 insert 块清理 | 临时 profile 残留夹具 | 真实文件 |
| 启动对账 | 孤儿 insert 块自动摘除;未完结操作标 interrupted;孤儿依赖告警不删 | 构造残留临时 profile | 真实文件 |
| mode 集成 | 引擎 restart(注入无 hmr 环境)+ 非 bundle install → `mode:'restart'`+`restartRequired`;引擎 hot → `mode:'hot'`(两轴分离,契约 §9) | 假 cordis 上下文 | 生产路径 |
| e2e | 演练 profile:install 非 bundle 插件(如 hotplug-drill 变体)→ 3080 ping 200 → uninstall → 404;坏包 install → GATE.REJECTED;观察窗口自动回滚实测(装一个故意 failed 的包) | 演练 profile(web 或临时) | 实机,验证后完全清理 |

## 6. 验收条件(M2 完成判定,逐项 MUST 满足)

- [x] A2.1 M1 验收全保留(回归);typecheck/test 全绿;✅ 98/98 + build 零错误;
- [x] A2.2 前置核对完成:`ctx.get('hmr')` 服务名确认为 `"hmr"`(源码核对,2026-08-14);pkgMeta 影响确认(install 带提示);✅
- [x] A2.3 quality 门:好包过/坏包拒(GATE.REJECTED 带原因,不落盘);detail HTML 转义(escapeHtml,含回归测试);✅
- [x] A2.4 非 bundle install → 热挂(mode:'hot',观察确认);bundle install → bundles + restartRequired(含 e2e 用例);uninstall 联动清理 + in-box 保护 + bundle-uninstall restartRequired;✅
- [x] A2.5 观察窗口:active 成功 / 超时自动回滚(无 node_modules 残留,含用例);同块全行对账(blockRowIds 接线);命中率统计(observationStats);✅ (failed 分支经 waitForHealthWithBlock 语义覆盖)
- [x] A2.6 崩溃对账:孤儿 insert 块自动摘除;未完结 sidecar 审计为 OP_INTERRUPTED(码已入契约);孤儿依赖告警;✅
- [ ] A2.7 e2e 实测通过且演练后 profile 完全复原——**受限**:真实 pnpm spawn 已由 `scripts/real-pnpm-e2e.cjs` 验证(临时 profile 装 hotplug-drill 成功);服务级端到端经 fake pnpm 集成覆盖;真实 3080 宿主验证依赖 M3 对外通道;
- [x] A2.8 契约一致性:service 行为与 01-contract §4/§9 逐条对照(ok=true=已应用、mode 两轴、uninstall bundle→restartRequired);双 review 确认;✅
- [ ] A2.9 未越界 + bundles 对拍——**部分受限**:无 REST/UI/官方机制重写 ✅;官方 CLI 对拍测试需真实 `dsh` CLI 环境,记为 M4 发布验证项(ADR-0005 等价性已由语义单测 + 源码逐条对照覆盖)。

## 7. Review 记录(2026-08-14 M2 代码双 review)

| 视角 | 结论 | 修复 |
|---|---|---|
| 架构 | **有条件通过**(5 major + 若干 minor) | 已修复:观察全行对账(blockRowIds 接线 install/enable)、observation 失败清理 node_modules 依赖(pnpm remove)、uninstall bundle→restartRequired、`%` 加入 CMD_METACHARS 拒集、INTERRUPTED 码入契约 §8/types;minor:dryRun 共享 installed 门禁、GATE detail HTML 转义、对拍测试登记 M4、withBundleAdded 注释澄清(官方同样末尾追加) |
| 一致性 | **基本一致需修正**(2 major + 7 minor,与架构交叉) | 已修复:C1 INTERRUPTED 码登记、C2 GATE 转义实现+测试、C3 dryRun 共享解析(已装包复检)、C4 全块对账接线、C5 bundle-install/观察失败用例补全;minor:uninstall mode、findPnpm 顺序(设计 §3.6 措辞更新为显式优先)、观察统计计 rollback、内存未完结操作入审计、审计 spec 字段、SPEC_UNSAFE 码、PROFILE.NOT_FOUND 留 M4 |

**已记录(推迟/接受)**:真实 3080 宿主 e2e(M3);官方 CLI bundles 对拍(M4 发布验证);PROFILE.NOT_FOUND(M4 多 profile)。

### 7.1 复核(锁定)结论(2026-08-14)

| 视角 | 结论 | 处理 |
|---|---|---|
| 架构复核 | **有条件通过**——9 个 ISSUE 全部验证修复正确、无回归 | minor 已修:观察统计与 rollback 稳定分离(独立 rollback 计数,不污染 8s 校准);观察统计口径修正;记录一次性邻行快照(uninstall 无观察为设计 §3.4 范围外;blockRowIds 多行/空退化无直测,留 M3 补) |
| 一致性复核 | **基本一致需修正**——12 项(C1-C5/G1-G7)全部验证一致 | 已修:内存未完结操作死循环移除(仅 sidecar 扫描为权威,已在构造函数时 map 为空);uninstall 审计 target=name;计划矩阵转义测试位置修正(service 层);HMR_UNAVAILABLE 标注保留码;GATE detail 经 failureResult 用 message 而非结构化 detail(记录,可接受) |

**M2 锁定完成**。遗留低危项均登记:blockRowIds 多行直测(M3)、uninstall 观察确认(设计 §3.4 范围外,记录)、官方 CLI 对拍(M4)。

## 8. 风险与回退

- pnpm 版本差异(11.x):在临时 profile 对拍官方 `dsh plugin` 输出(等价性测试);
- 观察窗口默认 8s 不足:以命中率统计为准,M4 前可调;
- Windows spawn 意外:先修 Windows 分支(dev 环境即 Windows),再补 Linux/macOS;
- 任一验收不过:按 AGENTS.md 修复规则。
