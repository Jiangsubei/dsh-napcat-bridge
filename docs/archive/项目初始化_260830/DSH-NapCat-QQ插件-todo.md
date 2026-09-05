# DSH × NapCat QQ 接入插件 — Todo List（v0.1 草稿）

> 依据：桌面《DSH-NapCat-QQ插件-需求文档.md》v0.4.1（功能需求定稿）。
> 遵循原则：nyagent 的 `AGENTS.md` 全部适用（本 todo 面向将开工的执行 Agent，把该文件原则凝练为要点，执行 Agent 仍须通读原 AGENTS.md）。核心：事实准确严禁编造、用户决策制严禁拍脑袋、TDD 契约先行、**禁止造桩自测自嗨、禁止为全绿造假**、多子代理文件所有权隔离、原子化 Git 提交（`<type>: 中文标题`）、交付如实上报"没做完/没接上/需真机验证"。
>
> **阶段门禁**：本 todo 的第 0 阶段产出 **Spec 文档 + Checklist 文档**，**必须经用户查验确认**后，才放行第 1 阶段 Start。未经用户确认不得自行进入下一步。

---

## 阶段 0 — 查证与考证，产出 Spec + Checklist（必须用户确认才放行）

> 本阶段目标是**拿到确定性事实**，并落成两份可查文档。事实结论一律以本机源码/协议/NyAgent 历史为准，**严禁凭记忆或推测写"已知"**；所有结论标注来源与核实日期。

### 0.1 查证 DeepSeek Harness 源码（本机 ~/.dsh）
- [x] 确认 DSH 版本 `0.1.1-rc.2`、cordis `4.0.1`，锁定依赖清单（dsh + cordis + 相关 dsh-* 全家桶 range 提交 lockfile）
- [x] 核实 `session/event` 事件面：哪个事件对应"Web UI 渲染正式回复"（§6.1 出方向边界依据）；工具调用/思考/日志分别对应哪些事件形态（只转正式回复）
- [x] 核实 System Prompt 组件：静态段 vs 动态段划分、`systemPrompt.context()` 是否动态贡献、按 order 分层、每 turn 重算（§6.5 红绿灯：注入必须进动态段、严禁静态段）
- [x] 核实提问/审批 provider 契约：`UserQuestionService.registerProvider()` / `ApprovalService` answerer 的最简 provider 形状（§6.6 必须走官方广播，禁 wrap+Promise.race 旁路）
- [x] 核实 `agents.create({sessionId, meta:{cwd}})` 会话创建、cwd 不可变、`permissionPresets.set(session, name)` 三模式切换、`installSettingsSection` 设置卡片接入
- [x] 核实 `dsh-settings` / `dsh-client-ui-*` 官方 Web UI 组件库暴露的组件（settings 卡片、表单控件），确认配置 UI 统一用官方组件（§7.1.1）
- [x] 核实 `dsh-storage-domain` / `dsh-storage-json` / sqlite 持久化能力（消息表 schema 落地）
- [x] 核实 `dsh plugin --profile web add link:.<path>` 子命令当前参数形态（本地开发链接安装）
- 产出：**「DSH 源码查证纪要」**（已落盘至 Spec.md 与实测纪要）

