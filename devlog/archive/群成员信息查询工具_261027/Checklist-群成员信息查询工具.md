# Checklist：群成员信息查询工具实施清单

## 阶段一：契约测试与定义先行 (TDD)
- [x] 1.1 编写 `tests/contract/group-member-info.test.ts` 契约测试用例
  - [x] 1.1.1 Gateway 动作测试：`getGroupMemberList` 正确发送 `get_group_member_list` 动作及参数
  - [x] 1.1.2 精确查询测试：按 `user_id` 命中并准确返回身份与头衔
  - [x] 1.1.3 模糊搜索测试：按 `query` 模糊匹配群名片与个人昵称
  - [x] 1.1.4 角色筛选测试：按 `role: 'owner' | 'admin'` 筛选特定特权成员
  - [x] 1.1.5 会话门控测试：非群聊环境（私聊）调用被防御性拦截
  - [x] 1.1.6 缓存穿透测试：验证 5 分钟 TTL 缓存及 `no_cache: true` 强制刷新行为
  - [x] 1.1.7 装配闭环测试：`bootDshNapcatBridge` 真实挂载后 tools 注册表包含 `get_group_member_info`

## 阶段二：网关接口与类型契约落地
- [x] 2.1 在 `src/types/index.ts` 补充群成员查询相关接口与参数类型
- [x] 2.2 在 `src/gateway/server.ts` 扩展 `getGroupMemberList` 方法，对接 OneBot 11

## 阶段三：核心查询逻辑与工具模块实现
- [x] 3.1 创建 `src/tools/member-info.ts`，实现查询过滤、数据格式化及 TTL 缓存池
- [x] 3.2 封装 `createGetGroupMemberInfoTool` 导出 `defineTool` 定义
- [x] 3.3 在 `src/tools/index.ts` 中注册 `get_group_member_info` 并挂载全局上下文

## 阶段四：验证与交付
- [x] 4.1 运行契约测试 `tests/contract/group-member-info.test.ts`，验证全部测试转绿 (8/8 通过)
- [x] 4.2 运行全量 `pnpm typecheck` (tsc --noEmit 0 错误)
- [x] 4.3 运行 `pnpm build` 并核对 `dist/` 构建物包含 `get_group_member_info`
- [x] 4.4 提交原子化 Git commit 并向用户汇报
