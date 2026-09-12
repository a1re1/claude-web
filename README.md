# claude-web

A browser control panel for running [Claude Code](https://code.claude.com) sessions, built on
[channels](https://code.claude.com/docs/en/channels). It lets you watch what a session is doing,
push messages into it, approve or deny permission prompts, and stop or steer a turn, for many
sessions at once, from any device that can reach the hub behind Caddy.

```
 browser ──HTTPS/WSS──▶ Caddy ──▶ hub (Bun, :8790)
                                   │  /ui   ◀── browsers (snapshot + live events)
                                   │  /agent ◀── one channel plugin per Claude session
                                   │
                                   ├─ spawns  claude --session-id … (in a PTY)  ─┐
                                   │     stop = Escape, steer = typed text        │ stdio (MCP)
                                   │     transcript tail ~/.claude/projects/…     │
                                   └────────────────────────────────── plugin/server.ts
                                                                        messages in, replies out,
                                                                        permission relay
```

Two pieces:

- **`plugin/`** — a channel plugin (MCP server over stdio) that Claude Code loads with
  `--dangerously-load-development-channels plugin:claude-web@claude-web`. It dials the hub over a
  WebSocket, turns hub messages into `<channel>` events, exposes a `reply` tool, and relays
  permission prompts. Modeled on the official `fakechat` and `telegram` plugins.
- **`hub/`** — a Bun web server with a small framework-free UI. It spawns Claude sessions in PTYs
  (so it can interrupt them), tails their transcripts, and fans events out to browsers.

## Prerequisites

- Bun ≥ 1.3 (native PTY support)
- Claude Code ≥ 2.1.269 with a claude.ai or Console login (channels are a research preview)
- Caddy 2 if you want to expose the hub beyond localhost

## Setup

```bash
bun install

# Register this repo as a local plugin marketplace and install the channel plugin
claude plugin marketplace add /absolute/path/to/claude-web
claude plugin install claude-web@claude-web
```

## Run

```bash
# 1. the hub (binds 127.0.0.1:8790 by default)
bun run start

# 2. optionally, Caddy in front with basic auth
CLAUDE_WEB_PASSWORD_HASH="$(caddy hash-password --plaintext 'change-me')" caddy run
# then open https://localhost (or set CLAUDE_WEB_DOMAIN=claude.example.com for auto-TLS)
```

Without Caddy, open <http://127.0.0.1:8790> directly.

### Start a session from the browser

Enter an absolute project path (and an optional name) in the sidebar and click **New session**.
The hub runs

```
claude --session-id <uuid> --dangerously-load-development-channels plugin:claude-web@claude-web [--name <name>]
```

in a PTY with `CLAUDE_WEB_SESSION`, `CLAUDE_WEB_CWD`, and `CLAUDE_WEB_HUB` set, so the plugin
inside that session knows which hub session it belongs to. The first time a project loads the
plugin, Claude Code asks for consent in the terminal tab. The green dot next to a session turns on
once the plugin has connected.

### Attach a session you started yourself

```bash
claude --dangerously-load-development-channels plugin:claude-web@claude-web
```

It appears in the sidebar as `external`. You can chat with it and answer its permission prompts,
but **Stop, Steer, Kill, and the Terminal tab are disabled** because the hub does not own its
terminal. Set `CLAUDE_WEB_HUB=ws://host:port` if the hub is not on `127.0.0.1:8790`.

## What the buttons do

| Button | Mechanism | Works on |
| --- | --- | --- |
| **Send** | Channel notification. Queued and delivered at the start of Claude's next turn. Claude answers with the `reply` tool and the text shows up in the chat. | any session with the plugin connected |
| **Steer** | Types the text + Enter into the PTY. Claude Code queues it mid-turn like typing in the terminal. | hub-spawned |
| **Stop** | Writes Escape to the PTY, interrupting the current turn. | hub-spawned |
| **Kill** | SIGTERM, then SIGKILL after 3 s. | hub-spawned |
| **Allow / Deny** | Answers a relayed permission prompt. The terminal dialog stays live too; whichever answer arrives first wins. | any session with the plugin connected |

The chat pane also shows a compact view of the session transcript (assistant text and `▸ ToolName`
rows) tailed from `~/.claude/projects/<encoded cwd>/<session-id>.jsonl`.

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `CLAUDE_WEB_PORT` | `8790` | hub, Caddyfile |
| `CLAUDE_WEB_HOST` | `127.0.0.1` | hub |
| `CLAUDE_WEB_CHANNEL` | `plugin:claude-web@claude-web` | hub (channel spec passed to spawned sessions) |
| `CLAUDE_WEB_HUB` | `ws://127.0.0.1:8790` | plugin (hub to dial) |
| `CLAUDE_WEB_TOKEN` | none | hub + plugin (shared secret an agent must present in its hello; spawned sessions inherit it) |
| `CLAUDE_WEB_DOMAIN`, `CLAUDE_WEB_USER`, `CLAUDE_WEB_PASSWORD_HASH` | `localhost`, `claude`, none | Caddyfile |

## Security

- Custom channels require `--dangerously-load-development-channels`; the plugin is not on
  Anthropic's approved allowlist. Only run it with a hub you trust.
- The hub refuses browser requests whose `Origin` does not match its own host, so other web pages
  cannot drive or read it.
- Any local process can connect to `/agent` and claim a session id. Set `CLAUDE_WEB_TOKEN` on the
  hub (spawned sessions inherit it; export it for externally started ones) so a stray agent cannot
  impersonate a session and answer its permission prompts. Anyone who can reach the hub UI itself can send messages, type into terminals, and **approve permission
  prompts**. Keep the hub bound to localhost and put Caddy's `basic_auth` (or your own auth) in
  front of it before exposing it.
- The hub has no sender allowlist of its own; Caddy is the gate.

## Development

```bash
bun run check        # typecheck + tests
bun test hub         # hub tests only (use `cat` under a PTY, no real claude needed)
bun test plugin      # hub-client reconnect tests
```

## Troubleshooting

- **Session shows no green dot** — run `/mcp` inside the session. A `failed` server usually means a
  dependency error; restart the session with `--debug` and read `~/.claude/debug/<session-id>.txt`.
- **`reply` returns "hub is offline"** — the plugin could not reach `CLAUDE_WEB_HUB`. It keeps
  retrying with backoff; start the hub and the dot will turn green.
- **Channel notice missing at startup** — the plugin is not installed or channels are disabled by
  your organization. See the channels docs on enterprise controls.
