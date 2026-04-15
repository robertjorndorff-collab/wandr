import type Redis from 'ioredis';
import type { AgentStatus } from './types.js';

export const HEARTBEAT_TTL_SECONDS = 120;

/**
 * Redis-backed state store for agent status.
 * Keys namespaced by agent ID: wandr:{agentId}:state
 */
export class StateStore {
  private readonly stateKey: string;
  private readonly heartbeatKey: string;
  private readonly registryKey = 'wandr:agents';

  constructor(
    private readonly redis: Redis,
    private readonly agentId: string,
  ) {
    this.stateKey = `wandr:${agentId}:state`;
    this.heartbeatKey = `wandr:${agentId}:heartbeat`;
  }

  /** Pulse heartbeat — orchestrator treats absence of key as DEAD. */
  async heartbeat(): Promise<void> {
    await this.redis.set(this.heartbeatKey, String(Date.now()), 'EX', HEARTBEAT_TTL_SECONDS);
  }

  static heartbeatKeyFor(agentId: string): string {
    return `wandr:${agentId}:heartbeat`;
  }

  static async getHeartbeat(redis: Redis, agentId: string): Promise<number | null> {
    const raw = await redis.get(StateStore.heartbeatKeyFor(agentId));
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
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
    try {
      await this.redis.del(this.heartbeatKey);
    } catch { /* best-effort */ }
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
