# Node.js Agent 全流程详细讲解

本文是 `node-impl/` 的中文概念手册和源码导航。它回答三个问题：一次请求每一步做什么、为什么这样设计、相关 Agent 术语之间是什么关系。

> 推荐方式：先启动 `node-impl` 和 `agent-flow-demo`，在浏览器逐步执行；每走一步，再回到本文和对应源码。不要一开始接真实 LLM、Redis 和 Jaeger，否则很难区分业务逻辑与外部依赖问题。

## 1. 先区分六个容易混淆的概念

### 1.1 LLM、Agent 与多 Agent

- **LLM（Large Language Model）**：接受消息并生成文本或结构化数据的模型。本项目通过 `ChatOpenAI` 调用它。
- **Agent**：围绕明确目标组织起来的组件，通常包含角色、输入、Prompt、模型、工具、记忆、规则和输出契约。LLM 只是 Agent 可选的一项能力。
- **多 Agent 系统**：把意图识别、知识问答、工单和合规拆成多个专业角色，再通过统一编排协作。

本项目没有 API Key 时仍能运行，说明“Agent 不等于 LLM”：IntentRouter 使用关键词，KnowledgeRAG 使用本地检索，TicketHandler 使用规则，Compliance 使用正则。

### 1.2 Workflow 与自主 Agent

本项目主要是确定性 **Agent Workflow**：节点和边预先定义，模型只参与部分节点的判断与生成。它不是让模型无限自主规划。

固定图的优点是流程可审计、合规出口不可绕过、测试容易、成本上限更明确。缺点是面对新任务时灵活性低，需要开发者添加节点和边。

### 1.3 Supervisor 与专业 Agent

**Supervisor Pattern** 类似“调度中心 + 专业部门”：

1. IntentRouter 给请求分类。
2. Supervisor 根据分类选择一个业务 Agent。
3. 业务 Agent 只负责自己的领域。
4. 所有分支回到 Compliance。
5. Supervisor 合成最终响应。

Supervisor 不应该承担全部业务，否则会退化成一个难维护的“大 Agent”。专业 Agent 也不直接写 HTTP 响应，否则会绕过统一合规和响应契约。

### 1.4 State、消息历史、工作记忆与 Checkpoint

| 名称 | 保存内容 | 当前实现 | 生命周期 | 主要消费者 |
| --- | --- | --- | --- | --- |
| Agent State | 一次图运行中的全部共享字段 | LangGraph `StateSchema` | 单次运行，并进入 Checkpoint | 所有图节点 |
| `messages` | 图内标准 Human/AI 消息 | `MessagesValue` reducer | 随 Checkpoint 保存 | LangGraph/LLM |
| Short-term Memory | 面向产品的最近对话记录 | Redis List 或 Map | TTL 30 分钟 | HTTP 历史接口 |
| Working Memory | 最近路由等轻量上下文 | Map | 当前进程 | Supervisor |
| Long-term Memory | 可检索知识文档与向量 | 内存数组 | 当前进程 | KnowledgeRAG |
| Checkpoint | 每个图节点后的完整 State 快照 | `MemorySaver` | 当前进程 | 调试、恢复、HITL |

最关键的区别：`GET /api/history/:sessionId` 读取短期对话历史；`getStateHistory(sessionId)` 读取 LangGraph Checkpoint。前者服务多轮聊天，后者服务图状态恢复和调试。

### 1.5 MCP 与函数调用

**MCP（Model Context Protocol）** 统一描述工具发现和调用。本项目的工具具有名称、说明、JSON Schema、分类和 handler，并通过 JSON-RPC 2.0 暴露。

MCP 不负责任务编排。它解决的是“能力如何被发现和调用”，LangGraph 解决的是“节点按什么流程运行”，Agent 解决的是“为了完成职责何时使用能力”。当前 Agent 流程和 MCP 服务共享工单底层能力，但尚未实现由模型自主挑选 MCP 工具。

### 1.6 Trace、Span 与指标

- **Trace**：一条请求的完整调用链。
- **Span**：链路中的一个有开始、结束、耗时和状态的操作。
- **Metric**：跨多次请求聚合的调用次数、平均耗时和错误率。
- **OpenTelemetry**：生成和导出这些观测数据的开放标准。

`trace()` 包装 Agent 方法：成功时标记 OK，失败时记录异常并继续抛出，最后一定结束 Span 并累计本地指标。观测代码不能吞掉业务异常。

## 2. 应用启动阶段逐步执行

入口是 `node-impl/src/main.js`，应用组合根是 `node-impl/src/app.js`。

