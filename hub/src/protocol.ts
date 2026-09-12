// Shared protocol for the claude-web hub: zod schemas + TypeScript types for
// conversation entries parsed from Claude Code transcripts, discovered
// sessions, the /agent (plugin) and /ui (browser) WebSocket frames, and every
// HTTP request body.

import { z } from "zod";

/* ------------------------------- Conversation ------------------------------- */
// One transcript line (~/.claude/projects/<encodedCwd>/<sessionId>.jsonl)
// becomes at most one entry. Assistant records carry one content block per
// line, so a single API message (same `messageId`) spans several entries and
// repeats the same `usage` on each; consumers de-duplicate totals by messageId.

export const UsageSchema = z.object({
  input: z.number(), // input_tokens
  cacheRead: z.number(), // cache_read_input_tokens
  cacheCreate: z.number(), // cache_creation_input_tokens
  output: z.number(), // output_tokens
});
export type Usage = z.infer<typeof UsageSchema>;

const base = {
  uuid: z.string(), // record uuid (or a synthesized one for records without it)
  ts: z.number(), // epoch ms, 0 when the record has no timestamp
  sidechain: z.boolean(), // isSidechain: subagent traffic, hidden by default
};

const assistantBase = {
  ...base,
  messageId: z.string().nullable(), // message.id, shared by all blocks of one reply
  model: z.string().nullable(),
  usage: UsageSchema.nullable(),
};

export const ConvEntrySchema = z.discriminatedUnion("kind", [
  // A user turn: plain string content or text blocks. `meta` marks isMeta
  // records (injected context such as skill bodies) the UI hides by default.
  z.object({ kind: z.literal("prompt"), ...base, text: z.string(), meta: z.boolean() }),
  z.object({ kind: z.literal("text"), ...assistantBase, text: z.string() }),
  z.object({ kind: z.literal("thinking"), ...assistantBase, text: z.string() }),
  z.object({
    kind: z.literal("tool_use"),
    ...assistantBase,
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal("tool_result"),
    ...base,
    toolUseId: z.string(),
    text: z.string(), // string content, or text blocks joined with "\n"
    isError: z.boolean(),
  }),
  // `system` records that carry a non-empty string `content` (hook summaries,
  // notices); other system records are dropped.
  z.object({
    kind: z.literal("system"),
    ...base,
    subtype: z.string(),
    level: z.string().nullable(),
    text: z.string(),
  }),
  // isCompactSummary user records: the summary that replaced earlier context.
  z.object({ kind: z.literal("compact"), ...base, text: z.string() }),
  // ai-title records: the session's generated title (may change over time).
  z.object({ kind: z.literal("title"), ...base, text: z.string() }),
]);
export type ConvEntry = z.infer<typeof ConvEntrySchema>;

/* --------------------------------- Sessions -------------------------------- */

// One Claude Code process from ~/.claude/sessions/<pid>.json.
export const RegistryEntrySchema = z.object({
  pid: z.number().int(),
  sessionId: z.string(),
  cwd: z.string(),
  status: z.string().nullable(), // "busy" | "idle" | anything newer
  name: z.string().nullable(),
  kind: z.string().nullable(), // "interactive" | ...
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  alive: z.boolean(), // process still exists (kill(pid, 0))
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

// A session discovered under the launch directory: transcript on disk and/or
// a live registry entry.
export const SessionInfoSchema = z.object({
  id: z.string(),
  cwd: z.string(), // from the transcript records, else the registry, else decoded from the dir
  transcriptPath: z.string().nullable(),
  title: z.string().nullable(), // latest ai-title, else the first prompt's first line
  firstPrompt: z.string().nullable(),
  lastPrompt: z.string().nullable(),
  gitBranch: z.string().nullable(),
  version: z.string().nullable(), // Claude Code version that wrote the transcript
  startedAt: z.number().nullable(), // first record timestamp
  updatedAt: z.number().nullable(), // transcript mtime, else registry updatedAt
  sizeBytes: z.number(),
  running: z.boolean(), // alive registry entry exists
  busy: z.boolean(), // registry status === "busy"
  pid: z.number().int().nullable(),
  name: z.string().nullable(), // registry name (also --name for spawned)
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// What the hub shows: discovery info plus what the hub knows about sessions it
// spawned itself (PTY control) and about connected channel plugins.
export const SessionSchema = SessionInfoSchema.extend({
  spawned: z.boolean(), // the hub owns this process (message/stop/kill/terminal)
  exitCode: z.number().int().nullable(),
  exitSignal: z.string().nullable(),
  agentConnected: z.boolean(), // optional channel plugin is attached
});
export type Session = z.infer<typeof SessionSchema>;

export const PendingPermissionSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  description: z.string(),
  inputPreview: z.string(),
  ts: z.number(),
});
export type PendingPermission = z.infer<typeof PendingPermissionSchema>;

/* -------------------------------- Agent frames ------------------------------- */
// /agent endpoint (optional channel plugin). First frame hub<-agent must be
// hello; thereafter the plugin sends reply/permission_request and the hub
// sends message/permission.

export const AgentHelloSchema = z.object({
  type: z.literal("hello"),
  sessionId: z.string().min(1),
  cwd: z.string(),
  pid: z.number().int().nullable(),
  ppid: z.number().int().nullable(),
  name: z.string().nullable(),
  // Shared secret (CLAUDE_WEB_TOKEN); required when the hub is configured with one.
  token: z.string().optional(),
});
export type AgentHello = z.infer<typeof AgentHelloSchema>;

export const HubToAgentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    id: z.string(),
    text: z.string().min(1).max(64_000),
  }),
  z.object({
    type: z.literal("permission"),
    request_id: z.string().min(1),
    behavior: z.enum(["allow", "deny"]),
  }),
]);
export type HubToAgent = z.infer<typeof HubToAgentSchema>;

