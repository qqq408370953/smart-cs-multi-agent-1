// 官方 redis 客户端。连接是惰性的：构造 ShortTermMemory 时不会立刻访问 Redis。
import { createClient } from "redis";

/**
 * 短期记忆：Redis + TTL + 滑动消息窗口。
 * 未配置REDIS_URL或连接失败时自动降级为进程内Map，保证本地仍能运行。
 *
 * 每个会话保存形如 { role, content, timestamp } 的消息列表。
 * Redis 模式使用 List + EXPIRE；内存模式使用 Map + expiresAt 模拟相同行为。
 */
export class ShortTermMemory {
  // Redis 不可用时的后备存储：sessionId -> { messages, expiresAt }。
  #store = new Map();
  // 已经成功连接的客户端。
  #redis = null;
  // 共享正在进行的连接 Promise，防止并发首请求重复创建连接。
  #connectionPromise = null;
  // 一次连接失败后不在每条消息上反复尝试，避免持续增加请求延迟。
  #connectionAttempted = false;

  constructor({ redisUrl = process.env.REDIS_URL, maxTurns = 20, ttlSeconds = 1800 } = {}) {
    this.redisUrl = redisUrl;
    this.maxTurns = maxTurns;
    // 内存模式使用毫秒，Redis EXPIRE 使用秒，所以保留两种单位。
    this.ttlMilliseconds = ttlSeconds * 1000;
    this.ttlSeconds = ttlSeconds;
  }

  /** 写入一条消息，并刷新会话TTL。 */
  async addMessage(sessionId, role, content) {
    // 每次写入都加服务端时间戳，客户端不负责提供可信时间。
    const message = { role, content, timestamp: new Date().toISOString() };
    // 第一次调用时才真正连接 Redis；返回 null 代表应使用内存降级。
    const redis = await this.#getRedis();
    if (redis) {
      const key = this.#sessionKey(sessionId);
      // RPUSH 按时间顺序追加；LTRIM 只保留尾部 maxTurns 条；EXPIRE 刷新会话 TTL。
      await redis.rPush(key, JSON.stringify(message));
      await redis.lTrim(key, -this.maxTurns, -1);
      await redis.expire(key, this.ttlSeconds);
      return;
    }

    // 内存模式先懒清理过期会话，再追加消息并实现同样的滑动窗口和 TTL。
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
      // 负索引表示从 List 尾部读取，符合“最近 N 条”的语义。
      const raw = await redis.lRange(this.#sessionKey(sessionId), -count, -1);
      return raw.map((item) => JSON.parse(item));
    }

    this.#removeIfExpired(sessionId);
    const messages = this.#store.get(sessionId)?.messages ?? [];
    // structuredClone 确保调用方修改返回结果时不会污染内部消息。
    return structuredClone(lastN ? messages.slice(-lastN) : messages);
  }

  /** 从最近消息向前构造一个受字符数限制的上下文窗口。 */
  async getContextWindow(sessionId, maxCharacters = 8000) {
    const history = await this.getHistory(sessionId);
    const parts = [];
    let length = 0;
    // 从最新消息倒序选取，达到字符上限后停止，再用 unshift 恢复时间正序。
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
    // 固定命名空间避免与同一个 Redis 中其他业务的 key 冲突。
    return `smartcs:short_term:${sessionId}`;
  }

  async #getRedis() {
    // 未配置地址就是明确选择内存模式。
    if (!this.redisUrl) return null;
    // 已就绪时直接复用连接。
    if (this.#redis?.isReady) return this.#redis;
    // 之前已经尝试且当前没有连接过程，说明连接失败，保持内存降级。
    if (this.#connectionAttempted && !this.#connectionPromise) return null;
    if (!this.#connectionPromise) {
      this.#connectionAttempted = true;
      // 本地学习环境快速失败：500ms 连接超时且不自动重连，避免无 Redis 时请求长时间挂起。
      const client = createClient({
        url: this.redisUrl,
        socket: { connectTimeout: 500, reconnectStrategy: false },
      });
      // error 事件必须注册监听器，否则 Node EventEmitter 可能把未处理 error 当作进程异常。
      client.on("error", () => {});
      this.#connectionPromise = client.connect()
        .then(() => {
          // 只有 connect 成功后才发布到 #redis，避免其他请求拿到半连接客户端。
          this.#redis = client;
          console.info(`[ShortTermMemory] 已连接Redis: ${this.redisUrl}`);
          return client;
        })
        .catch((error) => {
          // 销毁失败客户端并返回 null，当前业务请求会无缝切换到 Map。
          console.warn(`[ShortTermMemory] Redis不可用，降级为进程内存: ${error.message}`);
          client.destroy();
          return null;
        })
        .finally(() => {
          // 无论成功失败都清空“连接中”标记。
          this.#connectionPromise = null;
        });
    }
    return this.#connectionPromise;
  }

  #removeIfExpired(sessionId) {
    // 内存模式没有后台清理线程，读写该会话时进行懒删除。
    const session = this.#store.get(sessionId);
    if (session?.expiresAt <= Date.now()) this.#store.delete(sessionId);
  }
}
