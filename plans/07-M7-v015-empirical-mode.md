# M7 详细计划 — v0.1.5 P2-2 修复(经验判定模式检测)

> 计划编号:hotplug-engine-PLAN-07 | 里程碑:M7 | 目标:落地 P2-2 修复——以「经验判定」替代 `ctx.get('hmr')` 静态探测,消除 mode=restart 与配置热应用矛盾。
> 上位约束:docs/01-contract.md §9(已锁定)、docs/02-design.md §5.3/§9(已锁定)、adr/ADR-0003/0007(已修订)、AGENTS.md(红线/原则/推进流程)
> 规范关键词:MUST / MUST NOT / SHOULD / SHOULD NOT / MAY(RFC 语义)
> 范围声明:纯 **v1 向后兼容**——仅改「判定方法」,不改字段形状/值域(`mode:'hot'|'restart'`、`restartRequired` 未变);设计/契约已通过 **双 review + 终审门禁锁定**(commit b64a383 + b8304fc),本计划只做实现,不改文档(实现若发现必须回改 → 走变更流程)。

---

## 0. 背景与范围

v0.1.4 实机验收发现 P2-2:引擎用 `ctx.get('hmr')` 探测「配置热应用可用性」,但探测的是 cordis-plugin-hmr(模块级 HMR 插件,实测 web profile 该插件 config 行被官方 disabled:true),而引擎 patch 行真正依赖的「配置热应用/重挂」(CLI 程序化重挂 root:[])是另一条独立且仍活跃的机制 → 静态探测假阴性,引擎误判 mode='restart',导致 (1) 写操作误报「需重启」实际已热应用;(2) install 在 restart 判定下跳过观察窗口、失去坏行自动回滚防线。

已授权并锁定的方案(A 方案 + 「未反映=保留+restart+警示」):

1. **经验判定**:宿主 profile 的 patch 行写操作**始终运行观察窗口**,以 loader 树真实 fiber phase 判定生效方式,按「loader 是否反映本次写入」三分:
   - **反映成功**:install/enable 行挂载 `active`、disable 行卸载 `gone` → `mode:'hot'` + `restartRequired:false`;
   - **反映失败**:行进入 `failed`,或 install/enable 卡 loading/pending 超时、disable 卡 non-gone/non-active → 自动回滚(坏行,保守);
   - **未反映**:install/enable 行全程 `undefined`(从未挂载)、disable 行仍 `active`(未卸载)→ `mode:'restart'` + `restartRequired:true`,保留写入、下次启动加载、不自动回滚;**结果 MUST 附「未在 loader 生效,可能 restart 环境或 loader 拒绝,重启后核对,可用 handle 回滚」警示**。
2. **EngineSnapshot.mode 懒更新**:初始 `'restart'`;首次 install/enable/disable 观察「反映成功」后置 `'hot'` 并保持;`rollback` **不触发** mode 判定。
3. v1 兼容:字段形状/值域不变,仅判定方法改。

### 现状代码核对结论(2026-08-16 终审已逐行核对)

| 变更点 | 现状(代码位置) |
|---|---|
| 静态探测 + readonly mode | `service.ts:87` `readonly mode`、`116-119` `ctx.get('hmr')` → 定死 'restart'/'hot' |
| install 观察门禁 | `service.ts:380` `if (isHost && this.mode === 'hot')` 才跑观察窗口 |
| effectiveMode | `service.ts:773` 依 `this.mode` 返回;被 mutateRow(639)与 rollback(276)使用 |
| 审计写 mode | `service.ts:753` `mode: this.mode`(记操作当时引擎级 mode) |
| 健康原语粒度 | `health.ts` `waitForActive/waitForGone/waitForHealthWithBlock` 都把「从未挂载」与「卡 loading」折叠为 `timeout`,给不出三分粒度 |
| 测试假 hmr | `install.spec.ts:127` `ctx.provide('hmr', {})`、`service.spec.ts:104-124` 依赖「无 hmr → restart」静态探测语义 |

---

## 1. 变更设计(已锁定语义,逐条映射到代码)

### 1.1 health.ts 观察原语扩展(三分粒度)

- `waitForActive(readPhase)` 与 `waitForHealthWithBlock(readPhase, readBlockPhases)` 返回 `'active' | 'failed' | 'stuck' | 'absent'`:
  - `'absent'`:全程 `readPhase()` 停留在**写前基线**——install 新行 `undefined`(从未进入 include 树)、enable 的 disabled 行 `null`(在树但 fiber 未启动、仍 disabled)→ **未反映**;
  - `'stuck'`:曾进入「活」相位(`'pending'|'loading'|'active'`,即离开 null/undefined 基线)但超时前未 active/failed → **反映失败**;
  - 实现:循环内记录 `sawLive = sawLive || (phase !== undefined && phase !== null)`;超时后 `sawLive ? 'stuck' : 'absent'`。**关键**:不可用 `phase !== undefined` 判「已挂载」——enable 目标行本就以 `null`(在树 disabled)为基线,`null` 非 undefined,若用 `sawPresent = phase !== undefined` 会把 restart 环境 enable(全程 null)误判为 stuck→回滚,违反锁定「未反映→保留」语义。
