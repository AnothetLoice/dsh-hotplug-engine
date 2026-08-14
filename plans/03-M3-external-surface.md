# M3 详细计划 — 对外面(REST / SSE / agent 工具 / 最小管理 UI)

> 计划编号:`hotplug-engine-PLAN-03` | 里程碑:M3 | 目标:契约 §5/§6/§7 全量可消费(市场/agent/浏览器)
> 上位约束:01-contract §5(REST)/§6(工具)/§7(事件)/§8(错误);02-design §1/§10(模块与 UI 范围);ADR-0006(对外接口)

---

## 1. 目标与范围

**做**:
- events.ts(事件总线 + SSE `/api/dsh-hotplug/events`:连接即发 snapshot 帧,推送 operation/entry 帧);
- rest.ts(REST 10 端点:snapshot/status/install/uninstall/enable/disable/rollback/audit/operations/events;同源校验;JSON 序列化;GATE detail 转义复用);
- tools.ts(6 个 `hotplug_*` 工具:status/install/uninstall/toggle/rollback/audit;遵循审批策略;描述注明"客户端需刷新/bundle 需重启");
- client/ 最小管理 UI(index.ts + panels.tsx:list/enable/disable/rollback/audit,**无目录/无 spec 输入**);
- index.ts 扩展(注册 REST + tools + SSE)。

**不做(边界)**:多 profile(M4);降级完整验证(M4);契约 v1 冻结(M4);任何市场功能(目录/搜索/榜单/策展)。

## 2. 前置条件

1. M2 全部验收通过(A2.1-A2.9);
2. 官方 webServer/工具注册 API 用法确认(参照 dsh-ssh 的 `ctx.webServer.register`、dsh-tools 的 `ctx.tools.register`、官方 client inject 声明)。

## 3. 任务拆分(文件级)

| # | 任务 | 产出 | 说明 | 依赖 |
|---|---|---|---|---|
| T3.1 | 事件总线 | `src/host/events.ts` | 事件订阅表 + SSE 帧序列化(EngineEvent);连接即发 snapshot 帧 | M2 |
| T3.2 | REST | `src/host/rest.ts` | 10 端点(01-contract §5);GET 只读同源;POST 同源校验;错误封装(业务 → HTTP 200 + ok:false;非法体 → 4xx);detail 转义复用 | T3.1 |
| T3.3 | agent 工具 | `src/host/tools.ts` | 6 工具(hotplug_*);写工具审批门禁;描述文案含机制提示;与 service 共享实现 | M2 |
| T3.4 | 客户端 UI | `src/client/index.ts`、`src/client/panels.tsx` | 最小管理面板:list 三视图(entries/packages/insertRows)/enable/disable/rollback/audit;经 REST + SSE 驱动;snapshot 为最终一致源;**无目录/无 spec 输入 UI** | T3.2 |
| T3.5 | 入口扩展 | `src/host/index.ts` | 注册 REST 路由 + SSE + tools;inject 校验 | T3.2, T3.3 |
| T3.6 | 测试 + 实机 | `tests/`(见 §5) | REST 路由集成、工具注册、UI 冒烟;实机 3080 | T3.1-T3.5 |

## 4. 实施顺序

1. T3.1 events → T3.2 rest(先测试后实现,注入假 webServer);
2. T3.3 tools(注入假 tools 注册器);
3. T3.4 client UI → T3.5 入口组装;
4. T3.6 全绿 → 实机 3080 验证(面板/SSE/工具)。

## 5. 测试设计(本里程碑新增)

