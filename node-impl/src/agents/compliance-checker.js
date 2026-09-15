import { trace } from "../tracing/tracer.js";
import { z } from "zod";

// 金融违规用语快筛词库。生产环境应通过配置中心维护并建立版本审计。
const forbiddenTerms = [
  "保证收益", "稳赚不赔", "零风险", "保本保息", "最高收益",
  "预期收益率", "承诺回报", "内部消息", "内幕", "暗箱操作",
];

// 常见PII模式：手机号、身份证号、银行卡号、邮箱地址。
const piiPatterns = [
  ["手机号", /1[3-9]\d{9}/g],
  ["身份证号", /\d{17}[\dXx]/g],
  ["银行卡号", /\d{16,19}/g],
  ["邮箱地址", /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g],
];

export class ComplianceCheckerAgent {
  constructor(llm = null) {
    this.llm = llm;
  }

  /** 执行规则审查并返回风险等级、违规项和脱敏内容。 */
  check(content) {
    const violations = forbiddenTerms
      .filter((term) => content.includes(term))
      .map((term) => `包含违规金融用语: '${term}'`);

    for (const [label, pattern] of piiPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) violations.push(`检测到PII信息泄露: ${label}`);
    }

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
    const ruleResult = this.check(content);
    if (!ruleResult.passed || !this.llm) return ruleResult;

    try {
      const reviewer = this.llm.withStructuredOutput(z.object({
        passed: z.boolean(),
        risk_level: z.enum(["low", "medium", "high", "critical"]),
        violations: z.array(z.string()),
        suggestions: z.array(z.string()),
      }), { name: "compliance_result" });
      const llmResult = await reviewer.invoke([
        ["system", "你是金融客服合规审查Agent。检查违规金融用语、PII、越权承诺、缺失风险提示、歧视或侮辱内容。审查要严格但避免误报。"],
        ["human", `请审查以下客服回复：\n\n${content}`],
      ]);
      return {
        ...llmResult,
        sanitized_content: ruleResult.sanitized_content,
      };
    } catch (error) {
      console.warn(`[ComplianceChecker] LLM审查失败，保留规则结果: ${error.message}`);
      return ruleResult;
    }
  }

  /** 汇总业务Agent字符串结果，确保最终回复经过统一合规节点。 */
  async process(state) {
    return trace("compliance_checker", "process", async () => {
      const content = Object.entries(state.sub_results)
        .filter(([name, result]) => name !== "compliance" && typeof result === "string")
        .map(([, result]) => result)
        .join("\n");

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
