# AGENTS.md

This file provides guidance to agent tools when working with code in this repository.

## 仓库现状

本仓库是 **dsh-hotplug-engine**(「DSH 热插拔执行引擎」)的项目目录。定位:一个 host 侧服务插件,把「安装→注册→应用→回滚→审计」热插拔执行链做成**任何市场 / agent / 宿主插件都能调用的可靠服务**;自己不拥有目录、不做发现与策展——与市场是"执行层 vs 发现层"的分工,**不是竞争关系**。

- **当前状态(2026-08-14)**:设计/契约/计划已定;**M1–M4 全量实现完成并锁定,契约 v1 已冻结**(01-contract.md 版本 1.0):M1(最小闭环)/M2(安装闭环)/M3(对外面)/M4(加固冻结:审计滞后指示 auditLag、多 profile 文件/restart 语义、引擎自身行 enable/disable 自毁守卫、发布包实机验证);每里程碑双 subagent review(架构 + 一致性)+ 修复后复核,冻结门终审双 review 通过(major M1 已修 + 回归,minor 全部修正/文档化);host/client typecheck 零错误、**166/166 测试全绿**、build 产物正确、发布 tarball 实机 boot 验证通过;真实 web profile 全程未触碰(模板原样、3080 在线)。**后续方向**:v2 候选(token/审批钩子、观察窗口数据校准、动态服务装配评估等,见 01-contract §10 / ADR-0006 / 00-index §4)。设计基线在上级目录 `harness-research/`:
  - `hotplug-engine-design.md` — **上位设计**:服务定位/服务契约 API 草案/消费方集成路径/Non-Goals/可靠性承诺/落地建议;
  - `hotplug-dev-audit.md` — 机制精确化(含 §1.2 hmr disabled 真相)、社区三家审计、安全面、更安全策略、§7 实测记录、§8 开发方向合理性(红线);
  - `hotplug-analysis.md`、`official-harness-architecture.md`、`SESSION-HANDOVER.md` — 机制与上下文;
  - `hotplug-drill/` — 实测演练包(全链路已验证,可复用为测试夹具)。
- **本项目文档**(2026-08-14 已建,首版未冻结):`docs/00-index.md`(索引+决策总览+review 记录)、`docs/01-contract.md`(**契约 v1,权威**)、`docs/02-design.md`(详细设计,M1-M4 实施顺序)、`docs/adr/ADR-0001..0007`(锁定决策)、**`plans/00-plan-index.md` + `plans/01..04-M*.md`(实施计划:M1 最小闭环/M2 安装闭环/M3 对外面/M4 加固冻结,含各阶段任务拆分/验收条件/测试设计)**。
- **实现环境事实**:DSH `0.1.0-rc.6`(developer preview,机制可能变动);工作目录 `<workspace>`;Web profile = `web`(3080 在线,boot 图 49 条目);官方源码在 npx 缓存 `node_modules\@deepseek-ai\*`;npm registry = https://registry.npmjs.org/;pnpm = `<repo-tools>/pnpm` (私链工具,不随仓库提供)。
- **验证手段**:实机 `http://127.0.0.1:3080/`(boot 图/ping 路由);`dsh --profile web --dump-config`(组合树,需 $DSH_HOME 写权限,沙箱需升级审批)。
- **未实现项**:M1–M4 全量完成并锁定,契约 v1 已冻结(2026-08-14)。后续均为 **v2 候选**(见 01-contract §10 / ADR-0006 / 00-index §4):REST token/审批钩子、观察窗口数据校准、webServer/tools 动态装配评估、官方 CLI bundles 对拍(发布验证项)、官方内核行为变化跟踪(preview 期)。

## 文档层级与约束关系

| 层 | 位置 | 职责 |
|---|---|---|
| 设计基线 | `harness-research/hotplug-engine-design.md` | 服务定位/契约/集成路径/Non-Goals(本项目唯一设计权威) |
| 机制与安全依据 | `harness-research/hotplug-dev-audit.md` | 官方机制事实、社区审计、安全面、策略、红线(实现必须对照) |
| 上下文 | `harness-research/hotplug-analysis.md`、`official-harness-architecture.md`、`SESSION-HANDOVER.md` | 机制演进、官方架构、环境事实与坑 |
| 本项目设计 | `docs/00-index.md` / `01-contract.md` / `02-design.md` / `adr/` | 契约(权威)+ 详细设计 + 决策记录(**已建,2026-08-14**) |
| 实施计划 | `plans/00-plan-index.md` / `01-M1-*.md` / `02-M2-*.md` / `03-M3-*.md` / `04-M4-*.md` | 阶段拆分/里程碑/验收条件/测试设计(**已建,2026-08-14**) |
| 实现 | 本目录 `src/`(M1 已实现:contract/patch/manifest/queue/backup/health/audit/service/index/client) | host 服务 / patch 写入 / 质量门(M2) / 回滚 / 审计 / REST(M3) / 工具(M3) / 最小管理 UI(M3) |