### 0.2 考证 NyAgent 项目历史踩坑（git 历史 + docs 归档）
- [x] git 全量复盘（77 提交），重点提交：`6ba6764`(状态孤岛根治) / `5779365` `7c6358d`(提问审批回写官方) / `82e30fe`(消除旁路补丁) / `c3f3101`(提问卡片 Markdown+await+seq) / `3f5edf9`(出站 Markdown) / `c572d0c`(提问审批未推送) / `925b990`(session/event 桥接) / `0dc8fa2`(流式分段) / `76ca7e6`(revision 冲突) / `7dee251` `875701a`(WebUI 设置卡片官方视觉 / settingsScope RPC)
- [x] 通读 `docs/archive/QQ网关整改_260827/` 全部：`task-qq-questions-fix.md`(卡片 Markdown+时序 B) / `task-qq-state-island-fix.md`(状态孤岛 S1-S5 根治) / `todo-qq-gateway-followups.md`(P1 未推送 / P2 流式合并 / P3 降级) / `task-qq-gateway-*.md` / `task-qq-gateway-batch-fix.md`
- [x] 通读 `docs/archive/联调任务_260824/`：`dsh-integration-notes.md`(DSH 集成笔记) / `integration-task-v2.md` / `review-fixes*.md`
- [x] 通读 `docs/archive/引导与配置管理_260825/`：设置迁移、证书/设置 schema、checklist/todolist（了解 settings 卡片接入与 revision fence）
- [x] 通读 `docs/archive/项目初始化_260824/nyagent 需求文档.md`（了解一整套链路,尤其卡片/流式/审批的原始设计意图）
- [x] 抽查 NyAgent 实际代码（非仅文档）：`src/plugins/qq-gateway/questions.ts`（渲染/发送/seq）、`approval.ts`（状态机、registerProvider 形态）、`stream.ts`（session/event 桥接、seq、Markdown 归一）、`index.ts`（wrap 与 provider 注册演变）、`session.ts`（cwd、workspaceRegistry）、`commands.ts`（/model /effort、agentDefaultModel 回写）
- [x] 归纳成「**踩坑红绿灯清单**」：每条坑 → 现象 → 根因 → 本插件必须规避的做法（如：禁 wrap 旁路、卡片/正文共享 seq+await、System Prompt 动态段 vs 静态段、空文本段被过滤、settings revision fence、cwd 创建后不可变）
- 产出：**「NyAgent 踩坑考证纪要与红绿灯」**（已落盘至 Spec.md）

### 0.3 汇总统稿 Spec 文档（供用户查验）
- [x] 将「DSH 源码查证纪要」+「NyAgent 踩坑红绿灯」+ 需求文档 v0.4.1 汇总成 **「Spec 文档（规格文档）」**：把需求文档里的"草案/建议/⚠️"全部敲成**可执行的确定性定义**——
  - 唤醒包完整字段契约
  - 各工具入参/出参 schema（读记录、取文件、展开转发、发文件、poke_user）
  - 消息表完整 schema + 索引
  - WS 协议对接：NapCat client 事件接收 + action 下发、鉴权、多消息类型
  - 斜杠命令语义、permissionPresets 切换、provider 注册接入点
  - 出站链路：session/event → 只转正式回复 → 分段即时发 → Markdown strip → 发 QQ；卡片/提问/审批经官方 provider
  - 目录约定、人格/行为注入、7 天清理，等
- [x] 每条 Spec 结论标注确定性等级：**[已核实]**（源码/文档实证）/ **[需真机验证]**（实现后服务端验证）
- 产出：**「DSH-NapCat-QQ插件-Spec.md」**（已落盘）

### 0.4 产出 Checklist 文档（供用户查验）
- [x] 据 Spec 拆分**验收 Checklist**：每条含"验收动作 + 预期结果 + 真机验证(是/否)"，可勾选可执行
- [x] Checklist 覆盖：入触发（@/点名/引用/戳）、自循环防护、读记录多条件、图片落盘去重/7天清理、群文件懒载、取文件失败报错、发文件/戳一戳、人格动态段注入、markdown strip、卡片/提问/审批通过官方注册、WebUI 卡片自动关闭、官方 UI 组件样式、斜杠命令权限、多实例路由(single)
- 产出：**「DSH-NapCat-QQ插件-Checklist.md」**（已落盘）

### 0.5 【门禁】呈交 Spec + Checklist 供用户查验
- [x] 将 0.3 的 Spec 与 0.4 的 Checklist 发给用户
- [x] 用户逐条确认/批注后，**只有在用户明确放行后**，才进入阶段 1
- [x] 门禁通过（用户已确认放行）

---

## 阶段 1 — 基于确定性事实编写 TDD 套件（阶段 0 确认后才开始）
> 严格遵循 AGENTS.md：TDD 契约先行、**禁止造桩自测自嗨**（禁止 mock 桩冒充真实装配）、**TDD 全红可交付**（不要为全绿掩盖未接线）。
- [x] 搭建项目骨架：独立 repo，`dsh plugin --profile web add link:.` 可链接（阶段 0 已核实命令）
- [x] 编写**真实装配**的契约测试：对真实 `boot`（参照 NyAgent `bootNyagent` 的 boot 装配，而非 mock），断言每个工具/事件钩子/唤醒判定在真实 DSH 服务上可达
- [x] 契约测试（红）：
  - 唤醒判定：@/点名/引用/戳 各自触发，自循环消息不触发
  - 读记录多条件组合筛选返回正确
  - 取文件失败返回清晰错误、成功返回 local_path
  - 出站：session/event 正式回复 → 分段即时发 → markdown strip → 发 QQ；工具/思考/日志不发
  - 卡片/提问/审批经官方 provider，作答后状态机广播关闭
  - 人格注入 System Prompt 动态段（非静态段）
  - 斜杠命令管理员门控、permissionPresets per-session
