/**
 * MCP工具服务端的Node.js实现。
 * 支持工具注册/发现/调用、基础参数校验、JSON-RPC 2.0与调用日志。
 *
 * 术语关联：
 * - MCP（Model Context Protocol）描述“有哪些工具、参数是什么、怎样调用”；
 * - Agent 决定“何时、为何使用某种能力”；
 * - LangGraph 决定“多个步骤以什么顺序执行”；
 * - JSON-RPC 2.0 是当前 MCP HTTP 入口使用的请求/响应信封格式。
 * 当前演示项目暴露了 MCP 工具，但业务 Agent 尚未通过模型自动选择这些工具。
 */
export class MCPToolServer {
  #tools = new Map();
  #callLog = [];

  /** 注册工具并返回this，支持链式装配默认工具。 */
  register(tool) {
    // name 用作唯一索引，handler 是实际执行函数；同名注册会覆盖旧工具。
    if (!tool?.name || typeof tool.handler !== "function") {
      throw new TypeError("MCP tool requires a name and handler");
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  /** 返回不包含handler实现的公开工具Schema。 */
  listTools(category) {
    // handler 是进程内函数，不属于协议 Schema，也不能序列化给远端客户端。
    return [...this.#tools.values()]
      .filter((tool) => !category || tool.category === category)
      .map(({ handler: _handler, inputSchema, ...tool }) => ({ ...tool, inputSchema }));
  }

  /** 校验参数、调用handler，并把结果写入最近100条审计日志。 */
  async callTool(name, arguments_ = {}) {
    const tool = this.#tools.get(name);
    const startedAt = performance.now();
    let response;
    try {
      // 工具不存在和参数不合法都转成统一 success:false 响应，而不是抛到 HTTP 层。
      if (!tool) throw new Error(`Tool '${name}' not found`);
      this.#validate(tool.inputSchema, arguments_);
      // handler 可以是同步或异步函数，await 对两者都适用。
      response = { success: true, result: await tool.handler(arguments_), error: null };
    } catch (error) {
      response = { success: false, result: null, error: error.message };
    }

    // 审计日志只保留结果摘要，不记录 arguments，避免未来把敏感参数写入日志。
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

  /** 处理MCP使用的JSON-RPC 2.0 ping/tools/list/tools/call请求。 */
  async handleJsonRpc(request) {
    // JSON-RPC 的 id 用来让客户端把异步响应对应回原请求；通知请求可能没有 id。
    const id = request?.id ?? null;
    if (request?.jsonrpc !== "2.0") {
      // -32600 和 -32601 是 JSON-RPC 标准错误码：无效请求、方法不存在。
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
    // 当前只实现 required 校验，尚未覆盖类型、范围、additionalProperties 等完整 JSON Schema。
    for (const field of schema?.required ?? []) {
      if (arguments_[field] === undefined || arguments_[field] === "") {
        throw new Error(`Missing required argument: ${field}`);
      }
    }
  }
}

/**
 * 注册与其他语言版本对应的四个默认工具。
 * handler当前返回演示数据，生产环境应改为调用订单、知识库、工单和风控服务。
 */
export function createDefaultTools(server, { ticketAgent } = {}) {
  // 链式 register 返回同一个 server，最后得到已经注册四个工具的 MCPToolServer。
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
