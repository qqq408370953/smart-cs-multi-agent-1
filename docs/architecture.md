# 架构设计文档

> **Node.js 实现对照：**本文描述跨语言总体架构。需要把架构概念映射到 Node.js 的具体类、State 字段和十五步运行过程时，请阅读[Node.js Agent 全流程详细讲解](./node-agent-detailed-guide.md)。源码中的中文注释进一步解释了条件边、Reducer、Checkpoint、RAG、MCP 和 Span 的关联。

## 1. 系统总体架构

### 1.1 架构概览

本系统采用 **Supervisor编排模式**（中心化协调），由一个Supervisor Agent统一调度4个专业子Agent。

```
                          ┌─────────────────────────┐
                          │     用户 (Web/App/API)    │
                          └────────────┬────────────┘
                                       │ HTTP/SSE
                                       ▼
                          ┌─────────────────────────┐
                          │ API Gateway (FastAPI /    │
                          │ Spring / Gin / Node.js)   │
                          │   认证 | 限流 | 日志       │
                          └────────────┬────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                   │
                    ▼                  ▼                   ▼
            ┌──────────┐     ┌──────────────┐    ┌──────────────┐
            │ 短期记忆   │     │  Supervisor  │    │ 全链路追踪    │
            │  (Redis)  │◄───►│   编排Agent   │───►│(OpenTelemetry)│
            └──────────┘     └──────┬───────┘    └──────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
            ┌──────────┐   ┌──────────┐   ┌──────────────┐
            │ 知识检索   │   │ 工单处理  │   │   合规审查    │
            │  Agent    │   │  Agent   │   │    Agent     │
            │  (RAG)    │   │ (CRUD)   │   │ (规则+LLM)   │
            └────┬─────┘   └────┬─────┘   └──────────────┘
                 │               │
                 ▼               ▼
            ┌──────────┐   ┌──────────┐
            │ 长期记忆   │   │ MCP工具   │
            │(向量数据库) │   │  协议层   │
            └──────────┘   └──────────┘
```

### 1.2 编排流程（Supervisor Pattern）

```
用户请求
    │
    ▼
[Supervisor] ──── 分析意图 ──── [意图路由Agent]
    │                              │
    │ ◄──── 路由决策 ──────────────┘
    │
    ├── intent == "knowledge_rag" ──► [知识检索Agent] ──┐
    ├── intent == "ticket_handler" ──► [工单处理Agent] ──┤
    └── intent == "compliance"    ──► [安全提示节点] ────┤
                                                        │
                            ┌───────────────────────────┘
                            ▼
                     [合规审查Agent] (所有回复必须经过)
                            │
                            ├── 通过 ──► [Supervisor汇总] ──► 响应用户
                            └── 不通过 ──► 转人工 + 创建工单
```

## 2. 核心组件设计

### 2.1 Agent设计原则

每个Agent遵循**单一职责原则**：

| Agent | 职责 | 输入 | 输出 |
|-------|------|------|------|
| Supervisor | 编排调度、结果汇总 | 用户消息 + 全局State | 路由决策 + 最终回复 |
| 意图路由 | 意图分类 | 用户消息 | intent标签 + 置信度 |
| 知识检索 | RAG问答 | 用户问题 | 基于文档的回答 |
| 工单处理 | 工单创建、查询、状态更新 | 用户需求 | 工单号 + 状态 |
| 合规审查 | 内容审查 | Agent回复内容 | 通过/不通过 + 违规项 |

### 2.2 State设计

```python
class AgentState(TypedDict):
    messages: list[BaseMessage]      # 对话消息列表
    user_id: str                      # 用户标识
    session_id: str                   # 会话标识
    intent: str                       # 识别到的意图
    sub_results: dict[str, Any]       # 各Agent的处理结果
    compliance_passed: bool           # 合规审查是否通过
    final_response: str               # 最终回复
    current_agent: str                # 当前执行的Agent
    retry_count: int                  # 重试次数
```

