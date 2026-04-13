import Redis from 'ioredis';
import { WebClient } from '@slack/web-api';
import { App as SlackApp } from '@slack/bolt';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { AgentSidecar } from './sidecar/agent-sidecar.js';
import { SlackTransport } from './sidecar/slack-transport.js';
import { LogTailer } from './sidecar/log-tailer.js';
import { InputBridge } from './sidecar/input-bridge.js';
import { MessageQueue } from './sidecar/message-queue.js';
import { Checkpoint } from './sidecar/checkpoint.js';
import { LexiconStore } from './sidecar/lexicon-store.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { StateStore } from './sidecar/state-store.js';
import { ManagerAPI } from './api/manager-api.js';
import { runUp, runDown } from './cli/up.js';

const APPROVE_PATTERN = /^(approve|yes|go|go ahead)\s*$/i;
const DENY_PATTERN = /^(deny|no|stop|reject)\s*$/i;
const APPROVAL_ID_PATTERN = /ID:\s*`([^`]+)`/;

// Messages directed at this agent trigger a task.
// Format in Slack: "!<agent-id> <prompt>"
const TASK_PATTERN = /^!(\S+)\s+(.+)$/s;

// Lexicon admin: !lexicon list  |  !lexicon add <key> <description>  |  !lexicon rm <key>
const LEXICON_PATTERN = /^!lexicon\s+(list|add|rm)(?:\s+(\S+))?(?:\s+(.+))?$/s;
// On-demand capability spec: !spec <need>
const SPEC_PATTERN = /^!spec\s+(.+)$/s;
// Operator presence ping: !ping
const PING_PATTERN = /^!ping\s*$/i;
// Channel purge: !purge | !clear | !purge 50 | !purge all
const PURGE_PATTERN = /^!(?:purge|clear)(?:\s+(\d+|all))?\s*$/i;

// Heartbeat: how long without an operator message before we poke #wandr-ops
const OPERATOR_SILENCE_MS = 4 * 60 * 60 * 1000; // 4 hours

function printUsage(): void {
  console.error('Usage:');
  console.error('');
  console.error('  One-command mode (recommended):');
  console.error('    wandr up <agent-id> [extra-claude-flags...]');
  console.error('    Example: wandr up myapp-dev1 --dangerously-skip-permissions');
  console.error('');
  console.error('  Spawn mode (current — runs Claude in print mode per task):');
  console.error('    wandr <agent-id> <command> [extra-flags...]');
  console.error('    Example: wandr clode1 claude --dangerously-skip-permissions');
  console.error('');
  console.error('  Attach mode (new — tails existing agent log, no spawning):');
  console.error('    wandr --attach <agent-id>');
  console.error('    Example: wandr --attach myapp-dev1');
  console.error('');
  console.error('  Attach mode tails ~/.wandr/logs/<agent-id>.log and streams to Slack.');
  console.error('  Start the agent with: ./scripts/wandr-start.sh <agent-id>');
  process.exit(1);
}

// ─── Attach Mode ────────────────────────────────────────────────────
//
// Two sub-modes controlled by WANDR_ORCHESTRATOR env var:
//
//   Orchestrator (WANDR_ORCHESTRATOR=1):
//     Opens a single Socket Mode connection to Slack. Receives ALL inbound
//     !commands, matches the agent prefix, and routes to the correct agent's
//     input bridge at ~/.wandr/input/<agentId>.cmd. Also runs its own sidecar
//     duties (log tail, checkpoint, etc.) for the orchestrator agent.
//
//   Plain sidecar (default):
//     Outbound only — streams logs to Slack via REST API (WebClient), runs
//     checkpoint heartbeats, watches its own .cmd file for commands routed
//     by the orchestrator. Does NOT open Socket Mode.
//
// This eliminates the race condition where multiple Socket Mode connections
// compete for the same inbound messages.

async function mainAttach(agentId: string): Promise<void> {
  const isOrchestrator = process.env.WANDR_ORCHESTRATOR === '1';
  const wandrHome = join(homedir(), '.wandr');
  const logPath = join(wandrHome, 'logs', `${agentId}.log`);
  const cmdPath = join(wandrHome, 'input', `${agentId}.cmd`);

  // ── Common infrastructure (both orchestrator and plain sidecar) ──

  const redis = new Redis(config.redis.url);
  const slackClient = new WebClient(config.slack.botToken);
  const transport = new SlackTransport(slackClient, config.slack.channelId);

  const state = new StateStore(redis, agentId);
  const queue = new MessageQueue(
    redis,
    agentId,
    {
      flushIntervalMs: config.sidecar.flushIntervalMs,
      flushSizeLimit: config.sidecar.flushSizeLimit,
      recentMessageLimit: config.sidecar.recentMessageLimit,
    },
    (messages) => transport.sendBatch(messages),
  );

  const checkpoint = new Checkpoint(agentId, transport, logPath);
  const lexicon = new LexiconStore(join(process.cwd(), 'config', 'lexicon.json'));

  // Task queue for THIS agent — one prompt in flight at a time
  const taskQueue: string[] = [];
  let isBusy = false;

  // Log tailer — watches the agent's log file
  const tailer = new LogTailer(logPath);

  tailer.on('waiting', (path: string) => {
    console.log(`[wandr:attach] Waiting for log file: ${path}`);
  });

  tailer.on('attached', (path: string, offset: number) => {
    console.log(`[wandr:attach] Tailing ${path} (starting at byte ${offset})`);
  });

  tailer.on('line', (line: string) => {
    checkpoint.onActivity(line);
    void queue.enqueue({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'output',
      content: line,
    }).then(() => state.incrementMessages());
  });

  // MCP failure detection
  const mcpAlertsSeen = new Set<string>();

  tailer.on('mcp-alert', (label: string, rawLine: string) => {
    if (mcpAlertsSeen.has(label)) return;
    mcpAlertsSeen.add(label);
    console.error(`[wandr:attach] MCP failure detected: ${label}`);
    void transport.postCheckpoint(
      `⚠️ [${agentId}] MCP FAILURE: ${label}\n> \`${rawLine.slice(0, 200)}\``,
    );
    void state.update({ state: 'degraded' });
  });

  tailer.on('error', (err: Error) => {
    console.error(`[wandr:attach] Tailer error: ${err.message}`);
  });

  // Input bridge — watches .cmd file for commands routed by orchestrator
  const bridge = new InputBridge(cmdPath);

  bridge.on('ready', (path: string) => {
    console.log(`[wandr:attach] Input bridge watching: ${path}`);
  });

  bridge.on('command', (text: string) => {
    const has = spawnSync('tmux', ['has-session', '-t', agentId]);
    if (has.status !== 0) {
      console.error(`[wandr:attach] tmux session "${agentId}" missing — dropping command`);
      return;
    }
    const a = spawnSync('tmux', ['send-keys', '-t', agentId, '-l', '--', text]);
    if (a.status !== 0) {
      console.error(`[wandr:attach] tmux send-keys (text) failed: ${a.stderr?.toString() ?? ''}`);
      return;
    }
    const b = spawnSync('tmux', ['send-keys', '-t', agentId, 'Enter']);
    if (b.status !== 0) {
      console.error(`[wandr:attach] tmux send-keys (Enter) failed: ${b.stderr?.toString() ?? ''}`);
      return;
    }
    console.log(`[wandr:attach] Injected ${text.length} chars into tmux:${agentId}`);
  });

  const dispatch = async (prompt: string): Promise<void> => {
    try {
      await bridge.sendCommand(prompt);
      checkpoint.onTaskDispatched(prompt);
      await queue.enqueue({
        timestamp: new Date().toISOString(),
        agentId,
        type: 'system',
        content: `Command dispatched via input bridge: ${prompt.slice(0, 120)}`,
      });
      console.log(`[wandr:attach] Command dispatched to ${agentId}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[wandr:attach] Bridge error: ${errMsg}`);
    }
  };

  checkpoint.on('task-complete', () => {
    const next = taskQueue.shift();
    if (next) {
      void dispatch(next);
    } else {
      isBusy = false;
    }
  });

  checkpoint.on('restart-redispatch', (prompt: string) => {
    void bridge.sendCommand(prompt).catch((err) => {
      console.error(`[wandr:attach] Re-dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  // ── Orchestrator: Socket Mode listener + command routing ──

  let slackApp: InstanceType<typeof SlackApp> | null = null;
  let operatorSilenceTimer: ReturnType<typeof setInterval> | null = null;

  if (isOrchestrator) {
    if (!config.slack.appToken || !config.slack.signingSecret) {
      throw new Error(
        'Orchestrator requires SLACK_APP_TOKEN and SLACK_SIGNING_SECRET. ' +
        'Set these env vars or run without --orchestrator for outbound-only mode.',
      );
    }

    // Operator-silence heartbeat (dead-man's switch) — only the orchestrator
    // receives operator messages via Socket Mode, so only it can track silence.
    let lastOperatorMessageAt = Date.now();
    operatorSilenceTimer = setInterval(() => {
      if (Date.now() - lastOperatorMessageAt > OPERATOR_SILENCE_MS) {
        void transport.postCheckpoint(
          `👋 [${agentId}] OPERATOR CHECK-IN — no commands for 4h. Reply \`!ping\` to confirm presence.`,
        );
        lastOperatorMessageAt = Date.now();
      }
    }, 5 * 60 * 1000);

    // Bot user ID — for !purge scoping
    let botUserIdPromise: Promise<string | null> | null = null;
    const getBotUserId = (): Promise<string | null> => {
      if (!botUserIdPromise) {
        botUserIdPromise = slackClient.auth.test()
          .then((r) => (r.user_id as string | undefined) ?? null)
          .catch((err) => {
            console.error(`[wandr:orchestrator] auth.test failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          });
      }
      return botUserIdPromise;
    };

    const purgeBotMessages = async (limit: number | null): Promise<number> => {
      const botUserId = await getBotUserId();
      if (!botUserId) return 0;
      const channel = config.slack.channelId;
      let deleted = 0;
      let cursor: string | undefined;
      const target = limit ?? Infinity;

      while (deleted < target) {
        const resp = await slackClient.conversations.history({
          channel,
          limit: 100,
          cursor,
        });
        const messages = (resp.messages ?? []) as Array<{ user?: string; bot_id?: string; ts?: string; subtype?: string }>;
        for (const msg of messages) {
          if (deleted >= target) break;
          if (msg.user !== botUserId || !msg.ts) continue;
          try {
            await slackClient.chat.delete({ channel, ts: msg.ts });
            deleted += 1;
          } catch (err) {
            console.error(`[wandr:orchestrator] chat.delete failed for ts=${msg.ts}: ${err instanceof Error ? err.message : String(err)}`);
          }
          await new Promise((r) => setTimeout(r, 200));
        }
        cursor = resp.response_metadata?.next_cursor;
        if (!cursor) break;
      }
      return deleted;
    };

    slackApp = new SlackApp({
      token: config.slack.botToken,
      appToken: config.slack.appToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
    });

    slackApp.error(async (error) => {
      console.error(`[wandr:orchestrator] Bolt error: ${error.message ?? error}`);
    });

    slackApp.message(async ({ message, say }) => {
      try {
        const skipSubtypes = new Set(['bot_message', 'message_changed', 'message_deleted', 'message_replied']);
        if (message.subtype && skipSubtypes.has(message.subtype)) return;
        if (!('text' in message) || !message.text) return;

        const text = message.text.trim();
        lastOperatorMessageAt = Date.now();

        // ── Global commands (not agent-specific) ──

        // !ping — report all registered agents
        if (PING_PATTERN.test(text)) {
          const agents = await StateStore.getAllAgents(redis);
          if (agents.length === 0) {
            await say(`:wave: Orchestrator \`${agentId}\` online. No agents registered.`);
          } else {
            const lines = agents.map((a) =>
              `  \`${a.agentId}\` — ${a.state} (last: ${new Date(a.lastActivity).toLocaleTimeString('en-US', { hour12: false })})`,
            ).join('\n');
            await say(`:wave: Orchestrator \`${agentId}\` online. Agents:\n${lines}`);
          }
          return;
        }

        // !purge | !clear
        const purgeMatch = text.match(PURGE_PATTERN);
        if (purgeMatch) {
          const arg = purgeMatch[1];
          const limit: number | null = arg === 'all' ? null : arg ? parseInt(arg, 10) : 100;
          const label = limit === null ? 'all' : String(limit);
          await say(`:wastebasket: Purging up to ${label} bot messages...`);
          try {
            const n = await purgeBotMessages(limit);
            await say(`:wastebasket: Purged ${n} message${n === 1 ? '' : 's'}.`);
          } catch (err) {
            await say(`:x: Purge failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        // !lexicon list|add|rm
        const lexMatch = text.match(LEXICON_PATTERN);
        if (lexMatch) {
          const [, op, key, rest] = lexMatch;
          if (op === 'list') {
            await say(`:books: *Lexicon*\n${await lexicon.list()}`);
          } else if (op === 'add' && key && rest) {
            await lexicon.add(key, rest.trim());
            await say(`:white_check_mark: Lexicon: added \`${key}\``);
          } else if (op === 'rm' && key) {
            const removed = await lexicon.remove(key);
            await say(removed ? `:wastebasket: Lexicon: removed \`${key}\`` : `:x: Lexicon: \`${key}\` not found`);
          } else {
            await say(`Usage: \`!lexicon list\` | \`!lexicon add <key> <description>\` | \`!lexicon rm <key>\``);
          }
          return;
        }

        // !spec <need> — on-demand capability ticket
        const specMatch = text.match(SPEC_PATTERN);
        if (specMatch) {
          const need = specMatch[1].trim();
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const slug = need.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
          const ticketPath = join(process.cwd(), 'TICKETS', `ondemand-${ts}-${slug}.md`);
          const body = `# On-Demand: ${need}\n\n## Created: ${new Date().toISOString()}\n## Requested by: operator via Slack\n## Agent: ${agentId}\n\n## Need\n${need}\n\n## Status\n- [ ] Spec\n- [ ] Build\n- [ ] Deploy\n- [ ] Verify\n\n## Notes\nAuto-generated by \`!spec\` from #wandr-ops.\n`;
          await mkdir(join(process.cwd(), 'TICKETS'), { recursive: true });
          await writeFile(ticketPath, body, 'utf-8');
          await say(`:memo: On-demand ticket created: \`${ticketPath.split('/').pop()}\``);
          return;
        }

        // ── Agent-targeted commands: !<agentId> <prompt> ──

        const taskMatch = text.match(TASK_PATTERN);
        if (!taskMatch) return;

        const [, targetAgent, prompt] = taskMatch;

        if (targetAgent === agentId) {
          // Route to self — use local dispatch with queue
          if (isBusy) {
            taskQueue.push(prompt);
            await transport.postCheckpoint(
              `📋 [${agentId}] QUEUED: ${prompt.slice(0, 80)} (position ${taskQueue.length} in queue)`,
            );
            return;
          }
          isBusy = true;
          await say(`:rocket: Command sent to \`${agentId}\`: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`);
          void dispatch(prompt);
        } else {
          // Route to another agent — write directly to their .cmd file.
          // The target agent's InputBridge polls this file and injects into tmux.
          const targetCmdPath = join(wandrHome, 'input', `${targetAgent}.cmd`);
          try {
            await writeFile(targetCmdPath, prompt, 'utf-8');
            await say(`:rocket: Command routed to \`${targetAgent}\`: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`);
            console.log(`[wandr:orchestrator] Routed command to ${targetAgent} (${prompt.length} chars)`);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await say(`:x: Failed to route to \`${targetAgent}\`: ${errMsg}`);
            console.error(`[wandr:orchestrator] Route failed for ${targetAgent}: ${errMsg}`);
          }
        }
      } catch (err) {
        console.error(`[wandr:orchestrator] Message handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    await slackApp.start();
    console.log(`[wandr:orchestrator] Socket Mode active — routing commands for all agents`);
  }

  // ── Start common services ──

  const api = new ManagerAPI(redis);

  await api.start(config.api.port, config.api.host);
  await state.register();
  queue.start();
  await tailer.start();
  bridge.start();
  checkpoint.start();

  await queue.enqueue({
    timestamp: new Date().toISOString(),
    agentId,
    type: 'system',
    content: `Sidecar attached to \`${agentId}\` (${isOrchestrator ? 'orchestrator' : 'outbound-only'}). Streaming output to Slack.`,
  });

  console.log(`[wandr:attach] READY`);
  console.log(`[wandr:attach] Sidecar attached to agent "${agentId}"`);
  console.log(`[wandr:attach] Mode: ${isOrchestrator ? 'ORCHESTRATOR (Socket Mode + routing)' : 'SIDECAR (outbound REST only)'}`);
  console.log(`[wandr:attach] Log file: ${logPath}`);
  console.log(`[wandr:attach] Input bridge: ${cmdPath}`);
  console.log(`[wandr:attach] Slack channel: ${config.slack.channelId}`);
  console.log(`[wandr:attach] Manager API: http://${config.api.host}:${config.api.port}`);
  if (isOrchestrator) {
    console.log(`[wandr:attach] Send commands in Slack: !<agent-id> <prompt>`);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[wandr:attach] Received ${signal}, shutting down...`);
    if (operatorSilenceTimer) clearInterval(operatorSilenceTimer);
    checkpoint.stop();
    tailer.stop();
    bridge.stop();
    queue.stop();
    await state.deregister();
    await api.stop();
    if (slackApp) await slackApp.stop();
    redis.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ─── Spawn Mode (existing) ──────────────────────────────────────────

async function mainSpawn(agentId: string, command: string, extraArgs: string[]): Promise<void> {
  // Initialize connections
  const redis = new Redis(config.redis.url);
  const slackClient = new WebClient(config.slack.botToken);
  const transport = new SlackTransport(slackClient, config.slack.channelId);

  // Create sidecar — extra CLI args (like --dangerously-skip-permissions)
  // are passed as base args to every claude invocation.
  const sidecar = new AgentSidecar(
    { agentId, command, args: extraArgs },
    redis,
    transport,
    {
      flushIntervalMs: config.sidecar.flushIntervalMs,
      flushSizeLimit: config.sidecar.flushSizeLimit,
      recentMessageLimit: config.sidecar.recentMessageLimit,
    },
  );

  // Start Slack app to listen for tasks and approval responses
  const slackApp = new SlackApp({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    socketMode: true,
  });

  // Global error handler — prevents Bolt from silently dropping messages
  slackApp.error(async (error) => {
    console.error(`[wandr] Bolt error: ${error.message ?? error}`);
  });

  // Catch-all event listener for debugging — log every event type received
  slackApp.event(/.*/, async ({ event }) => {
    console.log(`[wandr:debug] Event received: type=${event.type} subtype=${'subtype' in event ? event.subtype : 'none'}`);
    if ('text' in event && typeof event.text === 'string') {
      console.log(`[wandr:debug] Text: ${event.text.slice(0, 100)}`);
    }
    if ('channel' in event) {
      console.log(`[wandr:debug] Channel: ${event.channel}`);
    }
  });

  // Listen for task commands: !<agent-id> <prompt>
  slackApp.message(async ({ message, say }) => {
    try {
    console.log(`[wandr:debug] message handler fired — subtype=${message.subtype ?? 'none'}, hasText=${'text' in message}, channel=${'channel' in message ? message.channel : '?'}`);

    // Only skip bot messages and message_changed/deleted subtypes.
    // Don't skip all subtypes — some normal messages have subtypes.
    const skipSubtypes = new Set(['bot_message', 'message_changed', 'message_deleted', 'message_replied']);
    if (message.subtype && skipSubtypes.has(message.subtype)) {
      console.log(`[wandr:debug] Skipping subtype: ${message.subtype}`);
      return;
    }
    if (!('text' in message) || !message.text) {
      console.log('[wandr:debug] No text in message, skipping');
      return;
    }

    const text = message.text.trim();
    console.log(`[wandr:debug] Processing text: "${text.slice(0, 100)}"`);

    // --- Approval responses (thread replies) ---
    if ('thread_ts' in message && message.thread_ts) {
      const isApprove = APPROVE_PATTERN.test(text);
      const isDeny = DENY_PATTERN.test(text);
      if (!isApprove && !isDeny) return;

      const threadTs = 'thread_ts' in message ? message.thread_ts : undefined;
      const history = await slackClient.conversations.replies({
        channel: config.slack.channelId,
        ts: threadTs!,
        limit: 1,
      });

      const parent = history.messages?.[0];
      if (!parent?.text) return;

      const idMatch = parent.text.match(APPROVAL_ID_PATTERN);
      if (!idMatch) return;

      const approvalId = idMatch[1];
      const respondedBy = ('user' in message) ? message.user : undefined;

      await sidecar.approvals.resolve(approvalId, isApprove, respondedBy);

      const emoji = isApprove ? ':white_check_mark:' : ':x:';
      await say({ text: `${emoji} Approval \`${approvalId.slice(0, 8)}...\` ${isApprove ? 'approved' : 'denied'}.`, thread_ts: threadTs });
      return;
    }

    // --- Task dispatch: !clode1 do something ---
    const taskMatch = text.match(TASK_PATTERN);
    console.log(`[wandr:debug] Task pattern match: ${taskMatch ? `agent=${taskMatch[1]}` : 'NO MATCH'} (expected: !${agentId})`);
    if (!taskMatch) return;

    const [, targetAgent, prompt] = taskMatch;
    if (targetAgent !== agentId) {
      console.log(`[wandr:debug] Agent mismatch: got "${targetAgent}", expected "${agentId}"`);
      return;
    }

    await say(`:rocket: Task dispatched to \`${agentId}\`: ${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}`);

    // Fire-and-forget — do NOT await. The Slack handler must return
    // within 3 seconds or Bolt stops delivering subsequent messages.
    void (async () => {
      try {
        console.log(`[wandr] Task started for ${agentId}: ${prompt.slice(0, 80)}`);
        const response = await sidecar.runTask(prompt);
        const truncated = response.length > 3800
          ? response.slice(0, 3800) + '\n\n_...truncated_'
          : response;
        await say(`:white_check_mark: \`${agentId}\` response:\n\`\`\`${truncated}\`\`\``);
        console.log(`[wandr] Task complete for ${agentId} (${response.length} chars)`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[wandr] Task error for ${agentId}: ${errMsg}`);
        await say(`:x: \`${agentId}\` task failed: ${errMsg}`);
      }
    })();
    } catch (err) {
      console.error(`[wandr] Message handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Start manager API
  const api = new ManagerAPI(redis);

  // Start everything
  await slackApp.start();
  await api.start(config.api.port, config.api.host);
  await sidecar.start();

  console.log(`[wandr] Sidecar online for agent "${agentId}"`);
  console.log(`[wandr] Command: ${command} ${extraArgs.join(' ')}`);
  console.log(`[wandr] Slack channel: ${config.slack.channelId}`);
  console.log(`[wandr] Manager API: http://${config.api.host}:${config.api.port}`);
  console.log(`[wandr] Send tasks in Slack: !${agentId} <prompt>`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[wandr] Received ${signal}, shutting down...`);
    await sidecar.stop();
    await api.stop();
    await slackApp.stop();
    redis.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// ─── CLI Entry Point ────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    return;
  }

  // up <agent-id> [extra claude flags...]
  if (args[0] === 'up') {
    const agentId = args[1];
    if (!agentId) {
      console.error('Error: `wandr up` requires an agent ID');
      console.error('Example: wandr up myapp-dev1');
      process.exit(1);
    }
    await runUp(agentId, args.slice(2));
    return;
  }

  // down <agent-id>
  if (args[0] === 'down') {
    const agentId = args[1];
    if (!agentId) {
      console.error('Error: `wandr down` requires an agent ID');
      process.exit(1);
    }
    await runDown(agentId);
    return;
  }

  // --attach <agent-id>
  if (args[0] === '--attach') {
    const agentId = args[1];
    if (!agentId) {
      console.error('Error: --attach requires an agent ID');
      console.error('Example: wandr --attach myapp-dev1');
      process.exit(1);
    }
    await mainAttach(agentId);
    return;
  }

  // Spawn mode: <agent-id> <command> [extra-flags...]
  const [agentId, command, ...extraArgs] = args;
  if (!agentId || !command) {
    printUsage();
    return;
  }
  await mainSpawn(agentId, command, extraArgs);
}

// ─── Global Safety Nets ────────────────────────────────────────────
// The @slack/socket-mode finity state machine can throw synchronous errors
// when disconnect events arrive during the "connecting" state. Without these
// handlers the process crashes silently and the sidecar goes dark.
process.on('uncaughtException', (err) => {
  // Known finity bug: "Unhandled event 'server explicit disconnect' in state 'connecting'"
  // The Socket Mode client recovers on its own — just log and continue.
  if (err.message?.includes('Unhandled event') && err.message?.includes('in state')) {
    console.error(`[wandr] Socket Mode state machine error (non-fatal): ${err.message}`);
    return;
  }
  console.error('[wandr] Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[wandr] Unhandled rejection:', reason);
});

main().catch((err) => {
  console.error('[wandr] Fatal:', err);
  process.exit(1);
});
