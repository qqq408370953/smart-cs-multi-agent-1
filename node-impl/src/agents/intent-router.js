import { trace } from "../tracing/tracer.js";
import { z } from "zod";

// 配置LLM时优先结构化分类；模型不可用或异常时使用确定性关键词规则兜底。
const intentKeywords = {
  ticket_handler: ["退款", "退货", "理赔", "投诉", "开户", "申请", "办理", "工单", "申诉", "注销"],
  compliance_checker: ["举报", "欺诈", "盗刷", "异常", "安全", "违规", "泄露", "风险"],
};

export class IntentRouterAgent {
  constructor(llm = null) {
    this.llm = llm;
  }

  /** 分析用户消息，将请求路由到知识、工单或安全合规分支。 */
  async process(state) {
    return trace("intent_router", "process", async () => {
      const message = state.user_message.toLowerCase();
      let intent = "knowledge_rag";
      let maxScore = 0;

      if (this.llm) {
        try {
          const schema = z.object({
            suggested_agent: z.enum(["knowledge_rag", "ticket_handler", "compliance_checker"]),
            primary_intent: z.enum(["consultation", "complaint", "transaction", "account", "compliance", "unknown"]),
            secondary_intent: z.string(),
            confidence: z.number().min(0).max(1),
            entities: z.record(z.string(), z.string()),
          });
          const classifier = this.llm.withStructuredOutput(schema, { name: "intent_result" });
          const result = await classifier.invoke([
            ["system", "你是客服意图识别Agent。资金安全、欺诈和账户异常路由到compliance_checker；退款、理赔、开户和投诉路由到ticket_handler；产品、政策和一般咨询路由到knowledge_rag。"],
            ["human", message],
          ]);
          state.intent = result.suggested_agent;
          state.sub_results.intent_router = result;
          return state;
        } catch (error) {
          console.warn(`[IntentRouter] LLM分类失败，降级为规则路由: ${error.message}`);
        }
      }

      for (const [candidate, keywords] of Object.entries(intentKeywords)) {
        const score = keywords.filter((keyword) => message.includes(keyword)).length;
        if (score > maxScore) {
          intent = candidate;
          maxScore = score;
        }
      }

      state.intent = intent;
      state.sub_results.intent_router = {
        suggested_agent: intent,
        confidence: maxScore > 0 ? Math.min(0.98, 0.7 + maxScore * 0.1) : 0.6,
      };
      return state;
    });
  }
}
