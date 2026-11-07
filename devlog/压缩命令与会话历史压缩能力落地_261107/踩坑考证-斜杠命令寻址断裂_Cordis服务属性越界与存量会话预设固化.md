# 踩坑考证: 斜杠命令寻址断裂、Cordis服务属性越界与存量会话预设固化

- **状态**: 已考证沉淀
- **日期**: 2026-11-07
- **关联提交**:
  - `d63d112`: feat: 实现 /压缩 斜杠命令与 Compaction 预设及两段式用量报告

---

## 1. 现象与多重迷雾

在为 QQ 侧引入 `/压缩` 斜杠命令（底层对接 DSH 官方 `compaction` 插件组与 `compactNow` 引擎）时，在真机联调阶段连续遭遇了具备极高欺骗性的两阶段故障：

### 阶段一：静默失联（已读不回）
- **现象**：在真机 QQ 侧发送 `/帮助`，正常收到指令列表；但紧接着发送 `/压缩` 时，没有收到首条立即回执（`正在压缩会话历史…`），后台未触发任何实际压缩，也未收到完成回执；
- **排查困境**：OneBot 协议端（SnowLuma）日志显示收到私聊消息 `/压缩`，但网关后续完全没有调用 `send_private_msg`；控制台未见明显红字崩溃。

### 阶段二：微内核注入报错暴露
- **现象**：在网关命令分发层增加未捕获异常的兜底回发后，再次发送 `/压缩`，QQ 侧立刻收到明确报错：
  ```text
  执行指令失败：cannot get property "compaction" without inject
  ```
- **核心疑惑**：为什么在 DSH 原生 Web 界面上手动输入 `/compact` 能够正常执行，但在 QQ 插件侧读取压缩能力却报 `without inject`？

---

## 2. 深度根因剖析（三层陷阱咬合）

经过深入查阅 DSH 官方微内核（`cordis`、`dsh-scope`、`dsh-agent-preset-registry`）源码并结合断点探查，确认这是三个相互咬合的设计陷阱：

### 陷阱 1：`CommandContext` 句柄漏传导致 TypeError 同步崩溃被静默吞掉

在 `src/index.ts` 的消息消费循环中：
```typescript
const agent = await sessionManager.getOrCreateAgent(peer);
const session = agent.session;
const result = await handleSlashCommand(content, {
  userId: fromUser,
  admins: currentConfig().admins || [],
  session,
  // ❌ 遗漏了 agent: agent
  ctx,
  sessionManager,
});
```

而在 `src/commands/index.ts` 的 `case '压缩'` 中：
- 由于上下文没有传入活体 `agent`，代码只能通过 `agents.get(sessionId)` 兜底寻址；
- 寻址到的对象若缺少 `.ctx` 属性（或结构不满足 scope 契约），紧接着调用：
  ```typescript
  const scopedEngine = agentPresets.serviceFor(agent, 'compaction');
  ```
- 查看 `@deepseek-ai/dsh-agent-preset-registry` 源码：
  ```javascript
  serviceFor(agent, name) {
    const mount = this.generationFor(agent.ctx)?.mount;
    return mount === void 0 ? void 0 : serviceForMount(this.owner, mount, name);
  }
  ```
- `generationFor` 底层执行 `@deepseek-ai/dsh-scope` 的 `scopeOf(agent.ctx)`，其实现为 `return ctx[kScope];`。
- **致命崩溃**：若传入缺少 `ctx` 的对象，`scopeOf` 直接抛出：
  ```text
  TypeError: Cannot read properties of undefined (reading 'Symbol(dsh.scope)')
  ```
- 该错误发生在同步阶段且未被 `try-catch` 包裹，直接被外层 `catch (cmdErr)` 捕获后静默退出，导致首条回复未能下发，两段式异步追发彻底断链。

---

### 陷阱 2：Cordis 微内核属性拦截与注入隔离（`without inject` 红线）

在修复了 `agent` 传递后，为什么紧接着出现 `cannot get property "compaction" without inject`？

