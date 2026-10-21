# TD-001 调研纪要 — QQ 侧提问能力与「单一组合 provider」的官方集成方式

> **性质**：调研纪要（investigation memo），非代码交付。
> **关联**：桌面 `DshNapcat-Issue-List.md` TD-001；热修 commit `c902517`（移除插件 userQuestions 注册）。
> **核对基线**：本机 `~/.dsh/profiles/node_modules/@deepseek-ai/`，DSH `0.1.1-rc.2`（`dsh-user-questions@0.1.1-rc.2`、`dsh-host-apiproxy@0.1.1-rc.2` 均已核对版本）。
> **结论速览**：**DSH 0.1.1-rc.2 不存在「官方单一组合 provider 统一路由」这一官方可插拔 seam**。`registerProvider` 是**单槽位**语义（第二个注册者抛 `DUPLICATE_PROVIDER`），且槽位已被官方 `dsh-host-apiproxy` 的 Web 渠道 provider 占据；官方 provider 把**所有会话（含 QQ 会话）的提问广播给 Web UI**，QQ 侧作答无法回灌官方 pending 表（rpcId 由宿主私密生成）。**用户已拍板落地方式**（参照本机 nyagent 成熟 composite 方案）：headless 场景走官方 `registerProvider`；web+QQ 同部署时构造**按 session 路由的 composite provider** 并**直接赋值** `userQuestionsSvc.provider`（绕开单槽位校验，仅在 api-proxy 就绪后接管，dispose 还原宿主）——本批次已实现并全绿（84/84），详见 §2.3。

---

## 1. 官方 provider 结构（源码实证，逐条可查）

### 1.1 `ctx.userQuestions`：单槽位 provider 服务（`dsh-user-questions/lib/index.js`）

- **单槽位语义**（`index.js:31-38`）：
  ```js
  registerProvider(provider) {
    const dispose = this.ctx.effect(function* () {
      if (this.provider !== void 0)
        throw new UserQuestionError("a user-questions provider is already registered", "DUPLICATE_PROVIDER");
      this.provider = provider;
      yield () => { this.provider = void 0; };
    }.bind(this), "userInteraction.registerProvider()");
    return () => void dispose();
  }
  ```
  关键点：①`registerProvider` 是**单槽位**——第二个注册者的 effect 在 flush 时抛 `DUPLICATE_PROVIDER`；
  ②真正的"占用检查 + 赋值"发生在 **effect flush 阶段**（不是同步调用点），因此
  "先查 `provider` 字段再注册"的**守卫并不能消除竞态**——这正是热修前 web 启动崩溃的机理
  （插件 apply 时 provider 尚未 flush，守卫误判为空，随后双 effect 撞车抛出）。
- **ask() 调度与校验**（`index.js:45-75`）：
  - agent 必须等于 registry 中确切的 live 实例（`CALLER_NOT_LIVE`，`:62`），且必须是 live root
    （被子代理持有时报 `DELEGATED_CALLER`，`:63`）；
  - 无 provider 时报 `NO_PROVIDER`（`:71`），否则直接 `return this.provider.ask(request)`（`:72`）——
    **服务本身不做任何 session 类型（web/QQ）分流**。

### 1.2 官方唯一 provider 的实现（`dsh-host-apiproxy/lib/index.js:1861-1890`）

```js
const disposeProvider = ctx.userQuestions.registerProvider({ ask(request) {
  const sessionId = request.agent?.id;                       // :1862 要求 agent 会话
  if (sessionId === void 0) return Promise.reject(...ASK_MISSING_AGENT);
  return new Promise((resolve, reject) => {
    const rpcId = RpcId(randomUUID());                       // :1866 宿主私密生成
    const pending = { rpcId, sessionId, questions, resolve, reject, ...signal };
    pendingQuestions.set(rpcId, pending);                    // :1879 宿主内存 pending 表
    const envelope = { rpcId, payload: { type: "question/requested", sessionId, questions } };
    for (const queue of muxQueues) queue.push(envelope);     // :1883-1888 广播给所有 Web UI
  });
} });
```

