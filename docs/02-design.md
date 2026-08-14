# 详细设计 — dsh-hotplug-engine

> 文档编号:`hotplug-engine-DESIGN-02` | 性质:详细设计(实现蓝图) | 版本:0.1(2026-08-14)
> 上位约束:契约 `docs/01-contract.md`(权威);设计基线(私有工作笔记,未随仓库发布);机制事实(设计审计笔记,私有,未随仓库发布)
> 规范关键词:MUST / MUST NOT / SHOULD / SHOULD NOT / MAY

---

## 1. 模块布局(src 树)

```
dsh-hotplug-engine/
├─ AGENTS.md
├─ docs/                       # 本仓库设计文档(00-index/01-contract/02-design/adr/)
├─ package.json                # bundle 双面声明(见 §7)
├─ tsconfig.host.json          # host 半段(tsc + tsdown)
├─ tsconfig.client.json        # client 半段(tsc + tsdown)
├─ tsdown.client.config.ts     # 客户端 bundle 构建(host 半段直接 tsc 输出 lib/)
├─ src/
│  ├─ contract/
│  │  └─ types.ts              # 契约类型(由 docs/01-contract.md §3 派生,单一来源)
│  ├─ index.ts                 # 插件入口:name/inject/apply,注册服务 + REST + 工具(根级,2026-08-14 M3 review 对齐)
│  ├─ host/
│  │  ├─ service.ts            # HotplugEngineService(ctx.hotplugEngine):契约实现
│  │  ├─ queue.ts              # 全局串行队列 + operationId
│  │  ├─ patch.ts              # 写入层:managed block / 白名单 / 原子写 / YAML 陷阱
│  │  ├─ manifest.ts           # profile package.json 读写(bundles/deps) + in-box 保护
│  │  ├─ installer.ts          # pnpm 执行 + 包形态判定 + 质量门 + 联动清理
│  │  ├─ quality.ts            # 质量门(import 对账/入口/客户端 bundle)
│  │  ├─ health.ts             # 观察窗口 + fiber 健康确认 + 自动回滚
│  │  ├─ backup.ts             # 变更前备份 / 回滚句柄 / 恢复
│  │  ├─ audit.ts              # JSONL 审计
│  │  ├─ events.ts             # SSE /api/dsh-hotplug/events + 事件总线
│  │  ├─ rest.ts               # REST 路由注册(ctx.webServer.register)
│  │  └─ tools.ts              # agent 工具(hotplug_*)
│  └─ client/
│     ├─ index.ts              # 客户端插件入口(最小管理 UI 挂载)
│     ├─ api.ts                # 同源 REST + SSE 客户端
│     ├─ controller.ts         # 面板开关状态(订阅/快照)
│     ├─ mount.tsx             # DOM 级面板 + 侧边栏入口挂载
│     └─ panels.tsx            # 管理面板(list/enable/disable/rollback/audit)
├─ cordis.patch.yml            # 本 bundle 的 patch(insert 行 id: hotplug-engine)
└─ tests/                      # vitest(host 单测 + 集成 + client jsdom 冒烟)
```

依赖注入:`index.ts` `inject: ['loader']`(唯一硬依赖);`webServer`/`tools` 以 `ctx.get(name)` 可选探测(2026-08-14 A3.6 实测:cordis 服务属性在未声明 inject 时**抛异常**,必须用 `ctx.get` 而非 `ctx.xxx !== undefined`)——宿主无 webServer/tools 时核心服务(headless)仍可用,仅对应对外面缺席。

## 2. 写入层设计(patch.ts,MUST 遵守)

### 2.1 owner managed block 格式

```
# dsh-hotplug-engine:managed:start
- insert:
    - id: <rowId>
      name: '<package>'
# dsh-hotplug-engine:managed:end
```
或 disable 块:
```
# dsh-hotplug-engine:managed:start
- id: <entryId>
  disabled: true
# dsh-hotplug-engine:managed:end
```

- 一个 block 只对应一个行 id;同 id 重复写 = 原位刷新(先摘除旧块再写新块);
- **绝不整文件重写**:只做增量编辑(追加/摘除 block),用户注释与手写行 MUST 原样保留;
- 解析用**行级扫描**(社区 web-plugin-manager patch.ts 语义,按其 LICENSE 注明),不依赖 YAML 全量重序列化(避免重排用户版式)。

### 2.2 白名单与 YAML 陷阱(写前 MUST)

