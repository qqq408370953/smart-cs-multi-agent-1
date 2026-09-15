# Agent Flow Lab

面向学习者的智能客服Agent执行流程可视化客户端。它不复制后端业务逻辑，而是调用`node-impl`的真实API，再将一次完整请求拆成八个可观察步骤。

## 功能

- 产品咨询、退款工单、账户安全、合规拦截四个场景按钮
- 单步执行、点击指定步骤、自动播放和重置
- LangGraph节点的等待、执行、完成与未选分支状态
- 实时查看共享State、接口Result和事件日志
- 验证健康检查、意图路由、业务Agent、合规、最终响应、会话历史、指标与MCP工具
- 支持修改API地址和自定义用户消息
- 响应式布局，可在桌面和移动端使用
- 支持时注册`run_agent_flow_demo` WebMCP工具

## 启动

先启动Agent后端：

```bash
cd ../node-impl
npm start
```

再开一个终端启动前端：

```bash
cd ../agent-flow-demo
npm start
```

浏览器访问：

```text
http://localhost:8200
```

默认连接`http://localhost:8100`。如后端运行在其他地址，可直接修改页面右上角的Agent API输入框。

## 推荐演示顺序

1. 选择“产品咨询”，使用“执行下一步”逐步观察正常RAG链路。
2. 切换State、Result、Events，比较输入状态、真实响应和事件证据。
3. 选择“退款工单”，观察条件边切换到Ticket Agent。
4. 选择“账户安全”，观察Security分支。
5. 选择“合规拦截”，观察业务回答如何被统一合规出口阻断。
6. 修改消息，测试自己的路由假设。

## 重要说明

`POST /api/chat`会在后端一次性执行完整LangGraph。前端为了教学，将同一次真实结果拆成多个观察阶段；它不会伪造不存在的逐节点HTTP接口。

“会话记忆”步骤读取的是`GET /api/history/:sessionId`短期历史。LangGraph Checkpoint保存在后端`MemorySaver`中，目前没有公开HTTP查询入口，两者不要混为一谈。
