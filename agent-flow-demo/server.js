// 这个文件只提供静态页面，不参与 Agent 推理。真正的 Agent 服务位于 node-impl:8100。
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.url 是 ESM 模块地址；转换后得到 dist 的绝对文件系统路径。
const root = fileURLToPath(new URL("./dist/", import.meta.url));
const port = Number(process.env.PORT || 8200);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

createServer(async (request, response) => {
  try {
    // 浏览器访问 / 时返回 index.html，其他 URL 映射到 dist 下的静态资源。
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = normalize(join(root, relativePath));
    // normalize + startsWith 防御 ../ 路径穿越，确保只能读取 dist 内文件。
    if (!filePath.startsWith(root)) throw new Error("Invalid path");
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not found");
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    // 使用 Stream 管道发送文件，避免把较大静态资源一次性读入内存。
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  }
}).listen(port, "0.0.0.0", () => {
  console.info(`Agent流程学习Demo启动在 http://localhost:${port}`);
});
