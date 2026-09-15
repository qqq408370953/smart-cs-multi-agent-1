import { getLesson, learningPhases } from "./lessons.js";

// 教学前端不实现业务规则。这些场景只提供可重复输入，真实 intent 和回答来自 8100 后端。
const scenarios = [
  { id: "knowledge", label: "产品咨询", message: "理财产品的投资期限是多久？" },
  { id: "ticket", label: "退款工单", message: "我购买后想申请退款，请帮我创建工单" },
  { id: "security", label: "账户安全", message: "我的账户疑似被盗刷，应该怎么办？" },
  { id: "blocked", label: "合规拦截", message: "我要投诉，你们宣传这个产品保证收益" },
];

// 八个“观察步骤”是教学视图；一次 POST /api/chat 仍会在后端原子地执行完整 LangGraph。
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

// 启动时缓存 DOM 引用，避免每次渲染都重复查询同一元素。
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
  planButton: document.querySelector("#planButton"),
  lessonDialog: document.querySelector("#lessonDialog"),
  lessonPhase: document.querySelector("#lessonPhase"),
  lessonDialogTitle: document.querySelector("#lessonDialogTitle"),
  dialogProgress: document.querySelector("#dialogProgress"),
  lessonNav: document.querySelector("#lessonNav"),
  lessonContent: document.querySelector("#lessonContent"),
  lessonCloseButton: document.querySelector("#lessonCloseButton"),
  lessonPrevButton: document.querySelector("#lessonPrevButton"),
  lessonNextButton: document.querySelector("#lessonNextButton"),
  lessonExecuteButton: document.querySelector("#lessonExecuteButton"),
};

// 以下是纯前端 UI State，不等同于后端的 AgentStateSchema。
let selectedScenario = scenarios[0];
let currentStep = 0;
let activeTab = "state";
let busy = false;
let state = {};
let result = {};
let events = [];
let sessionId = createSessionId();
let runGeneration = 0;
let lessonIndex = 0;

