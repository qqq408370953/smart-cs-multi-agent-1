# Node.js 实现

智能客服多 Agent 系统的 Node.js 版本。它与 Python、Java、Go 版本保持相同的核心业务边界，实现 LangGraph.js Supervisor 编排、意图路由、RAG 检索、工单处理、两阶段合规审查、分层记忆、MCP JSON-RPC、OpenTelemetry 和 SSE 接口。

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
