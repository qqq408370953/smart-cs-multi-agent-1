// 合规检查也参与统一链路追踪，便于定位审查耗时或失败。
import { trace } from "../tracing/tracer.js";
// LLM 深层审查必须返回固定风险等级与违规列表，避免直接信任自由文本。
import { z } from "zod";

// 第一阶段规则之一：金融违规用语快筛词库。
// 这里是演示数据；生产环境应通过配置中心维护，并记录词库版本与变更审计。
const forbiddenTerms = [
  "保证收益", "稳赚不赔", "零风险", "保本保息", "最高收益",
  "预期收益率", "承诺回报", "内部消息", "内幕", "暗箱操作",
];

// 第一阶段规则之二：常见 PII（Personally Identifiable Information，个人可识别信息）模式。
// 使用全局正则是为了既能检测，也能在 maskPii 中替换同一段文本里的全部匹配项。
const piiPatterns = [
  ["手机号", /1[3-9]\d{9}/g],
  ["身份证号", /\d{17}[\dXx]/g],
  ["银行卡号", /\d{16,19}/g],
  ["邮箱地址", /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g],
];

export class ComplianceCheckerAgent {
  constructor(llm = null) {
    // 没有 LLM 时只执行确定性的规则层；有 LLM 时规则通过后再执行语义审查。
    this.llm = llm;
  }

  /**
   * 第一阶段：同步规则审查。
   * 输入是一段准备返回给用户的业务回答，而不是用户原始问题。
   * 输出包含是否通过、风险级别、违规原因和脱敏后的文本；本方法不修改 State。
   */
  check(content) {
    // 扫描所有金融禁用词，并为命中的每一项生成可审计原因。
    const violations = forbiddenTerms
      .filter((term) => content.includes(term))
      .map((term) => `包含违规金融用语: '${term}'`);

    for (const [label, pattern] of piiPatterns) {
      // 全局正则带有可变 lastIndex；每次 test 前归零，避免连续调用时漏检。
      pattern.lastIndex = 0;
      if (pattern.test(content)) violations.push(`检测到PII信息泄露: ${label}`);
    }

    // 根据违规类型计算严重程度：PII 高于普通金融用语，两者同时出现则为 critical。
    const hasPii = violations.some((violation) => violation.includes("PII"));
    const hasForbidden = violations.some((violation) => violation.includes("违规金融用语"));
    return {
      passed: violations.length === 0,
      risk_level: hasPii && hasForbidden ? "critical" : hasPii ? "high" : hasForbidden ? "medium" : "low",
      violations,
      sanitized_content: this.maskPii(content),
    };
  }

  /** 保留PII首尾各3个字符，其余字符替换为星号。 */
  maskPii(content) {
    // reduce 让每种 PII 正则依次处理上一步已经脱敏过的字符串。
    return piiPatterns.reduce((masked, [, pattern]) => masked.replace(pattern, (value) => {
      if (value.length <= 6) return "****";
      return `${value.slice(0, 3)}${"*".repeat(value.length - 6)}${value.slice(-3)}`;
    }), content);
  }

  /**
   * 两阶段合规审查：规则高风险直接拦截；规则通过后由LLM检查隐性承诺、越权和歧视内容。
   * LLM不可用或调用失败时保留规则结果，确保本地模式可运行。
   */
  async fullCheck(content) {
    // 第 1 步始终先跑便宜、快速、确定性的规则层。
    const ruleResult = this.check(content);
    // 规则发现问题时直接拦截；无 LLM 时规则结果就是最终结果。
    if (!ruleResult.passed || !this.llm) return ruleResult;

    try {
      // 第 2 步只在规则通过时运行 LLM，补充规则难以识别的隐性承诺、歧视和越权语义。
      const reviewer = this.llm.withStructuredOutput(z.object({
        passed: z.boolean(),
        risk_level: z.enum(["low", "medium", "high", "critical"]),
        violations: z.array(z.string()),
        suggestions: z.array(z.string()),
      }), { name: "compliance_result" });
      // 把“待发送的客服回复”明确放进 Human Message，避免模型误解为用户请求。
      const llmResult = await reviewer.invoke([
        ["system", "你是金融客服合规审查Agent。检查违规金融用语、PII、越权承诺、缺失风险提示、歧视或侮辱内容。审查要严格但避免误报。"],
        ["human", `请审查以下客服回复：\n\n${content}`],
      ]);
      return {
        // passed/risk_level/violations/suggestions 采用 LLM 的语义判断。
        ...llmResult,
        // 脱敏文本仍采用确定性规则结果，避免让 LLM 自己处理敏感字符。
        sanitized_content: ruleResult.sanitized_content,
      };
    } catch (error) {
      // 当前演示版在模型故障时保留规则结果，以可用性优先；高风险生产场景可改成 fail-closed。
      console.warn(`[ComplianceChecker] LLM审查失败，保留规则结果: ${error.message}`);
      return ruleResult;
    }
  }

  /**
   * LangGraph 合规节点：
   * 1. 从 sub_results 中提取业务 Agent 产生的所有字符串；
   * 2. 排除之前保存的 compliance 元数据；
   * 3. 拼成待审查内容并执行两阶段检查；
   * 4. 更新顶层 compliance_passed，供 Supervisor 决定是否返回业务回答；
   * 5. 在 sub_results.compliance 保存结构化审计信息。
   */
  async process(state) {
    return trace("compliance_checker", "process", async () => {
      // intent_router 的值是对象，天然会被 typeof result === "string" 过滤掉。
      const content = Object.entries(state.sub_results)
        .filter(([name, result]) => name !== "compliance" && typeof result === "string")
        .map(([, result]) => result)
        .join("\n");

      // 注意这里只记录审查结论；最终面向用户的安全兜底文本由 Supervisor.synthesize 生成。
      const result = await this.fullCheck(content);
      state.compliance_passed = result.passed;
      state.sub_results.compliance = {
        passed: result.passed,
        risk_level: result.risk_level,
        violations: result.violations,
      };
      return state;
    });
  }
}
