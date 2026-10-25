# dsh-napcat-bridge 活跃需求与任务排期清单 (TODO)

> **更新日期**: 2026-10-26  
> **文档定位**: 项目根目录活跃任务追踪与排期总览  
> **排期原则**: 遵照用户拍板排期，P1 双轨并进（表情包交互体验 + 会话预设与安全隔离底座），P2 推进 JEV 前置群聊感知，P3/P4 顺延推进自修改演进与运维管理；P0 暂空，作为突发紧急阻塞预留位。

---

## 优先级总览

| 优先级 | 任务主题 | 核心模块 | 当前状态 | 下一步行动 |
|:---:|---|---|:---:|---|
| **P0** | *(暂无紧急阻塞)* | - | - | 预留位，随时响应生产故障或重大阻断缺陷 |
| **P1** | **表情包管理工具 · 本地表情库 · 设置卡表情包 Tab** | `src/tools/`<br>`src/client/`<br>`src/storage/` | **需求收敛**<br>(待前置实测) | 进行 M1~M3 开工前实测，验证 sub_type 渲染与复用性 |
| **P1** | **QQ 会话专属预设系统**（提示词纯净化 & 工具白名单硬隔离） | `src/gateway/session/`<br>`src/prompt/` | **方案收敛**<br>(待装配验证) | 验证 `complete: true` 覆盖与 `tools.restrict` 隔离，改造 `agent-runner.ts` |
| **P2** | **JEV 决策模型前置群聊感知与主动唤醒** | `src/gateway/wakeup.ts`<br>`src/gateway/jev.ts` | **方案定稿**<br>(沙盒实测验证通过) | 编写 TDD 契约测试，实现 JEV 客户端与门控装配 |
| **P3** | **Agent 自修改演进机制**（群专属人设/行为准则自我演进） | `src/gateway/session/`<br>`src/tools/` | **架构调研草案**<br>(待方案细化) | 细化自修改工具协议与权限栅栏设计，编写契约测试 |
| **P4** | **好友与群管理工具及专用管理 Session** | `src/gateway/`<br>`src/tools/` | **需求收敛**<br>(待实测与实现) | 验证管理 API 可达性，实现管理工具及独立 Session 隔离 |

---

## 任务详情与跟踪清单

### 【P1】表情包管理工具 · 本地表情库 · 设置卡表情包 Tab

- **相关文档**:
  - 规格需求: [devlog/需求文档-表情包管理工具与本地表情库.md](./devlog/需求文档-表情包管理工具与本地表情库.md)
  - 任务清单: [devlog/Checklist-表情包管理工具与本地表情库.md](./devlog/Checklist-表情包管理工具与本地表情库.md)
- **核心定位**:
  - 本地表情库作为唯一数据源，不操作、不镜像 QQ 收藏表情；
  - 提供 `list_faces` / `send_face` 工具赋能 Agent 生动趣味回复；
  - 设置卡新增「表情包管理」Tab（配额 / 列表 / 语义标签 / 启停 / 删除）；
  - 后台定期从落盘图片中识别表情包、打标并归档入库。
- **执行清单 (Next Steps)**:
  - [ ] 完成开工前实测 M1：`image` 消息段 `sub_type` QQ 侧渲染形态
  - [ ] 完成开工前实测 M2：尺寸与动图（GIF/WebP）压缩边界
  - [ ] 完成开工前实测 M3：发送端已上传资源复用性（`file_id`）验证
  - [ ] 表情库 SQLite/JSON 索引与文件目录结构实现
  - [ ] 注册 `list_faces` 与 `send_face` Agent 工具并编写契约测试
  - [ ] 前端设置卡「表情包管理」Tab 开发

---

### 【P1】QQ 会话专属预设系统（提示词纯净化 & 工具白名单硬隔离）

- **相关文档**:
  - 架构方案: [devlog/spec_session_preset_system.md](./devlog/spec_session_preset_system.md)
- **核心定位**:
  - 解决 QQ 会话全量继承 DSH 默认 Coding 预设导致的提示词膨胀问题（消除 "You are a coding agent..." 等冗余上下文）；
  - 建立工具白名单裁剪与隔离机制（`tools.restrict`），防止群聊中提示词注入（Prompt Injection）触发宿主系统级高危工具（如 bash/pwsh）；
  - 支持按群聊/私聊差异化装配纯净 Prompt 与安全工具集。
