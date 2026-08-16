# 验收交接 — dsh-hotplug-engine v0.1.5(P2-2 经验判定修复)

> 文档编号:hotplug-engine-ACCEPT-06 | 性质:实机验收 + 交接 | 版本:0.1(2026-08-16)
> 上位约束:00-index.md / 01-contract.md(契约 v1)/ 02-design.md §5.3§9 / adr/ADR-0003·0007(修订)/ plans/07-M7

## 1. 背景

v0.1.4 实机验收发现 P2-2:引擎用 `ctx.get('hmr')` 静态探测「配置热应用可用性」,探测的是 cordis-plugin-hmr(模块级 HMR 插件,实测 web profile 该插件 config 行被官方 disabled:true),而引擎 patch 行真正依赖的「配置热应用/重挂」(CLI 程序化重挂 root:[])是另一条独立且仍活跃的机制 → 静态探测假阴性,引擎误判 mode='restart'。

v0.1.5(M7)以「经验判定」替代:宿主 profile patch 行写操作**始终运行观察窗口**,以 loader 树真实 fiber phase 判定生效方式(反映成功→hot / 反映失败→回滚 / 未反映→restart 保留+警示);`EngineSnapshot.mode` 懒更新(初始 restart→首确认后 hot;rollback 不翻);未反映警示落 `MutationResult.message` + `AuditRecord.note?`(v1 只增)。

## 2. 交付链(commit)

| commit | 内容 |
|---|---|
| b64a383 | docs:设计/契约变更(经验判定,ADR/契约/设计) |
| b8304fc | docs:终审 minor 同步(三分零漂移) |
| 9dae527 | docs:M7 计划(review-fixed + locked) |
| cb4ab83 | feat:v0.1.5 实现(T7.1–T7.6) |
| 19ef4df | chore:review-fix minors + 版本号 0.1.4→0.1.5 |

## 3. 测试

- `pnpm test`:15 文件 / **216 用例全绿**(既有 207 + 新增 9)。
- typecheck 双面(host + client)0 错误。

## 4. 实机验证(web profile 3080,v0.1.5)

| 项 | 结果 |
|---|---|
| 运行实例版本 | `node_modules/dsh-hotplug-engine/package.json` = **0.1.5** |
| 静态探测移除 | 部署版 `service.js` 无 `ctx.get('hmr')`(仅注释);`_mode` 懒更新 |
| 三分粒度 | 部署版 `health.js` 含 `sawLive`/`everLeftActive`/`absent`/`stuck`/`still-active` |
| 未反映警示 | 部署版含 `UNREFLECTED_NOTE` + `unreflected` 计数 + 审计 `note` 落点 |

### 行为验证(mode 翻转)

1. 初始 `hotplug_status` → `mode=restart`(经验判定初始态)✅
2. 禁用非核心 UI 行 `pet`(`hotplug_toggle entryId=pet enabled=false`)→ 返回 `ok:true` + `mode=hot` + `restartRequired=false`;观察窗口确认 pet 卸载(`fiberPhase=null`)✅
3. `hotplug_status` → `mode=hot`(引擎级懒更新翻转)✅
4. 重新启用 `pet` → `ok:true` + `mode=hot`;pet 恢复 `enabled=true` + `fiberPhase=active` ✅
5. `hotplug_status` → `mode=hot`(保持,不再回落)✅

**结论:P2-2 修复实机生效——mode 由经验判定、首次反映后翻 hot 并保持;不再出现「写操作报 restart 实际已热应用」的矛盾。**

## 5. 环境终态

- pet 行已恢复启用(`enabled=true` + `phase=active`),无残留。
- 审计记录本次 toggle(op-1786859985210-1 disable / op-1786859996583-2 enable,caller=tool)。
- 真实 web profile 其余未改动。

## 6. 遗留(非阻塞,双 review 记录)

- sawLive 振荡边角(enable 临时 live 后回落判 stuck→回滚,偏保守可辩护)。
- 观察统计 `stuck` 与 `waitForStable` 的 `timeout` 共槽(统计粒度取舍)。

---

*验收执行:agent 实机(hotplug_* 工具 + 只读核验),版本 0.1.5,行为验证通过。*
