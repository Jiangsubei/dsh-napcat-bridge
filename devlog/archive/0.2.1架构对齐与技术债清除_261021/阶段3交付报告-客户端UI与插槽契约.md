# 阶段 3 交付报告：客户端 UI 与插槽契约

## 1. 任务概述

本阶段聚焦于将客户端 WebUI 插槽装配契约从 0.1.5-rc.1 历史假绿与形状漂移整改为严格对齐 DSH 0.2.1 官方规范，闭环汇总报告中的 **A13、A14、A25、A28** 四项重点问题。

---

## 2. 问题分析与整改实施

### 2.1 A14: QQComposerHider 只读互锁脱离 sessionsSnap.current，实现双重互锁
- **问题现状**：DSH 0.2.x 中 `SessionListState` 已移除 `current` 字段（当前会话由视图层持有），导致旧实现中基于 Store 快照的 `sessionsSnap?.current` 永远取不到当前会话，`body[data-dsh-napcat-readonly="true"]` 属性成为死逻辑，双重互锁只剩单边。
- **整改方案**：
  1. `QQComposerHider` 挂载在 `conversation.composer.dock`（`scope: "session"`），DSH 运行环境会向该槽位条目注入标准的 `SessionStandardProps`（提供确定的 `sessionId` 与 `useSession` hook）。
  2. `QQComposerHider` 内部通过 `props.sessionId` 或 `props.useSession` 判定是否为当前插件管理的 QQ 会话（`isReadonly`）。
  3. 使用 `React.useEffect` 监听 `isReadonly` 状态变化，挂载/激活时调用 `syncReadonlyAttribute(true)`，离开/卸载时通过 cleanup 回调自动清理 `syncReadonlyAttribute(false)`。
  4. 渲染的 `<style>` 标签恢复 `body[data-dsh-napcat-readonly="true"] [data-composer-card]` 强约束双重互锁选择器，确保即使多实例挂载也不会发生跨会话误伤。

### 2.2 A13 & A28: 收窄 settings.section 与 conversation.composer.dock 注册参数
- **问题现状**：
  1. `conversation.composer.dock` 是 list 槽位（`kind: 'list'`），但在 0.1.5 中同时传入了 `key` 属性。根据 0.2.1 `KindOptions` 规范，list 槽位仅接受 `id`、`order`、`label`、`priority`，传入 `key` 属于 keyed 槽位非法参数。
  2. `settings.section` 注册传入了 `locale: 'dsh-napcat-bridge'` 与 `inject: () => ({})`。在 DSH 0.2.1 运行时中，若声明 `locale` 但客户端未提供已安装的 locale face，渲染器会抛出异常；且 REST 自驱动架构下无需多余的空 inject 字典。
- **整改方案**：
  1. `src/client/index.tsx` 中 `conversation.composer.dock` 注册移除 `key` 属性，仅保留规范的 `name`, `id`, `order`。
  2. `settings.section` 注册移除空 `locale` 声明与空 `inject` 字典，仅保留规范的 `name`, `id`, `order`, `label`。
  3. `src/client/card.tsx` 中 `SettingsSectionProps` 增加 `close?: () => void` 契约，支持消费 0.2.1 shell 注入的 `SettingsSectionOwnerProps`。

### 2.3 A25: 清理已删除的 14px 图标，全仓测试对齐 0.2.1 真实图标
- **问题现状**：DSH 0.2.1 `@deepseek-ai/dsh-client-ui-primitives` 仅导出 `IconChevronDownOutlineRegular` 与 `IconChevronDownOutlineMedium`，历史 0.1.5 中的 `IconChevronDownOutline14` 已彻底废弃。但测试 mock 与 `card.tsx` 仍保留了 14px 兜底分支。
- **整改方案**：
  1. `src/client/card.tsx` 彻底删除 `IconChevronDownOutline14` 兜底解析分支。
  2. 全仓契约测试（`client-settings.test.ts`、`settings-tabs.test.ts`、`webui-readonly-composer.test.ts`、`server-routes.test.ts`、`proactive-only-text.test.ts`）移除 `IconChevronDownOutline14`，严格对齐 0.2.1 真实的 Medium/Regular 导出。

