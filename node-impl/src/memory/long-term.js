import { createHash } from "node:crypto";

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

export class LongTermMemory {
  #documents = [];

  addDocument(content, source = "", metadata = {}) {
    const document = {
      id: createHash("md5").update(content).digest("hex").slice(0, 12),
      content,
      source,
      metadata,
    };
    this.#documents.push(document);
    return document.id;
  }

  addDocumentsBatch(documents) {
    return documents.map((doc) => this.addDocument(doc.content, doc.source, doc.metadata));
  }

  search(query, topK = 5) {
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