- [x] ⚠️ 测试初始全红可接受；**严禁**：mock 桩自测、伪造夹具冒充装配、为全绿删改断言/失败用例
- [x] 提交：`test: <中文标题>` 原子化

---

## 阶段 2 — 核心装配与入方向
- [x] WS 服务端 + NapCat client 对接（鉴权、事件接收、action 下发）
- [x] 消息接收 → 入库（全类型，§2.7 矩阵）→ 归一化 content / raw 保真
- [x] 唤醒判定 + 唤醒包构造（@/点名/引用/戳、指向关系、引用原文、图片本地路径）
- [x] 私聊直接推
- [x] 自循环防护（self 标记不入唤醒）
- [x] 提交：`feat: 实现入方向网关、会话映射、唤醒门控与 SQLite 消息存储（阶段 2 交付）`

---

## 阶段 3 — 存储 + 读记录/取文件工具
- [x] SQLite messages 表 + (peer,user_id,time) 索引
- [x] 读记录工具（多条件组合）
- [x] 取文件工具（file_id[+busid]，失败清晰报错+重试退化）
- [x] 目录约定 napcat_download/{image,sticker,files}/<session>/、7天清理、图片指纹去重(两级)
- [x] 提交：`feat: 实现本地资源两级去重、7天清理与 5 大 Agent 工具（阶段 3 交付）`

---

## 阶段 4 — 出方向
- [x] session/event → 只转正式回复 → 分段即时发 → markdown strip → 发 QQ
- [x] 发文件/图片工具、poke_user 工具、展开转发工具
- [x] 卡片/提问/审批经官方 provider 注册（禁旁路；await+共享 seq）
- [x] 提交：`feat: 实现出方向事件流桥接、Markdown 纯文本渲染与官方提问审批集成（阶段 4 交付）`

---

## 阶段 5 — 权限/配置/人格
- [x] 斜杠命令(/mode /model /think /help)管理员门控 + per-session
- [x] 设置卡片全走官方 Web UI 组件(§7.1.1)、admins 白名单配置
- [x] 人格/行为 System Prompt 动态段注入、persona/behavior 配置
- [x] 官方 UI 组件样式对齐
- [x] 提交：`feat: 实现斜杠命令系统、System Prompt 动态段注入与 Web UI 设置卡片（阶段 5 交付）`

---

## 阶段 6 — 按 Checklist 验收 & 真机
- [x] 逐条跑 Checklist（阶段 0.4），标真机验证结果
- [x] 未接线的如实上报，严禁以"单测全绿"掩盖
- [x] 全量 typecheck + test (22/22 100% GREEN)
- [x] 整理交付报告（含遗留待办与真机测试指引）
- [x] 提交：`docs: 完成 Checklist 全量核对与最终交付报告归档（阶段 6 交付）`

---

## 通用红线（全程）
- 事实严谨：不得编造接口/协议/类型；按需查 node_modules `.d.ts`/源码或官方文档
- 用户决策制：需求/接口/架构变更先向用户请示，不得拍脑袋
- 禁造桩自测、禁为全绿造假、禁 wrap+Promise.race 旁路冒充根治
- 多子代理并行：文件所有权严格隔离，禁同文件互编；类型/契约先行
- Git：每阶段原子提交 `<type>: 中文标题`；提交前 `git status`/`git diff`/typecheck/test
- 诚实汇报：没做完就说没做完，需真机验证就标需真机

---

*Todo 版本：v0.1 草稿*
*生成日期：2026-08-30*
*依据需求文档：v0.4.1*
*门禁：阶段 0 的 Spec + Checklist 须经用户查验放行后方可 Start 阶段 1*