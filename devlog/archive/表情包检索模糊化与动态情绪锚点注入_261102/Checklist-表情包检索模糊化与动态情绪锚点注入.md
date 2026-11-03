# Checklist：表情包检索模糊化与动态情绪锚点注入

**版本**: v1.0.0  
**日期**: 2026-11-02  
**状态**: 全部完成且验证通过 (Completed & Verified)

---

## 阶段一：契约测试编写 (TDD 先行)
- [x] 1.1 编写 `tests/contract/face-search-fuzzy.test.ts`：
  - [x] 1.1.1 验证 `mood LIKE` 包含匹配（"调侃" 匹配 "调侃/幽默"）；
  - [x] 1.1.2 验证 `tag LIKE` 子串匹配（"猫" 匹配 "可爱猫猫"，不带引号闭合限制）；
  - [x] 1.1.3 验证 `query` 综合关键词跨 `tags` 与 `mood` 的模糊检索；
  - [x] 1.1.4 验证 `getFaceMoodSummary()` 聚合统计正确性（降序排序、上限切片、过滤停用与软删除）；
- [x] 1.2 编写 `tests/contract/face-dynamic-prompt.test.ts`：
  - [x] 1.2.1 验证 QQ 会话开启 `face_enabled: true` 时，注入包含总数与 Top 情绪的锚点摘要；
  - [x] 1.2.2 验证库为空时，注入引导收录文案；
  - [x] 1.2.3 验证 `face_enabled: false` 或非 QQ 会话时静默，输出为空；
- [x] 1.3 扩展 `tests/contract/face-tools.test.ts`：
  - [x] 1.3.1 验证 `list_faces` 工具接入 `query` 参数后的 Lossless JSON 契约。

---

## 阶段二：存储层与类型定义实现
- [x] 2.1 修改 `src/types/index.ts`：
  - [x] 2.1.1 在 `FaceQueryOptions` 中扩展 `query?: string`；
  - [x] 2.1.2 在 `ListFacesParams` 中扩展 `query?: string`；
  - [x] 2.1.3 定义 `FaceMoodSummary` 结构体；
- [x] 2.2 修改 `src/storage/database.ts`：
  - [x] 2.2.1 实现 `getFaceMoodSummary(limitMoods?: number)`；
  - [x] 2.2.2 重构 `queryFaces` 中的 `mood` 匹配为模糊 LIKE；
  - [x] 2.2.3 重构 `queryFaces` 中的 `tag` 匹配为模糊 LIKE（移除外层双引号限制）；
  - [x] 2.2.4 支持 `query` 跨字段模糊匹配。

---

## 阶段三：动态 System Prompt 情绪锚点注入
- [x] 3.1 在 `src/prompt/dynamic.ts` 中实现 `registerFacePromptContext`：
  - [x] 3.1.1 注册 `napcat:face_summary` 动态段（order: 48）；
  - [x] 3.1.2 挂接 QQ 会话校验与 `face_enabled` 配置开关校验；
  - [x] 3.1.3 按照预算约束拼接极简摘要文本；
- [x] 3.2 在 `src/index.ts` 插件入口接入装配：
  - [x] 3.2.1 调用 `registerFacePromptContext`，注入 DB 与配置；
  - [x] 3.2.2 妥善保存 disposer并在插件卸载时释放。

---

## 阶段四：工具定义与装配升级
- [x] 4.1 在 `src/tools/index.ts` 中升级 `list_faces` 工具定义：
  - [x] 4.1.1 在参数列表中登记 `query` 参数及使用说明；
  - [x] 4.1.2 更新 `mood` 和 `tag` 的参数描述说明（告知模型已支持模糊匹配）；
  - [x] 4.1.3 将 `query` 参数传递至底层 `listFaces` 执行函数。

---

## 阶段五：全量验证与构建交付
- [x] 5.1 运行全量契约与单测：`pnpm test` (全量 678 tests 100% 通过)；
- [x] 5.2 运行类型检查：`pnpm typecheck` (0 错误)；
- [x] 5.3 运行全量构建：`pnpm build`（确认 `dist/` 编译产物同步更新且包含新逻辑）；
- [x] 5.4 提交前检查与原子提交：
  - 确认工作区无无关修改；
  - 按照规范书写 Git Commit 信息。
