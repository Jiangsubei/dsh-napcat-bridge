# QQ 斜杠命令 /model 切换失效原因排查与 NapCat 全局/会话双模设计方案 (v2)

## 1. 问题现场与现象核查

### 1.1 问题现象
- **操作**：管理员在 QQ 私聊/群聊中发送 `/model qwen3.8-flash`。
- **插件反馈**：提示 `✅ 当前会话模型已切换为: aliyun-token-plan / qwen3.8-flash`。
- **实际表现**：
  1. 打开 DeepSeek Harness Web UI 查看当前会话，模型依然是之前的 `OpenCode Go MIMO2.5`（`opencode-go / mimo-v2.5`），没有变成 `3.8 Flash`。
  2. 随后在 QQ 发送消息（如 `喵喵喵`）唤醒对话，通过解压审查 `~/.dsh/sessions/--home-nyara-.dsh-workspace-napcat--/qq-user-2000000001-2/session.jsonl.zstd` 最新事件流证实：
     ```json
     {"type":"request/header","seq":5149,"time":1788408689290,"data":{"header":{"config":{"provider":"opencode-go","model":"mimo-v2.5","maxTokens":128000}}}}
     ```
     实际请求发往 LLM 的 provider 与 model 依然是 `opencode-go / mimo-v2.5`！
  3. 向本地运行中的 Web UI 端口发起 RPC 测试：
     ```bash
     curl -s -X POST http://127.0.0.1:3080/api/session.models \
       -H "Content-Type: application/json" \
       -d '{"type":"client-request","rpcId":"1","method":"session.models","payload":{"sessionId":"qq-user-2000000001-2"}}'
     ```
     返回：
     ```json
     {"result":{"ok":true,"value":{"current":{"provider":"opencode-go","model":"mimo-v2.5"}}}}
     ```
- **结论**：**斜杠命令不仅在 Web UI 显示上失效，在 QQ 真实的 LLM 请求运行路径上也完全没有生效。**

---

## 2. 根本原因剖析 (Root Cause Analysis)

经过对运行中进程、DSH 源码（`@deepseek-ai/dsh-agent`、`@deepseek-ai/dsh-host-apiproxy`、`@deepseek-ai/dsh-agent-default-model`）以及桥接层实现的比对排查，确认存在以下三大致命缺陷：

### 2.1 凭空臆造不存在的属性与无效的对象修改
在 `src/commands/index.ts`（原第 267-276 行）：
```ts
if (agent) {
  if ((agent as any).modelSelection?.current) {
    (agent as any).modelSelection.current.provider = targetProvider;
    (agent as any).modelSelection.current.model = targetModel;
  }
  if ((agent as any).options) {
    (agent as any).options.provider = targetProvider;
    (agent as any).options.model = targetModel;
  }
}
```
- **事实**：查阅 `@deepseek-ai/dsh-agent` 源码，`Agent` 类上**根本没有任何名为 `modelSelection` 的属性**！这一段代码纯属历史虚构，运行时条件判断永远为 `false`，从未执行。
- **事实**：`agent.options` 只是创建 Agent 时传入的静态初始入参，DSH 在运行 step、组装 system prompt 和发起请求时**根本不会读取 `agent.options`**，修改它对运行中的 LLM 调用毫无任何作用。

### 2.2 DSH Web 运行时中 `apiProxy` 的强覆盖机制
DSH 官方在 `dsh-host-apiproxy` 中对所有 session 的模型解析规则如下（`node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js`）：
```js
function selectionFor(agent) {
  const installed = selections.get(agent);
  if (installed !== void 0) return installed;
  let picked;
  const selection = {
    get current() {
      if (picked !== void 0) return picked;
      const logged = agent.session.requestHeader()?.config;
      if (logged === void 0) return defaults.defaultModelSelection();
      return { provider: logged.provider, model: logged.model, ... };
    },
    set current(next) {
      picked = next;
    },
    assembled: void 0
  };
  installModelSelection(agent.ctx, selection);
  selections.set(agent, selection);
  return selection;
}
```
- `selections` 是 `apiProxy` 内部私有的 `WeakMap<Agent, ModelSelectionRef>`。
- 当通过 Web UI 访问该会话时，`selectionFor(agent)` 会在 `agent.ctx` 上安装 waterfall 钩子：
  - `system-prompt/assemble`：快照 `selection.current` 并填入 prompt 变量。
  - `agent/request`：在所有内层解析完毕后，**强制用外层的 `selection.assembled` 覆盖 `provider` 和 `model`**！
