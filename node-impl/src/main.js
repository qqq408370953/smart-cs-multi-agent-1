import { createApplication } from "./app.js";

// Node.js服务入口：读取环境变量，启动组合后的应用。
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8100);
const application = createApplication();
const { server } = application;

server.listen(port, host, () => {
  console.info(`智能客服多Agent系统(Node.js) 启动在 http://${host}:${port}`);
});

function shutdown(signal) {
  // 停止接收新请求，等待已有连接结束，方便容器优雅退出。
  console.info(`收到 ${signal}，正在停止服务...`);
  server.close(async (error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    await application.close();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