| 检查 | 规则 |
|---|---|
| rowId/entryId | `^[A-Za-z0-9._/-]+$` 且 ≤120;不满足 → `HOTPLUG.PATCH.UNSAFE_TARGET` |
| 包名 | **npm 命名规范**(2026-08-14 review 收紧):`^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$`——小写、**排除 `'`/`:`/空白/控制字符**(防单引号转义注入);≤200;不满足 → `HOTPLUG.PATCH.UNSAFE_VALUE`(单测覆盖含引号/冒号的恶意包名) |
| `@` 前缀 | 包名 MUST 单引号包裹(`'@scope/pkg'`,bare `@` 是 YAML 保留符) |
| 空文档 | 追加前 MUST 删除 `[]` 行(否则双文档 YAML) |
| 删空后 | 仅剩注释 → 解析为 null → MUST 恢复官方 `[]` 模板 |
| `!!js` | 引擎写入的行 MUST NOT 包含 `!!js`(§安全红线) |
| 写后校验 | 写后 MUST 用 YAML 解析器(js-yaml + 官方同款 schema 或不含 js 的保守子集)验证:顶层 seq、无 errors、目标行可达;失败 → `HOTPLUG.PATCH.INVALID` + 恢复备份 |

### 2.3 原子写

```
tmp = <patch>.<pid>.<uuid>.tmp   # 唯一命名防并发
writeFileSync(tmp, content)
renameSync(tmp, patch)
```
写后 MUST 读回比对(内容一致);失败即回滚备份。

## 3. 安装执行流程(installer.ts + quality.ts + health.ts)

### 3.1 非 bundle 包(热挂,主路径)

```
install(spec)
 └─ 队列入队(operationId)
    ├─ 1. 质量门 quality(spec 已装或临时解析):入口可解析 / import 对账 / 客户端 bundle 存在
    │     └─ 不通过 → HOTPLUG.GATE.REJECTED(附原因清单),不落盘
    ├─ 2. 变更前备份(backup.ts:patch + package.json 快照)
    ├─ 3. pnpm --dir <profile> add <spec>(直接 spawn,不经 dsh CLI;**参数数组传递,禁 shell 字符串拼接**;Windows 经 cmd.exe /c pnpm.cmd 仍透传数组参数,见 §3.6)
    │     └─ 失败 → HOTPLUG.INSTALL.FAILED(exitCode/output)
    ├─ 4. 解析实际包名(manifest dependencies 与 spec 对账)
    ├─ 5. 质量门复检(装后):目标包 node_modules 实体
    ├─ 6. 写 managed insert 行(rowId = slugify(pkg),见 §3.3)
    ├─ 7. 观察窗口(health.ts):轮询 loader 树目标行 fiber phase
    │     ├─ active → 成功(mode 按 §9.2,返回 rollbackHandle)
    │     └─ failed / 超时 → 自动回滚(摘除 insert 行 + pnpm remove)+ 审计 'rolled-back'
    └─ 8. 审计 JSONL
```

> 注(dryRun 与 pkgMeta 负缓存):`dryRun: true` 走**同一解析路径**(只过门禁不落盘,不得另写一套);若目标包"预期为客户端包"但命中 `dsh-client-modules` 的 pkgMeta 负判定缓存(audit §1.1,曾被扫为普通包则热挂不被拾取),门禁会过但不热生效——install 结果 MUST 提示「需重启或换新包名」。

### 3.2 bundle 包(重启生效路径)

```
install(spec)
 └─ 1-5 同上(pnpm add;质量门复检)
    ├─ 6. manifest.ts:追加 dsh.profile.bundles(若缺)+ in-box bundles 保护(写入格式/去重/in-box 语义与官方 reconcile 的源码级等价举证见 ADR-0005 §等价性)
    ├─ 7. 返回 mode:'restart', restartRequired:true(不写 insert 行,防下次启动重复)
    └─ 8. 审计
```

### 3.3 行 id 生成(slugify)

`@scope/pkg` → `scope-pkg`;`^@` 剥掉、非 `[a-z0-9-]` 转 `-`、小写。确定性、幂等。**碰撞处理**(2026-08-14 review):若目标 rowId 已存在且对应包名不同 → 追加包名短哈希(8 hex)后缀,保证唯一。

### 3.4 uninstall

```
uninstall(name)
 └─ 1. 备份
    ├─ 2. pnpm --dir <profile> remove <name>
    ├─ 3. bundles 中摘除(若在)+ in-box 保护
    ├─ 4. 联动清理:摘除该包名对应的 managed insert 块(否则下次启动 boot 失败)
    └─ 5. 审计
```

### 3.5 enable / disable