Node.js 使用同样的字段语义，以普通对象作为每次请求独享的 State：

```javascript
export function createState(userId, sessionId, userMessage) {
  return {
    messages: [new HumanMessage(userMessage)],
    user_id: userId,
    session_id: sessionId,
    user_message: userMessage,
    intent: "",
    sub_results: {},
    compliance_passed: true,
    final_response: "",
    current_agent: "",
    retry_count: 0,
  };
}
```

Python与Node.js均通过LangGraph reducer/checkpoint管理图状态。Node.js使用`StateSchema`与`MessagesValue`，以`session_id`作为`thread_id`，由`MemorySaver`在每个节点保存快照；生产可替换为数据库Checkpointer。

### 2.3 分层记忆架构

```
┌──────────────────────────────────────────────┐
│                  应用层                       │
├──────────────────────────────────────────────┤
│  工作记忆 (Working Memory)                    │
│  ├── 存储: 进程内存 (dict)                    │
│  ├── 生命周期: 单次请求                       │
│  ├── 延迟: < 1ms                             │
│  └── 用途: 当前推理状态、路由决策上下文         │
├──────────────────────────────────────────────┤
│  短期记忆 (Short-term Memory)                │
│  ├── 存储: Redis / 连接失败回退进程内存         │
│  ├── 生命周期: TTL 30分钟                     │
│  ├── 延迟: 1-5ms                             │
│  ├── 容量: 最近20轮对话                       │
│  └── 用途: 多轮对话上下文                     │
├──────────────────────────────────────────────┤
│  长期记忆 (Long-term Memory)                 │
│  ├── 存储: FAISS / Milvus / 关键词索引         │
│  ├── 生命周期: 永久                           │
│  ├── 延迟: 10-50ms                           │
│  └── 用途: 知识库、用户画像、历史工单          │
└──────────────────────────────────────────────┘
```

各语言使用相同的三层职责，但存储后端并不完全相同：Python优先Redis与FAISS，Java面向Spring生态适配，Go当前使用进程内实现；Node.js通过官方`redis`客户端实现TTL滑动窗口，未配置或连接失败时回退私有`Map`。Node.js长期记忆在配置API Key时使用OpenAI Embeddings和内存向量余弦检索，失败时回退中英文关键词索引。Memory类通过构造器注入，替换为持久化向量库时不需要修改编排流程。

## 3. RAG检索流程

下图描述完整RAG流程。Python和Node.js均包含LLM Query改写、Top-5召回、结构化重排序与生成；Node.js召回层优先使用OpenAI Embeddings内存向量余弦检索，未配置API Key或Embedding调用失败时自动降级为中文二元词组/英文单词检索和模板回答。

```
用户原始问题: "怎么退钱啊"
        │
        ▼
[Query改写] ──► "退款 政策 申请 流程 时限"
        │
        ▼
[向量化] ──► Embedding(1536维)
        │
        ▼
[向量检索] ──► Top-5候选文档
        │
        ▼
[重排序] ──► LLM评估相关性 ──► Top-3文档
        │
        ▼
[上下文注入] ──► System Prompt + 文档内容 + 用户问题
        │
        ▼
[LLM生成] ──► 基于文档的回答 + 引用标注
        │
        ▼
[合规审查] ──► 检查回复合规性
        │
        ▼
最终回答 + 引用来源
```

## 4. MCP工具协议

```

Node.js 的 `MCPToolServer` 原生处理 `ping`、`tools/list` 与 `tools/call`，提供必填字段校验和最近100条调用日志。`POST /mcp` 使用JSON-RPC 2.0，`POST /api/tools/call` 为普通REST客户端提供等价入口。
┌─────────────┐    JSON-RPC 2.0    ┌─────────────────┐
│   Agent      │ ◄────────────────► │  MCP Tool Server │
│              │                    │                  │
│ tools/list   │ ──── 发现 ─────►  │  ┌─order_query  │
│ tools/call   │ ──── 调用 ─────►  │  ├─ticket_create│
│              │ ◄─── 结果 ──────  │  ├─risk_check   │
│              │                    │  └─kb_search    │
└─────────────┘                    └─────────────────┘
```