约束方向:设计基线 → 机制依据 → 本项目契约 → 实现。**实现不得在未走设计变更的情况下偏离 `docs/01-contract.md` 的契约与 `adr/` 已锁定决策**;官方机制事实以 `hotplug-dev-audit.md` 的源码级核对为准(preview 期若官方行为变化,先更新依据文档再改实现)。

## 系统上下文与核心参与者

- **DSH host(官方内核)**:配置热应用(cordis-plugin-hmr + watchUserPatches)、loader/fiber、客户端图(dsh-client-modules)、SSE rebuilt(dsh-client-hmr)、`dsh plugin` 安装通道。**只消费,绝不重写**。
- **引擎插件(本项目)**:执行层编排者——写 patch 文件/调 CLI、质量门、健康确认、回滚、审计。**状态不自己持有**,只做官方树的投影与差分。
- **消费方(市场 / agent / 其他插件)**:市场(发现/策展)把 spec 交给引擎执行;agent 经工具驱动;宿主插件经服务注入调用。引擎对消费方只暴露稳定契约。
- **用户**:审批($DSH_HOME 写操作、危险安装)、验收、决策所有者。

## 贯穿性核心原则

1. **消费官方机制,绝不重写**(最高红线):不实现热应用、图重组、patch 语义、loader;引擎只"写文件/调 CLI/读官方树"。
2. **状态唯一真源 = 官方组合树/loader 树**:引擎只做投影与差分;任何"自己维护一份状态"的倾向都是重新开发的信号。
3. **写前门禁优先于写后回滚**:拒绝会让 profile 启动 fail-loud 的坏包,比装后回滚更便宜(官方 boot 是 fail-loud:一个坏行 = 整个 profile 起不来)。
4. **所有变更可回滚、可审计、幂等、串行**:每次写操作前备份,操作记 JSONL(操作/行 diff/结果/调用方),desired-state 幂等,写操作全局串行(配置 HMR 重放非可重入)。
5. **安全红线**:patch 文件 = 可执行代码(`!!js` 表达式经 `new Function`+`eval` 求值 = host RCE 面);写行白名单化(id/包名正则、禁用 `!!js` 回显),不回显不可信内容;写操作经审批策略。
6. **降级路径**:官方 HMR 程序化重挂是 CLI 胶水实现细节(preview 期可能变);HMR 不在时退化为"写 bundles + 提示重启",**服务契约不变**。
7. **与市场非竞争**:spec 由市场解析后传入,引擎不拥有目录/搜索/榜单/策展;不实现市场 UI(只允许最小管理 UI:list/enable/disable/rollback/audit)。

## 工程实现原则(本项目设定)

1. **选择满足当前需求的最简实现**:不为尚未出现的需求预设计抽象、配置项、间接层。
2. **分层扩展**:从"端到端可用的最小版本"(装依赖 + 挂行 + 回滚)开始,逐步加质量门/观察窗口/审计/REST/工具;绝不为了未完成的复杂设计牺牲已能工作的部分。
3. **保持模块化,职责清晰**:patch 写入 / 安装执行 / 质量门 / 回滚 / 审计 / 服务契约 / 客户端 UI 分模块,模块间只经服务层交互。
4. **优先成熟库与官方依赖**:js-yaml、官方 `@deepseek-ai/*`、cordis 等已有能力先查证再用,不重复实现标准能力(参考社区 web-plugin-manager patch.ts 语义,可复用其模式但按其 LICENSE 注明)。
5. **测试走真实生产路径**:patch 写入测试必须经过"真实文件 + 解析路径"(不得直调内部函数绕过);安装/回滚测试要有端到端用例(可用 `hotplug-drill/` 作夹具);全绿 ≠ 路径真实。
6. **类型检查零错误是完成定义的一部分**:`tsc --noEmit` 必须通过;类型错误视为未完成,阻塞推进与 review。

