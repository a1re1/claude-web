# claude-web

A browser UI for [Claude Code](https://code.claude.com) sessions, in the spirit of `drip --ui`.
Run `claude-web` from a project directory and it prints a URL. The page lists every Claude
session under that directory, running or past, renders the whole conversation live (prompts,
assistant text, thinking, tool calls and results, model, token usage, context pressure), and can
start a new session there, message it, interrupt a turn, or kill it.

```
 claude-web (Bun, first free port from 8790)
   ├─ discovers   ~/.claude/sessions/<pid>.json   (who is running, busy/idle)
   │              ~/.claude/projects/<cwd>/<id>.jsonl   (the full conversation)
   ├─ spawns      claude --session-id … in a PTY   → Send / Stop / Kill / Terminal tab
   └─ optional    channel plugin (plugin/)         → Allow / Deny permission buttons
```

Everything a session writes to its transcript is shown; sessions started elsewhere are read-only
unless the optional plugin is loaded in them.

## Prerequisites

- Bun ≥ 1.3 (native PTY support)
- Claude Code ≥ 2.1.269

## Run

```bash
bun install
cd ~/src/my-project
bun run /path/to/claude-web/hub/src/cli.ts        # or `bun link` once and run `claude-web`
# claude-web: http://127.0.0.1:8790/  (sessions under /Users/you/src/my-project)
```

Flags: `--port N` (default: first free port from 8790, or `CLAUDE_WEB_PORT`), `--host H`
(default `127.0.0.1`), `--root DIR` (default: the current directory), `--open` (launch the browser).

### The page

- **Sessions rail** — every session whose working directory is the root or below it. Running
  sessions come first with their resident memory; a pulsing dot means Claude is mid-turn. Sessions
  this `claude-web` started carry a `claude-web` badge. Sessions that are alive but have never been
  used (an unused terminal tab: no conversation yet) are hidden behind **show empty sessions**,
  which also totals how much memory they hold.
- **Conversation** — the full transcript, streamed as it grows, with Markdown rendering. Images
  pasted into a prompt or read by Claude are shown inline (click to toggle full size). Thinking,
  injected meta prompts, and subagent traffic are hidden behind toggles; tool calls and results
  are collapsible.
- **Terminal** — an xterm view of the PTY, for sessions `claude-web` started (startup dialogs,
  permission prompts, anything the transcript does not carry).
- **Composer** — **Send** types the text plus Enter into the PTY. **Stop** sends Escape to
  interrupt the current turn. **Kill** sends SIGTERM (SIGKILL after 3 s). All three need a session
  `claude-web` started; a session started from another terminal shows as read-only. The one
  exception is Kill on an empty external session (idle, no conversation): the hub SIGTERMs it by
  pid, since nothing can be lost.
- **New session** — starts `claude --session-id <uuid> [--name …]` in the given directory
  (default: the root); an optional first prompt is typed once the input box appears.
- **Resume** — on any session that is not running: relaunches it with `claude --resume <id>` in
  its own directory under claude-web's PTY. Same id, same transcript, and from then on Send, Stop,
  Kill and the Terminal tab work for it.
- **Status bar** — state, model, prompt and tool-call counts, input context of the latest call as
  a share of `CLAUDE_WEB_MAX_CONTEXT_TOKENS` (1M by default), and output tokens.

## Optional: permission buttons via the channel plugin

Claude Code does not expose permission prompts on disk, so Allow/Deny in the browser needs the
channel plugin in `plugin/` loaded inside the session:

```bash
claude plugin marketplace add /absolute/path/to/claude-web
claude plugin install claude-web@claude-web

# spawned sessions load it when this is set before starting claude-web:
export CLAUDE_WEB_CHANNEL=plugin:claude-web@claude-web
# a session you start yourself can attach too:
CLAUDE_WEB_HUB=ws://127.0.0.1:8790 claude --dangerously-load-development-channels plugin:claude-web@claude-web
```

Sessions with the plugin attached get a `plugin` badge; their permission prompts appear as a banner
with Allow/Deny, and **Send** works for them even when `claude-web` did not start them (delivered
as a channel message at the start of Claude's next turn). Set `CLAUDE_WEB_TOKEN` to a shared
secret so only sessions you started can attach (spawned sessions inherit it).

## Optional: Caddy front door

The server binds localhost with no auth of its own. To reach it from another device put
`Caddyfile` in front:

```bash
CLAUDE_WEB_PORT=8790 CLAUDE_WEB_PASSWORD_HASH="$(caddy hash-password --plaintext 'change-me')" caddy run
# https://localhost, or CLAUDE_WEB_DOMAIN=claude.example.com for auto-TLS
```

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `CLAUDE_WEB_PORT` | first free from `8790` | cli, Caddyfile |
| `CLAUDE_WEB_HOST` | `127.0.0.1` | cli |
| `CLAUDE_WEB_CHANNEL` | unset | hub: channel spec passed to spawned sessions (plugin opt-in) |
| `CLAUDE_WEB_HUB` | `ws://127.0.0.1:8790` | plugin (hub to dial) |
| `CLAUDE_WEB_TOKEN` | none | hub + plugin shared secret |
| `CLAUDE_WEB_DOMAIN`, `CLAUDE_WEB_USER`, `CLAUDE_WEB_PASSWORD_HASH` | `localhost`, `claude`, none | Caddyfile |

## Security

- Anyone who can reach the page can type into your sessions and, with the plugin, approve
  permission prompts. Keep it on localhost or behind Caddy's `basic_auth`.
- Browser requests whose `Origin` does not match the server's host are refused, so another web page
  cannot drive or read it.
- Custom channels require `--dangerously-load-development-channels`; only load the plugin against a
  hub you trust, and set `CLAUDE_WEB_TOKEN` so a stray local process cannot claim a session id.

## Development

```bash
bun run check        # typecheck + tests
bun test hub         # hub tests (transcript fixtures + `cat` under a PTY, no real claude needed)
bun test plugin      # hub-client reconnect tests
```

The UI follows the Vitrine design system (a liquid-glass, mac-native language): its tokens are
copied into `hub/public/app.css` (typography, colors, materials, radii, motion) so the page has no
runtime dependency on the design project. Light and dark follow the system, or pin one with
`data-theme="light|dark"` on the root element.

Layout: `hub/src/discovery.ts` (registry + transcript scan), `hub/src/conversation.ts` (JSONL →
entries, tailer), `hub/src/sessions.ts` (PTY processes), `hub/src/index.ts` (HTTP/WS),
`hub/src/cli.ts`, `hub/public/` (framework-free UI), `plugin/` (optional channel plugin).

## Troubleshooting

- **A session is missing from the rail** — its working directory is outside the root; run
  `claude-web --root` higher up, or from `~` to see everything.
- **Send is disabled** — the session was not started by this `claude-web` and has no plugin attached.
  If it is not running, **Resume** picks it up here; if it is running in another terminal, it keeps
  its own stdin, so exit it there first or use the plugin.
- **Spawned session shows a consent dialog** — switch to the Terminal tab and answer it there;
  that happens the first time a project loads the plugin.
