// 使用 Node 内置哈希为文档生成稳定 ID，不引入额外依赖。
import { createHash } from "node:crypto";

// 英文按单词切分；连续中文生成二元词组，避免中文无空格导致整句无法召回。
function tokenize(text) {
  // 统一小写，使英文检索不区分大小写。
  const normalized = text.toLowerCase();
  // 英文/数字按连续字符切词。
  const latin = normalized.match(/[a-z0-9]+/g) ?? [];
  // 中文没有天然空格，先抽取连续汉字片段。
  const chineseRuns = normalized.match(/[\u3400-\u9fff]+/g) ?? [];
  // 对每个中文片段生成二元字组，例如“投资期限”→“投资、资期、期限”。
  const chinese = chineseRuns.flatMap((run) => {
    if (run.length < 2) return [run];
    return Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2));
  });
  // Set 去重，避免同一个词重复出现时人为抬高分数。
  return [...new Set([...latin, ...chinese])];
}

/**
 * 长期记忆：优先使用OpenAI Embeddings和余弦相似度，异常时回退关键词检索。
 * 文档和向量保存在当前进程；生产环境可替换为持久化向量库或混合检索。
 * documents 与 vectors 使用相同数组下标一一对应：documents[i] 的向量就是 vectors[i]。
 */
export class LongTermMemory {
  #documents = [];
  #vectors = [];

  constructor({ embeddings = null } = {}) {
    // embeddings 为 null 时 search 会直接使用关键词模式。
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
    // 新文档的向量先设为 null，首次搜索时再批量计算，降低应用启动成本。
    this.#vectors.push(null);
    return document.id;
  }

  addDocumentsBatch(documents) {
    // 复用单篇添加逻辑，确保 ID 和向量占位规则完全一致。
    return documents.map((doc) => this.addDocument(doc.content, doc.source, doc.metadata));
  }

  /** 优先执行Embedding余弦相似度检索，模型不可用时回退关键词覆盖数排序。 */
  async search(query, topK = 5) {
    // 只有同时存在 Embedding 客户端和文档时才进入向量检索。
    if (this.embeddings && this.#documents.length > 0) {
      try {
        // 找出尚未计算向量的文档下标，实现惰性向量缓存。
        const missing = this.#vectors
          .map((vector, index) => vector ? -1 : index)
          .filter((index) => index >= 0);
        if (missing.length > 0) {
          // 一次批量请求缺失文档，减少外部 Embedding API 调用次数。
          const vectors = await this.embeddings.embedDocuments(
            missing.map((index) => this.#documents[index].content),
          );
          missing.forEach((documentIndex, vectorIndex) => {
            this.#vectors[documentIndex] = vectors[vectorIndex];
          });
        }
        // 查询只需计算一个向量，再与所有文档向量计算余弦相似度。
        const queryVector = await this.embeddings.embedQuery(query);
        return this.#documents
          .map((document, index) => ({
            ...document,
            score: cosineSimilarity(queryVector, this.#vectors[index]),
          }))
          .sort((left, right) => right.score - left.score)
          .slice(0, topK);
      } catch (error) {
        // API/网络/维度异常都不影响可用性，继续执行下方关键词检索。
        console.warn(`[LongTermMemory] Embedding检索失败，降级为关键词检索: ${error.message}`);
      }
    }

    return this.#keywordSearch(query, topK);
  }

  #keywordSearch(query, topK) {
    // 分数是“查询词在文档中出现的种类数”；这是简单兜底，不等价于语义相似度。
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
  // 缺失向量或维度不同无法比较，按 0 分处理。
  if (!left?.length || left.length !== right?.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  // 一次循环同时计算点积和两个向量的平方范数。
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
