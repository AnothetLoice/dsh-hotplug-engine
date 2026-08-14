# M5 详细计划 — 安全与健壮性整改(评审整改)

> 计划编号:hotplug-engine-PLAN-05 | 里程碑:M5 | 目标:落实 security-crash-review.md 的整改(根因定位 → 修复 → 回归)
> 上位约束:docs/security-crash-review.md(评审结论)、01-contract v1(已冻结)、ADR-0006 / ADR-0007、AGENTS.md(安全红线)
> 规范关键词:MUST / MUST NOT / SHOULD / SHOULD NOT / MAY

---

## 0. 背景与范围

严格只读评审产出 docs/security-crash-review.md,定级 **2 高危(H1/H2)/ 3 中危(M1-M3)/ 5 低危(L1-L5)**。本计划对每项先探查根因、再定修复方式,并按“是否触碰契约/鉴权语义”分两类:

- **A 类 — 纯实现加固(契约不变、向后兼容)**:H2、M1、M2、M3、L1、L2、L3、L5。直接修,不涉 ADR。
- **B 类 — 涉及鉴权语义(需契约/ADR 标注)**:H1。本计划采用**加法式可选 token 门禁(opt-in,默认关闭=现状)** 的方案,落在 v1 兼容边界内;若改“默认强制 token”则属语义变更 → 升 v2,另行 ADR。
- **L4(操作历史持久化)**:本阶段仅文档化,不实现(见 §6 决策点)。

---

## 1. 根因总表(探查后)

| 发现 | 直接根因(代码位置) | 深层根因 |
|---|---|---|
| **H2** handle 路径穿越 | rollback() 未校验 handle 格式即 join 成路径(service.ts:228-247 → backup.ts:59-60 / 99-100);rollbackByHandle 信任 sidecar 内绝对路径 | 外部可控字符串被当作“内部生成 id”直接进入文件系统路径,缺一道“外部输入 → 安全 id”的边界校验 |
| **M1** profile . / .. | PROFILE_NAME_RE 允许点号(manifest.ts:24),join 归一化别名 | 白名单校验与“路径解析语义”脱节(只防分隔符,漏路径别名) |
| **M2** pnpm 输出注入 | runPnpm 原样累积 stdout/stderr,service.ts:319 / 430 直接嵌入 message | 子进程输出被当作“可安全展示的字符串”,未做终端/日志安全清洗 |
| **M3** readPatch 无防护 | readPatch 无 try/catch(manifest.ts:102-105),与 readManifest 不对称 | 防御性读取策略不一致 |
| **L1** busy-wait | writePatchAtomic 用 sleepSync 空转重试(patch.ts:574-606) | 同步 API + 重试的固有代价,上限未按经验收紧 |
| **L2** 随机性弱 | Math.random 用于 tmp 名(manifest.ts:126 / patch.ts:610-612) | 临时文件名唯一性诉求用了非密码学随机 |
| **L3** local spec 逃逸 | assertSafeSpec 只拦 cmd 元字符(installer.ts:37-41),isLocalDirSpec 放行绝对路径/.. | spec 校验聚焦“命令注入”,未覆盖“本地路径作用域” |
| **L5** REST 响应无防护 | writeJson/writeError 直接 writeHead/end 无 try/catch(rest.ts:361-383) | 只读 handler 未与 respondMutation 统一异常兜底 |
| **H1** REST install RCE | 同源围栏无 token(rest.ts:269-315),install 经 pnpm 执行任意代码 | v1 无鉴权设计决策(ADR-0006)+ install 天然等于代码执行 |

> 关键探查结论(决定 H1 方案):官方审批服务 @deepseek-ai/dsh-user-approval 的 ApprovalService.request(req) 强依赖 agent + 打开中的 turn(见其 types/index.d.ts:request 签名与注释),而浏览器 REST 请求无 agent/session 上下文 → **REST 写路径无法复用 agent 审批钩子**,只能靠“同源围栏 + 可选 token”。这与 ADR-0006 的自陈一致。

---

## 2. 修复方式(逐项:根因 → 方案 → 取舍 → 测试)

### A1 — H2:回滚句柄格式校验 + sidecar 路径归属校验

- **根因**:外部 handle 未经校验直接 join 成路径。
- **修复(两层)**
  1. **主修复**:新增 assertSafeOperationId(id)(放 backup.ts),严格匹配 /^op-\d+-\d+$/(与 queue.ts:41 生成格式一致);在 rollback() 入口(resolveProfile 之后、enqueue 之前)调用。不匹配 → 返回 ROLLBACK_NOT_FOUND(或新增 HOTPLUG.ROLLBACK.INVALID)。破坏性:无(合法 handle 恒匹配)。
  2. **纵深**:在 loadBackup 内 path.resolve 后断言仍落在 backupDir 前缀内;在 rollbackByHandle 内对 sidecar 的 patchPath/manifestPath 重新校验归属(可选,主修复已封死注入)。
