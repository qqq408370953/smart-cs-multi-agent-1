import { createClient } from "redis";

/**
 * 短期记忆：Redis + TTL + 滑动消息窗口。
 * 未配置REDIS_URL或连接失败时自动降级为进程内Map，保证本地仍能运行。
 */
export class ShortTermMemory {
  #store = new Map();
  #redis = null;
  #connectionPromise = null;
  #connectionAttempted = false;

  constructor({ redisUrl = process.env.REDIS_URL, maxTurns = 20, ttlSeconds = 1800 } = {}) {
    this.redisUrl = redisUrl;
    this.maxTurns = maxTurns;
    this.ttlMilliseconds = ttlSeconds * 1000;
    this.ttlSeconds = ttlSeconds;
  }

  /** 写入一条消息，并刷新会话TTL。 */
  async addMessage(sessionId, role, content) {
    const message = { role, content, timestamp: new Date().toISOString() };
    const redis = await this.#getRedis();
    if (redis) {
      const key = this.#sessionKey(sessionId);
      await redis.rPush(key, JSON.stringify(message));
      await redis.lTrim(key, -this.maxTurns, -1);
      await redis.expire(key, this.ttlSeconds);
      return;
    }

    this.#removeIfExpired(sessionId);
    const session = this.#store.get(sessionId) ?? { messages: [] };
    session.messages.push(message);
    session.messages = session.messages.slice(-this.maxTurns);
    session.expiresAt = Date.now() + this.ttlMilliseconds;
    this.#store.set(sessionId, session);
  }

  /** 读取历史副本，可选只返回最后N条。 */
  async getHistory(sessionId, lastN) {
    const redis = await this.#getRedis();
    if (redis) {
      const count = lastN ?? this.maxTurns;
      const raw = await redis.lRange(this.#sessionKey(sessionId), -count, -1);
      return raw.map((item) => JSON.parse(item));
    }

    this.#removeIfExpired(sessionId);
    const messages = this.#store.get(sessionId)?.messages ?? [];
    return structuredClone(lastN ? messages.slice(-lastN) : messages);
  }

  /** 从最近消息向前构造一个受字符数限制的上下文窗口。 */
  async getContextWindow(sessionId, maxCharacters = 8000) {
    const history = await this.getHistory(sessionId);
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

  async clear(sessionId) {
    const redis = await this.#getRedis();
    if (redis) await redis.del(this.#sessionKey(sessionId));
    this.#store.delete(sessionId);
  }

  /** 关闭Redis连接；进程内回退模式无需操作。 */
  async close() {
    if (this.#redis?.isOpen) await this.#redis.quit();
    this.#redis = null;
  }

  #sessionKey(sessionId) {
    return `smartcs:short_term:${sessionId}`;
  }

  async #getRedis() {
    if (!this.redisUrl) return null;
    if (this.#redis?.isReady) return this.#redis;
    if (this.#connectionAttempted && !this.#connectionPromise) return null;
    if (!this.#connectionPromise) {
      this.#connectionAttempted = true;
      const client = createClient({
        url: this.redisUrl,
        socket: { connectTimeout: 500, reconnectStrategy: false },
      });
      client.on("error", () => {});
      this.#connectionPromise = client.connect()
        .then(() => {
          this.#redis = client;
          console.info(`[ShortTermMemory] 已连接Redis: ${this.redisUrl}`);
          return client;
        })
        .catch((error) => {
          console.warn(`[ShortTermMemory] Redis不可用，降级为进程内存: ${error.message}`);
          client.destroy();
          return null;
        })
        .finally(() => {
          this.#connectionPromise = null;
        });
    }
    return this.#connectionPromise;
  }

  #removeIfExpired(sessionId) {
    const session = this.#store.get(sessionId);
    if (session?.expiresAt <= Date.now()) this.#store.delete(sessionId);
  }
}
