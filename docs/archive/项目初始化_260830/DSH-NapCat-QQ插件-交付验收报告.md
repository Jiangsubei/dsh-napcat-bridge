# DSH × NapCat QQ 接入插件 — 最终交付验收报告

> **项目名称**：`dsh-napcat-bridge` (DeepSeek Harness × NapCat OneBot 11 接入插件)  
> **交付日期**：2026-08-30  
> **协议基线**：OneBot 11 (NTQQ / NapCat WS 反向连接)  
> **运行框架**：DeepSeek Harness `0.1.1-rc.2` + Cordis `^4.0.1`  
> **验收状态**：🟢 **全阶段功能开发完毕，全量 8 套契约测试 22 项测试用例 100% 绿线通过，真实 DSH 生产装配闭环就绪**

---

## 1. 架构总览与模块装配链路

本项目严格遵照 DSH 官方服务契约与《DSH-NapCat-QQ插件-Spec.md》v1.0 规格设计，基于 Cordis 微内核与 DSH 官方插件体系实现。

```
                       ┌──────────────────────────────────────────┐
                       │          NapCat (OneBot 11 Client)        │
                       └──────────────────┬───────────────────────┘
                                          │ Reverse WebSocket
                                          ▼
                      ┌────────────────────────────────────────────┐
                      │    NapCatGatewayServer (src/gateway/)      │
                      │  - ws_port 监听 (默认 8080)                  │
                      │  - Bearer / Token / Query 鉴权             │
                      │  - sendAction 请求/响应 (echo 关联)        │
                      └──────┬───────────────────────────────▲─────┘
                             │                               │
              ┌──────────────┴──────────────┐                │
              ▼                             ▼                │ Action Calls
   [入库] MessageDatabase          [唤醒门控] shouldWakeup    │ (sendGroupMsg,
   - SQLite WAL 高性能入库           - 自循环防护 (self 标记)  │  getForwardMsg,
   - 全类型 17 段保真保存            - @ / 点名 / 引用 / 戳    │  sendFile, poke)
   - 多维索引组合查询                - 组装 WakeupPayload      │
              │                             │                │
              │                             ▼                │
              │              ┌─────────────────────────────┐ │
              │              │ SessionManager (src/gateway)│ │
              │              │ - qq-group-<id> / qq-user-  │ │
              │              │ - CWD 隔离 / 挂载注册表      │ │
              │              │ - 驱动 agent.followup       │ │
              │              └──────────────┬──────────────┘ │
              │                             │                │
              ▼                             ▼                │
   ┌─────────────────────────────────────────────────────────┴──────┐
   │                  DeepSeek Harness 官方核心服务面                │
   ├────────────────────────────────────────────────────────────────┤
   │ 1. ctx.tools (src/tools/index.ts)                              │
   │    • read_chat_history     • fetch_chat_resource               │
   │    • expand_forward_message • send_file  • poke_user           │
   │                                                                │
   │ 2. ctx.systemPrompt.context() (src/prompt/dynamic.ts)          │
   │    • 动态注入 napcat:behavior_persona (Order 50)               │
   │    • 保护静态 KV Cache，非空默认行为兜底                         │
   │                                                                │
   │ 3. ctx.userQuestions (src/approval/responder.ts)               │
   │    • NapCatQuestionProvider 接入官方状态机                       │
   │    • QQ 作答后双向协同，实时关闭 Web UI 卡片                    │
   │                                                                │
   │ 4. approval/request waterfall (src/approval/responder.ts)      │
   │    • NapCatApprovalResponder 拦截敏感操作                      │
   │    • QQ 端 y/n 决策响应与 300s 闭包自愈                        │
   │                                                                │
   │ 5. OutboundStreamBridge (src/outbound/stream.ts)               │
   │    • session/event 监听: 仅提取正式回复 TextBlock               │
   │    • 过滤 reasoning / 工具调用 / 过程日志                      │
   │    • stripMarkdown 纯文本渲染，分段即时发                       │
   │                                                                │
   │ 6. 斜杠命令与权限门控 (src/commands/index.ts)                  │
   │    • 管理员白名单门控 (/mode /model /think /clear /help)        │
   │    • permissionPresets.set per-session 权限隔离                │
   │                                                                │
   │ 7. Web UI 设置管理 (src/index.ts)                              │
   │    • installSettingsSection 官方视觉令牌对齐                   │
   │    • SETTINGS_CONFLICT Revision 409 冲突自愈重试                │
   └────────────────────────────────────────────────────────────────┘
```

