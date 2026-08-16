# 优化方向 — dsh-hotplug-engine

> 文档编号:`hotplug-engine-OPT-03` | 性质:方向文档(非契约、非计划) | 版本:0.1(2026-08-16)
> 上位约束:AGENTS.md(红线/原则/防线);00-index.md(索引与决策总览);01-contract.md(**契约 v1 已冻结**);02-design.md(详细设计);adr/ADR-0006(对外接口与 v2 候选登记)
> 适用对象:引擎实现者、消费方(市场/agent/宿主插件)、计划制定者
> 规范关键词:MUST / MUST NOT / SHOULD / SHOULD NOT / MAY(RFC 语义)
> 文档定位:**本文件只定方向与验收,不写实施计划**;计划另行在 `plans/06-*.md` 按仓库流程制定。

---

## 1. 背景与目的

契约 v1 已于 2026-08-14 冻结(M1–M4 全量完成、166/166 测试全绿、双 review 通过)。v1 冻结后,新能力分为两类:

1. **v1 内向后兼容增量**(只增不改,旧消费方忽略新字段)——本文件大部分方向属于此类;
2. **v2 语义变更**(需新 ADR,旧版并行降级期)——本文件涉及的如"bundle 免重启热挂"等受官方内核约束的方向,只做编排层评估,不承诺突破。

本文件登记两批优化方向:

- **引擎基础方向(A–D)**:来自 2026-08-16 实机安装 `dsh-task-dag` 时暴露的四个问题(pnpm 发现、Windows shim 可执行性、bundle 重启约束、错误可诊断性);
- **看板 UI 方向(E–H)**:管理看板的搜索、排序、状态色彩与高危停用警告四项 UX 增强。

每个方向给出:现状与问题 → 目标 → 方案要点 → 范围与非目标 → 依赖与数据缺口 → 验收标准 → 归属(v1 兼容 / v2 评估)。

## 2. 方向总览

| 编号 | 方向 | 类别 | 优先级建议 | 归属 |
|---|---|---|---|---|
| A | pnpm 定位与可配置化 | 引擎基础 | P0 | v1 兼容 |
| B | Windows 可执行性健壮性 | 引擎基础 | P0 | v1 兼容 |
| C | bundle 热加载编排与动态服务装配评估 | 引擎基础 | P1 | 编排 v1 兼容 / 装配评估 v2 |
| D | 错误模型细分与可操作诊断 | 引擎基础 | P1 | v1 兼容 |
| E | 看板搜索(插件名 / 来源) | 看板 UI | P1 | v1 兼容 |
| F | 看板排序(安装时间 / 插件名 / 来源 / 启停) | 看板 UI | P1 | v1 兼容(+host 字段增量) |
| G | 看板状态色彩(糖果绿=挂载 / 樱桃红=停用) | 看板 UI | P2 | v1 兼容 |
| H | 高危停用警告(官方核心插件) | 看板 UI | P1 | v1 兼容(+host 字段增量) |

优先级建议依据:直接影响"安装/启停可用性"(A/B)、影响日常运维安全(C 编排/H)、影响检索效率(E/F)、纯视觉增强(G)。

---

## 3. 引擎基础方向

### 方向 A — pnpm 定位与可配置化

**现状与问题**

- `findPnpm()`(`src/host/installer.ts`)只做两件事:优先使用构造期注入的 `pnpmPath`,否则按 `PATH` 逐目录找 `pnpm / pnpm.cmd / pnpm.exe`。
- 插件入口 `src/index.ts` 的 `apply(ctx)` 以 `new HotplugEngineService(ctx)` 构造,**不读取插件 config**,`pnpmPath` 无法由用户配置——必须改代码重建 bundle 才能注入。
- 实机问题(2026-08-16):目标机 PATH 无 pnpm → 引擎报 `pnpm not found on PATH (install pnpm to manage plugins)`,且不提示如何安装、不提示已搜索的目录,用户只能手工装全局 pnpm(还需处理权限与 shim 问题,见方向 B)。

**目标**