- `waitForGone(readPhase)` 返回 `'gone' | 'failed' | 'still-active' | 'stuck'`:
  - `'gone'`:phase 为 `undefined`/null(已卸载)→ 反映成功;
  - `'still-active'`:全程 phase === `'active'`(从未离开)→ **未反映**;
  - `'stuck'`:离开 active 但超时前未 gone/failed(loading/pending 卡住)→ **反映失败(保守)**;
  - 实现:循环内记录 `everLeftActive = everLeftActive || (phase !== 'active' && phase !== undefined && phase !== null)`;超时后 `everLeftActive ? 'stuck' : 'still-active'`。
- `waitForStable`(rollback 回稳)不变;rollback 不使用上述三分原语。

### 1.2 service.ts mode 改为可变 + 懒更新

- `readonly mode` → `private _mode: 'hot'|'restart' = 'restart'` + 只读 getter `get mode()`(契约 `EngineSnapshot.mode` 只读面不变)。
- 删除构造器 `116-119` 的 `ctx.get('hmr')` 探测(不再读 hmr 服务)。
- 懒更新:install/enable/disable 观察「反映成功」时 `this._mode = 'hot'`(仅此一处翻转;rollback 不翻)。写操作串行队列(ADR-0003)保证无竞态。

### 1.3 install 去门禁 + 三分映射

- 删除 `service.ts:380` 的 `if (isHost && this.mode === 'hot')` 门禁 → 宿主 profile 非 bundle install **恒观察**。
- 观察结果映射:`'active'` → 反映成功(hot,置 `this._mode='hot'`);`'failed' | 'stuck'` → 反映失败(throw HEALTH_FAILED → 自动回滚,现有行为);`'absent'` → 未反映(见 1.5)。
- bundle 分支不变(写 bundles + `mode:'restart'` + `restartRequired:true`,不观察、不翻转)。

### 1.4 enable/disable(mutateRow)+ effectiveMode 重做

- enable/disable 观察结果映射:`'active'`(enable)/`'gone'`(disable)→ 反映成功(hot,置 `this._mode='hot'`);`'failed' | 'stuck'` → 反映失败(throw → 回滚);`'absent'`(enable)/`'still-active'`(disable)→ 未反映(见 1.5)。
- mutateRow 不再用 `effectiveMode()` 定 mode,改由观察结果驱动。
- `effectiveMode()` 保留(返回 `{ mode: this.mode, restartRequired: this.mode==='restart' }`),仅供 **rollback 与 uninstall** 使用(二者无观察窗口:rollback 不翻转 mode;uninstall 的 mode = 引擎当前 mode)。install/enable/disable 改由观察结果驱动。

### 1.5 未反映处置(警示 + 审计)

- 结果:`ok:true` + `mode:'restart'` + `restartRequired:true` + `rollbackHandle` 照常返回;message 追加警示句「未在 loader 生效,可能 restart 环境或 loader 拒绝,重启后请核对,可用 handle 回滚」。
- 审计:按 `result:'succeeded'` + `mode:'restart'` 记录,并**新增 `AuditRecord.note?` 可选字段(v1 只增,契约 §3)**承载警示原文「未在 loader 生效,可能 restart 或 loader 拒绝,重启后核对」——满足锁定「结果/审计 MUST 附警示」字面,并使审计可区分「未反映」与「bundle/非宿主 restart」(二者同为 mode:'restart'+succeeded,无 note 无法区分)。警示同时落 `MutationResult.message`。
- 审计 `mode` 字段(service.ts:753)记 **append 时刻**的引擎级 `this.mode`:懒更新下首次成功操作先翻 `this._mode='hot'`、后 append → 该条审计记 'hot';从未确认前 append → 记 'restart'。与 `MutationResult.mode` 语义不混用(已锁定 design §9.3 落地要点④);实现须注意「翻转」与「append」先后顺序。
- 观察命中率统计:`ObservationStats`(service.ts:75-81)新增 `unreflected` 计数;`observe()` 包装(service.ts:554-569)须把 'absent'/'still-active' 从 'timeout' 拆出、计 `unreflected + total`(design §5.3「命中/未反映/回滚统计」要求)。

---

## 2. 任务拆分(file-level)

