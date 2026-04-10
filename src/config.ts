import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    signingSecret: required('SLACK_SIGNING_SECRET'),
    channelId: required('SLACK_CHANNEL_ID'),
  },
  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },
  sidecar: {
    flushIntervalMs: Number(optional('FLUSH_INTERVAL_MS', '2000')),
    flushSizeLimit: Number(optional('FLUSH_SIZE_LIMIT', '20')),
    recentMessageLimit: Number(optional('RECENT_MESSAGE_LIMIT', '100')),
  },
  api: {
    port: Number(optional('MANAGER_API_PORT', '9400')),
    host: optional('MANAGER_API_HOST', '127.0.0.1'),
  },
  agent: {
    gracePeriodMs: Number(optional('AGENT_GRACE_PERIOD_MS', '30000')),
    heartbeatIntervalMs: Number(optional('HEARTBEAT_INTERVAL_MS', '5000')),
  },
} as const;