- **执行清单 (Next Steps)**:
  - [ ] 验证 `@deepseek-ai/dsh-system-prompt` 中 `complete: true` 的覆盖行为与纯净 Prompt 组装
  - [ ] 验证 `@deepseek-ai/dsh-tools` 中 `tools.restrict` 白名单裁剪隔离效果
  - [ ] 改造 `src/gateway/session/agent-runner.ts` 装配纯净 QQ 专属预设
  - [ ] 编写预设隔离契约测试（验证无 coding 提示词泄漏、高危工具不可见）

---

### 【P2】JEV 决策模型前置群聊感知与主动唤醒

- **相关文档**:
  - 规格需求: [devlog/需求文档-JEV决策模型前置群聊感知与主动唤醒.md](./devlog/需求文档-JEV决策模型前置群聊感知与主动唤醒.md) (v0.3)
  - 实测日志: [devlog/JEV模型本地实测与题目有效性探查.md](./devlog/JEV模型本地实测与题目有效性探查.md)
  - 试验脚本: `devlog/scratch/test_abstract_pragmatics.py`
- **核心定位**:
  - 解决群聊核心唤醒体验，引入 TypeSafe JEV / OpenJEV 作为前置直觉感知层；
  - 摒弃盲目随机摇号（解决低情商乱插话），并取消 JEV 模式下的回复冷却（解决连续追问漏回断链）；
  - 建立“全景社交场态感知原语网”（涵盖直接交流目标、社交边界、语用形态、修辞张力与槽点留白），并将元数据透传后续 Agent。
- **执行清单 (Next Steps)**:
  - [x] 开工前沙盒实测验证（T1~T6 在 RTX 2060S 本地小模型上 100% 验证通过）
  - [x] 修正连续对话冷却偏差，定稿 v0.3 需求规格
  - [ ] 编写契约测试：JEV 请求 Payload 组装器、State 构建器、多维解码与决策融合算法
  - [ ] 实现独立模块 `src/gateway/jev.ts`（支持超时中断与 Fail-Safe 优雅降级）
  - [ ] 在 `src/gateway/wakeup.ts` 中装配 JEV 门控链路
  - [ ] 扩展 `src/config/schema.ts` 配置项与前端 Web UI 设置卡片

---

### 【P3】Agent 自修改演进机制（群专属人设/行为准则自我演进）

- **相关文档**:
  - 架构方案: [devlog/spec_session_preset_system.md](./devlog/spec_session_preset_system.md)
- **核心定位**:
  - 在 QQ 会话专属预设系统的安全底座上，为 Agent 提供自主演变性格与群规准则的能力（"Soft Soul" 演进）；
  - 提供显式自我修订工具（如 `update_agent_soul` / `manage_session_preset`），支持在对话中根据用户反馈或群氛围持久化更新人设规则；
  - 严格保持人设软演进与系统权限硬策略的解耦，工具权限开关需配合管理员白名单鉴权，杜绝越狱风险。
- **执行清单 (Next Steps)**:
  - [ ] 细化自演进工具接口契约与鉴权安全边界（人设自修改开放 vs 工具开关鉴权）
  - [ ] 设计按 peer 持久化存储与热加载机制（如 `.dsh/napcat/soul/<peer>.md` 或配置 Profile）
  - [ ] 注册自演进工具并接入 `agent-runner`
  - [ ] 编写自修改演进行为与越权防御契约测试

---

### 【P4】好友与群管理工具及专用管理 Session

- **相关文档**:
  - 规格需求: [devlog/需求文档-好友与群管理工具及专用Session.md](./devlog/需求文档-好友与群管理工具及专用Session.md)
  - 任务清单: [devlog/Checklist-好友与群管理工具及专用Session.md](./devlog/Checklist-好友与群管理工具及专用Session.md)
- **核心定位**:
  - 为机器人管理员提供运维管理工具：好友申请审批、加群审核、群成员禁言与踢人；
  - 设计独立的专用管理 Session，将管理动作上下文与日常群聊/私聊闲聊彻底物理隔离；
  - 严格仅对管理员白名单授权调用，配备双向确认机制。
- **执行清单 (Next Steps)**:
  - [ ] 验证 NapCat OneBot 11 对应管理 Action 接口连通性（`set_group_kick`, `set_group_ban`, `set_friend_add_request`, `set_group_add_request`）
  - [ ] 设计并实现专用管理 Session 路由与生命周期管理
  - [ ] 注册管理类工具集并实施管理员白名单鉴权
  - [ ] 编写管理工具契约测试与装配验证