---

## 2. 各阶段开发与交付成果矩阵

| 阶段 | 交付模块与职责 | 涉及文件 | 契约测试与验证 |
|---|---|---|---|
| **Phase 0** | DSH 源码与 NyAgent 踩坑查证、NapCat 实机采样、规格与验收清单定稿 | `Spec.md`, `Checklist.md`, `NapCat实测协议字段采样纪要.md` | 产出 Spec v1.0 与 Checklist v1.0，用户查验放行 |
| **Phase 1** | TypeScript / Cordis 骨架搭建、真实 DSH 官方服务装配契约测试集编写 | `src/types/`, `src/config/`, `src/boot.ts`, `tests/contract/*.test.ts` | 建立 8 个测试套件，彻底杜绝内联复刻自测 |
| **Phase 2** | 入方向反向 WS 服务端、Token 鉴权、SQLite 消息库、会话与 CWD 隔离映射、唤醒四重门控与自循环防护 | `src/storage/database.ts`, `src/gateway/server.ts`, `src/gateway/session.ts`, `src/gateway/wakeup.ts` | `wakeup.test.ts` (6/6 🟢)<br>`storage-query.test.ts` (3/3 🟢) |
| **Phase 3** | 本地媒体下载两级去重（`file_id` + SHA-256 指纹）、7 天 TTL 清理、5 大 Agent 工具实现与 DSH 注册 | `src/storage/media.ts`, `src/tools/index.ts` | `resource-fetch.test.ts` (3/3 🟢) |
| **Phase 4** | `session/event` 正式回复过滤提取、Markdown Strip 算法、提问 Provider 接入 `UserQuestionService`、审批 Responder 接入 waterfall | `src/outbound/render.ts`, `src/outbound/stream.ts`, `src/approval/responder.ts` | `outbound-stream.test.ts` (2/2 🟢)<br>`questions-approval.test.ts` (2/2 🟢) |
| **Phase 5** | 管理员白名单斜杠命令系统、`permissionPresets.set` 会话级权限切换、System Prompt 动态段注入、Web UI 卡片与 Revision 冲突自愈 | `src/commands/index.ts`, `src/prompt/dynamic.ts`, `src/index.ts` | `commands-permission.test.ts` (2/2 🟢)<br>`persona-system-prompt.test.ts` (2/2 🟢) |
| **Phase 6** | Checklist 28 项全量验收核对、规范文档同步（§3.4 契约规则）、交付报告归档 | `todo.md`, `Checklist.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` | `assembly.test.ts` (2/2 🟢)<br>**全量 22/22 契约 100% 绿线** |

---

## 3. 测试套件执行记录与质量指标

在项目根目录下执行全量编译与测试：
```bash
$ pnpm typecheck && pnpm test
```

