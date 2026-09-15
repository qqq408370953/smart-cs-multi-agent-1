// 工单 Agent 的所有业务入口都经过 trace，记录调用次数、耗时和异常。
import { trace } from "../tracing/tracer.js";
// 使用 Zod 约束 LLM 的工单分析结果，防止模型产生系统不支持的 action/status。
import { z } from "zod";

/**
 * 工单处理 Agent：负责创建、查询和更新工单。
 * 当前用进程内 Map 模拟数据库，因此重启服务后数据清空，也不能跨多个 Node 实例共享。
 * 这个类既被 LangGraph 业务节点调用，也把 createTicket 暴露给 MCP ticket_create 工具复用。
 */
export class TicketHandlerAgent {
  // JavaScript 私有字段：类外无法直接读取或篡改内部工单集合。
  #tickets = new Map();
  // 演示用自增序号，只保证当前进程内不重复。
  #counter = 0;

  constructor(llm = null) {
    // 有模型时做结构化语义分析；无模型或模型失败时使用下面的正则与关键词规则。
    this.llm = llm;
  }

  /**
   * 把自然语言转换成标准工单命令。
   * 标准结果包含 action、ticket_id、ticket_type、priority、summary、details 和可选 status。
   */
  async analyzeRequest(message, { useLlm = true } = {}) {
    // 首先尝试提取工单号。后续“查询/更新”只有携带合法编号才可能成立。
    const ticketId = message.match(/TK-\d{8}-[A-Z0-9]{4,8}/i)?.[0]?.toUpperCase();
    if (!this.llm || !useLlm) {
      // 本地分析第 1 步：同时含工单号与更新类动词时，判定为 update。
      const isUpdate = Boolean(ticketId && /更新|修改|设为|关闭|解决|处理中|待审核|升级/.test(message));
      // 本地分析第 2 步：把中文状态表达归一化成系统内部枚举。
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
        // update 优先级最高；否则“有编号 + 查询类词语”为 query，其余情况创建新工单。
        action: isUpdate ? "update" : ticketId && /查询|进度|状态/.test(message) ? "query" : "create",
        ticket_id: ticketId,
        // 工单类型与优先级同样使用确定性关键词推断。
        ticket_type: /退款|退货/.test(message) ? "refund" : /理赔/.test(message) ? "claim" : /开户/.test(message) ? "account_open" : /投诉/.test(message) ? "complaint" : "general",
        priority: /盗刷|资金安全|紧急/.test(message) ? "urgent" : /超时|争议/.test(message) ? "high" : "medium",
        summary: message.slice(0, 100),
        details: message,
        status,
      };
    }

    // LLM 模式：要求模型直接返回业务可以执行的结构化命令。
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

  /**
   * LangGraph 业务节点执行流程：
   * 1. 分析用户请求；模型失败则改用本地规则；
   * 2. 根据 action 进入 query、update 或 create；
   * 3. 将可读结果写入 state.sub_results.ticket_handler；
   * 4. 返回 State，下一站固定是合规节点。
   */
  async process(state) {
    return trace("ticket_handler", "process", async () => {
      let info;
      try {
        info = await this.analyzeRequest(state.user_message);
      } catch (error) {
        // 包括网络超时、模型返回不符合 Zod Schema 等异常。
        console.warn(`[TicketHandler] LLM分析失败，降级为规则分析: ${error.message}`);
        info = await this.analyzeRequest(state.user_message, { useLlm: false });
      }

      if (info.action === "query" && info.ticket_id) {
        // 查询不会改变工单，只把结果格式化成客服回复。
        const ticket = this.getTicket(info.ticket_id);
        state.sub_results.ticket_handler = ticket
          ? `工单查询结果：\n\n工单号: ${ticket.id}\n状态: ${ticket.status}\n类型: ${ticket.type}\n摘要: ${ticket.summary}\n更新时间: ${ticket.updated_at}`
          : `未找到工单号 ${info.ticket_id}，请确认工单号是否正确。`;
        return state;
      }

      if (info.action === "update" && info.ticket_id && info.status) {
        // 更新必须同时具备工单号和目标状态；否则会落入创建逻辑。
        const ticket = this.updateStatus(info.ticket_id, info.status);
        state.sub_results.ticket_handler = ticket
          ? `工单 ${ticket.id} 状态已更新为 ${ticket.status}。`
          : `未找到工单号 ${info.ticket_id}，无法更新。`;
        return state;
      }

      // 既不是完整 query 也不是完整 update 时，按创建请求处理。
      const ticket = this.createTicket(
        state.user_id,
        info.summary || state.user_message,
        info.priority,
        info.ticket_type,
        info.details,
      );
      // 内部使用英文枚举便于程序处理，对用户回复时转换成中文标签。
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
    // 日期 + 当前进程序号组成演示 ID。真实系统应使用数据库序列或分布式 ID。
    this.#counter += 1;
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replaceAll("-", "");
    const id = `TK-${date}-${String(this.#counter).padStart(4, "0")}`;
    // created_at 永不改变；updated_at 会在状态更新时刷新。
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
    // 内部保存原对象，但向调用者返回浅拷贝，减少外部意外修改内部存储的风险。
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
    // 直接修改 Map 中保存的对象，然后刷新更新时间。
    ticket.status = status;
    ticket.updated_at = new Date().toISOString();
    return { ...ticket };
  }
}
