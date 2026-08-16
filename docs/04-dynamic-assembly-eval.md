# 动态服务装配评估 — dsh-hotplug-engine

> 文档编号:`hotplug-engine-EVAL-04` | 性质:评估文档(v2 候选,非契约、非计划) | 版本:0.1(2026-08-16)
> 上位约束:docs/03-optimization-directions.md 方向 C、01-contract §9/§10、AGENTS.md(红线)、设计审计笔记(私有,未随仓库发布)机制事实
> 评估问题:**纯客户端 bundle 能否经 dsh-client-modules / SSE rebuilt 免重启加载?**

---

## 1. 背景

bundle 包(声明 `dsh.bundle.patch`)安装后,引擎返回 `mode:'restart'` + `restartRequired:true`,必须重启进程才生效。这是官方内核机制(bundles 层 boot 时加载),引擎不能绕过。用户在实机安装 `dsh-task-dag`(bundle)时期望"热加载",本评估判断能否在编排层(而非突破内核)实现"免重启"。

## 2. 官方机制事实(源码级核对)

1. **bundles 层 boot 时加载**:`dsh.profile.bundles` 在 profile 启动时消费,写入后不热应用;
2. **模块级 partial reload 被禁**:官方 `hmr` 配置行 `disabled: true`(TODO),CLI 程序化重挂 `root: []` 仅提供**配置热应用**(patch 行 insert/disable 实时生效),模块级热替换被官方禁用;
3. **pkgMeta 负判定缓存永不过期**:曾被扫为"非客户端包"的包名热挂不生效,全新包名才可热解析;
4. **客户端新 bundle 需页面刷新**:SSE `/plugins/events` 只推 `rebuilt` 帧,`graph` 帧仅连接时发一次且浏览器忽略;新客户端 bundle 刷新页面才加载。

## 3. 可行性分析

| 路径 | 结论 | 依据 |
|---|---|---|
| 纯客户端 bundle 免重启加载 | **不可行** | §2.2 模块级 partial reload 被官方禁用;§2.3 pkgMeta 负缓存;§2.4 SSE 不推 graph 帧 |
| 服务端 bundle 免重启 | **不可行** | §2.1 bundles 层 boot 加载;图重组/loader 是官方职责(红线:MUST NOT 重写) |
| 首装引导重启 + 此后热挂 | **可行(编排层)** | 首次写 bundles + 提示重启一次;重启后该插件启停/升级走配置 HMR(insert/disable 行实时生效) |
| 客户端刷新引导 | **可行(编排层)** | 契约消息已含"新客户端 bundle 需刷新页面",可升级为 UI 引导 |

## 4. 风险

- 强行突破内核(自定义热应用/图重组/loader)违反最高红线,且 preview 期官方行为可能变化,不可取;
- "免重启"承诺若建立在未公开内核行为上,会随内核升级漂移,破坏契约稳定性。

## 5. 结论与 v2 建议

- **结论**:纯客户端 bundle 不能免重启加载;引擎编排层只提供"首装引导重启一次 + 此后热挂 + 客户端刷新引导"(已在 M6 方向 C 落地,见 02-design §13.3)。
- **v2 建议**:**不升 v2**。动态服务装配评估不构成契约语义变更;若未来官方内核放开模块级 partial reload(解除 hmr TODO),再评估"bundle 免重启"并走 ADR 升 v2。
