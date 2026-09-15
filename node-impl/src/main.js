// main.js 只负责“进程生命周期”，具体 Agent 依赖组装集中在 app.js。
// 这种分层叫 Composition Root（组合根）：入口保持简单，测试可绕过监听端口直接创建应用。
import { createApplication } from "./app.js";

// Node.js服务入口：读取环境变量，启动组合后的应用。
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8100);
// createApplication 会创建 LLM、三层记忆、全部 Agent、LangGraph、MCP 和 HTTP Server。
const application = createApplication();
const { server } = application;

server.listen(port, host, () => {
  console.info(`智能客服多Agent系统(Node.js) 启动在 http://${host}:${port}`);
});

function shutdown(signal) {
  // 停止接收新请求，等待已有连接结束，方便容器优雅退出。
  console.info(`收到 ${signal}，正在停止服务...`);
  server.close(async (error) => {
    // server.close 先停止接受新连接，并等待正在处理的请求结束。
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    // application.close 继续释放 Redis 和 OpenTelemetry 等外部资源。
    await application.close();
  });
}

// SIGINT 通常来自 Ctrl+C，SIGTERM 通常来自 Docker/Kubernetes 停止容器。
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
