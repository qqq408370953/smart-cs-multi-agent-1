import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createState } from "../agents/state.js";
import { getMetrics } from "../tracing/tracer.js";

// 防止客户端通过超大JSON请求持续占用服务内存。
const MAX_BODY_BYTES = 1024 * 1024;

/** 输出统一JSON响应，并为本地前端联调开放CORS。 */
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
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
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
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return response.end();
    }

    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, {
          status: "healthy",
          version: "1.1.0",
          runtime: "node",
          orchestration: "langgraph",
        });
      }

      if (request.method === "GET" && url.pathname === "/api/tools") {
        return sendJson(response, 200, { tools: mcpServer.listTools(url.searchParams.get("category")) });
      }

      if (request.method === "GET" && url.pathname === "/api/metrics") {
        return sendJson(response, 200, {
          agent_metrics: getMetrics(),
          tool_call_log: mcpServer.getCallLog(20),
        });
      }

      const historyMatch = request.method === "GET" && url.pathname.match(/^\/api\/history\/([^/]+)$/);
      if (historyMatch) {
        const sessionId = decodeURIComponent(historyMatch[1]);
        return sendJson(response, 200, {
          session_id: sessionId,
          messages: await shortTermMemory.getHistory(sessionId),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/tools/call") {
        const body = await readJson(request);
        return sendJson(response, 200, await mcpServer.callTool(body.name ?? "", body.arguments ?? {}));
      }

      if (request.method === "POST" && url.pathname === "/mcp") {
        return sendJson(response, 200, await mcpServer.handleJsonRpc(await readJson(request)));
      }

      if (request.method === "POST" && ["/api/chat", "/api/chat/stream"].includes(url.pathname)) {
        const body = await readJson(request);
        if (typeof body.message !== "string" || body.message.trim() === "") {
          return sendJson(response, 400, { error: "message 是必填的非空字符串" });
        }

        const sessionId = body.session_id || randomUUID();
        const userId = body.user_id || "anonymous";
        await shortTermMemory.addMessage(sessionId, "user", body.message);
        const state = createState(userId, sessionId, body.message);
        const result = await supervisor.orchestrate(state);
        await shortTermMemory.addMessage(sessionId, "assistant", result.final_response);

        const payload = {
          response: result.final_response,
          session_id: sessionId,
          intent: result.intent,
          compliance_passed: result.compliance_passed,
        };

        // 当前SSE一次发送完整结果；接入流式LLM后可在此持续写入token事件。
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

      return sendJson(response, 404, { error: "Not Found" });
    } catch (error) {
      console.error(error);
      return sendJson(response, error.statusCode ?? 500, {
        error: error.statusCode ? error.message : "处理失败，请稍后重试",
      });
    }
  });
}
