import { describe, expect, test } from "bun:test";
import { openRemoteTerminal, remoteTerminalSession, type TerminalWindowDeps } from "./terminal-window";

const PEER = "0b".repeat(32);
const row = { peerId: PEER, peerName: "Laptop B", repo: "app", agent: "worker-1" };

function deps(options: { exists?: boolean; started?: number; ghostty?: { ok: boolean; message: string } } = {}) {
  const calls: string[][] = [];
  const opened: string[] = [];
  const fake: TerminalWindowDeps = {
    runTmux: async (args) => {
      calls.push(args);
      if (args[0] === "has-session") return options.exists ? 0 : 1;
      return options.started ?? 0;
    },
    openInGhostty: async (session) => {
      opened.push(session);
      return options.ghostty ?? { ok: true, message: "Opened in Ghostty" };
    },
  };
  return { fake, calls, opened };
}

describe("openRemoteTerminal", () => {
  const session = remoteTerminalSession(PEER, "app", "worker-1");

  test("the session is outside the agent prefix, so orphan cleanup leaves it alone", () => {
    expect(session).toMatch(new RegExp(`^ib-remote-${PEER.slice(0, 10)}-app-worker-1-[0-9a-f]{8}$`));
    expect(session.startsWith("itsybitsy-")).toBe(false);
  });

  test("distinct agents get distinct sessions, each a valid tmux name, even when the readable parts match", () => {
    const names = [
      remoteTerminalSession(PEER, "app", "worker-1"),
      remoteTerminalSession(PEER, "web", "worker-1"),
      remoteTerminalSession(PEER, "web", "api-fix"),
      remoteTerminalSession(PEER, "web-api", "fix"),
      remoteTerminalSession(PEER, "my.app", "w"),
      remoteTerminalSession(PEER, "my_app", "w"),
      remoteTerminalSession(PEER, "", "worker-1"),
    ];
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[\w-]+$/);
    expect(remoteTerminalSession(PEER, "my app.js", "w")).toStartWith(`ib-remote-${PEER.slice(0, 10)}-my_app_js-w-`);
  });

  test("starts ib peer attach in a new detached session, as separate arguments, and opens it", async () => {
    const d = deps();
    expect(await openRemoteTerminal(row, d.fake)).toEqual({ ok: true, message: "Opened Laptop B/app/worker-1 in Ghostty" });
    expect(d.calls).toEqual([
      ["has-session", "-t", `=${session}`],
      ["new-session", "-d", "-s", session, "ib", "peer", "attach", `${PEER}/app/worker-1`],
    ]);
    expect(d.opened).toEqual([session]);
  });

  test("reopens a session that is still running instead of starting a second attach", async () => {
    const d = deps({ exists: true });
    expect((await openRemoteTerminal(row, d.fake)).ok).toBe(true);
    expect(d.calls).toEqual([["has-session", "-t", `=${session}`]]);
    expect(d.opened).toEqual([session]);
  });

  test("leaves out a repo name that would not parse as one segment", async () => {
    const d = deps();
    await openRemoteTerminal({ ...row, repo: "a/b" }, d.fake);
    expect(d.calls[1]!.at(-1)).toBe(`${PEER}/worker-1`);
    expect(d.calls[1]![3]).toBe(remoteTerminalSession(PEER, "", "worker-1"));
  });

  test("refuses an agent id that is not safe for a session name", async () => {
    const d = deps();
    expect(await openRemoteTerminal({ ...row, agent: "x;y" }, d.fake)).toEqual({ ok: false, message: "Invalid remote agent id" });
    expect(d.calls).toEqual([]);
  });

  test("without Ghostty, says how to attach to the session it started", async () => {
    const d = deps({ ghostty: { ok: false, message: "Ghostty not found on PATH" } });
    expect(await openRemoteTerminal(row, d.fake)).toEqual({
      ok: false, message: `Ghostty not found on PATH; attach with: tmux attach -t ${session}`,
    });
  });

  test("a failed new-session is reported", async () => {
    const d = deps({ started: 1 });
    expect(await openRemoteTerminal(row, d.fake)).toEqual({ ok: false, message: `Could not start tmux session ${session}` });
    expect(d.opened).toEqual([]);
  });
});