1. `pnpmPath` 可配置:插件 config schema 支持(如 `hotplug-engine.pnpmPath`),用户可在 profile patch config / settings 中显式指定;
2. `findPnpm` 发现能力增强:corepack 探测(`corepack pnpm`)、常见安装位置扫描(全局 npm bin、corepack shims、`LOCALAPPDATA\pnpm` 等)、保留 PATH 搜索;
3. 未找到时返回**可操作指引**:建议的安装命令 + 已搜索的位置清单,不再是一句裸错误。

**方案要点**

- 插件入口读取 `ctx.config`(cordis 插件 config),把 `pnpmPath` 传入 `HotplugEngineServiceOptions`;缺省行为不变(PATH 搜索)→ v1 兼容。
- `findPnpm` 增加探测序列(按可用性排序,首中即返):显式 `pnpmPath` → corepack pnpm(需验证可执行,见方向 B)→ PATH 常规搜索 → 常见安装位置。
- 探测结果归一:返回 `{ path?, candidates[], note }`,未命中时错误 detail 携带候选清单与安装指引。

**范围与非目标**

- 不实现 pnpm 自举安装(不替用户改系统环境);
- 不改变 spec 解析语义(仍是"spec → 安全安装",引擎不猜来源)。

**依赖与数据缺口**

- 无契约变更(错误 detail 属于既有 `HOTPLUG.INSTALL.FAILED` 的 detail 内容,方向 D 会细分)。

**验收标准**

- [x] 未装 pnpm 的干净环境:install 返回的 detail 含安装指引与搜索目录,错误码可归类(见方向 D);
- [x] 配置 `pnpmPath` 指向任意可执行 pnpm 后 install 成功;不配置时行为与 v1 一致;
- [x] corepack 环境(pnpm 经 corepack 提供)可被探测到;
- [x] 既有 188 测试全绿 + 新增探测序列单测(真实临时目录)。

### 方向 B — Windows 可执行性健壮性

**现状与问题**

- `findPnpm` 按 `['pnpm', 'pnpm.cmd', 'pnpm.exe']` 顺序命中**第一个存在的文件**。Windows 上 npm 全局安装会同时生成无扩展名的 `pnpm`(POSIX sh 脚本)与 `pnpm.cmd`;无扩展名文件先被命中。
- `runPnpm()` 仅以扩展名判断执行方式:非 `.cmd/.bat` 直接 `spawn(pnpmPath, ...)` → Windows 无法直接 spawn 无扩展名 sh 脚本 → `spawn error: ENOENT`。
- 实机问题(2026-08-16):`pnpm add failed (exit null): spawn ...\npm\pnpm ENOENT`,用户需手工改名 shim 才能继续,且错误信息无指向性。

**目标**

1. Windows 上按 **PATHEXT 语义**选择可执行文件(`.exe/.com/.cmd/.bat` 优先,无扩展名 shim 垫底或跳过);
2. spawn 前做**可执行性预检**(文件存在 + 扩展名规则 + 权限),失败归入明确错误码(见方向 D),不再裸抛 ENOENT;
3. 跨平台语义一致:POSIX 上仍按 `pnpm` 优先。

**方案要点**

- `findPnpm` 在 `process.platform === 'win32'` 时按扩展名分组排序候选:`.exe/.com` → `.cmd/.bat` → 无扩展名(仅当无其它候选时兜底,且 `runPnpm` 对无扩展名候选先做 spawn 冒烟或直接拒绝并提示);
- `runPnpm` 增加 spawn error 分类:ENOENT → `HOTPLUG.PNPM_NOT_EXECUTABLE`(detail 含文件路径与原因);其它 → 保留原始信息;
- 新增 `verifyPnpmExecutable(path)` 探测助手(方向 A 复用)。

**范围与非目标**

- 不改 `cmd.exe /c` 包装策略(既有双引号策略已实测有效);
- 不替用户修复损坏的全局安装,只把问题讲清楚。

**验收标准**

- [x] 存在无扩展名 shim + `pnpm.cmd` 的环境:自动命中 `pnpm.cmd`,install 成功(无需手工改名);
- [x] 只有无扩展名 shim 的环境:返回可操作错误(建议改用 pnpm.cmd / 重新安装),不裸 ENOENT;
- [x] POSIX 环境回归不受影响;
- [x] 新增单测覆盖三类环境。

