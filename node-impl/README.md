# Node.js 实现

智能客服多 Agent 系统的 Node.js 版本。它与 Python、Java、Go 版本保持相同的核心业务边界，实现 LangGraph.js Supervisor 编排、意图路由、RAG 检索、工单处理、两阶段合规审查、分层记忆、MCP JSON-RPC、OpenTelemetry 和 SSE 接口。

## 中文深度学习入口

如果目标是理解每个 Agent 的每一步，不建议只按文件从上到下读。请配合以下资料：

1. [Node.js Agent 全流程详细讲解](../docs/node-agent-detailed-guide.md)：术语、十五步请求链路、State 变化和各 Agent 关联知识。
2. [Node.js Agent 项目学习路线](../docs/node-learning-roadmap.md)：十二步动手课程和掌握标准。
3. `agent-flow-demo/`：用真实 API 将一次完整请求拆成八个可观察阶段。

源码已经补充中文行内注释。注释重点解释输入/输出、State 修改、设计原因、失败降级，以及与 LangGraph、RAG、MCP、Memory 和 OpenTelemetry 的关系。

## 设计定位

Node.js 版本面向 Web 全栈、BFF 和 JavaScript/TypeScript 团队：

- 使用 LangGraph.js `StateGraph`、`StateSchema`、`MessagesValue`和`MemorySaver`
- 以`session_id`作为`thread_id`，每个图节点自动保存Checkpoint
- 通过LangChain `ChatOpenAI`实现LLM意图分类、Query改写/重排/生成、工单分析和二阶段合规审查
- 通过`OpenAIEmbeddings`实现内存向量余弦检索，失败时自动回退中英文关键词检索
- 使用官方`redis`客户端保存会话；未配置或连接失败时自动回退进程内Map
- 配置OTLP地址后启动OpenTelemetry NodeSDK并输出真实Span，同时保留本地聚合指标
- 使用 Node.js 20+ 原生 ESM、`async/await` 和 `node:http`
- Agent 统一实现 `process(state)` 契约，由 Supervisor 注入和调度
- REST、SSE 和 MCP JSON-RPC 2.0 共用同一套业务服务
- 使用 `node:test` 验证真实HTTP链路和核心规则

`OPENAI_API_KEY`是可选配置：配置后启用完整LLM链路；未配置或模型调用失败时，Agent会降级到确定性规则和本地知识检索。`REDIS_URL`和`OTEL_EXPORTER_OTLP_ENDPOINT`同样按需启用，因此缺少外部服务时仍可运行。

如果你准备从源码系统学习，请按[Node.js Agent项目学习路线](../docs/node-learning-roadmap.md)中的流程图和十二步课程进行。

## 请求链路

```text
HTTP / SSE 请求
      ↓
IntentRouterAgent
      ↓
SupervisorAgent ──→ KnowledgeRAGAgent / TicketHandlerAgent / 安全提示
      ↓
ComplianceCheckerAgent（统一汇聚）
      ↓
响应合成 → LangGraph Checkpoint + Redis会话历史 + OpenTelemetry
```

## 目录结构

```text
node-impl/
├── src/
│   ├── agents/       # State、Supervisor及四类Agent
│   ├── api/          # 原生HTTP、REST与SSE
│   ├── memory/       # 工作、短期、长期记忆
│   ├── mcp/          # 工具注册与JSON-RPC 2.0
│   ├── llm/          # ChatOpenAI创建与消息处理
│   ├── tracing/      # OpenTelemetry与聚合指标
│   ├── app.js        # 依赖装配与默认知识库
│   └── main.js       # 服务入口与优雅退出
└── test/             # Node.js内置测试
```

## 运行

需要 Node.js 20 或更高版本：

```bash
cd node-impl
npm install
npm start
```

服务默认监听 `http://localhost:8100`。复制`.env.example`中的变量到运行环境，可按需连接LLM、Redis和OTLP Collector；程序本身不会自动加载`.env`文件。

```bash
curl -X POST http://localhost:8100/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"user_001","message":"理财产品的投资期限是多久？"}'
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/chat` | 聊天主接口 |
| `POST` | `/api/chat/stream` | SSE 聊天接口 |
| `GET` | `/api/history/:sessionId` | 获取会话历史 |
| `GET` | `/api/tools` | 发现 MCP 工具 |
| `POST` | `/api/tools/call` | 调用 MCP 工具 |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 入口 |
| `GET` | `/api/metrics` | Agent 指标和工具调用日志 |
| `GET` | `/health` | 健康检查 |

