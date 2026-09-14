import { createApplication } from "./app.js";

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8100);
const { server } = createApplication();

server.listen(port, host, () => {
  console.info(`智能客服多Agent系统(Node.js) 启动在 http://${host}:${port}`);
});

function shutdown(signal) {
  console.info(`收到 ${signal}，正在停止服务...`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
