# M6 详细计划 — v0.1.4 优化方向(A–H)

> 计划编号:hotplug-engine-PLAN-06 | 里程碑:M6 | 目标:落地 docs/03-optimization-directions.md 的 A–H 八个方向(pnpm 定位/Windows 可执行性/bundle 热加载编排/错误诊断/看板搜索/排序/状态色彩/高危停用警告),发布 v0.1.4
> 上位约束:docs/03-optimization-directions.md(方向文档,权威)、docs/01-contract.md(**契约 v1 已冻结**)、docs/02-design.md(详细设计)、adr/、AGENTS.md(红线/原则/推进流程)
> 规范关键词:MUST / MUST NOT / SHOULD / SHOULD NOT / MAY(RFC 语义)
> 范围声明:**M5 遗留 L3(local spec 路径作用域)不在本计划内**(用户已确认不处理);本计划只做 v1 向后兼容增量,不触发契约语义变更。

---

## 0. 背景与范围

契约 v1 已于 2026-08-14 冻结(M1–M4 全量 + M5 安全加固完成,188/188 测试全绿)。docs/03-optimization-directions.md(2026-08-16)登记两批优化方向:

- **引擎基础方向(A–D)**:来自实机安装 dsh-task-dag 暴露的四个问题;
- **看板 UI 方向(E–H)**:管理看板的搜索/排序/状态色彩/高危停用警告。

全部属于 **v1 向后兼容增量(只增不改,旧消费方忽略新字段)**,仅 C 的"动态服务装配评估"是 v2 评估项(只产出文档,不改契约)。本计划据此拆分任务、定验收与测试设计,按仓库流程先改契约/设计文档 → 双 subagent review → 暂停等用户确认后再落地实现。

### 现状代码核对结论(2026-08-16 已逐文件核对)

| 方向 | 关键现状(代码位置) |
|---|---|
| A | findPnpm(explicit?) 只做 explicit + PATH 搜索 pnpm / pnpm.cmd / pnpm.exe,返回 string 或 undefined,无 corepack/常见位置/候选清单;index.ts apply(ctx) 以 new HotplugEngineService(ctx) 构造、**不读 config**;service.ts 的 HotplugEngineServiceOptions.pnpmPath 字段已存在但未接 config |
| B | findPnpm 按扩展名固定顺序命中第一个存在文件,Windows 上无扩展名 pnpm(POSIX sh 脚本)先命中;runPnpm 仅当 win32 且扩展名为 .cmd/.bat 时走 cmd.exe,无扩展名 shim 直接 spawn → ENOENT,无错误分类 |
| C | service.ts install bundle 分支返回 mode restart + restartRequired true,message 无"重启一次之后热挂"引导;startupReconcile 已存在(重启后对账基础);客户端刷新提示已含于 clientNote |
| D | ErrorCodes 无 PNPM_*;pnpm 缺失/spawn 失败/pnpm add 失败统一抛 INSTALL_FAILED(service.ts:319/323/430/434);无 stage 归类 |
| E | panels.tsx 无搜索框,snap 直接 map;controller.ts 仅管面板开关,不管数据缓存 |
| F | InstalledPackage.installedAt 类型**已声明**(contract/types.ts:49 / 01-contract §3),但 snapshot() packages 构建(service.ts:164-168)只填 name/isBundle/version,**未填 installedAt** |
| G | panels.tsx 行级无启停色彩;CSS 已有 badge(source/status/result)色,无行级状态色 |
| H | RuntimeEntry **无 critical 字段**;panels.tsx 停用无二次确认、无核心插件警告 |

---

## 1. 方向实现方式(逐方向)

### 方向 A — pnpm 定位与可配置化(P0,v1 兼容)