- 因为我们在 QQ 执行 `/model` 时，只修改了桥接层自己独立的 `sessionManager.selectionMap`，**`apiProxy` 闭包内的 `selections.get(agent)` 完全没有被触及**。
- 于是 `apiProxy` 依然认为 `picked === undefined`，回退读取日志历史记录或全局默认设置 `opencode-go / mimo-v2.5`，并在每次发请求时无情覆盖，导致无论 QQ 还是 Web UI 看到的都是旧模型。

### 2.3 历史单测的“造桩自测自嗨”漏洞
查阅 `tests/contract/commands-permission.test.ts` 原测试用例：
```ts
it('B1-契约 3: /model 为 Per-Session 语义，仅落位当前会话且不写全局默认', async () => {
  ...
  const selA = sessionManager.getModelSelection(sessionA.id);
  expect(selA?.model).toBe('deepseek-v4-pro');
});
```
- 该测试仅在 `sessionManager` 内部读取自己 map 中的变量，没有在真实的 `bootDshNapcatBridge` 装配链路、没有在 `apiProxy`、更没有在真实的 `agent/request` 派发链路上断言。
- 这正是 `AGENTS.md §3.1` 严厉禁止的“零件自造 mock 桩断言全绿，生产装配断链不可用”。

---

## 3. NapCat 插件全局 vs 当前 QQ 会话模型双模设计方案

根据用户的明确指示：
> **“这里的全局是我们的 NapCat 插件的全局，也就是说只有 QQ 会话会一起切换，不要误伤 Web UI 的全局设置！我们这里本来就知道我们的 QQ 会话有哪些，这个功能做起来也不难。”**

因此方案核心原则为：
1. **作用域严格限定在 NapCat QQ 会话**：无论是单会话切换还是全局切换，**绝对不修改 DSH 宿主的 `agentDefaultModel`（不污染 `~/.dsh/settings.yaml`）**，保证 Web UI 自己创建的其他非 QQ 会话和全局默认模型完全不受影响；
2. **支持 NapCat 全局默认模型**：通过 NapCat 自有的 SQLite 数据库（`messages.sqlite`）维护插件专属的全局默认模型；
3. **已存在的 QQ 会话批量联动**：使用 `--global` 时，已知的所有 QQ 会话批量同步更新；
4. **Web UI 同步生效且免受污染**：通过安全拦截机制调用 `apiProxy.sessions.selectModel`，使得 Web UI 上查看 QQ 会话时同步显示切换后的模型，同时杜绝全局 settings 误写。

### 3.1 命令语法与语义矩阵

| 命令语法 | 作用范围 | 语义说明 | Web UI 宿主全局 (`settings.yaml`) | Web UI 上的 QQ 会话 |
| :--- | :--- | :--- | :--- | :--- |
| **`/model`** | 查询 | 查询当前会话模型、NapCat QQ 默认模型、可用模型列表及帮助 | 不变 | 保持现状 |
| **`/model <model>`** | **仅当前 QQ 会话** | 只切换当前群聊/私聊的模型绑定，并在数据库中单独标记 | **绝对不变** | **当前 QQ 会话同步更新**为目标模型 |
| **`/model <model> --global`** | **NapCat 插件全局 (所有 QQ 会话)** | 1. 设置 NapCat 插件全局默认模型<br>2. 批量将当前所有已知 QQ 会话同步更新为此模型<br>3. 未来所有新创建的 QQ 会话默认使用此模型 | **绝对不变**（不误伤宿主配置） | **所有 QQ 会话同步更新**为目标模型 |

