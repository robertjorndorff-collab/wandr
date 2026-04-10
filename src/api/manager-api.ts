import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type Redis from 'ioredis';
import { StateStore } from '../sidecar/state-store.js';
import type { AgentMessage, ApprovalRequest, ManagerDigest } from '../sidecar/types.js';

/**
 * Lightweight HTTP API for Clai to query agent status.
 * No Express — native http module keeps it minimal.
 */
export class ManagerAPI {
  private server: ReturnType<typeof createServer> | null = null;

  constructor(private readonly redis: Redis) {}

  start(port: number, host: string): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.listen(port, host, () => {
        console.log(`[wandr] Manager API listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        const agents = await StateStore.getAllAgents(this.redis);
        this.json(res, 200, { agents });
      } else if (req.method === 'GET' && url.pathname === '/approvals') {
        const approvals = await this.getAllApprovals();
        this.json(res, 200, { approvals });
      } else if (req.method === 'GET' && url.pathname === '/digest') {
        const digest = await this.getDigest();
        this.json(res, 200, digest);
      } else if (req.method === 'GET' && url.pathname === '/health') {
        this.json(res, 200, { ok: true, timestamp: new Date().toISOString() });
      } else {
        this.json(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[wandr] API error: ${message}`);
      this.json(res, 500, { error: message });
    }
  }

  private async getDigest(): Promise<ManagerDigest> {
    const agents = await StateStore.getAllAgents(this.redis);
    const approvals = await this.getAllApprovals();
    const recentMessages = await this.getRecentMessages();

    return {
      agents,
      pendingApprovals: approvals.filter((a) => !a.resolvedAt),
      recentMessages,
      queriedAt: new Date().toISOString(),
    };
  }

  private async getAllApprovals(): Promise<ApprovalRequest[]> {
    const agentIds = await this.redis.smembers('wandr:agents');
    const approvals: ApprovalRequest[] = [];

    for (const id of agentIds) {
      const raw = await this.redis.hgetall(`wandr:${id}:approvals`);
      for (const value of Object.values(raw)) {
        approvals.push(JSON.parse(value) as ApprovalRequest);
      }
    }

    return approvals;
  }

  private async getRecentMessages(): Promise<AgentMessage[]> {
    const agentIds = await this.redis.smembers('wandr:agents');
    const messages: AgentMessage[] = [];

    for (const id of agentIds) {
      const raw = await this.redis.lrange(`wandr:${id}:messages`, 0, 19);
      for (const value of raw) {
        messages.push(JSON.parse(value) as AgentMessage);
      }
    }

    // Sort by timestamp descending
    messages.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return messages.slice(0, 50);
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