```
disable(entryId) / enable(entryId)
 └─ 备份 → 写/摘 disable block(managed)或改用户行 disabled 字段(见 patch.ts 语义)
    → 观察窗口确认(enable 需确认 active;disable 确认 fiber 卸载)
    → 审计
```
- 用户手写行:enable/disable 走"行级编辑其 disabled 字段"(不删用户行);managed insert 行:摘/加块;
- 非 patch 可定位行(随机 loader id)→ `HOTPLUG.PATCH.UNSAFE_TARGET`。

### 3.6 profile 目录定位与自身探测(2026-08-14 review 补,阻塞级缺口)

- `profileDir(name)`:DSH_HOME 解析(`$DSH_HOME` env,缺省 `~/.dsh`)+ `profiles/<name>`;`name` MUST 过白名单正则 `^[A-Za-z0-9._-]+$` 且 ≤120(防路径穿越),不满足 → `HOTPLUG.PROFILE.UNSAFE`;
- **自身宿主 profile 探测**:`process.argv` 中 `--profile <name>`;无该标志时按 `dsh web|headless` 命令模式判定(参照 web-plugin-manager `isHostProfile` 语义);
- **M4 多 profile 语义(2026-08-14 T4.2 定案)**:任意白名单名可管理;目录不存在 → `NOT_FOUND`;官方 profile(web/headless)中**非宿主**者 → `PROTECTED`;宿主 profile 恒可管理;不可从宿主 profile 卸载引擎自身(`dsh-hotplug-engine`,PROTECTED),**不可 enable/disable 引擎自身行 `hotplug-engine`**(自毁守卫,M4 冻结终审 M1);**非宿主 profile = 文件/restart 语义**:变更只写目标 profile 的 patch/manifest 等文件,`mode:'restart'` + `restartRequired:true`(目标下次启动生效),**不经过宿主 loader 观察窗口**(其行不在本进程 loader 中);非宿主 snapshot 为文件级投影(patch insert 行,`fiberPhase:null`,`mode:'restart'`);非宿主 enable/disable 的目标存在性以**目标 patch 文件**为准;非宿主 uninstall 同样走 pnpm + 文件语义(M4 冻结终审 M6 记录);宿主 profile 保持 loader 投影 + 观察窗口语义不变;**自保护以宿主 profile 为界**(跨 profile uninstall 引擎使目标 fail-loud 属操作者责任,引擎不额外拦截,v1 语义不扩大);
- **pnpm 探测**:显式配置 `hotplugEngine.pnpmPath` 优先,其次依次检查 `pnpm` / `pnpm.cmd` / `pnpm.exe`(PATH);缺失 → 启动告警,install/uninstall 返回明确错误(`HOTPLUG.INSTALL.FAILED` + 提示);
- **Windows spawn 策略**:spawn 一律用**参数数组**(`['add', '--dir', profile, spec]`),禁 shell 字符串拼接;Windows 上经 `cmd.exe /c pnpm.cmd <数组参数>`,保留注入防护(`--script`/`;` 等无法经数组参数注入)。

## 4. 质量门(quality.ts,装前静态检查)

对目标包目录(已装实体或临时解析):
1. `package.json` 可读且为 JSON;
2. 入口可解析:`exports["."].default` / `main` / `index.js` 任一存在;
3. **import 对账**:扫描入口文件裸导入(`from/import(/require(` 正则),凡未在 `dependencies ∪ peerDependencies` 且不在「Loader 提供集合」→ 拒装(该集合 = 官方客户端平台表 + host 侧 cordis/dsh 基础,取自 web-plugin-manager `LOADER_PROVIDED` 同款,按其 LICENSE 注明;**锁定到官方 0.1.0-rc.6 的具体平台表,防漂移,升级内核时同步核对**);
4. 若声明 `dsh.client`:MUST 存在 `exports["./client"]` 对应产物(缺 → 拒装,启动即 MissingClientBundleError);
5. 通过 → 安装;不通过 → `HOTPLUG.GATE.REJECTED` + 原因清单,不落盘。

> 门禁原则:拒绝坏包比装后回滚更便宜(boot fail-loud:一个坏行 = profile 起不来)。
> 安全注:`GATE.REJECTED` 的 detail(含扫描到的包路径等字符串)会回显到 REST/管理 UI——输出前 MUST HTML 转义,防 XSS。

## 5. 备份 / 回滚句柄 / 观察窗口 / 启动对账(backup.ts + health.ts)

