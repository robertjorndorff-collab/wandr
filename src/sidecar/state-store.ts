import type Redis from 'ioredis';
import type { AgentStatus } from './types.js';

/**
 * Redis-backed state store for agent status.
 * Keys namespaced by agent ID: wandr:{agentId}:state
 */
export class StateStore {
  private readonly stateKey: string;
  private readonly registryKey = 'wandr:agents';

  constructor(
    private readonly redis: Redis,
    private readonly agentId: string,
  ) {
    this.stateKey = `wandr:${agentId}:state`;
  }

  async register(pid?: number): Promise<void> {
    const status: AgentStatus = {
      agentId: this.agentId,
      state: 'running',
      pid,
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      messageCount: 0,
      pendingApprovals: [],
    };
    await this.redis.set(this.stateKey, JSON.stringify(status));
    await this.redis.sadd(this.registryKey, this.agentId);
  }

  async update(patch: Partial<AgentStatus>): Promise<void> {
    const current = await this.get();
    if (!current) return;
    const updated = { ...current, ...patch, lastActivity: new Date().toISOString() };
    await this.redis.set(this.stateKey, JSON.stringify(updated));
  }

  async incrementMessages(): Promise<void> {
    const current = await this.get();
    if (!current) return;
    await this.update({ messageCount: current.messageCount + 1 });
  }

  async get(): Promise<AgentStatus | null> {
    const raw = await this.redis.get(this.stateKey);
    return raw ? (JSON.parse(raw) as AgentStatus) : null;
  }

  async deregister(): Promise<void> {
    await this.update({ state: 'stopped' });
  }

  /** Get all registered agent statuses */
  static async getAllAgents(redis: Redis): Promise<AgentStatus[]> {
    const agentIds = await redis.smembers('wandr:agents');
    const statuses: AgentStatus[] = [];
    for (const id of agentIds) {
      const raw = await redis.get(`wandr:${id}:state`);
      if (raw) {
        statuses.push(JSON.parse(raw) as AgentStatus);
      }
    }
    return statuses;
  }
}