查阅 `@deepseek-ai/cordis`（Cordis 4.x）的 `ReflectService` 源码：
```javascript
static handler = {
  get: (target, prop, ctx) => {
    if (isSpecialProperty(prop)) return Reflect.get(target, prop, ctx);
    if (Reflect.has(target, prop)) return getTraceable(ctx, Reflect.get(target, prop, ctx));
    const error = new Error(`cannot get property "${prop}" without inject`);
    ...
    if (fiber.parent[symbols.isolate][prop] !== key) throw error;
  }
}
```
并且 Cordis 官方在 `ctx.get` 的方法签名上明确注明：
```javascript
/**
* Read a service from the store without the inject requirement.
* @param name — the service name.
*/
get(name, strict = true) { ... }
```

- **底层铁律**：
  1. 插件在 `export const inject = [...]` 中声明的属于必需依赖；
  2. 未在 `inject` 中声明的可选服务，**必须且只能通过 `ctx.get('serviceName')` 从 store 安全查找**，未提供时安全返回 `undefined`；
  3. **严禁使用属性直接访问**：一旦写了 `(ctx as any).xxx` 或 `ctx.xxx`，若当前上下文并未声明该 inject 且该服务处于 isolate 隔离中，Cordis 的 Proxy Getter 会**无条件抛出 `cannot get property "${prop}" without inject` 致命异常**；
- **破案现场**：
  在代码降级分支中写了：
  ```typescript
  const hostEngine = context.ctx.get?.('compaction') || (context.ctx as any).compaction;
  ```
  在当前测试会话中，由于 `scopedEngine` 未就绪且 host 平面禁用了 compaction，`ctx.get('compaction')` 返回了 `undefined`；代码接着执行了 `|| (context.ctx as any).compaction`，直接命中属性拦截抛错！

---

### 陷阱 3：DSH 存量会话预设固化设计哲学（Strict Session Immutability）

为什么在重启 Harness 且插件已更新最新预设后，存量会话的 `scopedEngine` 依然返回 `undefined`？

- **DSH 会话与预设绑定哲学**：
  DSH 官方在 `dsh-session` 与 `dsh-agent-loop` 中遵循严格的会话不变性原则：
  > *"Durable because the preset decides the session's tools and prompt: a resume that restored a different composition would replay history the model can no longer act on."*
- **存量会话的客观状态**：
  测试所用的当前私聊会话是在添加 compaction 预设组**之前**创建的。在 DSH 存储中，该会话关联的预设快照永远停留在历史版本，不会在 resume 时被自动篡改或追加新插件；
- **反模式警示**：
  企图在运行时调用 `agentPresets.recompose` 强行篡改历史会话的预设是危险的反模式行为，可能引发该会话历史工具调用与 Prompt 出现断层；
- **正当行为边界**：
  对存量会话，如实、平稳地向用户回执 `压缩服务不可用：当前会话未挂载压缩能力。`；当用户通过 `/清空` 开始新轮次时，新会话将自然装配包含 compaction 组的最新完整预设。

---

## 3. 防范准则与工程最佳实践

为彻底杜绝类似陷阱复发，项目确立以下四项开发红线：

### 3.1 杜绝直接属性访问，统一使用 `safeGetService`
在所有插件代码中，严禁使用 `(ctx as any).xxx` 获取可选服务，必须统一使用安全辅助函数：
```typescript
export function safeGetService<T = any>(ctx: any, name: string): T | undefined {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const val = ctx.get(name);
      if (val !== undefined) return val;
    }
  } catch {}
  try {
    if (ctx.root && typeof ctx.root.get === 'function') {
      const rootVal = ctx.root.get(name);
      if (rootVal !== undefined) return rootVal;
    }
  } catch {}
  return undefined;
}
```

### 3.2 寻址调用强制防御包裹
调用宿主复杂服务（如 `agentPresets.serviceFor(agent, ...)`）时，必须执行 `agent?.ctx` 前置守卫，并完整包裹 `try...catch`，避免第三方库底层抛出的未分类异常打断调用线程。

### 3.3 遵守会话生命周期，不强改存量预设
会话预设一旦创建不可热篡改。功能未挂载时平稳降级并清晰告知用户，依赖 `/清空` 或新建会话自然激活新预设。

### 3.4 网关分发必须具备友好异常兜底
斜杠命令分发层必须捕获最外层异常，并向 QQ 发送端下发友好错误提示，杜绝任何“已读不回 / 静默中断”。
