# ADR 0028: CLI/API Agent Runtime Broker 与统一 Canvas Tool Gateway

- **Status:** Proposed
- **Date:** 2026-08-30
- **Decision scope:** Agent runtime selection, Desktop CLI process boundary, runtime event contract, Canvas MCP reuse
- **Related:** [ADR 0017](./0017-intelligence-provider-boundary.md), [ADR 0021](./0021-open-agent-sdk.md), [ADR 0027](./0027-canvas-layered-runtime.md)

## Context

zhihui 的主产品链路已经是 AI Agent 驱动的无限画布，但“Agent runtime”目前隐含等同于 FastAPI 中的 LangGraph/API 模型调用。产品下一阶段需要在不重做 BYOK、不分叉画布协议的前提下支持三种用户选择：

- `api`：继续使用现有 BYOK、平台模型目录、Custom Provider、Base URL、API Key、模型发现和 LangGraph Design Agent。
- `cli`：调用用户本机已安装并已登录的 Codex CLI、Gemini CLI，后续可扩展 Claude Code 等；zhihui 不读取、上传或保存 CLI 的 OAuth Token、Cookie、账号密码。
- `auto`：本机 CLI 已安装、认证可用且具备本次任务所需能力时选 CLI，否则在执行开始前回退 API。

必须保持唯一画布执行协议：

```text
Agent UI
  -> AgentRuntimeBroker
     -> CliRuntimeAdapter | ApiRuntimeAdapter
  -> AgentRunEvent
  -> Canvas Tool Gateway
  -> tool_ops
  -> SceneDocument
```

`Infinite-Canvas` 只用于理解 CLI 探测、非交互执行、Provider 分类等产品行为。其许可证明确禁止未经授权的商业封装，并要求衍生软件开源和署名；因此本 ADR 不复制其实现文件或代码，仅记录可独立实现的行为需求。

## Audit findings

### 1. 当前 zhihui Agent 完整调用链

#### 1.1 主画布 Design Agent（当前 Agent Dock 的真实主链路）

1. `apps/web/src/components/editor/panels/agent/AgentDock.tsx`
   - 接收用户输入和附件。
   - 读取当前 `SceneDocument`，生成轻量 `scene_nodes`、`scene_frames`、空间摘要、焦点画板、短/中期记忆和当前 revision。
   - 读取选中模型及 `fast/standard/reasoning/vision/image` 路由偏好。
   - 通过 `agentSendPath.ts` 区分直接媒体生成与 Design Agent；设计任务进入 `runDesignAgent.ts`。
2. `apps/web/src/components/editor/panels/agent/runDesignAgent.ts`
   - 通过 `apps/web/src/service/design.ts` 调用 `POST /api/v1/design/run`。
   - 消费 SSE，处理状态、token、thinking、`tool_ops`、事务、scene feedback、暂停/恢复/取消和断线重放。
   - 维护 mutation lock、`op_id` 去重、base/current revision、单事务历史组和回滚。
3. `apps/api/app/api/routes/design.py`
   - 创建 `design_task` 与 worker snapshot。
   - 本地模式调用 `run_design_job_from_snapshot`；worker 模式派发后台任务，但对前端保持同一 SSE 契约。
4. `apps/api/app/services/design/runtime/orchestrator.py`
   - 检查权限/额度，合并 Admin 规则和用户 route overrides。
   - 用 request-scoped user context 解析 BYOK。
   - 启动 `canvas_ops_v1` LangGraph。
5. `apps/api/app/services/design/runtime/graph/`
   - 固定主拓扑为 `intent -> decide -> paint -> apply -> observe -> review -> settle`。
   - `models_route.py` 做 intent/lane/model 选择；`llm_step.py` 与 `services/llm/agent.py` 构建模型调用。
   - `paint.py` 取得结构化 `tool_ops`；设计 pipeline 和 `services/design/ops/tool_ops_contract.py` 做 allowlist、schema、治理和归一化。
   - `apply.py` 不直接写浏览器画布，而是发出 `transaction.begin/chunk/commit` 和 `scene_feedback_request`。
6. 前端收到 `transaction.chunk` 或 `tool_ops`
   - `runDesignAgent.ts` 的 `applyAgentToolOps` 做 revision gate、可重放 rebase、去重和事务控制。
   - 调用 `apps/web/src/components/editor/panels/agent/designTools.ts` 的 `executeDesignToolAsync`。
   - 每个工具最终通过 RCB/Redux 场景写入口更新 `editor.document`，即唯一的 `SceneDocument` 事实层；历史记录进入 `editorHistory`。
