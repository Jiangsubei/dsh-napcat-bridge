# 修复报告：Coding 工具组裁剪误伤 read_image 与 working_directory 修复

> **文档定位**：问题排查与修复交付报告  
> **创建日期**：2026-11-01  
> **关联提交**：`d366e7e`, `b370977`  

---

## 1. 问题背景与根因

在提交 `d366e7e` 实现发言黑名单与 Coding 工具组裁剪控制时，`src/gateway/session/agent-runner.ts` 中的 `applyCodingToolsRestriction` 将 `read_image` 与 `working_directory` 列入了 `potential` 数组：

```typescript
const potential = ['bash', 'pwsh', 'read', 'write', 'edit', 'read_image', 'working_directory'];
```

由于群聊新建会话默认关闭 Coding 工具组（`coding_tools_group_default: false`），导致默认情况下：
1. **识图能力误杀**：群聊内用户发送的图片或表情包虽正常落盘，但模型被剥夺了 `read_image` 工具，无法读取本地图片内容，造成群聊看图功能失效；
2. **只读工具混入隔离清单**：`read_image` 仅为本地图像视觉转换工具，`working_directory` 仅为只读工作区路径查询工具，均不属于高危代码编写或终端执行工具，不应被 Coding 工具组硬隔离。

---

## 2. 修复范围与改动细节

1. **运行时收敛 (`src/gateway/session/agent-runner.ts`)**：
   - 将 `potential` 工具清单严格收敛为 5 个高危工程编码工具：`['bash', 'pwsh', 'read', 'write', 'edit']`；
   - `read_image` 与 `working_directory` 不再进入 `deny` 列表。
2. **契约测试修正与补全 (`tests/contract/security-session-permission.test.ts`)**：
   - 将 `CODING_TOOLS` 测试列表同步调整为 5 个工具；
   - 补充正向断言：明确验证在关闭 Coding 工具组的群聊会话中，`read_image` 与 `working_directory` 依然完好保留供模型使用。
3. **前端卡片提示与用户文档更新 (`src/client/card.tsx`, `docs/configuration.md`, `README.md`)**：
   - 更新 WebUI 设置卡片中的描述文字，明确说明隔离的 5 个工程工具，并标明只读视觉工具 `read_image` 与目录感知 `working_directory` 始终可用。

---

## 3. 验证结论

- **单测与契约测试**：`tests/contract/security-session-permission.test.ts` 7/7 契约测试全部通过；
- **全量测试套件**：80 个测试文件、647 个测试用例全部 100% 绿色通过；
- **构建验证**：`pnpm build` 与 `pnpm typecheck` 零告警顺利通过，编译产物 `dist/` 与 `dist/client.js` 同步更新。
