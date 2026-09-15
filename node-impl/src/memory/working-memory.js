/**
 * 工作记忆：按session隔离当前推理上下文，保留最近50条状态变更。
 * 数据仅存在当前Node.js进程内，重启后清空。
 */
export class WorkingMemory {
  #contexts = new Map();
  #history = new Map();

  /** 合并会话上下文并记录一次不可变的历史快照。 */
  update(sessionId, data) {
    this.#contexts.set(sessionId, {
      ...(this.#contexts.get(sessionId) ?? {}),
      ...data,
    });

    const history = this.#history.get(sessionId) ?? [];
    history.push({ timestamp: new Date().toISOString(), data: { ...data } });
    this.#history.set(sessionId, history.slice(-50));
  }

  /** 返回上下文副本，防止调用方直接修改内部Map。 */
  getContext(sessionId) {
    return { ...(this.#contexts.get(sessionId) ?? {}) };
  }

  clear(sessionId) {
    this.#contexts.delete(sessionId);
    this.#history.delete(sessionId);
  }
}
