# ADR-0007 审计、降级路径与范围锁定

- **状态**:已接受 | **日期**:2026-08-14
- **上位约束**:hotplug-engine-design.md §5(审计/降级)与 §4(Non-Goals);机制事实 audit §1.2(hmr 程序化重挂是 CLI 胶水细节)

## 背景
可靠性 = 可回滚 + 可审计 + 可降级。官方 HMR 程序化重挂(`root: []`)是 CLI 胶水实现细节,preview 期可能变;审计是"谁在何时改了什么"的信任前提;范围锁定防引擎滑向市场。

## 决策
1. **审计 JSONL**:`$DSH_HOME/logs/hotplug-engine/<YYYY-MM-DD>.jsonl`,行 = `AuditRecord`(契约 §3):ts/operationId/op/target/spec/mode/result/errorCode/caller/patchBeforeHash/patchAfterHash/backupPath;写审计失败不阻断操作(仅告警);
2. **降级路径**:服务 init 探测 `ctx.get('hmr')`;缺失 → `mode:'restart'`——所有写操作仍按契约执行(写 patch 文件/写 bundles),但返回 `restartRequired:true`(重启后生效;非 bundle 的 insert 行重启后由 patch 层正常加载,契约不变);
3. **profile 范围与自保护**:默认只管理托管自身运行的 profile;**profile 名 → 物理目录解析**(2026-08-14 review 补):DSH_HOME 解析(`$DSH_HOME` env,缺省 `~/.dsh`)+ `profiles/<name>`,名过白名单正则 `^[A-Za-z0-9._-]+$` ≤120 防路径穿越;**自身宿主 profile 探测** = `process.argv --profile` 或 `dsh web|headless` 命令模式(参照 web-plugin-manager isHostProfile);官方 profile(web/headless)与自身宿主 profile 受保护(不可 uninstall 自身/rename/remove;M4 冻结终审补:**不可 enable/disable 引擎自身行 `hotplug-engine`**,否则实时卸载运行中的服务;外部 profile patch 禁用引擎仍是文档化降级路径,但引擎 API 不自毁);M1–M3 仅当前 profile,多 profile 自 M4;**自保护边界(M4 冻结终审定案)**:保护以「自身宿主 profile」为界——经 `profile?` 指向其他 profile 无法影响运行实例(契约 §4 语义);但引擎若安装在第二个 profile 中,`uninstall(...,{profile:other})` 会使其缺依赖 fail-loud(跨 profile 脚枪),属操作者责任范围,引擎不额外拦截(记录不扩大 v1 语义);
4. **Non-Goals 锁定**:无目录/搜索/榜单/策展/spec 解析 UI;无市场身份;客户端 UI 仅 list/enable/disable/rollback/audit(见 02-design §10)。

## 备选
- 审计存内存:重启丢失,排除;
- 无降级(假设 HMR 永在):preview 期不可接受,排除;
- 引擎提供 spec 输入 UI:滑向市场定位,排除。

## 后果
- 需要 `$DSH_HOME/backups|logs/hotplug-engine/` 目录的写权限(宿主进程具备);
- 消费方必须按 `mode/restartRequired` 渲染 UI 提示,这是契约的一部分;
- 引擎身份保持"执行层",不与任何市场绑定。

## 关联
- ADR-0003(操作模型)、ADR-0004(写入层)

## 修订(v0.1.5,2026-08-16)
- **决策 2 探测手段替换**:原「服务 init 探测 `ctx.get('hmr')`」在实测 web profile 产生假阴性(该插件 `disabled:true`,但「配置热应用/重挂」仍活跃)→ 改为**经验判定**(观察窗口内目标行是否被 loader 挂载,见 ADR-0003 修订)。「缺失 → restart、契约不变」的**语义保留**,仅换探测手段。
- **引擎级 `EngineSnapshot.mode` 懒更新**:服务初始 `'restart'`;首次写操作观察窗口确认目标行被 loader 挂载后置 `'hot'` 并保持(不再静态探测 `ctx.get('hmr')`)。
