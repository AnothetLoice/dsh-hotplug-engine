# ADR-0006 对外接口:REST + agent 工具 + SSE 事件

- **状态**:已接受 | **日期**:2026-08-14
- **上位约束**:hotplug-engine-design.md §3(消费方集成路径)

## 背景
消费方分三类:host 型市场(inject 服务)、纯浏览器市场(需要 HTTP)、agent(需要工具)。工具名与社区冲突(web-plugin-manager 已用 `plugin_*`),且 `api` 通道为 Typert 所有(独立 bundle 带不了反射产物),需走 `ctx.webServer.register` 同源 REST。

## 决策
1. **REST 前缀固定** `/api/dsh-hotplug/*`(webServer.register 注册):snapshot/status/install/uninstall/enable/disable/rollback/audit/operations/events(见契约 §5);只读 GET 无需额外权限,写 POST 校验同源,v1 不做 token 鉴权(SHOULD 部署在可信网络);
2. **agent 工具用 `hotplug_*` 前缀**:`hotplug_status / hotplug_install / hotplug_uninstall / hotplug_toggle / hotplug_rollback / hotplug_audit`——避免与社区 `plugin_*` 工具名冲突;写工具遵循现有审批策略;工具描述 MUST 注明"客户端新插件需刷新页面、bundle 包需重启";
3. **SSE 事件** `/api/dsh-hotplug/events`:连接即发 snapshot 帧,此后推送 operation/entry 帧;消费方以 snapshot 为最终一致源;
4. host 型消费方优先 `inject: ['hotplugEngine']`,REST 是浏览器端与外部工具的通道。

## 备选
- 走官方 `/api` Typert 通道:需生成反射产物,独立 bundle 无法携带,排除;
- 工具名沿用 `plugin_*`:与 web-plugin-manager 同进程冲突,排除;
- v1 就做 token 鉴权:preview 期收益低、复杂度高,延后(记入 v2 候选)。

## 后果
- REST 是"无鉴权 + 同源"形态,安全边界靠部署网络;写工具经审批策略兜底;
- **REST 写路径无 agent 工具那套审批钩子**(同源 install 即执行任意包代码 = host 级妥协,比工具路径更弱)——**v2 候选**:为 install/uninstall 加可配置 token 或审批确认钩子(2026-08-14 review);
- 工具与 REST 共享同一 service 实现,不存在两套逻辑;
- 事件帧与快照的最终一致性是 UI 的刷新准则。

## 关联
- ADR-0002(服务身份)、ADR-0003(操作模型)