### 方向 C — bundle 热加载编排与动态服务装配评估

**现状与问题**

- bundle 包(声明 `dsh.bundle.patch`)安装后 `mode:'restart'`,必须重启进程才生效——这是**官方内核机制**(bundles 层 boot 时加载、官方模块级 partial reload 被 TODO 禁用、pkgMeta 负缓存永不过期),引擎不能绕过。
- 实机问题(2026-08-16):用户期望"热加载",但 `dsh-task-dag` 是 bundle → 只能提示重启;引擎当前只返回 `restartRequired:true`,不做任何后续编排。

**目标(编排层,现实可达)**

1. **首装/升级分化**:bundle 首装后引导一次重启,并明确告知"此后插件变更(启停/升级)走热挂";
2. **重启后自动化**:重启后自动对账并提示刷新页面(已有启动对账基础);
3. **客户端 bundle 联动**:装完即推送 SSE `rebuilt` 语义提示(客户端新 bundle 需刷新页面加载,契约消息已含,可升级为 UI 引导);
4. **v2 评估项**:动态服务装配评估——评估纯客户端 bundle 能否经 `dsh-client-modules`/SSE rebuilt 免重启加载,形成可行性报告后决定是否升 v2。

**范围与非目标**

- MUST NOT 绕过官方内核(不实现自定义热应用/图重组/loader);
- 不承诺"bundle 免重启"为 v1 能力;
- 动态服务装配评估输出为评估文档 + ADR 候选,不直接改契约。

**验收标准**

- [x] 实机:安装 bundle → 返回含"重启一次,之后热挂"的明确指引 → 重启后对账正常、页面刷新后插件可用;
- [x] 客户端 bundle 安装后,SSE 事件/UI 提示引导用户刷新(而非只有控制台信息);
- [x] v2 评估文档产出(可行性结论 + 风险 + 是否升 v2 建议)。

### 方向 D — 错误模型细分与可操作诊断

**现状与问题**

- 错误统一走 `HOTPLUG.INSTALL.FAILED` 等粗粒度码,detail 直接拼接原始输出;
- 实机问题(2026-08-16):pnpm 缺失与 pnpm spawn 失败分别表现为 `pnpm not found on PATH` 和 `spawn error: ENOENT`,用户无法区分"没装/装坏了/命令失败",也无修复建议。

**目标**

1. 错误码细分:`HOTPLUG.PNPM_NOT_FOUND` / `HOTPLUG.PNPM_NOT_EXECUTABLE` / `HOTPLUG.PNPM_ADD_FAILED`(保留退出码)等,`INSTALL_FAILED` 保留为兼容码(v1 内只增不改,errors[] 双码共发);
2. detail 携带**可操作建议**与关键上下文(搜索过的位置、退出码、输出片段,经 `sanitizeTerminal` 清洗);
3. 失败阶段归类:gate 失败 / 安装失败 / 观察失败,返回结构可区分(新增字段,向后兼容)。

**方案要点**

- 扩展 `src/contract/types.ts` 错误码枚举(新增不删改);
- `installer.ts` 内把 spawn/pnpm 相关失败映射到新码;
- `service.ts` 失败摘要按三阶段归类并在 `MutationResult.errors[]` 附加 `stage` 字段(可选)。

**范围与非目标**

- 不回显未清洗的终端输出(沿用 sanitize 策略);
- 不改变既有成功返回结构。

**验收标准**

- [x] 四种失败场景(未装 pnpm / shim 不可执行 / pnpm add 非零退出 / 观察超时)分别返回可区分的错误码与建议;
- [x] 旧消费方按旧码处理不破坏(新码附加于既有 detail/errors);
- [x] 测试覆盖四场景 + 清洗断言。

---

## 4. 看板 UI 方向

> 现状基线(`src/client/`,2026-08-16):管理面板为「entries / packages / insert rows / operations / audit」5 个 Tab 表格,已有 source/status 徽章与 DSH 主题色(`--dsw-alias-state-*`);**无搜索、无排序、无启停色彩、无核心插件警告**。数据来自 REST snapshot + SSE。
> 通用约定:UI 方向全部为纯 client 增强(除 F/H 所需字段外),不改变服务契约语义;新增依赖字段按契约 v1"只增不改"原则扩展。

