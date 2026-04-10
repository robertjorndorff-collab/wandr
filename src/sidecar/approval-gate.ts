import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type Redis from 'ioredis';
import type { ApprovalRequest } from './types.js';
import type { SlackTransport } from './slack-transport.js';

/**
 * Manages approval request lifecycle.
 * Posts to Slack, listens for responses, emits events to unblock agents.
 * Event-driven — no polling.
 */
export class ApprovalGate extends EventEmitter {
  private readonly redisKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly agentId: string,
    private readonly transport: SlackTransport,
  ) {
    super();
    this.redisKey = `wandr:${agentId}:approvals`;
  }

  /**
   * Request approval. Returns a promise that resolves when operator responds.
   */
  async request(prompt: string): Promise<{ approved: boolean; respondedBy?: string }> {
    const id = randomUUID();
    const approval: ApprovalRequest = {
      id,
      agentId: this.agentId,
      prompt,
      createdAt: new Date().toISOString(),
    };

    // Persist to Redis
    await this.redis.hset(this.redisKey, id, JSON.stringify(approval));

    // Post to Slack
    await this.transport.postApprovalRequest(this.agentId, id, prompt);

    this.emit('requested', approval);

    // Wait for resolution — event-driven, no polling
    return new Promise((resolve) => {
      const handler = (resolvedId: string, approved: boolean, respondedBy?: string) => {
        if (resolvedId === id) {
          this.off('resolved', handler);
          resolve({ approved, respondedBy });
        }
      };
      this.on('resolved', handler);
    });
  }

  /**
   * Called when a Slack message matches an approval response.
   * Resolves the pending approval and emits to unblock the waiting agent.
   */
  async resolve(approvalId: string, approved: boolean, respondedBy?: string): Promise<void> {
    const raw = await this.redis.hget(this.redisKey, approvalId);
    if (!raw) return;

    const approval: ApprovalRequest = JSON.parse(raw);
    approval.resolvedAt = new Date().toISOString();
    approval.approved = approved;
    approval.respondedBy = respondedBy;

    // Update in Redis
    await this.redis.hset(this.redisKey, approvalId, JSON.stringify(approval));

    this.emit('resolved', approvalId, approved, respondedBy);
  }

  async getPending(): Promise<ApprovalRequest[]> {
    const all = await this.redis.hgetall(this.redisKey);
    return Object.values(all)
      .map((raw) => JSON.parse(raw) as ApprovalRequest)
      .filter((a) => !a.resolvedAt);
  }

  async getAll(): Promise<ApprovalRequest[]> {
    const all = await this.redis.hgetall(this.redisKey);
    return Object.values(all).map((raw) => JSON.parse(raw) as ApprovalRequest);
  }
}
