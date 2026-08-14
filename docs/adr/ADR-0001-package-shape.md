# ADR-0001 包形态与挂载方式

- **状态**:已接受 | **日期**:2026-08-14
- **上位约束**:hotplug-engine-design.md §6(包形态);机制事实 audit §1.2(配置热应用激活)

## 背景
引擎自身如何安装与挂载,决定消费方与用户的引导路径;同时也决定引擎能否自我热管理。

## 决策
1. 引擎是 **bundle 双面插件**:声明 `dsh.bundle.patch`(`cordis.patch.yml` 内 `- insert: - id: hotplug-engine / name: 'dsh-hotplug-engine'`),host 半段(服务)+ client 半段(最小管理 UI);
2. 自身行 id 固定为 `hotplug-engine`(可被 profile patch disable,即"卸载引擎"= 禁用该行,HMR 卸载服务);
3. 官方 `dsh plugin --profile <name> add dsh-hotplug-engine` 可装(进 bundles 层,**首装需重启一次**);此后的所有插件变更走引擎热挂。

## 备选
- **非 bundle + insert 挂载**:自身可热挂,但安装引导需手工 insert 行(鸡生蛋),且 `dsh plugin add` 只装依赖不注册——引导摩擦大;
- 不声明 dsh.client(纯 host):放弃最小管理 UI,消费方只剩 API——与"给市场用"的定位不符。

## 后果
- 接受"引擎本身首装需重启"(一次性);换来官方安装路径零摩擦;
- 引擎运行期间可被禁用(自我卸载)或由引擎自身管理其他一切;
- 引擎的"热"承诺适用于**引擎管理的插件**,不适用于引擎自身首装——在 UI/工具描述中明示。

## 关联
- ADR-0002(服务身份)、ADR-0006(对外接口)
