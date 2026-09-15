const scenarios = [
  { id: "knowledge", label: "产品咨询", message: "理财产品的投资期限是多久？" },
  { id: "ticket", label: "退款工单", message: "我购买后想申请退款，请帮我创建工单" },
  { id: "security", label: "账户安全", message: "我的账户疑似被盗刷，应该怎么办？" },
  { id: "blocked", label: "合规拦截", message: "我要投诉，你们宣传这个产品保证收益" },
];

const steps = [
  { id: "api", title: "连接API", subtitle: "GET /health", lesson: "确认后端版本和LangGraph编排状态。" },
  { id: "state", title: "创建State", subtitle: "构造共享数据", lesson: "State是所有节点共同读写的数据总线。" },
  { id: "intent", title: "意图路由", subtitle: "选择业务分支", lesson: "配置LLM时结构化分类；否则使用关键词规则。" },
  { id: "agent", title: "执行专业Agent", subtitle: "RAG / Ticket / Security", lesson: "一次真实/api/chat调用会完整执行整张图，本Demo按阶段拆开展示结果。" },
  { id: "compliance", title: "合规统一出口", subtitle: "规则 + LLM", lesson: "所有业务分支都必须进入Compliance Gate，不能绕过。" },
  { id: "response", title: "合成最终响应", subtitle: "Supervisor synthesize", lesson: "合规通过时汇总业务结果；失败时采用安全拒答。" },
  { id: "memory", title: "观察会话记忆", subtitle: "GET /api/history", lesson: "短期历史与LangGraph Checkpoint职责不同：一个服务对话，一个保存图状态。" },
  { id: "observe", title: "观察指标与工具", subtitle: "Metrics + MCP", lesson: "通过证据判断Agent调用、耗时以及可发现的外部工具。" },
];

const elements = {
  apiBase: document.querySelector("#apiBase"),
  checkButton: document.querySelector("#checkButton"),
  connectionState: document.querySelector("#connectionState"),
  scenarioList: document.querySelector("#scenarioList"),
  messageInput: document.querySelector("#messageInput"),
  resetButton: document.querySelector("#resetButton"),
  nextButton: document.querySelector("#nextButton"),
  autoButton: document.querySelector("#autoButton"),
  stepList: document.querySelector("#stepList"),
  progressCount: document.querySelector("#progressCount"),
  progressBar: document.querySelector("#progressBar"),
  runId: document.querySelector("#runId"),
  lessonCard: document.querySelector("#lessonCard"),
  inspectorContent: document.querySelector("#inspectorContent"),
  copyButton: document.querySelector("#copyButton"),
  toast: document.querySelector("#toast"),
};

let selectedScenario = scenarios[0];
let currentStep = 0;
let activeTab = "state";
let busy = false;
let state = {};
let result = {};
let events = [];
let sessionId = createSessionId();
let runGeneration = 0;

function createSessionId() {
  return `flow-demo-${Date.now().toString(36)}`;
}

function apiUrl(path) {
  return `${elements.apiBase.value.trim().replace(/\/$/, "")}${path}`;
}

function addEvent(type, message, data) {
  events.unshift({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), type, message, ...(data === undefined ? {} : { data }) });
  events = events.slice(0, 30);
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.dataset.visible = "true";
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { elements.toast.dataset.visible = "false"; }, 2200);
}

