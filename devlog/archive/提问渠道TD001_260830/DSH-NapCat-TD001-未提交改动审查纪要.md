# TD-001 未提交改动审查纪要 — webStartup 信号 + 非严格 apiProxy 探测的 composite 注册

> **性质**：审查纪要（review memo），非代码交付。
> **审查对象**：工作区未提交改动（`git diff`）
>   - `src/approval/responder.ts`（registerNapCatQuestionChannel 时序细化）
>   - `tests/contract/questions-provider-channel.test.ts`（新增"情况1b: web 部署不抢注"）
> **核对基线**：本机全局 DSH 安装 `~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，DSH `0.1.1-rc.2`；
> 所有官方描述均逐条源码/类型实证，非转述记忆。
> **结论**：**方案合理且与官方 API 语义逐条吻合**（详 §3）；存在 4 项非阻塞改进点（§4），核心 2 项（eager 死参数、provider 绕过官方 private 槽位）建议下批清理。

---

## 1. 未提交改动内容

1. **`ctx.get` 签名放宽**：`get(name, strict?: boolean)`，新增两处非严格探测：
   - `ctx.get('apiProxy', false)` —— 探测 apiProxy"在途"（已被官方插件声明入 Cordis 树但 fiber 可能未激活）；
   - `ctx.get('webStartup', false)` —— 新引入的 **web 部署信号**：`dsh-web-app` 提供 `webStartup` 服务即判定为 web+QQ 同部署；
2. **apply 阶段绝不抢注**：情况1（官方 registerProvider）新增 `!isWebApp` 守卫——web 部署下即使宿主 provider 尚未出现也保持静默，改由 `ctx.inject(['apiProxy'])` 回调 composite 接管；
3. `register` 新增 `eager` 参数（**两个调用点均未传 false，属死代码**，见 §4.1）；
4. 测试新增"情况1b"：webStartup 就绪 → apply 不注册不赋值 → 宿主 provider 出现后 inject 回调 composite 接管。

## 2. 官方描述（源码实证）

### 2.1 cordis `ctx.get(name, strict = true)`（`cordis/lib/index.js:762`）
> Read a service from the store without the inject requirement.
> `@param strict` — when `true`, only return implementations whose providing
> fiber is currently active.

`_getImpl` 实现（`:771-777`）：`strict && impl.fiber.state !== 2` 时返回 undefined；`strict=false` 时**只要 store 里已有该服务的声明记录（不限 fiber 状态）即返回其实例**。
→ 新代码"非严格取 apiProxy 探测在途"的语义理解**完全正确**。

### 2.2 `webStartup` 服务（`dsh-web-app/lib/types/startup.d.ts:14`、`lib/startup.js`）
> The web app's command-line provider: it parses the `dsh --profile web` flag
> family (…), then provides the immutable values as `WEB_STARTUP_SERVICE`.
> `WEB_STARTUP_SERVICE = "webStartup"`；`program.action()` 内 `ctx.provide(WEB_STARTUP_SERVICE, {openBrowser, host?, port?, trustedHosts})`。

- **仅 `dsh --profile web` 启动**时提供（`--help`/参数校验失败不提供，此时也没有 Web UI，语义自洽）；
- **headless / 本项目 `bootDshNapcatBridge` 装配不提供** —— 与代码注释断言一致；
- web bundle patch（`dsh-web-app/cordis.patch.yml`）含 `web-startup` 行（提供 webStartup）与 `api-gateway` 行 = `@deepseek-ai/dsh-host-apiproxy`（patch:106）——
  **webStartup 与 apiProxy/官方 provider 由同一官方 bundle 耦合提供**，用 webStartup 做"web 部署必有宿主 provider"的信号是一致的。

### 2.3 `userQuestions` 服务（`@deepseek-ai/dsh-user-questions`，官方描述）
> Abstract user-questions seam (ctx.userQuestions) for asking the human during agent runs.

- Service 实例由 base 组合行提供：`dsh-base/cordis.patch.yml:55-56`（`- id: user-questions / name: '@deepseek-ai/dsh-user-questions'`）—— **headless 与 web 都装配**；
- **单槽位**：`registerProvider(provider)`（`lib/index.js`）effect flush 时 `this.provider !== void 0` 抛 `DUPLICATE_PROVIDER`；返回 disposer（置回 `void 0`）；
- **`provider` 字段官方类型标注为 `private`**（`lib/types/index.d.ts`：`private provider;`）—— 直接赋值属运行时可行的官方外操作（详见 §4.2）；
- `ask(request)` 在派发前做 agent 活性校验（`CALLER_NOT_LIVE` / `DELEGATED_CALLER`）、intent 校验（`BAD_INTENT`）、无 provider 抛 `NO_PROVIDER`；**服务本身不做任何 session 类型分流**。

### 2.4 官方唯一 provider（`dsh-host-apiproxy/lib/index.js:1861-1890`）
> API gateway: the ApiProxy contract (api/), the fetch carrier pair (fetch/),
> and the host-side gateway plugin providing ctx.apiProxy.

- `registerProvider({ask})`：`const sessionId = request.agent?.id`（**官方以 `agent.id` 作会话标识**）→ 宿主私密生成 `rpcId` → pending 表 → mux 广播全部 Web UI；作答经 `POST /api/respond` 认领；
- `ctx.apiProxy` 服务：`super(ctx, "apiProxy")`（`:5530`）。

### 2.5 `Agent` 与 `AskUserQuestionRequest`（`dsh-agent/lib/types/runtime-types.d.ts:60-66`、`dsh-user-questions/lib/types/index.d.ts:20-24`）
- `Agent.id: SessionId` —— 官方注释 "The single identity shared with `session`"，**`agent.id === agent.session.id`**；
- `AskUserQuestionRequest.agent?: Agent` —— "Exact live calling agent, when the request came from an agent tool call"；
- `dsh-tool-ask-user` 调用点：`...exec.agent !== void 0 ? { agent: exec.agent } : {}`。
→ composite 路由键 `request.agent?.id || request.agent?.session?.id` 与官方 api-proxy 的 `agent.id` 语义一致；
→ `NapCatQuestionProvider.ask` 用 `agent.session.id` 同样成立（Agent 必有 `session`）。

### 2.6 `ctx.inject`（`cordis/lib/index.js:1599-1612`）
> inject(inject, callback) → this.plugin({ inject, apply: callback })  —— **新建独立子 fiber**。

→ 在 apply 内调用 `ctx.inject(['apiProxy'], cb)` **不会阻塞当前插件激活**：headless 下只是产生一个永不激活的 pending 子 fiber（父 ctx 释放时随 fiber 树回收），符合实测（ready 不补发的装配环境 apply 阶段注册仍生效）。

## 3. 合理性结论（逐项对照）

| 改动点 | 官方语义对照 | 判定 |
|---|---|---|
| `ctx.get('apiProxy', false)` 探测在途 | cordis strict=false 返回任意 fiber 状态下的 store 记录 | ✅ 正确 |
| `webStartup` 作 web 部署信号 | web profile 独有服务，与 host-apiproxy 同 bundle 耦合 | ✅ 正确且自洽 |
| 情况1 加 `!isWebApp` 守卫，apply 绝不抢注 | 消除热修前 DUPLICATE_PROVIDER 竞态的直接手段（官方单槽位实证） | ✅ 正确 |
| `inject(['apiProxy'])` 就绪后 composite 接管 | 待 apiProxy fiber 激活（state 2）后回调，此时官方 provider effect 已 flush | ✅ 正确 |
| ready 兜底幂等 | `provider === questionProvider` / `composed` 双守卫，重复执行无副作用 | ✅ 正确 |
| 直接赋值 `svc.provider = compositeProvider` | 官方字段 private、单槽位校验在 registerProvider 内 —— 旁路操作，**用户已拍板 C 方案**，风险已知（升级可能碎） | ⚠️ 已接受，需记录 |
| composite 路由键 `agent.id / session.id` | 官方 api-proxy 同键；`qq-group-*`/`qq-user-*` 与 SessionManager 生成规则一致 | ✅ 正确 |
| dispose 还原宿主 provider | 条件 `provider === compositeProvider` 才还原，避免误伤 | ✅ 正确 |
| 测试 85/85 全绿（含新增情况1b） | 装配契约（B2-契约3/TD001-契约4）同样在跑 | ✅ 通过 |

## 4. 改进点（非阻塞，按优先级）

1. **`eager` 参数是死代码**（responder.ts:218/231）：两个调用点（inject 回调、ready、apply）均未传 `false`，只有默认值路径可达。建议下批删除参数与 `eager &&` 条件，避免误导后续维护者以为存在"惰性注册"分支。
2. **`userQuestionsSvc.provider` 官方为 `private`**（§2.3）：直接赋值依赖 TS `private` 仅为编译期约束这一事实，官方任何字段重构（getter/rename）都会碎。已在调研纪要标记"无官方 seam，升级可能碎"，本纪要再记录一次：**该旁路仅当官方不提供多通道 seam 时成立，升级需回归复合路径**。
3. **行序依赖残差**：bridge 插件若在 `web-startup` 行之前 apply，`webStartup` 尚未入 store → 信号缺失 → apply 抢注 → 与官方 provider 冲突。实际 profile 组合中 bundle insert 行先于用户插件行，风险低但非零——**真机验证（§2.4 剩余项）时应确认 web 启动无 DUPLICATE_PROVIDER 报错**。
4. **inject 回调早触发窗口**：若 `apiProxy` 注入回调触发时宿主 provider 尚未 flush（时序测试模拟场景），情况1（isWebApp 跳过）与情况2（provider 为空跳过）均不执行 → 静默不接管，仅靠 ready 兜底。真实时序下（host-apiproxy apply 完整跑完才轮到子 fiber 回调）窗口极小，但代码对该窗口无显式兜底，建议真机验证时观测提问卡片是否能在 QQ 侧呈现。

## 5. 真机验证清单（承接调研纪要 §2.4）

- [ ] `dsh web` + NapCat 同机：启动日志无 DUPLICATE_PROVIDER / 无 `NO_PROVIDER`；
- [ ] QQ 会话提问 → composite 路由进 NapCatQuestionProvider，QQ 侧收到问题卡片并可作答 resolve；
- [ ] Web 会话提问 → composite 委托宿主 provider，Web UI 卡片行为与未装插件时一致；
- [ ] 插件卸载/重载 → 宿主 provider 还原，Web 提问不受影响；
- [ ] 纯 headless（bootDshNapcatBridge）→ 情况1 注册路径，无 webStartup 依赖残留。