## 类型检查与构建要求(本项目设定)

1. **TypeScript ESM + strict**:所有模块完整类型标注,不使用裸 `any` 泄漏(确需时用显式类型别名并注明理由)。
2. **双面插件构建**(参照社区 dsh-web-plugin-manager 与官方 bundle 模式):
   - `tsconfig.host.json` / `tsconfig.client.json` 分离(host/client 两侧声明合并隔离);
   - 产物:`lib/index.js`(host 半段)+ `lib/client.js`(预构建浏览器 bundle,`window.__ModuleLoader__.load({id, factory})` 协议);
   - `package.json`:exports 声明 `"."`/`"./client"`/`"./package.json"`;`dsh.client.platform: "web"` + inject 声明;`dsh.bundle.patch` 指向 cordis.patch.yml(非 bundle 形态时**不要**声明,走 insert 挂载)。
3. **命令**:`pnpm typecheck`(= `tsc --noEmit`)、`pnpm build`(tsdown 双面)、`pnpm test`(vitest)。
4. 编辑 LSP(tsc)与 CLI `pnpm typecheck` 不一致时以 CLI 为准。

## 项目推进流程(本项目设定)

1. **实现前必须对照设计**:先读 `hotplug-engine-design.md` §2-§5 与 `hotplug-dev-audit.md` §8 红线;新增/变更契约或 Non-Goals 先改设计文档再动代码。
2. **复杂内容推进门**:设计/契约变更 → 分段详细计划 → 双 subagent review(架构 + 一致性两视角)→ **暂停等待用户确认**再落地。
3. **Review 规则**:代码实现默认 **2 个不同方面**的 subagent review(如"是否越层/是否重写官方机制" + "实现 vs 设计契约字面");非 goal 场景发起 review 前须用户授权;全量暴露问题,不逐渐披露。
4. **修复规则**:先定位根本原因(可用 `diagnose` skill:复现→最小化→假设→插桩→修复→回归);不得直接打补丁;代码修复后仍走双 review;两次修复未过则单审定向,仍未过则暂停向用户报告。
5. **验证规则**:任何写操作先在演练 profile 或备份后实机验证(`hotplug-drill/` 夹具 + 3080 ping 路由 + dump-config);验证结果回填 `hotplug-dev-audit.md` 实测记录。

## 命令行操作注意(本会话已验证)

- **沙箱**:写 `$DSH_HOME`(含 `profiles/web`)需 `sandbox_permissions: danger-full-access` 升级(会弹用户审批);读操作无需;
- **git/curl 的 schannel TLS 在本沙箱失败**(SEC_E_NO_CREDENTIALS)——网络下载用 Node https 脚本(OpenSSL 可用),见 `harness-research/fetch-community-plugins.js`;
- npm/npx 直跑会 EPERM(写 npm-cache 被拦)——下载一律 Node 脚本写进工作区;
- PowerShell 命令串避免反引号(会被 JS 模板字面量搞坏),用 `[char]10` 或 Add-Content 数组;
- pnpm 11 遇到 `ERR_PNPM_IGNORED_BUILDS`:把包名加进 profile `pnpm-workspace.yaml` 的 `allowBuilds`;
- 工具调用偶发 `missing required property` 报错:同一调用重试 1-3 次即好(harness 偶发 bug)。

## 经验沉淀(本会话/实测已验证)

**机制层**:
- **配置热应用激活**:profile `cordis.patch.yml` 写 insert/disable 行经 HMR 实时生效(host 侧零重启)——实测 ping 路由写行即 200、恢复即 404;但 `hmr` 配置行被官方 `disabled: true`(TODO),CLI 程序化重挂 `root: []` 提供配置热应用,**模块级 partial reload 被禁**(见 audit §1.2);
- **客户端新插件需页面刷新**:行增删只重组服务端图,SSE `/plugins/events` 只推 `rebuilt` 帧、`graph` 帧仅连接时发一次且浏览器忽略;新客户端 bundle 刷新页面才加载;
- **pkgMeta 负判定缓存永不过期**:曾被扫为"非客户端包"的包名热挂不生效;全新包名可热解析;
- **boot fail-loud**:启动时一个坏行(缺依赖/缺客户端 bundle)会让整个 profile 起不来——安装前门禁是硬需求;
- **`!!js` = host RCE 面**:patch YAML 的 `!!js` 表达式经 `new Function`+`eval` 求值,写行必须白名单化、不回显不可信内容。

