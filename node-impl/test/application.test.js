// 测试既是回归保护，也是最短的可执行使用文档：每个 test 展示一个公开契约。
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApplication } from "../src/app.js";
import { createState } from "../src/agents/state.js";
import { TicketHandlerAgent } from "../src/agents/ticket-handler.js";
import { LongTermMemory } from "../src/memory/long-term.js";

// 默认不传 LLM，验证项目在无 API Key 时的确定性降级链路。
const application = createApplication();
let baseUrl;

before(async () => {
  // 监听端口 0 让操作系统分配空闲端口，避免测试与本地 8100 服务冲突。
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  // 显式关闭 HTTP、Redis 和追踪资源，否则 Node 测试进程可能因活动句柄无法退出。
  await new Promise((resolve) => application.server.close(resolve));
  await application.close();
});

test("health endpoint reports the Node runtime", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "healthy",
    version: "1.1.0",
    runtime: "node",
    orchestration: "langgraph",
  });
});

test("chat routes refund requests to the ticket agent and stores history", async () => {
  // 集成验证：HTTP → 路由 → 工单 → 合规 → 合成 → 短期记忆。
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "我需要申请退款", user_id: "user-1", session_id: "session-1" }),
  });
  const body = await response.json();
  assert.equal(body.intent, "ticket_handler");
  assert.equal(body.compliance_passed, true);
  assert.match(body.response, /TK-\d{8}-0001/);

  // 同一个 session_id 应保存一条 user 和一条 assistant 消息。
  const history = await (await fetch(`${baseUrl}/api/history/session-1`)).json();
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].role, "user");
  assert.equal(history.messages[1].role, "assistant");

  // Checkpoint 数量证明图经过多个节点；它与上面的两条聊天历史不是同一存储。
  const checkpoints = await Array.fromAsync(application.supervisor.getStateHistory("session-1"));
  assert.ok(checkpoints.length >= 5);
  assert.equal(checkpoints[0].values.final_response, body.response);
});

test("knowledge requests retrieve seeded documents", async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "理财产品的投资期限是多久？" }),
  });
  const body = await response.json();
  assert.equal(body.intent, "knowledge_rag");
  assert.match(body.response, /6个月至3年/);
});

test("ticket agent creates, queries and updates tickets without an LLM", async () => {
  // 单元验证：绕过 HTTP/Supervisor，直接检查专业 Agent 的三种业务动作。
  const agent = new TicketHandlerAgent();
  const createdState = createState("ticket-user", "ticket-session", "我要提交退款工单");
  await agent.process(createdState);
  const ticketId = createdState.sub_results.ticket_handler.match(/TK-\d{8}-\d{4}/)?.[0];
  assert.ok(ticketId);

  const queriedState = createState("ticket-user", "ticket-session", `查询工单 ${ticketId} 状态`);
  await agent.process(queriedState);
  assert.match(queriedState.sub_results.ticket_handler, /状态: created/);

  const updatedState = createState("ticket-user", "ticket-session", `将工单 ${ticketId} 更新为已解决`);
  await agent.process(updatedState);
  assert.match(updatedState.sub_results.ticket_handler, /状态已更新为 resolved/);
  assert.equal(agent.getTicketsByUser("ticket-user")[0].status, "resolved");
});

test("MCP validates arguments and executes tools", async () => {
  // 第一部分证明 required 校验生效；第二部分证明 JSON-RPC 信封被正确映射到工具调用。
  const invalid = await application.mcpServer.callTool("risk_check", { user_id: "u1" });
  assert.equal(invalid.success, false);
  assert.match(invalid.error, /action/);

  const valid = await application.mcpServer.handleJsonRpc({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "risk_check", arguments: { user_id: "u1", action: "transfer", amount: 60000 } },
  });
  assert.equal(valid.id, 7);
  assert.equal(valid.result.result.risk_level, "high");
});

test("compliance checker identifies and masks PII", () => {
  const result = application.agents.complianceAgent.check("客户手机号是13812345678");
  assert.equal(result.passed, false);
  assert.equal(result.risk_level, "high");
  assert.equal(result.sanitized_content, "客户手机号是138*****678");
});

test("configured LLM participates in routing, RAG and deep compliance", async () => {
  // Fake LLM 不访问网络，但实现了 Agent 依赖的两个接口：withStructuredOutput 和 invoke。
  const fakeLlm = {
    withStructuredOutput(_schema, { name }) {
      // name 对应各 Agent 创建结构化 Runnable 时指定的任务名，据此返回不同固定结果。
      const outputs = {
        intent_result: {
          suggested_agent: "knowledge_rag",
          primary_intent: "consultation",
          secondary_intent: "product_inquiry",
          confidence: 0.99,
          entities: { product: "理财产品A" },
        },
        document_ranking: { indices: [0] },
        compliance_result: {
          passed: true,
          risk_level: "low",
          violations: [],
          suggestions: [],
        },
      };
      return { invoke: async () => outputs[name] };
    },
    async invoke(messages) {
      // 普通 invoke 同时服务 Query Rewrite 和 Answer Generate，通过 Prompt 内容区分阶段。
      const serialized = JSON.stringify(messages);
      return serialized.includes("改写为适合检索")
        ? { content: "理财产品 投资期限" }
        : { content: "LLM生成回答（来源：product_faq.md）" };
    },
  };

  const llmApplication = createApplication({ llm: fakeLlm });
  const state = createState("llm-user", "llm-session", "理财产品投资期限多久？");
  const result = await llmApplication.supervisor.orchestrate(state);
  assert.equal(result.intent, "knowledge_rag");
  assert.equal(result.compliance_passed, true);
  assert.match(result.final_response, /LLM生成回答/);
  await llmApplication.close();
});

test("long-term memory prefers embedding similarity when configured", async () => {
  // 二维固定向量让余弦相似度结果完全可预测，证明向量检索优先于关键词降级。
  const embeddings = {
    async embedDocuments() {
      return [[1, 0], [0, 1]];
    },
    async embedQuery() {
      return [0, 1];
    },
  };
  const memory = new LongTermMemory({ embeddings });
  memory.addDocument("第一篇文档", "first.md");
  memory.addDocument("第二篇文档", "second.md");

  const results = await memory.search("目标查询", 1);
  assert.equal(results[0].source, "second.md");
  assert.equal(results[0].score, 1);
});
