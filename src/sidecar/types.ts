export type MessageType = 'output' | 'error' | 'approval_gate' | 'system';

export interface AgentMessage {
  timestamp: string;
  agentId: string;
  type: MessageType;
  content: string;
  sequence: number;
}

export interface ApprovalRequest {
  id: string;
  agentId: string;
  prompt: string;
  createdAt: string;
  resolvedAt?: string;
  approved?: boolean;
  respondedBy?: string;
}

export interface AgentStatus {
  agentId: string;
  state: 'running' | 'idle' | 'waiting_approval' | 'stopped' | 'error';
  pid?: number;
  startedAt: string;
  lastActivity: string;
  messageCount: number;
  pendingApprovals: string[];
}

export interface FlushResult {
  flushed: number;
  slackTs?: string;
  error?: string;
}

export interface ManagerDigest {
  agents: AgentStatus[];
  pendingApprovals: ApprovalRequest[];
  recentMessages: AgentMessage[];
  queriedAt: string;
}

export interface SidecarConfig {
  agentId: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}