async function request(path, options) {
  const response = await fetch(apiUrl(path), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function estimateIntent(message) {
  const ticketWords = ["退款", "退货", "理赔", "投诉", "开户", "申请", "办理", "工单", "申诉", "注销"];
  const securityWords = ["举报", "欺诈", "盗刷", "异常", "安全", "违规", "泄露", "风险"];
  const ticketScore = ticketWords.filter((word) => message.includes(word)).length;
  const securityScore = securityWords.filter((word) => message.includes(word)).length;
  if (ticketScore > securityScore && ticketScore > 0) return "ticket_handler";
  if (securityScore > 0) return "compliance_checker";
  return "knowledge_rag";
}

function activeBusinessNode() {
  const intent = result.intent || state.intent;
  return intent === "ticket_handler" ? "ticket" : intent === "compliance_checker" ? "security" : "knowledge";
}

function renderScenarios() {
  elements.scenarioList.innerHTML = scenarios.map((scenario) => `
    <button class="scenario-button" type="button" data-scenario="${scenario.id}" aria-pressed="${scenario.id === selectedScenario.id}">${scenario.label}</button>
  `).join("");
}

function renderSteps() {
  elements.stepList.innerHTML = steps.map((step, index) => {
    const status = index < currentStep ? "done" : index === currentStep ? "active" : "idle";
    return `
      <li><button class="step-button" type="button" data-step="${index}" data-status="${status}">
        <span class="step-dot">${index < currentStep ? "✓" : String(index + 1).padStart(2, "0")}</span>
        <span><strong>${step.title}</strong><small>${step.subtitle}</small></span>
      </button></li>
    `;
  }).join("");
  elements.progressCount.textContent = `${Math.min(currentStep, steps.length)} / ${steps.length}`;
  elements.progressBar.style.width = `${Math.min(100, currentStep / steps.length * 100)}%`;
}

function renderFlow() {
  const nodeOrder = ["api", "state", "intent", activeBusinessNode(), "compliance", "response", "memory", "observe"];
  document.querySelectorAll(".flow-node").forEach((node) => {
    const nodeName = node.dataset.node;
    const index = nodeOrder.indexOf(nodeName);
    const isUnselectedBranch = ["knowledge", "ticket", "security"].includes(nodeName) && nodeName !== activeBusinessNode();
    if (isUnselectedBranch && currentStep >= 3) node.dataset.status = "muted";
    else if (index >= 0 && index < currentStep) node.dataset.status = "done";
    else if (index === currentStep) node.dataset.status = "active";
    else node.dataset.status = "idle";
  });
}

function renderInspector() {
  const contents = { state, result, events };
  elements.inspectorContent.textContent = JSON.stringify(contents[activeTab], null, 2);
  document.querySelectorAll("[role='tab']").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === activeTab));
  });
}

function renderLesson() {
  if (currentStep >= steps.length) {
    elements.lessonCard.innerHTML = `<span class="lesson-number">完成</span><div><strong>一次完整Agent链路已拆解完毕</strong><p>重置后换一个场景，对比不同条件边和合规结果。</p></div>`;
    return;
  }
  const step = steps[currentStep];
  elements.lessonCard.innerHTML = `<span class="lesson-number">${String(currentStep + 1).padStart(2, "0")}</span><div><strong>${step.title}</strong><p>${step.lesson}</p></div>`;
}

function render() {
  renderScenarios();
  renderSteps();
  renderFlow();
  renderInspector();
  renderLesson();
  elements.runId.textContent = sessionId;
  elements.nextButton.textContent = currentStep >= steps.length ? "已完成" : "执行下一步";
  elements.nextButton.disabled = busy || currentStep >= steps.length;
  elements.autoButton.disabled = busy || currentStep >= steps.length;
  elements.resetButton.disabled = busy;
}

function setConnection(status, label) {
  elements.connectionState.dataset.status = status;
  elements.connectionState.querySelector("span").textContent = label;
}

async function executeStep(index) {
  const message = elements.messageInput.value.trim();
  if (!message) throw new Error("请先输入一条消息");

  if (index === 0) {
    const health = await request("/health");
    result.health = health;
    setConnection("online", `${health.version} 在线`);
    addEvent("HTTP", "健康检查成功", health);
  }

  if (index === 1) {
    state = {
      messages: [{ type: "human", content: message }],
      user_id: "flow-student",
      session_id: sessionId,
      user_message: message,
      intent: "",
      sub_results: {},
      compliance_passed: true,
      final_response: "",
      current_agent: "",
      retry_count: 0,
    };
    addEvent("STATE", "创建共享Agent State", state);
  }

  if (index === 2) {
    state.intent = estimateIntent(message);
    state.current_agent = "intent_router";
    addEvent("ROUTE", `本地规则预测：${state.intent}`);
  }

  if (index === 3) {
    const chat = await request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, user_id: state.user_id, session_id: sessionId }),
    });
    result.chat = chat;
    state.intent = chat.intent;
    state.current_agent = activeBusinessNode();
    state.sub_results.business_agent = "业务Agent已执行，真实结果见Result视图";
    addEvent("AGENT", `真实图调用完成，业务分支：${chat.intent}`, chat);
  }

  if (index === 4) {
    state.current_agent = "compliance_checker";
    state.compliance_passed = result.chat.compliance_passed;
    state.sub_results.compliance = { passed: result.chat.compliance_passed };
    addEvent("COMPLIANCE", result.chat.compliance_passed ? "合规审查通过" : "合规审查未通过，触发安全响应");
  }

  if (index === 5) {
    state.current_agent = "supervisor";
    state.final_response = result.chat.response;
    state.messages.push({ type: "ai", content: result.chat.response });
    addEvent("SYNTHESIZE", "Supervisor生成最终回复", { response: result.chat.response });
  }

  if (index === 6) {
    result.history = await request(`/api/history/${encodeURIComponent(sessionId)}`);
    addEvent("MEMORY", `读取到${result.history.messages.length}条短期记忆`, result.history);
  }

  if (index === 7) {
    const [metrics, tools] = await Promise.all([
      request("/api/metrics"),
      request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} }),
      }),
    ]);
    result.metrics = metrics;
    result.tools = tools.result;
    addEvent("OBSERVE", `发现${tools.result.length}个MCP工具，并读取Agent指标`, { metrics, tools: tools.result });
  }
}