| # | 任务 | 涉及文件 | 依赖 |
|---|---|---|---|
| T7.1 | health.ts 观察原语三分粒度:waitForActive/waitForHealthWithBlock 增 'absent'/'stuck';waitForGone 增 'still-active'/'stuck';waitForStable 不变 | src/host/health.ts | — |
| T7.2 | service.ts mode 可变 + 去 `ctx.get('hmr')` 探测 + 懒更新 getter | src/host/service.ts | — |
| T7.3 | install 去观察门禁 + 三分映射(active→hot/翻 mode;failed/stuck→回滚;absent→未反映) | src/host/service.ts | T7.1, T7.2 |
| T7.4 | enable/disable(mutateRow)三分映射 + 观察结果驱动 mode;effectiveMode 仅保留给 rollback + uninstall | src/host/service.ts | T7.1, T7.2 |
| T7.5 | 未反映处置:结果 message 警示 + 审计 mode:'restart' + `AuditRecord.note?` 警示原文(契约 §3 增 note? 字段,types.ts/tools.ts 同步) | src/host/service.ts、src/contract/types.ts、src/host/tools.ts、docs/01-contract.md | T7.3, T7.4 |
| T7.6 | 测试:health.spec 新增 absent/stuck/still-active;service.spec 重写 mode 区块(懒更新/三分/rollback 不翻转);install.spec 去 `ctx.provide('hmr')` 改由 states 反映观察;tools.spec 补未反映警示 render | tests/health.spec.ts、tests/service.spec.ts、tests/install.spec.ts、tests/tools.spec.ts | T7.1–T7.5 |
| T7.7 | 全量回归(typecheck/test)+ 独立演练 profile 实机(install/enable/disable/rollback 全链路 + 懒更新翻转)+ 审计回填 + plans/00 里程碑登记 | tests/、plans/00-plan-index.md、设计审计笔记(私有) | T7.1–T7.6 |

---

## 3. 实施顺序

1. **T7.1 + T7.2 并行**(health 粒度 + mode 可变,相互独立);
2. **T7.3 → T7.4 → T7.5**(install → enable/disable → 未反映警示,依赖 1 的结果);
3. **T7.6** 测试随实现同步补(每任务收尾即补对应用例,不堆到最后);
4. **T7.7** 全量回归 + 演练实机 + 回填。

> 每步 typecheck 零错误;本里程碑仅增契约 §3 `AuditRecord.note?`(v1 只增),其余契约/设计文档不新改(已锁定)。

---

## 4. 测试设计

### 4.1 新增用例

| 层 | 用例 | 夹具 | 路径要求 |
|---|---|---|---|
| 单元(health) | waitForActive/waitForHealthWithBlock:全程 undefined(install)→ 'absent';全程 null(enable disabled 基线)→ 'absent';先 null 后 loading 卡住 → 'stuck';active → 'active';failed → 'failed' | 假 readPhase 回调 | 真实函数 |
| 单元(health) | waitForGone:全程 'active' → 'still-active';active→loading 卡住 → 'stuck';null → 'gone';failed → 'failed' | 假 readPhase 回调 | 真实函数 |
| 单元(service) | mode 初始 'restart';enable/disable/install 观察「反映成功」后 mode 翻 'hot' 并保持;rollback 不翻 mode | 假 loader + states 映射 | 真实文件 |
| 单元(service) | 三分映射:enable 全程 null(仍 disabled)→ ok:true + mode:'restart' + restartRequired + message 含警示;enable loading 卡住 → 回滚;install 全程 undefined → 未反映保留;disable 仍 active → 未反映保留;disable 卡 loading → 回滚 | 假 loader + states 映射 | 真实文件 |
| 单元(service) | 审计:未反映记录 result:'succeeded' + mode:'restart' + note 含警示原文;mode 字段 = append 时刻引擎级 mode | 临时 profile | 真实文件 |
| 单元(tools) | renderMutation 对未反映结果输出警示句 | makeService 假 service | — |

### 4.2 既有用例更新(不回归)

