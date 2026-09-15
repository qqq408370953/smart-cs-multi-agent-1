// LangChain 提供统一模型接口。这里的 ChatOpenAI 负责文本/结构化生成，
// OpenAIEmbeddings 负责把文本变成向量；二者用途不同但可以连接同一个兼容端点。
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";

/**
 * 创建LangChain ChatOpenAI客户端。
 * 未配置OPENAI_API_KEY时返回null，让所有Agent自动使用确定性本地降级逻辑。
 *
 * 关联知识：LLM 在本项目中不是 Agent 本身。Agent = 角色职责 + Prompt + 工具/记忆 + 控制逻辑；
 * LLM 只是 Agent 可选使用的一种推理能力。没有 LLM，路由、检索、工单和规则合规仍可工作。
 */
export function createChatModel() {
  if (!process.env.OPENAI_API_KEY) return null;

  const baseURL = process.env.OPENAI_BASE_URL;
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.MODEL_NAME || "gpt-4o",
    // temperature=0 降低随机性，更适合路由、抽取、合规等要求稳定输出的任务。
    temperature: 0,
    // SDK 层最多重试两次；LangGraph 业务节点还可能设置节点级 retryPolicy，两层不要混淆。
    maxRetries: 2,
    timeout: Number(process.env.LLM_TIMEOUT_MS || 15000),
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}

/**
 * 配置 API Key 时创建向量模型，与 ChatOpenAI 共享兼容 API 端点。
 * Embedding 将语义相近的文本映射到向量空间中的相近位置，再通过余弦相似度做召回；
 * 它不负责生成答案，生成仍由 ChatOpenAI 或本地模板完成。
 */
export function createEmbeddingsModel() {
  if (!process.env.OPENAI_API_KEY) return null;
  const baseURL = process.env.OPENAI_BASE_URL;
  return new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    maxRetries: 2,
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}

/**
 * 将 LangChain 消息的字符串或多段内容统一转换为文本。
 * 不同模型可能返回纯字符串，也可能返回 text/image/tool 等内容块；知识 Agent 最终只需要文本。
 */
export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => typeof part === "string" ? part : part?.text ?? "")
      .join("");
  }
  return String(message?.content ?? "");
}