**写入层(YAML 陷阱,社区踩坑实录)**:
- 空文档 `[]` 行追加前必须删除,否则变双文档 YAML;
- `@` 前缀包名必须单引号(bare `@` 是 YAML 保留指示符);
- 删行后若只剩注释,文件解析为 null 导致 HMR 失败——须恢复 `[]` 模板;
- 用 managed block(`# <owner>:managed:start/end` 标记块)增量写,不整文件重写;原子写 tmp+rename(唯一命名 `.{name}.{pid}.{uuid}.tmp`);
- 幂等 desired-state 写(`disabled: true/false` 存在即更新)。

**安装/卸载**:
- 非 bundle 包经 `pnpm --dir <profile> add` 直装依赖不写 bundles;`dsh plugin` 对非 bundle 包只告警不 reconcile;
- in-box bundles(base/web-app/headless)是安装自带、不是依赖——卸载/重装后要保护其不丢;
- 卸载包必须联动清理其 insert 行(否则下次启动 boot 失败)。

## 关键术语速查

- **Profile / Bundle / Patch**:命名组合 / 插件分发格式(`dsh.bundle.patch` 指向 patch 文件)/ 顶层 YAML 数组(按 id 覆盖 config 或 insert 新行);层次 = bundles → profile patch → home patch → overlay。
- **insert / disabled**:patch 行操作——insert 挂新行;disabled 停用行(可 `!!js` 条件);二者写 profile `cordis.patch.yml` 即 HMR 实时生效。
- **fiber / loader**:Cordis 插件运行时实例 / 入口树;`loader.entries()` 递归含子树行(清单展示用)。
- **配置热应用 / 模块级 partial reload**:前者激活(CLI 程序化重挂 `root:[]`),后者被官方 TODO 禁用。
- **客户端图 / SSE rebuilt**:`dsh-client-modules` 组合 `window.__DSH_BOOT__` 并服务 `/plugins/<id>/client.js`;`dsh-client-hmr` 推 rebuilt 帧做内容级热替换(dev 场景)。
- **managed block**:owner 标记的增量写入块(`# <owner>:managed:start/end`),可整体摘除回滚。
- **质量门 / 观察窗口 / 回滚句柄**:装前静态检查(import 对账/入口/客户端 bundle);装后 N 秒健康确认(fiber phase),failed 自动恢复;操作前备份的可恢复句柄。
- **spec**:安装源(npm 包名 / path / git URL)——**由市场解析后传入**,引擎不猜来源。

## 实现时必须守护的防线(对照 audit §8 红线 + §4 安全面)

1. 不重写官方机制(热应用/图重组/patch 语义/loader)——只消费;
2. 状态唯一真源 = 官方树;不另存真源、不做与官方树的双写;
3. 不把不可信内容写进 patch 行(`!!js` 面);写行 id/包名白名单校验;
4. 任何写操作前备份、后审计;全局串行;幂等;
5. 安装先过质量门;热挂后健康确认;失败自动回滚;
6. 降级路径(无 HMR → 写 bundles + 提示重启)必须存在且契约不变;
7. 不做市场功能(目录/搜索/榜单/策展/spec 解析),不拥有市场身份;
8. 托管自身运行的 profile 只读保护(不可 rename/remove 自身宿主 profile);
9. 客户端新插件的"需刷新页面"提示必须出现在契约返回里,不得声称免刷新;
10. 类型检查零错误、测试走真实生产路径,是完成定义的一部分。

## 文档语言与术语约定

- 规范关键词 **MUST / MUST NOT / SHOULD / SHOULD NOT / MAY**(RFC 语义);
- 中文为主;术语与 `harness-research/` 系列文档保持一致(profile/bundle/patch/insert/disabled/fiber/HMR/managed block/质量门/观察窗口/spec);
- 本仓库维护 `AGENTS.md`;若另建 `CLAUDE.md`,内容 MUST 与 `AGENTS.md` 一致并同步更新;
- 新增设计文档沿用 `harness-research` 编号风格(如 `hotplug-engine-<主题>.md`),先链接受影响的上位文档再落笔。