- **方案**:index.ts 声明 cordis 插件 Config(经 apply(ctx, config) 第二参数传入,已核对 registry.d.ts:80 的 apply 签名),把 config.pnpmPath 传入 new HotplugEngineService(ctx, { pnpmPath: config?.pnpmPath });findPnpm 增加探测序列(显式 pnpmPath → corepack pnpm → PATH 常规搜索 → 常见安装位置),返回结构归一为候选对象(含 path、candidates[]、note),未命中时携带候选清单与安装指引。
- **Config schema**:用 schemastery(import { Schema } from '@deepseek-ai/schemastery'),Schema.object({ pnpmPath: Schema.string().optional() }) —— 官方生态 standard-schema 兼容,需把 @deepseek-ai/schemastery 加入 devDependencies(host 半段类型用)。缺省行为不变(PATH 搜索)→ v1 兼容。
- **涉及文件**:src/index.ts、src/host/installer.ts、src/host/service.ts(findPnpm 调用点适配新返回结构)、package.json(devDep schemastery)。
- **实现注**:findPnpm 返回类型若由 string|undefined 改为探测结果对象,将牵连 service.ts 的 install/uninstall 两处调用点(pnpm 变量)与 tests/installer.spec.ts:51/55 的现有断言(expect(findPnpm('C:/custom/pnpm.cmd')).toBe('C:/custom/pnpm.cmd'))。实施时二选一:(a) 返回类型改为对象,同步适配调用点与断言;(b) 最小改动——findPnpm 保留返回 string,另加 findPnpmCandidates() 返回候选清单供错误 detail 使用(推荐,遵循"最简实现"原则)。此选择在 T6.2 落定时定夺。
- **实现注(安全)**:配置的 pnpmPath 与探测到的候选路径,在嵌入 win32 cmd 命令行前 MUST 复用 CMD_METACHARS 守卫(与 spec 同规则,installer.ts:30),verifyPnpmExecutable 一并拒绝含元字符路径(防 cmd 注入);findPnpm 的 PATH 搜索 MUST 改用 path.delimiter(win32 为 ;、POSIX 为 :)修复 POSIX 失效。
- **Non-Goals**:不实现 pnpm 自举安装;不改变 spec 解析语义。

### 方向 B — Windows 可执行性健壮性(P0,v1 兼容)

- **方案**:findPnpm 在 process.platform 为 win32 时按 PATHEXT 语义排序候选(.exe/.com → .cmd/.bat → 无扩展名垫底/跳过);runPnpm 增加 spawn error 分类(ENOENT → 新码 HOTPLUG.PNPM_NOT_EXECUTABLE,detail 含文件路径与原因);新增 verifyPnpmExecutable(path) 探测助手(方向 A 复用)。
- **涉及文件**:src/host/installer.ts。
- **Non-Goals**:不改 cmd.exe /c 包装策略(已实测有效);不替用户修损坏安装。

### 方向 C — bundle 热加载编排与动态服务装配评估(P1,编排 v1 兼容 / 评估 v2)

- **方案(编排层,现实可达)**:
  1. service.ts install bundle 分支 message 增加"已写入 bundles 层,重启一次后生效;此后该插件启停/升级走热挂"的明确引导;
  2. 重启后自动化:复用 startupReconcile 对账,并在 message/文档明示"重启后需刷新页面加载客户端 bundle";
  3. 客户端 bundle 联动:契约消息已含 clientNote,升级为 UI 引导(面板 footer 已有,补强 install 结果 message 措辞);
  4. **v2 评估项**:产出动态服务装配评估文档(纯客户端 bundle 能否经 dsh-client-modules/SSE rebuilt 免重启加载,可行性 + 风险 + 是否升 v2 建议),作为 docs 独立文档,**不改契约**。
- **涉及文件**:src/host/service.ts(message 引导)、docs(新评估文档)。
- **MUST NOT** 绕过官方内核(不实现自定义热应用/图重组/loader);不承诺"bundle 免重启"为 v1 能力。

### 方向 D — 错误模型细分与可操作诊断(P1,v1 兼容)

- **方案**:
  1. contract/types.ts 新增错误码(只增不删):PNPM_NOT_FOUND / PNPM_NOT_EXECUTABLE / PNPM_ADD_FAILED;INSTALL_FAILED 保留为兼容码;
  2. **兼容策略(关键,双码共发)**:三类 pnpm 失败在 MutationResult.errors[] 中**同时携带新细分码与旧 INSTALL_FAILED 码**(例:errors = [{code:PNPM_ADD_FAILED, stage:'install', detail}, {code:INSTALL_FAILED, detail}])——旧消费方按 INSTALL_FAILED 匹配仍命中、新消费方按 PNPM_* 得到细分;契约明示"以新码为准、INSTALL_FAILED 仅供兼容识别"(避免旧消费方双处理歧义);
  3. detail 携带可操作建议与关键上下文(搜索过的位置、退出码、输出片段,经 sanitizeTerminal 清洗);
  4. 失败阶段归类:gate 失败 / 安装失败 / 观察失败,MutationResult.errors[] 附加可选 stage 字段。
- **涉及文件**:src/contract/types.ts、src/host/installer.ts(spawn 分类)、src/host/service.ts(映射 + stage + 双码共发)。
- **契约影响**:错误码枚举新增(01-contract §8 新增三行),errors[].stage 为新增可选字段;INSTALL_FAILED 语义不变(保留为兼容码,双码共发)。