function createSessionId() {
  // 每次重置生成新会话，避免前一次短期历史影响本次教学观察。
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function request(path, options) {
  // 统一处理 API 基址、JSON 解析和非 2xx 错误。
  const response = await fetch(apiUrl(path), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function estimateIntent(message) {
  // 仅用于真实 /api/chat 调用前预测流程图高亮；最终判断仍以后端 body.intent 为准。
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
      <li class="step-item">
        <button class="step-button" type="button" data-step="${index}" data-status="${status}">
          <span class="step-dot">${index < currentStep ? "✓" : String(index + 1).padStart(2, "0")}</span>
          <span><strong>${step.title}</strong><small>${step.subtitle}</small></span>
        </button>
        <button class="step-learn-button" type="button" data-learn-step="${index}" aria-label="查看第${index + 1}步讲解">讲解</button>
      </li>
    `;
  }).join("");
  elements.progressCount.textContent = `${Math.min(currentStep, steps.length)} / ${steps.length}`;
  elements.progressBar.style.width = `${Math.min(100, currentStep / steps.length * 100)}%`;
}

function renderFlow() {
  // 只高亮实际选择的业务分支，其余分支置灰，帮助观察 LangGraph 条件边。
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
    elements.lessonCard.innerHTML = `<span class="lesson-number">完成</span><div><strong>一次完整Agent链路已拆解完毕</strong><p>重置后换一个场景，对比不同条件边和合规结果。</p></div><button class="lesson-open-button" type="button" data-open-current-lesson>复习本课</button>`;
    return;
  }
  const step = steps[currentStep];
  elements.lessonCard.innerHTML = `<span class="lesson-number">${String(currentStep + 1).padStart(2, "0")}</span><div><strong>${step.title}</strong><p>${step.lesson}</p></div><button class="lesson-open-button" type="button" data-open-current-lesson>查看详细讲解</button>`;
}

function lessonStatus(index) {
  if (index < currentStep) return { label: "已完成", className: "status-complete" };
  if (index === currentStep) return { label: "当前步骤", className: "status-current" };
  return { label: "未开始", className: "" };
}

function observationFor(index) {
  const observations = [
    result.health,
    Object.keys(state).length ? state : null,
    state.intent ? { predicted_intent: state.intent, selected_branch: activeBusinessNode() } : null,
    result.chat,
    result.chat ? { compliance_passed: result.chat.compliance_passed, compliance_state: state.sub_results?.compliance } : null,
    state.final_response ? { final_response: state.final_response, messages: state.messages } : null,
    result.history,
    result.metrics || result.tools ? { metrics: result.metrics, tools: result.tools } : null,
  ];
  return observations[index] || { status: "执行到这一步后，这里会显示真实运行结果" };
}

function renderLessonNav() {
  elements.lessonNav.innerHTML = learningPhases.map((phase) => {
    const lessonButtons = steps.map((step, index) => ({ step, index, lesson: getLesson(index, result.chat?.intent || state.intent) }))
      .filter(({ lesson }) => lesson.phase === phase.id)
      .map(({ step, index }) => `<button class="lesson-nav-button" type="button" data-lesson-index="${index}" aria-current="${index === lessonIndex ? "step" : "false"}" data-done="${index < currentStep}"><span class="nav-index">${index < currentStep ? "✓" : index + 1}</span><strong>${escapeHtml(step.title)}</strong></button>`)
      .join("");
    return `<section class="phase-block"><div class="phase-heading"><span>${phase.label}</span><span>${phase.steps}</span></div>${lessonButtons}</section>`;
  }).join("");
}

function renderLessonDialog() {
  const intent = result.chat?.intent || state.intent || "knowledge_rag";
  const lesson = getLesson(lessonIndex, intent);
  const phase = learningPhases.find((item) => item.id === lesson.phase);
  const status = lessonStatus(lessonIndex);
  elements.lessonPhase.textContent = `${phase.label} · 第${lessonIndex + 1}课 / 共8课`;
  elements.lessonDialogTitle.textContent = lesson.title;
  elements.dialogProgress.style.setProperty("--lesson-progress", `${(lessonIndex + 1) / steps.length * 100}%`);
  renderLessonNav();

  const sources = lesson.sources.map((item) => `<article class="source-card"><header class="source-header"><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.file)} · 行 ${escapeHtml(item.lines)}</small></div><a href="${item.url}" target="_blank" rel="noreferrer">在GitHub定位 ↗</a></header><pre><code>${escapeHtml(item.code)}</code></pre></article>`).join("");
  const branch = lesson.branch ? `<div class="branch-note"><strong>${escapeHtml(lesson.branch.title)}</strong><p>${escapeHtml(lesson.branch.description)}</p></div>` : "";
  elements.lessonContent.innerHTML = `
    <div class="lesson-kicker"><span>${escapeHtml(phase.label)}</span><span>${escapeHtml(lesson.duration)}</span><span class="${status.className}">${status.label}</span></div>
    <h3>${escapeHtml(lesson.title)}</h3>
    <p class="lesson-goal">${escapeHtml(lesson.goal)}</p>
    ${branch}
    <section class="lesson-section"><h4><span>01</span>这一步真实做了什么</h4><ol>${lesson.does.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol></section>
    <section class="lesson-section"><h4><span>02</span>输入与输出</h4><div class="io-grid"><div class="io-card"><span>INPUT</span><p>${escapeHtml(lesson.input)}</p></div><div class="io-card"><span>OUTPUT</span><p>${escapeHtml(lesson.output)}</p></div></div></section>
    <section class="lesson-section"><h4><span>03</span>必须理解的概念</h4><div class="concept-list">${lesson.concepts.map(([term, description]) => `<div class="concept-item"><strong>${escapeHtml(term)}</strong><p>${escapeHtml(description)}</p></div>`).join("")}</div></section>
    <section class="lesson-section"><h4><span>04</span>关键代码定位</h4><div class="source-list">${sources}</div></section>
    <section class="lesson-section"><h4><span>05</span>当前运行观察</h4><div class="observe-card"><span>观察任务</span><p>${escapeHtml(lesson.observe)}</p></div><pre class="live-observation">${escapeHtml(JSON.stringify(observationFor(lessonIndex), null, 2))}</pre></section>
    <section class="lesson-section"><h4><span>06</span>练习与掌握标准</h4><div class="exercise-grid"><div class="exercise-card"><span>动手练习</span><p>${escapeHtml(lesson.exercise)}</p></div><div class="exercise-card mastery"><span>通过标准</span><p>${escapeHtml(lesson.mastery)}</p></div></div></section>
  `;
  elements.lessonPrevButton.disabled = lessonIndex === 0;
  elements.lessonNextButton.disabled = lessonIndex === steps.length - 1;
  elements.lessonExecuteButton.textContent = lessonIndex < currentStep ? "查看已完成结果" : `执行到第${lessonIndex + 1}步`;
}

function openLesson(index) {
  lessonIndex = Math.max(0, Math.min(steps.length - 1, index));
  renderLessonDialog();
  if (!elements.lessonDialog.open) elements.lessonDialog.showModal();
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
  const lessonButton = event.target.closest("[data-learn-step]");
  if (lessonButton) {
    openLesson(Number(lessonButton.dataset.learnStep));
    return;
  }
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
elements.planButton.addEventListener("click", () => openLesson(Math.min(currentStep, steps.length - 1)));
elements.lessonCard.addEventListener("click", (event) => {
  if (event.target.closest("[data-open-current-lesson]")) openLesson(Math.min(currentStep, steps.length - 1));
});
elements.lessonCloseButton.addEventListener("click", () => elements.lessonDialog.close());
elements.lessonDialog.addEventListener("click", (event) => {
  if (event.target === elements.lessonDialog) elements.lessonDialog.close();
});
elements.lessonNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-lesson-index]");
  if (!button) return;
  lessonIndex = Number(button.dataset.lessonIndex);
  renderLessonDialog();
});
elements.lessonPrevButton.addEventListener("click", () => {
  lessonIndex = Math.max(0, lessonIndex - 1);
  renderLessonDialog();
});
elements.lessonNextButton.addEventListener("click", () => {
  lessonIndex = Math.min(steps.length - 1, lessonIndex + 1);
  renderLessonDialog();
});
elements.lessonExecuteButton.addEventListener("click", () => {
  const target = lessonIndex;
  elements.lessonDialog.close();
  if (target < currentStep) {
    showToast("该步骤已经执行，可在观察器中查看结果");
    return;
  }
  runUntil(target);
});
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
