# DSH-NapCat 全库核对整改报告（对照 Spec v1.0 / 需求 v0.4.1）

> 依据《DSH-NapCat-全面审查与整改报告》结论（整体符合率约 75%），对 `src/` 全库 A/B/C 三类问题逐条整改。
> 每条附修复后证据（`文件:行号` 指向整改后代码）；契约测试引用 src 真实模块，禁止 mock 桩自测（NapCat 网络为外部依赖，测试中以行为桩隔离）。
> 验收基线：`pnpm typecheck:all` 通过；`pnpm test` 全量 **9 套 46 例全绿**（原 8 套 22 例基础上新增/更新 24 例）。

---

## 0. 验证结果总览

| 项 | 结果 |
|---|---|
| `pnpm typecheck` / `pnpm typecheck:all` | ✅ 通过 |
| `pnpm test`（9 套 46 例） | ✅ 全绿 |
| 真实装配验证（`bootDshNapcatBridge` mountPlugin 挂载 + 真实 DSH 服务栈） | ✅ B2/B3 契约 5/6 与装配契约 3/4 均跑真实装配路径 |
| 需真机验证 | 见 §交付边界 |

---

## A 类硬伤（3 项）— 已全部修复

### A1 [高] 出方向 at_questioner / quote_original 接线

**整改**
- 新增共享串行发送器 `src/outbound/queue.ts:16`（`PerPeerSerialSender`，Spec §7.3 串行队列基座）。
- `src/outbound/stream.ts:81` 新增 `trackInboundContext(peer, {msg_id, from_user, is_group})`：记录唤醒源消息上下文。
- `src/outbound/stream.ts:150` `buildMessagePayload()`：群聊 peer 按配置组装前缀 —— `quote_original=true` 附 `CQ:reply`（引用唤醒原消息 id）、`at_questioner=true` 附 `CQ:at`（提问者 QQ）；私聊（`user_*`）不 @ 不引用，保持纯文本。
- `src/outbound/stream.ts:138` 同 turn 多段正文**仅首段**携带前缀（Spec §7.1"在首段 @ 提问者"）。
- `src/index.ts:448` 唤醒判定后向 outbound 记录唤醒源 `event.message_id` 与 `payload.from_user`。
- 配置声明保持 `src/config/schema.ts:21-22`（at_questioner 默认 false、quote_original 默认 true，决策 A）。

**契约测试** `tests/contract/outbound-stream.test.ts`（A1-契约 1~5）：
- 开关 4 组合（true/false × 2）下出站消息元素差异断言；
- 私聊不 @ 不引用；无上下文纯文本；首段-only 前缀。

### A2 [高] 工具降级路径去"假成功"

**整改**（统一返回 `{success:false, error:<清晰原因>}`，报错即信息，需求 §0.0）
- `send_file`：`src/tools/index.ts:166` 无 gateway/peer → 报错；`:197-199` NapCat 未返回 `message_id` → 按错误处理，删除写死 `10001`。
- `fetch_chat_resource`：`src/tools/index.ts:75-105` 删除 `'group_file_content_placeholder'` 占位写入与 `'not_found_id'` 哨兵分支；无 gateway/无 URL/下载失败均返回清晰错误。
- `poke_user`：`src/tools/index.ts:239` 无 gateway → `{success:false, error:'戳一戳执行失败: NapCat 未连接'}`。
- `expand_forward_message`：`src/tools/index.ts:146` 无 gateway → `{success:false, error:'...NapCat 未连接'}`（不再返回 `{success:true, messages:[]}`）。
- 提问 provider：`src/approval/responder.ts:73-77` 无 peer/gateway → **抛错**，删除自动选首选项的 `auto-answered` 分支。

**契约测试** `tests/contract/resource-fetch.test.ts`（A2-契约 1~7）、`tests/contract/questions-approval.test.ts`（A2-契约 1~3）：
- 各工具无 gateway / 失败时 `success:false` 且 `error` 非空断言；
- 提问无 peer/gateway 抛错断言。

### A3 [中] 正文 / 提问 / 审批 / 发文件统一走 per-peer 串行队列

**整改**
- 抽取共享发送器 `src/outbound/queue.ts`（`PerPeerSerialSender`，单任务失败不阻塞队列）。
- 接线：正文 `src/outbound/stream.ts:190`；提问 `src/approval/responder.ts:89-95`；审批 `src/approval/responder.ts:239-246`；发文件 `src/tools/index.ts:186-189`；装配层统一实例 `src/index.ts:40` 注入各方（`src/index.ts:127,210,256`）。

