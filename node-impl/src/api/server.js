// 使用 Node.js 原生 HTTP，便于学习协议边界；生产项目也可以替换成 Express/Fastify。
import { createServer } from "node:http";
// 未传 session_id 时由服务端生成随机 UUID，避免不同匿名请求意外共享状态。
import { randomUUID } from "node:crypto";
import { createState } from "../agents/state.js";
import { getMetrics } from "../tracing/tracer.js";

// 防止客户端通过超大JSON请求持续占用服务内存。
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 输出统一 JSON 响应，并为本地前端联调开放 CORS。
 * CORS 是浏览器的跨源访问控制；前端在 8200、后端在 8100，因此必须返回允许跨源的响应头。
 */
function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(body));
}

/** 流式读取并解析请求体，超过1 MiB或JSON非法时返回客户端错误。 */
async function readJson(request) {
  const chunks = [];
  let length = 0;
  // Node Request 是异步可迭代的字节流。逐块读取时同步累计大小，避免先收完超大请求再拒绝。
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    // Buffer.concat 将二进制块合并，随后按 UTF-8 解码并解析 JSON。
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求体必须是有效的 JSON"), { statusCode: 400 });
  }
}

/**
 * 创建原生Node.js HTTP服务。
 * API覆盖聊天、SSE、会话历史、MCP工具、指标和健康检查。
 */
export function createApiServer({ supervisor, shortTermMemory, mcpServer }) {
  return createServer(async (request, response) => {
    // 浏览器正式跨域 POST 前可能先发送 OPTIONS 预检请求。
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return response.end();
    }

    try {
      // request.url 只有路径，需要提供占位 origin 才能使用 WHATWG URL API。
      const url = new URL(request.url, "http://localhost");

      // 健康检查不依赖模型、Redis 或 Agent，主要用于容器探活和启动确认。
      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          status: "healthy",
          version: "1.1.0",
          runtime: "node",
          orchestration: "langgraph",
        });
      }

      // 工具发现：列出 MCP Schema，不暴露真正的 handler 函数。
      if (request.method === "GET" && url.pathname === "/api/tools") {
        return sendJson(response, 200, { tools: mcpServer.listTools(url.searchParams.get("category")) });
      }

      // 可观测性接口：聚合 Agent 指标与最近 MCP 调用审计。
      if (request.method === "GET" && url.pathname === "/api/metrics") {
        return sendJson(response, 200, {
          agent_metrics: getMetrics(),
          tool_call_log: mcpServer.getCallLog(20),
        });
      }

      // 短期记忆接口。这里看到的是用户/助手消息，不是 LangGraph Checkpoint。
      const historyMatch = request.method === "GET" && url.pathname.match(/^\/api\/history\/([^/]+)$/);
      if (historyMatch) {
        const sessionId = decodeURIComponent(historyMatch[1]);
        return sendJson(response, 200, {
          session_id: sessionId,
          messages: await shortTermMemory.getHistory(sessionId),
        });
      }

      // 普通 REST 风格的工具调用入口，便于不支持 JSON-RPC 的客户端使用。
      if (request.method === "POST" && url.pathname === "/api/tools/call") {
        const body = await readJson(request);
        return sendJson(response, 200, await mcpServer.callTool(body.name ?? "", body.arguments ?? {}));
      }

      // 标准化的 MCP JSON-RPC 入口，支持 ping、tools/list 和 tools/call。
      if (request.method === "POST" && url.pathname === "/mcp") {
        return sendJson(response, 200, await mcpServer.handleJsonRpc(await readJson(request)));
      }

      // /api/chat 返回普通 JSON；/api/chat/stream 通过 SSE 返回事件。
      if (request.method === "POST" && ["/api/chat", "/api/chat/stream"].includes(url.pathname)) {
        const body = await readJson(request);
        // 在进入 Agent 之前做 API 层参数校验，避免无效 State 传播进整个图。
        if (typeof body.message !== "string" || body.message.trim() === "") {
          return sendJson(response, 400, { error: "message 是必填的非空字符串" });
        }

        // sessionId 同时关联短期聊天历史和 LangGraph thread；userId 关联业务身份/工单归属。
        const sessionId = body.session_id || randomUUID();
        const userId = body.user_id || "anonymous";
        // 步骤 1：先保存用户消息。即使后续 Agent 失败，也保留收到请求的事实。
        await shortTermMemory.addMessage(sessionId, "user", body.message);
        // 步骤 2：创建这一次图运行的初始共享 State。
        const state = createState(userId, sessionId, body.message);
        // 步骤 3：Supervisor.invoke 会完整执行“路由→业务→合规→合成”。
        const result = await supervisor.orchestrate(state);
        // 步骤 4：图成功结束后，把最终答复保存为短期记忆的 assistant 消息。
        await shortTermMemory.addMessage(sessionId, "assistant", result.final_response);

        // 步骤 5：只向外暴露稳定 API 字段，不把整个内部 State/sub_results 泄露给客户端。
        const payload = {
          response: result.final_response,
          session_id: sessionId,
          intent: result.intent,
          compliance_passed: result.compliance_passed,
        };

        // SSE（Server-Sent Events）是服务端到浏览器的单向事件流。
        // 当前只发送一个完整 result，并非逐 Token 流式；以后可监听 LangGraph/LLM 事件持续 write。
        if (url.pathname.endsWith("/stream")) {
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          });
          response.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
          return response.end();
        }

        return sendJson(response, 200, payload);
      }

      // 没有匹配任何路由时返回 404，而不是让请求静默成功。
      return sendJson(response, 404, { error: "Not Found" });
    } catch (error) {
      // 已知客户端错误保留具体信息；未知内部错误只返回通用文案，避免泄露堆栈和内部结构。
      console.error(error);
      return sendJson(response, error.statusCode ?? 500, {
        error: error.statusCode ? error.message : "处理失败，请稍后重试",
      });
    }
  });
}