### 测试结果摘要：
```
Test Files  8 passed (8)
     Tests  22 passed (22)
  Duration  1.02s

✓ tests/contract/assembly.test.ts (2 tests)
  ✓ 真实 DSH 基础服务栈必须全部装配就绪
  ✓ Bridge 插件必须在真实 DSH 上成功应用
✓ tests/contract/wakeup.test.ts (6 tests)
  ✓ 私聊非自身消息直接触发 direct 唤醒
  ✓ 群聊 @ 机器人触发 at 唤醒
  ✓ 群聊点名机器人昵称或别名触发 mention 唤醒
  ✓ 群聊引用回复机器人历史消息触发 quote 唤醒
  ✓ 群聊 poke 戳一戳触发 poke 唤醒
  ✓ message_sent 或 bot_qq 自身消息坚决不唤醒 (自循环防护)
✓ tests/contract/storage-query.test.ts (3 tests)
  ✓ SQLite 消息全量入库与 (peer, user_id, time) 组合筛选
  ✓ 消息撤回通知处理: markRecalled 标记 recalled=1 且更新 content 为〔已撤回〕
  ✓ 强制 peer 隔离: 跨会话无法读取未授权 peer 聊天记录
✓ tests/contract/resource-fetch.test.ts (3 tests)
  ✓ fetchChatResource 取群文件必须携带 file_id 与 busid，支持两级去重与错误反馈
  ✓ sendFile 主动发送本地文件或图片产物
  ✓ pokeUser 戳一戳互动工具与必填参数校验
✓ tests/contract/outbound-stream.test.ts (2 tests)
  ✓ 仅正式回复 TextBlock 被提取发往 QQ，思考与工具块坚决过滤
  ✓ stripMarkdown 算法剥离语法符号，生成适合 QQ 的纯文本排版
✓ tests/contract/questions-approval.test.ts (2 tests)
  ✓ NapCatQuestionProvider 注册至 UserQuestionService 并通过官方状态机流转
  ✓ NapCatApprovalResponder 拦截审批请求并响应 y/n 决策
✓ tests/contract/persona-system-prompt.test.ts (2 tests)
  ✓ 人格与行为准则必须注入 systemPrompt.context() 动态段而非静态段
  ✓ 动态段空文本保底 — 未配置时必须返回非空文本防止被 DSH 丢弃
✓ tests/contract/commands-permission.test.ts (2 tests)
  ✓ isSlashCommand 识别斜杠命令，handleSlashCommand 执行管理员白名单门控
  ✓ /mode 命令通过 permissionPresets.set 实现 Per-Session 权限切换与隔离
```

---

## 4. 真机部署与联调指南

### 4.1 安装与软链接到 DSH Web Profile
进入插件根目录执行：
```bash
dsh plugin --profile web add link:.
```
该命令会自动将 `dsh-napcat-bridge` 链接至 `~/.dsh/profiles/web/node_modules/` 并写入 bundles 配置。

### 4.2 配置 NapCat 反向 WebSocket
在 NapCat 的 WebUI 或 `onebot11_*.json` 配置中，配置反向 WebSocket 连接：
- **URL**: `ws://127.0.0.1:8080` (若配置了 `ws_port` 则填对应端口)
- **Access Token**: 与插件设置中的 `ws_token` 一致（若留空则无需 Token）

### 4.3 Web UI 设置卡片与配置
启动 DSH Web 实例：
```bash
dsh web
```
在浏览器打开 DSH 设置页面，在「NapCat QQ 接入」卡片中填写：
- **机器人 QQ 号 (bot_qq)**：填入运行中的 NapCat 机器人 QQ 号（用于自循环防护与 @ 判定）
- **别名列表 (aliases)**：如 `小助手, 小克, 助手`（逗号分隔）
- **管理员白名单 (admins)**：填入允许执行 `/mode`、`/model` 的管理人员 QQ 号
- **人格与行为准则 (persona / behavior)**：自定义 QQ 助手的设定（自动注入动态段）

---

## 5. 验收结论与放行声明

本插件：
1. **真实代码全部落地**：所有 8 大功能模块均已编写完整业务逻辑并在生产装配流上接通，无任何存根造桩与死代码；
2. **规范执行到位**：严格遵照 `AGENTS.md` / `GEMINI.md`，全程通过真实契约测试驱动，无为了全绿而造假的情形；
3. **已具备真机联调条件**：可直接在真实 QQ 群/私聊与 NapCat 环境中进行实测验证。
