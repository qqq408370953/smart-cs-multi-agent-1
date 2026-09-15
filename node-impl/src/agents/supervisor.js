import { AIMessage } from "@langchain/core/messages";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { AgentStateSchema } from "./state.js";
import { trace } from "../tracing/tracer.js";

/** 移除messages，避免MessagesValue reducer把节点收到的历史再次追加。 */
function stateUpdates(state) {
  const { messages: _messages, ...updates } = state;
  return updates;
}

/**
 * 基于LangGraph.js的中央编排Agent。
 * 图结构固定为：意图路由 → 条件业务节点 → 合规审查 → 响应合成。
 */
export class SupervisorAgent {
  constructor({ intentRouter, knowledgeAgent, ticketAgent, complianceAgent, workingMemory, checkpointer }) {
    this.intentRouter = intentRouter;
    this.knowledgeAgent = knowledgeAgent;
    this.ticketAgent = ticketAgent;
    this.complianceAgent = complianceAgent;
    this.workingMemory = workingMemory;
    this.checkpointer = checkpointer ?? new MemorySaver();
    this.graph = this.#buildGraph();
  }

  #buildGraph() {
    const graph = new StateGraph(AgentStateSchema)
      .addNode("intent_router", async (state) => {
        state.current_agent = "intent_router";
        const result = await this.intentRouter.process(state);
        this.workingMemory.update(state.session_id, {
          intent: result.intent,
          timestamp: new Date().toISOString(),
        });
        return stateUpdates(result);
      })
      .addNode("knowledge_rag", async (state) => {
        state.current_agent = "knowledge_rag";
        return stateUpdates(await this.knowledgeAgent.process(state));
      }, { retryPolicy: { maxAttempts: 2 } })
      .addNode("ticket_handler", async (state) => {
        state.current_agent = "ticket_handler";
        return stateUpdates(await this.ticketAgent.process(state));
      }, { retryPolicy: { maxAttempts: 2 } })
      .addNode("security_handler", (state) => ({
        current_agent: "security_handler",
        sub_results: {
          ...state.sub_results,
          security_guidance: "您的请求涉及账户或资金安全。请立即停止相关操作并保护好验证码、密码等信息；该问题建议转交人工风控客服进一步核实。",
        },
      }))
      .addNode("compliance_check", async (state) => {
        state.current_agent = "compliance_checker";
        return stateUpdates(await this.complianceAgent.process(state));
      })
      .addNode("synthesize", (state) => {
        const finalResponse = this.synthesize(state);
        return {
          current_agent: "supervisor",
          final_response: finalResponse,
          messages: [new AIMessage(finalResponse)],
        };
      })
      .addEdge(START, "intent_router")
      .addConditionalEdges("intent_router", (state) => state.intent, {
        knowledge_rag: "knowledge_rag",
        ticket_handler: "ticket_handler",
        compliance_checker: "security_handler",
      })
      .addEdge("knowledge_rag", "compliance_check")
      .addEdge("ticket_handler", "compliance_check")
      .addEdge("security_handler", "compliance_check")
      .addEdge("compliance_check", "synthesize")
      .addEdge("synthesize", END);

    return graph.compile({ checkpointer: this.checkpointer });
  }

  /** 使用session_id作为thread_id执行图；MemorySaver会在每个节点保存Checkpoint。 */
  async orchestrate(state) {
    return trace("supervisor", "orchestrate", () => this.graph.invoke(
      state,
      { configurable: { thread_id: state.session_id } },
    ));
  }

  /** 合并业务Agent结果；合规失败时采用fail-closed的转人工响应。 */
  synthesize(state) {
    if (!state.compliance_passed) {
      return "抱歉，您的请求涉及敏感内容，已转交人工客服处理。请留意后续通知。";
    }

    const responses = Object.entries(state.sub_results)
      .filter(([name, result]) => !["compliance", "intent_router"].includes(name) && typeof result === "string")
      .map(([, result]) => result);
    return responses.join("\n\n") || "抱歉，暂时无法处理您的请求，请稍后重试。";
  }

  /** 暴露指定会话的Checkpoint历史，便于调试、恢复和Human-in-the-Loop扩展。 */
  getStateHistory(sessionId) {
    return this.graph.getStateHistory({ configurable: { thread_id: sessionId } });
  }
}
