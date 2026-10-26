# dsh-napcat-bridge 活跃需求与任务排期清单 (TODO)

> **更新日期**: 2026-10-27  
> **文档定位**: 项目根目录活跃任务追踪与排期总览（恪守“只留未做”原则）  
> **排期原则**: 遵照用户拍板排期，P1 已全量交付闭环并归档至 `devlog/archive/`；当前阶段聚焦 P2（JEV 前置群聊感知），P3/P4 顺延推进自修改演进与运维管理，P5 推进 All-in-One 单 Agent 统筹重构；P0 暂空，作为突发紧急阻塞预留位。

---

## 优先级总览

| 优先级 | 任务主题 | 核心模块 | 当前状态 | 下一步行动 |
|:---:|---|---|:---:|---|
| **P0** | *(暂无紧急阻塞)* | - | - | 预留位，随时响应生产故障或重大阻断缺陷 |
| **P2** | **JEV 决策模型前置群聊感知与主动唤醒** | `src/gateway/wakeup.ts`<br>`src/gateway/jev.ts` | **方案定稿**<br>(沙盒实测验证通过) | 编写 TDD 契约测试，实现 JEV 客户端与门控装配 |
| **P3** | **Agent 自修改演进机制**（群专属人设/行为准则自我演进） | `src/gateway/session/`<br>`src/tools/` | **架构调研草案**<br>(待方案细化) | 细化自修改工具协议与权限栅栏设计，编写契约测试 |
| **P4** | **好友与群管理工具及专用管理 Session** | `src/gateway/`<br>`src/tools/` | **需求收敛**<br>(待实测与实现) | 验证管理 API 可达性，实现管理工具及独立 Session 隔离 |
| **P5** | **All-in-One 单 Agent 统筹重构**（`send_qq_message` 回归 · 出站与终结解耦 · 淘汰独立后台 Agent） | `src/gateway/`<br>`src/tools/`<br>`src/outbound/` | **架构远景规划**<br>(待排期实施) | 引入 `send_qq_message` 解耦出站与回合，实现发完消息顺手整理表情包与记忆，下线独立后台 Agent |

---

## 活跃任务跟踪清单

### 【P2】JEV 决策模型前置群聊感知与主动唤醒

- **相关文档**:
  - 规格需求: [`devlog/需求文档-JEV决策模型前置群聊感知与主动唤醒.md`](./devlog/需求文档-JEV决策模型前置群聊感知与主动唤醒.md) (v0.3)
  - 归档实测日志: [`devlog/archive/JEV模型探查与实测_261022/JEV模型本地实测与题目有效性探查.md`](./devlog/archive/JEV模型探查与实测_261022/JEV模型本地实测与题目有效性探查.md)
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
  - 架构方案: [`devlog/方案设计-Agent自修改演进机制.md`](./devlog/方案设计-Agent自修改演进机制.md)
- **核心定位**:
  - 在 QQ 会话专属预设系统的安全底座上，为 Agent 提供自主演变性格与群规准则的能力（"Soft Soul" 演进）；
  - 提供显式自我修订工具（`update_agent_soul`），支持在对话中根据用户反馈或群氛围持久化更新人设规则；
  - 严格保持人设软演进与系统权限硬策略的解耦，工具权限开关需配合管理员白名单鉴权，杜绝越狱风险。
- **执行清单 (Next Steps)**:
  - [ ] 细化自演进工具接口契约与鉴权安全边界（人设自修改开放 vs 工具开关鉴权）
  - [ ] 设计按 peer 持久化存储与热加载机制（`.dsh/napcat/soul/<peer>.md`）
  - [ ] 注册自演进工具并接入 `agent-runner`
  - [ ] 编写自修改演进行为与越权防御契约测试

---

### 【P4】好友与群管理工具及专用管理 Session

- **相关文档**:
  - 规格需求: [`devlog/需求文档-好友与群管理工具及专用Session.md`](./devlog/需求文档-好友与群管理工具及专用Session.md)
  - 任务清单: [`devlog/Checklist-好友与群管理工具及专用Session.md`](./devlog/Checklist-好友与群管理工具及专用Session.md)
- **核心定位**:
  - 为机器人管理员提供运维管理工具：好友申请审批、加群审核、群成员禁言与踢人；
  - 设计独立的专用管理 Session，将管理动作上下文与日常群聊/私聊闲聊彻底物理隔离；
  - 严格仅对管理员白名单授权调用，配备双向确认机制。
- **执行清单 (Next Steps)**:
  - [ ] 验证 NapCat OneBot 11 对应管理 Action 接口连通性（`set_group_kick`, `set_group_ban`, `set_friend_add_request`, `set_group_add_request`）
  - [ ] 设计并实现专用管理 Session 路由与生命周期管理
  - [ ] 注册管理类工具集并实施管理员白名单鉴权
  - [ ] 编写管理工具契约测试与装配验证

---

### 【P5】All-in-One 单 Agent 统筹重构（出站解耦 · 发完顺手维护 · 后台 Agent 下线）

- **相关文档**:
  - 架构方案: [`devlog/架构演进-AllInOne单Agent统筹重构.md`](./devlog/架构演进-AllInOne单Agent统筹重构.md)
- **核心定位**:
  - 彻底去除零散的 Background Agent（下线独立 Curator、独立 Background Reviewer 会话与倒计时调度）；
  - 重新引入 `send_qq_message` 工具，实现出站文本发送与回合终结彻底解耦；
  - 打通“即时出站回复 -> 顺手在后台维护表情包（`collect_face` / `manage_faces`）与记忆（`create_memory` / `edit_memory`） -> 平稳收敛终结”的单 Agent 统一治理链路。
- **执行清单 (Next Steps)**:
  - [ ] 重新接入 `send_qq_message`，验证非终结出站机制
  - [ ] 改造会话执行流，编写单 Agent 顺手完成表情与记忆维护的契约测试
  - [ ] 下线独立后台 Agent 及配套调度代码，完成技术债清退