- **流向**：`ask_user_question` 工具（`dsh-tool-ask-user`，`ctx.userQuestions.ask({questions, agent, signal})`）
  → 唯一 provider.ask → **无论会话是 web 还是 QQ，一律广播 `question/requested` 给全部 Web UI 客户端**
  （mux / SSE 推送，会话名只作为卡片归属，不作通道路由）。
- **作答回流**（`api-proxy` `respond(message)`，`index.js:3727-3775`）：
  浏览器 POST `/api/respond`（携带 `rpcId` 回执）→ 按 `pendingQuestions.get(message.rpcId)` 认领
  → `questionResponsePayloadSchema` + `matchesQuestions(payload, pending)`（`:3769`）校验
  → `claimQuestion(pending, "answered")` → `pending.resolve(payload.answer)`，并广播
  `question/resolved`（Web UI 卡片关闭）。
- **关键事实**：`rpcId` 由宿主在 ask 内私密生成、只随 mux 信封下发；**pending 表的 resolve/reject
  闭包完全位于 host-apiproxy 内部**。插件侧既拿不到 rpcId，也够不到 pending 表，因此
  "QQ 用户作答 → 官方状态机 resolve"这条路在 rc.2 上**不存在**（除非插件自身就是那个 provider）。

### 1.3 与审批（approval）的机制差异（为什么审批能 QQ 双通道、提问不能）

- 审批走 `approval/request` **waterfall**（`index.js` host 侧 `ctx.on("approval/request", (req, next) => …)`：
  host 的 handler 不 `next()` 时由插件 handler 接管——**多 handler 天然可叠加**）；
  本插件的 `NapCatApprovalResponder` 正是挂在这个官方 waterfall 上，实现 QQ 呈现+作答，
  host 的 Web 渠道同时保留——这是**官方支持的多通道 seam**。
- 提问走 `userQuestions` **单槽位 provider**——不存在 waterfall/多 handler 语义。
  `dsh-tool-ask-user/lib/index.js:97` 直接 `ctx.userQuestions.ask(...)`，无旁路钩子。

---

## 2. "如何接入 QQ 渠道 / 双 channel 协同"的结论

### 2.1 可验证的事实约束（0.1.1-rc.2）

1. 槽位唯一：Web 部署下 host-apiproxy 已占槽（`registerProvider` 抛 `DUPLICATE_PROVIDER` 实证，
   也是 `c902517` 热修的原因）；
2. 官方 provider 无会话通道概念：QQ 会话提问也会在 **Web UI** 呈现卡片（session 名
   `qq-group-...`），用户可在 Web UI 作答并正常 resolve——**提问走官方 Web UI 渠道是当前工作路径**；
3. QQ 侧呈现/作答需要"成为那个 provider"或官方提供 multichannel seam，二者 rc.2 均不满足；
4. 宿主重启丢失 pending（README 已知限制："待回答的提问无法跨宿主重启存活"），与 QQ 通道无关。

### 2.2 三个落地选项（需用户拍板，AGENTS §2.2 用户决策制）

| 选项 | 做法 | 优 | 劣 | 定论 |
|---|---|---|---|---|
| **A（现状保持）** | 不注册提问 provider；QQ 会话提问经 Web UI 卡片呈现与作答 | 零侵入、无崩溃风险、官方语义内 | 纯 QQ 场景用户必须看 Web UI 才能作答 | 已被用户否决 |
| **B（无 Web UI 部署：官方合规）** | 在**没有** host-apiproxy 的部署恢复 `registerProvider(NapCatQuestionProvider)` | 完全走官方 registerProvider + service.ask，无旁路 | 对"web+QQ 同部署"无效（槽位被占） | 已并入 C 的方案（情况1 分支） |
| **C（web+QQ 同部署：按 session 路由的 composite）** | ①headless/无宿主 provider 时走官方 `registerProvider`；②宿主 provider 已存在时**直接赋值** `userQuestionsSvc.provider = compositeProvider`（绕开单槽位校验），composite 按 session 路由：QQ → `NapCatQuestionProvider.ask`，其他 → 委托宿主 provider | QQ 侧可作答、Web 侧行为不变；参照本机 nyagent 成熟实现，实战验证过 | 无官方 seam 依赖（升级可能碎）；必须保证时序（见下） | ✅ **用户拍板选定并已落地**（2026-08-30） |

