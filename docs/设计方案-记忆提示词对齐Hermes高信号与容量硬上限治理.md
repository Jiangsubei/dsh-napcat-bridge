# 设计方案：记忆提取提示词对齐 Hermes 高信号原则与容量硬上限治理

**日期**: 2026-09-10  
**状态**: 实施中  
**前置背景**: 本地实际记忆文件严重膨胀（`user/2415112980.md` 达 5.4KB，`session/group_646988881.md` 达 3.2KB，单条记录含 600 字技术排查流水账），且 Background Review 提取提示词混入了 Hermes Skill 的催促语，缺乏高信号与容量硬约束。

---

## 一、核心问题诊断

1. **退出语义被 Skill 污染**：
   - 包含 `'Nothing to save.' should NOT be the default... produced no new technique... Otherwise, act.`；
   - 产生“每次 review 不记就是失职”的负向激励，导致即便日常闲聊也硬凑内容记录。
2. **缺乏单条简短与高信号原则**：
   - 缺失 Hermes `MEMORY_SCHEMA` 核心铁律（`keep entries compact and high-signal`）；
   - Agent 自由发挥写叙事流水账、会话排查复盘。
3. **缺少针对 QQ 场景的 SKIP 过滤清单**：
   - 缺失对单次技术测试、临时跑分、水群闲聊、路过打招呼等瞬时噪音的过滤指引。
4. **主 Agent 工具描述缺乏行动指导**：
   - 主 Agent 在前台 live turn 中同样挂载记忆工具，缺乏 WHEN / SKIP 与单条简短指导，也会主动向记忆库写入冗余长文。
5. **机制层 0 写入容量门禁**：
   - 工具层无字数上限拦截，文件无限膨胀，仅在读取端截断，导致多用户画像被静默丢弃。
6. **允许长期稳定群梗与文化**：
   - 明确长期稳定出现的群梗、代号、固定剧本可记录（避免死板），但严格单行精简记录。

---

## 二、整改目标与方案

### 1. 常量定义 (`src/constants/index.ts`)
- `DEFAULT_USER_PROFILE_CHAR_LIMIT = 1500`（单用户画像硬上限）
- `DEFAULT_SESSION_MEMORY_CHAR_LIMIT = 2200`（单会话/群聊记忆硬上限）

### 2. 写入硬道闸 (`src/memory/tools.ts`)
- `create_memory` 与 `edit_memory` 在最终文本写入前计算长度；
- 超出上限直接拒绝写入并返回 `success: false` 与精简提示，逼迫 Agent 使用 `edit_memory` 删减合并。

### 3. 主 Agent 工具描述优化 (`src/memory/tools.ts`)
- `create_memory`：明确 WHEN / SKIP / FORMAT（单行原子事实 <80 字，用户 <=1500，会话 <=2200），注明严禁流水账；
- `edit_memory`：明确合并压缩（Consolidation）优先，定向修改删减；
- `read_memory`：明确用于编辑前的最新内容比对与定位。

### 4. Background Review 提示词重构 (`src/memory/review.ts`)
- 剔除 Skill 催促语，回归 `Nothing to save.` 为标准常态退出；
- 强调单行原子事实（30~80 字），禁止长篇叙事；
- 明确长期稳定群梗/固定剧本允许记录（脱敏抽象示例）；
- 增加 QQ 场景专属 SKIP 负面清单；
- 强调 Consolidation 合并压缩优先。

### 5. 真实记忆文件脱水
- 提交代码并 build 验收后，将本地膨胀的 `user/` 和 `session/` 记忆文件进行精炼脱水。
