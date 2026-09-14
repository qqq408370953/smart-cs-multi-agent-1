# Node.js 实现

智能客服多 Agent 系统的零依赖 Node.js 版本。实现了 Supervisor 编排、意图路由、RAG 检索、工单处理、合规审查、三层记忆抽象、MCP JSON-RPC、调用指标和 SSE 接口。

## 运行

需要 Node.js 20 或更高版本，无需安装第三方依赖：

```bash
cd node-impl
npm start
```

服务默认监听 `http://localhost:8100`。可通过 `HOST`、`PORT`、`SHORT_TERM_MAX_TURNS` 和 `SHORT_TERM_TTL_SECONDS` 环境变量调整配置。

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

## 测试

```bash
npm test
```

当前实现使用进程内短期记忆和关键词检索，方便开箱运行。生产环境可保持现有接口，将 `memory/short-term.js` 替换为 Redis，将 `memory/long-term.js` 替换为向量数据库，并在各 Agent 内接入 LLM。
