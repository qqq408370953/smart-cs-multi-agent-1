export class MCPToolServer {
  #tools = new Map();
  #callLog = [];

  register(tool) {
    if (!tool?.name || typeof tool.handler !== "function") {
      throw new TypeError("MCP tool requires a name and handler");
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  listTools(category) {
    return [...this.#tools.values()]
      .filter((tool) => !category || tool.category === category)
      .map(({ handler: _handler, inputSchema, ...tool }) => ({ ...tool, inputSchema }));
  }

  async callTool(name, arguments_ = {}) {
    const tool = this.#tools.get(name);
    const startedAt = performance.now();
    let response;
    try {
      if (!tool) throw new Error(`Tool '${name}' not found`);
      this.#validate(tool.inputSchema, arguments_);
      response = { success: true, result: await tool.handler(arguments_), error: null };
    } catch (error) {
      response = { success: false, result: null, error: error.message };
    }

    response.duration_ms = performance.now() - startedAt;
    this.#callLog.push({
      tool: name,
      success: response.success,
      duration_ms: response.duration_ms,
      timestamp: new Date().toISOString(),
      error: response.error,
    });
    this.#callLog = this.#callLog.slice(-100);
    return response;
  }

  async handleJsonRpc(request) {
    const id = request?.id ?? null;
    if (request?.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" }, id };
    }
    if (request.method === "ping") return { jsonrpc: "2.0", result: { status: "ok" }, id };
    if (request.method === "tools/list") {
      return { jsonrpc: "2.0", result: this.listTools(request.params?.category), id };
    }
    if (request.method === "tools/call") {
      const result = await this.callTool(request.params?.name ?? "", request.params?.arguments ?? {});
      return { jsonrpc: "2.0", result, id };
    }
    return { jsonrpc: "2.0", error: { code: -32601, message: `Method not found: ${request.method}` }, id };
  }

  getCallLog(lastN = 20) {
    return structuredClone(this.#callLog.slice(-lastN));
  }

  #validate(schema, arguments_) {
    for (const field of schema?.required ?? []) {
      if (arguments_[field] === undefined || arguments_[field] === "") {
        throw new Error(`Missing required argument: ${field}`);
      }
    }
  }
}

export function createDefaultTools(server, { ticketAgent } = {}) {
  return server
    .register({
      name: "order_query",
      description: "查询订单信息，支持按订单号或用户ID查询",
      inputSchema: { type: "object", properties: { order_id: { type: "string" }, user_id: { type: "string" } } },
      category: "order",
      handler: async ({ order_id = "ORD-20260401-001" }) => ({
        order_id,
        status: "shipped",
        amount: 299,
        product: "智能理财产品A",
        created_at: "2026-04-01T10:00:00Z",
      }),
    })
    .register({
      name: "knowledge_search",
      description: "搜索企业知识库，返回相关文档片段",
      inputSchema: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer", default: 3 } }, required: ["query"] },
      category: "knowledge",
      handler: async ({ query }) => [{ content: `关于'${query}'的知识库文档片段`, source: "FAQ.md", score: 0.95 }],
    })
    .register({
      name: "ticket_create",
      description: "创建客服工单",
      inputSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, priority: { type: "string" } }, required: ["title", "description"] },
      category: "ticket",
      handler: async ({ title, description, priority = "medium" }) => {
        const ticket = ticketAgent.createTicket("mcp-user", `${title}: ${description}`, priority);
        return { ticket_id: ticket.id, title, status: ticket.status, priority: ticket.priority };
      },
    })
    .register({
      name: "risk_check",
      description: "风控接口 — 检查交易或操作的风险等级",
      inputSchema: { type: "object", properties: { user_id: { type: "string" }, action: { type: "string" }, amount: { type: "number" } }, required: ["user_id", "action"] },
      category: "compliance",
      handler: async ({ user_id, action, amount = 0 }) => {
        const riskLevel = amount > 50000 ? "high" : amount > 10000 ? "medium" : "low";
        return { user_id, action, risk_level: riskLevel, requires_manual_review: riskLevel === "high" };
      },
    });
}