7. 前端应用完成后
   - 向 `POST /api/v1/design/run/{task_id}/scene` 回传真实节点/画板/空间摘要、每个 op receipt、transaction ACK 和 revision。
   - 后端 `observe/review` 基于真实画布继续下一轮，或 `settle` 完成。

因此当前不是“后端直接改画布”，而是后端提出受约束事务、前端 host 执行并反馈真实结果。

#### 1.2 独立 Chat Agent 链路

`POST /api/v1/chat/agent` 是另一条通用 Agent 链：

- `mode=turn`：单轮 `bind_tools`，画布工具以 client tool call 形式返回。
- `mode=react`：LangChain `create_agent` 在服务端执行 image tool，并在 MCP 开启时执行 `canvas_get_scene_summary` / `canvas_apply_tool_ops`。

它不是 Agent Dock 当前 Design Agent 的控制平面，不能直接当作未来 `ApiRuntimeAdapter`。API Adapter 应包装 `/design/run`，保留其事务、反馈、恢复、额度和 review 语义。

#### 1.3 当前 MCP 到画布链路

```text
外部 MCP client
  -> scripts/mcp/recombyn_canvas_stdio.mjs
  -> /api/v1/mcp/canvas/call
  -> services/mcp/dispatch.py
  -> canonical tool_ops validation + project ACL
  -> live project: Redis pending batch
     -> McpCanvasBridge.tsx polls
     -> applyAgentToolOps -> designTools -> SceneDocument
  -> headless project: supported ops -> document patch -> stored project revision
```

MCP 已复用 canonical `tool_ops` 校验，这是 CLI 应使用的入口；不应为 Codex/Gemini 再定义一套 canvas function schema。

### 2. 当前 API/BYOK 完成度

#### 已实现

- 已认证用户的 BYOK Provider 服务端加密存储；列表接口只返回 hint，不返回明文 key。
- `custom:<providerId>` / `byok:<providerId>` 模型引用与 request-scoped user 解析。
- OpenAI-compatible 文本/视觉模型调用。
- 自定义 OpenAI-style image endpoint 调用。
- 平台级 BYOK，可用用户 OpenRouter/Volcengine 等 key 解锁平台目录模型。
- text/image/video/audio 平台目录和 Agent lane 路由。
- 临时凭据或已保存 Provider 的 `discover-models`。
- `openai`、`gemini`、`volcengine`、`runninghub` 发现端点识别，以及 text/image/video/audio 轻量分类。
- 上游 URL 必须为 public HTTP(S)，限制 localhost/私网 SSRF；不跟随 redirect，并限制响应体大小和超时。
- Agent、chat 和 image 路径在 BYOK 时跳过平台额度计费。

#### 部分实现

- 模型分类以名称/元数据启发式为主，未做分页、模型能力验证或生成端点探测。
- `protocol` 只用于发现请求，没有持久化到 Provider；保存后文本/图片执行仍按 OpenAI-compatible transport 处理。原生 Gemini、RunningHub、Volcengine 发现成功不代表同一 custom row 可直接执行。
- 自定义 BYOK text/vision/image 有执行路径；自定义 video/audio 尚未形成对称的通用 Provider 执行路径。audio 也尚不能从当前 `CustomModelKind` 完整保存。
- 平台 BYOK video/audio 主要依赖既有 OpenRouter/平台 transport，不等价于任意 Base URL 的 video/audio BYOK。
- 未登录时前端把 ciphertext 放入 localStorage，但 AES key 只在 sessionStorage；浏览器会话结束后不可恢复。同时该明文凭据没有进入后端 `get_llm_endpoint` 的安全调用链，因此“本地 fallback Provider”不能视为完成的运行时能力。
- 模型可选性和实际 transport capability 没有统一 capability object，UI 可能展示“已发现但不可执行”的模型。

#### 尚未实现

- `AgentRuntimeMode`、Runtime Broker、CLI Adapter、AUTO 选择和 runtime health/capability 状态。
- CLI 安装/版本/认证可用性探测，以及 CLI 运行/取消/进程树清理。
- API 与 CLI 的统一 `AgentRunEvent`。
- 运行级、项目级 MCP capability grant。
- Gemini/其他 CLI 的稳定 session-scoped MCP 注入策略。
- 任意 custom Provider 的协议持久化、分页 discovery、真实 capability probing。

### 3. 当前 Desktop/Tauri 能力