### 5.1 备份
- 目录:`$DSH_HOME/backups/hotplug-engine/`(`<ts>-<operationId>.<patch|manifest>.bak`);
- 每个写操作前备份:profile `cordis.patch.yml` + `package.json`;
- 备份文件记录在审计 JSONL 的 `backupPath`。

### 5.2 回滚句柄(按 managed-block 作用域恢复)

- `MutationResult.rollbackHandle` = 该操作的操作 id 对应的备份引用;
- `rollback(handle)` 分两条路径(2026-08-14 review 修复:防整文件回滚抹掉外部并发写者的修改):
  - **路径 A(无并发)**:当前 patch 文件 hash == 操作完成时记录的 hash → 直接恢复整份备份(安全);
  - **路径 B(检测到并发)**:hash 不匹配 → **只增量摘除**本次操作写入的 managed block(用户手写行与他方新增内容原样保留)+ 告警「检测到外部并发修改,已按块回滚」;
- 随后等待 HMR 重放(观察窗口确认目标行回到先前状态)→ 审计 `op:'rollback'`;
- 句柄不存在/已消费 → `HOTPLUG.ROLLBACK.NOT_FOUND`。

### 5.3 观察窗口(health.ts)

- 默认 **8s**(配置可调,`config.observationWindowMs`),轮询间隔 500ms;
- 判定:目标行 `fiberPhase === 'active'` → 成功;`'failed'` → 自动回滚;超时 → 自动回滚(保守);
- **对账范围**(2026-08-14 review):窗口内同时核对本次写入的 managed block **全行**——目标行 active 但同块其他行 failed / 级联扰动 → 视为失败回滚(坏安装可能不标 failed 目标行却扰动他行);
- 回滚 = 摘除本次写入(insert 块/disable 块/bundles 追加)+ 恢复备份 → 审计 `rolled-back` + `HOTPLUG.*` 错误码;
- **命中率校准**:M2 起记录窗口命中/超时/回滚统计,校准 8s 默认值(重客户端插件激活可能需更长)。

### 5.4 崩溃恢复 / 启动对账(2026-08-14 review 新增)

- 每次写操作开始时在操作记录写入 `status:'queued'`(未完结标记);
- 服务 init 执行**启动对账**:
  1. 孤儿 insert 块(块在、包不在依赖)→ 自动摘除(同 uninstall 联动清理逻辑);
  2. 未完结操作(queued/running 且无 finishedAt)→ 标记 `failed(interrupted)`,提示可 rollback(备份仍在);
  3. 孤儿依赖(包在 deps、无任何引擎痕迹)→ 保留 + 告警(可能为用户手工安装);
- 对账结果记入审计;对账不阻塞服务启动(仅告警 + 清理明确的孤儿块)。

## 6. 审计(audit.ts)

- 文件:`$DSH_HOME/logs/hotplug-engine/<YYYY-MM-DD>.jsonl`;
- 行 = `AuditRecord`(契约 §3),写操作 MUST 记:op/目标/spec/mode/result/errorCode/caller/patchBeforeHash/patchAfterHash/backupPath;
- 读:`audit(query?)`(op/from/limit 过滤);
- 写审计本身失败 MUST NOT 阻断操作(仅告警),但 MUST 记录到 stderr 日志;**滞后指示暴露面(M4 T4.1 定案,2026-08-14)**:`EngineSnapshot.auditLag`(可选字段,快照状态面)+ 服务增量方法 `auditLag()`——不改 `audit()` 返回形状以保 v1 兼容;UI 依 snapshot.auditLag 显示告警。(2026-08-14 review:防"可审计"承诺出现静默洞)

## 7. 包声明与构建(package.json)

```jsonc
{
  "name": "dsh-hotplug-engine",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-settings"]
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.host.json && tsc --noEmit -p tsconfig.client.json",
    "build": "tsc -p tsconfig.host.json && tsc -p tsconfig.client.json && tsdown --config tsdown.client.config.ts",
    "test": "vitest run"
  }
}
```
- `cordis.patch.yml`:`- insert: - id: hotplug-engine / name: 'dsh-hotplug-engine'`(自身挂载行,id 固定);
- host/client 两侧声明合并隔离:host 引官方 host 包,client 引官方 client 包,不得混引(参照社区 tsconfig 双 Program 模式)。

## 8. 并发与串行(queue.ts)

- 单例 promise 链(`queue = queue.then(task)`),所有写操作入队;任务间不并行(配置 HMR 重放非可重入);
- `operationId` 入队即分配(UUIDv7 或 `op-<ts>-<seq>`);
- 读操作( snapshot/status/audit/listOperations )不排队;
- 同一操作重复调用:desired-state 幂等;队列内相同 op+target 且前序仍在队列 → **锁定返回 `HOTPLUG.OP.CONFLICT`**(2026-08-14 review 定稿:不做合并,行为可预期)。

