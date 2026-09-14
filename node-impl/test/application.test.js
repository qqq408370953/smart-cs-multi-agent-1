import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApplication } from "../src/app.js";

const application = createApplication();
let baseUrl;

before(async () => {
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => application.server.close(resolve));
});

test("health endpoint reports the Node runtime", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "healthy", version: "1.0.0", runtime: "node" });
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