当前 Tauri **不能安全启动本地 Agent CLI**：

- `apps/web/src-tauri/src/lib.rs` 只注册 opener、dialog、fs、log；没有 Rust commands、process supervisor 或 shell/process plugin。
- `Cargo.toml` 没有 CLI process runtime 依赖。
- `capabilities/default.json` 没有执行进程权限，但已有较宽的 `$HOME/**` 写权限；CLI Runtime 不应通过扩张前端 shell 权限实现。
- `scripts/ensure-desktop-api.mjs` 只是在开发启动时以固定参数拉起 uvicorn，不是可复用的安全 CLI broker；它只 kill 直接 child，没有 Windows Job Object / Unix process group 清理。
- Web 浏览器模式没有可信的本地进程边界，必须禁用 `cli`，`auto` 直接选 `api`。

结论：CLI 必须由 Tauri Rust command 层持有，前端只能提交结构化请求，不能提交命令行字符串。

### 4. Infinite-Canvas 参考结论

可借鉴的行为：

- 把 CLI 作为一种 Provider/Runtime 选择展示。
- 用 PATH/配置路径和 `--version` 做 installed probe。
- 登录状态无法从 version 可靠判断，应保持 `unknown`，在最小非交互 preflight 或首次执行时转成 `ready/auth_required`。
- Codex 非交互 prompt 使用 stdin，stdout/JSON 解析为事件；CLI 有显式 timeout。
- API Provider 可读取上游模型并做 image/chat/video 分类。

不可复制或应明确拒绝的行为：

- 读取 `.codex/auth.json`、提取 access token/API key，违反本产品认证隔离目标。
- 把 `--dangerously-skip-permissions`、`--approval-mode yolo` 等作为默认执行方式。
- 任意配置的 executable 直接执行，或把用户输入拼成 shell command。
- 只 kill 直接 child、没有进程树治理。
- 把 CLI 默认模型硬编码后冒充真实的模型 discovery。
- 参考仓库许可证与本项目商业/开源边界未确认，禁止复制实现文件。

## Decision

### 5. Runtime 接入点

#### AgentRuntimeBroker

放在 Web 编辑器的 Agent domain，而不是 FastAPI：

`apps/web/src/components/editor/panels/agent/runtime/AgentRuntimeBroker.ts`

理由：

- Broker 同时看到用户偏好、Tauri availability、当前 project/session 和现有前端事务 host。
- API Runtime 是 HTTP/SSE；CLI Runtime 是 Tauri IPC。两者的共同边界在 Web/Tauri，而不是远端 API 进程。
- 浏览器构建可以 tree-safe 地只注册 API Adapter。

Broker 负责：

1. 校验 `AgentRunRequest`。
2. 根据 `AgentRuntimePreference` 和 task capability 选择 adapter。
3. AUTO 仅在 run 尚未产生 canvas mutation 前回退。
4. 合并 adapter stdout 事件和 MCP canvas 事件，按 `runId/seq` 输出 `AgentRunEvent`。
5. 保证一个 project 同时只有一个 mutating Agent run；只读/chat run 可另行并发。
6. 转发 cancel/pause/resume；记录 requested mode 与 resolved runtime。

#### ApiRuntimeAdapter

放在：

`apps/web/src/components/editor/panels/agent/runtime/ApiRuntimeAdapter.ts`

它包装现有 `runDesignAgent.ts` / `service/design.ts`，不重写 LangGraph、BYOK、模型路由、额度、SSE reconnect 或 scene feedback。Phase 1 允许先把现有 `DesignJobEvent` 无损映射成 `AgentRunEvent`；之后再逐步把 UI side effects 从 `runDesignAgent.ts` 移到 Gateway。

#### CliRuntimeAdapter

Web 侧放在：

`apps/web/src/components/editor/panels/agent/runtime/CliRuntimeAdapter.ts`

Rust 侧放在：

`apps/web/src-tauri/src/agent_runtime/`

Web Adapter 只调用固定 Tauri commands，并将 Tauri event 转成 `AgentRunEvent`。Rust 层负责 descriptor allowlist、可执行文件解析、环境清理、argv 构造、stdin/stdout、timeout、取消和进程树回收。

#### Canvas Tool Gateway

放在：

`apps/web/src/components/editor/panels/agent/runtime/CanvasToolGateway.ts`

它封装并最终收敛现有 `applyAgentToolOps` 能力：

