import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApplication } from "../src/app.js";
import { createState } from "../src/agents/state.js";
import { TicketHandlerAgent } from "../src/agents/ticket-handler.js";
import { LongTermMemory } from "../src/memory/long-term.js";

const application = createApplication();
let baseUrl;

before(async () => {
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
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
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "我需要申请退款", user_id: "user-1", session_id: "session-1" }),
  });
  const body = await response.json();
  assert.equal(body.intent, "ticket_handler");
  assert.equal(body.compliance_passed, true);
  assert.match(body.response, /TK-\d{8}-0001/);

  const history = await (await fetch(`${baseUrl}/api/history/session-1`)).json();
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].role, "user");
  assert.equal(history.messages[1].role, "assistant");

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
  const fakeLlm = {
    withStructuredOutput(_schema, { name }) {
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