### 方向 E — 看板搜索(P1,v1 兼容,纯 client)

- **方案**:panels.tsx 面板顶部搜索框,按 entryId/moduleName(插件名)与 source(bundle/insert/user)过滤;即时过滤、大小写不敏感、支持来源下拉;空态明确。
- **实现注**:搜索状态放 panels.tsx(它持有 snap 缓存),不强行引入 controller 数据层(03 文档"controller 持有缓存"与实际代码不符,以实际为准;核心"纯 client 过滤"不变)。
- **涉及文件**:src/client/panels.tsx、src/client/i18n.ts(新增文案 key)。

### 方向 F — 看板排序 + installedAt(P1,v1 兼容 + host 字段填充)

- **方案**:
  1. **host 侧填充**:service.ts snapshot() 给 packages 填 installedAt(ISO 时间)——来源:node_modules/<name>/package.json 的 mtime;缺失置 null(向后兼容)。**不做审计日志兜底**(架构 review:install 审计行 target=undefined 且只存 spec,无法映射回包名,兜底路径不可落地);
  2. **client 侧排序器**:四维 × 两向(安装时间/插件名/来源/启停),稳定排序(同值按 entryId 字典序),表头可点击切换,与搜索叠加;
  3. installedAt 为近似值(文件系统 mtime),文档明示非精确审计时间。
- **涉及文件**:src/host/service.ts(填充 installedAt)、src/client/panels.tsx、src/client/i18n.ts。
- **契约影响**:installedAt 字段**类型已存在**,本方向是"填充实现 + 语义注(01-contract §3 注 / 02-design)",无需新增类型字段。

### 方向 G — 看板状态色彩(P2,v1 兼容,纯 client)

- **方案**:行级状态色——enabled + fiberPhase 综合判定(active/loading→挂载绿;disabled/null→停用红;failed→异常色不并入绿/红);CSS 用语义变量(映射 --dsw-alias-state-success-* / --dsw-alias-state-error-*),不硬编码 hex;data-state 属性驱动;色弱可读(绿/红之外保留 ● 启用 / ○ 停用 文字图标)。
- **涉及文件**:src/client/mount.tsx(CSS)、src/client/panels.tsx、src/client/i18n.ts。

### 方向 H — 高危停用警告(P1,v1 兼容 + host 字段增量)

- **方案**:
  1. **host 侧**:RuntimeEntry 新增 critical 可选字段(向后兼容);service.ts snapshot() 依据内置核心清单 + 前缀规则判定,config 可覆盖豁免/追加;核心清单为引擎内常量(可覆盖、随内核升级对账,不冻结失真)。**"非可选插件"谓词定义**:内置核心清单显式列名为主判据(03 文档举例 @deepseek-ai/dsh-session / dsh-agent / dsh-tools / dsh-web / dsh-llm / dsh-sandbox / dsh-approval 等),前缀规则 @deepseek-ai/ 仅作默认兜底、非唯一判据;
  2. **client 侧**:critical 且 !enabled → 警告行色 + 停用操作二次确认(在既有确认流程之上叠加);面板头部聚合警告条("N 个核心插件已停用")。
- **涉及文件**:src/contract/types.ts、src/host/service.ts(或新核心清单常量文件)、src/client/panels.tsx、src/client/i18n.ts、src/client/mount.tsx(CSS)。
- **契约影响**:RuntimeEntry.critical 为新增可选字段(01-contract §3 新增)。
- **Non-Goals**:核心清单只做提示,不强制禁止;不把第三方标记为 critical(除非用户配置);不改停用审批策略。

---

## 2. 任务拆分(file-level)

