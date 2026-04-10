import type { WebClient } from '@slack/web-api';
import type { AgentMessage, FlushResult, MessageType } from './types.js';
import { stripAnsi, BOX_DRAWING_REGEX, isNoiseLine } from './log-tailer.js';

const TYPE_EMOJI: Record<MessageType, string> = {
  output: ':speech_balloon:',
  error: ':rotating_light:',
  approval_gate: ':lock:',
  system: ':gear:',
};

/**
 * Defense-in-depth sanitizer for output messages bound for Slack.
 * The log-tailer already filters most TUI noise, but multi-line buffered
 * content can still slip through — re-run the same filters per line here.
 */
export function sanitizeOutput(content: string): string {
  const cleaned = stripAnsi(content);
  const kept: string[] = [];
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(BOX_DRAWING_REGEX, '').trimEnd();
    if (isNoiseLine(line)) continue;
    if (line.trim().length === 0) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function formatBatch(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const emoji = TYPE_EMOJI[msg.type];
    const ts = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour12: false });
    const prefix = `${emoji} \`${ts}\` *[${msg.agentId}]*`;

    if (msg.type === 'error') {
      lines.push(`${prefix}\n\`\`\`${msg.content}\`\`\``);
    } else {
      const content = msg.type === 'output' ? sanitizeOutput(msg.content) : msg.content;
      if (content.trim().length === 0) continue;
      lines.push(`${prefix} ${content}`);
    }
  }
  return lines.join('\n');
}

/**
 * Sends batched messages to a Slack channel.
 */
export class SlackTransport {
  constructor(
    private readonly slack: WebClient,
    private readonly channelId: string,
  ) {}

  async sendBatch(messages: AgentMessage[]): Promise<FlushResult> {
    if (messages.length === 0) {
      return { flushed: 0 };
    }

    const text = formatBatch(messages);

    if (text.trim().length === 0) {
      return { flushed: messages.length };
    }

    const result = await this.slack.chat.postMessage({
      channel: this.channelId,
      text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });

    return {
      flushed: messages.length,
      slackTs: result.ts,
    };
  }

  /**
   * Post a raw checkpoint message, bypassing batching and sanitization.
   */
  async postCheckpoint(text: string): Promise<void> {
    await this.slack.chat.postMessage({
      channel: this.channelId,
      text,
      mrkdwn: true,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  async postApprovalRequest(
    agentId: string,
    approvalId: string,
    prompt: string,
  ): Promise<string | undefined> {
    const result = await this.slack.chat.postMessage({
      channel: this.channelId,
      text: `:lock: *Approval Required* — \`${agentId}\`\n\n${prompt}\n\n_Reply in thread with \`approve\` or \`deny\` (ID: \`${approvalId}\`)_`,
      mrkdwn: true,
    });
    return result.ts;
  }
}
