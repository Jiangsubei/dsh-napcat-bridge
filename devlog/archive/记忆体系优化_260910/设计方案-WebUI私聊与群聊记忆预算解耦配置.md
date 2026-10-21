# 设计方案：Web UI 私聊与群聊记忆预算解耦配置

**日期**: 2026-09-10  
**状态**: 实施中  
**目标**: 将原本单一的 `memory_budget_chars` 解耦为按场景区分的两个 Web UI 可配置项：
1. `group_memory_budget_chars` (默认 2200): 群聊会话规则与多活跃用户画像总注入预算，兼单群规则写入上限；
2. `private_memory_budget_chars` (默认 1500): 私聊会话规则与单用户画像总注入预算，兼单用户画像写入上限。

---

## 一、涉及模块与职责

1. **配置与类型**:
   - `src/constants/index.ts`: 声明 `DEFAULT_GROUP_MEMORY_BUDGET_CHARS = 2200`, `DEFAULT_PRIVATE_MEMORY_BUDGET_CHARS = 1500`；保留 `DEFAULT_MEMORY_BUDGET_CHARS = 2200` 用于向后兼容。
   - `src/types/index.ts`: `BridgePluginConfig` 扩展 `group_memory_budget_chars?: number; private_memory_budget_chars?: number;`。
   - `src/config/schema.ts`: `BridgeConfigSchema` 注册两个配置项，设置默认值与描述，并对旧 `memory_budget_chars` 进行平滑回退支持。
2. **Web UI 设置卡**:
   - `src/client/card.tsx`: 在 `memory` Tab 渲染两个独立的 `ValueField`（群聊预算上限 & 私聊预算上限）。
   - `src/client/model.ts`: `CONFIG_KEYS` 和 `DEFAULT_BASE_CONFIG` 加入新字段，支持脏检查与重置。
3. **注入与道闸层**:
   - `src/memory/storage.ts`: `getPromptSnapshotSync(peer, activeUsers, maxBudget)`:
     - 私聊支持传入 `maxBudget`（即 `private_memory_budget_chars`），单用户画像超出时做安全截断；
     - 群聊使用 `group_memory_budget_chars` 限制总长度。
   - `src/memory/tools.ts`: `MemoryTools` 接收动态获取限额的函数或 options `limits: { user?: () => number; session?: () => number }`，若未传则回退默认常量。
   - `src/memory/index.ts`: `registerMemoryPromptContext` 与 `setupMemoryService` 传入动态 getter。
   - `src/index.ts`: 组装 `setupMemoryService` 时连接 `currentConfig().group_memory_budget_chars` 与 `currentConfig().private_memory_budget_chars`。

---

## 二、验收标准

1. `tests/contract/settings-tabs.test.ts` 契约覆盖：Web UI 设置卡片包含这两个字段的输入、变更与重置；
2. `tests/contract/memory-storage.test.ts` & `memory-assembly.test.ts` 契约覆盖：私聊与群聊分别使用各自的动态预算；
3. `tests/contract/memory-tools.test.ts` 契约覆盖：动态调整上限后，写入道闸按新限额执行拦截；
4. `pnpm typecheck` & `pnpm test` 100% 通过；
5. `pnpm build` 成功并核查 `dist/`。
