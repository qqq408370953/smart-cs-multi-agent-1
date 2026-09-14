import { trace } from "../tracing/tracer.js";

export class SupervisorAgent {
  constructor({ intentRouter, knowledgeAgent, ticketAgent, complianceAgent, workingMemory }) {
    this.intentRouter = intentRouter;
    this.knowledgeAgent = knowledgeAgent;
    this.ticketAgent = ticketAgent;
    this.complianceAgent = complianceAgent;
    this.workingMemory = workingMemory;
  }

  async orchestrate(state) {
    return trace("supervisor", "orchestrate", async () => {
      state.current_agent = "intent_router";
      await this.intentRouter.process(state);
      this.workingMemory.update(state.session_id, {
        intent: state.intent,
        timestamp: new Date().toISOString(),
      });

      if (state.intent === "ticket_handler") {
        state.current_agent = "ticket_handler";
        await this.ticketAgent.process(state);
      } else if (state.intent === "compliance_checker") {
        state.sub_results.security_guidance = "您的请求涉及账户或资金安全。请立即停止相关操作并保护好验证码、密码等信息；该问题建议转交人工风控客服进一步核实。";
      } else {
        state.current_agent = "knowledge_rag";
        await this.knowledgeAgent.process(state);
      }

      state.current_agent = "compliance_checker";
      await this.complianceAgent.process(state);
      state.final_response = this.synthesize(state);
      state.current_agent = "supervisor";
      return state;
    });
  }

  synthesize(state) {
    if (!state.compliance_passed) {
      return "抱歉，您的请求涉及敏感内容，已转交人工客服处理。请留意后续通知。";
    }

    const responses = Object.entries(state.sub_results)
      .filter(([name, result]) => !["compliance", "intent_router"].includes(name) && typeof result === "string")
      .map(([, result]) => result);
    return responses.join("\n\n") || "抱歉，暂时无法处理您的请求，请稍后重试。";
  }
}
