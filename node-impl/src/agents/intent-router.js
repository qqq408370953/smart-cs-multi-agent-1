// 每个 Agent 都通过 trace 包装执行过程，从而同时产生耗时指标和 OpenTelemetry Span。
import { trace } from "../tracing/tracer.js";
// LLM 返回的是外部、不可信数据，因此用 Zod 约束它必须返回允许的路由枚举和字段。
import { z } from "zod";

// 本地规则路由表。没有命中任何关键词时默认走 knowledge_rag，适合处理普通咨询。
// 配置 LLM 时优先结构化分类；模型不可用或异常时仍回到这张表，保证服务可用。
const intentKeywords = {
  ticket_handler: ["退款", "退货", "理赔", "投诉", "开户", "申请", "办理", "工单", "申诉", "注销"],
  compliance_checker: ["举报", "欺诈", "盗刷", "异常", "安全", "违规", "泄露", "风险"],
};

export class IntentRouterAgent {
  constructor(llm = null) {
    // llm 可以是真实 ChatOpenAI，也可以是测试中的 fakeLlm；null 表示纯本地模式。
    this.llm = llm;
  }

  /**
   * 第一个图节点：分析用户消息，将请求路由到知识、工单或安全合规分支。
   *
   * 输入：state.user_message。
   * 写入：state.intent、state.sub_results.intent_router。
   * 输出：仍返回同一份业务 State，由 LangGraph 根据 intent 选择下一条条件边。
   */
  async process(state) {
    return trace("intent_router", "process", async () => {
      // 转为小写主要服务英文关键词；中文不会受到影响。
      const message = state.user_message.toLowerCase();
      // 普通问题默认按知识咨询处理。maxScore 用来选出命中关键词最多的分支。
      let intent = "knowledge_rag";
      let maxScore = 0;

      if (this.llm) {
        try {
          // 第 1 步（LLM 模式）：定义模型必须遵循的结构化输出，而不是解析自由文本。
          const schema = z.object({
            suggested_agent: z.enum(["knowledge_rag", "ticket_handler", "compliance_checker"]),
            primary_intent: z.enum(["consultation", "complaint", "transaction", "account", "compliance", "unknown"]),
            secondary_intent: z.string(),
            confidence: z.number().min(0).max(1),
            entities: z.record(z.string(), z.string()),
          });
          // 第 2 步：withStructuredOutput 会要求模型按 schema 返回 JS 对象。
          const classifier = this.llm.withStructuredOutput(schema, { name: "intent_result" });
          // 第 3 步：System Prompt 定义路由职责，Human Message 携带本次用户原话。
          const result = await classifier.invoke([
            ["system", "你是客服意图识别Agent。资金安全、欺诈和账户异常路由到compliance_checker；退款、理赔、开户和投诉路由到ticket_handler；产品、政策和一般咨询路由到knowledge_rag。"],
            ["human", message],
          ]);
          // 第 4 步：把最终路由和完整分析写入共享 State，供条件边及调试界面使用。
          state.intent = result.suggested_agent;
          state.sub_results.intent_router = result;
          return state;
        } catch (error) {
          // 模型超时、网络错误或 Schema 不合格都不能让整个客服请求失败，继续执行本地规则。
          console.warn(`[IntentRouter] LLM分类失败，降级为规则路由: ${error.message}`);
        }
      }

      // 本地模式第 1 步：计算每个候选分支命中了多少个关键词。
      for (const [candidate, keywords] of Object.entries(intentKeywords)) {
        const score = keywords.filter((keyword) => message.includes(keyword)).length;
        // 只在严格大于当前最高分时切换，因此同分时保持先出现的候选或默认知识分支。
        if (score > maxScore) {
          intent = candidate;
          maxScore = score;
        }
      }

      // 本地模式第 2 步：保存路由。confidence 是演示用启发式分数，不是统计学概率。
      state.intent = intent;
      state.sub_results.intent_router = {
        suggested_agent: intent,
        confidence: maxScore > 0 ? Math.min(0.98, 0.7 + maxScore * 0.1) : 0.6,
      };
      return state;
    });
  }
}