工具注册示例：
```json
{
  "name": "order_query",
  "description": "查询订单信息",
  "inputSchema": {
    "type": "object",
    "properties": {
      "order_id": {"type": "string"}
    },
    "required": ["order_id"]
  }
}
```

## 5. 全链路追踪

下面是OpenTelemetry Span目标结构。Node.js的`trace()`包装器使用OpenTelemetry API创建真实Span；配置OTLP HTTP端点后由NodeSDK导出至Jaeger，同时记录调用次数、总耗时、平均耗时和错误率并通过`GET /api/metrics`输出。

### Span层级结构

```
[Root] user_request (session_id=xxx, user_id=yyy)
  │
  ├── [Span] supervisor.route_decision
  │     └── duration: 800ms, tokens: 150
  │
  ├── [Span] knowledge_rag.process
  │     ├── [Span] rag.query_rewrite (200ms)
  │     ├── [Span] rag.vector_search (15ms)
  │     ├── [Span] rag.rerank (500ms)
  │     └── [Span] rag.generate_answer (1200ms)
  │
  ├── [Span] compliance_checker.process
  │     ├── [Span] compliance.rule_check (2ms)
  │     └── [Span] compliance.llm_check (600ms)
  │
  └── [Span] supervisor.synthesize (50ms)
```

### 关键监控指标

| 指标 | 说明 | 告警阈值 |
|------|------|---------|
| P99延迟 | 99%请求的响应时间 | > 5s |
| Agent错误率 | 各Agent的失败比例 | > 5% |
| Token消耗/请求 | 平均每请求的Token数 | > 5000 |
| 路由准确率 | 意图路由的正确率 | < 85% |
| 合规通过率 | 合规审查的通过比例 | < 90%需关注 |

## 6. 技术选型对比

### 编排框架对比

| 维度 | LangGraph (Python) | Spring AI (Java) | 原生编排 (Go) | LangGraph.js (Node.js) |
|------|-------------------|------------------|-----------|------------------|
| 编排模型 | 有向图StateGraph | Agent组合模式 | 顺序Supervisor | 有向图StateGraph |
| 状态管理 | TypedDict + Checkpoint | POJO | struct | StateSchema + Checkpoint |
| 并行能力 | asyncio | CompletableFuture | goroutine | Event Loop + Promise |
| 生态 | LangSmith/LangServe | Spring生态 | Gin / Go微服务 | npm / Web全栈生态 |
| 适合团队 | AI/数据团队 | 企业级Java团队 | Go微服务团队 | Node.js全栈/BFF团队 |
| 生产成熟度 | 高 | 中高 | 中 | 中高 |

Node.js 版本采用LangGraph.js显式执行“意图路由 → 业务Agent → 合规审查 → 汇总”，并使用MemorySaver Checkpoint和节点重试。配置API Key后，ChatOpenAI参与意图、RAG、工单分析和二阶段合规；配置Redis与OTLP端点后分别启用分布式会话和真实Span导出。无外部服务时，各组件自动降级但图编排仍保持不变。

### 向量数据库对比

| 维度 | FAISS | Milvus | Pinecone |
|------|-------|--------|----------|
| 部署方式 | 嵌入式 | 分布式 | SaaS |
| 数据规模 | 千万级 | 百亿级 | 百亿级 |
| 查询延迟 | < 1ms | ~10ms | ~50ms |
| 运维复杂度 | 低 | 中 | 零 |
| 成本 | 免费 | 中等 | 高 |
| 适合阶段 | 开发/小规模 | 生产 | 快速上线 |