1. `main.js` 读取 `HOST` 和 `PORT`。
2. `createApplication()` 初始化 OpenTelemetry。
3. 根据 `OPENAI_API_KEY` 创建 ChatModel 和 Embeddings；无 Key 时得到 `null`。
4. 创建 Working、Short-term、Long-term 三类记忆。
5. 向 Long-term Memory 写入三篇演示知识文档。
6. 创建 Ticket、Compliance、IntentRouter、KnowledgeRAG 等专业 Agent。
7. 将 Agent 注入 Supervisor，由 Supervisor 构建并编译 LangGraph。
8. 注册四个 MCP 工具。
9. 把 Supervisor、短期记忆、MCP 服务注入 HTTP Server。
10. 监听 8100 端口。

这里采用 **依赖注入**：组件从构造参数拿依赖，而不是读取不可替换的全局单例。测试因此可以注入 `fakeLlm` 和 `fakeEmbeddings`。

## 3. 一次聊天请求的十五步

以 `POST /api/chat` 为例：

1. Node HTTP Server 收到字节流。
2. `readJson()` 限制请求最大 1 MiB，再解析 JSON。
3. API 校验 `message` 必须为非空字符串。
4. 缺少 `session_id` 时生成 UUID；缺少 `user_id` 时使用 `anonymous`。
5. ShortTermMemory 先保存用户消息。
6. `createState()` 创建独立 State，并把原话包装成 `HumanMessage`。
7. `supervisor.orchestrate()` 用 `session_id` 作为 LangGraph `thread_id` 调用图。
8. `intent_router` 节点识别意图并写入 `intent`。
9. 条件边只选择一个业务节点。
10. 业务节点把字符串结果写入自己的 `sub_results` 命名空间。
11. 三个业务分支都进入 `compliance_check`。
12. Compliance 汇总业务字符串，执行规则审查和可选 LLM 审查。
13. `synthesize` 根据 `compliance_passed` 返回业务内容或安全兜底，并追加 `AIMessage`。
14. 图运行期间，MemorySaver 在节点边界保存 Checkpoint。
15. API 保存助手消息，只选取稳定公开字段返回 JSON 或 SSE。

## 4. State 每一步怎样变化

初始状态：

```js
{
  messages: [HumanMessage("理财产品的投资期限是多久？")],
  user_id: "student",
  session_id: "lesson-1",
  user_message: "理财产品的投资期限是多久？",
  intent: "",
  sub_results: {},
  compliance_passed: true,
  final_response: "",
  current_agent: "",
  retry_count: 0
}
```

路由后新增或更新：

```js
intent = "knowledge_rag"
current_agent = "intent_router"
sub_results.intent_router = { suggested_agent: "knowledge_rag", confidence: 0.6 }
```

知识 Agent 后：

```js
current_agent = "knowledge_rag"
sub_results.knowledge_rag = "根据知识库检索结果……"
```

合规后：

```js
current_agent = "compliance_checker"
compliance_passed = true
sub_results.compliance = { passed: true, risk_level: "low", violations: [] }
```

合成后：

```js
current_agent = "supervisor"
final_response = sub_results.knowledge_rag
messages = [...messages, AIMessage(final_response)]
```

## 5. IntentRouterAgent：意图路由详解

### 输入与输出

- 输入：`state.user_message`
- 输出：`state.intent` 和 `state.sub_results.intent_router`
- 下一步：Supervisor 的条件边

### 有 LLM 时

1. Zod 定义允许的路由枚举和字段。
2. `withStructuredOutput()` 把自由文本生成约束为业务对象。
3. System Prompt 描述三种路由边界。
4. 模型返回 `suggested_agent`、主次意图、置信度和实体。
5. Schema 不合法、网络异常或超时进入规则降级。

**结构化输出** 比“让模型回答一个单词再手工解析”可靠，但不是绝对可靠，所以仍需要捕获异常和业务枚举。

### 无 LLM 时

1. 默认 `knowledge_rag`。
2. 分别统计工单词和安全词的命中数。
3. 分数严格更高时更新候选分支。
4. 没有命中时保持知识咨询。

这里的 `confidence` 是启发式展示值，不是真实概率，也没有经过校准，不能直接用于高风险自动决策。

## 6. SupervisorAgent：图编排详解

### 节点与边

```text
START
  ↓
intent_router
  ├─ knowledge_rag ─┐
  ├─ ticket_handler ├→ compliance_check → synthesize → END
  └─ security_handler ┘
```

