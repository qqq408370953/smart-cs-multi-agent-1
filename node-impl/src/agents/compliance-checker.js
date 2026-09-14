import { trace } from "../tracing/tracer.js";

const forbiddenTerms = [
  "保证收益", "稳赚不赔", "零风险", "保本保息", "最高收益",
  "预期收益率", "承诺回报", "内部消息", "内幕", "暗箱操作",
];

const piiPatterns = [
  ["手机号", /1[3-9]\d{9}/g],
  ["身份证号", /\d{17}[\dXx]/g],
  ["银行卡号", /\d{16,19}/g],
  ["邮箱地址", /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g],
];

export class ComplianceCheckerAgent {
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

  maskPii(content) {
    return piiPatterns.reduce((masked, [, pattern]) => masked.replace(pattern, (value) => {
      if (value.length <= 6) return "****";
      return `${value.slice(0, 3)}${"*".repeat(value.length - 6)}${value.slice(-3)}`;
    }), content);
  }

  async process(state) {
    return trace("compliance_checker", "process", async () => {
      const content = Object.entries(state.sub_results)
        .filter(([name, result]) => name !== "compliance" && typeof result === "string")
        .map(([, result]) => result)
        .join("\n");

      const result = this.check(content);
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