### 方向 E — 看板搜索(插件名 / 来源)

**现状与问题**

- 插件多(官方 100+ 行 + 第三方)时,表格无法按名称/来源定位,只能滚动目视。

**目标**

- 面板顶部提供搜索框,支持按 **entryId / moduleName(插件名)** 与 **source(来源:bundle / insert / user)** 过滤;
- 即时过滤(输入即过滤,无额外请求),大小写不敏感,支持来源中文/英文标签;
- 搜索结果为空时给出明确空态。

**方案要点**

- 纯 client 过滤:`panels.tsx` 持有 snapshot 缓存(实际代码中 controller.ts 仅管面板开关,见 plans/06 方向 E 实现注),搜索词作用于 entries/packages/insertRows 三份列表;
- 来源过滤与文本搜索可叠加(下拉 + 输入);
- 过滤状态随 SSE snapshot 帧更新保持。

**范围与非目标**

- 不做服务端搜索(数据量小,client 过滤足够);
- 不做正则/模糊打分(前缀/包含匹配即可)。

**验收标准**

- [x] 按插件名片段、来源、两者叠加均能正确过滤;SSE 更新后过滤结果不丢;
- [x] 空态与恢复清空行为正确;jsdom 交互冒烟覆盖。

### 方向 F — 看板排序(安装时间 / 插件名 / 来源 / 启停)

**现状与问题**

- 表格顺序固定(官方 loader 树顺序),无法按运维视角排序;
- **snapshot 无 `installedAt` 字段**:packages 只有 name/isBundle/version,entries 只有 entryId/moduleName/source/enabled/fiberPhase/managed——"按安装时间排序"当前无数据来源。

**目标**

- 提供四维排序:安装时间(新→旧 / 旧→新)、插件名(字典序)、来源名(bundle/insert/user)、是否启用(启用在前 / 停用在前);
- 表头可点击切换维度与方向,默认安装时间降序或插件名(实施时定);
- 排序与搜索叠加生效。

**方案要点**

- **host 侧增量**:snapshot 的 packages/entries 增加 `installedAt`(ISO 时间)——来源:node_modules/<name>/package.json 的 mtime;仅新增字段,缺失时置 undefined(向后兼容);
- client 侧排序器:稳定排序(同值按 entryId 字典序),随 SSE 更新保持;
- UI:表头箭头指示当前维度/方向。

**范围与非目标**

- 不做多列复合排序(单维即可);
- `installedAt` 为近似值(文件系统 mtime),文档明示非精确审计时间。

**验收标准**

- [x] 四维 × 两向排序正确且稳定;null installedAt 排末尾;与搜索叠加正确;
- [x] 契约字段新增为可选,旧 snapshot 消费方不受影响;host 侧单测覆盖 mtime 路径。

### 方向 G — 看板状态色彩(糖果绿=挂载 / 樱桃红=停用)

**现状与问题**

- 当前仅 source/操作状态有徽章色;**启用/停用状态无颜色表达**,行级"哪个插件当前挂载/停用"需要逐行看 `enabled` 列文本。

**目标**

- 行级状态色:**浅色糖果绿**(mint green)= 已挂载(启用);**浅色樱桃红**(cherry red)= 已停用;
- 挂载与否以 `enabled` + `fiberPhase` 综合判定(active/loading→挂载;disabled/null→停用;failed→异常色,不并入绿/红);
- 适配 DSH 亮/暗双主题,色弱可读(绿/红之外保留图标或文字标注,如 `● 启用 / ○ 停用`)。

**方案要点**

- client CSS 使用语义变量(映射到 `--dsw-alias-state-success-*` / `--dsw-alias-state-error-*` 或新增本地 token),不硬编码 hex;
- 行级 `data-state` 属性驱动,保持既有 badge 体系不变;
- 操作按钮与行色联动:停用行红色系、挂载行绿色系,但**不改变现有交互/确认流程**。

**范围与非目标**