- schema/allowed-key 检查；
- `runId/transactionId/op_id` 去重；
- base revision gate 和允许的 rebase；
- project mutation lock；
- 调用现有 `designTools.executeDesignToolAsync`；
- 单 transaction 历史组、rollback、receipt、Scene feedback；
- 只允许作用于 Broker 绑定的当前 project。

`runDesignAgent.ts` 和 `McpCanvasBridge.tsx` 都改为调用 Gateway。Gateway 不是新协议，只是现有 host 执行逻辑的唯一入口。

### 6. 统一数据结构

以下是语言中立契约的 TypeScript 形态。实现时 Rust `serde` 类型与 TS 类型必须用 contract fixtures 做双向兼容测试。

```ts
export type AgentRuntimeMode = 'auto' | 'cli' | 'api';

export interface AgentRuntimePreference {
  mode: AgentRuntimeMode;
  preferredCliId?: string;       // e.g. codex, gemini
  cliModel?: string;             // optional CLI-specific override
  apiModelRef?: string;          // existing catalog/custom:* reference
  autoFallback: 'api' | 'none';
  updatedAt: number;
}

export interface CliAgentCapabilities {
  nonInteractive: boolean;
  streamingEvents: boolean;
  mcpStdio: boolean;
  mcpHttp: boolean;
  text: boolean;
  imageInput: boolean;
  imageGeneration: boolean;
  sessionResume: boolean;
  cancellation: boolean;
  sandboxModes: Array<'read-only' | 'workspace-write'>;
}

export interface CliAgentDescriptor {
  id: 'codex' | 'gemini' | string;
  displayName: string;
  executableNames: string[];
  resolvedExecutable?: string;   // returned by Rust; never accepted blindly from UI
  version?: string;
  installState: 'unknown' | 'missing' | 'installed';
  authState: 'unknown' | 'ready' | 'required' | 'error';
  health: 'unknown' | 'ready' | 'degraded' | 'unavailable';
  capabilities: CliAgentCapabilities;
  diagnosticCode?: string;       // redacted stable code, not raw credential output
}

export interface AgentRunRequest {
  runId: string;
  projectId: string;
  sessionId?: string;
  requestedRuntime: AgentRuntimeMode;
  prompt: string;
  locale: string;
  interactionMode: 'agent' | 'ask';
  baseRevision: number;
  sceneContext: {
    nodes: unknown[];
    frames: unknown[];
    spatialSummary?: unknown;
    focusFrameId?: string;
  };
  attachments: Array<{
    id: string;
    kind: 'image' | 'video' | 'audio' | 'file';
    safeHandle: string;           // resolved/copy-scoped by host; never arbitrary CLI arg
  }>;
  selection: {
    apiModelRef?: string;
    cliId?: string;
    cliModel?: string;
    routeOverrides?: Record<string, string>;
  };
  deadlineMs: number;
}

export type AgentRunEvent =
  | { type: 'run.started'; runId: string; seq: number; runtime: 'cli' | 'api' }
  | { type: 'runtime.resolved'; runId: string; seq: number; requested: AgentRuntimeMode; resolved: 'cli' | 'api'; reason: string }
  | { type: 'status'; runId: string; seq: number; phase: string; message?: string }
  | { type: 'thinking.delta' | 'message.delta'; runId: string; seq: number; text: string }
  | { type: 'tool.requested' | 'tool.result'; runId: string; seq: number; toolCallId: string; name: string; payload: unknown }
  | { type: 'canvas.transaction.begin'; runId: string; seq: number; transactionId: string; baseRevision: number }
  | { type: 'canvas.ops.requested'; runId: string; seq: number; transactionId: string; ops: unknown[] }
  | { type: 'canvas.transaction.commit' | 'canvas.transaction.rollback'; runId: string; seq: number; transactionId: string; reason?: string }
  | { type: 'canvas.feedback.requested'; runId: string; seq: number; transactionId?: string }
  | { type: 'artifact'; runId: string; seq: number; artifact: unknown }
  | { type: 'auth.required' | 'warning'; runId: string; seq: number; code: string; message: string }
  | { type: 'completed' | 'cancelled'; runId: string; seq: number; summary?: string }
  | { type: 'failed'; runId: string; seq: number; code: string; message: string; retryable: boolean };
```

契约中禁止出现 OAuth token、Cookie、CLI auth file path/content、API key 或完整 inherited environment。

### 7. MCP 复用：Codex CLI 修改当前 project

推荐链路：

