// trace 统一记录 Agent 耗时和错误；messageText 统一处理不同模型返回的消息格式。
import { trace } from "../tracing/tracer.js";
import { messageText } from "../llm/client.js";
// 重排序要求模型返回索引数组，Zod 用来限制索引必须是非负整数。
import { z } from "zod";

/**
 * 知识检索Agent。
 * 配置模型后执行Query改写、Embedding召回、LLM重排序和生成；模型不可用时自动降级。
 */
export class KnowledgeRAGAgent {
  constructor(longTermMemory, llm = null) {
    // longTermMemory 是知识库抽象；llm 为 null 时仍可用关键词检索和模板回答。
    this.longTermMemory = longTermMemory;
    this.llm = llm;
  }

  async rewriteQuery(query) {
    // 没有模型就保留原问题，跳过改写而不是中断 RAG。
    if (!this.llm) return query;
    // Query 改写的目标是提高“检索召回率”，不是直接回答用户。
    const response = await this.llm.invoke([
      ["system", "将用户口语问题改写为适合检索的查询，保留核心语义并补充专业术语。只返回查询文本。"],
      ["human", query],
    ]);
    return messageText(response).trim() || query;
  }

  async rerankDocuments(query, documents, topK = 3) {
    // 无模型或只有一篇候选时，直接保留检索层的原始顺序。
    if (!this.llm || documents.length <= 1) return documents.slice(0, topK);
    // 让 LLM 只返回候选数组的索引，可以避免它改写或虚构文档内容。
    const ranker = this.llm.withStructuredOutput(
      z.object({ indices: z.array(z.number().int().nonnegative()).max(documents.length) }),
      { name: "document_ranking" },
    );
    // 给每篇文档添加稳定的临时编号，模型返回这些编号即可。
    const candidates = documents.map((document, index) => `[${index}] ${document.content}`).join("\n");
    const result = await ranker.invoke(`查询：${query}\n候选文档：\n${candidates}\n返回最相关的${topK}个索引。`);
    // 去重、过滤越界索引、限制数量，再把索引映射回原文档对象。
    const selected = [...new Set(result.indices)]
      .filter((index) => index < documents.length)
      .slice(0, topK)
      .map((index) => documents[index]);
    // 模型若返回空数组，仍保留检索排名的前 topK 篇作为安全降级。
    return selected.length > 0 ? selected : documents.slice(0, topK);
  }

  async generateAnswer(query, documents, { useLlm = true } = {}) {
    // 检索为空时明确告知用户，不允许模型脱离知识库自由发挥。
    if (documents.length === 0) {
      return "抱歉，知识库中暂未找到与您问题相关的信息。建议您联系人工客服获取帮助。";
    }

    // 将结构化文档拼成带来源的上下文，供模型生成 grounded answer（有依据的回答）。
    const context = documents
      .map((document) => `来源: ${document.source || "未知来源"}\n内容: ${document.content}`)
      .join("\n\n---\n\n");
    if (!this.llm || !useLlm) {
      // 本地降级模式不生成新事实，只把已命中的原始知识片段格式化后返回。
      const content = documents
        .map((document) => `【${document.source || "未知来源"}】${document.content}`)
        .join("\n\n");
      return `根据知识库检索结果，为您回答如下：\n\n${content}\n\n以上信息仅供参考，具体以合同条款为准。如需进一步帮助，请联系人工客服。`;
    }

    // 正常模式要求模型严格依据上下文，并保留金融风险提示和引用来源。
    const response = await this.llm.invoke([
      ["system", "你是知识库问答Agent。严格根据文档简洁回答，不得编造；金融信息必须包含风险提示，末尾标注文档来源。"],
      ["human", `用户问题: ${query}\n\n参考文档:\n${context}`],
    ]);
    return messageText(response);
  }

  /**
   * 知识业务节点完整流程：
   * 1. 读取 state.user_message；
   * 2. 用 LLM 改写检索词；
   * 3. 从长期记忆召回 Top-5；
   * 4. 用 LLM 重排并保留 Top-3；
   * 5. 基于文档生成回答；
   * 6. 写入 state.sub_results.knowledge_rag。
   * 任一 LLM 阶段异常时，整段切换到“原问题 + 本地检索 + 模板回答”。
   */
  async process(state) {
    return trace("knowledge_rag", "process", async () => {
      let documents;
      let answer;
      try {
        // 正常链路：rewrite → retrieve → rerank → generate。
        const rewrittenQuery = await this.rewriteQuery(state.user_message);
        documents = await this.longTermMemory.search(rewrittenQuery, 5);
        documents = await this.rerankDocuments(rewrittenQuery, documents, 3);
        answer = await this.generateAnswer(state.user_message, documents);
      } catch (error) {
        // 这里统一捕获模型、Embedding、结构化输出等异常，保证用户仍能得到知识库结果。
        console.warn(`[KnowledgeRAG] LLM流程失败，降级为本地检索: ${error.message}`);
        documents = await this.longTermMemory.search(state.user_message, 3);
        answer = await this.generateAnswer(state.user_message, documents, { useLlm: false });
      }
      // 只写自己的命名空间，不覆盖路由或其他 Agent 已经放入 sub_results 的内容。
      state.sub_results.knowledge_rag = answer;
      return state;
    });
  }
}