`/api/chat/stream`当前通过SSE发送完整的最终结果事件；LangGraph与LLM内部已使用异步接口，后续可扩展为逐Token事件。

## 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP监听地址 |
| `PORT` | `8100` | HTTP端口 |
| `OPENAI_API_KEY` | 空 | 配置后启用ChatOpenAI |
| `OPENAI_BASE_URL` | OpenAI官方端点 | OpenAI兼容API地址 |
| `MODEL_NAME` | `gpt-4o` | Chat模型 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 向量模型 |
| `LLM_TIMEOUT_MS` | `15000` | 单次模型调用超时 |
| `REDIS_URL` | 空 | 配置后使用Redis短期记忆 |
| `SHORT_TERM_MAX_TURNS` | `20` | 每个会话最多保留消息数 |
| `SHORT_TERM_TTL_SECONDS` | `1800` | 会话TTL |
| `OTEL_SERVICE_NAME` | `smart-cs-node` | OpenTelemetry服务名 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 空 | 配置后启用OTLP HTTP Span导出 |

## package.json 与运行脚本说明

JSON 标准不允许写注释，所以 `package.json` 和 `package-lock.json` 不直接加入行内注释：

- `type: module`：启用原生 ESM，源码使用 `import/export`。
- `engines.node >= 20`：声明本地最低 Node.js 版本；Dockerfile 当前使用 Node 22 Alpine。
- `start`：普通启动，执行 `src/main.js`。
- `dev`：使用 Node `--watch`，源码变化后自动重启。
- `test`：使用 Node 内置 `node:test`，不依赖 Jest。
- `package-lock.json`：锁定完整依赖树和校验值，应该由 npm 维护，不应手工添加说明字段。

主要依赖的职责：

| 依赖 | 与 Agent 的关系 |
| --- | --- |
| `@langchain/langgraph` | StateSchema、节点、边、Checkpoint 和整图执行 |
| `@langchain/core` | HumanMessage、AIMessage 等标准消息对象 |
| `@langchain/openai` | 可选 Chat LLM 与 Embedding 客户端 |
| `zod` | 校验 State 和 LLM 结构化输出 |
| `redis` | 可选短期会话历史存储 |
| `@opentelemetry/*` | 创建、聚合并导出 Agent Span |

## 测试

```bash
npm test
```

测试覆盖健康检查、LangGraph Checkpoint、工单创建/查询/更新、知识库检索、会话历史、MCP参数校验/调用、PII脱敏、Mock LLM深度链路和Embedding排序。

## 与其他实现的对应关系

| 能力 | Python | Java | Go | Node.js |
| --- | --- | --- | --- | --- |
| 编排 | LangGraph StateGraph | Agent组合 | Supervisor结构体 | LangGraph.js StateGraph |
| API | FastAPI | Spring Boot | Gin | 原生node:http + SSE |
| State | TypedDict + Checkpoint | POJO | struct | StateSchema + Checkpoint |
| 工作记忆 | dict | Java集合 | map | Map |
| 短期记忆 | Redis/内存回退 | Redis适配 | 内存实现 | Redis/Map回退 |
| 长期检索 | FAISS/关键词回退 | 向量库抽象 | 关键词 | OpenAI Embeddings内存向量/关键词回退 |
| MCP | Python工具服务 | Java工具服务 | Go工具服务 | REST + JSON-RPC 2.0 |
| 追踪 | OpenTelemetry | OpenTelemetry | 指标包装 | OpenTelemetry + 聚合指标 |

## 生产化扩展

保持现有接口即可逐步升级：

1. 将MemorySaver替换为Postgres/MongoDB等持久化Checkpointer，实现跨进程恢复。
2. 将当前进程内Embedding向量缓存替换为持久化向量数据库或Hybrid Search。
3. 将内存工单存储替换为数据库或真实工单服务。
4. 将SSE从单个最终事件升级为模型Token和LangGraph节点事件。
5. 为外部工具增加鉴权、完整JSON Schema校验、重试、超时、熔断和持久化审计日志。