1. Agent UI 启动 run，Broker 绑定 `userId + projectId + runId + baseRevision`。
2. Web 调用新增的 MCP grant endpoint，取得短时、随机、受众为 `mcp-canvas` 的 capability grant。grant 只允许当前 project 和明确 tool allowlist，不能调用其他 API。
3. Tauri 启动 Codex 时不写用户全局 `~/.codex/config.toml`，也不执行 `codex mcp add`。使用本次运行的配置覆盖，把现有 `scripts/mcp/recombyn_canvas_stdio.mjs` 作为 STDIO MCP server，并通过环境变量传递短时 grant、projectId、runId。
4. Codex 使用非交互 JSONL；prompt 走 stdin，命令固定为 descriptor 生成的 argv。文件 sandbox 为 `read-only`，不使用 `--yolo`。画布写权限只来自受限 MCP tool。
5. STDIO bridge 调用现有 MCP REST dispatch。dispatch 继续执行 project ACL 和 canonical `tool_ops` 校验。
6. 当前 project 有 live heartbeat 时，MCP batch 进入 pending queue；batch 增加 `runId/transactionId/baseRevision` 元数据。
7. Web 将 pending batch 转成 `canvas.ops.requested`，交给统一 Gateway；成功后 ACK batch，并把 receipts/revision 反馈给 Agent run。
8. 没有 live host 时，CLI 画布编辑默认失败为 `live_canvas_required`；Phase 1 不静默切换到 headless subset，避免用户以为已修改当前可见画布。

OpenAI 官方文档确认 Codex 支持 STDIO MCP、环境变量、tool allowlist/approval policy、`codex exec --json` JSONL、stdin prompt、`--ephemeral` 和 read-only/workspace-write sandbox。实现时仍需按已安装 CLI 版本做 capability probe，不能假设所有版本参数一致。

Gemini CLI 使用同一 MCP server 和 Gateway，但 adapter 参数、stream-json schema、session-scoped settings 必须独立实现并版本探测。不能沿用参考项目的 Antigravity/`agy` 参数冒充官方 Gemini CLI。

### 8. AUTO 选择规则

AUTO 是确定性选择，不是运行中任意重试：

1. 非 Tauri/Web：API。
2. Tauri 中检查 preferred CLI；若未指定，按受支持 descriptor 顺序检查。
3. 必须同时满足 installed、version compatible、non-interactive preflight ready、所需 capability、MCP server ready。
4. 不满足时，在任何 canvas mutation 之前回退 API，并产生 `runtime.resolved` reason。
5. CLI 已产生 tool call/画布 mutation 后崩溃，不自动重放到 API；返回 resumable failure，让用户明确选择继续，避免重复改画布和重复计费。
6. 用户显式选择 `cli` 时默认不回退 API；返回 missing/auth_required/crash 的可操作错误。

## Security threat model

| 威胁 | 控制措施 | 验收条件 |
|---|---|---|
| command injection | Rust 使用固定 descriptor + argv array；prompt 只走 stdin；禁止 shell/cmd.exe/powershell `-Command` 拼接 | 特殊字符、换行、引号不能改变 executable/argv |
| arbitrary executable | Phase 1 只允许内置 `codex` descriptor；PATH 结果 canonicalize；UI 不提交路径或命令 | 任意路径/相对路径/UNC 注入被拒绝 |
| secret leakage | child `env_clear` 后只恢复 PATH、home/profile、locale/temp 和运行级 MCP grant；日志/事件 redact 且限长 | API keys、web bearer、OAuth、Cookie 不出现在 argv、log、event、crash report |
| OAuth leakage | zhihui 不读 `.codex/auth.json`、Gemini credential store 或浏览器 Cookie；CLI 自己在用户 profile 中取认证 | 代码中无 auth-file parser；无 token upload endpoint |
| localhost abuse | 优先 STDIO；如需 HTTP，仅绑定随机 `127.0.0.1` 端口、不可猜 nonce、严格 Host/Origin、短 TTL | LAN/网页 origin 无法调用 run control/MCP grant |
| CORS | API 保持显式 localhost/Tauri origin；MCP grant 不使用 wildcard；修复客户端 `/api/v1` 前缀 | 未授权 origin 的 preflight/credentialed request 被拒绝 |
| process timeout | descriptor 有 startup/idle/deadline 三层 timeout；输出 backpressure 与大小上限 | CLI hang 会进入 timeout event 并开始清理 |
| process tree cleanup | Windows 使用 Job Object kill-on-close；macOS/Unix 使用独立 process group，TERM 后 KILL；应用退出时清理 registry | CLI 派生 child 不残留 |
| MCP authorization | 短时 grant 绑定 user/project/run/tools/audience；服务端 project ACL、op allowlist、revision gate；grant 可撤销 | grant 不能访问其他 project/API，过期/重放失败 |
| project isolation | CLI cwd 为 app-private run dir；附件复制/映射为只读 safe handle；画布 project 只由 grant 绑定 | CLI 不获得整个磁盘或其他项目写权限 |
| duplicate/conflict | 单 project mutation lease；`op_id`/transaction 去重；baseRevision + rebase/reject；ACK receipts | SSE/MCP 重连不重复执行，协作冲突可见且可恢复 |

