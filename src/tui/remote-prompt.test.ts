import { expect, test } from "bun:test";
import { REMOTE_PROMPT_REFRESH_MS, RemotePrompt, type RemotePromptTarget } from "./remote-prompt";
import { createFakeClock } from "../peers/test-pair-transport";
import { stripAnsi } from "../parse-state";

const target = (id: string): RemotePromptTarget => ({ key: `peer/app/${id}`, peerId: "peer", repo: "app", id });

function setup() {
  const clock = createFakeClock();
  const every = (ms: number, tick: () => void) => {
    const next = () => { tick(); cancel = clock.setTimer(ms, next); };
    let cancel = clock.setTimer(ms, next);
    return () => cancel();
  };
  const requests: { id: string; reply: ReturnType<typeof Promise.withResolvers<string>> }[] = [];
  const shown: [string, string][] = [];
  const prompt = new RemotePrompt((_peerId, _repo, id) => {
    const reply = Promise.withResolvers<string>();
    requests.push({ id, reply });
    return reply.promise;
  }, (key, lines) => shown.push([key, stripAnsi(lines.join("\n"))]), every);
  return { clock, requests, shown, prompt };
}

test("reads only while selected: at once, then on every refresh while no read is pending", async () => {
  const { clock, requests, shown, prompt } = setup();
  clock.advance(3 * REMOTE_PROMPT_REFRESH_MS);
  expect(requests).toHaveLength(0);
  prompt.select(target("a"));
  expect(requests.map((r) => r.id)).toEqual(["a"]);
  // The first read is still pending: a refresh starts no second one.
  clock.advance(REMOTE_PROMPT_REFRESH_MS);
  expect(requests).toHaveLength(1);
  requests[0]!.reply.resolve("first\nsecond");
  await Promise.resolve();
  expect(shown).toEqual([["peer/app/a", "first\nsecond"]]);
  clock.advance(REMOTE_PROMPT_REFRESH_MS);
  expect(requests).toHaveLength(2);
  // An unchanged prompt is not shown again; a changed one is.
  requests[1]!.reply.resolve("first\nsecond");
  await Promise.resolve();
  expect(shown).toHaveLength(1);
  clock.advance(REMOTE_PROMPT_REFRESH_MS);
  requests[2]!.reply.resolve("edited");
  await Promise.resolve();
  expect(shown.at(-1)).toEqual(["peer/app/a", "edited"]);
  // Selecting the same agent again changes nothing; deselecting stops the refresh.
  prompt.select(target("a"));
  prompt.select(null);
  clock.advance(3 * REMOTE_PROMPT_REFRESH_MS);
  expect(requests).toHaveLength(3);
});

test("each agent's last prompt is cached: shown at once on return, and kept when a read fails", async () => {
  const { requests, shown, prompt } = setup();
  prompt.select(target("a"));
  requests[0]!.reply.resolve("prompt a");
  await Promise.resolve();
  // b's read fails before anything is cached for it: the reason is shown.
  prompt.select(target("b"));
  requests[1]!.reply.reject(new Error("Machine is disconnected"));
  await Promise.resolve();
  expect(shown).toEqual([["peer/app/a", "prompt a"], ["peer/app/b", "Machine is disconnected"]]);
  // Back on a: its cached prompt at once, and a read that fails leaves it shown.
  prompt.select(target("a"));
  expect(shown.at(-1)).toEqual(["peer/app/a", "prompt a"]);
  expect(requests.map((r) => r.id)).toEqual(["a", "b", "a"]);
  requests[2]!.reply.reject(new Error("Machine is disconnected"));
  await Promise.resolve();
  expect(shown).toHaveLength(3);
  // A read that settles after its agent was deselected still updates the cache.
  prompt.select(target("b"));
  prompt.select(target("a"));
  requests[3]!.reply.resolve("prompt b");
  requests[4]!.reply.resolve("prompt a");
  await Promise.resolve();
  prompt.select(target("b"));
  expect(shown.at(-1)).toEqual(["peer/app/b", "prompt b"]);
});
