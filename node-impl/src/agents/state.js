export function createState(userId, sessionId, userMessage) {
  return {
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
