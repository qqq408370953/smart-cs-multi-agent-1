// HumanMessage 是 LangChain 对“用户消息”的标准封装。使用标准消息对象后，
// LangGraph Checkpoint、LLM 调用和消息 reducer 才能用统一格式处理消息。
import { HumanMessage } from "@langchain/core/messages";
// StateSchema 用来声明图中所有节点共享的数据结构；MessagesValue 是专门处理消息列表的字段类型。
import { MessagesValue, StateSchema } from "@langchain/langgraph";
// Zod 同时承担运行时校验和默认值填充，避免某个 Agent 收到结构不完整的 State。
import { z } from "zod";

/**
 * LangGraph.js 的共享状态契约（可以把它理解为所有 Agent 共用的“白板”）。
 *
 * 一次请求只创建一份 State，随后各节点读取已有字段，并返回自己负责的增量更新：
 * 1. API 创建初始 State；
 * 2. IntentRouter 写入 intent 和路由分析；
 * 3. 业务 Agent 把结果写入 sub_results；
 * 4. ComplianceChecker 写入合规结果；
 * 5. Supervisor 写入 final_response，并追加一条 AIMessage。
 *
 * 注意：messages 使用 MessagesValue 自带的 reducer。节点返回新的 messages 时是“追加”而非
 * 整体覆盖；其余字段则采用普通的最后写入值。这也是 supervisor.js 中要主动剔除旧 messages
 * 的原因，否则一个节点可能把收到的整段历史重复追加回去。
 */
export const AgentStateSchema = new StateSchema({
  // 标准化对话消息。初始时含 HumanMessage，结束时 synthesize 节点追加 AIMessage。
  messages: MessagesValue,
  // 业务用户标识：创建工单时用于确定工单归属。它不是 LangGraph 的会话隔离键。
  user_id: z.string(),
  // 会话标识：既用于短期历史，也会作为 LangGraph thread_id 保存 Checkpoint。
  session_id: z.string(),
  // 当前请求的原始文本。Agent 直接读取它，避免每次都从 messages 中反向解析。
  user_message: z.string(),
  // 路由目标：knowledge_rag、ticket_handler 或 compliance_checker。
  intent: z.string().default(""),
  // Agent 间的“共享黑板”：每个 Agent 以自己的名字作为 key 写入结果，避免互相覆盖。
  sub_results: z.record(z.string(), z.any()).default(() => ({})),
  // 合规总开关。最终合成时只要为 false，就不返回业务内容，而是采用安全兜底回复。
  compliance_passed: z.boolean().default(true),
  // 面向 HTTP 客户端的最终文本，只由 Supervisor 的 synthesize 节点生成。
  final_response: z.string().default(""),
  // 便于调试当前执行到了哪个节点；它不参与路由决策。
  current_agent: z.string().default(""),
  // 为未来的自定义重试策略预留。目前业务节点重试由 LangGraph retryPolicy 管理。
  retry_count: z.number().int().default(0),
});

/**
 * 创建一次Supervisor编排所使用的共享状态。
 * 字段命名与Python/Java/Go版本保持一致，便于跨语言比较和API调试。
 */
export function createState(userId, sessionId, userMessage) {
  // 每次 HTTP 请求都返回一个全新的对象，防止并发请求共享可变数据。
  return {
    // 先把用户原话包装成图可识别的消息；后续节点不需要重复添加它。
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