**契约测试** `tests/contract/serial-queue.test.ts`（A3-契约 1~4）：
- 同 peer 严格保序（前置延迟不插队）；不同 peer 独立；前置失败不阻塞；
- "先文本后提问"、"先提问后审批"顺序断言（正文/提问/审批 mock 桩仅隔离 NapCat 网络）。

---

## B 类中等问题（6 项）— 已全部整改

### B1 [中] /model 改为严格 per-session
- 删除写全局 `agentDefaultModel.saveSelection` 的代码（原 `src/commands/index.ts:260-270`）。
- `src/commands/index.ts:261` 经 `sessionManager.setModelSelection(session.id, provider, model)` 显式落位当前会话（`src/gateway/session.ts:82` selectionMap）；已存在 agent 时同步其 `modelSelection.current`（installModelSelection 引用同一 ref 对象，已核实 `@deepseek-ai/dsh-agent/lib/index.js:272-298`）。
- 无任何可落位服务时返回错误，不假装成功（`src/commands/index.ts:278`）。
- 契约：`tests/contract/commands-permission.test.ts` B1-契约 3 —— A 会话切换不影响 B 会话默认，覆盖式再切换生效。

### B2 [中] 消除 compositeProvider 字段旁路，对齐官方单 provider 状态机
- 已核实本机源码：`@deepseek-ai/dsh-user-questions/lib/index.js:33` —— `registerProvider` 在已有 provider 时抛 `DUPLICATE_PROVIDER`，**官方仅支持唯一 provider**。
- 整改：`src/index.ts:218` `tryRegisterQuestionProvider()`：仅在无其他 provider 时经官方 `registerProvider` 注册 NapCat 渠道；已有 provider（如 Web UI）时跳过并在日志明示，**绝不直接改写 `userQuestionsSvc.provider`**。
- 装配期实测：插件 `'ready'` 事件在 boot 完成后不补发（实测确认），故改为 **apply 阶段立即注册 + ready 兜底 + unref 轮询兜底**（修复了此前"QQ 提问渠道实际从未注册"的接线缺口）。
- 契约：`tests/contract/assembly.test.ts` B2-契约 3（无 provider 时注册 NapCatQuestionProvider）、B2-契约 4（已有 dummy provider 时插件不替换）；`tests/contract/questions-approval.test.ts` B2-契约 1（第二个 registerProvider 抛 DUPLICATE_PROVIDER）。

### B3 [中] 事件钩子核实 + 执行侧隔离改用官方 tools.guard
- **核实证据（本机源码）**：`system-prompt/assemble` 存在（`@deepseek-ai/dsh-system-prompt/lib/index.js:283`，waterfall 签名 `(assembly, AssembleContext{scope,agent}, next) => PromptAssembly`，`lib/types/index.d.ts:27`）；`tools/pre-execute` 存在但决策类型为 **PreToolDecision 对象**（`@deepseek-ai/dsh-tools/lib/types/index.d.ts:38,418`），且 gate 消费端 `lib/index.js:3116` 仅按 `decision.kind==='allow'` 放行——原先返回字符串 `'deny'` 是**静默无效果**（伪拦截）。
- 整改：删除 `tools/pre-execute` 伪拦截，改用官方单调守卫 `tools.guard((exec)=>reason|undefined)`（`dsh-tools/lib/types/index.d.ts:488,601-622`），`src/index.ts:177`；`system-prompt/assemble` 呈现侧过滤保留并加固 session 提取（`src/index.ts:153-166`，AssembleContext.scope 即 agent 对象）。
- 真实装配验证：`tests/contract/assembly.test.ts` B3-契约 5（非 QQ agent 调 `read_chat_history` → `isError` 且 message 含"仅限 QQ 会话"；QQ agent → 放行）、B3-契约 6（Web 装配不含 NapCat 工具、QQ 装配含全量 5 工具）。

### B4 [中] 提问/审批发送失败不再无限挂起
- `src/approval/responder.ts:96-101` 提问消息发送失败 → **reject**（错误含失败原因），不再 log 后进入 pending。
- `src/approval/responder.ts:238-249` 审批消息发送失败 / 无 peer / 无 gateway → 直接 `rejected`（不替用户放行，不挂起）。
- 契约：`tests/contract/questions-approval.test.ts` A2-契约 2（sendMsg 抛错 → ask reject）、A2-契约 3（审批无 peer/gateway → rejected）。

