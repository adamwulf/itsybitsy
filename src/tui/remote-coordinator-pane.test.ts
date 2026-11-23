import { expect, mock, test } from "bun:test";
import { RemoteCoordinatorPane } from "./remote-coordinator-pane";
import { createFakeClock } from "../peers/test-pair-transport";
import { stripAnsi } from "../parse-state";
import type { CoordinatorPane } from "../peers/peer-link";

test("reads immediately and every two seconds, serializes per peer, and ignores stale completions", async () => {
  const clock = createFakeClock();
  const every = (ms: number, tick: () => void) => {
    const next = () => { tick(); cancel = clock.setTimer(ms, next); };
    let cancel = clock.setTimer(ms, next);
    return () => cancel();
  };
  const requests: { id: string; reply: ReturnType<typeof Promise.withResolvers<CoordinatorPane>> }[] = [];
  const pane = new RemoteCoordinatorPane(id => {
    const reply = Promise.withResolvers<CoordinatorPane>();
    requests.push({ id, reply });
    return reply.promise;
  }, () => {}, every);
  const output = () => stripAnsi(pane.render(60, 4).join("\n"));
  clock.advance(6_000);
  expect(requests).toHaveLength(0);
  pane.select("A");
  clock.advance(4_000);
  expect(requests.map(r => r.id)).toEqual(["A"]);
  pane.select("B");
  pane.select("A");
  expect(requests.map(r => r.id)).toEqual(["A", "B"]);
  for (const { reply } of requests) reply.resolve({ state: "running", text: "stale" });
  await Promise.resolve();
  expect(output()).not.toContain("stale");
  clock.advance(1_999);
  expect(requests).toHaveLength(2);
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
  const pane = new RemoteCoordinatorPane(fetch, () => {}, every);
  pane.select("A", "Human dashboard required");
  expect(pane.render(60, 2)).toContain("Human dashboard required");
  expect(fetch).not.toHaveBeenCalled();
  expect(every).not.toHaveBeenCalled();
});
