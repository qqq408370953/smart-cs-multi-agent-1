import { HumanMessage } from "@langchain/core/messages";
import { MessagesValue, StateSchema } from "@langchain/langgraph";
import { z } from "zod";

/** LangGraph.js共享状态Schema；messages使用内置reducer实现跨节点追加。 */
export const AgentStateSchema = new StateSchema({
  messages: MessagesValue,
  user_id: z.string(),
  session_id: z.string(),
  user_message: z.string(),
  intent: z.string().default(""),
  sub_results: z.record(z.string(), z.any()).default(() => ({})),
  compliance_passed: z.boolean().default(true),
  final_response: z.string().default(""),
  current_agent: z.string().default(""),
  retry_count: z.number().int().default(0),
});

/**
 * 创建一次Supervisor编排所使用的共享状态。
 * 字段命名与Python/Java/Go版本保持一致，便于跨语言比较和API调试。
 */
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
