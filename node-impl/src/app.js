import { IntentRouterAgent } from "./agents/intent-router.js";
import { KnowledgeRAGAgent } from "./agents/knowledge-rag.js";
import { TicketHandlerAgent } from "./agents/ticket-handler.js";
import { ComplianceCheckerAgent } from "./agents/compliance-checker.js";
import { SupervisorAgent } from "./agents/supervisor.js";
import { WorkingMemory } from "./memory/working-memory.js";
import { ShortTermMemory } from "./memory/short-term.js";
import { LongTermMemory } from "./memory/long-term.js";
import { MCPToolServer, createDefaultTools } from "./mcp/server.js";
import { createApiServer } from "./api/server.js";
import { createChatModel, createEmbeddingsModel } from "./llm/client.js";
import { initTracing, shutdownTracing } from "./tracing/tracer.js";

/**
 * 应用组合根（Composition Root）：集中创建记忆、Agent、Supervisor、MCP与HTTP Server。
 * 避免业务模块依赖全局单例，也便于测试为每个应用创建隔离状态。
 *
 * 关联知识：这里使用的是依赖注入（Dependency Injection）思想。
 * Agent 不主动寻找全局 LLM/数据库，而是通过构造函数接收依赖，因此：
 * - 测试能传 fakeLlm/fakeEmbeddings；
 * - 生产环境能替换 Redis、向量库或 Checkpointer；
 * - 单个 Agent 不需要知道 HTTP、Docker 等外围细节。
 */
export function createApplication(options = {}) {
  // 第 1 步：尽早初始化追踪，这样后面执行的 Agent 才能创建真实 Span。
  initTracing(options.tracing);
  // 第 2 步：创建模型。options 显式传值优先，undefined 才读取环境变量。
  // 这种写法允许测试显式传 null，强制验证“无模型降级”路径。
  const llm = options.llm !== undefined ? options.llm : createChatModel();
  const embeddings = options.embeddings !== undefined ? options.embeddings : createEmbeddingsModel();
  // 第 3 步：实例化三层记忆。三者职责不同，不能互相替代。
  const workingMemory = new WorkingMemory();
  const shortTermMemory = new ShortTermMemory({
    redisUrl: options.redisUrl ?? process.env.REDIS_URL,
    maxTurns: options.maxTurns ?? Number(process.env.SHORT_TERM_MAX_TURNS || 20),
    ttlSeconds: options.ttlSeconds ?? Number(process.env.SHORT_TERM_TTL_SECONDS || 1800),
  });
  const longTermMemory = new LongTermMemory({ embeddings });

  // 第 4 步：给长期记忆注入种子知识。它们是 RAG 的事实来源，不是 Prompt 中硬编码的答案。
  // RAG（Retrieval-Augmented Generation）先检索外部知识，再让模型基于证据回答，
  // 用于降低幻觉并支持来源引用；Embedding 只是其中一种检索方式。
  longTermMemory.addDocumentsBatch([
    {
      content: "我们的理财产品A年化收益率为3.5%-5.2%，投资期限为6个月至3年，最低投资金额10000元。注意：理财非存款，产品有风险，投资须谨慎。",
      source: "product_faq.md",
    },
    {
      content: "退款政策：用户在购买后7天内可申请无理由退款，超过7天需提供合理原因。退款将在3-5个工作日内原路退回。",
      source: "refund_policy.md",
    },
    {
      content: "开户流程：1.准备身份证原件 2.填写开户申请表 3.进行视频认证 4.设置交易密码 5.完成风险评估问卷。整个流程约需15-30分钟。",
      source: "account_guide.md",
    },
  ]);

  // 第 5 步：创建专业 Agent。多个 Agent 共用同一个 llm 客户端，但各自拥有独立 Prompt 和职责。
  const ticketAgent = new TicketHandlerAgent(llm);
  const complianceAgent = new ComplianceCheckerAgent(llm);
  // 第 6 步：Supervisor 接收所有专业 Agent，并把它们编排为 LangGraph 状态图。
  // Supervisor 模式强调“中央路由和统一出口”，区别于 Agent 之间自由互相调用的协作模式。
  const supervisor = new SupervisorAgent({
    intentRouter: new IntentRouterAgent(llm),
    knowledgeAgent: new KnowledgeRAGAgent(longTermMemory, llm),
    ticketAgent,
    complianceAgent,
    workingMemory,
  });
  // 第 7 步：注册 MCP 工具。MCP 是“能力调用协议”，LangGraph 是“流程编排框架”，两者不是一回事。
  // 当前 ticket_create 工具与 TicketHandlerAgent 复用同一 createTicket 能力。
  const mcpServer = createDefaultTools(new MCPToolServer(), { ticketAgent });
  // 第 8 步：将编排器、短期记忆和工具服务注入 HTTP 边界。
  const server = createApiServer({ supervisor, shortTermMemory, mcpServer });

  return {
    server,
    supervisor,
    memories: { workingMemory, shortTermMemory, longTermMemory },
    agents: { ticketAgent, complianceAgent },
    mcpServer,
    llmEnabled: Boolean(llm),
    async close() {
      // 关闭顺序从业务资源到观测资源，确保退出前尽量导出剩余 Span。
      await shortTermMemory.close();
      await shutdownTracing();
    },
  };
}