| # | 任务 | 方向 | 涉及文件 | 依赖 |
|---|---|---|---|---|
| T6.1 | pnpmPath 可配置:Config schema + apply 读 config(确认 schemastery 运行时由 cordis 传递依赖解析,否则移入 dependencies,防发布包实机 boot ReferenceError) | A | src/index.ts、package.json(devDep schemastery) | — |
| T6.2 | findPnpm 探测序列增强 + 候选清单 + 可操作指引 | A | src/host/installer.ts、src/host/service.ts | T6.1 |
| T6.3 | Windows PATHEXT 排序 + spawn 预检/错误分类 | B | src/host/installer.ts | T6.2 |
| T6.4 | bundle 首装/升级引导 message + 重启后对账明示 | C | src/host/service.ts | — |
| T6.5 | 动态服务装配评估文档(v2 候选,纯文档) | C | docs/(新评估文档) | — |
| T6.6 | 错误码新增 PNPM_* + 契约 §8 | D | src/contract/types.ts、docs/01-contract.md | — |
| T6.7 | 错误映射 + detail 可操作建议 + stage 字段(双码共发覆盖 install/uninstall 的 pnpm-not-found 与 add/remove 失败两类站点,即 service.ts:319/430 与 :323/434) | D | src/host/installer.ts、src/host/service.ts、src/contract/types.ts | T6.6 |
| T6.8 | 看板搜索(插件名/来源) | E | src/client/panels.tsx、src/client/i18n.ts | — |
| T6.9 | snapshot 填 installedAt + 契约/设计语义注 | F | src/host/service.ts、docs/01-contract.md、docs/02-design.md | — |
| T6.10 | 看板排序(四维两向 + 表头点击) | F | src/client/panels.tsx、src/client/i18n.ts | T6.9 |
| T6.11 | 看板状态色彩(行级绿/红 + 色弱标识) | G | src/client/mount.tsx、src/client/panels.tsx、src/client/i18n.ts | — |
| T6.12 | critical 字段 + host 分类(核心清单) + 契约 §3 | H | src/contract/types.ts、src/host/service.ts、docs/01-contract.md | — |
| T6.13 | 高危停用警告(行级 + 二次确认 + 聚合条) | H | src/client/panels.tsx、src/client/i18n.ts、src/client/mount.tsx | T6.12 |
| T6.14 | 索引登记 M6 + 文档回填 | 全部 | docs/00-index.md、plans/00-plan-index.md、docs/03-optimization-directions.md | — |
| T6.15 | 全量回归 + 演练实机 + 审计回填 | 全部 | tests/、设计审计笔记(私有,未随仓库发布) | T6.1–T6.13 |

---

## 3. 实施顺序

1. **契约/设计文档先行**(T6.6/T6.9 文档注、T6.12 契约字段、T6.5 评估文档、T6.14 索引):先改 01-contract / 02-design / 00-index / plans-00 / 03 标注,再动代码 —— 这是"复杂内容推进门"的前置;
2. **A/B 基础**(T6.1→T6.2→T6.3):直接影响安装/启停可用性,先落地;
3. **D 诊断**(T6.7):依赖 A/B 的错误分类;
4. **C 编排**(T6.4):bundle 引导 message(独立,可与 2/3 并行);T6.5 评估文档独立;
5. **看板 UI**(T6.8→T6.9/T6.10→T6.11→T6.12/T6.13):F 的 installedAt 填充(T6.9,host 侧)先于排序(T6.10,client);G 色彩(T6.11)先于 H 警告(T6.12/T6.13)为**有意调整**——G 只加行级状态色、风险极低,先落地可让 H 的"critical 且停用"警告复用同一 data-state 体系;03 建议 H 先于 G,此处以"先视觉基础、后安全提示叠加"为序,不改变方向语义。注:T6.9/T6.12 的 host+契约部分属"文档先行"范畴(步骤 1),此处仅 client UI 部分;
6. **T6.15** 全量回归 + 演练 profile 实机(安装/启停/回滚全链路 + 3080 同源/越权用例),验证后清理,结果回填设计审计笔记(私有)实测记录。

> 每个方向收尾回填 docs/03-optimization-directions.md 验收标准打勾,未过项 MUST NOT 合并。

---

## 4. 测试设计(新增)

| 层 | 用例 | 夹具 | 路径要求 |
|---|---|---|---|
| 单元 | A:findPnpm 探测序列(显式/corepack/PATH/常见位置)+ 未命中候选清单 + POSIX PATH 分隔符(path.delimiter);Config 传参 pnpmPath + pnpmPath 元字符守卫 | 临时目录 + 假 PATH | 真实文件 |
| 单元 | B:Windows PATHEXT 排序(无扩展名 shim + .cmd 并存命中 .cmd;仅无扩展名返回可操作错误);runPnpm ENOENT 分类 | 临时目录假 shim | 真实文件 |
| 单元 | D:四种失败(未装 pnpm/shim 不可执行/add 非零退出/观察超时)分别返回可区分错误码 + stage;旧码兼容(双码共发)断言;errors[].detail 经 sanitizeTerminal 清洗断言(原始输出片段不回显) | 注入假 pnpm 结果 | — |
| 单元 | F:installedAt 填充(mtime 路径,null 排末尾;不做审计兜底) | 临时 profile | 真实文件 |
| 单元 | H:critical 分类(核心清单命中/前缀规则/config 豁免) | 临时 profile | 真实文件 |
| 集成 | C:bundle install message 含"重启一次之后热挂"引导 | 假 loader + 临时 profile | 真实文件 |
| jsdom | E/F/G/H:搜索过滤(SSE 更新后不丢)/四维两向排序/行级色彩 data-state/停用二次确认 + 聚合警告条 | client.spec.tsx 扩展 | jsdom 交互冒烟 |
| e2e | install(非 bundle)→独立演练 profile 验证→rollback;bundle install→restart 引导 | 独立演练 profile(web 形态克隆,非 3080 端口) | 验证后清理 |

