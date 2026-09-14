import { trace } from "../tracing/tracer.js";

export class KnowledgeRAGAgent {
  constructor(longTermMemory) {
    this.longTermMemory = longTermMemory;
  }

  async process(state) {
    return trace("knowledge_rag", "process", async () => {
      const documents = this.longTermMemory.search(state.user_message, 3);
      if (documents.length === 0) {
        state.sub_results.knowledge_rag = "抱歉，知识库中暂未找到与您问题相关的信息。建议您联系人工客服获取帮助。";
        return state;
      }

      const content = documents
        .map((document) => `【${document.source || "未知来源"}】${document.content}`)
        .join("\n\n");
      state.sub_results.knowledge_rag = `根据知识库检索结果，为您回答如下：\n\n${content}\n\n以上信息仅供参考，具体以合同条款为准。如需进一步帮助，请联系人工客服。`;
      return state;
    });
  }
}