### 2.3 已落地实现（用户拍板方案，`src/approval/responder.ts:180-290`）

```ts
registerNapCatQuestionChannel(ctx, { questionProvider, isQQSession, logger })
```

- **情况1**（`!svc.provider && !apiProxy`，纯 headless/独立 QQ 部署）：调用官方
  `userQuestionsSvc.registerProvider(questionProvider)`，返回的 unregister 入 dispose 链；
- **情况2**（`svc.provider` 存在且非本渠道）：记录宿主 `hostProvider`，构造 composite，
  **直接赋值** `userQuestionsSvc.provider = compositeProvider`（绝不二次 registerProvider，
  否则 DUPLICATE_PROVIDER）；`ask(request)` 内按 `request.agent.id/session.id` 路由：
  QQ 会话（默认 `qq-` 前缀，可自定义 `isQQSession`）→ `NapCatQuestionProvider.ask`，
  其他 → `hostProvider.ask(request)`；dispose 时若仍是 composite 则还原宿主。
- **时序（避免 rc.2 竞态，照 nyagent 三要点）**：
  1. `ctx.inject(['apiProxy'])` —— 等官方 api-proxy 服务就绪后再 composite 接管（web 部署主路径）；
  2. `ctx.on('ready')` 兜底 —— 覆盖 headless / 装配时序（本测试装配环境 ready 不补发已实测，
     故保留 apply 阶段守卫注册）；
  3. apply 阶段仅当 **apiProxy 与宿主 provider 均不存在** 时（纯 headless）立即注册，
     绝不触碰 apiProxy 在途或宿主 provider 已存在的场景 → 消除热修前 DUPLICATE_PROVIDER 竞态。
- 接线：`src/index.ts`（`questionProvider` + `unregisterQuestionChannel` + dispose 释放）；
  装配测试 `tests/contract/assembly.test.ts` B2-契约 3（情况1：无 provider → 注册 NapCat 渠道）与
  TD001-契约 4（情况2：已存在 provider → composite 接管 + Web 会话委托 + dispose 还原）均已转绿；
  组合路由契约测试 `tests/contract/questions-provider-channel.test.ts`（5 例：情况1/情况2/时序/自定义路由/ready 兜底）。

### 2.4 剩余事项

- **需真机验证**：实际 `dsh web` + NapCat 同机部署下 composite 接管的端到端提问呈现与作答
  （本机测试环境无 host-apiproxy，仅覆盖 headless 装配路径与逻辑时序）；
- **升级风险**：composite 依赖 `userQuestionsSvc.provider` 字段可写、宿主 provider 局部于宿主桩；
  若 DSH 后续提供官方 multichannel/channel seam，应迁移至官方通道。

---

## 3. 附：关键代码位（便于复核）

- `dsh-user-questions/lib/index.js:31-38`（registerProvider 单槽位 + DUPLICATE_PROVIDER）
- `dsh-user-questions/lib/index.js:45-75`（ask 校验；`:62` CALLER_NOT_LIVE、`:63` DELEGATED_CALLER、`:72` 唯一 provider 直调）
- `dsh-host-apiproxy/lib/index.js:1861-1890`（官方 provider：rpcId 私密生成、pendingQuestions、mux 广播 question/requested）
- `dsh-host-apiproxy/lib/index.js:3727-3775`（POST /api/respond 作答认领：matchesQuestions 校验 → resolve + question/resolved 广播）
- `dsh-host-apiproxy/README.zh.md`（"待处理交互状态位于宿主侧"、"待回答的提问无法跨宿主重启存活"）
- `dsh-tool-ask-user/lib/index.js:97`（模型侧 ask_user_question 工具直呼 service.ask，无旁路钩子）
- 本项目：`src/approval/responder.ts`（`NapCatQuestionProvider` + `registerNapCatQuestionChannel` composite 接线已落地）、`src/approval/responder.ts`（`NapCatApprovalResponder` 走官方 waterfall 已接线）
- 参照实现：本机 `nyagent/src/plugins/qq-gateway/index.ts:176-225`（composite provider 按 session 路由 + apiProxy 就绪时序 + dispose 还原，用户指定参考方）

---

*创建：2026（dsh-napcat-bridge 文件链路+需求增强整改批次）*
*性质：调研纪要 — TD-001*