> 所有用例 MUST 走真实生产路径(patch 写临时文件 + 真实解析;禁止直调内部函数绕过);既有 188 测试不回归,typecheck 零错误。

---

## 5. 契约/设计文档变更清单(推进门前置)

| 文档 | 变更 | 性质 |
|---|---|---|
| docs/01-contract.md §3 | RuntimeEntry 新增 critical(可选);MutationResult.errors[] 元素新增可选 stage | 契约只增不改 |
| docs/01-contract.md §3 注 | InstalledPackage.installedAt 补充取值语义(package.json mtime,近似值) | 契约说明 |
| docs/01-contract.md §8 | 新增 PNPM_NOT_FOUND / PNPM_NOT_EXECUTABLE / PNPM_ADD_FAILED(INSTALL_FAILED 保留为兼容码) | 契约只增不改 |
| docs/02-design.md | 新增 §13(v0.1.4 优化方向实现设计:pnpm 探测序列/PATHEXT/错误码映射/installedAt/critical 清单/client 搜索排序色彩警告);修订 §3.1(INSTALL_FAILED→PNPM_ADD_FAILED 细分)、§3.6(pnpm 探测指向 §13.1) | 设计增量 + 修订 |
| docs/00-index.md | 文档清单登记 03→plans/06(v0.1.4) | 索引 |
| plans/00-plan-index.md | 里程碑表新增 M6 一行 | 索引 |
| docs/03-optimization-directions.md | §6 标注计划已建;§E 修正 controller 描述;§7 基线 166→188 | 回填 |

---

## 6. 决策点(已定案,2026-08-16 用户确认全部按推荐执行)

1. **方向 A Config 载体**:**定案**引入 @deepseek-ai/schemastery(官方生态 standard-schema 兼容,加入 devDependencies)。
2. **方向 H 核心清单范围**:**定案**以 --dump-config 实测 web profile boot 图定稿内置核心清单。
3. **方向 C 评估文档落点**:**定案**独立 docs/04-dynamic-assembly-eval.md。
4. **方向 D PNPM 错误码兼容策略**:**定案**errors[] 双码共发(新码 + 旧 INSTALL_FAILED 并存,旧消费方仍命中;已写入 §1 方向 D 与 02-design §13.4)。

---

## 7. 验收条件(M6 完成判定,逐项 MUST 满足)

- [ ] typecheck 零错误;pnpm test 全绿(既有 188 + 新增);
- [ ] 方向 A/B:未装 pnpm 环境返回含安装指引/搜索目录的可操作错误;配置 pnpmPath 后 install 成功;Windows 无扩展名 shim 环境自动命中 .cmd;POSIX 回归不受影响;
- [ ] 方向 C:bundle install message 含"重启一次之后热挂";评估文档产出;客户端刷新引导明确;
- [ ] 方向 D:四种失败场景错误码可区分;旧码兼容;stage 归类正确;
- [ ] 方向 E/F/G/H:搜索/排序/色彩/警告在 jsdom 冒烟通过;installedAt/critical 字段为可选、旧消费方不受影响;
- [ ] client 变更走 tsdown 双面构建,lib/client.js 可复现;
- [ ] 独立演练 profile 实机(非线上 web profile、非 3080 端口):安装/启停/回滚全链路回归,验证后清理,结果回填设计审计笔记(私有)实测记录;真实 web profile 全程未触碰(模板原样、3080 在线);
- [ ] docs/03-optimization-directions.md 各方向验收标准回填打勾;未过项 MUST NOT 合并。

---

*本计划与 plans/00-plan-index.md 里程碑表衔接(M6 为 v1 冻结 + M5 加固后的优化里程碑);落地前按仓库流程走双 subagent review(架构 + 一致性),暂停等用户确认后再实现。*