> 语法容错支持：`--global` 前置或后置、`-g` 简写、以及 `<provider>/<model>`、`<provider> <model>` 语法。

---

### 3.2 核心技术实现机制

#### 1. 数据库存储设计 (`messages.sqlite`)
NapCat 插件已经拥有独立的 SQLite 数据库 `~/.dsh/workspace/napcat/messages.sqlite`。
- **表 1：`session_states` 扩展字段**
  平滑执行迁移（若不存在则添加）：
  `ALTER TABLE session_states ADD COLUMN model_provider TEXT;`
  `ALTER TABLE session_states ADD COLUMN model_name TEXT;`
  - 若为 NULL：表示跟随 NapCat 插件全局默认模型；
  - 若有值：表示该 peer 会话单独指定了专属模型。
- **表 2：新增 `plugin_kv` 元数据表**
  ```sql
  CREATE TABLE IF NOT EXISTS plugin_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ```
  存储 `key = 'napcat_default_model'`，`value = '{"provider":"aliyun-token-plan","model":"qwen3.8-flash"}'`。
  确保即使 DSH 服务重启，NapCat 插件的全局默认模型与各会话模型也 100% 稳固保留，绝不丢失。

#### 2. 避免误伤 Web UI 宿主全局设置的安全隔离机制
在调用 DSH 官方的 `apiProxy.sessions.selectModel` 来更新 Web UI 和运行时 `selectionFor(agent).current` 时，官方源码会自动调用 `defaults.saveDefaultModelSelection?.(selected)`（这会写入 `settings.yaml`）。
**安全隔离解决方案**：
在执行 `apiProxy.sessions.selectModel` 期间：
```ts
const defaultModelSvc = ctx.get('agentDefaultModel');
const originalSave = defaultModelSvc?.saveSelection;
if (defaultModelSvc) {
  // 临时将宿主全局保存拦截为 no-op，确保绝对不误伤 Web UI 全局 settings
  defaultModelSvc.saveSelection = async () => {};
}
try {
  await apiProxy.sessions.selectModel({ rpcId, payload: { sessionId, provider, model } });
} finally {
  // 调用完成后立即恢复原方法
  if (defaultModelSvc && originalSave) {
    defaultModelSvc.saveSelection = originalSave;
  }
}
```
**效果**：
- `apiProxy` 内部将该 Agent 的当前模型更新为目标模型；
- Web UI 打开或刷新该 QQ 会话时，显示为目标模型；
- 紧接着该 QQ 会话发消息唤醒 Agent 时，LLM 请求头配置精准变更为目标模型；
- **DSH 宿主的 `settings.yaml`（`agent-default-model`）毫发无损！**

#### 3. 模式 A：单会话切换 (`/model <model>` 无 `--global`)
1. 解析出目标 `targetProvider` 与 `targetModel`；
2. 数据库落盘：在 `session_states` 中将当前 peer 的 `model_provider` 与 `model_name` 设置为目标模型；
3. 更新 `sessionManager.selectionMap` 中当前 `sessionId` 的选择；
4. 若 `ctx.apiProxy` 存在，通过安全隔离方式调用 `apiProxy.sessions.selectModel` 更新当前 session；
5. 回复管理员：
   ```text
   ✅ 当前 QQ 会话模型已切换为: aliyun-token-plan / qwen3.8-flash
   📌 提示：仅对当前 QQ 会话生效；其他 QQ 会话及 Web UI 宿主设置不受影响。
   ```

#### 4. 模式 B：NapCat 插件全局切换 (`/model <model> --global`)
1. 解析出目标 `targetProvider` 与 `targetModel`；
2. 数据库落盘：在 `plugin_kv` 表中写入 `napcat_default_model`；
3. 批量更新已知 QQ 会话：
   - 从 `session_states` 获取所有已知的 QQ 会话 peer；
   - 将所有 peer 的模型配置更新为目标模型（或重置其跟随新的全局默认）；
   - 对当前已在内存中或 Web UI 中挂载的 QQ Agent，逐一通过安全隔离调用 `selectModel`；
