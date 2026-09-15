import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";

/**
 * 创建LangChain ChatOpenAI客户端。
 * 未配置OPENAI_API_KEY时返回null，让所有Agent自动使用确定性本地降级逻辑。
 */
export function createChatModel() {
  if (!process.env.OPENAI_API_KEY) return null;

  const baseURL = process.env.OPENAI_BASE_URL;
  return new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.MODEL_NAME || "gpt-4o",
    temperature: 0,
    maxRetries: 2,
    timeout: Number(process.env.LLM_TIMEOUT_MS || 15000),
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}

/** 配置API Key时创建向量模型，与ChatOpenAI共享兼容API端点。 */
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

/** 将LangChain消息的字符串或多段内容统一转换为文本。 */
export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => typeof part === "string" ? part : part?.text ?? "")
      .join("");
  }
  return String(message?.content ?? "");
}
