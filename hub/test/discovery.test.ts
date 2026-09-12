import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { encodeProjectDir } from "../src/conversation";
import { SessionIndex, isUnder, readRegistry } from "../src/discovery";

const fixture = fs.readFileSync(path.join(import.meta.dir, "fixtures", "transcript.jsonl"), "utf8");

function fakeHome(): { home: string; root: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cw-disc-"));
  const root = path.join(home, "src", "proj");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
  return { home, root };
}

function writeTranscript(home: string, cwd: string, id: string, lines: string[]): string {
  const dir = path.join(home, ".claude", "projects", encodeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function userLine(id: string, cwd: string, text: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "user", uuid: `${id}-${ts}`, sessionId: id, cwd, timestamp: ts, gitBranch: "feat", version: "2.1.269", message: { role: "user", content: text }, ...extra });
}

function registry(home: string, pid: number, sessionId: string, cwd: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(home, ".claude", "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, kind: "interactive", startedAt: 1, updatedAt: 2, ...extra }));
  fs.writeFileSync(path.join(home, ".claude", "sessions", `${pid}.key`), "secret");
}

describe("isUnder", () => {
  test("matches the root itself and descendants, not prefix siblings", () => {
    expect(isUnder("/a/b", "/a/b")).toBe(true);
    expect(isUnder("/a/b", "/a/b/c")).toBe(true);
    expect(isUnder("/a/b", "/a/bc")).toBe(false);
    expect(isUnder("/a/b", "/a")).toBe(false);
  });
});

describe("readRegistry", () => {
  test("reads pid files, skips keys and garbage, reports liveness", () => {
    const { home, root } = fakeHome();
    registry(home, process.pid, "live-1", root, { status: "busy", name: "me" });
    registry(home, 2147483000, "dead-1", root, { status: "idle" });
    fs.writeFileSync(path.join(home, ".claude", "sessions", "garbage.json"), "{nope");
    fs.writeFileSync(path.join(home, ".claude", "sessions", "partial.json"), JSON.stringify({ pid: 5 }));
    const entries = readRegistry(home).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    expect(entries.map((e) => [e.sessionId, e.alive, e.status, e.name])).toEqual([
      ["dead-1", false, "idle", null],
      ["live-1", true, "busy", "me"],
    ]);
    expect(readRegistry(path.join(home, "missing"))).toEqual([]);
  });
});

describe("SessionIndex", () => {
  test("lists transcripts under the root (including worktree-style dirs) merged with the live registry", async () => {
    const { home, root } = fakeHome();
    const sub = path.join(root, ".worktrees", "wt");
    // The fixture was recorded elsewhere; re-home its cwd so it counts as under this root.
    const FIXTURE_CWD = "/Users/tylerwhitehurst/src/claude-web/.worktrees/tw-ajmer-dmqv6";
    writeTranscript(home, root, "aaa", fixture.replaceAll(FIXTURE_CWD, root).split("\n").filter(Boolean));
    writeTranscript(home, sub, "bbb", [
      userLine("bbb", sub, "  worktree prompt\nsecond line", "2026-09-12T10:00:00.000Z"),
      userLine("bbb", sub, "later prompt", "2026-09-12T10:05:00.000Z"),
    ]);
    writeTranscript(home, path.join(home, "src", "projX"), "ccc", [userLine("ccc", "/elsewhere", "sibling prefix must not match", "2026-09-12T10:00:00.000Z")]);
    // "/src/proj-2" encodes to the same shape as a worktree under proj; its recorded cwd rules it out.
    const sibling = path.join(home, "src", "proj-2");
    writeTranscript(home, sibling, "fff", [userLine("fff", sibling, "sibling with a dash", "2026-09-12T10:00:00.000Z")]);
    writeTranscript(home, "/somewhere/else", "ddd", [userLine("ddd", "/somewhere/else", "unrelated", "2026-09-12T10:00:00.000Z")]);
    // A subdirectory inside a project dir (tool-results) is skipped.
    fs.mkdirSync(path.join(home, ".claude", "projects", encodeProjectDir(root), "aaa", "tool-results"), { recursive: true });
    registry(home, process.pid, "bbb", sub, { status: "busy", name: "wt-session" });
    registry(home, process.pid + 100000, "aaa", root, { status: "idle" }); // dead pid: not running
    registry(home, process.ppid, "eee", root, { status: "idle", name: "fresh" }); // alive (parent), no transcript yet

    const index = new SessionIndex({ rootCwd: root, home });
    const list = await index.refresh();
    expect(list.map((s) => s.id)).toEqual(["bbb", "eee", "aaa"]); // running first, then newest; ccc/ddd/fff excluded

    const a = index.get("aaa")!;
    expect(a.running).toBe(false);
    expect(a.pid).toBeNull();
    expect(a.cwd).toBe(root);
    expect(a.version).toBe("2.1.269");
    expect(a.gitBranch).toBe("tw-ajmer-dmqv6");
    expect(a.title).toBe("Custom web UI channel plugin"); // ai-title wins over the first prompt
    expect(a.firstPrompt?.startsWith("claude code support channels")).toBe(true);
    expect(a.lastPrompt?.startsWith("claude code support channels")).toBe(true); // the compact summary is not a prompt
    expect(a.sizeBytes).toBeGreaterThan(0);
    expect(a.transcriptPath?.endsWith("aaa.jsonl")).toBe(true);

    const b = index.get("bbb")!;
    expect(b.running).toBe(true);
    expect(b.busy).toBe(true);
    expect(b.pid).toBe(process.pid);
    expect(b.name).toBe("wt-session");
    expect(b.cwd).toBe(sub);
    expect(b.title).toBe("worktree prompt"); // first line of the first prompt, trimmed
    expect(b.lastPrompt).toBe("later prompt");
    expect(b.startedAt).toBe(Date.parse("2026-09-12T10:00:00.000Z"));

    const e = index.get("eee")!;
    expect(e.transcriptPath).toBeNull();
    expect(e.title).toBe("fresh");
    expect(e.running).toBe(true);
    expect(e.pid).toBe(process.ppid);
    expect(e.busy).toBe(false);

    // Unchanged files are served from the cache and come back equal.
    const again = await index.refresh();
    expect(again).toEqual(list);
  });

  test("large transcripts are scanned in head/tail windows", async () => {
    const { home, root } = fakeHome();
    const filler = "x".repeat(4000);
    const lines = [userLine("big", root, "first big prompt", "2026-09-12T10:00:00.000Z")];
    for (let i = 0; i < 60; i++) lines.push(userLine("big", root, filler, "2026-09-12T10:01:00.000Z", { isMeta: true }));
    lines.push(JSON.stringify({ type: "ai-title", sessionId: "big", aiTitle: "Big one" }));
    lines.push(JSON.stringify({ type: "last-prompt", sessionId: "big", lastPrompt: "the end" }));
    const file = writeTranscript(home, root, "big", lines);
    expect(fs.statSync(file).size).toBeGreaterThan(128 * 1024);
    const index = new SessionIndex({ rootCwd: root, home });
    const [big] = await index.refresh();
    expect(big?.firstPrompt).toBe("first big prompt");
    expect(big?.title).toBe("Big one");
    expect(big?.lastPrompt).toBe("the end");
  });

  test("a missing ~/.claude yields an empty list", async () => {
    const index = new SessionIndex({ rootCwd: "/nowhere", home: path.join(os.tmpdir(), "cw-no-home-" + process.pid) });
    expect(await index.refresh()).toEqual([]);
    expect(index.get("x")).toBeUndefined();
  });
});