4. 更新 `sessionManager` 内部缓存的默认模型为新模型，使得所有未来新生成的 QQ 会话默认使用此模型；
5. 回复管理员：
   ```text
   ✅ NapCat 插件全局 QQ 会话模型已切换为: aliyun-token-plan / qwen3.8-flash
   🌐 范围：已同步切换所有 QQ 会话；未来新建立的 QQ 会话也将默认使用此模型。
   🛡️ 隔离：未修改 Web UI 宿主全局设置。
   ```

#### 5. 模式 C：查询展示 (`/model` 空参数)
清晰展示三层模型状态：
```text
🤖 当前 QQ 会话模型: aliyun-token-plan / qwen3.8-flash
🐧 QQ 插件全局默认: aliyun-token-plan / qwen3.8-flash
🌐 Web UI 宿主默认: opencode-go / mimo-v2.5 (未改动)

📋 可用模型列表:
【aliyun-token-plan】
• qwen3.8-flash
• qwen3.8-max
...
【opencode-go】
• mimo-v2.5
• minimax-m3
...

💡 切换方法:
• 仅当前 QQ 会话: /model <模型名> (例如: /model qwen3.8-flash)
• 所有 QQ 会话全局: /model <模型名> --global (例如: /model qwen3.8-flash --global)
• 指定供应商: /model <供应商> <模型名> [--global]
```

---

## 4. 落地修改范围清单

1. **`src/database/` (如 `src/database/index.ts`)**：
   - 增加 `plugin_kv` 表的创建与 `getPluginConfig`/`setPluginConfig` 方法；
   - 为 `session_states` 表增补 `model_provider`、`model_name` 字段，并在读写函数中支持保存与读取会话模型。
2. **`src/gateway/session.ts`**：
   - `SessionManager` 初始化时从数据库加载 `napcat_default_model`；
   - `getDefaultModelSelection()` 逻辑重构：优先读取 `napcat_default_model`，若未配置才退回到宿主 `agentDefaultModel`；
   - 新增 `setNapcatDefaultModel()` 方法，支持批量更新已知所有 QQ 会话；
   - 在 `getOrCreateAgent` 创建/恢复 agent 时，按“专属模型 -> 插件全局模型 -> 宿主全局模型”顺序装配。
3. **`src/commands/index.ts`**：
   - 增强参数解析，提取 `--global` / `-g` 与模型主体；
   - 实现安全隔离调用（临时抑制宿主 `saveSelection`）；
   - 分流处理单会话切换与 NapCat 全局批量切换；
   - 优化 `/model` 查询展示文案。
4. **`tests/contract/commands-permission.test.ts`**：
   - 契约测试 1：普通 `/model` 仅切换当前 QQ 会话，断言宿主 `agentDefaultModel` 绝对不变、其他 QQ 会话不变；
   - 契约测试 2：`/model --global` 切换所有 QQ 会话，断言已存在的多会话批量同步变更、新创建 QQ 会话继承新模型，且宿主 `agentDefaultModel` 与 `settings.yaml` 绝对不被修改；
   - 契约测试 3：参数解析鲁棒性（`-g`、`--global` 前置/后置）。

---

## 5. 验收标准

1. `pnpm typecheck`：TypeScript 零报错；
2. `pnpm test`：全部契约测试 100% 通过；
3. `pnpm build`：生成最新 `dist/` 产物；
4. 真机验证（若需要）：在 QQ 输入 `/model qwen3.8-flash --global` 后：
   - QQ 消息回复成功，且使用 `qwen3.8-flash`；
   - Web UI 打开 QQ 会话显示 `qwen3.8-flash`；
   - 检查 `~/.dsh/settings.yaml`，`agent-default-model` 仍然保持 `opencode-go / mimo-v2.5`，未被误伤。
