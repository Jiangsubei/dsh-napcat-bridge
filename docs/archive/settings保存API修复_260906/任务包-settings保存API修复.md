# 任务包：修复设置卡片保存 — 跟随 DSH 新版 settings API

> **项目**: dsh-napcat-bridge  
> **日期**: 2026-09-06  
> **优先级**: P1（设置无法保存，阻塞）  
> **现象**: WebUI 设置卡片保存报错 `settings API 不可用`。DSH 更新后客户端 settings 保存 API 变更，插件仍在用旧 API。

---

## 1. 根因（已到 dsh 运行时源码确证）

**报错点**：`src/client/index.tsx:41`
```ts
if (!api?.settings?.update) throw new Error('settings API 不可用');
```

**旧 API（插件当前在用，已失效）**：
```ts
await api.settings.update({ ns, patch: values, expectedRevision });  // 选项对象
```

**新 API（DSH 官方 WebUI 卡片保存的确切调用）** —— 参考源码：
- `dsh-client-ui-settings/lib/client.js:1016-1090` 的 `SettingsScope` 服务
- `dsh-client-ui-settings/lib/client.js:1045`：`ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision)`
- `dsh-client-ui-settings/lib/client.js:1143`：`settingsScope` 服务定义，经 `ctx.settingsScope.bind({ namespace: X })` 得到按命名空间绑定的 scope

**新机制（三个变化）**：
1. **调用方不同**：保存走 `ctx.settingsScope.bind({ namespace })` 返回的 scope 的 `mutate(ops, expectedRevision)`（或 `.set(field, value)` / `.unset(field)`），底层是 `ctx.remote.settings.mutate(ns, ops, revision)`。`connection.api.settings.update`（选项对象扁平补丁）已不存在/不再适用 → 守卫处 `api.settings.update` 为 falsy → 报「settings API 不可用」
2. **位置参数**：`mutate(namespace, ops, expectedRevision)` 三个位置参数（不是 `{ns, patch, expectedRevision}` 对象）
3. **op 数组**：参数二是操作数组，不是裸 patch 记录：
   ```ts
   ops = [
     { op: 'set',   path: ['<字段名>'], value },
     // 或 { op: 'unset', path: ['<字段名>'] }
   ]
   ```

**返回**：`{ ok, value: { revision } }`（`ok=false` 表示失败/版本冲突，需触发重读 recovery，或按现有逻辑重试）。

> 注意：**插件已注入 `settingsScope`**（`index.tsx:9` `inject = ['slots','connection','settingsScope']`），读取用 `ctx.settingsScope.describe()`（拿 snapshot 的 view.namespaces 找当前 ns 的 value/revision/base）。保存却走了旧的 `connection.api.settings.update` —— 这就是断层。

## 2. 修复设计（定稿）

把 `src/client/index.tsx` 的 `buildSettingsBridge.onSaveSettings` 改走官方 `settingsScope`：

```ts
onSaveSettings: async (values, { expectedRevision }) => {
  // 绑定到本插件的命名空间 scope（官方同款机制）
  const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
  if (!scope?.mutate) throw new Error('settings API 不可用');

  // 把表单值转成 settings mutate 操作数组（op: set）
  const ops = Object.entries(values ?? {}).map(([field, value]) => ({
    op: 'set',
    path: [field],
    value,
  }));

  const res = await scope.mutate(ops, expectedRevision);
  // 处理 res 失败 / 版本冲突（参考现有 52-68 行的重读重试逻辑，适配新返回形态）
  ...
  return { revision: res?.value?.revision };
}
```

**要点（实现时核实）**：
- `ctx.settingsScope.bind({ namespace })` 的确切形态：绑定后返回的 scope 是否自带 `.mutate(ops, revision)` 且命名空间已固定（参考官方 `ctx.settingsScope.bind({ namespace: CHAT_SETTINGS_NAMESPACE })` 用法，line 8069 / 15977）
- op 构建：`values` 是全量表单值，逐字段转 `{op:'set', path:[field], value}`；若某字段需清空，官方有 `unset` op（现插件无清空语义，可只用 set）
- 版本冲突重试：现 52-68 行逻辑以 `res?.result?.ok` / 错误文案判断，新 API 以 `res?.ok` 与恢复重读为准（对比 `dsh-client-ui-settings` 的 `recover()`，line 1052-1067）；**能适配就适配，不能完全照搬就退化为"失败时重读预期 revision 再 mutate 一次"**
- `readNamespace` / `initialConfig` / `revision` 读取路径（走 `settingsScope.describe()`）**保持不变**，除非验证也断
- `SETTINGS_NAMESPACE` 常量（`src/constants` 里已有，核对名字）

## 3. 任务拆解（原子提交）

1. **onSaveSettings 重写**：改走 `ctx.settingsScope.bind({namespace}).mutate(ops, revision)`；构建 ops；适配返回与冲突重试
2. **读路径核对**：`settingsScope.describe()` 读取 / revision / base 若也有变动则一并修（以真机为准）
3. **契约/单元测试**：
   - `onSaveSettings` 正确构建 op 数组（字段→`{op:'set',path:[field],value}`）
   - 调用 `settingsScope.bind({namespace}).mutate(ops, expectedRevision)`（mock scope）
   - 返回 revision；冲突时重试一次
   - 守卫：scope.mutate 缺失时报「settings API 不可用」
4. **真机验证**（必做，AGENTS.md 红线——UI 无法单测封死）：依赖 `hermes-escalate` / Edge CDP / 浏览器驱动，在真实 DSH WebUI 打开 NapCat 设置卡片，改一个开关保存，确认不再报错且配置落盘生效（`~/.dsh/` 侧 settings 文件或下次启动读到）

> ⚠️ 此任务是纯前端 WebUI 客户端改动，单测只能验证 op 构建 + mock mutate 调用；**必须真机浏览器验证保存闭环**，不能用单测全绿代替。

## 4. 验收标准

| # | 验收项 | 验证 |
|---|---|---|
| A1 | 保存不再抛「settings API 不可用」 | 真机 WebUI |
| A2 | 改动配置保存后落盘生效（重启/重读读到） | 真机 |
| A3 | onSaveSettings 构建正确 op 数组并调 `scope.mutate(ops, revision)` | 单测 |
| A4 | 返回新 revision；版本冲突重试一次 | 单测 |
| A5 | 读路径（initialConfig/revision/base）无回归 | 真机 + 单测 |
| A6 | 现有全部测试通过 + build 通过 + dist 含改动 | `pnpm test` + `pnpm build` |
| A7 | 未引入新 npm 依赖 | 检查 |

## 5. 关键文件

| 文件 | 改动 |
|---|---|
| `src/client/index.tsx` | `buildSettingsBridge.onSaveSettings` 重写 → settingsScope.mutate；冲突重试适配；读路径核对 |
| `src/client/card.tsx` | （仅在读取/传参需配套时） |
| `tests/contract/*`（或新增 settings-save 测试文件） | op 构建 / mutate 调用 / revision / 冲突重试 / 守卫 |