// 课程数据与 UI 渲染分离：本文件描述知识点，app.js 负责交互和真实 API 请求。
const githubRoot = "https://github.com/qqq408370953/smart-cs-multi-agent-1/blob/main/node-impl";

function source(file, lines, title, code) {
  // 生成源码卡片及 GitHub 深链。lines 用于教学提示，源文件增加注释后可能产生少量偏移；
  // 跳转后建议按卡片中的方法名搜索，而不是只依赖绝对行号。
  const firstLine = lines.match(/\d+/)?.[0] || "1";
  return {
    file: `node-impl/${file}`,
    lines,
    title,
    code,
    url: `${githubRoot}/${file}#L${firstLine}`,
  };
}

export const learningPhases = [
  { id: "foundation", label: "基础入口", steps: "01—03", description: "理解请求怎样变成State并选择分支" },
  { id: "intelligence", label: "核心智能", steps: "04—06", description: "理解专业Agent、合规与最终回答" },
  { id: "stateful", label: "状态能力", steps: "07", description: "区分聊天历史与图Checkpoint" },
  { id: "engineering", label: "工程化", steps: "08", description: "用Trace、指标和MCP观察系统" },
];

const lessons = [
  {
    phase: "foundation",
    duration: "8分钟",
    title: "API入口：先确认系统活着",
    goal: "理解HTTP层的职责边界，以及为什么健康检查不应该进入Agent图。",
    does: [
      "前端向GET /health发送请求，确认8100端口上的Node服务可访问。",
      "API层返回版本、Node运行时和langgraph编排标识，不调用任何业务Agent。",
      "前端把连接状态更新为在线，并将原始响应保存到Result.health。",
    ],
    input: "GET /health，无请求体",
    output: '{ status: "healthy", version: "1.1.0", runtime: "node", orchestration: "langgraph" }',
    concepts: [
      ["边界层", "负责HTTP协议、参数和响应格式，不承载意图判断或知识检索。"],
      ["健康检查", "证明进程可响应；它不等于Redis、LLM、OTLP等外部依赖全部健康。"],
      ["CORS", "后端允许本地前端跨端口访问API，配置位于统一JSON响应头。"],
    ],
    sources: [source("src/api/server.js", "46—72", "HTTP服务与健康路由", `export function createApiServer(...) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        status: "healthy",
        version: "1.1.0",
        runtime: "node",
        orchestration: "langgraph",
      });
    }
  });
}`)],
    observe: "执行后看右上角是否显示“1.1.0 在线”，再到Result页确认health对象。",
    exercise: "把后端暂时停止，再点击连接检测，观察前端如何进入错误状态；随后恢复服务。",
    mastery: "能说清楚为什么/health不调用Supervisor，以及健康接口能证明和不能证明什么。",
  },
  {
    phase: "foundation",
    duration: "12分钟",
    title: "创建State：建立Agent共享数据总线",
    goal: "理解LangGraph节点之间不是随意传参，而是围绕统一State Schema协作。",
    does: [
      "API从请求体取得message、user_id和session_id，再调用createState。",
      "用户消息被包装成HumanMessage，供MessagesValue reducer管理消息追加。",
      "intent、sub_results、compliance_passed和final_response被初始化，后续节点只更新自己负责的字段。",
    ],
    input: "user_id + session_id + 用户message",
    output: "包含messages、intent、sub_results、合规状态和当前Agent的完整State对象",
    concepts: [
      ["StateSchema", "声明每个字段的类型和默认值，是整张图的数据契约。"],
      ["MessagesValue", "LangGraph内置消息reducer，节点返回新消息时负责追加，而不是覆盖历史。"],
      ["共享黑板", "sub_results收集各Agent结果，Agent不需要彼此直接引用。"],
    ],
    sources: [
      source("src/agents/state.js", "6—66", "State Schema与初始值", `export const AgentStateSchema = new StateSchema({
  messages: MessagesValue,
  user_id: z.string(),
  session_id: z.string(),
  intent: z.string().default(""),
  sub_results: z.record(z.string(), z.any()).default(() => ({})),
  compliance_passed: z.boolean().default(true),
  final_response: z.string().default(""),
});`),
      source("src/api/server.js", "115—124", "请求转为State并进入图", `const sessionId = body.session_id || randomUUID();
const userId = body.user_id || "anonymous";
await shortTermMemory.addMessage(sessionId, "user", body.message);
const state = createState(userId, sessionId, body.message);
const result = await supervisor.orchestrate(state);`),
    ],
    observe: "切换到State页，对照输入消息检查user_message、session_id和所有初始字段。",
    exercise: "思考如果增加request_id，应放在HTTP局部变量还是State中；判断依据是后续节点是否需要它。",
    mastery: "能解释State、HTTP请求体和聊天历史三者为什么不是同一个对象。",
  },
  {
    phase: "foundation",
    duration: "15分钟",
    title: "意图路由：决定请求走哪条条件边",
    goal: "掌握LLM结构化路由与确定性规则降级两条路径。",
    does: [
      "IntentRouter读取state.user_message，默认候选分支是knowledge_rag。",
      "配置LLM时，用Zod约束模型必须输出三个合法Agent之一及置信度、实体等字段。",
      "没有LLM或调用失败时，对工单词和安全词分别计分；产品咨询没有命中特殊词，因此进入knowledge_rag。",
      "Supervisor用addConditionalEdges把intent映射为具体业务节点。",
    ],
    input: "state.user_message：理财产品的投资期限是多久？",
    output: 'state.intent = "knowledge_rag"；规则模式下confidence = 0.6',
    concepts: [
      ["结构化输出", "用Zod限制LLM结果形状，避免模型返回无法路由的自由文本。"],
      ["降级策略", "外部模型不可用时仍能用规则完成确定性路由。"],
      ["条件边", "图结构根据State中的intent选择唯一业务分支。"],
    ],
    sources: [
      source("src/agents/intent-router.js", "8—78", "LLM分类与规则兜底", `if (this.llm) {
  const classifier = this.llm.withStructuredOutput(schema, {
    name: "intent_result",
  });
  const result = await classifier.invoke(messages);
  state.intent = result.suggested_agent;
}

// LLM不可用时按关键词计分
state.intent = intent;`),
      source("src/agents/supervisor.js", "83—90", "Intent到节点的条件边", `.addConditionalEdges("intent_router", (state) => state.intent, {
  knowledge_rag: "knowledge_rag",
  ticket_handler: "ticket_handler",
  compliance_checker: "security_handler",
})`),
    ],
    observe: "产品咨询应高亮Knowledge RAG；切换退款和账户安全场景，对比Ticket与Security分支。",
    exercise: "在输入中加入“投诉”和“盗刷”，先预测计分结果，再执行验证优先级。",
    mastery: "能说明为什么路由Agent不直接生成最终答复，以及LLM路由为什么仍需要Schema和规则兜底。",
  },
  {
    phase: "intelligence",
    duration: "20分钟",
    title: "专业Agent：让不同能力各司其职",
    goal: "掌握产品咨询的RAG主链路，并能对比Ticket与Security分支。",
    does: [
      "前端在这一步调用一次真实POST /api/chat；后端会原子地跑完整张LangGraph图。",
      "产品咨询进入KnowledgeRAGAgent：Query改写 → Top-5召回 → Top-3重排 → 基于文档生成。",
      "无API Key时，改写和重排直接降级，长期记忆使用中英文关键词检索，最终采用带来源的模板回答。",
      "业务结果写入state.sub_results，交给后续统一合规节点，而不是直接返回HTTP。",
    ],
    input: "带有intent的共享State",
    output: "sub_results.knowledge_rag / ticket_handler / security_guidance",
    concepts: [
      ["专业化Agent", "每个Agent只拥有一种业务职责，便于测试、替换和追踪。"],
      ["RAG", "先检索可信资料再生成回答，减少无依据回答。"],
      ["RetryPolicy", "知识和工单节点最多尝试2次，应对短暂外部调用错误。"],
    ],
    sources: [source("src/agents/knowledge-rag.js", "78—105", "Knowledge RAG主流程", `const rewrittenQuery = await this.rewriteQuery(state.user_message);
documents = await this.longTermMemory.search(rewrittenQuery, 5);
documents = await this.rerankDocuments(rewrittenQuery, documents, 3);
answer = await this.generateAnswer(state.user_message, documents);
state.sub_results.knowledge_rag = answer;`)],
    observe: "在Result.chat中找response和intent；产品咨询回答应包含product_faq.md与“6个月至3年”。",
    exercise: "依次运行四个场景，记录每次实际intent、业务结果形态和最终合规状态。",
    mastery: "能画出RAG四阶段，并说明为什么业务Agent只写sub_results而不直接结束请求。",
  },
  {
    phase: "intelligence",
    duration: "18分钟",
    title: "合规统一出口：任何分支都不能绕过",
    goal: "理解规则快筛、LLM深审和fail-closed最终响应之间的关系。",
    does: [
      "ComplianceChecker先汇总sub_results中的业务字符串，排除自己的历史结果。",
      "规则层检查金融违禁词、手机号、身份证号、银行卡号和邮箱，并生成脱敏文本。",
      "规则通过且配置LLM后，再用结构化输出检查隐性承诺、越权、歧视等语义风险。",
      "检查结果写回compliance_passed和sub_results.compliance，Supervisor据此决定返回业务答复还是安全拒答。",
    ],
    input: "所有业务Agent产生的字符串结果",
    output: "passed、risk_level、violations，以及State中的compliance_passed",
    concepts: [
      ["统一汇聚点", "Knowledge、Ticket和Security都有固定边指向同一个合规节点。"],
      ["两阶段审查", "规则低延迟且确定；LLM覆盖隐含语义，两者职责互补。"],
      ["Fail-closed", "确认违规时不暴露原业务内容，统一返回转人工安全响应。"],
    ],
    sources: [
      source("src/agents/compliance-checker.js", "27—125", "规则与LLM两阶段审查", `const ruleResult = this.check(content);
if (!ruleResult.passed || !this.llm) return ruleResult;

const llmResult = await reviewer.invoke(messages);
state.compliance_passed = result.passed;
state.sub_results.compliance = {
  passed: result.passed,
  risk_level: result.risk_level,
  violations: result.violations,
};`),
      source("src/agents/supervisor.js", "91—97", "全部业务分支汇聚到合规", `.addEdge("knowledge_rag", "compliance_check")
.addEdge("ticket_handler", "compliance_check")
.addEdge("security_handler", "compliance_check")
.addEdge("compliance_check", "synthesize")`),
    ],
    observe: "运行“合规拦截”场景，查看compliance_passed=false以及最终安全响应；再与产品咨询对比。",
    exercise: "解释为什么审查的是Agent输出而不只是用户输入；再设计一条包含手机号的业务输出测试。",
    mastery: "能解释规则审查、LLM审查和Supervisor安全响应分别解决什么风险。",
  },
  {
    phase: "intelligence",
    duration: "10分钟",
    title: "Supervisor合成：把结果变成最终回答",
    goal: "理解业务结果与最终用户响应之间最后一道可控转换。",
    does: [
      "synthesize先读取compliance_passed；未通过时立即返回固定安全响应。",
      "通过时过滤intent_router和compliance等结构化中间结果，只合并业务字符串。",
      "synthesize节点创建AIMessage，MessagesValue将它追加到图消息历史。",
      "API层只从最终State提取response、session_id、intent和compliance_passed返回客户端。",
    ],
    input: "已经过合规审查的完整State",
    output: "final_response + AIMessage + 精简HTTP payload",
    concepts: [
      ["响应合成", "统一决定对用户公开哪些中间结果，避免直接泄露内部结构。"],
      ["安全短路", "合规失败后不再拼接业务文本。"],
      ["API DTO", "HTTP响应只暴露调用方需要的字段，而不是整个内部State。"],
    ],
    sources: [
      source("src/agents/supervisor.js", "73—80, 111—121", "合成节点与安全响应", `.addNode("synthesize", (state) => ({
  current_agent: "supervisor",
  final_response: this.synthesize(state),
  messages: [new AIMessage(finalResponse)],
}))

if (!state.compliance_passed) {
  return "抱歉，您的请求涉及敏感内容，已转交人工客服处理。";
}`),
      source("src/api/server.js", "126—151", "最终HTTP响应字段", `const payload = {
  response: result.final_response,
  session_id: sessionId,
  intent: result.intent,
  compliance_passed: result.compliance_passed,
};`),
    ],
    observe: "State页看final_response和新增AI消息，Result页看HTTP payload，比较内部State与外部响应字段。",
    exercise: "思考调试信息、检索文档和合规violations哪些应该返回普通用户，哪些只应进入内部日志。",
    mastery: "能说明为什么最终响应必须由Supervisor统一合成，而不是直接返回最后一个Agent的输出。",
  },
  {
    phase: "stateful",
    duration: "20分钟",
    title: "记忆与Checkpoint：两种状态不要混淆",
    goal: "区分聊天历史、工作记忆和LangGraph Checkpoint的生命周期与用途。",
    does: [
      "进入图之前，API把用户消息写入ShortTermMemory；图完成后再写入助手消息。",
      "ShortTermMemory优先使用Redis List、LTRIM和EXPIRE；未配置或连接失败时回退进程内Map与TTL。",
      "前端调用GET /api/history/:sessionId读取对话历史，所以会看到user和assistant两条消息。",
      "Supervisor以session_id作为thread_id调用LangGraph，MemorySaver在节点间保存图状态快照；当前API没有公开Checkpoint查询接口。",
    ],
    input: "session_id、用户消息、最终助手消息和图节点State",
    output: "聊天历史列表 + MemorySaver内部Checkpoint序列",
    concepts: [
      ["短期记忆", "面向多轮对话内容，Redis模式支持多实例共享。"],
      ["Checkpoint", "面向图执行状态，可用于恢复、调试和Human-in-the-Loop。"],
      ["thread_id", "LangGraph识别同一状态线程的键，本项目使用session_id。"],
    ],
    sources: [
      source("src/memory/short-term.js", "21—66", "Redis/Map消息读写", `const redis = await this.#getRedis();
if (redis) {
  await redis.rPush(key, JSON.stringify(message));
  await redis.lTrim(key, -this.maxTurns, -1);
  await redis.expire(key, this.ttlSeconds);
}

const raw = await redis.lRange(key, -count, -1);`),
      source("src/agents/supervisor.js", "31—33, 98—107", "MemorySaver与thread_id", `this.checkpointer = checkpointer ?? new MemorySaver();
return graph.compile({ checkpointer: this.checkpointer });

return this.graph.invoke(state, {
  configurable: { thread_id: state.session_id },
});`),
    ],
    observe: "Result.history里应有两条消息。注意这里展示的是短期历史，不要把它误称为Checkpoint列表。",
    exercise: "使用相同session_id再请求一次，观察历史增长；然后思考进程重启后Map和MemorySaver会发生什么。",
    mastery: "能准确比较WorkingMemory、ShortTermMemory和MemorySaver，不再把“保存聊天”与“恢复图”混为一谈。",
  },
  {
    phase: "engineering",
    duration: "18分钟",
    title: "Tracing与MCP：让系统可观察、可扩展",
    goal: "学会用指标证明Agent执行过程，并理解标准化工具注册与调用。",
    does: [
      "trace()为Supervisor和各Agent创建active span，写入Agent名、方法、耗时、成功状态和异常。",
      "未配置OTLP Collector时，OpenTelemetry使用无操作Provider，但本地metrics Map仍持续聚合调用次数、平均耗时和错误率。",
      "前端读取GET /api/metrics，展示当前进程已有的Agent指标和MCP调用日志。",
      "前端通过JSON-RPC tools/list读取4个工具的名称、描述、分类与inputSchema。",
    ],
    input: "Agent执行耗时/异常；JSON-RPC tools/list请求",
    output: "agent_metrics、tool_call_log和4个MCP工具定义",
    concepts: [
      ["Span", "一次可追踪操作；startActiveSpan让嵌套Agent形成上下文关系。"],
      ["OTLP", "把Span导出到Jaeger等Collector的协议；本项目使用HTTP exporter。"],
      ["MCP工具", "用名称、描述和输入Schema描述外部能力，调用逻辑与Agent编排解耦。"],
    ],
    sources: [
      source("src/tracing/tracer.js", "39—94", "真实Span与本地指标", `return tracer.startActiveSpan(name, async (span) => {
  try {
    const result = await operation();
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } finally {
    recordMetric(agentName, durationMs, success);
    span.end();
  }
});`),
      source("src/mcp/server.js", "17—90", "工具注册、发现与调用", `register(tool) {
  this.#tools.set(tool.name, tool);
  return this;
}

if (request.method === "tools/list") {
  return { jsonrpc: "2.0", result: this.listTools(), id };
}`),
    ],
    observe: "Result.metrics中应出现intent_router、knowledge_rag、compliance_checker、supervisor；tools中应有4个工具。",
    exercise: "调用一次risk_check后重新执行本步，确认tool_call_log增加；再比较Agent节点和MCP工具的职责差异。",
    mastery: "能从指标定位慢Agent，并能判断新能力应该写成Agent、普通函数还是MCP工具。",
  },
];

