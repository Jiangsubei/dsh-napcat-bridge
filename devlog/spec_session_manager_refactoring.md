# 规格设计：SessionManager 模块化解耦重构方案

> **文件状态**：草案待审（Draft for Review）  
> **关联源码**：[`src/gateway/session.ts`](file:///f:/Project/dsh-napcat-bridge/src/gateway/session.ts) (1485 行)  
> **目标**：消除 1400+ 行上帝类（God Class），将 5 类正交职责拆解为高内聚、低耦合的专职子模块，同时保证外部调用接口 100% 向后兼容。

---

## 1. 现状痛点与重构动因

当前 `src/gateway/session.ts` 文件总计 1485 行，核心类 `SessionManager` 达 1226 行，单类同时承担了以下 5 类完全正交的系统职责：

```
+-----------------------------------------------------------------------------------------+
|                                    SessionManager                                       |
+-----------------------------------------------------------------------------------------+
| 1. 身份映射与寻址     | 2. 状态持久化与物理探测 | 3. Agent 调度与生命周期 | 4. 工作区与 CWD | 5. 模型与思维链配置 |
| parseSessionId        | loadStateFromDb        | getOrCreateAgent       | getDshHome      | getHostDefaultModel |
| buildSessionId        | saveSessionState       | dispatchWakeup         | resolveCwd      | resolveDefaultEffort|
| peerToSessionId       | isSessionArchived      | markSessionBusy        | registerWorksp. | setModelSelection   |
| sessionIdToPeer       | isSessionPhysically... | resumeSession          |                 | getModelSelection   |
| gap-filling / 短哈希  | 磁盘目录递归探查       | guardSessionController |                 | getAllQQSessionIds  |
+-----------------------------------------------------------------------------------------+
```

### 主要问题
1. **严重违反单一职责原则 (SRP)**：修改一个纯模型选择逻辑或空缺填补算法时，可能因接触到同一个巨型类的状态集合而影响到 Agent 生命周期或磁盘扫描逻辑；
2. **测试与调试困难**：由于多种能力强耦合在 `SessionManager` 实例中，纯函数的计算逻辑（如编号排序、空缺填补、短哈希计算）难以在脱离数据库和 Cordis 上下文的情况下进行轻量单测；
3. **状态爆炸与竞态风险**：内部维护了多达 8 个 Map（`peerCurrentSessionId`, `clearedVersions`, `modelSelections`, `busySessions`, `activeHandles`, `pendingClearedSessionId` 等），并发读写时心智负担极重。

---

## 2. 重构目标与核心原则

1. **绝对零破坏（Zero-Breaking-Change）**：
   - `src/gateway/session.ts` 对外导出的所有类型、类与辅助函数（包括 `SessionManager`, `parseSessionId`, `buildSessionId`, `formatSessionTitle`, `formatWakeupPrompt`, `RemoteError`, `SessionAlreadyOwnedError` 等）的公开签名和行为保持 100% 一致；
   - 现有的 `src/index.ts`, `src/commands/index.ts`, `src/approval/responder.ts`, `src/memory/` 以及全部既有契约测试文件无需修改任何 import 路径或调用方式；
2. **职责单一化与物理拆分**：
   - 每个子模块文件代码量控制在 150 ~ 300 行之间；
   - 纯函数逻辑（编解码、算法）彻底与环境依赖（Cordis Context / SQLite / FS）剥离；
3. **单向依赖、杜绝循环引用**：
   - 子模块之间不直接交叉引用，统一由中央装配层或 `SessionManager` 进行协调。

---

## 3. 目标模块架构划分

在 `src/gateway/session/` 子目录下拆解 5 个专职模块，原 `src/gateway/session.ts` 蜕变为**轻量门面（Facade）与生命周期协调器**：

```
src/gateway/
├── session.ts                         # [门面] 向后兼容导出，组装各子模块并委托调用 (~200 行)
└── session/
    ├── types.ts                       # 会话领域专有类型定义 (~60 行)
    ├── id-resolver.ts                 # [职责 1] 纯函数：编解码、版本推导、空缺填补与哈希 (~220 行)
    ├── workspace.ts                   # [职责 4] CWD 解析与 DSH 工作区目录注册 (~80 行)
    ├── persistence.ts                 # [职责 2] 数据库状态持久化与物理磁盘会话探测 (~260 行)
    ├── model-selector.ts              # [职责 5] 宿主模型探测、思维链解析与 Per-Session 模型映射 (~260 行)
    └── agent-runner.ts                # [职责 3] Agent 创建挂载、排队调度与生命周期句柄管理 (~350 行)
```

---

## 4. 详细模块设计与契约边界

### 4.1 `src/gateway/session/id-resolver.ts`（身份映射与寻址）
- **定位**：无状态纯逻辑模块，零外部服务依赖（仅依赖 `crypto`）。
- **对外暴露接口**：
  ```ts
  export function parseSessionId(sessionId: string): ParsedSessionId | null;
  export function buildSessionId(parsed: ParsedSessionId): string;
  export function generateSessionHash(): string;
  export function findSmallestAvailableVersion(activeVersions: Iterable<number>): number;
  export function formatSessionTitle(peer: string, round?: number, version?: number, customName?: string): string;
  export function formatWakeupPrompt(payload: WakeupPayload): string;
  ```
- **核心算法迁移**：
  - 会话 ID 正则解析器与生成器（含多轮 `-r1-1` 及短哈希后缀）；
  - 空缺编号填补算法 `findSmallestAvailableVersion`；
  - 会话标题中文友好格式化（如 `QQ私聊-用户昵称(123456)`）。

### 4.2 `src/gateway/session/workspace.ts`（工作区与 CWD 管理）
- **定位**：环境与路径解析器，负责工作区物理隔离。
- **类定义**：
  ```ts
  export class SessionWorkspaceManager {
    constructor(private ctx?: Context) {}
    public getDshHome(): string;
    public resolveCwd(peer: string): string;
    public async registerWorkspace(peer: string, cwd: string): Promise<void>;
  }
  ```
- **核心逻辑**：
  - 从 `process.env.DSH_HOME` 或用户主目录定位 `.dsh` 根路径；
  - 为每个 peer 解析隔离目录：`.dsh/workspaces/qq-user-xxx` 或 `qq-group-xxx`；
  - 接入 `ctx.get('workspace')` 执行工作区服务注册。

### 4.3 `src/gateway/session/persistence.ts`（持久化与物理探测）
- **定位**：会话元数据持久化层，连接 SQLite 与底层物理磁盘文件。
- **类定义**：
  ```ts
  export class SessionPersistenceManager {
    constructor(
      private db: MessageDatabase | null | undefined,
      private ctx: Context | undefined,
      private workspaceManager: SessionWorkspaceManager
    ) {}

    public loadAllStates(): SessionStateRecord[];
    public saveSessionState(peer: string, state: Partial<SessionStateRecord>): void;
    public isSessionArchived(sessionId: string): boolean;
    public isSessionPhysicallyPresent(sessionId: string): boolean;
    public async isSessionPhysicallyPresentAsync(sessionId: string): Promise<boolean>;
  }
  ```
- **核心逻辑**：
  - 与 `MessageDatabase` 同步会话状态（`saveSessionState` / `loadAllStates`）；
  - 会话物理存在性双向校验：扫描 `sessions/` 目录下的 `session.json`, `session.jsonl`, `events.jsonl`, `.zstd` 判定会话是否被外部硬删除；
  - 归档状态探测与多轮标记。

### 4.4 `src/gateway/session/model-selector.ts`（模型与思维链管理）
- **定位**：处理与 DSH LLM 服务的交互，维护模型选择状态。
- **类定义**：
  ```ts
  export class SessionModelSelector {
    constructor(
      private ctx: Context | undefined,
      private persistence: SessionPersistenceManager
    ) {}

    public getHostDefaultModelSelection(): ModelSelection;
    public async resolveDefaultEffort(provider: string, model: string): Promise<string | undefined>;
    public getNapcatDefaultModel(): ModelSelection;
    public setNapcatDefaultModel(selection: ModelSelection): void;
    public getDefaultModelSelection(): ModelSelection;
    public getModelSelection(sessionId: string): ModelSelection | undefined;
    public async setModelSelection(sessionId: string, selection: ModelSelection, options?: { persistDb?: boolean }): Promise<void>;
    public getAllQQSessionIds(): string[];
  }
  ```
- **核心逻辑**：
  - 动态查询 `ctx.get('defaultModel')` 与 `ctx.get('llm')` 获取当前环境支持的模型清单；
  - 深度解析模型的 reasoningEffort 能力；
  - 维护内存级会话模型映射，并按需通知 `SessionPersistenceManager` 持久化到 SQLite。

### 4.5 `src/gateway/session/agent-runner.ts`（Agent 生命周期与执行调度）
- **定位**：驱动 DSH 核心运行时，负责 Agent 创建、并发控制与消息排队。
- **类定义**：
  ```ts
  export class SessionAgentRunner {
    constructor(
      private ctx: Context,
      private workspaceManager: SessionWorkspaceManager,
      private modelSelector: SessionModelSelector,
      private outboundBridgeGetter: () => OutboundBridgeLike | undefined
    ) {}

    public getAgent(sessionId: string): Agent | undefined;
    public async getOrCreateAgent(sessionId: string, options?: CreateAgentOptions): Promise<Agent>;
    public markSessionBusy(sessionId: string, busy: boolean): void;
    public isSessionBusy(sessionId: string): boolean;
    public getActiveHandle(sessionId: string): AgentHandle | undefined;
    public hasActiveHandle(sessionId: string): boolean;
    public async releaseActiveHandle(sessionId: string): Promise<void>;
    public async dispatchWakeup(payload: WakeupPayload): Promise<void>;
    public guardSessionController(sc?: any): void;
    public dispose(): Promise<void>;
  }
  ```
- **核心逻辑**：
  - 负责 `ctx.get('agents').create(...)` 并注入 Per-Session 配置、工作区与 Outbound 钩子；
  - 负责 `AgentHandle` 持有、繁忙锁保护与超时释放；
  - 负责唤醒 Prompt 组织并下发执行任务（`dispatchWakeup`）；
  - 提供安全看门狗 `guardSessionController` 拦截非法并发操作。

### 4.6 `src/gateway/session.ts`（外观与聚合协调者）
- 保持原类名 `SessionManager`，内部组合上述 5 个子组件；
- 维护跨组件的高层状态协同（如 `peerToSessionId` 寻址时的版本分配）：
  ```ts
  export class SessionManager {
    private readonly idResolver = IdResolver;
    private readonly workspace: SessionWorkspaceManager;
    private readonly persistence: SessionPersistenceManager;
    private readonly modelSelector: SessionModelSelector;
    private readonly agentRunner: SessionAgentRunner;

    // 所有旧有 public 方法直接一行委托给相应子模块：
    public resolveCwd(peer: string) { return this.workspace.resolveCwd(peer); }
    public getModelSelection(sid: string) { return this.modelSelector.getModelSelection(sid); }
    public async dispatchWakeup(payload: WakeupPayload) { return this.agentRunner.dispatchWakeup(payload); }
    // ...其余 100% 保持完全透明
  }
  ```

---

## 5. 执行步骤与安全验证策略

遵循 AGENTS.md 规范：契约测试先行、构建产物同步（`pnpm build`）、绝不破坏现有测试。

1. **第一阶段：创建目录与提取纯逻辑子模块**
   - 建立 `src/gateway/session/`；
   - 提取 `types.ts` 与 `id-resolver.ts`；
   - 验证既有单测 `session-gap-filling.test.ts` 保持绿色。
2. **第二阶段：提取工作区、持久化与模型管理子模块**
   - 实现 `workspace.ts`、`persistence.ts`、`model-selector.ts`；
   - 单元契约测试：`session-v3-persistence.test.ts`, `workspace-and-title.test.ts`, `commands-permission.test.ts`。
3. **第三阶段：提取 Agent 调度子模块与重构 SessionManager 门面**
   - 实现 `agent-runner.ts`；
   - 将 `src/gateway/session.ts` 精简为组合门面；
   - 运行全局测试 `pnpm test:quick` 与 `pnpm typecheck`。
4. **第四阶段：构建验证**
   - 执行 `pnpm build` 并比对 `dist/` 产物，确保真实运行时生产路径完全正常。
