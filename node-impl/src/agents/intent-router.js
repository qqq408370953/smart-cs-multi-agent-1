import { trace } from "../tracing/tracer.js";

const intentKeywords = {
  ticket_handler: ["退款", "退货", "理赔", "投诉", "开户", "申请", "办理", "工单", "申诉", "注销"],
  compliance_checker: ["举报", "欺诈", "盗刷", "异常", "安全", "违规", "泄露", "风险"],
};

export class IntentRouterAgent {
  async process(state) {
    return trace("intent_router", "process", async () => {
      const message = state.user_message.toLowerCase();
      let intent = "knowledge_rag";
      let maxScore = 0;

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
