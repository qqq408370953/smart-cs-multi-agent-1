import { createHash } from "node:crypto";

// 英文按单词切分；连续中文生成二元词组，避免中文无空格导致整句无法召回。
function tokenize(text) {
  const normalized = text.toLowerCase();
  const latin = normalized.match(/[a-z0-9]+/g) ?? [];
  const chineseRuns = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  const chinese = chineseRuns.flatMap((run) => {
    if (run.length < 2) return [run];
    return Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2));
  });
  return [...new Set([...latin, ...chinese])];
}

/**
 * 长期记忆：优先使用OpenAI Embeddings和余弦相似度，异常时回退关键词检索。
 * 文档和向量保存在当前进程；生产环境可替换为持久化向量库或混合检索。
 */
export class LongTermMemory {
  #documents = [];
  #vectors = [];

  constructor({ embeddings = null } = {}) {
    this.embeddings = embeddings;
  }

  /** 添加单篇文档，使用内容MD5前12位作为稳定ID。 */
  addDocument(content, source = "", metadata = {}) {
    const document = {
      id: createHash("md5").update(content).digest("hex").slice(0, 12),
      content,
      source,
      metadata,
    };
    this.#documents.push(document);
    this.#vectors.push(null);
    return document.id;
  }

  addDocumentsBatch(documents) {
    return documents.map((doc) => this.addDocument(doc.content, doc.source, doc.metadata));
  }

  /** 优先执行Embedding余弦相似度检索，模型不可用时回退关键词覆盖数排序。 */
  async search(query, topK = 5) {
    if (this.embeddings && this.#documents.length > 0) {
      try {
        const missing = this.#vectors
          .map((vector, index) => vector ? -1 : index)
          .filter((index) => index >= 0);
        if (missing.length > 0) {
          const vectors = await this.embeddings.embedDocuments(
            missing.map((index) => this.#documents[index].content),
          );
          missing.forEach((documentIndex, vectorIndex) => {
            this.#vectors[documentIndex] = vectors[vectorIndex];
          });
        }
        const queryVector = await this.embeddings.embedQuery(query);
        return this.#documents
          .map((document, index) => ({
            ...document,
            score: cosineSimilarity(queryVector, this.#vectors[index]),
          }))
          .sort((left, right) => right.score - left.score)
          .slice(0, topK);
      } catch (error) {
        console.warn(`[LongTermMemory] Embedding检索失败，降级为关键词检索: ${error.message}`);
      }
    }

    return this.#keywordSearch(query, topK);
  }

  #keywordSearch(query, topK) {
    const terms = tokenize(query);
    return this.#documents
      .map((document) => ({
        ...document,
        score: terms.reduce(
          (score, term) => score + (document.content.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter((document) => document.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }
}

function cosineSimilarity(left, right) {
  if (!left?.length || left.length !== right?.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
