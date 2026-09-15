/**
 * 工作记忆：按session隔离当前推理上下文，保留最近50条状态变更。
 * 数据仅存在当前Node.js进程内，重启后清空。
 *
 * 它和另外两类“记忆”的区别：
 * - 不保存完整聊天内容（那是 ShortTermMemory）；
 * - 不保存可检索知识文档（那是 LongTermMemory）；
 * - 不保存 LangGraph 每个节点的完整 State（那是 MemorySaver Checkpoint）。
 * 当前 Supervisor 主要用它记录最近一次路由意图和时间。
 */
export class WorkingMemory {
  // sessionId -> 合并后的最新上下文。
  #contexts = new Map();
  // sessionId -> 最近 50 次 update 的不可变快照。
  #history = new Map();

  /** 合并会话上下文并记录一次不可变的历史快照。 */
  update(sessionId, data) {
    // 新字段覆盖同名旧字段，未出现在 data 中的旧字段继续保留。
    this.#contexts.set(sessionId, {
      ...(this.#contexts.get(sessionId) ?? {}),
      ...data,
    });

    // 另存一份浅拷贝作为时间序列，便于未来排查路由变化。
    const history = this.#history.get(sessionId) ?? [];
    history.push({ timestamp: new Date().toISOString(), data: { ...data } });
    // slice(-50) 给内存设置上限，避免长会话无限增长。
    this.#history.set(sessionId, history.slice(-50));
  }

  /** 返回上下文副本，防止调用方直接修改内部Map。 */
  getContext(sessionId) {
    return { ...(this.#contexts.get(sessionId) ?? {}) };
  }

  clear(sessionId) {
    // 同时清除最新上下文和历史，避免残留半份会话状态。
    this.#contexts.delete(sessionId);
    this.#history.delete(sessionId);
  }
}
