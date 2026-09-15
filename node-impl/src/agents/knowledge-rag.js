import { trace } from "../tracing/tracer.js";
import { messageText } from "../llm/client.js";
import { z } from "zod";

/**
 * 知识检索Agent。
 * 配置模型后执行Query改写、Embedding召回、LLM重排序和生成；模型不可用时自动降级。
 */
export class KnowledgeRAGAgent {
  constructor(longTermMemory, llm = null) {
    this.longTermMemory = longTermMemory;
    this.llm = llm;
  }

  async rewriteQuery(query) {
    if (!this.llm) return query;
    const response = await this.llm.invoke([
      ["system", "将用户口语问题改写为适合检索的查询，保留核心语义并补充专业术语。只返回查询文本。"],
      ["human", query],
    ]);
    return messageText(response).trim() || query;
  }

  async rerankDocuments(query, documents, topK = 3) {
    if (!this.llm || documents.length <= 1) return documents.slice(0, topK);
    const ranker = this.llm.withStructuredOutput(
      z.object({ indices: z.array(z.number().int().nonnegative()).max(documents.length) }),
      { name: "document_ranking" },
    );
    const candidates = documents.map((document, index) => `[${index}] ${document.content}`).join("\n");
    const result = await ranker.invoke(`查询：${query}\n候选文档：\n${candidates}\n返回最相关的${topK}个索引。`);
    const selected = [...new Set(result.indices)]
      .filter((index) => index < documents.length)
      .slice(0, topK)
      .map((index) => documents[index]);
    return selected.length > 0 ? selected : documents.slice(0, topK);
  }

  async generateAnswer(query, documents, { useLlm = true } = {}) {
    if (documents.length === 0) {
      return "抱歉，知识库中暂未找到与您问题相关的信息。建议您联系人工客服获取帮助。";
    }

    const context = documents
      .map((document) => `来源: ${document.source || "未知来源"}\n内容: ${document.content}`)
      .join("\n\n---\n\n");
    if (!this.llm || !useLlm) {
      const content = documents
        .map((document) => `【${document.source || "未知来源"}】${document.content}`)
        .join("\n\n");
      return `根据知识库检索结果，为您回答如下：\n\n${content}\n\n以上信息仅供参考，具体以合同条款为准。如需进一步帮助，请联系人工客服。`;
    }

    const response = await this.llm.invoke([
      ["system", "你是知识库问答Agent。严格根据文档简洁回答，不得编造；金融信息必须包含风险提示，末尾标注文档来源。"],
      ["human", `用户问题: ${query}\n\n参考文档:\n${context}`],
    ]);
    return messageText(response);
  }

  /** 执行Query改写、Top-5召回、LLM重排序和回答生成。 */
  async process(state) {
    return trace("knowledge_rag", "process", async () => {
      let documents;
      let answer;
      try {
        const rewrittenQuery = await this.rewriteQuery(state.user_message);
        documents = await this.longTermMemory.search(rewrittenQuery, 5);
        documents = await this.rerankDocuments(rewrittenQuery, documents, 3);
        answer = await this.generateAnswer(state.user_message, documents);
      } catch (error) {
        console.warn(`[KnowledgeRAG] LLM流程失败，降级为本地检索: ${error.message}`);
        documents = await this.longTermMemory.search(state.user_message, 3);
        answer = await this.generateAnswer(state.user_message, documents, { useLlm: false });
      }
      state.sub_results.knowledge_rag = answer;
      return state;
    });
  }
}
