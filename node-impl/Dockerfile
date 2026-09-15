FROM node:22-alpine

# 容器内统一工作目录；后续 COPY 和启动命令都相对此目录执行。
WORKDIR /app
# 先复制依赖清单再安装，源码变化时仍可复用 Docker 的依赖缓存层。
COPY package.json package-lock.json ./
# npm ci 严格按 lock 文件安装；omit=dev 不安装开发期依赖，减小生产镜像。
RUN npm ci --omit=dev
# 只复制运行所需源码，避免把宿主机 node_modules 或无关文档带入镜像。
COPY src ./src

# 告诉库和工具当前运行在生产模式；具体是否读取由各依赖决定。
ENV NODE_ENV=production
# EXPOSE 是镜像元数据；真正的宿主机端口映射由 docker run/compose 配置。
EXPOSE 8100
# Node 作为 PID 1 启动，SIGTERM 会交给 main.js 的优雅退出逻辑处理。
CMD ["node", "src/main.js"]