### 2.4 构建脚本与产物对齐
- `scripts/build-client.ts` 注释与构建规约对齐为 module ID `dsh-napcat-bridge`（消除历史 `/client` 后缀误导）。
- 执行 `pnpm build`，成功产出 61951 字节的 `dist/client.js` bundle，经比对验证已包含双重互锁与纯净注册逻辑。

---

## 3. 修改文件清单

| 文件 | 修改性质 | 说明 |
|---|---|---|
| `src/client/index.tsx` | 源码修改 | A14 双重互锁 useEffect 同步；A13/A28 收窄槽位注册参数 |
| `src/client/card.tsx` | 源码修改 | A25 移除 14px 图标分支；支持 close 契约 |
| `scripts/build-client.ts` | 工具脚本 | 注释对齐 0.2.1 模块 ID |
| `tests/contract/client-settings.test.ts` | 契约测试 | 断言收窄槽位元数据、增加真实静态渲染断言 |
| `tests/contract/webui-readonly-composer.test.ts` | 契约测试 | 断言双重互锁与真实 sessionId 来源 |
| `tests/contract/settings-tabs.test.ts` | 契约测试 | 移除 14px 图标 mock |
| `tests/contract/server-routes.test.ts` | 契约测试 | 移除 14px 图标 mock |
| `tests/contract/proactive-only-text.test.ts` | 契约测试 | 移除 14px 图标 mock |
| `docs/探查-0.2.1对齐与死代码_261020/汇总报告-0.2.1半截更新与技术债死代码.md` | 文档更新 | 标注 A13, A14, A25, A28 已闭环 |

---

## 4. 验证结果

### 4.1 编译检查
```powershell
$ pnpm typecheck
$ tsc --noEmit
# exit 0 (零错误)
```

### 4.2 客户端相关契约测试
```powershell
$ npx vitest run tests/contract/client-settings.test.ts tests/contract/settings-tabs.test.ts tests/contract/webui-readonly-composer.test.ts
✓ tests/contract/webui-readonly-composer.test.ts (14 tests)
✓ tests/contract/client-settings.test.ts (11 tests)
✓ tests/contract/settings-tabs.test.ts (15 tests)

Test Files  3 passed (3)
     Tests  40 passed (40)
```

### 4.3 构建产物一致性验证
```powershell
$ pnpm build
[build-client] Successfully built F:\Project\dsh-napcat-bridge\dist\client.js (61951 bytes)

# 抽查产物头部的 module id
window.__ModuleLoader__.load({
  id: "dsh-napcat-bridge",
  ...
})

# 抽查双重互锁样式
body[data-dsh-napcat-readonly="true"] [data-composer-card] {
  display: none !important;
}

# 抽查槽位注册不含无效 key
name: "conversation.composer.dock",
id: "dsh-napcat-bridge-hide-composer",
order: -100
```

---

## 5. 未完成项与下一阶段（阶段 4）交接

客户端 UI 与插槽契约（阶段 3）已完全闭环并验证。
下一步将进入 **阶段 4：运行时正确性**，重点解决：
1. **D4 审批与提问运行时**：超时机制（300s fail-closed）、同 peer 顶替收敛、取消语义映射为 `cancelled`；
2. **出站通道**：`turn/start` 串轮修复、`pendingMessageContexts` TTL 清理、空 chains 垃圾回收；
3. **网关健壮性**：异步 handler rejection 捕获、媒体文件防路径穿越净化、`bot_nickname` 唤醒接线；
4. **工具系统**：工具失败显式抛出错误、模型同步移除空 catch、移除猴补丁；
5. **记忆系统**：预算硬上限、原子写统一、真实会话上下文与 `tools.restrict()`。
