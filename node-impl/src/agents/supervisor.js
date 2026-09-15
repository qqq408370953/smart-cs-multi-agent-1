// AIMessage 用来把最终客服回复追加进 LangGraph 的标准消息历史。
import { AIMessage } from "@langchain/core/messages";
// START/END 是图的虚拟起终点；StateGraph 构图；MemorySaver 保存每个节点后的状态快照。
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { AgentStateSchema } from "./state.js";
import { trace } from "../tracing/tracer.js";

/**
 * 把 Agent 返回的完整 State 转成“增量更新”。
 * Agent 为了便于独立测试会直接修改并返回 state，但 LangGraph 的 messages 字段使用追加型 reducer。
 * 如果把原 messages 原样交还给图，它会把历史再次追加一遍，所以业务节点更新时必须剔除它。
 */
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
    // Supervisor 不在内部 new 具体 Agent，而是接收外部注入，方便测试替换和未来更换实现。
    this.intentRouter = intentRouter;
    this.knowledgeAgent = knowledgeAgent;
    this.ticketAgent = ticketAgent;
    this.complianceAgent = complianceAgent;
    this.workingMemory = workingMemory;
    // 不传持久化实现时使用内存 Checkpointer；进程重启后这些快照会消失。
    this.checkpointer = checkpointer ?? new MemorySaver();
    // 构造函数阶段编译一次图，后续每个请求复用已编译图，通过 thread_id 隔离状态。
    this.graph = this.#buildGraph();
  }

  #buildGraph() {
    // 图中节点返回的对象会由 AgentStateSchema 合并到当前 State。
    const graph = new StateGraph(AgentStateSchema)
      .addNode("intent_router", async (state) => {
        // 节点 1：识别意图。current_agent 仅用于观测，不控制流程。
        state.current_agent = "intent_router";
        const result = await this.intentRouter.process(state);
        // 把路由结论额外保存到工作记忆，便于查询当前会话最近的推理上下文。
        this.workingMemory.update(state.session_id, {
          intent: result.intent,
          timestamp: new Date().toISOString(),
        });
        return stateUpdates(result);
      })
      .addNode("knowledge_rag", async (state) => {
        // 业务分支 A：知识检索问答。失败时 LangGraph 最多尝试 2 次。
        state.current_agent = "knowledge_rag";
        return stateUpdates(await this.knowledgeAgent.process(state));
      }, { retryPolicy: { maxAttempts: 2 } })
      .addNode("ticket_handler", async (state) => {
        // 业务分支 B：创建、查询或更新工单，同样允许一次重试。
        state.current_agent = "ticket_handler";
        return stateUpdates(await this.ticketAgent.process(state));
      }, { retryPolicy: { maxAttempts: 2 } })
      .addNode("security_handler", (state) => ({
        // 业务分支 C：安全事件暂不调用独立类，而是生成固定安全指引并建议转人工。
        current_agent: "security_handler",
        sub_results: {
          ...state.sub_results,
          security_guidance: "您的请求涉及账户或资金安全。请立即停止相关操作并保护好验证码、密码等信息；该问题建议转交人工风控客服进一步核实。",
        },
      }))
      .addNode("compliance_check", async (state) => {
        // 统一出口：无论上面选择哪个业务分支，都必须经过同一个合规节点。
        state.current_agent = "compliance_checker";
        return stateUpdates(await this.complianceAgent.process(state));
      })
      .addNode("synthesize", (state) => {
        // 最终节点：根据合规结果合成面向用户的文本，并追加 AIMessage。
        const finalResponse = this.synthesize(state);
        return {
          current_agent: "supervisor",
          final_response: finalResponse,
          messages: [new AIMessage(finalResponse)],
        };
      })
      // 图入口固定先做意图识别。
      .addEdge(START, "intent_router")
      // 条件边读取 state.intent，每次请求只会进入三个业务分支之一。
      .addConditionalEdges("intent_router", (state) => state.intent, {
        knowledge_rag: "knowledge_rag",
        ticket_handler: "ticket_handler",
        compliance_checker: "security_handler",
      })
      // 三条业务分支重新汇聚到合规节点，防止任何业务回答绕过安全检查。
      .addEdge("knowledge_rag", "compliance_check")
      .addEdge("ticket_handler", "compliance_check")
      .addEdge("security_handler", "compliance_check")
      .addEdge("compliance_check", "synthesize")
      .addEdge("synthesize", END);

    // compile 后得到可 invoke 的 Runnable；checkpointer 会在每个节点边界保存 State。
    return graph.compile({ checkpointer: this.checkpointer });
  }

  /** 使用session_id作为thread_id执行图；MemorySaver会在每个节点保存Checkpoint。 */
  async orchestrate(state) {
    // session_id 作为 thread_id：同一会话可查询连续 Checkpoint，不同会话彼此隔离。
    return trace("supervisor", "orchestrate", () => this.graph.invoke(
      state,
      { configurable: { thread_id: state.session_id } },
    ));
  }

  /** 合并业务Agent结果；合规失败时采用fail-closed的转人工响应。 */
  synthesize(state) {
    // Fail-closed：无法确认安全时宁可不返回业务内容，避免泄露 PII 或输出违规承诺。
    if (!state.compliance_passed) {
      return "抱歉，您的请求涉及敏感内容，已转交人工客服处理。请留意后续通知。";
    }

    // intent_router 和 compliance 保存的是结构化元数据；这里只拼接业务 Agent 的字符串回答。
    const responses = Object.entries(state.sub_results)
      .filter(([name, result]) => !["compliance", "intent_router"].includes(name) && typeof result === "string")
      .map(([, result]) => result);
    return responses.join("\n\n") || "抱歉，暂时无法处理您的请求，请稍后重试。";
  }

  /** 暴露指定会话的Checkpoint历史，便于调试、恢复和Human-in-the-Loop扩展。 */
  getStateHistory(sessionId) {
    // 返回异步迭代器而不是数组，调用方可按需消费大量历史快照。
    return this.graph.getStateHistory({ configurable: { thread_id: sessionId } });
  }
}