const businessSources = {
  knowledge_rag: {
    title: "当前分支：Knowledge RAG",
    description: "产品咨询会经过Query改写、召回、重排和回答生成。无LLM时保留关键词检索与模板回答。",
    source: source("src/agents/knowledge-rag.js", "78—105", "Knowledge RAG主流程", `const rewrittenQuery = await this.rewriteQuery(state.user_message);
documents = await this.longTermMemory.search(rewrittenQuery, 5);
documents = await this.rerankDocuments(rewrittenQuery, documents, 3);
answer = await this.generateAnswer(state.user_message, documents);`),
  },
  ticket_handler: {
    title: "当前分支：Ticket Agent",
    description: "退款、投诉等请求先分析create/query/update动作，再更新内存工单并把结果写入sub_results。",
    source: source("src/agents/ticket-handler.js", "80—124", "工单分析与创建/查询/更新", `info = await this.analyzeRequest(state.user_message);
if (info.action === "query") return this.getTicket(info.ticket_id);
if (info.action === "update") return this.updateStatus(info.ticket_id, info.status);
const ticket = this.createTicket(state.user_id, info.summary, info.priority);`),
  },
  compliance_checker: {
    title: "当前分支：Security Handler",
    description: "盗刷、欺诈和账户安全请求不做普通知识回答，而是生成安全操作提示，再进入统一合规节点。",
    source: source("src/agents/supervisor.js", "60—67", "安全请求专用节点", `.addNode("security_handler", (state) => ({
  current_agent: "security_handler",
  sub_results: {
    ...state.sub_results,
    security_guidance: "请立即停止相关操作并保护好验证码、密码等信息...",
  },
}))`),
  },
};

export function getLesson(index, intent = "knowledge_rag") {
  const lesson = structuredClone(lessons[index]);
  if (index === 3) {
    const branch = businessSources[intent] || businessSources.knowledge_rag;
    lesson.branch = branch;
    lesson.sources = [branch.source];
  }
  return lesson;
}
