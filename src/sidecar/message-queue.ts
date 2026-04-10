import Redis from 'ioredis';
import { EventEmitter } from 'node:events';
import type { AgentMessage, FlushResult } from './types.js';

interface QueueOptions {
  flushIntervalMs: number;
  flushSizeLimit: number;
  recentMessageLimit: number;
}

/**
 * In-memory message queue backed by Redis for durability.
 * Flushes to a callback (Slack transport) on interval or size limit.
 */
export class MessageQueue extends EventEmitter {
  private buffer: AgentMessage[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private readonly redisKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly agentId: string,
    private readonly options: QueueOptions,
    private readonly onFlush: (messages: AgentMessage[]) => Promise<FlushResult>,
  ) {
    super();
    this.redisKey = `wandr:${agentId}:messages`;
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Final flush on stop
    void this.flush();
  }

  async enqueue(message: Omit<AgentMessage, 'sequence'>): Promise<void> {
    const msg: AgentMessage = { ...message, sequence: this.sequence++ };
    this.buffer.push(msg);

    // Persist to Redis for durability
    await this.redis.lpush(this.redisKey, JSON.stringify(msg));
    await this.redis.ltrim(this.redisKey, 0, this.options.recentMessageLimit - 1);

    // Flush if buffer hits size limit
    if (this.buffer.length >= this.options.flushSizeLimit) {
      await this.flush();
    }
  }

  async flush(): Promise<FlushResult> {
    if (this.buffer.length === 0) {
      return { flushed: 0 };
    }

    const batch = this.buffer.splice(0);
    try {
      const result = await this.onFlush(batch);
      this.emit('flush', result);
      return result;
    } catch (err) {
      // Put messages back at front of buffer on failure
      this.buffer.unshift(...batch);
      const error = err instanceof Error ? err.message : String(err);
      this.emit('flush-error', error);
      return { flushed: 0, error };
    }
  }

  async getRecent(limit = 50): Promise<AgentMessage[]> {
    const raw = await this.redis.lrange(this.redisKey, 0, limit - 1);
    return raw.map((r) => JSON.parse(r) as AgentMessage);
  }

  get pending(): number {
    return this.buffer.length;
  }
}
