export class WorkingMemory {
  #contexts = new Map();
  #history = new Map();

  update(sessionId, data) {
    this.#contexts.set(sessionId, {
      ...(this.#contexts.get(sessionId) ?? {}),
      ...data,
    });

    const history = this.#history.get(sessionId) ?? [];
    history.push({ timestamp: new Date().toISOString(), data: { ...data } });
    this.#history.set(sessionId, history.slice(-50));
  }

  getContext(sessionId) {
    return { ...(this.#contexts.get(sessionId) ?? {}) };
  }

  clear(sessionId) {
    this.#contexts.delete(sessionId);
    this.#history.delete(sessionId);
  }
}
