# ADR-0004 写入层契约:owner managed block + 白名单 + 原子写

- **状态**:已接受 | **日期**:2026-08-14
- **上位约束**:hotplug-engine-design.md §5.1(写入层);机制事实 audit §3.2/§4(社区 YAML 陷阱、`!!js` RCE 面)

## 背景
`cordis.patch.yml` 是用户编辑区:整文件重写会毁用户注释/手写行;YAML 有多个致命陷阱(空 `[]` 双文档、`@` 保留符、注释-only → null);且 patch 文件 = 可执行代码(`!!js` 经 `new Function`+`eval` 求值 = host RCE)。

## 决策
1. **owner managed block**:写入只发生在 `# dsh-hotplug-engine:managed:start/end` 标记块内,一个块一个行 id,同 id 原位刷新(先摘除再写);**绝不整文件重写**;
2. **行级解析与编辑**(社区 web-plugin-manager patch.ts 同款语义,按 LICENSE 注明):不依赖 YAML 全量重序列化(避免重排用户版式);
3. **写前白名单**:rowId `^[A-Za-z0-9._/-]+$` ≤120;**包名收紧为 npm 命名规范**(2026-08-14 review:`^(@[a-z0-9-~][a-z0-9-._~]*/)?[a-z0-9-~][a-z0-9-._~]*$`、≤200、排除 `'`/`:`/空白/控制字符——防单引号转义注入);`@` 前缀 MUST 单引号;追加前 MUST 处理空文档 `[]`;删空后 MUST 恢复 `[]` 模板;slugify 生成 rowId 冲突时追加短哈希(2026-08-14 review);
4. **禁 `!!js`**:引擎写入的行 MUST NOT 包含 `!!js` 表达式(回显不可信内容 = RCE);
5. **原子写 + 写后校验**:`tmp(pid+uuid)+rename`,写后读回比对 + YAML 解析校验(顶层 seq、无 errors、目标行可达);失败 → `HOTPLUG.PATCH.INVALID` + 恢复备份。

## 备选
- 全量 YAML parse + 重序列化(hrhgit 路线):结构校验强,但重排用户版式、破坏注释位置,排除;
- 允许 `!!js` 支持"高级配置":安全面不可接受(§4.1),排除。

## 后果
- 引擎写入的行可整体摘除回滚,用户内容零扰动;
- 行级解析对"用户手写行"的 enable/disable 走"行级改 disabled 字段"(不删用户行),边界行为需测试锁定;
- 该层是安全红线最密集处,测试用例 MUST 覆盖全部陷阱(见 02-design §11)。

## 关联
- ADR-0003(操作模型)、ADR-0005(质量门)