export const AgentToHubSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reply"),
    text: z.string().min(1).max(256_000),
  }),
  z.object({
    type: z.literal("permission_request"),
    request_id: z.string().min(1),
    tool_name: z.string().min(1),
    description: z.string(),
    input_preview: z.string(),
  }),
]);
export type AgentToHub = z.infer<typeof AgentToHubSchema>;

/* ---------------------------------- UI frames -------------------------------- */
// /ui endpoint. On open the hub sends `sessions`; the UI subscribes to one
// session at a time and receives its full `history`, then live `entry` and
// `pty` frames for it. Session list refreshes arrive as new `sessions` frames.

export const UiToHubSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), id: z.string().min(1) }),
  z.object({ type: z.literal("unsubscribe") }),
]);
export type UiToHub = z.infer<typeof UiToHubSchema>;

export const SessionsFrameSchema = z.object({
  type: z.literal("sessions"),
  sessions: z.array(SessionSchema),
  pending: z.record(z.string(), z.array(PendingPermissionSchema)),
});
export type SessionsFrame = z.infer<typeof SessionsFrameSchema>;

export const HistoryFrameSchema = z.object({
  type: z.literal("history"),
  id: z.string(),
  entries: z.array(ConvEntrySchema),
  truncated: z.boolean(), // older entries were dropped to respect HISTORY_LIMIT
});
export const EntryFrameSchema = z.object({
  type: z.literal("entry"),
  id: z.string(),
  entry: ConvEntrySchema,
});
export const PtyFrameSchema = z.object({
  type: z.literal("pty"),
  id: z.string(),
  data: z.string(), // base64 of raw PTY bytes
});
export const SessionRemovedFrameSchema = z.object({
  type: z.literal("session_removed"),
  id: z.string(),
});
export const PermissionRequestFrameSchema = z.object({
  type: z.literal("permission_request"),
  id: z.string(),
  request: PendingPermissionSchema,
});
// Emitted when a session's plugin socket drops: every pending prompt is gone.
export const PermissionsClearedFrameSchema = z.object({
  type: z.literal("permissions_cleared"),
  id: z.string(),
});
export const PermissionResolvedFrameSchema = z.object({
  type: z.literal("permission_resolved"),
  id: z.string(),
  request_id: z.string(),
  behavior: z.enum(["allow", "deny"]),
});

export const HubToUiSchema = z.discriminatedUnion("type", [
  SessionsFrameSchema,
  HistoryFrameSchema,
  EntryFrameSchema,
  PtyFrameSchema,
  SessionRemovedFrameSchema,
  PermissionRequestFrameSchema,
  PermissionResolvedFrameSchema,
  PermissionsClearedFrameSchema,
]);
export type HubToUi = z.infer<typeof HubToUiSchema>;

/* ------------------------------ HTTP request bodies --------------------------- */

// POST /api/sessions — start a new Claude Code session under the launch
// directory. `cwd` defaults to the launch directory; `prompt` is typed in
// once the session is ready.
export const CreateSessionBodySchema = z.object({
  cwd: z.string().min(1).max(4096).optional(),
  name: z.string().max(120).optional(),
  prompt: z.string().max(64_000).optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

// POST /api/sessions/:id/message — typed into the PTY of a spawned session
// (text + Enter); for an external session with a channel plugin attached it
// is pushed as a channel message instead.
export const MessageBodySchema = z.object({
  text: z.string().min(1).max(64_000),
});
export type MessageBody = z.infer<typeof MessageBodySchema>;

// POST /api/sessions/:id/input — raw keystrokes (base64 data).
export const InputBodySchema = z.object({
  data: z.string().min(1).max(8192),
});
export type InputBody = z.infer<typeof InputBodySchema>;

// POST /api/sessions/:id/resize
export const ResizeBodySchema = z.object({
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(1000),
});
export type ResizeBody = z.infer<typeof ResizeBodySchema>;

// POST /api/sessions/:id/permission — a verdict from the UI.
export const PermissionBodySchema = z.object({
  request_id: z.string().min(1),
  behavior: z.enum(["allow", "deny"]),
});
export type PermissionBody = z.infer<typeof PermissionBodySchema>;
