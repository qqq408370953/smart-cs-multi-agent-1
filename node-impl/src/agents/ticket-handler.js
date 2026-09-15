import { trace } from "../tracing/tracer.js";
import { z } from "zod";

/** 工单处理Agent：负责创建、查询和更新当前进程内的演示工单。 */
export class TicketHandlerAgent {
  #tickets = new Map();
  #counter = 0;

  constructor(llm = null) {
    this.llm = llm;
  }

  async analyzeRequest(message, { useLlm = true } = {}) {
    const ticketId = message.match(/TK-\d{8}-[A-Z0-9]{4,8}/i)?.[0]?.toUpperCase();
    if (!this.llm || !useLlm) {
      const isUpdate = Boolean(ticketId && /更新|修改|设为|关闭|解决|处理中|待审核|升级/.test(message));
      const status = /关闭/.test(message)
        ? "closed"
        : /已解决|解决/.test(message)
          ? "resolved"
          : /待审核/.test(message)
            ? "pending_review"
            : /升级/.test(message)
              ? "escalated"
              : /处理中/.test(message)
                ? "processing"
                : undefined;
      return {
        action: isUpdate ? "update" : ticketId && /查询|进度|状态/.test(message) ? "query" : "create",
        ticket_id: ticketId,
        ticket_type: /退款|退货/.test(message) ? "refund" : /理赔/.test(message) ? "claim" : /开户/.test(message) ? "account_open" : /投诉/.test(message) ? "complaint" : "general",
        priority: /盗刷|资金安全|紧急/.test(message) ? "urgent" : /超时|争议/.test(message) ? "high" : "medium",
        summary: message.slice(0, 100),
        details: message,
        status,
      };
    }

    const analyzer = this.llm.withStructuredOutput(z.object({
      action: z.enum(["create", "query", "update"]),
      ticket_id: z.string().optional(),
      ticket_type: z.enum(["refund", "claim", "account_open", "account_change", "complaint", "general"]),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      summary: z.string(),
      details: z.string(),
      status: z.enum(["created", "processing", "pending_review", "resolved", "closed", "escalated"]).optional(),
    }), { name: "ticket_request" });
    return analyzer.invoke([
      ["system", "你是工单处理Agent。分析用户请求，决定创建、查询或更新工单，并提取工单号、类型、优先级、摘要和详情。"],
      ["human", message],
    ]);
  }

  /** 根据用户请求创建工单，并生成适合客服场景的确认回复。 */
  async process(state) {
    return trace("ticket_handler", "process", async () => {
      let info;
      try {
        info = await this.analyzeRequest(state.user_message);
      } catch (error) {
        console.warn(`[TicketHandler] LLM分析失败，降级为规则分析: ${error.message}`);
        info = await this.analyzeRequest(state.user_message, { useLlm: false });
      }

      if (info.action === "query" && info.ticket_id) {
        const ticket = this.getTicket(info.ticket_id);
        state.sub_results.ticket_handler = ticket
          ? `工单查询结果：\n\n工单号: ${ticket.id}\n状态: ${ticket.status}\n类型: ${ticket.type}\n摘要: ${ticket.summary}\n更新时间: ${ticket.updated_at}`
          : `未找到工单号 ${info.ticket_id}，请确认工单号是否正确。`;
        return state;
      }

      if (info.action === "update" && info.ticket_id && info.status) {
        const ticket = this.updateStatus(info.ticket_id, info.status);
        state.sub_results.ticket_handler = ticket
          ? `工单 ${ticket.id} 状态已更新为 ${ticket.status}。`
          : `未找到工单号 ${info.ticket_id}，无法更新。`;
        return state;
      }

      const ticket = this.createTicket(
        state.user_id,
        info.summary || state.user_message,
        info.priority,
        info.ticket_type,
        info.details,
      );
      const priorityLabels = { low: "普通", medium: "中等", high: "高", urgent: "紧急" };
      state.sub_results.ticket_handler = `工单已创建成功！\n\n工单号: ${ticket.id}\n类型: ${ticket.type}\n状态: 已创建\n优先级: ${priorityLabels[ticket.priority] || ticket.priority}\n摘要: ${ticket.summary}\n创建时间: ${ticket.created_at}\n\n我们将尽快处理您的请求，请保存好工单号以便后续查询。`;
      return state;
    });
  }

  /**
   * 创建工单的公共能力，同时供Agent流程和MCP ticket_create工具复用。
   * 生产环境应将存储替换为数据库，并使用全局唯一ID生成策略。
   */
  createTicket(userId, summary, priority = "medium", type = "general", details = summary) {
    this.#counter += 1;
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replaceAll("-", "");
    const id = `TK-${date}-${String(this.#counter).padStart(4, "0")}`;
    const ticket = {
      id,
      user_id: userId,
      type,
      summary,
      details,
      priority,
      status: "created",
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.#tickets.set(id, ticket);
    return { ...ticket };
  }

  /** 按工单号查询；返回副本，避免调用方修改内部状态。 */
  getTicket(ticketId) {
    const ticket = this.#tickets.get(ticketId);
    return ticket ? { ...ticket } : null;
  }

  /** 查询某个用户的全部工单，按创建时间倒序返回。 */
  getTicketsByUser(userId) {
    return [...this.#tickets.values()]
      .filter((ticket) => ticket.user_id === userId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map((ticket) => ({ ...ticket }));
  }

  /** 更新工单状态，返回更新后的副本。 */
  updateStatus(ticketId, status) {
    const ticket = this.#tickets.get(ticketId);
    if (!ticket) return null;
    ticket.status = status;
    ticket.updated_at = new Date().toISOString();
    return { ...ticket };
  }
}
