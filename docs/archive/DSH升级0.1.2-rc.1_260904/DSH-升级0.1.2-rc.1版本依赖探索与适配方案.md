# DSH 升级 0.1.2-rc.1 版本依赖探索与适配方案

> **文档状态**：探索完成，等待用户决策确认  
> **文档位置**：`docs/DSH-升级0.1.2-rc.1版本依赖探索与适配方案.md`  
> **创建时间**：2026-09-04  

---

## 1. 全局包版本核对

通过对用户全局环境的查验，核对事实如下：
- **全局 DSH 路径**：`/home/nyara/.local/bin/dsh -> ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js`
- **全局 DSH 版本**：`@deepseek-ai/dsh@0.1.2-rc.1`
- **配套依赖基线**：
  - `@deepseek-ai/cordis`: `4.0.2`
  - `@deepseek-ai/schemastery`: `3.18.2`
  - `@deepseek-ai/dsh-*` 全家桶：全部为 `0.1.2-rc.1`
  - `@deepseek-ai/dsh-client-ui-primitives`: `0.1.2-rc.1`

---

## 2. 项目依赖升级规划与实施

已在 [`package.json`](package.json) 中将项目依赖升级对齐至全局包版本，并通过 `pnpm install` 更新了锁文件：

```json
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-agent": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-app-boot": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-base": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-commands": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-llm": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-permission-presets": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-session": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-settings": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-storage": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-storage-domain": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-storage-json": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-system-prompt": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-tools": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-user-approval": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-user-questions": "^0.1.2-rc.1",
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh": "0.1.2-rc.1",
    "@deepseek-ai/dsh-agent": "0.1.2-rc.1",
    "@deepseek-ai/dsh-app-boot": "0.1.2-rc.1",
    "@deepseek-ai/dsh-base": "0.1.2-rc.1",
    "@deepseek-ai/dsh-client-ui-primitives": "0.1.2-rc.1",
    "@deepseek-ai/dsh-commands": "0.1.2-rc.1",
    "@deepseek-ai/dsh-llm": "0.1.2-rc.1",
    "@deepseek-ai/dsh-permission-presets": "0.1.2-rc.1",
    "@deepseek-ai/dsh-session": "0.1.2-rc.1",
    "@deepseek-ai/dsh-settings": "0.1.2-rc.1",
    "@deepseek-ai/dsh-storage": "0.1.2-rc.1",
    "@deepseek-ai/dsh-storage-domain": "0.1.2-rc.1",
    "@deepseek-ai/dsh-storage-json": "0.1.2-rc.1",
    "@deepseek-ai/dsh-system-prompt": "0.1.2-rc.1",
    "@deepseek-ai/dsh-tools": "0.1.2-rc.1",
    "@deepseek-ai/dsh-user-approval": "0.1.2-rc.1",
    "@deepseek-ai/dsh-user-questions": "0.1.2-rc.1",
    "@deepseek-ai/schemastery": "^3.18.2"
  }
```

---

## 3. 升级后探索结果综述

### 3.1 客户端构建 (`pnpm run build:client`)
- **状态**：✅ **通过**（生成 `dist/client.js`，大小 41,980 字节）。
- 说明：`@deepseek-ai/dsh-client-ui-primitives@0.1.2-rc.1` 中使用到的 `IconChevronDownOutline14` 依然导出完备，无任何编译问题。

### 3.2 类型检查 (`pnpm typecheck`)
- **状态**：❌ 报错 6 处（涉及 4 个文件）：
  1. `src/approval/responder.ts:11`：`UserQuestionProvider` 类型在 `@deepseek-ai/dsh-user-questions` 中已被移除。
  2. `src/boot.ts:61`：`healProfilesModuleFallback(installAnchor, dshHome)` 参数由位置入参改为 options 对象入参。
  3. `src/commands/index.ts:110`：`permissionPresets.current(session.events)` 报错 `Property 'events' does not exist on type 'Session'`。
  4. `src/index.ts:8`：`installSettingsSection` 与 `settingsNamespace` 独立函数在 `@deepseek-ai/dsh-settings` 中已被移除。
  5. `src/index.ts:80`：参数类型隐式推断报错。

### 3.3 测试运行 (`pnpm test:quick`)
- **状态**：15 passed，12 failed（43 项失败）。
- **根因分析**：12 个失败文件均是因为在 `bootDshNapcatBridge()` 阶段调用了 `healProfilesModuleFallback(installAnchor, dshHome)`。由于 0.1.2-rc.1 改变为对象签名，传入 string 导致函数内部 `options.installAnchor` 为 undefined，在 `readFileSync(undefined)` 时抛出 `TypeError: The "path" argument must be of type string or an instance of Buffer or URL. Received undefined`，导致整个 DSH 启动流程中断。

---

## 4. 深度探索：新版本破坏性变更与适配点方案

### 适配点 1：`healProfilesModuleFallback` 改为对象入参且返回 Promise
- **原先签名 (0.1.1-rc.2)**：
  ```ts
  function healProfilesModuleFallback(installAnchor: string, home?: string): void;
  ```
- **新版签名 (0.1.2-rc.1)**：
  ```ts
  interface ProfileModuleFallbackOptions {
    installAnchor: string;
    profile?: Profile;
    home?: string;
  }
  function healProfilesModuleFallback(options: ProfileModuleFallbackOptions): Promise<void>;
  ```