- `addNode` 注册可执行节点。
- `addEdge` 声明固定流转。
- `addConditionalEdges` 读取 State 决定分支。
- `compile` 把图定义编译成可调用 Runnable。
- `invoke` 执行一次图。

### Reducer 与增量更新

State 中普通字段通常由新值覆盖；`messages` 使用追加 reducer。业务 Agent 为方便测试会返回完整 State，Supervisor 必须通过 `stateUpdates()` 去掉旧 `messages`，否则消息历史会被重复追加。只有 `synthesize` 明确返回一条新的 `AIMessage`。

### Checkpoint、thread_id 与 Human-in-the-Loop

Checkpointer 在节点边界保存快照，`thread_id` 决定快照属于哪条会话。它为失败恢复、时间旅行调试和 **Human-in-the-Loop（HITL，人在回路）** 提供基础：系统可以在敏感节点暂停，让人工批准后从保存状态继续。

当前使用 `MemorySaver`，只适合单进程学习；生产应换成数据库 Checkpointer，并设计会话权限、过期、加密和并发版本控制。

## 7. KnowledgeRAGAgent：RAG 五阶段详解

### 7.1 Query Rewrite

把口语问题改写成更适合搜索的文本，目的是提高召回率，不是回答问题。无模型时保留原问题。

### 7.2 Retrieve

LongTermMemory 优先计算 Embedding，并按余弦相似度返回 Top-5。Embedding 失败时切换中英文关键词检索。

- **召回率**关注相关材料有没有被找进候选集。
- **精确率**关注找回来的材料中有多少真正相关。
- 初次检索取较大的 Top-K 通常偏向召回率，后续重排再提高精确率。

### 7.3 Rerank

让 LLM 对少量候选做更精细排序，只允许返回候选索引，避免模型篡改文档。去重、越界过滤后保留 Top-3；结果为空则退回原排序。

### 7.4 Generate

把文档内容与来源拼成上下文，要求模型只基于证据回答。无模型时直接格式化检索片段，不创造新事实。

### 7.5 Fallback

正常链路任何一步失败，重新用“原问题 + 本地关键词检索 + 模板生成”执行。降级回答质量可能下降，但服务仍可用且事实仍来自知识库。

## 8. TicketHandlerAgent：工单状态操作详解

Agent 先把自然语言转换为标准命令：

```text
action: create | query | update
ticket_id: 可选工单号
ticket_type: refund | claim | account_open | complaint | general
priority: low | medium | high | urgent
status: created | processing | pending_review | resolved | closed | escalated
```

有模型时通过结构化输出抽取；无模型时通过工单号正则、动作词、类型词和优先级词判断。

- Query：只读 Map 并格式化结果。
- Update：要求同时有工单号和目标状态，修改 `updated_at`。
- Create：生成日期加进程序号的 ID，状态初始化为 `created`。

当前 Map 是演示仓库：重启丢失、多实例不共享、ID 可能冲突、没有事务。生产替换数据库时，应把存储封装为 Repository，而不是把 SQL 写进 Agent Prompt。

## 9. Security Handler 与 ComplianceCheckerAgent

### Security Handler

资金安全请求进入 Supervisor 内的同步节点，生成停止操作、保护凭证、转人工风控的固定指引。它说明不是每个节点都必须调用 LLM；确定性安全策略通常更快、更可审计。

### Compliance 两阶段防线

第一阶段规则检查：

1. 扫描禁止的金融承诺词。
2. 用正则检测手机号、身份证、银行卡和邮箱。
3. 计算 `low/medium/high/critical` 风险级别。
4. 用确定性算法脱敏，保留首尾三位。

第二阶段 LLM 检查：

1. 只在规则通过且存在 LLM 时执行。
2. 检测隐性承诺、越权、缺少风险提示、歧视和侮辱。
3. 用 Zod 约束输出。
4. 模型失败时当前实现保留规则结果。

**Fail-open 与 Fail-closed**：模型故障后放行叫 fail-open，阻断叫 fail-closed。当前深层审查故障偏可用性，最终只要 `compliance_passed=false`，Supervisor 合成则严格 fail-closed。真实金融系统应按风险等级、业务类型和监管要求制定策略，不能只用一种处理方式。

## 10. Memory 三层与检索知识

### WorkingMemory

保存轻量推理上下文和最近 50 次变化。它不是聊天记录，目前主要用于观察最近路由。

### ShortTermMemory

Redis 模式用 `RPUSH` 保持时间顺序、`LTRIM` 保留滑动窗口、`EXPIRE` 刷新 TTL。连接失败后切换 Map；Map 用 `expiresAt` 和访问时懒删除模拟 TTL。