| 文件 | 需更新点 |
|---|---|
| tests/service.spec.ts:103-124 | 「mode and snapshot」区块:mode 初始仍 'restart'(断言值不变,但语义从"无 hmr→restart"改为"初始 restart");「reports restartRequired」用例改为"观察未反映 → restart"(由 states 控制) |
| tests/install.spec.ts:109-127 | setup() 去掉 `ctx.provide('hmr', {})`;hot 判定改由 states 映射控制(观察窗口读到 active → hot);restart 用例改由 states 不反映 → absent → restart + 警示 |
| tests/install.spec.ts:139-158(restart)、160-171(hot) | 非 bundle restart 用例断言 r.mode='restart'(值不变)+ 补 message 含警示;hot 用例断言 r.mode='hot'(states 反映后翻转)。**注意**:去门禁后 restart 用例从「不观察、立即返回」变为「恒观察满窗口(≈1.5s)再判 absent」,执行时长与语义变化属预期、非回归卡慢 |
| tests/health.spec.ts:59-76 | waitForActive 超时用例:'loading' 卡住 → 由 'timeout' 改断言 'stuck';补 'absent' 用例 |
| tests/install.spec.ts:485-496 | 「observation stats」用例:去 `setup({hot:true})` 后 hot 判定改由 states 反映驱动;统计断言补 unreflected |
| tests/service.spec.ts:230-243 | 「disable user row」:239 断言 `r.mode==='restart'` → 新模型 disable 观察 gone 会翻 'hot',断言需改 `r.mode==='hot'`(或由 states 不反映控制为 'restart') |
| tests/service.spec.ts 其余 | `svc.mode`(引擎级)与 `r.mode`(观察驱动)须分开核对:svc.mode 初始 'restart' 不变;r.mode 依观察结果翻转。全 tests/ 假 hmr fixture 仅 install.spec:127 一处 `ctx.provide('hmr',{})`,service.spec 无假 hmr |

> 全部用例 MUST 走真实生产路径(patch 临时文件 + 真实解析 + 假 loader states 驱动观察);既有测试总数不减少,typecheck 零错误。

---

## 5. 契约/设计文档变更清单

本里程碑**几乎零文档变更**(契约 §9/设计 §5.3§9/ADR-0003/0007 已于锁定阶段完成,commit b64a383+b8304fc);唯一新增:契约 §3 `AuditRecord` 增 `note?` 可选字段(v1 只增,承载未反映警示原文,由计划 review 一致性 B1 驱动)。变更清单:

| 文档 | 变更 | 性质 |
|---|---|---|
| docs/01-contract.md §3 | AuditRecord 增 `note?: string`(可选,v1 只增) | 契约只增不改 |
| plans/00-plan-index.md | 里程碑表新增 M7 一行;风险登记 mode 行「已发生→ v0.1.5 修复」补实现状态 | 索引 |
| 设计审计笔记(私有,未随仓库发布) | 实测记录回填(演练 profile 经验判定验证) | 回填 |

---

## 6. 决策点(已定案,2026-08-16 用户拍板 + 双 review + 终审锁定)

1. **经验判定替代静态探测**:定案(contract §9.1/design §9.1)。
2. **未反映处置 = 保留 + restart + 强制警示**:定案(用户明确否决"disable 仍 active 应回滚"备选)。
3. **EngineSnapshot.mode 懒更新 = A 方案**(初始 restart → 首确认后 hot 并保持;rollback 不翻):定案(contract §9.1/ADR-0007)。
4. **警示落点**:MutationResult.message(不新增 AuditRecord 字段,避免契约范围扩大)。
5. **v1 兼容**:仅改判定方法,字段形状/值域不变,不升 v2(终审项 3 确认)。

---

## 7. 验收条件(M7 完成判定,逐项 MUST 满足)

- [ ] typecheck 零错误;pnpm test 全绿(既有 207 + 新增,不减少);
- [ ] health 三分粒度:absent/stuck/still-active 区分正确(单测覆盖);
- [ ] service mode:初始 'restart';首次 install/enable/disable「反映成功」后翻 'hot';rollback 不翻;
- [ ] install/enable/disable 三分映射:反映成功→hot;反映失败(failed/stuck)→自动回滚;未反映(absent/still-active)→保留 + restart + 警示(message 含警示句);
- [ ] 未反映结果 `ok:true` + `mode:'restart'` + `restartRequired:true` + `rollbackHandle` 照常;审计 `result:'succeeded'` + `mode:'restart'`;
- [ ] bundle install 仍恒 restart(不观察、不翻转);非宿主 profile 仍文件/restart 语义;
- [ ] 既有「无 hmr 静态探测」相关测试全部迁移到 states 驱动,无残留假 hmr fixture;
- [ ] 独立演练 profile 实机(非线上 web profile、非 3080 端口):install/enable/disable/rollback 全链路 + 懒更新翻转验证,验证后清理,结果回填设计审计笔记(私有)实测记录;真实 web profile 全程未触碰;
- [ ] plans/00-plan-index.md 里程碑表登记 M7;风险登记 mode 行补实现状态。

---

*本计划与 plans/00-plan-index.md 里程碑表衔接(M7 为 v0.1.4 验收 P2-2 修复的落地里程碑);实现前按仓库流程走计划 review(架构 + 一致性),锁定后由用户授权再落地代码。*