### B5 [低] ws_port 默认统一 8080
- `src/constants/index.ts:9` `DEFAULT_WS_PORT = 8080`；`src/client/card.tsx` hint/placeholder（默认 8080）。
- Spec §1.1/§8.2 已写 8080，实现与 Spec 对齐。

### B6 [低] bot_qq 必填 + 缺失告警
- `src/config/schema.ts:18` `z.string().required()`（Spec §8.2 一致）。
- `src/index.ts:36` 配置缺失时启动即告警"自循环防护将退化为仅依赖 post_type===message_sent"，避免静默降级。

---

## C 类低优先级（3 项）— 已全部清理

### C1 [低] /clear 真清空（用户确认语义：直接开启新对话、不归档）
- `src/commands/index.ts:341-359` `/clear` 调用 `sessionManager.markSessionCleared(session.id)`，返回真实结果文案。
- `src/gateway/session.ts:170` `markSessionCleared()`：推进 per-peer 会话版本号并失效缓存；`src/gateway/session.ts:138` `peerToSessionId` 对已 clear 的 peer 直接返回下一版本（跳过基础会话），**原会话保留、不入 workspaceRegistry 归档集**（与用户确认的"直接开启新对话、归档仅 Web UI 手动行为"一致）。
- 契约：`tests/contract/commands-permission.test.ts` C1-契约 4（clear 后 `group_1001 → qq-group-1001-2`、保持稳定、原会话不在 archivedSessionIds）。

### C2 [低] 死代码删除 + 稳定主键
- 删除零调用：`src/gateway/server.ts` `deleteMsg`（原 :274）、`getVersionInfo`（原 :340）；`src/index.ts` `updateSettingsWithRetry`（原 :552，全库 grep 确认零引用）。
- `src/index.ts:44` 新增 `stableNoticeMsgId()`（FNV-1a 32-bit 正数哈希）；`src/index.ts:484` group_upload、`:527` poke 通知入库改用稳定 id，消除 `-Date.now()` 负数主键高并发撞键风险。

### C3 [低] 消息段默认分支占位
- `src/gateway/wakeup.ts:149-176` 补 lightapp/share/music/location/contact/anonymous 占位（`[分享:标题]` `[音乐分享]` `[位置:标题]` `[联系人推荐]` `[匿名消息]`），未知类型输出 `[未知消息段:<type>]`，防静默丢段（Spec v1.0 未列、需求侧差异按 Spec 为准，占位保留）。
- 契约：`tests/contract/wakeup.test.ts` C3-契约 7。

---

## 附：DSH 本机源码核实证据（B2/B3，路径 `~/.dsh/profiles/node_modules/@deepseek-ai/`）

| 事实 | 证据 |
|---|---|
| userQuestions 仅支持唯一 provider，重复注册抛 DUPLICATE_PROVIDER | `dsh-user-questions/lib/index.js:33` |
| `system-prompt/assemble` waterfall 签名与 AssembleContext.scope=agent | `dsh-system-prompt/lib/index.js:283`、`lib/types/index.d.ts:27` |
| `tools/pre-execute` 决策为对象类型而非字符串，字符串 'deny' 被消费端忽略（静默放行） | `dsh-tools/lib/types/index.d.ts:38,418`（PreToolDecision）、`lib/index.js:3116`（gate 消费） |
| 官方单调守卫 `tools.guard`（plain-context 全局生效，返回字符串即拒绝） | `dsh-tools/lib/types/index.d.ts:488,601-622` |
| agent 的 `modelSelection` 为 SessionManager 注入的同一 ref（B1 per-session 依据） | `dsh-agent/lib/index.js:272-298`（installModelSelection） |

## 交付边界（如实标注）

1. **需真机验证**（本环境无真实 NapCat 客户端 / Web UI 连接）：
   - A1 的 `CQ:reply` / `CQ:at` 前缀在真实 NapCat 群聊中的渲染效果；
   - B6 `bot_qq` 必填后在 Web UI 设置卡片保存校验（客户端 bundle 装载）；client bundle 已 build 成功（`dist/client.js`）但未在浏览器侧人工核验；
   - B2 双 UI（dsh web host + QQ）真实部署下 provider 时序。
2. `/clear` 语义（直接开启新对话、不归档）已按用户确认实施。
3. 测试中 NapCat 网络以行为桩隔离（外部依赖隔离允许），装配/状态机路径全部走真实 DSH 服务栈。