- 不重做整个主题系统;颜色仅用于状态表达,不承载唯一信息(文字/图标并存);
- 不改动服务端状态判定逻辑。

**验收标准**

- [x] 挂载/停用/异常三种行态在亮暗主题下均可辨识;色弱模式下仍有非色彩标识;
- [x] 既有徽章/表格样式回归通过(jsdom 快照)。

### 方向 H — 高危停用警告(官方核心插件)

**现状与问题**

- 官方核心插件(如 `@deepseek-ai/dsh-session`、`dsh-agent`、`dsh-tools`、`dsh-web`、`dsh-llm`、`dsh-sandbox`、`dsh-approval` 等)被停用时,当前面板**无任何提示**,用户可能误停用导致 profile 行为异常/起不来(boot fail-loud)。

**目标**

- 对**官方核心插件**的停用给出高危警告:行级警告标识 + 停用操作二次确认;
- 分类规则可维护:内置核心清单 + 前缀规则(如 `@deepseek-ai/` 且非可选插件),并允许用户配置豁免/追加;
- 已停用的核心插件在列表与重启前均有醒目提示(如警告条:"N 个核心插件已停用,可能影响稳定性")。

**方案要点**

- **host 侧增量**:snapshot entries 增加 `critical?: boolean`(分类由 host 依据核心清单判定,client 不重复维护规则);核心清单作为引擎内常量 + config 可覆盖;
- client 侧:critical && !enabled → 警告行色(沿用错误/警告语义色)+ 停用操作需二次确认(在既有审批/确认流程之上叠加);
- 面板头部聚合警告条。

**范围与非目标**

- 核心清单只做**提示**,不做强制禁止(用户有权停用,但须知情);
- 不把第三方插件标记为 critical(除非用户配置);
- 不改变停用操作的审批策略。

**验收标准**

- [x] 停用任一内置核心插件:面板出现行级警告 + 二次确认;多个停用出现聚合警告条;
- [x] 配置豁免后不再警告;非核心插件停用无警告;
- [x] host 分类单测 + client jsdom 交互冒烟覆盖。

---

## 5. 依赖与数据面缺口汇总

| 方向 | 所需数据 | 现状 | 方案 |
|---|---|---|---|
| F | `installedAt` | snapshot 无 | host 增量字段(package.json mtime),可选、null 可 |
| H | `critical` 分类 | snapshot 无 | host 增量字段(核心清单 + 前缀规则 + config 覆盖),可选 |
| E/G | 无新增 | — | 纯 client |
| A/B/D | 无契约变更 | 错误码/探测内部 | 错误码枚举新增、detail 增强 |

> 契约影响:仅新增可选字段/错误码,符合 v1"只增不改"原则;若任何一项演变为语义变更(如强制 token、禁止停用核心插件),按流程升 v2 并新增 ADR。

## 6. 计划制定指引(后续动作)

> ✅ 计划已建(2026-08-16):`plans/06-M6-optimization.md`(v0.1.4 优化方向实施计划,任务拆分/验收/测试设计已定,待双 subagent review 后落地)。

1. 按仓库流程在 `plans/06-*.md` 制定实施计划:每个方向拆任务 + 验收条件 + 测试设计,顺序建议 A/B(基础)→ D(诊断)→ E/F(看板基础)→ H(安全提示)→ G(视觉)→ C(v2 评估文档);
2. 复杂内容(涉及契约字段新增、双面构建、UI 重构)先改本文件/相关设计文档,再走**双 subagent review**(架构 + 一致性),暂停等待用户确认后落地;
3. 所有写操作(含 profile 演练)沿用:真实路径测试、typecheck 零错误、测试全绿、演练 profile 实机验证后回填审计;
4. 每个方向收尾回填本文件验收标准打勾,未过项 MUST NOT 合并。

## 7. 验收与回归总要求

- `pnpm typecheck` 零错误;`pnpm test` 全绿(既有 188 + 新增);
- client 变更走 tsdown 双面构建,`lib/client.js` 可复现;
- UI 方向需 jsdom 交互冒烟(搜索/排序/确认弹窗);
- 实机:web profile 安装/启停/回滚全链路回归,写操作在演练 profile 验证后清理。