async function runOne() {
  if (busy || currentStep >= steps.length) return;
  busy = true;
  render();
  try {
    await executeStep(currentStep);
    currentStep += 1;
  } catch (error) {
    addEvent("ERROR", error.message);
    setConnection("error", "连接失败");
    activeTab = "events";
    showToast(error.message);
  } finally {
    busy = false;
    render();
  }
}

async function runUntil(targetIndex) {
  const generation = runGeneration;
  while (currentStep <= targetIndex && currentStep < steps.length) {
    if (generation !== runGeneration) break;
    await runOne();
    if (generation !== runGeneration) break;
    if (events[0]?.type === "ERROR") break;
    await new Promise((resolve) => window.setTimeout(resolve, 240));
  }
}

function reset() {
  runGeneration += 1;
  currentStep = 0;
  state = {};
  result = {};
  events = [];
  sessionId = createSessionId();
  setConnection("idle", "未检测");
  render();
}

elements.scenarioList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-scenario]");
  if (!button || busy) return;
  selectedScenario = scenarios.find((scenario) => scenario.id === button.dataset.scenario);
  elements.messageInput.value = selectedScenario.message;
  reset();
});

elements.messageInput.addEventListener("input", () => {
  if (currentStep > 0 && !busy) reset();
});

elements.stepList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-step]");
  if (!button || busy) return;
  runUntil(Number(button.dataset.step));
});

document.querySelector(".tab-list").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab) return;
  activeTab = tab.dataset.tab;
  renderInspector();
});

elements.checkButton.addEventListener("click", async () => {
  try {
    const health = await request("/health");
    result.health = health;
    setConnection("online", `${health.version} 在线`);
    addEvent("HTTP", "独立连接检测成功", health);
    renderInspector();
  } catch (error) {
    setConnection("error", "连接失败");
    showToast(`无法连接Agent API：${error.message}`);
  }
});

elements.nextButton.addEventListener("click", runOne);
elements.autoButton.addEventListener("click", () => runUntil(steps.length - 1));
elements.resetButton.addEventListener("click", reset);
elements.copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements.inspectorContent.textContent);
  showToast("当前观察器内容已复制");
});

function registerWebMcpTool() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  void Promise.resolve(context.registerTool({
    name: "run_agent_flow_demo",
    title: "运行Agent流程演示",
    description: "选择一个内置客服场景或提供自定义消息，并在页面中执行完整的八步Agent流程演示。",
    inputSchema: {
      type: "object",
      properties: {
        scenario: { type: "string", enum: scenarios.map((scenario) => scenario.id) },
        message: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input = {}) {
      if (input.scenario !== undefined && !scenarios.some((scenario) => scenario.id === input.scenario)) {
        throw new TypeError("scenario必须是knowledge、ticket、security或blocked");
      }
      const scenario = scenarios.find((candidate) => candidate.id === input.scenario) || selectedScenario;
      selectedScenario = scenario;
      elements.messageInput.value = typeof input.message === "string" && input.message.trim()
        ? input.message.trim()
        : scenario.message;
      reset();
      await runUntil(steps.length - 1);
      const error = events.find((event) => event.type === "ERROR");
      if (error) throw new Error(error.message);
      return {
        session_id: sessionId,
        intent: result.chat?.intent,
        compliance_passed: result.chat?.compliance_passed,
        response: result.chat?.response,
        completed_steps: currentStep,
      };
    },
  }, { signal: lifecycle.signal })).catch((error) => {
    addEvent("WEBMCP", `工具注册失败：${error.message}`);
    renderInspector();
  });
}

registerWebMcpTool();
render();