额外约束：

- 当前 Tauri 的 `$HOME/**` 写 scope 应缩小；CLI auth 访问由 Rust process 自身完成，不需要给 WebView fs 权限。
- 不把完整 web bearer token 放入 `RECOMBYN_TOKEN` 传给 CLI。现有 stdio bridge 的 token 模式仅保留给手工外部集成；嵌入式 CLI 必须使用 run-scoped grant。
- capability grant 只存 hash/metadata，不能作为长期凭据落盘。

## File-level implementation plan

### 新增

#### Web

- `apps/web/src/components/editor/panels/agent/runtime/contracts.ts`
- `apps/web/src/components/editor/panels/agent/runtime/AgentRuntimeBroker.ts`
- `apps/web/src/components/editor/panels/agent/runtime/ApiRuntimeAdapter.ts`
- `apps/web/src/components/editor/panels/agent/runtime/CliRuntimeAdapter.ts`
- `apps/web/src/components/editor/panels/agent/runtime/CanvasToolGateway.ts`
- `apps/web/src/components/editor/panels/agent/runtime/runtimePreference.ts`
- 对应 `*.test.ts` / `*.test.tsx`
- `apps/web/src/service/agentRuntime.ts`（Tauri IPC、CLI status/run/cancel、MCP grant API 的 typed client）

#### Tauri

- `apps/web/src-tauri/src/agent_runtime/mod.rs`
- `apps/web/src-tauri/src/agent_runtime/contracts.rs`
- `apps/web/src-tauri/src/agent_runtime/descriptors.rs`
- `apps/web/src-tauri/src/agent_runtime/process.rs`
- `apps/web/src-tauri/src/agent_runtime/redaction.rs`
- `apps/web/src-tauri/src/agent_runtime/platform/windows.rs`
- `apps/web/src-tauri/src/agent_runtime/platform/unix.rs`
- Rust unit/integration tests for argv, env, timeout, cancellation and cleanup

#### API/MCP

- `apps/api/app/services/mcp/run_grant.py`
- `apps/api/tests/unit_tests/test_mcp_run_grant.py`
- contract/queue tests for run metadata and replay protection

### 修改

- `AgentDock.tsx`：读取 runtime preference，通过 Broker 发送/取消/恢复。
- `AgentModelsPanel.tsx`、`AgentRoutePrefsEditor.tsx`：加入 Runtime 模式和 CLI health/capability 展示；API 模型选择继续复用现有目录。
- `runDesignAgent.ts`、`designAgentEventRouter.ts`：API event 归一化并把 canvas side effect 委托给 Gateway。
- `McpCanvasBridge.tsx`：pending batch 转成 `AgentRunEvent` 并调用 Gateway；修正 stale document getter。
- `apps/web/src/service/mcpCanvas.ts`：修复 `/api/v1/mcp/canvas` 前缀并增加 run metadata/grant client。
- `apps/web/src-tauri/src/lib.rs`：只注册窄范围 agent runtime commands，不引入通用 shell command。
- `apps/web/src-tauri/Cargo.toml`：增加受控 async process/平台 cleanup 所需依赖。
- `apps/web/src-tauri/capabilities/default.json`：增加 invoke command 权限并缩小 WebView fs scope；不增加通用 shell 权限。
- `apps/api/app/api/routes/mcp.py`：增加 grant mint/revoke/validate，保持现有 tool endpoints。
- `apps/api/app/services/mcp/push/channel.py`：pending batch 带 run/transaction/revision 元数据。
- `scripts/mcp/recombyn_canvas_stdio.mjs`：支持 run-scoped grant 与 run metadata；保留标准 MCP JSON-RPC。
- `docs/agent-harness.md`、`docs/mcp-canvas.md`、`docs/desktop.md`：在 Phase 1 完成后更新运行和安全说明。
- 中英文 i18n 资源：Runtime 模式、CLI 状态和错误文案。

