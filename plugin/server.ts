// plugin/server.ts — claude-web channel plugin.
//
// An MCP stdio server that bridges a Claude Code session to the claude-web
// hub: hub messages arrive as channel notifications, the `reply` tool sends
// text back to the hub, and permission requests are relayed to the hub UI.
//
// stdout is the MCP transport — every log line goes to stderr, never stdout.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { HubClient } from './hub-client.ts';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const sessionId = process.env.CLAUDE_WEB_SESSION ?? crypto.randomUUID();
const cwd = process.env.CLAUDE_WEB_CWD ?? process.env.PWD ?? process.cwd();
const name = process.env.CLAUDE_WEB_NAME ?? null;
const hubUrl = `${process.env.CLAUDE_WEB_HUB ?? 'ws://127.0.0.1:8790'}/agent`;
// Never exceed the hub's AgentToHub reply bound (256k UTF-16 chars) — the hub
// drops oversize frames. Gating on UTF-8 bytes is at least as strict.
const MAX_REPLY_BYTES = 256_000;

function log(...args: unknown[]): void {
  console.error('[claude-web]', ...args);
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: 'claude-web', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions: [
      'The sender reads the claude-web UI, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches the UI.',
      '',
      `Messages from the claude-web UI arrive as <channel source="claude-web" chat_id="${sessionId}" message_id="...">. Reply with the reply tool; the sender only sees what is passed to it.`,
      '',
      'Permission prompts are relayed to the sender through the same channel: a permission decision shown to you comes from the sender in the claude-web UI.',
    ].join('\n'),
  },
);

// ---------------------------------------------------------------------------
// Hub client
// ---------------------------------------------------------------------------

const hub = new HubClient(hubUrl, {
  type: 'hello',
  sessionId,
  cwd,
  pid: process.pid,
  ppid: process.ppid,
  name,
  ...(process.env.CLAUDE_WEB_TOKEN ? { token: process.env.CLAUDE_WEB_TOKEN } : {}),
});

/** Deliver a hub→session message into the Claude Code conversation. */
function pushMessage(id: string, text: string): void {
  void mcp
    .notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: { chat_id: sessionId, message_id: id },
      },
    })
    .catch((err) => log('channel notification failed:', err));
}

/** Relay a permission verdict from the hub into Claude Code. */
function sendPermissionVerdict(requestId: string, behavior: 'allow' | 'deny'): void {
  void mcp
    .notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: requestId, behavior },
    })
    .catch((err) => log('permission notification failed:', err));
}

hub.on((frame) => {
  const type = frame['type'];
  if (type === 'message') {
    const id = typeof frame['id'] === 'string' ? frame['id'] : '';
    const text = typeof frame['text'] === 'string' ? frame['text'] : '';
    if (id === '' || text === '') {
      log('ignoring malformed message frame:', JSON.stringify(frame));
      return;
    }
    pushMessage(id, text);
  } else if (type === 'permission') {
    const requestId = typeof frame['request_id'] === 'string' ? frame['request_id'] : '';
    const behavior = frame['behavior'];
    if (requestId === '' || (behavior !== 'allow' && behavior !== 'deny')) {
      log('ignoring malformed permission frame:', JSON.stringify(frame));
      return;
    }
    sendPermissionVerdict(requestId, behavior);
  } else {
    log('ignoring unknown hub frame type:', String(type));
  }
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a message to the sender in the claude-web UI. This is the only way they see your output.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
        },
        required: ['text'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'reply') {
    return {
      content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const text = typeof args.text === 'string' ? args.text : '';
  if (text === '') {
    return {
      content: [{ type: 'text', text: 'reply requires a non-empty text argument' }],
      isError: true,
    };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_REPLY_BYTES) {
    return {
      content: [{ type: 'text', text: `reply is too long (${bytes} bytes, max ${MAX_REPLY_BYTES}); send it in parts` }],
      isError: true,
    };
  }
  const sent = hub.send({ type: 'reply', text });
  if (!sent) {
    return {
      content: [{ type: 'text', text: 'claude-web hub is offline; message not delivered' }],
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: 'sent' }] };
});

// ---------------------------------------------------------------------------
// Permission request relay (Claude Code → hub UI)
// ---------------------------------------------------------------------------

const PermissionRequestNotification = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }).passthrough(),
});

mcp.setNotificationHandler(PermissionRequestNotification, async ({ params }) => {
  const { request_id, tool_name, description, input_preview } = params;
  const sent = hub.send({
    type: 'permission_request',
    request_id,
    tool_name,
    description,
    input_preview,
  });
  if (!sent) {
    log(`hub offline; dropped permission_request ${request_id} (${tool_name})`);
  }
});

// ---------------------------------------------------------------------------
// Connect: stdio (the MCP transport) first, then the hub WebSocket
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
log(`session ${sessionId} in ${cwd}; dialing hub at ${hubUrl}`);
hub.connect();