| 层 | 用例 | 夹具 | 路径要求 |
|---|---|---|---|
| events 单元 | 帧序列化;连接即发 snapshot;operation/entry 帧推送;订阅/退订 | 内存 | — |
| REST 集成 | 10 端点路由注册(注入假 webServer 捕获);GET 只读;POST 同源校验(非同源拒);业务错误 → 200+ok:false;非法体 → 4xx;detail 转义 | 假 webServer + 假 service | 真实路由注册路径 |
| tools 集成 | 6 工具注册(hotplug_* 名);参数 schema;写工具审批钩子被调;描述含"需刷新/需重启" | 假 tools 注册器 | 真实注册路径 |
| UI 冒烟 | 面板渲染(假 REST 响应);enable/disable 交互调 POST;rollback 按 operation 历史;audit 查询;无 spec 输入入口(守卫) | 假 REST + 假 SSE | 组件测试(vitest + jsdom 或 RTL) |
| e2e | 实机:引擎在 web profile 运行时,浏览器管理面板可用;SSE 收到 operation/entry 帧;agent 工具(模拟调用)可驱动 install/enable | 演练 profile + 3080 | 实机,验证后清理 |

## 6. 验收条件(M3 完成判定,逐项 MUST 满足)

- [x] A3.1 M1-M2 验收全保留(回归);typecheck/test 全绿;✅ 2026-08-14:host/client typecheck 零错误、144/144 测试全绿(98 回归 + 46 新增:events 7/rest 17/tools 14/client 5/service 3)、build 产物正确(host lib + client.js 30.3kB bundle 握手结构核对);
- [x] A3.2 REST 10 端点与 01-contract §5 逐条一致(路径/方法/请求体/返回);同源校验生效;✅ 21 项路由测试(含 403 非同源(含 GET)/405/400 非法体/业务错误 200+ok:false/真实 HTTP e2e;2026-08-14 review 后**所有端点**同源围栏);
- [x] A3.3 SSE:连接即发 snapshot;operation/entry 帧格式 = EngineEvent(契约 §7);✅ events 7 项 + service 4 项(相位监控:变化/卸载/静默种子/**非 managed 行不发**)+ rest SSE 端点 + 真实 HTTP SSE 收帧;审计 caller 三值可达(rest/tool/service);
- [x] A3.4 工具:6 个 `hotplug_*` 名正确;写工具经审批门禁;描述含机制提示(契约 §6);✅ tools 14 项(ask 门禁/参数 schema/描述含刷新+重启);
- [x] A3.5 UI 范围锁定:list/enable/disable/rollback/audit 可用;**无目录/无 spec 输入**(Non-Goal 守卫);✅ client 5 项冒烟(jsdom:三视图/启停 POST/回滚/审计/SSE 刷新/无 input 守卫);
- [x] A3.6 实机:面板可用、SSE 事件流、工具可被 agent 调用(3080 验证);✅ **2026-08-14 演练宿主验证通过**(独立端口 3099 + 临时 profile hpe-e2e,不触碰真实 web profile):REST snapshot/operations/audit 在线;SSE 连接即发 `retry: 3000` + snapshot 帧、操作后实时收到 operation 帧;POST disable→enable 往返 ok:true(mode=restart,无 hmr 正确降级)、审计 caller=rest、patch 往返后复原为模板 `[]`;客户端 bundle `/plugins/dsh-hotplug-engine/client.js` 200(30.3kB);**实机捕获并修复一个真实 bug**:cordis 服务属性在未声明 inject 时**抛异常**——`ctx.webServer !== undefined` 探测模式错误,改为 `ctx.get('webServer'/'tools')` 可选探测(设计 §1 已同步);工具注册随宿主 boot 成功(无报错),工具行为由单测覆盖;演练 profile 已清理;
- [x] A3.7 契约可消费性:host 注入 + REST + 工具三条路径对同一 service 行为一致(无两套逻辑);✅ 三面共用同一 `service`(rest/tools 注入同一 HotplugEngineService);审计 caller 三值(service/rest/tool)可达并有断言;
- [x] A3.8 未越界:无市场功能;无官方机制重写;UI 以 snapshot 为最终一致源;✅ 双 review(架构+一致性)复核确认。

## 7. Review 记录(2026-08-14 M3 代码双 review)

> 首轮:架构 + 一致性双 subagent review(有条件通过 / 基本一致需修正);修复后复核同 M2 流程。修复后基线:150/150 测试全绿、host/client typecheck 零错误、build 产物正确。

| 视角 | 结论 | 修复 |
|---|---|---|
| 架构 | **有条件通过**(3 major + 4 minor,无 blocker) | Major 已修:① 所有端点(含只读 GET)加同源围栏(镜像官方 webServer loopback 围栏,契约 §5 措辞同步)② events.ts 写路径 try/catch + 写失败即 dispose(半死连接不再击穿 host)③ 审计 caller 透传(REST→'rest'/工具→'tool',service 缺省 'service');Minor 已修:SSE 连接纳入 ctx.effect 清理(onStream 钩子 + 关闭集合)、UI 双转义(panels 实体解码,React 文本节点兜底安全)、真实 HTTP e2e 测试(createServer + 真实 SSE 收帧/断开);探测式装配(preview 期)记录接受 |
| 一致性 | **基本一致需修正**(1 major + 4 minor,无 blocker) | 已修:① caller 恒 'service'(与架构③同修)② REST 四码并入 ErrorCodes 单一来源(RestCodes 派生别名,契约 §8 一致)③ entry 帧收敛到被管理条目(managedRowIds 过滤,契约 §7 字面)④ 设计 §1 布局/inject 对齐实现(入口 src/index.ts + 探测式装配)⑤ rest.spec 补 GATE detail 转义边界断言 + 真实 HTTP e2e |

**已记录(推迟/接受)**:实机 3080 宿主验证(A3.6,复核通过后执行);官方 CLI bundles 对拍(M4 发布验证);webServer/tools 静态探测(preview 期,动态装配留 M4 评估)。

### 7.1 复核(锁定)结论(2026-08-14)

| 视角 | 结论 | 处理 |
|---|---|---|
| 架构复核 | **通过** — 3 major + 3 已修 minor 全部根因解决并验证;唯一未改(探测式装配)按上轮记录接受 | 复核暴露的新 minor 已修:events heartbeat `unref`;补 throwing-`res.write` 红测(该测试**捕获真实 bug**:`start()` 在写抛 dispose 后仍继续订阅/建 heartbeat → 已修 `start()` 各写后 `if (this.disposed) return`);补 uninstall/toggle/rollback 的 caller:'tool' 断言;补 UI 实体解码渲染测试(该测试**捕获真实 bug**:action 错误被 refresh() 立即清空 → 已修:错误持续到下次操作);design §1 tsdown 文件清单精确化 |
| 一致性复核 | **一致(通过锁定)** — 5 项全部与文档重新对齐,无新漂移;§8 码表 = 20 码与 ErrorCodes 逐字一致(上轮"21"为笔误);caller 三值可达性确认 | 复核补充:L-3 design §1 `tsdown.config.ts` 不存在 → 清单已改精确;L-3 保留码(PROFILE.NOT_FOUND/HMR.UNAVAILABLE)与契约一致,无动作;L-4 审计滞后指示(design §6 承诺)→ **已在 M4 T4.1 登记**,非本轮回归 |

**M3 锁定完成**。遗留登记:官方 CLI bundles 对拍(M4 发布验证);webServer/tools 动态装配评估(M4);审计滞后指示暴露(M4 T4.1)。修复后基线:**155/155 测试全绿**(含 A3.6 后新增 `tests/entry.spec.ts` 3 项:apply() 注册 10 路由+6 工具、headless 安全、`ctx.get` 可选探测回归)、host/client typecheck 零错误、build 产物正确、契约 §8 20 码单一来源、真实 web profile 全程未触碰(模板原样 + bundles 4 层未动)。

## 8. 风险与回退

- REST 与浏览器同源限制:UI 走同源 fetch,无 CORS 面;外部工具(非浏览器)经 agent 工具而非 REST;
- 工具名冲突:hotplug_* 前缀已避社区 plugin_*;若官方未来占用,先核对再改名(契约 §6 更新 + ADR);
- SSE 断线重连:UI 以 snapshot 兜底(事件仅增量刷新),断线自动重连;
- 任一验收不过:按 AGENTS.md 修复规则。
