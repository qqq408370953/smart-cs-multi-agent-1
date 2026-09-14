import { trace } from "../tracing/tracer.js";

export class TicketHandlerAgent {
  #tickets = new Map();
  #counter = 0;

  async process(state) {
    return trace("ticket_handler", "process", async () => {
      const ticket = this.createTicket(state.user_id, state.user_message);
      state.sub_results.ticket_handler = [
        "工单已创建成功！",
        `工单号: ${ticket.id}`,
        "状态: 已创建",
        "优先级: 中等",
        `创建时间: ${ticket.created_at}`,
        "我们将尽快处理您的请求，请保存好工单号以便后续查询。",
      ].join("\n\n");
      return state;
    });
  }

  createTicket(userId, summary, priority = "medium") {
    this.#counter += 1;
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replaceAll("-", "");
    const id = `TK-${date}-${String(this.#counter).padStart(4, "0")}`;
    const ticket = {
      id,
      user_id: userId,
      summary,
      priority,
      status: "created",
      created_at: now.toISOString(),
    };
    this.#tickets.set(id, ticket);
    return { ...ticket };
  }

  getTicket(ticketId) {
    const ticket = this.#tickets.get(ticketId);
    return ticket ? { ...ticket } : null;
  }
}