### Phase 1 不应修改

- `SceneDocument` schema、RCB camera/render/hit 架构。
- `designTools.ts` 中现有 canvas op 语义。
- `services/design/ops/tool_ops_contract.py` 的 canonical 协议；只可复用，不可复制分叉。
- `canvas_ops_v1` LangGraph 拓扑和现有 API/BYOK 计费逻辑。
- Provider discovery/Custom Provider transport（除非独立缺陷修复另开 ADR/任务）。
- 用户 CLI 的 OAuth 文件、Cookie、全局 MCP 配置或全局 CLI settings。
- Infinite-Canvas 的任何实现文件。

## Known issues that gate CLI rollout

1. `apps/web/src/service/mcpCanvas.ts` 当前构造 `${base}/mcp/canvas`，而 API 实际挂在 `/api/v1/mcp/canvas`，Vite 也只代理 `/api`。在常规 base URL 语义下 live bridge 会请求错误路径。Phase 1 必须先用测试固定正确前缀。
2. `McpCanvasBridge.tsx` 的 document getter 捕获 React render closure；多 batch/多 op 时应从 store 读取最新 document，避免 stale scene。
3. 本地未登录 BYOK fallback 的加密 key 生命周期和服务端可执行性不闭环；CLI Runtime 不应依赖该 fallback。
4. MCP headless apply 只支持 tool_ops 子集；当前可见画布必须优先 live gateway，并对 live 缺失显式报错。

## Test matrix

| 场景 | Web/browser | Tauri Windows | Tauri macOS | 关键断言 |
|---|---:|---:|---:|---|
| API Runtime 正常 | ✓ | ✓ | ✓ | 仍走 `/design/run`，事件顺序、事务、scene feedback 不回归 |
| Web 选择 CLI | ✓ | — | — | 显示 desktop_required；AUTO 选 API |
| CLI installed + ready | — | Codex/Gemini | Codex/Gemini | descriptor/version/preflight/capability 正确 |
| CLI missing | — | ✓ | ✓ | 显式 CLI 报 missing；AUTO 在 mutation 前回退 API |
| CLI login required | — | ✓ | ✓ | 不读取凭据；发 `auth.required`；不给出 token 内容 |
| CLI crash/non-zero | — | ✓ | ✓ | redacted failure；产生 mutation 后不自动 API 重放 |
| CLI hang/timeout | — | ✓ | ✓ | deadline event；完整 process tree 被清理 |
| CLI stdout malformed/oversize | — | ✓ | ✓ | parser 隔离、限长、不会阻塞/崩溃 WebView |
| API invalid key | ✓ | ✓ | ✓ | BYOK 错误可识别，不泄露 key，不误回退 CLI |
| API invalid URL/private URL | ✓ | ✓ | ✓ | public URL/SSRF 校验，错误稳定 |
| API discovery OpenAI | ✓ | ✓ | ✓ | text/image/video/audio 分类、无持久化临时 key |
| API discovery Gemini/Volcengine/RunningHub | ✓ | ✓ | ✓ | protocol URL/header 正确；不宣称不可执行模型已可执行 |
| Agent cancel before tool | ✓ | ✓ | ✓ | adapter cancel、run terminal event、无 canvas mutation |
| Agent cancel during tool | ✓ | ✓ | ✓ | transaction rollback/明确 partial receipt；进程树清理 |
| MCP grant wrong project/tool | — | ✓ | ✓ | 403/denied；无 pending batch |
| MCP grant expired/replayed | — | ✓ | ✓ | 被拒绝，日志不含 grant |
| Canvas live host missing | — | ✓ | ✓ | Phase 1 报 live_canvas_required，不静默 headless |
| Canvas revision conflict | ✓ | ✓ | ✓ | 可 rebase op 重放；不可 rebase op 拒绝并反馈 Agent |
| Canvas duplicate/reconnect | ✓ | ✓ | ✓ | `op_id`/transaction/batch 只执行一次 |
| Collab concurrent edit | ✓ | ✓ | ✓ | project mutation lease + revision conflict，不覆盖用户新修改 |
| App exit/restart | — | ✓ | ✓ | run registry cleanup；无 orphan child；可识别 interrupted run |
| Secret scan | ✓ | ✓ | ✓ | argv/env snapshots/log/event/crash dump 无 OAuth/API key/web token |

测试层次：

