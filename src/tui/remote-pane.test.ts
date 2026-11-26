import { expect, mock, test } from "bun:test";
import { RemotePane } from "./remote-pane";
import { createFakeClock } from "../peers/test-pair-transport";
import { stripAnsi } from "../parse-state";
import type { PeerPane } from "../peers/peer-link";

test("reads immediately and every two seconds, serializes per peer, and ignores stale completions", async () => {
  const clock = createFakeClock();
  const every = (ms: number, tick: () => void) => {
    const next = () => { tick(); cancel = clock.setTimer(ms, next); };
    let cancel = clock.setTimer(ms, next);
    return () => cancel();
  };
  const requests: { id: string; reply: ReturnType<typeof Promise.withResolvers<PeerPane>> }[] = [];
  const pane = new RemotePane(id => {
    const reply = Promise.withResolvers<PeerPane>();
    requests.push({ id, reply });
    return reply.promise;
  }, () => {}, every);
  const output = () => stripAnsi(pane.render(60, 4).join("\n"));
  clock.advance(6_000);
  expect(requests).toHaveLength(0);
  pane.select({ peerId: "A", target: { op: "coordinator-pane" } });
  clock.advance(4_000);
  expect(requests.map(r => r.id)).toEqual(["A"]);
  pane.select({ peerId: "B", target: { op: "coordinator-pane" } });
  pane.select({ peerId: "A", target: { op: "coordinator-pane" } });
  expect(requests.map(r => r.id)).toEqual(["A", "B"]);
  for (const { reply } of requests) reply.resolve({ state: "running", text: "stale" });
  await Promise.resolve();
  expect(output()).not.toContain("stale");
  clock.advance(1_999);
  expect(requests).toHaveLength(3);
  clock.advance(1);
  requests[2]!.reply.resolve({ state: "running", text: "latest capture" });
  await Promise.resolve();
  expect(output()).toContain("latest capture");
  clock.advance(2_000);
  requests[3]!.reply.reject(new Error("peer went offline"));
  await Promise.resolve();
  expect(output()).toContain("latest capture");
  expect(output().split("\n").at(-1)).toBe("peer went offline");
  clock.advance(2_000);
  requests[4]!.reply.resolve({ state: "running", text: "new capture" });
  await Promise.resolve();
  expect(output()).toContain("new capture");
  expect(output()).not.toContain("peer went offline");
  pane.select(null);
  clock.advance(20_000);
  expect(requests).toHaveLength(5);
});

test("a denied selection displays the reason without scheduling a read", () => {
  const fetch = mock(async () => ({ state: "", text: "" }));
  const every = mock(() => () => {});
  const pane = new RemotePane(fetch, () => {}, every);
  pane.select({ peerId: "A", target: { op: "coordinator-pane" } }, "Human dashboard required");
  expect(pane.render(60, 2)).toContain("Human dashboard required");
  expect(fetch).not.toHaveBeenCalled();
  expect(every).not.toHaveBeenCalled();
});

test("the coordinator's input box is sliced off and its status lines are returned below it", async () => {
  const sep = "─".repeat(200);
  const text = ["reply one", "reply two", sep, "❯ ", sep, "  ⏵⏵ auto mode on (shift+tab to cycle)", "  Update available!", ""].join("\n");
  const pane = new RemotePane(async () => ({ state: "running", text }), () => {}, () => () => {});
  pane.select({ peerId: "A", target: { op: "coordinator-pane" } });
  await Promise.resolve();
  expect(pane.render(40, 3).map(stripAnsi)).toEqual(["reply one", "reply two", ""]);
  expect(pane.statusLines(20).map(stripAnsi)).toEqual(["  ⏵⏵ auto mode on (s", "  Update available!"]);
  pane.select({ peerId: "B", target: { op: "coordinator-pane" } }, "Human dashboard required");
  expect(pane.statusLines(20)).toEqual([]);
  // An agent without a model (Claude, as for a local agent) is sliced the same way.
  pane.select({ peerId: "A", target: { op: "agent-pane", repo: "r", id: "a" }, model: null });
  await Promise.resolve();
  expect(pane.render(40, 3).map(stripAnsi)).toEqual(["reply one", "reply two", ""]);
  expect(pane.statusLines(20).map(stripAnsi)).toEqual(["  ⏵⏵ auto mode on (s", "  Update available!"]);
});