Redis 连接使用共享 Promise，避免并发首请求建立多个连接。失败后不在每次请求重连，是为了避免无 Redis 环境持续产生 500ms 延迟。

### LongTermMemory

文档与向量下标一一对应，首次检索时惰性批量计算缺失向量。余弦相似度衡量向量方向接近程度：

```text
cos(a,b) = (a·b) / (||a|| × ||b||)
```

关键词降级对英文数字按词切分，对连续中文生成二元字组。这是简单教学实现，不具备分词、BM25、混合检索、Metadata Filter 或持久化能力。

## 11. MCP 工具流程

1. `register()` 把工具元数据和 handler 保存进 Map。
2. `listTools()` 移除不可序列化且不应暴露的 handler。
3. `callTool()` 查找工具并校验 required 字段。
4. 执行 handler，统一包装 `{ success, result, error }`。
5. 记录耗时和最近 100 条调用审计。
6. `handleJsonRpc()` 将 `ping/tools/list/tools/call` 映射到内部方法。

当前参数校验只是 JSON Schema 的最小子集。生产应加入类型、范围、枚举、额外字段限制、鉴权、授权、超时、重试、幂等键、熔断和敏感参数脱敏。

## 12. HTTP、REST 与 SSE 的关系

- `/api/chat`：普通 REST 请求，等待完整图结束后返回 JSON。
- `/api/chat/stream`：使用 SSE 信封，但当前仍只发送一个完整 `result` 事件。
- `/api/history/:id`：读取 ShortTermMemory。
- `/api/tools/call`：REST 风格工具调用。
- `/mcp`：JSON-RPC 风格 MCP 调用。
- `/api/metrics`：读取本地指标和工具日志。

真正的逐 Token 流式需要订阅模型或 LangGraph 流事件，在生成过程中多次 `response.write()`，还要处理客户端断开、背压、心跳和取消传播。

## 13. 测试与 Fake Model

`test/application.test.js` 同时包含三种测试层级：

- HTTP 集成测试：真实监听随机端口，验证路由、响应和短期历史。
- Agent 单元测试：直接创建 State 调 TicketHandler。
- 基础组件测试：用 fakeEmbeddings 验证余弦排序。

`fakeLlm` 实现与真实模型相同的最小接口，因此不访问网络也能验证路由、RAG、结构化输出和深层合规是否真正参与链路。这比在测试里调用真实模型更快、更稳定、更便宜。

## 14. 推荐断点顺序

按以下位置逐步调试一条产品咨询：

1. `api/server.js`：读取请求体以后。
2. `agents/state.js`：`createState()` 返回前。
3. `agents/supervisor.js`：`orchestrate()` 调用处。
4. `agents/intent-router.js`：写入 `state.intent` 后。
5. `agents/knowledge-rag.js`：每个 RAG 阶段后。
6. `agents/compliance-checker.js`：`fullCheck()` 返回后。
7. `agents/supervisor.js`：`synthesize()` 入口。
8. `api/server.js`：构造 `payload` 前。

每个断点都检查 `intent`、`sub_results`、`compliance_passed`、`final_response` 和 `messages`。

## 15. 新增 Agent 时的完整检查表

以 `OrderQueryAgent` 为例：

1. 定义清楚它与知识咨询、工单的职责边界。
2. 给 IntentRouter 的 Schema 和本地规则增加新意图。
3. 创建 Agent 类，声明读哪些 State 字段、写哪个 `sub_results` key。
4. 通过构造函数注入工具或 Repository，不直接依赖 HTTP 全局对象。
5. 在 `app.js` 实例化并注入 Supervisor。
6. 在 Supervisor 注册节点和条件边。
7. 让新分支固定汇入 `compliance_check`。
8. 为成功、参数错误、外部服务错误和合规拦截写测试。
9. 用 `trace()` 包装节点并选择不含 PII 的 Span 属性。
10. 更新 API/架构/学习/面试文档。

## 16. 当前实现边界

- `.env` 文件不会被程序自动加载，需要 shell 导出变量或使用其他加载方式。
- `MemorySaver`、工单、工作记忆、知识文档和本地指标都只在当前进程中。
- MCP 工具尚未由 Agent 自动选择调用。
- SSE 尚未逐 Token 输出。
- JSON Schema 校验只检查必填字段。
- 深层合规模型失败时采用规则结果，生产策略需重新评估。
- 健康检查只证明 Node 进程可响应，不证明全部外部依赖健康。

理解这些边界比只会描述功能更重要：它能帮助你区分教学实现、可运行原型与真正的生产系统。