- Web unit：Broker resolution、AUTO、event ordering/dedupe、Gateway revision/rollback。
- Web integration：mock API SSE + mock Tauri events + MCP pending queue。
- API unit/integration：grant scope/TTL/revoke、project ACL、pending metadata、wrong prefix regression。
- Rust unit：descriptor/argv/env/redaction/parser。
- Rust platform integration：Windows Job Object、macOS process group、timeout/cancel/app-exit。
- E2E：真实 Codex/Gemini 使用测试账号和临时 project；CI 默认只跑 fake CLI executable，不依赖个人登录。

## Phase 1 implementation scope

Phase 1 只交付基础架构和一个安全的 Codex Desktop 垂直切片：

1. 定义并测试 contracts、Broker、API Adapter，保持默认模式为 `api`，确保现有功能零回归。
2. 抽取统一 Canvas Tool Gateway，让 API SSE 和 MCP pending batch 共用执行入口。
3. 修复 MCP URL/stale document 两个 rollout blocker。
4. 实现 MCP run-scoped grant、run metadata、live-only Phase 1 策略。
5. 实现 Tauri descriptor/status/run/cancel/process-tree supervisor；Phase 1 只允许内置 Codex executable。
6. 实现 Codex `--json --ephemeral` 事件解析、stdin prompt、read-only file sandbox 和现有 canvas MCP 接入。
7. UI 加入 `API / CLI / AUTO`，显示 Codex installed/auth/health；Web 中 CLI 明确不可用。
8. 完成 Windows 与 macOS 的 fake CLI 自动化矩阵，并各做一次真实 Codex 手工验收。

Phase 1 不包含：Gemini 正式执行、Claude Code、任意 executable、自定义 CLI 安装器、读取 CLI 凭据、Custom Provider transport 重构、CLI 生图专用 helper、后台无 UI 画布编辑。Gemini Adapter 在 Phase 1 只保留 contract/descriptor 设计，待 Codex 垂直切片和 MCP/Gateway 稳定后进入 Phase 2。

## Consequences

### Positive

- API/BYOK 完整保留，Runtime 抽象不会复制 Provider 能力。
- CLI 和 API 共享事件、Gateway、tool_ops、SceneDocument、history/revision 语义。
- CLI 认证仍由 CLI 自己管理，zhihui 不成为 OAuth/token custodian。
- Web 构建行为明确，Desktop 才拥有本地进程能力。
- 后续新增 CLI 主要是 descriptor + parser + capability probe，不触碰画布协议。

### Negative / trade-offs

- API SSE 与 CLI stdout/MCP 是双事件源，需要 runId/seq/transaction 对齐。
- CLI 版本和 JSON schema 会变化，必须长期维护 capability probe 和兼容测试。
- CLI “已安装”不等于“已登录”，AUTO 首次 preflight 可能增加少量延迟。
- 安全 process supervisor、跨平台 cleanup 和 run-scoped MCP grant 是不可省略的工程成本。
- Phase 1 先支持 Codex，Gemini 不与其并行冒险上线。

## Rejected alternatives

1. **在 FastAPI 服务器直接 spawn 用户 CLI**：远端部署无法访问用户电脑，也混淆服务端/桌面信任边界。
2. **给 Tauri WebView 通用 shell 权限**：扩大 command injection 和任意 executable 攻击面。
3. **CLI 输出一份新的 canvas JSON 协议**：会分叉 tool_ops、history、revision 和 MCP，违反唯一事实层。
4. **让 CLI 直接修改 Redux/SceneDocument 文件**：绕过 Gateway 和实时 host，无法安全处理冲突/历史。
5. **把用户 web bearer token 传给 CLI**：权限过大且增加泄露面。
6. **AUTO 在 CLI 中途失败后自动重跑 API**：可能重复 canvas mutation、媒体费用和 Agent 副作用。
7. **复制 Infinite-Canvas CLI 实现**：授权未兼容，且其中读取 auth file/危险 flag/进程治理不满足本产品要求。

## References

- [Agent harness](../agent-harness.md)
- [MCP Canvas](../mcp-canvas.md)
- [Canvas architecture](../canvas-architecture.md)
- [Scene JSON specification](../scene-json-spec.md)
- [Desktop development](../desktop.md)
- [Infinite-Canvas reference repository](https://github.com/KevinYoungsir/Infinite-Canvas)
- [Official OpenAI Codex MCP documentation](https://developers.openai.com/codex/mcp/)
- [Official OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference/)
- [Official Gemini CLI repository](https://github.com/google-gemini/gemini-cli)
