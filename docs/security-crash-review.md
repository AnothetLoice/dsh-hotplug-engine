# dsh-hotplug-engine 安全与防崩溃只读评审

- 评审对象:`dsh-hotplug-engine`(DSH 热插拔执行引擎)
- 评审性质:**严格只读**,未修改任何代码
- 评审重点:安全性(攻击面 / 注入 / 越权 / 路径穿越)与防崩溃(异常处理 / 资源清理 / 进程存活)
- 评审方法:通读 src/ 全部源码(contract / host / client 共 19 个文件),对照 docs/01-contract.md、docs/adr/ADR-0006 的既定决策,交叉核对 tests/ 覆盖情况
- 结论摘要:整体工程防御意识强(串行队列、原子写、备份回滚、审计 lag、SSE guard、同源围栏、自毁守卫、!!js 白名单),但发现 **2 处高危、3 处中危、若干低危/健壮性缺口**,详见下文。

---

## 1. 信任模型与攻击面总览

| 面 | 位置 | 鉴权 | 风险 |
|---|---|---|---|
| 宿主服务 | HotplugEngineService | cordis inject | 受信宿主插件/市场 |
| agent 工具 | hotplug_install/uninstall/toggle/rollback | tools/pre-execute → 审批策略(fail-closed) | 写工具经审批兜底 |
| REST | POST /api/dsh-hotplug/* | **仅同源围栏,无 token**(ADR-0006 已定) | 见 H1 |
| SSE | GET /api/dsh-hotplug/events | 同源围栏 | 低 |
| 浏览器 UI | 面板(只读+启停+回滚,无安装入口) | 同源 | 低 |

核心事实:引擎的写入最终落点是 cordis.patch.yml(官方 loader 以 new Function + eval 求值 !!js 表达式,即 host RCE 面)与 package.json;install 经 pnpm add 会执行包的生命周期脚本(postinstall 等),本身就是任意代码执行。因此“写入口的鉴权与输入校验”是本引擎安全的第一要务。

---

## 2. 高危(HIGH)

### H1 — REST 安装端点 = 本地任意代码执行,且无 token 鉴权(设计决策,但为最高暴露面)

- 位置:src/host/rest.ts:117-133(install 路由)、src/host/installer.ts:107-114(pnpmAdd)、src/host/rest.ts:269-315(同源围栏)
- 事实:POST /api/dsh-hotplug/install 直接以 spec 调用 pnpm --dir <profile> add <spec>。pnpm 会执行被装包的 postinstall/生命周期脚本 → 任意代码执行。唯一的防护是 isSameOriginRequest(回环 peer + 回环 Host + Origin 匹配 + sec-fetch-site 反跨站),**没有任何 token/凭证校验**。
- 影响:任何能连到 3080 端口的本地进程、任何同机用户,都能通过安装一个恶意本地目录/包实现对宿主机的代码执行(宿主用户权限)。这比 agent 工具路径更弱——工具写路径还有审批策略兜底,REST 写路径没有(ADR-0006 §4.2 已自陈“同源 install 即执行任意包代码 = host 级妥协”)。
- 定性:这是**明文的 v1 设计决策**(ADR-0006:v1 不做 token 鉴权,SHOULD 部署在可信网络),不是实现偏离;但评审必须将其列为**最高暴露面**。同源围栏本身实现得较扎实(同时校验 peer 地址、Host、Origin、sec-fetch-site,可挡住浏览器 CSRF 与 DNS rebinding),它挡住的是“浏览器侧攻击”,挡不住“本地进程侧攻击”。
- 建议(v2 候选已列):为 install/uninstall 增加可配置 token 或审批确认钩子;至少在非 loopback 绑定时硬性拒绝。

### H2 — 回滚句柄(handle)未校验格式 → 路径穿越(path traversal)

- 位置:src/host/service.ts:228-247(rollback)、src/host/backup.ts:59-60(sidecarPath)、backup.ts:99-100(loadBackup)
- 事实:rollback(handle) → loadBackup(dshHomePath, handle) → sidecarPath(dir, handle) = join(dir, '<handle>.json')。**handle 是调用方可控的**(工具 hotplug_rollback、REST POST /rollback、宿主 rollback() 三处传入),但**没有任何格式校验**(队列实际生成的 id 恒为 op-<Date.now()>-<seq>,见 queue.ts:41,却无人断言)。传入 handle=../foo 即可让 join 逃逸备份目录。
- 影响(exploit 前提需如实说明):
  1. **任意 .json 读取**:可读到备份目录之外的任意 JSON 文件(须 JSON.parse 成功,失败返回 undefined)。读取内容不会直接回显给调用方,但会被当作 BackupHandle 使用。
  2. **潜在的受限任意写**:若读取到的对象恰好呈 BackupHandle 形状、其 patchBackup/manifestBackup 指向现存文件、patchPath/manifestPath 指向目标,则 rollbackByHandle(backup.ts:118-172)会 writePatchAtomic(handle.patchPath, restoredPatch) 覆盖任意路径(内容受 validatePatchContent 约束为合法顶层 YAML 数组)。Path B 分支同理受 patchAfterHash / managed-block 存在性约束。
  - 缓解因素:完整利用需攻击者能在 $DSH_HOME/backups/hotplug-engine/ 写入 sidecar(与引擎同信任级)或找到现成的“BackupHandle 形状 JSON 小工具”,故现实的严重度取决于备份目录的写权限边界。但作为文件写入引擎,外部可控句柄未经校验直接拼路径,是红线级缺陷(违背 AGENTS.md“写行白名单化 / 写前门禁”精神)。
- 建议:在 rollback 入口强制 /^op-\d+-\d+$/ 校验(或改为从不信任外部字符串、只按格式查 sidecar);对 loadBackup 返回的 patchPath/manifestPath/patchBackup 重新校验其落在 backupDir 与 profile 目录内。

---

## 3. 中危(MEDIUM)

### M1 — Profile 名白名单接受 . 与 .. → 路径别名逃逸

- 位置:src/host/manifest.ts:24(PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/)、manifest.ts:57-62(profileDirIn)、service.ts:836-847(resolveProfile)
- 事实:正则允许点号,故 . 、.. 均匹配。profileDirIn(dshHome, '..') = join(dshHome, 'profiles', '..') 归一化为 **$DSH_HOME 根目录**;'.' 指向 profiles/ 目录本身。二者都能通过 resolveProfile 的 existsSync 检查(DSH_HOME 恒存在)。
- 影响:以 profile='..' 调用 install/uninstall 会把 $DSH_HOME 当 profile 目录 → pnpm --dir $DSH_HOME add/remove(改写 $DSH_HOME/package.json)、写 $DSH_HOME/cordis.patch.yml、restoreInBoxBundles 改 $DSH_HOME/package.json。属于“意外写目标/混淆”,因同用户不构成额外提权,但白名单本意是防穿越,却漏了路径别名。
- 定性:契约 01-contract.md:142 明文采用该正则,故是**白名单不充分**(而非实现偏离)。
- 建议:正则显式排除 . / ..(如 /^(?!\.\.?$)[A-Za-z0-9._-]+$/,或改 /^[A-Za-z0-9][A-Za-z0-9._-]*$/ 并追加 name !== '.' && name !== '..')。

### M2 — pnpm 命令输出原样进入错误消息(终端转义 / 日志注入面)

- 位置:src/host/service.ts:319、service.ts:430(add.output.slice(0, 2000) / rm.output.slice(0, 2000) 进入 EngineError.message)
- 事实:pnpmAdd/pnpmRemove 失败时,子进程原始 stdout+stderr 被原样拼进错误消息 → MutationResult.message → 工具渲染文本 / 面板显示。包脚本可输出 ANSI 转义序列、终端控制字符或伪造日志行,污染终端显示与日志。对比:gateError(service.ts:967-970)已用 escapeHtml 清洗,但 pnpm 输出这条路径**未做任何清洗**。
- 建议:对进入 message 的 output 剥离 ESC/控制字符(如 /[\x00-\x1f\x7f]/g 过滤)并二次限制长度;或在 runPnpm 汇总时统一清洗。

### M3 — readPatch 无异常防护,多处直接传播

- 位置:src/host/manifest.ts:102-105(readPatch 无 try/catch)、调用点 service.ts:130(snapshot)、623/651(writeEnable/writeDisable)、772/804(scanPhases/managedRowIds)、875(startupReconcile)
- 事实:文件存在但不可读(权限)时 readFileSync 会 throw。readManifest 已用 try/catch 返回 {}(manifest.ts:86-94),但 readPatch 没有,造成防御不一致。
- 影响:进程不会崩(snapshot 由 REST try/catch 兜底 400、scanPhases 自身 try/catch、mutate 路径在 try 内),但会在只读 GET 上 4xx、在工具/SSE 上异常;属于健壮性缺口。
- 建议:readPatch 内部 try/catch 返回 ''(空串),与 readManifest 对齐。

---

## 4. 低危 / 健壮性(LOW / 观察项)

- **L1 — writePatchAtomic 的 rename 重试用同步 busy-wait**:patch.ts:574-606,sleepSync 空转,最坏累加约 2.75s(50ms×1..10),期间事件循环被阻塞(phase monitor、SSE heartbeat、其他请求全停)。建议改异步重试+退避,或降低上限。
- **L2 — tmp 文件名用非密码学随机**:manifest.ts:126(Math.random)、patch.ts:610-612(sha1(Date.now+Math.random))。仅影响临时文件名的不可预测性,非安全问题;可改用 crypto.randomBytes 统一。
- **L3 — 本地目录 spec 允许绝对路径与 ../ 相对逃逸**:installer.ts:37-41、57-58。assertSafeSpec 只拦 cmd 元字符,/ 与 . 放行,故 spec=/etc/x 或 ../../x 可通过 isLocalDirSpec 进入 qualityCheck(resolveLocalDir(spec)) 与 pnpm add。由于“安装任意本地目录=允许执行任意代码”本就是 install 语义,不构成额外提权,但质量门会对任意本地路径读 package.json(信息面)。建议对 local spec 规范化并限制在 profile 目录/明确工作区。
- **L4 — 操作历史仅存内存**:operations Map 是进程内(service.ts:93),重启即空,listOperations 归零;回滚与中断审计靠 sidecar JSON 兜底(service.ts:868-928)。属已知设计(contract §4),但值得留意“rolled-back 状态”与操作历史一致性依赖 sidecar 持久化正确性。
- **L5 — REST 只读响应的 writeHead/end 无 try/catch**:rest.ts:361-383。respondMutation 有 try/catch,但 snapshot/status/audit/operations 与 writeEngineError 直接 writeJson;若连接半关时 writeHead 抛错,handler promise 可能 unhandled-reject(取决于 webServer 框架是否兜底)。建议统一 try/catch 或由框架统一兜底。

---

## 5. 防崩溃评估(正面)

以下机制显著降低了崩溃与半程失败风险,予以肯定:

1. **串行队列无 unhandled rejection**:OperationQueue.enqueue 的 done 永不 reject、内部 chain 恒 resolve(queue.ts:43-49),错误在队列内被消费。
2. **mutating 操作全链路 try/catch**:service.ts 的 install/uninstall/enable/disable/rollback 均在 failWithRollback 中收口(service.ts:498-519),审计 append 永不 throw(audit.ts:21-31)、emit 捕获监听器异常(service.ts:747-751)。
3. **观察窗口全异步**:health.ts 的轮询均为 setTimeout 异步,不阻塞;phase monitor 定时器 unref()(service.ts:762)不会拖住进程退出。
4. **SSE 连接 guard**:EventStream 对 writeHead/write 加 try/catch,连接半死时 dispose 而非抛异常(events.ts:58-121);心跳 unref()。
5. **请求体上限**:REST MAX_BODY_BYTES = 1MB + JSON 解析失败 400(rest.ts:72-73, 343-359),防止内存耗尽。
6. **原子写 + 读回校验**:writePatchAtomic 走 tmp+rename 并读回比对(patch.ts:574-599),Windows 共享违规(EACCES/EBUSY/EPERM)有重试。
7. **自毁守卫**:enable/disable 拒绝操作引擎自身行 ENGINE_ROW_ID='hotplug-engine'(service.ts:563-565);uninstall 拒绝从宿主 profile 卸载引擎自身(service.ts:408-410)。
8. **!!js 永不写**:引擎写入的行永不包含 !!js 表达式(patch.ts:30-35),且解析用 opaque schema(patch.ts:66-71)从不求值;entryId/包名均白名单化(patch.ts:97-118)。
9. **命令注入防护**:spec 拒 cmd 元字符(含 %,见 installer.ts:28-30 注释),Windows 下 cmd.exe /d /s /c + 逐参数 quote + windowsVerbatimArguments(installer.ts:65-104)。
10. **同源围栏较扎实**:同时校验 peer 地址、Host、Origin、sec-fetch-site(rest.ts:295-315),可挡浏览器 CSRF 与 DNS rebinding。

## 6. 修复优先级建议

| 优先级 | 项 | 动作 |
|---|---|---|
| P0 | H2 rollback handle 穿越 | 校验 /^op-\d+-\d+$/ 并对 sidecar 内路径重新校验归属 |
| P0 | H1 REST install RCE | v2 token/审批钩子;非 loopback 绑定硬拒(设计变更,走 ADR) |
| P1 | M1 profile . / .. | 收紧 PROFILE_NAME_RE,显式排除路径别名 |
| P1 | M2 pnpm 输出清洗 | 剥离控制字符/ESC 后进入 message |
| P1 | M3 readPatch 防御 | 内部 try/catch 返回空串 |
| P2 | L1/L2/L3/L5 | 异步重试、crypto random、local spec 规范化、REST 响应 try/catch |

### M5 整改状态(2026-08-14,见 plans/05-M5-security-hardening.md)

| 项 | 状态 | 落地 |
|---|---|---|
| H2 | **已修** | assertSafeOperationId(/^op-\d+-\d+$/) + loadBackup 路径归属 + rollbackByHandle sidecar 路径复校(三层) |
| H1 | **已决策(加法式 opt-in token)** | restToken options/环境变量 DSH_HOTPLUG_REST_TOKEN;写端点 Bearer 门禁(timingSafeEqual);未配置=现状;已标注 01-contract §5/§8 与 ADR-0006 |
| M1 | **已修** | profileDirIn 显式拒绝 '.' / '..'(PROFILE_UNSAFE) |
| M2 | **已修** | sanitizeTerminal 剥离 C0/C1+ESC 后嵌入 message |
| M3 | **已修** | readPatch try/catch 返回空串 |
| L1 | **已修(调优)** | RENAME_RETRY_LIMIT 10→5、DELAY 50→20(保持同步,异步化留 v2) |
| L2 | **已修** | tmp 名改 randomBytes 密码学随机 |
| L3 | **待决策** | local spec 路径作用域需用户拍板,本阶段仅登记(可能破坏"任意目录安装"用法) |
| L4 | **已决策(defer)** | 操作历史持久化仅文档化,不实现 |
| L5 | **已修** | writeJson 内部 try/catch(一处收口) |

> 实测记录与回归见 harness-research/hotplug-dev-audit.md §7(M5 段)。

---

## 7. 评审范围声明

- 本评审**未执行**任何写操作、未安装/卸载任何包、未触发任何引擎方法;仅静态通读源码 + 交叉核对契约/ADR/测试。
- 未动态验证的假设(如 rollback 穿越在真实 $DSH_HOME 下的读/写效果、pnpm 生命周期脚本实际执行)建议在演练 profile(hotplug-drill/ 夹具)上补充针对性测试。
- 客户端侧(XSS)结论:React 文本节点自动转义、createEntry 用静态 innerHTML 无用户输入、面板无安装入口,未发现可注入点(panels.tsx:31-40 的 decodeEntities 后仍经 React 文本节点渲染,安全)。
