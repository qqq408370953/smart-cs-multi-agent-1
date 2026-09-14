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

export function createApplication(options = {}) {
  const workingMemory = new WorkingMemory();
  const shortTermMemory = new ShortTermMemory({
    maxTurns: options.maxTurns ?? Number(process.env.SHORT_TERM_MAX_TURNS || 20),
    ttlSeconds: options.ttlSeconds ?? Number(process.env.SHORT_TERM_TTL_SECONDS || 1800),
  });
  const longTermMemory = new LongTermMemory();

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

  const ticketAgent = new TicketHandlerAgent();
  const complianceAgent = new ComplianceCheckerAgent();
  const supervisor = new SupervisorAgent({
    intentRouter: new IntentRouterAgent(),
    knowledgeAgent: new KnowledgeRAGAgent(longTermMemory),
    ticketAgent,
    complianceAgent,
    workingMemory,
  });
  const mcpServer = createDefaultTools(new MCPToolServer(), { ticketAgent });
  const server = createApiServer({ supervisor, shortTermMemory, mcpServer });

  return {
    server,
    supervisor,
    memories: { workingMemory, shortTermMemory, longTermMemory },
    agents: { ticketAgent, complianceAgent },
    mcpServer,
  };
}