## 9. 模式与降级(与契约 §9 对应,两轴分离)

### 9.1 引擎运行模式(`EngineSnapshot.mode`)
- 服务 init:`ctx.get('hmr') === undefined` → `'restart'`,否则 `'hot'`;
- ⚠️ 实现前实机核对 hmr 服务注册名(audit §1.2:CLI 程序化重挂),防探测假阴性。

### 9.2 单次操作生效方式(`MutationResult.mode`)
- bundle 包 → 写 bundles + `mode:'restart'` + `restartRequired`;
- 非 bundle 包 → pnpm 装依赖 + managed insert 行:引擎 `'hot'` → `mode:'hot'`;引擎 `'restart'` → **仍写 insert 行** + `mode:'restart'` + `restartRequired`(重启后由 patch 层加载生效——HMR 只省重启,不改变 boot 消费 insert 行的事实,契约不变);
- 客户端新插件:任何模式下,`MutationResult` MUST 携带提示「新客户端 bundle 需刷新页面」(机制限制:SSE 不推 graph 帧,见 audit §1.3)。

## 10. 客户端最小管理 UI(范围锁定)

- 面板:list(entries/packages/insertRows 三视图,只读投影)+ enable/disable 开关 + rollback 按钮(按 operation 历史)+ audit 查询;
- **无目录浏览、无搜索市场、无 spec 输入 UI**(Non-Goal,spec 只经工具/REST 传入);
- 经 `ctx.webServer.register` 同源 REST 与事件 SSE 驱动;UI 状态以 `snapshot` 为最终一致源,事件增量刷新。

## 11. 测试策略(vitest)

| 层 | 用例 | 路径要求 |
|---|---|---|
| patch 写入 | 追加/摘除/原位刷新 managed block;陷阱用例(空文档 `[]`/@ 引号/注释-only);幂等;**恶意包名拒(含 `'`/`:` 等注入样本)**;slugify 碰撞 | **真实临时文件 + 真实解析**,不直调内部函数 |
| manifest | bundles 增删 + in-box 保护 + 原子写;与官方 CLI reconcile 输出等价性对拍(见 ADR-0005) | 真实临时 profile 目录 |
| quality | 好包过/坏包拒(缺入口/裸导入/缺 client bundle) | 用演练夹具(自备)与构造坏包夹具 |
| health | 观察窗口 active/failed/超时三分支;**同块全行对账**(目标 active 但邻行 failed);回滚路径 A/B(hash 对账 + 按块摘除) | 注入假 loader 树 |
| startup-reconcile | 孤儿 insert 块自动摘除;未完结操作标记 interrupted;孤儿依赖告警 | 构造残留夹具 + 真实临时 profile |
| queue | 串行性、CONFLICT 去重锁定、operationId | 单元 |
| mode | 引擎 restart + 非 bundle install → `mode:'restart'` + `restartRequired`(两轴分离) | 注入假 hmr 缺失环境 |
| e2e | install(非 bundle)→ 实机 3080 验证 ping 路由/回滚 | 演练 profile(web)或临时 profile,验证后清理 |
| 契约一致性 | `src/contract/types.ts` 与 `docs/01-contract.md` §3 人工对照(review 项) | — |

## 12. 实施顺序(与 AGENTS.md 分层扩展一致)

1. **M1(最小闭环)**:patch.ts + manifest.ts + queue.ts + backup.ts → enable/disable/rollback 可用(host 服务 + 单测);
2. **M2(安装闭环)**:installer.ts + quality.ts + health.ts → install/uninstall 可用(非 bundle 热挂 + bundle 重启,含观察窗口回滚);**M2 开工前**:实机核对 `ctx.get('hmr')` 服务名与 pkgMeta 负缓存对 install 的影响(§9.1/§3.1 注);开始记录观察窗口命中率(§5.3);
3. **M3(对外)**:rest.ts + events.ts + tools.ts + 最小管理 UI → 契约全量可消费;
4. **M4(加固)**:审计完善、多 profile、降级路径验证、**全量首版实现(M1–M4)完成 + 双 subagent review 通过后冻结契约 v1**。

---

*实现按 M1→M4 推进;每阶段过 typecheck + 测试,写操作在演练 profile 实机验证后回填设计审计笔记(私有,未随仓库发布)实测记录。*
