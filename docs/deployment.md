# 部署指南

## 1. 本地开发环境

### Python版本

```bash
cd python-impl
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env 填入你的API Key
python -m api.main
```

访问: http://localhost:8000/docs (Swagger UI)

### Java版本

```bash
cd java-impl
mvn clean package -DskipTests
java -jar target/smart-cs-agent-1.0.0.jar
```

访问: http://localhost:8080/api/health

### Go版本

```bash
cd go-impl
go mod tidy
go run main.go
```

访问: http://localhost:8090/health

### Node.js版本

```bash
cd node-impl
npm install
npm start
```

访问: http://localhost:8100/health

开发时可使用 `npm run dev` 启用 Node.js watch 模式，运行 `npm test` 执行接口与核心模块测试。

## 2. Docker部署

### 单服务启动

```bash
# Python
cd python-impl
docker build -t smart-cs-python .
docker run -p 8000:8000 --env-file .env smart-cs-python

# Java
cd java-impl
mvn clean package -DskipTests
docker build -t smart-cs-java .
docker run -p 8080:8080 -e OPENAI_API_KEY=xxx smart-cs-java

# Go
cd go-impl
docker build -t smart-cs-go .
docker run -p 8090:8090 smart-cs-go

# Node.js
cd node-impl
docker build -t smart-cs-node .
docker run -p 8100:8100 smart-cs-node
```

### Docker Compose 一键启动

```bash
docker-compose up -d
```

## 3. API接口说明

所有四个版本提供统一的REST API。Node.js 版本还提供 SSE 与 JSON-RPC 2.0 入口：

### POST /api/chat — 聊天接口

```json
// Request
{
  "message": "我想了解一下理财产品A",
  "user_id": "user_001",
  "session_id": "optional-session-id"
}

// Response
{
  "response": "关于理财产品A...",
  "session_id": "xxx",
  "intent": "knowledge_rag",
  "compliance_passed": true
}
```

### GET /api/history/{session_id} — 对话历史

### GET /api/tools — MCP工具列表

### POST /api/tools/call — MCP工具调用

```json
{
  "name": "risk_check",
  "arguments": {
    "user_id": "user_001",
    "action": "transfer",
    "amount": 60000
  }
}
```

### POST /api/chat/stream — SSE聊天接口（Node.js）

```bash
curl -N -X POST http://localhost:8100/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"理财产品的投资期限是多久？"}'
```

### POST /mcp — MCP JSON-RPC 2.0入口（Node.js）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

### GET /api/metrics — 系统指标

### GET /health — 健康检查

## 4. 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| OPENAI_API_KEY | LLM API密钥 | 无 |
| OPENAI_BASE_URL | API端点 | https://api.openai.com/v1 |
| MODEL_NAME | 模型名称 | gpt-4o |
| EMBEDDING_MODEL | Node.js向量模型 | text-embedding-3-small |
| REDIS_URL | Redis地址 | redis://localhost:6379/0 |
| OTEL_SERVICE_NAME | 追踪服务名 | smart-cs-multi-agent |
| OTEL_EXPORTER_OTLP_ENDPOINT | OTLP端点（Node.js使用HTTP） | Node.js示例为http://localhost:4318 |
| HOST | Node.js监听地址 | 0.0.0.0 |
| PORT | 服务端口（各实现可覆盖） | Node.js为8100 |
| SHORT_TERM_MAX_TURNS | Node.js短期记忆最大消息数 | 20 |
| SHORT_TERM_TTL_SECONDS | Node.js短期记忆TTL（秒） | 1800 |
| LLM_TIMEOUT_MS | Node.js单次LLM调用超时（毫秒） | 15000 |

Node.js 已接入LangGraph.js、ChatOpenAI、Redis和OpenTelemetry NodeSDK。`OPENAI_API_KEY`、`REDIS_URL`或`OTEL_EXPORTER_OTLP_ENDPOINT`未配置时，对应组件分别降级为规则Agent、进程内会话和本地聚合指标，因此仍可离线启动。