test("an agent's input box is sliced off by the detector for the CLI its model names", async () => {
  const codexStatus = "gpt-5-codex · ~/proj · Context 42% · 3h left";
  const text = ["codex reply", "› draft", codexStatus].join("\n");
  const pane = new RemotePane(async () => ({ state: "running", text }), () => {}, () => () => {});
  const view = async (model: string) => {
    pane.select({ peerId: "A", target: { op: "agent-pane", repo: "r", id: "a" }, model });
    await Promise.resolve();
    return { body: pane.render(60, 3).map(stripAnsi), status: pane.statusLines(60).map(stripAnsi) };
  };
  expect(await view("codex:gpt-5-codex")).toEqual({ body: ["codex reply", "", ""], status: [codexStatus] });
  expect(await view("fugu:gpt-5-codex")).toEqual({ body: ["codex reply", "", ""], status: [codexStatus] });
  // The Claude detector finds no input box in a codex capture, so it is shown whole.
  expect(await view("claude:opus")).toEqual({ body: ["codex reply", "› draft", codexStatus], status: [] });
});

test("an agy agent's background-task section stays in its status lines, below the input box", async () => {
  const text = await Bun.file(new URL("../fixtures/agy-background-task.txt", import.meta.url)).text();
  const pane = new RemotePane(async () => ({ state: "running", text }), () => {}, () => () => {});
  pane.select({ peerId: "A", target: { op: "agent-pane", repo: "r", id: "a" }, model: "agy:default" });
  await Promise.resolve();
  expect(stripAnsi(pane.render(100, 20).join("\n")).trim()).toBe("WAITING");
  expect(pane.statusLines(100).map(stripAnsi)).toEqual([
    '  ● [23:31:06] python3 -c "import time; time.sleep(120)" running',
    "─".repeat(100),
    "Gemini 3.8 Flash (High) | Context: 21%",
  ]);
});

test("scrollback clamps at each wrap width, counts the lines below as a local pane does, and keeps the error line visible", async () => {
  let tick: () => void = () => {};
  const [a, b, c] = ["a", "b", "c"].map(ch => ch.repeat(22)) as [string, string, string];
  const fetch = mock(async () => ({ state: "running", text: `${a}${a}\n${b}${b}\n${c}${c}` }));
  const pane = new RemotePane(fetch, () => {}, (_ms, poll) => { tick = poll; return () => {}; });
  pane.select({ peerId: "A", target: { op: "coordinator-pane" } });
  await Promise.resolve();
  const rows = (w: number) => pane.render(w, 4).map(stripAnsi);
  // Without an error line the indicator is the pane's last row. Six rows at
  // 22 columns in a 4-row pane clamp the offset at 2.
  pane.scroll(100);
  expect(rows(22)).toEqual([a, b, b, "── ↓ 2 lines below ──"]);
  pane.scroll(-100);
  expect(rows(22)).toEqual([b, b, c, c]);
  fetch.mockRejectedValueOnce(new Error("down"));
  tick();
  await Promise.resolve();
  expect(rows(44)).toEqual([a + a, b + b, c + c, "down"]);
  pane.scroll(100);
  // Everything fits at 44 columns: nothing to scroll, so no indicator.
  expect(rows(44)).toEqual([a + a, b + b, c + c, "down"]);
  // At 22 columns the three lines wrap into six rows: the offset clamps at 3,
  // and the indicator takes the last content row, as on a local agent's tmux pane.
  expect(rows(22)).toEqual([a, b, "── ↓ 3 lines below ──", "down"]);
  pane.scroll(-1);
  expect(rows(22)).toEqual([b, b, "── ↓ 2 lines below ──", "down"]);
  pane.scroll(-2);
  expect(rows(22)).toEqual([b, c, c, "down"]);
  pane.select(null);
});


test("switching from the coordinator to an agent on the same peer discards the old read and shares its slot", async () => {
  let poll = () => {};
  const pending = Promise.withResolvers<PeerPane>();
  const fetch = mock((_peer: string, _target: import("../peers/peer-link").PeerPaneTarget, _lines: number) => pending.promise);
  const pane = new RemotePane(fetch, () => {}, (_ms, tick) => { poll = tick; return () => {}; });
  const agent = { op: "agent-pane", repo: "app", id: "worker" } as const;
  pane.render(40, 250);
  pane.select({ peerId: "B", target: { op: "coordinator-pane" } });
  pane.select({ peerId: "B", target: agent });
  poll();
  expect(fetch.mock.calls).toEqual([["B", { op: "coordinator-pane" }, 260]]);
  fetch.mockResolvedValueOnce({ state: "running", text: "current worker" });
  pending.resolve({ state: "idle", text: "stale coordinator" });
  await Promise.resolve();
  expect(pane.render(40, 250).join(" ")).not.toContain("stale coordinator");
  await Promise.resolve();
  expect(fetch.mock.calls[1]).toEqual(["B", agent, 260]);
  expect(pane.render(40, 250)).toContain("current worker");
  pane.select(null);
});