- **拟定适配方案**：
  在 `src/boot.ts:61` 中，将调用改为：
  ```ts
  await healProfilesModuleFallback({ installAnchor, home: dshHome });
  ```

---

### 适配点 2：`UserQuestionService` 重构为 Cordis Waterfall（重大架构升级）
- **原先设计 (0.1.1-rc.2)**：
  - `userQuestionsSvc.registerProvider(provider)` 为**单槽位**设计（二次注册抛 `DUPLICATE_PROVIDER`）。
  - 项目此前因此必须使用 Hack：在 web profile 下以直接赋值 `userQuestionsSvc.provider = compositeProvider` 绕过校验，并在 `inject(['apiProxy'])` 和 `on('ready')` 下防抢注。
- **新版设计 (0.1.2-rc.1)**：
  - 官方彻底废弃并移除了 `registerProvider` 方法与 `UserQuestionProvider` 类型！
  - 官方正式引入了 Cordis Waterfall 事件机制：
    ```ts
    'user-questions/request'(
      this: Scoped<Agent>,
      request: AskUserQuestionRequestEvent,
      next: () => Promise<AskUserQuestionAnswer>
    ): Promise<AskUserQuestionAnswer>
    ```
  - 支持多 Answerer 自然级联：若是本插件处理的请求（QQ 会话），返回答题 Promise；若不是，调用 `next()` 委托给宿主 Web UI 或下一个 Provider！
- **拟定适配方案**：
  1. 移除 `src/approval/responder.ts` 中已废弃的 `UserQuestionProvider` 类型实现；
  2. 在 `src/index.ts` 中，直接注册官方 waterfall 事件：
     ```ts
     ctx.on('user-questions/request', async (req: any, next: any) => {
       const sessionId = req.agent?.session?.id;
       if (!sessionId || !sessionManager.isQQSession(sessionId)) {
         return next ? next() : Promise.reject(new Error('no answerer'));
       }
       return await questionProvider.ask(req);
     });
     ```
  3. 彻底消除此前由于单槽位限制而不得已采用的 `compositeProvider` 与直接改写 private 属性的临时补丁代码，完全转正为官方一等公民级联！

---

### 适配点 3：`dsh-settings` 模块方法化
- **原先设计 (0.1.1-rc.2)**：
  ```ts
  import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
  installSettingsSection(ctx, settingsNamespace(SETTINGS_NAMESPACE), BridgeConfigSchema, config, { setSource, onChange });
  ```
- **新版设计 (0.1.2-rc.1)**：
  - 删除了独立函数导出，统一整合到 `SettingsProvider` 实例方法 `installSection` 上。
  - 第一方插件标准使用模式（参见官方 `dsh-permission-presets` / `dsh-pwsh-local` 等）：
    ```ts
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, SETTINGS_NAMESPACE, BridgeConfigSchema, config, {
        setSource: (current) => {
          currentConfig = () => ({ ...config, ...(current() || {}) });
        },
        onChange: async () => { ... }
      });
    });
    ```
- **拟定适配方案**：
  按官方第一方规范在 `src/index.ts` 中重构设置段挂载。

---

### 适配点 4：`Session.events` 私有化与 `permissionPresets.current`
- **原先设计 (0.1.1-rc.2)**：
  - `permissionPresets.current(session.events)` 接收事件数组。
- **新版设计 (0.1.2-rc.1)**：
  - `Session` 实例的事件流被私有化为内部管理（`session.eventAt` / `session.snapshotEvents`）。
  - `permissionPresets.current(session: Session): string` 直接接收 `Session` 实例对象本身。
- **拟定适配方案**：
  在 `src/commands/index.ts:110` 中，将 `current(context.session.events)` 改为 `current(context.session)`。

---

## 5. 测试契约用例调整请示（严格遵循规则 §3）

根据《规范与手册》第 3 条红线要求：
> “测试用例是契约与质量红线，代理无权自行修改测试用例；若发现测试用例存在事实性错误或协议理解偏差，必须先向用户汇报并说明原因，经用户明确确认同意后方可修改。”

在 0.1.1-rc.2 时代，以下几个测试用例专门断言了当时官方 `registerProvider` 的存在与单槽位限制：
1. `tests/contract/assembly.test.ts:58`：
   - `expect(typeof ctx.userQuestions.registerProvider).toBe('function');`
   - 原因：0.1.2-rc.1 官方已删除 `registerProvider`，改为 Cordis waterfall。需要调整为断言官方 `ctx.userQuestions.ask` 与 waterfall 机制。
2. `tests/contract/questions-approval.test.ts:34, 82-94`：
   - 用例 `B2-契约 1: 官方 registerProvider 仅支持唯一 provider（第二个注册抛 DUPLICATE_PROVIDER）`
   - 原因：0.1.2-rc.1 官方已经全面支持多 Provider 级联（基于 waterfall），`DUPLICATE_PROVIDER` 概念在官方已不复存在。
3. `tests/contract/questions-provider-channel.test.ts`：
   - 该文件测试了针对 0.1.1-rc.2 单槽位限制而设计的 mock `registerProvider` 与 `userQuestionsSvc.provider` 属性替换逻辑。
   - 原因：在新版本下，应测试新的 waterfall 级联契约。

**请示用户确认**：
是否同意按照上述适配方案，更新业务代码与这部分基于旧版协议设计的测试契约？
待您确认同意后，再动手进行代码适配。
