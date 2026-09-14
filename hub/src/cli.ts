#!/usr/bin/env bun
// claude-web: serve the browser UI for the Claude Code sessions under the
// current directory, in the spirit of `drip --ui`.
//
//   claude-web                 first free port from 8790, prints the URL
//   claude-web --port 4200     pin the port
//   claude-web --root DIR      sessions of DIR instead of the cwd
//   claude-web --tree          also sessions in directories below the root
//   claude-web --all           every session on the machine
//   claude-web --host 0.0.0.0  bind address (default 127.0.0.1); the hub has no
//                              auth of its own, so put Caddy in front first
//   claude-web --open          open the URL in the default browser

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Scope } from "./discovery";
import { createHub } from "./index";

interface CliArgs {
  port: number | null;
  host: string;
  root: string;
  scope: Scope;
  open: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: CliArgs = {
    port: env.CLAUDE_WEB_PORT ? Number(env.CLAUDE_WEB_PORT) : null,
    host: env.CLAUDE_WEB_HOST ?? "127.0.0.1",
    root: realpathSync(process.cwd()),
    scope: "cwd",
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--port" || a === "-p") args.port = Number(next());
    else if (a === "--host") args.host = next();
    else if (a === "--root") args.root = realpathSync(resolve(next()));
    else if (a === "--tree") args.scope = "tree";
    else if (a === "--all") args.scope = "all";
    else if (a === "--open") args.open = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: claude-web [--port N] [--host H] [--root DIR] [--tree | --all] [--open]\n" +
          "Serve the browser UI for the Claude Code sessions of DIR (default: the cwd) and start new ones there.\n" +
          "  --tree  also list sessions in directories below DIR\n" +
          "  --all   list every session on the machine",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (args.port !== null && (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535)) {
    throw new Error(`invalid port: ${args.port}`);
  }
  return args;
}

// First free TCP port at or above `from`, so several projects can run at once.
export function freePort(host: string, from: number, tries = 50): number {
  for (let port = from; port < from + tries; port++) {
    try {
      const probe = Bun.listen({ hostname: host, port, socket: { data() {} } });
      probe.stop(true);
      return port;
    } catch {
      /* in use */
    }
  }
  throw new Error(`no free port in ${from}..${from + tries - 1}`);
}

if (import.meta.main) {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`claude-web: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const port = args.port ?? freePort(args.host, 8790);
  const { server } = createHub({
    port,
    hostname: args.host,
    rootCwd: args.root,
    scope: args.scope,
    agentToken: process.env.CLAUDE_WEB_TOKEN || undefined,
  });
  const url = `http://${args.host}:${server.port}/`;
  const what = args.scope === "all" ? "every session" : args.scope === "tree" ? `sessions under ${args.root}` : `sessions in ${args.root}`;
  console.log(`claude-web: ${url}  (${what})`);
  if (args.open) {
    // `start` is a cmd.exe builtin, not an executable, hence the wrapper on Windows.
    const opener =
      process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
    Bun.spawn(opener, { stdio: ["ignore", "ignore", "ignore"] });
  }
}