- **取舍**:仅第 1 层即可封死穿越、改动最小零风险 → 首选;第 2 层是纵深防御,防止未来再引入同类“外部 id 拼路径”。
- **测试**:service.spec 增 rollback('../x') / rollback('op-1/../../x') / rollback('op-1') 三例;backup.spec 增 sidecarPath 越界断言。

### A2 — M1:profile 名显式拒绝路径别名

- **根因**:白名单允许 . / ..。
- **修复(两层)**
  1. **主修复**:在 profileDirIn 内 if (name === '.' || name === '..') throw PROFILE_UNSAFE(最外科,零兼容风险)。
  2. **可选收紧**:正则改 /^[A-Za-z0-9][A-Za-z0-9._-]*$/(首字符必字母数字),彻底排除别名及以 -/_/. 开头的怪名;需先确认无既有 profile 以非字母数字开头。
- **取舍**:推荐第 1 层(零风险);第 2 层作为可选强化,先摸底再决定。
- **测试**:manifest.spec 增 profileDirIn(home, '.') / '..' 抛 PROFILE_UNSAFE;service.spec 增 snapshot('..') / install(spec, { profile: '..' }) 失败。

### A3 — M2:pnpm 输出清洗

- **根因**:子进程原始输出直接进 message。
- **修复**:新增 sanitizeTerminal(value, maxLen = 2000)(剥离 C0/C1 控制字符与 ESC,保留可见字符,截断);把 service.ts:319 / 430 两处 .slice(0, 2000) 改为 sanitizeTerminal(add.output)。
- **取舍**:在嵌入点清洗(而非 runPnpm 汇总时)以免改变 runPnpm 返回语义、牵连既有测试断言。
- **测试**:service.spec 构造含 \x1b[31m / \n 的 pnpm 失败输出,断言 message 不含 ESC/控制字符。

### A4 — M3:readPatch 防御化

- **根因**:与 readManifest 不对称。
- **修复**:readPatch 内 try/catch 返回 ''(空串)。
- **测试**:manifest.spec 构造存在但不可读的 patch(权限/删除竞态)→ readPatch 返回空串不抛。

### A5 — L5:REST 响应统一 try/catch

- **根因**:只读 handler 未兜底。
- **修复**:在 writeJson / writeError 内部 try/catch(吞掉或 console.warn),一处收口,覆盖全部只读 GET 与错误分支。
- **测试**:rest.spec 用“writeHead 抛错”的 fake res,断言 handler 不 throw / 不 unhandled-reject。

### A6 — L2:密码学随机 tmp 名

- **修复**:manifest.ts 与 patch.ts 的 tmp 后缀改用 randomBytes(8).toString('hex')(node:crypto)。
- **测试**:复用现有写测试;可选断言 tmp 名格式。

### A7 — L1:busy-wait 上限收紧(低风险调优)

- **根因**:同步重试空转。
- **修复(最小)**:RENAME_RETRY_LIMIT 10→5、RENAME_RETRY_DELAY_MS 50→20(累计约 300ms),保持同步;注释记录权衡。
- **取舍**:异步化 writePatchAtomic 会波及 startupReconcile(构造器,同步)与 rollbackByHandle(同步)等调用点,需改签名、改动较大 → 列为后续候选,本阶段只做调优。
- **测试**:现有 patch.spec 回归;可选注入首次 rename EACCES 的用例。

### A8 — L3:local spec 路径作用域(待产品决策,默认不强制)

- **根因**:spec 校验未限本地路径作用域。
- **方案**:对 isLocalDirSpec 的 spec,path.resolve 后断言落在允许根(工作区 / 显式 allowlist)内,否则 SPEC_UNSAFE。
- **取舍**:可能破坏“从任意本地目录安装”的现有用法 → 需用户确认后实施;本计划先登记为**待决策项**。
- **测试(若采纳)**:installer.spec 增绝对路径 / ../ 越界用例。

### B1 — H1:REST 写端点可选 token 门禁(加法式,opt-in)

- **根因**:同源围栏无凭证;approval 服务为 agent/session 作用域,无法复用于无会话 REST(见 §1 关键结论)。
- **修复(加法式,向后兼容)**
  1. 新增可选配置 restToken(服务构造 options 或环境变量 DSH_HOTPLUG_REST_TOKEN),经 index.ts 传入 makeRoutes;
  2. 在 expectSameOrigin 之后、写端点(install/uninstall/enable/disable/rollback)执行前:若 restToken 已配置,要求请求带 Authorization: Bearer <token>,用 crypto.timingSafeEqual 常量时间比较,否则 403 REST_FORBIDDEN;
  3. 未配置 token 时行为 = 现状(同源即可),保证 v1 兼容;文档强烈建议生产配置 token;
  4. “默认强制 token”属语义变更 → 升 v2 / 走 ADR,本计划默认不采纳。
- **取舍**:与 agent 审批钩子打通需引入 agent/session,浏览器 REST 无此上下文 → 不可行(ADR-0006 已定);token 是最小的自包含方案。
- **测试**:rest.spec 增三态:未配置 token → 同源放行(回归);配置后无/错 token → 403;正确 token → 放行。

---

## 3. 任务拆分(file-level)

| # | 任务 | 涉及文件 | 依赖 |
|---|---|---|---|
| T5.1 | H2 handle 校验 + sidecar 路径归属 | service.ts、backup.ts、contract/types.ts(错误码) | — |
| T5.2 | M1 profile 别名拒绝 | manifest.ts | — |
| T5.3 | M2 pnpm 输出清洗 | service.ts(或新 util 文件) | — |
| T5.4 | M3 readPatch 防御 | manifest.ts | — |
| T5.5 | L5 REST 响应兜底 | rest.ts | — |
| T5.6 | L2 crypto tmp | manifest.ts、patch.ts | — |
| T5.7 | L1 busy-wait 调优 | patch.ts | — |
| T5.8 | H1 可选 token 门禁 | rest.ts、index.ts、contract/types.ts、01-contract §5/§8(标注) | T5.5 |
| T5.9 | L3 local spec 作用域(待决策) | installer.ts | 决策后 |
| T5.10 | 回归 + 实机验证 + 文档回填 | tests/、security-crash-review.md(标注)、harness-research/hotplug-dev-audit.md(实测记录) | 全部 |

---

## 4. 实施顺序

1. **A 类低风险先落地**(T5.1-T5.7),每项带单测,合并后 pnpm typecheck / pnpm test 全绿;
2. **T5.8**(可选 token)先更新 01-contract §5/§8 与 ADR-0006 标注(加法式),再实现;
3. **T5.9** 待用户拍板后实施;
4. **T5.10** 全量回归 + 演练 profile 实机(3080 同源 / 越权 handle / 越权 profile / token 用例),验证后清理,结果回填 audit.md 实测记录。

---

## 5. 测试设计(新增)

| 层 | 用例 | 夹具 | 路径要求 |
|---|---|---|---|
| 单元 | H2:非法 handle(../、绝对路径、错误格式)→ 拒绝;合法 handle 仍可回滚 | 临时目录 + 假 loader | 真实文件 |
| 单元 | M1:profile . / .. → PROFILE_UNSAFE;snapshot/install 越权 profile 失败 | 临时多 profile | 真实文件 |
| 单元 | M2:pnpm 输出含 ESC/控制字符 → message 已清洗 | 注入假 pnpm 结果 | — |
| 单元 | M3:不可读 patch → readPatch 返回空串不抛 | 临时文件(权限/删除竞态) | 真实文件 |
| 集成 | L5:fake res writeHead 抛错 → handler 不 unhandled-reject | fake req/res | — |
| 集成 | H1:token 三态(未配置/错 token/对 token)+ 同源围栏回归 | fake req/res | — |
| 单元(若采纳) | L3:local spec 越界拒绝 | 临时目录 | — |

> 所有用例 MUST 走真实生产路径(patch 写临时文件 + 真实解析;REST 用 fake req/res;禁止直调内部函数绕过)。

---

## 6. 决策点(需用户拍板)

1. **H1** 采用“可选 token(opt-in,默认同源)” 还是 “默认强制 token(升 v2)”?
2. **L3** local spec 是否限作用域(可能破坏“从任意目录安装”的用法)?
3. **L4** 操作历史持久化是否本阶段做(建议 defer)?
4. **L1** 接受“保持同步仅调优”,还是要求异步化(更大改动)?

---

## 7. 验收条件(M5 完成判定,逐项 MUST 满足)

- [ ] A 类(H2/M1/M2/M3/L1/L2/L5)全部修复 + 单测全绿;typecheck/build 零错误;既有 166 测试不回归;
- [ ] H1 决策落地(若采纳 token),01-contract §5/§8 与 ADR-0006 同步标注;
- [ ] 演练 profile 实机验证(越权 handle / 越权 profile / token 用例),验证后清理,结果回填 harness-research/hotplug-dev-audit.md 实测记录;
- [ ] docs/security-crash-review.md 逐条标注“已修 / 已决策 / 待决策”。

---

*本计划与 00-plan-index.md 的里程碑表衔接(M5 为冻结后的加固里程碑);落地前建议在索引中登记 M5 一行。*
