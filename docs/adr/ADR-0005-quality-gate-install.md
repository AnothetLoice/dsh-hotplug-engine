# ADR-0005 质量门与安装执行

- **状态**:已接受 | **日期**:2026-08-14
- **上位约束**:hotplug-engine-design.md §5(可靠性承诺);机制事实 audit §1.3(boot fail-loud)

## 背景
官方 boot 是 **fail-loud**:一个坏行(缺依赖/缺客户端 bundle)会让整个 profile 起不来——安装期最大的破坏面。社区 web-plugin-manager 用"装后 import 扫描 + 回滚",但门禁应在**装前**更便宜;且安装执行不应依赖 `dsh` 在 PATH 上。

## 决策
1. **装前质量门**(quality.ts,见 02-design §4):入口可解析 / 裸导入对账(未声明且非 Loader 提供 → 拒)/ `dsh.client` 声明者必须有 `exports["./client"]` 产物;不通过 → `HOTPLUG.GATE.REJECTED`,不落盘;
2. **安装执行直接 spawn pnpm**(`pnpm --dir <profile> add|remove <spec>`,参数数组,Windows 经 cmd.exe /c pnpm.cmd),**不经 `dsh` CLI**(避免 PATH 依赖);bundles 簿记由 manifest.ts 自己做——**这是配置簿记 I/O,不是运行时机制,不违反红线 1**;等价性举证见下节;
3. **in-box bundles 保护**:base/web-app/headless 是安装自带、不是依赖——任何 bundles 变更后 MUST 恢复其原位;
4. **卸载联动清理**:uninstall MUST 摘除该包名对应的 managed insert 块(否则下次启动 boot 失败);
5. **按包形态 + 引擎模式分派生效方式**(与契约 §9.2 一致):声明 `dsh.bundle` → 写 bundles(restart);非 bundle → 装依赖 + managed insert 行(引擎 hot → hot;引擎 restart → 仍写行 + restartRequired)。

### 等价性举证(2026-08-14 review 补充)

自写 bundles 簿记 MUST 与官方 `dsh plugin` reconcile 逐条等价,依据官方源码 `@deepseek-ai/dsh/lib/plugin-9h8shc4d.js:46-77`:

1. 依赖中声明 `dsh.bundle.patch` 的包 → 追加进 bundles(不在则加,追加序 = 依赖序);
2. 依赖列表中的名字不再是 bundle(被移除/新版本丢声明)→ 从 bundles 摘除;
3. in-box bundles(base/web-app/headless)不是依赖 → **永不触碰**;
4. 落盘原子写(官方 `writeProfileManifest` 同款 tmp+rename)。

**边界声明**:红线 1(消费官方机制,绝不重写)针对的是**运行时机制**(热应用/客户端图/patch 语义/loader);bundles 列表是 profile 配置簿记,官方 reconcile 是 CLI 层 I/O——自实现不构成重写,但等价性由**对拍测试**锁定(同一 fixture profile 上,本引擎输出 vs 官方 CLI 输出逐条一致,见 02-design §11 manifest 行)。

## 备选
- 经 `dsh plugin` CLI 转发:需 dsh 在 PATH(运行期进程内不可靠),且 reconcile 行为不完全可控,排除;
- 只装不检(社区部分现状):坏包直接打穿 fail-loud,排除。

## 后果
- pnpm 必须可用(引擎可探测 `pnpm` 二进制,缺失时明确报错);
- 与官方 reconcile 的等价性需测试锁定(装/卸后 bundles 与官方 CLI 结果一致);
- 门禁/清理逻辑的测试用例需含坏包夹具(见 02-design §11)。

## 关联
- ADR-0003(操作模型)、ADR-0007(降级路径)
