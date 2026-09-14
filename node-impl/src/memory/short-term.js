export class ShortTermMemory {
  #store = new Map();

  constructor({ maxTurns = 20, ttlSeconds = 1800 } = {}) {
    this.maxTurns = maxTurns;
    this.ttlMilliseconds = ttlSeconds * 1000;
  }

  addMessage(sessionId, role, content) {
    this.#removeIfExpired(sessionId);
    const session = this.#store.get(sessionId) ?? { messages: [] };
    session.messages.push({ role, content, timestamp: new Date().toISOString() });
    session.messages = session.messages.slice(-this.maxTurns);
    session.expiresAt = Date.now() + this.ttlMilliseconds;
    this.#store.set(sessionId, session);
  }

  getHistory(sessionId, lastN) {
    this.#removeIfExpired(sessionId);
    const messages = this.#store.get(sessionId)?.messages ?? [];
    return structuredClone(lastN ? messages.slice(-lastN) : messages);
  }

  getContextWindow(sessionId, maxCharacters = 8000) {
    const history = this.getHistory(sessionId);
    const parts = [];
    let length = 0;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const part = `${history[index].role}: ${history[index].content}`;
      if (length + part.length > maxCharacters) break;
      parts.unshift(part);
      length += part.length;
    }
    return parts.join("\n");
  }

  clear(sessionId) {
    this.#store.delete(sessionId);
  }

  #removeIfExpired(sessionId) {
    const session = this.#store.get(sessionId);
    if (session?.expiresAt <= Date.now()) this.#store.delete(sessionId);
  }
}
