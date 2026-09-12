// Shared protocol for the claude-web hub: zod schemas + TypeScript types for
// every frame on the /agent and /ui WebSocket endpoints, the Session summary,
// chat log entries, pending permission prompts, transcript events, and all
// HTTP request bodies.

import { z } from "zod";

/* ---------------------------------- Session --------------------------------- */

export const SessionKindSchema = z.enum(["spawned", "external"]);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const SessionStatusSchema = z.enum(["starting", "running", "exited", "disconnected"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  cwd: z.string(),
  kind: SessionKindSchema,
  status: SessionStatusSchema,
  pid: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.string().nullable(),
  createdAt: z.number(),
  agentConnected: z.boolean(),
});
export type Session = z.infer<typeof SessionSchema>;

/* ------------------------------- Chat + prompts ------------------------------ */

export const ToolCallSchema = z.object({
  name: z.string(),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const TranscriptEventSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  tools: z.array(ToolCallSchema),
  ts: z.number(),
});
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

// One row of a session's chat log. `user` rows are channel messages sent from
// the hub, `assistant` rows are replies that arrived via the agent `reply`
// frame, `steer` rows are text typed straight into the PTY, `transcript`
// rows are compact TranscriptTailer events.
export const ChatEntrySchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "steer", "transcript"]),
  text: z.string(),
  ts: z.number(),
  tools: z.array(ToolCallSchema).optional(),
});
export type ChatEntry = z.infer<typeof ChatEntrySchema>;

export const PendingPermissionSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  description: z.string(),
  inputPreview: z.string(),
  ts: z.number(),
});
export type PendingPermission = z.infer<typeof PendingPermissionSchema>;

/* -------------------------------- Agent frames ------------------------------- */
// /agent endpoint. First frame hub<-agent must be hello; thereafter the plugin
// sends reply/permission_request and the hub sends message/permission.

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
// /ui endpoint. On open the hub sends snapshot, then relays session/pty
// events plus chat/permission events (transcript events arrive as chat
// entries with role "transcript"). The UI may subscribe to a
// session's PTY stream.

export const UiToHubSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscribe_pty"),
    id: z.string().min(1),
  }),
]);
export type UiToHub = z.infer<typeof UiToHubSchema>;

export const SessionEventFrameSchema = z.object({
  type: z.literal("session"),
  session: SessionSchema,
});
export const PtyEventFrameSchema = z.object({
  type: z.literal("pty"),
  id: z.string(),
  data: z.string(), // base64 of raw PTY bytes
});
export const SessionRemovedFrameSchema = z.object({
  type: z.literal("session_removed"),
  id: z.string(),
});
export const ChatEventFrameSchema = z.object({
  type: z.literal("chat"),
  id: z.string(),
  entry: ChatEntrySchema,
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

export const SnapshotFrameSchema = z.object({
  type: z.literal("snapshot"),
  sessions: z.array(SessionSchema),
  chat: z.record(z.string(), z.array(ChatEntrySchema)),
  pending: z.record(z.string(), z.array(PendingPermissionSchema)),
});
export type SnapshotFrame = z.infer<typeof SnapshotFrameSchema>;

// Everything the hub may push to a UI socket after the snapshot.
export const HubToUiSchema = z.discriminatedUnion("type", [
  SessionEventFrameSchema,
  PtyEventFrameSchema,
  SessionRemovedFrameSchema,
  ChatEventFrameSchema,
  PermissionRequestFrameSchema,
  PermissionResolvedFrameSchema,
  PermissionsClearedFrameSchema,
]);
export type HubToUi = z.infer<typeof HubToUiSchema>;

/* ------------------------------ HTTP request bodies --------------------------- */

// POST /api/sessions — spawn a new session.
export const CreateSessionBodySchema = z.object({
  cwd: z.string().min(1).max(4096),
  name: z.string().max(120).optional(),
});
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>;

// POST /api/sessions/:id/message — channel message routed to the plugin.
export const MessageBodySchema = z.object({
  text: z.string().min(1).max(64_000),
});
export type MessageBody = z.infer<typeof MessageBodySchema>;

// POST /api/sessions/:id/steer — typed into the PTY (text + "\r").
export const SteerBodySchema = z.object({
  text: z.string().min(1).max(64_000),
});
export type SteerBody = z.infer<typeof SteerBodySchema>;

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
