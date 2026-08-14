# dsh-hotplug-engine

[English](./README.en.md)

给 DSH 做插件管理的服务插件。市场、agent、其他插件都能调用:安装、卸载、启停、回滚、审计,一条链路。

## 做什么

DSH 用 `cordis.patch.yml` 和 loader 管理插件。这个插件把这套操作包成服务:改 patch、调 pnpm、装后健康确认、失败自动回滚、全程审计。只动文件和命令,不碰内核。

## 不做什么

- **不是市场**:没有目录、搜索、榜单、推荐。`spec`(装什么、从哪装)由调用方给,引擎不猜。
- **不改官方机制**:HMR、loader、patch 语义都是官方的,只消费,不重写。
- **不另存状态**:以官方组合树为唯一真源,引擎只投影和差分。
- **不带安装界面**:UI 只有最小管理面板(查看、启停、回滚、审计),没有 spec 输入。

## 接入方式

| 场景 | 入口 |
|---|---|
| 市场 / 插件管理界面 | 注入 `hotplugEngine` 服务,或调 REST |
| agent 会话 | `hotplug_*` 工具 |
| 宿主插件 | 注入 `hotplugEngine` |

## 安装

```bash
pnpm --dir <profile-dir> add dsh-hotplug-engine
# 或 dsh plugin add dsh-hotplug-engine
```

bundle 包:装/卸后重启 profile;新客户端面板刷新页面加载。

## 上手

- **宿主注入**:`inject: ['hotplugEngine']`,调 `ctx.hotplugEngine` 的 `install` / `rollback` / `enable` 等方法,Promise resolve 即操作完成。
- **REST**:前缀 `/api/dsh-hotplug`,同源。写:`install` / `uninstall` / `enable` / `disable` / `rollback`;读:`snapshot` / `status` / `audit` / `operations` / `events`(SSE)。
- **工具**:`hotplug_status` / `hotplug_install` / `hotplug_uninstall` / `hotplug_toggle` / `hotplug_rollback` / `hotplug_audit`,写工具走审批。

完整契约见 [docs/01-contract.md](docs/01-contract.md)。

## License

MIT
