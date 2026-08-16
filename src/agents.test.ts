import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, mkdir, readdir, unlink, utimes, writeFile, open } from "fs/promises";
import { tmpdir } from "os";
import {
  computeAge,
  buildAgentTree,
  flattenAgentTree,
  buildParentDisplayNames,
  isRunningState,
  subtreeHasRunning,
  isVisibleUnderRunningFilter,
  subtreeHasNonStopped,
  readRepoAgents,
  readPendingQuestions,
  readAllAgents,
  computeStateFromContent,
  readAgentMeta,
  isRecentlyCreated,
  writeAgentState,
  readAgentState,
  mutateAgentMeta,
  isCompacting,
  isRateLimited,
  isApiError,
  isApiErrorRateLimited,
  isApiTerms,
  isApiSafeguard,
  hasBackgroundTasks,
  isDeadPane,
  anyChildActive,
  detectAgentStates,
  CREATING_GRACE_PERIOD_MS,
  isRecentlyCreatedDirCtx,
  classifySpawnLogCtx,
  SPAWN_IN_PROGRESS_WINDOW_MS,
  resetListTmuxSessionsCache,
  resetReapedTmuxSessions,
  resetTmuxObservationState,
  resetLifecycleLogState,
  TMUX_MISSING_CONFIRMATION_MIN_INTERVAL_MS,
  readAgentTransient,
  writeAgentTransient,
  deleteAgentTransient,
  updateAgentTransient,
  setAgentOperation,
  claimAgentOperation,
  clearAgentOperation,
  isPidAliveCtx,
  isPidAliveSinceCtx,
  isPidIdentityCurrentCtx,
  processStartEpochSecondsCtx,
  resetProcessStartEpochSecondsCache,
  primeProcessStartCache,
  batchProcessStartRawCtx,
  CLAUDE_PID_START_MARGIN_SECONDS,
  PROCESS_START_CACHE_TTL_MS,
  LIFECYCLE_LOCK_STALE_MS,
  assertLifecycleTimingInvariant,
  killPidCtx,
  liveTmuxSessionsCtx,
  captureTmuxOutputResultCtx,
  probeTmuxSessionCtx,
  probeTmuxPaneCtx,
  reapReadAgentMetaCtx,
  acquireAgentLifecycleLock,
  acquireAgentLifecycleLockCtx,
  nowMsCtx,
  resetReadAgentMetaCache,
  TRANSIENT_FRESH_MS,
  OP_STUCK_TIMEOUT_MS,
  _isPidAliveForTests,
  terminateProcess,
  sleepMsCtx,
} from "./agents";
import type { TransientState, AgentOperation } from "./agents";
import { stripAnsi } from "./parse-state";
import { spawnCtx as tmuxPollerSpawnCtx } from "./tmux-poller";
import type { Agent, AgentMeta, FlatEntry, SpawnedBy } from "./agents";
import { makeAgent } from "./test-utils";

// Most state-detection fixtures use synthetic PIDs. Give those processes an
// old start time by default, then let the focused PID-reuse tests override it.
beforeEach(() => {
  resetProcessStartEpochSecondsCache();
  processStartEpochSecondsCtx.set(() => 0);
  // detectAgentStates now batch-primes the process-start cache through the
  // separate batchProcessStartRawCtx seam BEFORE the per-agent gate reads it
  // per-pid. Keep the two seams consistent by default so a focused test that
  // stubs only processStartEpochSecondsCtx sees the same value through the
  // primer: derive the batch `ps` output from the per-pid stub, omitting any
  // pid the per-pid stub reports as dead (null) — exactly as real `ps` omits a
  // dead pid. Tests that assert on the batch spawn itself override this.
  batchProcessStartRawCtx.set(async (pids) =>
    pids
      .map((pid) => {
        const epoch = processStartEpochSecondsCtx.fn(pid);
        if (epoch === null) return null;
        return `${pid} ${new Date(epoch * 1000).toUTCString()}`;
      })
      .filter((line): line is string => line !== null)
      .join("\n") + "\n"
  );
  // Existing fixtures intentionally use synthetic/incomplete AgentMeta. Keep
  // them on their historical bare-PID seam; focused tests below reset this to
  // exercise the real guarded implementation.
  isPidAliveSinceCtx.set((pid) => isPidAliveCtx.fn(pid));
  isPidIdentityCurrentCtx.set((pid) => isPidAliveCtx.fn(pid));
  // Most lifecycle fixtures use synthetic repo paths. Preserve the observed
  // snapshot at the final-revalidation seam; focused race tests reset this to
  // exercise the real disk read.
  reapReadAgentMetaCtx.set(async (_agentDir, agent) => agent.meta);
  acquireAgentLifecycleLockCtx.set(async () => ({ release: async () => {} }));
});

afterEach(() => {
  resetProcessStartEpochSecondsCache();
  processStartEpochSecondsCtx.reset();
  batchProcessStartRawCtx.reset();
  isPidAliveSinceCtx.reset();
  isPidIdentityCurrentCtx.reset();
  captureTmuxOutputResultCtx.reset();
  probeTmuxSessionCtx.reset();
  probeTmuxPaneCtx.reset();
  reapReadAgentMetaCtx.reset();
  acquireAgentLifecycleLockCtx.reset();
  nowMsCtx.reset();
  resetTmuxObservationState();
  resetLifecycleLogState();
});

describe("primeProcessStartCache (batch process-start priming)", () => {
  const S100 = Math.floor(Date.parse("Sat Aug 15 21:00:00 2026") / 1000);
  const S200 = Math.floor(Date.parse("Sat Aug 15 20:00:00 2026") / 1000);

  test("populates the cache from ONE batch spawn; dead pid → null entry", async () => {
    resetProcessStartEpochSecondsCache();
    // Read the guarded implementation (not the bare-PID beforeEach seam) so the
    // process-start cache is actually consulted.
    isPidAliveSinceCtx.reset();
    isPidAliveCtx.set(() => true);

    let batchCalls = 0;
    let requested: number[] = [];
    // pid 300 is deliberately ABSENT from the output — ps reports nothing for a
    // dead pid, so prime must cache a null entry for it.
    batchProcessStartRawCtx.set(async (pids) => {
      batchCalls++;
      requested = pids;
      return `  100 Sat Aug 15 21:00:00 2026    \n200 Sat Aug 15 20:00:00 2026\n`;
    });
    // After priming, EVERY read must hit the cache — never the per-pid spawn.
    processStartEpochSecondsCtx.set(() => {
      throw new Error("per-pid ps spawn must not run after a batch prime");
    });

    await primeProcessStartCache([100, 200, 300]);

    expect(batchCalls).toBe(1);
    expect(requested).toEqual([100, 200, 300]);

    // pid 100 cached a real start time: current when the write epoch matches,
    // NOT current an hour off (a null entry would fail open as alive both ways).
    expect(isPidAliveSinceCtx.fn(100, S100)).toBe(true);
    expect(isPidAliveSinceCtx.fn(100, S100 + 3600)).toBe(false);
    // pid 200 likewise holds its distinct start time.
    expect(isPidAliveSinceCtx.fn(200, S200)).toBe(true);
    expect(isPidAliveSinceCtx.fn(200, S200 + 3600)).toBe(false);
    // pid 300 cached null (dead): fails open as alive for ANY write epoch, and
    // reading it does NOT trigger the throwing per-pid spawn — proving the null
    // entry was cached, not merely absent.
    expect(() => isPidAliveSinceCtx.fn(300, S100 + 3600)).not.toThrow();
    expect(isPidAliveSinceCtx.fn(300, S100 + 3600)).toBe(true);
  });

  test("no spawn for an empty pid list", async () => {
    let batchCalls = 0;
    batchProcessStartRawCtx.set(async () => {
      batchCalls++;
      return "";
    });
    await primeProcessStartCache([]);
    expect(batchCalls).toBe(0);
  });

  test("unparseable lstart caches null (not a bogus epoch)", async () => {
    resetProcessStartEpochSecondsCache();
    isPidAliveSinceCtx.reset();
    isPidAliveCtx.set(() => true);
    batchProcessStartRawCtx.set(async () => `  100 not-a-real-date\n`);
    processStartEpochSecondsCtx.set(() => {
      throw new Error("per-pid ps spawn must not run after a batch prime");
    });
    await primeProcessStartCache([100]);
    // null entry → fails open as alive for any epoch, no per-pid spawn.
    expect(() => isPidAliveSinceCtx.fn(100, S100)).not.toThrow();
    expect(isPidAliveSinceCtx.fn(100, S100)).toBe(true);
  });

  test("detectAgentStates primes alive claude_pids with one batch spawn", async () => {
    resetProcessStartEpochSecondsCache();
    isPidAliveSinceCtx.reset();
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-p1", "ib-p2"]));
    captureTmuxOutputResultCtx.set(async () => ({ status: "ok", output: "working" }));

    const nowEpoch = Math.floor(Date.now() / 1000);
    let batchCalls = 0;
    let requested: number[] = [];
    batchProcessStartRawCtx.set(async (pids) => {
      batchCalls++;
      requested = pids;
      // Report each requested pid with a start time within margin of nowEpoch.
      const stamp = new Date(nowEpoch * 1000).toUTCString();
      return pids.map((p) => `${p} ${stamp}`).join("\n") + "\n";
    });
    // If the batch prime worked, the synchronous per-pid path is never hit.
    processStartEpochSecondsCtx.set(() => {
      throw new Error("per-pid ps spawn must not run when the batch prime covers the pid");
    });

    const mk = (id: string, session: string, pid: string) =>
      makeAgent({
        id,
        meta: {
          state: "running",
          tmux_session: session,
          claude_pid: pid,
          claude_pid_epoch: nowEpoch,
          created_epoch: nowEpoch - 3600,
        } as Partial<AgentMeta> as AgentMeta,
      });

    const agents = [mk("a1", "ib-p1", "4001"), mk("a2", "ib-p2", "4002")];
    await detectAgentStates(agents);

    expect(batchCalls).toBe(1);
    expect(requested.sort()).toEqual([4001, 4002]);
    expect(agents.map((a) => a.state)).toEqual(["running", "running"]);
  });

  test("detectAgentStates does not spawn a batch for dead or epoch-less claude_pids", async () => {
    resetProcessStartEpochSecondsCache();
    isPidAliveSinceCtx.reset();
    // pid alive check returns false → nothing to prime (dead pids never read the
    // process-start cache).
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set());

    let batchCalls = 0;
    batchProcessStartRawCtx.set(async () => {
      batchCalls++;
      return "";
    });

    const a = makeAgent({
      id: "dead-1",
      meta: {
        state: "running",
        tmux_session: "ib-dead",
        claude_pid: "5001",
        claude_pid_epoch: Math.floor(Date.now() / 1000),
        created_epoch: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a]);
    expect(batchCalls).toBe(0);
  });
});

/** Narrow a FlatEntry to kind==="agent" or fail */
function asAgent(entry: FlatEntry) {
  if (entry.kind !== "agent") throw new Error(`Expected agent entry, got ${entry.kind}`);
  return entry;
}

/** Narrow a FlatEntry to kind==="repo-header" or fail */
function asRepoHeader(entry: FlatEntry) {
  if (entry.kind !== "repo-header") throw new Error(`Expected repo-header entry, got ${entry.kind}`);
  return entry;
}

describe("computeAge", () => {
  test("seconds", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now - 30)).toBe("30s");
  });
  test("minutes", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now - 120)).toBe("2m");
  });
  test("hours", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now - 7200)).toBe("2h");
  });
  test("days", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now - 172800)).toBe("2d");
  });
  test("zero seconds", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(computeAge(now)).toBe("0s");
  });
});

describe("buildAgentTree", () => {
  test("single agent with no manager becomes root", () => {
    const agents = [makeAgent({ id: "agent-1" })];
    const roots = buildAgentTree(agents);
    expect(roots.length).toBe(1);
    expect(roots[0]!.id).toBe("agent-1");
    expect(roots[0]!.children.length).toBe(0);
  });

  test("child is nested under manager", () => {
    const manager = makeAgent({ id: "agent-1" });
    const worker = makeAgent({
      id: "agent-2",
      meta: { manager: "agent-1" } as any,
    });
    // Need to set manager on the actual meta
    worker.meta.manager = "agent-1";
    const agents = [manager, worker];
    const roots = buildAgentTree(agents);
    expect(roots.length).toBe(1);
    expect(roots[0]!.id).toBe("agent-1");
    expect(roots[0]!.children.length).toBe(1);
    expect(roots[0]!.children[0]!.id).toBe("agent-2");
  });

  test("agent with missing manager becomes root", () => {
    const agent = makeAgent({ id: "agent-1" });
    agent.meta.manager = "nonexistent";
    const roots = buildAgentTree([agent]);
    expect(roots.length).toBe(1);
    expect(roots[0]!.id).toBe("agent-1");
  });

  test("multi-level tree", () => {
    const root = makeAgent({ id: "root" });
    const mid = makeAgent({ id: "mid" });
    mid.meta.manager = "root";
    const leaf = makeAgent({ id: "leaf" });
    leaf.meta.manager = "mid";

    const roots = buildAgentTree([root, mid, leaf]);
    expect(roots.length).toBe(1);
    expect(roots[0]!.children.length).toBe(1);
    expect(roots[0]!.children[0]!.children.length).toBe(1);
    expect(roots[0]!.children[0]!.children[0]!.id).toBe("leaf");
  });

  test("multiple roots", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const roots = buildAgentTree([a, b]);
    expect(roots.length).toBe(2);
  });

  test("agent with valid manager is not orphaned", () => {
    const manager = makeAgent({ id: "mgr" });
    const worker = makeAgent({ id: "w1" });
    worker.meta.manager = "mgr";
    buildAgentTree([manager, worker]);
    expect(worker.orphaned).toBe(false);
  });

  test("agent with non-existent manager is orphaned", () => {
    const agent = makeAgent({ id: "a1" });
    agent.meta.manager = "does-not-exist";
    buildAgentTree([agent]);
    expect(agent.orphaned).toBe(true);
  });

  test("agent with no manager is not orphaned", () => {
    const agent = makeAgent({ id: "a1" });
    buildAgentTree([agent]);
    expect(agent.orphaned).toBe(false);
  });

  test("orphaned flag resets correctly on second call", () => {
    const agent = makeAgent({ id: "a1" });
    agent.meta.manager = "missing";
    buildAgentTree([agent]);
    expect(agent.orphaned).toBe(true);

    // Now add the missing manager and rebuild
    const manager = makeAgent({ id: "missing" });
    buildAgentTree([manager, agent]);
    expect(agent.orphaned).toBe(false);
  });

  test("agent with archived manager becomes orphaned root", () => {
    const manager = makeAgent({ id: "mgr", archived: true });
    const worker = makeAgent({ id: "w1" });
    worker.meta.manager = "mgr";
    const roots = buildAgentTree([manager, worker]);
    // Worker should be a root (not nested under archived manager)
    expect(roots).toContainEqual(expect.objectContaining({ id: "w1" }));
    expect(worker.orphaned).toBe(true);
    // Archived manager should also be a root
    expect(roots).toContainEqual(expect.objectContaining({ id: "mgr" }));
    // Manager should have no children
    expect(manager.children.length).toBe(0);
  });

  test("active agent with archived manager is visible in flattened tree", () => {
    const manager = makeAgent({ id: "mgr", archived: true });
    const worker = makeAgent({ id: "w1" });
    worker.meta.manager = "mgr";
    const roots = buildAgentTree([manager, worker]);
    const flat = flattenAgentTree(roots);
    // Worker should appear (archived manager is filtered out)
    const agentEntries = flat.filter((e) => e.kind === "agent");
    expect(agentEntries.length).toBe(1);
    expect((agentEntries[0] as any).agent.id).toBe("w1");
  });
});

describe("flattenAgentTree", () => {
  test("flat list with correct depths", () => {
    const root = makeAgent({ id: "root" });
    const child = makeAgent({ id: "child" });
    child.meta.manager = "root";

    const roots = buildAgentTree([root, child]);
    const flat = flattenAgentTree(roots);

    expect(flat.length).toBe(2);
    expect(asAgent(flat[0]!).agent.id).toBe("root");
    expect(asAgent(flat[0]!).depth).toBe(0);
    expect(asAgent(flat[1]!).agent.id).toBe("child");
    expect(asAgent(flat[1]!).depth).toBe(1);
  });

  test("empty tree returns empty list", () => {
    expect(flattenAgentTree([]).length).toBe(0);
  });

  test("three-level depth", () => {
    const root = makeAgent({ id: "root" });
    const mid = makeAgent({ id: "mid" });
    mid.meta.manager = "root";
    const leaf = makeAgent({ id: "leaf" });
    leaf.meta.manager = "mid";

    const roots = buildAgentTree([root, mid, leaf]);
    const flat = flattenAgentTree(roots);
    expect(asAgent(flat[0]!).depth).toBe(0);
    expect(asAgent(flat[1]!).depth).toBe(1);
    expect(asAgent(flat[2]!).depth).toBe(2);
  });

  test("single root has no connector", () => {
    const root = makeAgent({ id: "root" });
    const roots = buildAgentTree([root]);
    const flat = flattenAgentTree(roots);
    expect(asAgent(flat[0]!).connector).toBe("");
  });

  test("multiple roots get ├── and └── connectors", () => {
    const a = makeAgent({ id: "a" });
    const b = makeAgent({ id: "b" });
    const roots = buildAgentTree([a, b]);
    const flat = flattenAgentTree(roots);
    expect(asAgent(flat[0]!).connector).toBe("├── ");
    expect(asAgent(flat[1]!).connector).toBe("└── ");
  });

  test("child connectors use ├── and └──", () => {
    const root = makeAgent({ id: "root" });
    const c1 = makeAgent({ id: "c1" });
    c1.meta.manager = "root";
    const c2 = makeAgent({ id: "c2" });
    c2.meta.manager = "root";

    const roots = buildAgentTree([root, c1, c2]);
    const flat = flattenAgentTree(roots);
    expect(asAgent(flat[0]!).connector).toBe("");       // single root
    expect(asAgent(flat[1]!).connector).toBe("├── ");   // first child
    expect(asAgent(flat[2]!).connector).toBe("└── ");   // last child
  });

  test("nested children use │ continuation lines", () => {
    const root = makeAgent({ id: "root" });
    const c1 = makeAgent({ id: "c1" });
    c1.meta.manager = "root";
    const c2 = makeAgent({ id: "c2" });
    c2.meta.manager = "root";
    const leaf = makeAgent({ id: "leaf" });
    leaf.meta.manager = "c1";

    const roots = buildAgentTree([root, c1, c2, leaf]);
    const flat = flattenAgentTree(roots);
    // root (no connector, single root)
    expect(asAgent(flat[0]!).connector).toBe("");
    // c1 (first child of root, not last)
    expect(asAgent(flat[1]!).connector).toBe("├── ");
    // leaf (child of c1, c1 is not last sibling so prefix has │)
    expect(asAgent(flat[2]!).connector).toBe("│   └── ");
    // c2 (last child of root)
    expect(asAgent(flat[3]!).connector).toBe("└── ");
  });

  test("deep nesting with mixed last-sibling flags", () => {
    const root = makeAgent({ id: "root" });
    const a = makeAgent({ id: "a" });
    a.meta.manager = "root";
    const b = makeAgent({ id: "b" });
    b.meta.manager = "root";
    const a1 = makeAgent({ id: "a1" });
    a1.meta.manager = "a";
    const a1x = makeAgent({ id: "a1x" });
    a1x.meta.manager = "a1";

    const roots = buildAgentTree([root, a, b, a1, a1x]);
    const flat = flattenAgentTree(roots);
    // a1x is under a1 (last child of a), a is not last child of root
    expect(asAgent(flat[0]!).connector).toBe("");           // root
    expect(asAgent(flat[1]!).connector).toBe("├── ");       // a
    expect(asAgent(flat[2]!).connector).toBe("│   └── ");   // a1
    expect(asAgent(flat[3]!).connector).toBe("│       └── "); // a1x
    expect(asAgent(flat[4]!).connector).toBe("└── ");       // b
  });

  test("multi-repo: groups agents under sorted repo headers", () => {
    const a = makeAgent({ id: "a1", repoName: "zeta-repo" });
    const b = makeAgent({ id: "b1", repoName: "alpha-repo" });
    const roots = buildAgentTree([a, b]);
    const flat = flattenAgentTree(roots, ["zeta-repo", "alpha-repo"]);

    // Should be sorted alphabetically: alpha-repo first, then zeta-repo
    expect(flat.length).toBe(4); // 2 headers + 2 agents
    expect(asRepoHeader(flat[0]!).repoName).toBe("alpha-repo");
    expect(asRepoHeader(flat[0]!).hasAgents).toBe(true);
    expect(asAgent(flat[1]!).agent.id).toBe("b1");
    expect(asRepoHeader(flat[2]!).repoName).toBe("zeta-repo");
    expect(asRepoHeader(flat[2]!).hasAgents).toBe(true);
    expect(asAgent(flat[3]!).agent.id).toBe("a1");
  });

  test("multi-repo: includes empty repos with repoHasAgents=false", () => {
    const a = makeAgent({ id: "a1", repoName: "has-agents" });
    const roots = buildAgentTree([a]);
    const flat = flattenAgentTree(roots, ["has-agents", "empty-repo"]);

    expect(flat.length).toBe(3); // 2 headers + 1 agent
    // Sorted: empty-repo, has-agents
    expect(asRepoHeader(flat[0]!).repoName).toBe("empty-repo");
    expect(asRepoHeader(flat[0]!).hasAgents).toBe(false);
    expect(asRepoHeader(flat[1]!).repoName).toBe("has-agents");
    expect(asRepoHeader(flat[1]!).hasAgents).toBe(true);
    expect(asAgent(flat[2]!).agent.id).toBe("a1");
  });

  test("multi-repo: empty repos sorted alphabetically with populated repos", () => {
    const flat = flattenAgentTree([], ["charlie", "alpha", "bravo"]);
    expect(flat.length).toBe(3);
    expect(asRepoHeader(flat[0]!).repoName).toBe("alpha");
    expect(asRepoHeader(flat[0]!).hasAgents).toBe(false);
    expect(asRepoHeader(flat[1]!).repoName).toBe("bravo");
    expect(asRepoHeader(flat[1]!).hasAgents).toBe(false);
    expect(asRepoHeader(flat[2]!).repoName).toBe("charlie");
    expect(asRepoHeader(flat[2]!).hasAgents).toBe(false);
  });

  test("single repo: no headers when repoNames has 1 entry", () => {
    const a = makeAgent({ id: "a1" });
    const roots = buildAgentTree([a]);
    const flat = flattenAgentTree(roots, ["test"]);
    expect(flat.length).toBe(1);
    expect(flat[0]!.kind).toBe("agent");
    expect(asAgent(flat[0]!).agent.id).toBe("a1");
  });

  test("multi-repo: coordinator agents are excluded from flat list", () => {
    const now = Math.floor(Date.now() / 1000);
    const regular = makeAgent({ id: "regular-1", repoName: "my-repo", meta: { created_epoch: now - 100 } as any });
    const coord = makeAgent({ id: "coord-1", repoName: "my-repo", meta: { agentType: "coordinator", created_epoch: now - 50 } as any });
    const regular2 = makeAgent({ id: "regular-2", repoName: "my-repo", meta: { created_epoch: now - 200 } as any });
    const roots = buildAgentTree([regular, coord, regular2]);
    // Need 2+ repos for headers to appear
    const flat = flattenAgentTree(roots, ["my-repo", "other-repo"]);

    // Coordinator should be excluded entirely — only regular agents appear
    const agentEntries = flat.filter((f): f is Extract<typeof f, { kind: "agent" }> => f.kind === "agent");
    expect(agentEntries.length).toBe(2);
    expect(agentEntries.every(e => e.agent.meta.agentType !== "coordinator")).toBe(true);
    expect(agentEntries[0]!.agent.id).toBe("regular-2");
    expect(agentEntries[1]!.agent.id).toBe("regular-1");
  });

  // BUG-2: repo headers carry hasNonStoppedAgents (true iff any non-coordinator
  // agent in the repo is not fully stopped) alongside hasRunningAgents.
  test("multi-repo: repo header sets hasNonStoppedAgents from agent states", () => {
    // waiting-only repo: not running, but non-stopped.
    const waiting = makeAgent({ id: "w1", repoName: "waiting-repo", state: "waiting" });
    // stopped-only repo: neither running nor non-stopped.
    const stopped = makeAgent({ id: "s1", repoName: "stopped-repo", state: "stopped" });
    const roots = buildAgentTree([waiting, stopped]);
    const flat = flattenAgentTree(roots, ["waiting-repo", "stopped-repo"]);

    const waitingHeader = flat.find((f) => f.kind === "repo-header" && f.repoName === "waiting-repo");
    const stoppedHeader = flat.find((f) => f.kind === "repo-header" && f.repoName === "stopped-repo");
    expect(waitingHeader && asRepoHeader(waitingHeader).hasRunningAgents).toBe(false);
    expect(waitingHeader && asRepoHeader(waitingHeader).hasNonStoppedAgents).toBe(true);
    expect(stoppedHeader && asRepoHeader(stoppedHeader).hasRunningAgents).toBe(false);
    expect(stoppedHeader && asRepoHeader(stoppedHeader).hasNonStoppedAgents).toBe(false);
  });
});

describe("flattenAgentTree groupByParent", () => {
  /** Narrow a FlatEntry to kind==="parent-header" or fail */
  function asParentHeader(entry: FlatEntry) {
    if (entry.kind !== "parent-header") throw new Error(`Expected parent-header entry, got ${entry.kind}`);
    return entry;
  }

  test("default arg (omitted) is byte-identical to today — no parent-header", () => {
    const a = makeAgent({ id: "a1", repoName: "zeta-repo", repoPath: "/Users/x/Developer/zeta-repo" });
    const b = makeAgent({ id: "b1", repoName: "alpha-repo", repoPath: "/Users/x/Developer/alpha-repo" });
    const roots = buildAgentTree([a, b]);
    const repos = [
      { name: "zeta-repo", path: "/Users/x/Developer/zeta-repo" },
      { name: "alpha-repo", path: "/Users/x/Developer/alpha-repo" },
    ];
    // Omitted 4th arg and explicit false must produce the same output, and that
    // output must contain no parent-header rows.
    const omitted = flattenAgentTree(roots, repos);
    const explicitFalse = flattenAgentTree(roots, repos, undefined, false);
    expect(omitted).toEqual(explicitFalse);
    expect(omitted.some((f) => f.kind === "parent-header")).toBe(false);
    expect(omitted.length).toBe(4); // 2 repo-headers + 2 agents
    expect(asRepoHeader(omitted[0]!).repoName).toBe("alpha-repo");
    expect(asAgent(omitted[1]!).agent.id).toBe("b1");
    expect(asRepoHeader(omitted[2]!).repoName).toBe("zeta-repo");
    expect(asAgent(omitted[3]!).agent.id).toBe("a1");
  });

  test("two repos sharing one parent: single parent-header, repos nested under it", () => {
    const a = makeAgent({ id: "a1", repoName: "zeta-repo", repoPath: "/Users/x/Developer/zeta-repo" });
    const b = makeAgent({ id: "b1", repoName: "alpha-repo", repoPath: "/Users/x/Developer/alpha-repo" });
    const roots = buildAgentTree([a, b]);
    const repos = [
      { name: "zeta-repo", path: "/Users/x/Developer/zeta-repo" },
      { name: "alpha-repo", path: "/Users/x/Developer/alpha-repo" },
    ];
    const flat = flattenAgentTree(roots, repos, undefined, true);

    // parent-header, then repos sorted alphabetically within the group.
    expect(flat.length).toBe(5); // 1 parent-header + 2 repo-headers + 2 agents
    const parent = asParentHeader(flat[0]!);
    expect(parent.parentDir).toBe("/Users/x/Developer");
    expect(parent.displayName).toBe("Developer");
    expect(asRepoHeader(flat[1]!).repoName).toBe("alpha-repo");
    expect(asAgent(flat[2]!).agent.id).toBe("b1");
    expect(asRepoHeader(flat[3]!).repoName).toBe("zeta-repo");
    expect(asAgent(flat[4]!).agent.id).toBe("a1");
  });

  test("repos across two parents: one parent-header per group, sorted by parentDir", () => {
    const a = makeAgent({ id: "a1", repoName: "dev-repo", repoPath: "/Users/x/Developer/dev-repo" });
    const b = makeAgent({ id: "b1", repoName: "work-repo", repoPath: "/Users/x/Work/work-repo" });
    const roots = buildAgentTree([a, b]);
    const repos = [
      { name: "dev-repo", path: "/Users/x/Developer/dev-repo" },
      { name: "work-repo", path: "/Users/x/Work/work-repo" },
    ];
    const flat = flattenAgentTree(roots, repos, undefined, true);

    // Parent groups sorted alphabetically by parentDir: Developer < Work.
    expect(flat.length).toBe(6); // 2 parent-headers + 2 repo-headers + 2 agents
    expect(asParentHeader(flat[0]!).parentDir).toBe("/Users/x/Developer");
    expect(asParentHeader(flat[0]!).displayName).toBe("Developer");
    expect(asRepoHeader(flat[1]!).repoName).toBe("dev-repo");
    expect(asAgent(flat[2]!).agent.id).toBe("a1");
    expect(asParentHeader(flat[3]!).parentDir).toBe("/Users/x/Work");
    expect(asParentHeader(flat[3]!).displayName).toBe("Work");
    expect(asRepoHeader(flat[4]!).repoName).toBe("work-repo");
    expect(asAgent(flat[5]!).agent.id).toBe("b1");
  });

  test("single repo (repoNames length 1): no grouping, no parent-header even when true", () => {
    const a = makeAgent({ id: "a1", repoName: "solo", repoPath: "/Users/x/Developer/solo" });
    const roots = buildAgentTree([a]);
    // Only one repo → the >1 branch never runs, so no headers of any kind.
    const flat = flattenAgentTree(roots, [{ name: "solo", path: "/Users/x/Developer/solo" }], undefined, true);
    expect(flat.length).toBe(1);
    expect(flat[0]!.kind).toBe("agent");
    expect(asAgent(flat[0]!).agent.id).toBe("a1");
  });

  test("empty-path repo: bucketed under sentinel, NO parent-header, renders flat first", () => {
    // alpha has a known path; no-path has an empty path (unknown on disk).
    const a = makeAgent({ id: "a1", repoName: "alpha", repoPath: "/Users/x/Developer/alpha" });
    const b = makeAgent({ id: "b1", repoName: "no-path", repoPath: "" });
    const roots = buildAgentTree([a, b]);
    const repos = [
      { name: "alpha", path: "/Users/x/Developer/alpha" },
      { name: "no-path", path: "" },
    ];
    const flat = flattenAgentTree(roots, repos, undefined, true);

    // The "" sentinel group sorts first and emits NO parent-header; the
    // Developer group emits its parent-header. Total: 1 parent-header +
    // 2 repo-headers + 2 agents = 5.
    expect(flat.length).toBe(5);
    // "" sentinel group first: no-path repo, flat (no parent-header above it).
    expect(asRepoHeader(flat[0]!).repoName).toBe("no-path");
    expect(asAgent(flat[1]!).agent.id).toBe("b1");
    // Then the Developer parent group.
    expect(asParentHeader(flat[2]!).parentDir).toBe("/Users/x/Developer");
    expect(asRepoHeader(flat[3]!).repoName).toBe("alpha");
    expect(asAgent(flat[4]!).agent.id).toBe("a1");
    // Exactly one parent-header overall (the empty-path repo never got one).
    expect(flat.filter((f) => f.kind === "parent-header").length).toBe(1);
  });

  test("all repos share one parent: still emits the single parent-header", () => {
    const a = makeAgent({ id: "a1", repoName: "alpha", repoPath: "/Users/x/Developer/alpha" });
    const b = makeAgent({ id: "b1", repoName: "bravo", repoPath: "/Users/x/Developer/bravo" });
    const c = makeAgent({ id: "c1", repoName: "charlie", repoPath: "/Users/x/Developer/charlie" });
    const roots = buildAgentTree([a, b, c]);
    const repos = [
      { name: "alpha", path: "/Users/x/Developer/alpha" },
      { name: "bravo", path: "/Users/x/Developer/bravo" },
      { name: "charlie", path: "/Users/x/Developer/charlie" },
    ];
    const flat = flattenAgentTree(roots, repos, undefined, true);
    const parentHeaders = flat.filter((f) => f.kind === "parent-header");
    expect(parentHeaders.length).toBe(1);
    expect(asParentHeader(parentHeaders[0]!).displayName).toBe("Developer");
    // The single parent-header is at the very top.
    expect(flat[0]!.kind).toBe("parent-header");
  });

  test("empty repos participate in grouping by their path", () => {
    // No agents; two empty repos share a parent, one is elsewhere.
    const repos = [
      { name: "alpha", path: "/Users/x/Developer/alpha" },
      { name: "bravo", path: "/Users/x/Developer/bravo" },
      { name: "solo", path: "/Users/x/Other/solo" },
    ];
    const flat = flattenAgentTree([], repos, undefined, true);
    // Developer group (2 repos) then Other group (1 repo).
    expect(asParentHeader(flat[0]!).displayName).toBe("Developer");
    expect(asRepoHeader(flat[1]!).repoName).toBe("alpha");
    expect(asRepoHeader(flat[2]!).repoName).toBe("bravo");
    expect(asParentHeader(flat[3]!).displayName).toBe("Other");
    expect(asRepoHeader(flat[4]!).repoName).toBe("solo");
  });

  // S4: two DIFFERENT parents that share a basename must stay SEPARATE groups
  // (identity keys on full parentDir) AND render DISTINGUISHABLE labels.
  test("same-basename parents stay separate and render distinguishable labels", () => {
    const a = makeAgent({ id: "a1", repoName: "alpha", repoPath: "/Users/alice/Developer/alpha" });
    const b = makeAgent({ id: "b1", repoName: "bravo", repoPath: "/Volumes/work/Developer/bravo" });
    const roots = buildAgentTree([a, b]);
    const repos = [
      { name: "alpha", path: "/Users/alice/Developer/alpha" },
      { name: "bravo", path: "/Volumes/work/Developer/bravo" },
    ];
    const flat = flattenAgentTree(roots, repos, undefined, true);

    const parentHeaders = flat.filter((f) => f.kind === "parent-header").map((f) => asParentHeader(f));
    // Two separate groups (grouping keyed on full parentDir).
    expect(parentHeaders.length).toBe(2);
    expect(parentHeaders.map((p) => p.parentDir).sort()).toEqual([
      "/Users/alice/Developer",
      "/Volumes/work/Developer",
    ]);
    // Labels are disambiguated (last-two segments), NOT two identical "Developer".
    const labels = parentHeaders.map((p) => p.displayName);
    expect(labels).toContain("alice/Developer");
    expect(labels).toContain("work/Developer");
    expect(new Set(labels).size).toBe(2); // distinguishable
  });

  // S5: a repo directly under root ("/foo") has parent "/" whose basename is
  // "" — the header must NOT render blank.
  test("top-level repo (parent is '/') gets a non-empty parent label", () => {
    const a = makeAgent({ id: "a1", repoName: "rootrepo", repoPath: "/rootrepo" });
    const b = makeAgent({ id: "b1", repoName: "devrepo", repoPath: "/Users/x/Developer/devrepo" });
    const roots = buildAgentTree([a, b]);
    const repos = [
      { name: "rootrepo", path: "/rootrepo" },
      { name: "devrepo", path: "/Users/x/Developer/devrepo" },
    ];
    const flat = flattenAgentTree(roots, repos, undefined, true);
    const parentHeaders = flat.filter((f) => f.kind === "parent-header").map((f) => asParentHeader(f));
    // The "/" parent gets a non-blank label (falls back to the raw parentDir).
    const rootHeader = parentHeaders.find((p) => p.parentDir === "/");
    expect(rootHeader).toBeDefined();
    expect(rootHeader!.displayName.length).toBeGreaterThan(0);
    expect(rootHeader!.displayName).toBe("/");
  });
});

describe("buildParentDisplayNames", () => {
  test("unique basenames render as the plain basename", () => {
    const map = buildParentDisplayNames(["/Users/x/Developer", "/Users/x/Work"]);
    expect(map.get("/Users/x/Developer")).toBe("Developer");
    expect(map.get("/Users/x/Work")).toBe("Work");
  });

  test("colliding basenames fall back to last-two segments", () => {
    const map = buildParentDisplayNames(["/Users/alice/Developer", "/Volumes/work/Developer"]);
    expect(map.get("/Users/alice/Developer")).toBe("alice/Developer");
    expect(map.get("/Volumes/work/Developer")).toBe("work/Developer");
  });

  test("mixed: only the colliding basename disambiguates, uniques stay plain", () => {
    const map = buildParentDisplayNames([
      "/Users/alice/Developer",
      "/Volumes/work/Developer",
      "/Users/x/Projects",
    ]);
    expect(map.get("/Users/alice/Developer")).toBe("alice/Developer");
    expect(map.get("/Volumes/work/Developer")).toBe("work/Developer");
    expect(map.get("/Users/x/Projects")).toBe("Projects"); // unique → plain
  });

  test("root parent '/' → non-empty label", () => {
    const map = buildParentDisplayNames(["/"]);
    expect(map.get("/")).toBe("/");
  });
});

describe("V-filter state predicates", () => {
  test("isVisibleUnderRunningFilter is true for every non-stopped state", () => {
    const nonStopped = [
      "running", "waiting", "complete", "creating", "compacting",
      "rate_limited", "api_error", "api_terms", "api_safeguard", "merging", "restarting",
      "op_stuck", "unknown",
    ];
    for (const s of nonStopped) expect(isVisibleUnderRunningFilter(s)).toBe(true);
    expect(isVisibleUnderRunningFilter("stopped")).toBe(false);
  });

  test("isVisibleUnderRunningFilter is strictly broader than isRunningState", () => {
    // Every state isRunningState accepts, the filter accepts too...
    for (const s of ["running", "creating", "compacting"]) {
      expect(isRunningState(s)).toBe(true);
      expect(isVisibleUnderRunningFilter(s)).toBe(true);
    }
    // ...but the filter also keeps states isRunningState rejects (all but stopped).
    for (const s of ["waiting", "complete", "merging", "rate_limited"]) {
      expect(isRunningState(s)).toBe(false);
      expect(isVisibleUnderRunningFilter(s)).toBe(true);
    }
  });

  test("subtreeHasNonStopped mirrors subtreeHasRunning but on the non-stopped predicate", () => {
    // A stopped parent with a waiting child: not running anywhere, but the
    // subtree has a non-stopped node.
    const child = makeAgent({ id: "c1", state: "waiting" });
    const parent = makeAgent({ id: "p1", state: "stopped", children: [child] });
    expect(subtreeHasRunning(parent)).toBe(false);
    expect(subtreeHasNonStopped(parent)).toBe(true);

    // Fully-stopped subtree: neither.
    const allStopped = makeAgent({ id: "p2", state: "stopped", children: [makeAgent({ id: "c2", state: "stopped" })] });
    expect(subtreeHasRunning(allStopped)).toBe(false);
    expect(subtreeHasNonStopped(allStopped)).toBe(false);

    // Archived subtrees never count, matching subtreeHasRunning.
    const archived = makeAgent({ id: "p3", state: "waiting", archived: true });
    expect(subtreeHasNonStopped(archived)).toBe(false);
  });
});

describe("readRepoAgents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-agents-test-"));
  });

  afterEach(async () => {
    isRecentlyCreatedDirCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reads agents from .ittybitty/agents/", async () => {
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-abc");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "meta.json"),
      JSON.stringify({
        id: "agent-abc",
        session_id: "sess-1",
        tmux_session: "tmux-abc",
        prompt: "do stuff",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: Math.floor(Date.now() / 1000) - 60,
        worktree: true,
        worker: false,
        model: "sonnet",
        claude_pid: "999",
      })
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe("agent-abc");
    expect(agents[0]!.repoName).toBe("test-repo");
    expect(agents[0]!.archived).toBe(false);
  });

  test("reads archived agents", async () => {
    const archiveDir = join(tempDir, ".ittybitty", "archive", "agent-old");
    await mkdir(archiveDir, { recursive: true });
    await Bun.write(
      join(archiveDir, "meta.json"),
      JSON.stringify({
        id: "agent-old",
        session_id: "sess-2",
        tmux_session: "tmux-old",
        prompt: "old task",
        manager: null,
        created: "2026-03-04T00:00:00Z",
        created_epoch: Math.floor(Date.now() / 1000) - 86400,
        worktree: true,
        worker: true,
        model: "opus",
        claude_pid: "888",
      })
    );

    // Need agents/ dir to exist (even empty) since readRepoAgents reads both
    await mkdir(join(tempDir, ".ittybitty", "agents"), { recursive: true });

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(1);
    expect(agents[0]!.archived).toBe(true);
    expect(agents[0]!.meta.worker).toBe(true);
  });

  test("returns empty for missing .ittybitty dir", async () => {
    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(0);
  });

  test("includeArchived=false excludes archived agents and does not touch archive dir", async () => {
    // One active agent and one archived agent on disk.
    const activeDir = join(tempDir, ".ittybitty", "agents", "agent-active");
    await mkdir(activeDir, { recursive: true });
    await Bun.write(join(activeDir, "meta.json"), JSON.stringify({
      id: "agent-active", session_id: "s-a", tmux_session: "t-a",
      prompt: "active task", manager: null, created: "2026-03-05",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true, worker: false, model: "sonnet", claude_pid: "1",
    }));

    const archiveDir = join(tempDir, ".ittybitty", "archive", "agent-old");
    await mkdir(archiveDir, { recursive: true });
    await Bun.write(join(archiveDir, "meta.json"), JSON.stringify({
      id: "agent-old", session_id: "s-o", tmux_session: "t-o",
      prompt: "old task", manager: null, created: "2026-03-04",
      created_epoch: Math.floor(Date.now() / 1000) - 86400,
      worktree: true, worker: true, model: "opus", claude_pid: "2",
    }));

    // Proof the archive dir is never read: replace its meta.json with a value
    // that WOULD surface as a malformed-meta error if the archive were scanned.
    // Because includeArchived=false skips the archive dir entirely, no error
    // appears and only the active agent is returned.
    isRecentlyCreatedDirCtx.set(async () => false);
    await Bun.write(join(archiveDir, "meta.json"), "{ this is not valid json");

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo", false);
    expect(errors.length).toBe(0); // archive dir not scanned → no malformed-meta error
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe("agent-active");
    expect(agents.some((a) => a.archived)).toBe(false);
  });

  test("includeArchived=true (default) still reads archived agents", async () => {
    const archiveDir = join(tempDir, ".ittybitty", "archive", "agent-old");
    await mkdir(archiveDir, { recursive: true });
    await Bun.write(join(archiveDir, "meta.json"), JSON.stringify({
      id: "agent-old", session_id: "s-o", tmux_session: "t-o",
      prompt: "old task", manager: null, created: "2026-03-04",
      created_epoch: Math.floor(Date.now() / 1000) - 86400,
      worktree: true, worker: true, model: "opus", claude_pid: "2",
    }));
    await mkdir(join(tempDir, ".ittybitty", "agents"), { recursive: true });

    // Explicit true and the no-arg default must both include archived agents.
    const explicit = await readRepoAgents(tempDir, "test-repo", true);
    expect(explicit.agents.length).toBe(1);
    expect(explicit.agents[0]!.archived).toBe(true);

    const defaulted = await readRepoAgents(tempDir, "test-repo");
    expect(defaulted.agents.length).toBe(1);
    expect(defaulted.agents[0]!.archived).toBe(true);
  });

  test("reports error for malformed meta.json (non-recent dir)", async () => {
    // Override to simulate a directory that's past the grace period
    isRecentlyCreatedDirCtx.set(async () => false);
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-bad");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), '{"not_valid": true}');

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("missing or invalid");
  });

  test("reports error for unparseable meta.json (non-recent dir)", async () => {
    isRecentlyCreatedDirCtx.set(async () => false);
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-corrupt");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), "not json at all");

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("Failed to read");
  });

  test("skips directories without meta.json (non-recent dir)", async () => {
    isRecentlyCreatedDirCtx.set(async () => false);
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-empty");
    await mkdir(agentDir, { recursive: true });
    // No meta.json written

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("Missing");
  });

  test("suppresses errors for recently-created agent directories", async () => {
    // Default isRecentlyCreatedDirCtx uses real birthtime — dirs just created are < 6s old
    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-new");
    await mkdir(agentDir, { recursive: true });
    // No meta.json — simulates agent still being set up

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(0); // Error suppressed during grace period
  });

  test("suppresses errors for malformed meta.json in recently-created dirs", async () => {
    const agentDir = join(tempDir, ".ittybitsy", "agents", "agent-new2");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), '{"not_valid": true}');

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(0); // Error suppressed during grace period
  });

  test("renders in-progress spawn (recent [spawn] start, no completion) as creating, not orphan", async () => {
    // Fix 3: when meta.json is missing but agent.log shows a recent [spawn]
    // start with no terminating "spawn OK" / "spawn FAILED", the dashboard
    // should surface this as a creating agent, not an orphan.
    isRecentlyCreatedDirCtx.set(async () => false); // past 6s grace
    classifySpawnLogCtx.set(async () => ({
      kind: "in_progress",
      startEpochMs: Date.now() - 30_000, // 30s ago — well within window
    }));

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-spawning");
    await mkdir(agentDir, { recursive: true });
    // No meta.json — but a `[spawn] start` line in agent.log indicates active spawn.
    await Bun.write(
      join(agentDir, "agent.log"),
      "[2026-04-29 12:00:00] [spawn] start id=agent-spawning repo=/x worktree=true\n",
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(1);
    expect(agents[0]!.id).toBe("agent-spawning");
    expect(agents[0]!.state).toBe("creating");
    expect(agents[0]!.meta.state).toBe("creating");

    classifySpawnLogCtx.reset();
  });

  test("flags orphan when [spawn] start is stale (older than the in-progress window)", async () => {
    isRecentlyCreatedDirCtx.set(async () => false);
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-stale");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "agent.log"),
      "[2026-04-29 09:00:00] [spawn] start id=agent-stale repo=/x worktree=true\n",
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0]!.error).toContain("Missing");

    classifySpawnLogCtx.reset();
  });

  test("flags orphan when [spawn] start is followed by 'spawn FAILED' (terminated, not in-progress)", async () => {
    isRecentlyCreatedDirCtx.set(async () => false);
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-failed");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "agent.log"),
      "[2026-04-29 12:00:00] [spawn] start id=agent-failed repo=/x worktree=true\n" +
      "[2026-04-29 12:00:01] [spawn] spawn FAILED: could not create worktree\n",
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(agents.length).toBe(0);
    expect(errors.length).toBe(1);

    classifySpawnLogCtx.reset();
  });

  test("classifySpawnLog default impl: detects recent in-progress spawn from real agent.log", async () => {
    // Exercises the actual classifier (not the injected mock) to verify it
    // parses timestamps and the start-without-terminator condition correctly.
    isRecentlyCreatedDirCtx.set(async () => false);

    // Use a timestamp 1 minute ago (within the 5min in-progress window) in
    // local time, formatted exactly like logAgent() does.
    const oneMinAgo = new Date(Date.now() - 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts =
      `${oneMinAgo.getFullYear()}-${pad(oneMinAgo.getMonth() + 1)}-${pad(oneMinAgo.getDate())} ` +
      `${pad(oneMinAgo.getHours())}:${pad(oneMinAgo.getMinutes())}:${pad(oneMinAgo.getSeconds())}`;

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-real");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(
      join(agentDir, "agent.log"),
      `[${ts}] [spawn] start id=agent-real repo=/x worktree=true\n` +
      `[${ts}] [spawn] git worktree prune → exit=0\n`,
    );

    const { agents, errors } = await readRepoAgents(tempDir, "test-repo");
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(1);
    expect(agents[0]!.state).toBe("creating");
  });

  test("SPAWN_IN_PROGRESS_WINDOW_MS is reasonable for slow worktree-add", () => {
    // Sanity: window must comfortably exceed observed slow checkouts.
    expect(SPAWN_IN_PROGRESS_WINDOW_MS).toBeGreaterThanOrEqual(2 * 60 * 1000);
  });
});

describe("readAgentMeta", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-meta-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("meta.json with all correct fields works", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-abc",
        session_id: "sess-1",
        tmux_session: "tmux-abc",
        prompt: "do stuff",
        manager: null,
        created: "2026-03-05T00:00:00Z",
        created_epoch: 1000,
        worktree: true,
        worker: false,
        model: "sonnet",
        claude_pid: "999",
        claude_pid_epoch: 1001,
      })
    );

    const { meta, error } = await readAgentMeta(tempDir);
    expect(error).toBeUndefined();
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("agent-abc");
    expect(meta!.session_id).toBe("sess-1");
    expect(meta!.tmux_session).toBe("tmux-abc");
    expect(meta!.prompt).toBe("do stuff");
    expect(meta!.manager).toBeNull();
    expect(meta!.created).toBe("2026-03-05T00:00:00Z");
    expect(meta!.created_epoch).toBe(1000);
    expect(meta!.worktree).toBe(true);
    expect(meta!.worker).toBe(false);
    expect(meta!.model).toBe("sonnet");
    expect(meta!.claude_pid).toBe("999");
    expect(meta!.claude_pid_epoch).toBe(1001);
  });

  test("meta.json with wrong-typed fields gets defaults applied", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-typed",
        session_id: 123,
        tmux_session: false,
        prompt: 42,
        manager: 99,
        created: true,
        created_epoch: "not-a-number",
        worktree: "yes",
        worker: "no",
        model: 777,
        claude_pid: 0,
        claude_pid_epoch: "not-a-number",
      })
    );

    const { meta, error } = await readAgentMeta(tempDir);
    expect(error).toBeUndefined();
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("agent-typed");
    expect(meta!.session_id).toBe("");
    expect(meta!.tmux_session).toBe("");
    expect(meta!.prompt).toBe("");
    expect(meta!.manager).toBeNull();
    expect(meta!.created).toBe("");
    expect(meta!.created_epoch).toBe(0);
    expect(meta!.worktree).toBe(true);
    expect(meta!.worker).toBe(false);
    expect(meta!.model).toBe("unknown");
    expect(meta!.claude_pid).toBe("");
    expect(meta!.claude_pid_epoch).toBeUndefined();
  });

  test("meta.json with missing fields gets defaults applied", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-minimal",
      })
    );

    const { meta, error } = await readAgentMeta(tempDir);
    expect(error).toBeUndefined();
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("agent-minimal");
    expect(meta!.session_id).toBe("");
    expect(meta!.tmux_session).toBe("");
    expect(meta!.prompt).toBe("");
    expect(meta!.manager).toBeNull();
    expect(meta!.created).toBe("");
    expect(meta!.created_epoch).toBe(0);
    expect(meta!.worktree).toBe(true);
    expect(meta!.worker).toBe(false);
    expect(meta!.model).toBe("unknown");
    expect(meta!.claude_pid).toBe("");
    expect(meta!.summary).toBeUndefined();
  });

  test("reads summary field from meta.json when present", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-with-summary",
        summary: "A short task summary",
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.summary).toBe("A short task summary");
  });

  test("strips non-string summary values", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({
        id: "agent-bad-summary",
        summary: 123,
      })
    );

    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.summary).toBeUndefined();
  });

  test("reads a valid nickname from meta.json when present", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({ id: "agent-nick", nickname: "pikachu" })
    );
    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.nickname).toBe("pikachu");
  });

  test("strips a non-string nickname value", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({ id: "agent-bad-nick", nickname: 42 })
    );
    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.nickname).toBeUndefined();
  });

  test("drops an empty-string nickname on read (defensive — should never exist)", async () => {
    await Bun.write(
      join(tempDir, "meta.json"),
      JSON.stringify({ id: "agent-empty-nick", nickname: "" })
    );
    const { meta } = await readAgentMeta(tempDir);
    expect(meta).not.toBeNull();
    expect(meta!.nickname).toBeUndefined();
  });
});

describe("readPendingQuestions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-questions-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("reads pending questions from existing agents", async () => {
    await mkdir(join(tempDir, ".ittybitty", "agents", "agent-1"), { recursive: true });
    await Bun.write(
      join(tempDir, ".ittybitty", "user-questions.json"),
      JSON.stringify({
        questions: [
          { id: "q-1", agent: "agent-1", question: "Should I?", timestamp: "2026-03-05T00:00:00Z", status: "pending" },
          { id: "q-2", agent: "agent-2", question: "Done?", timestamp: "2026-03-05T00:01:00Z", status: "acknowledged" },
        ],
      })
    );

    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(1);
    expect(questions[0]!.id).toBe("q-1");
    expect(questions[0]!.status).toBe("pending");
  });

  test("filters out questions from agents that no longer exist", async () => {
    // Only agent-2 exists in agents dir; agent-1 does not
    await mkdir(join(tempDir, ".ittybitty", "agents", "agent-2"), { recursive: true });
    await Bun.write(
      join(tempDir, ".ittybitty", "user-questions.json"),
      JSON.stringify({
        questions: [
          { id: "q-1", agent: "agent-1", question: "Should I?", timestamp: "2026-03-05T00:00:00Z", status: "pending" },
          { id: "q-2", agent: "agent-2", question: "Done?", timestamp: "2026-03-05T00:01:00Z", status: "pending" },
        ],
      })
    );

    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(1);
    expect(questions[0]!.id).toBe("q-2");
  });

  test("filters out all questions when agents directory does not exist", async () => {
    // Create questions file but no agents/ directory
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(
      join(tempDir, ".ittybitty", "user-questions.json"),
      JSON.stringify({
        questions: [
          { id: "q-1", agent: "agent-ghost", question: "Hello?", timestamp: "2026-03-05T00:00:00Z", status: "pending" },
        ],
      })
    );

    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(0);
  });

  test("returns empty for missing file", async () => {
    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(0);
  });

  test("returns empty for malformed file", async () => {
    await mkdir(join(tempDir, ".ittybitty"), { recursive: true });
    await Bun.write(join(tempDir, ".ittybitty", "user-questions.json"), "garbage");
    const questions = await readPendingQuestions(tempDir);
    expect(questions.length).toBe(0);
  });
});

describe("computeStateFromContent", () => {
  test("empty string → returns 'creating'", () => {
    expect(computeStateFromContent("")).toBe("creating");
  });

  test("< 10 non-empty lines with no startup markers → returns 'creating'", () => {
    const input = "line1\nline2\nline3\n\n\n";
    expect(computeStateFromContent(input)).toBe("creating");
  });

  test("< 10 non-empty lines WITH a startup marker → returns null", () => {
    const input = "Claude Code v1.0\nline2\nline3";
    expect(computeStateFromContent(input)).toBeNull();
  });

  test("exactly 9 non-empty lines with no startup markers → returns 'creating'", () => {
    const lines = Array(9).fill("line").join("\n");
    expect(computeStateFromContent(lines)).toBe("creating");
  });

  test(">= 10 non-empty lines with no startup markers → returns null", () => {
    const lines = Array(10).fill("line").join("\n");
    expect(computeStateFromContent(lines)).toBeNull();
  });

  test("whitespace-only lines don't count as non-empty", () => {
    const input = "   \n  \n\t\n";
    expect(computeStateFromContent(input)).toBe("creating");
  });

  test("output with '[AGENT CONTEXT]' marker → returns null", () => {
    const input = "[AGENT CONTEXT]\nline2\nline3";
    expect(computeStateFromContent(input)).toBeNull();
  });

  test("output with '╭─ Claude Code' marker → returns null", () => {
    const input = "╭─ Claude Code\nline2";
    expect(computeStateFromContent(input)).toBeNull();
  });
});

describe("readAllAgents", () => {
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(async () => {
    tempDir1 = await mkdtemp(join(tmpdir(), "itsybitsy-all-1-"));
    tempDir2 = await mkdtemp(join(tmpdir(), "itsybitsy-all-2-"));
  });

  afterEach(async () => {
    await rm(tempDir1, { recursive: true, force: true });
    await rm(tempDir2, { recursive: true, force: true });
  });

  test("reads across multiple repos", async () => {
    // Create agent in repo 1
    const dir1 = join(tempDir1, ".ittybitty", "agents", "agent-r1");
    await mkdir(dir1, { recursive: true });
    await Bun.write(join(dir1, "meta.json"), JSON.stringify({
      id: "agent-r1", session_id: "s1", tmux_session: "t1",
      prompt: "p1", manager: null, created: "2026-03-05", created_epoch: Date.now() / 1000,
      worktree: true, worker: false, model: "sonnet", claude_pid: "1",
    }));

    // Create agent in repo 2
    const dir2 = join(tempDir2, ".ittybitty", "agents", "agent-r2");
    await mkdir(dir2, { recursive: true });
    await Bun.write(join(dir2, "meta.json"), JSON.stringify({
      id: "agent-r2", session_id: "s2", tmux_session: "t2",
      prompt: "p2", manager: null, created: "2026-03-05", created_epoch: Date.now() / 1000,
      worktree: true, worker: false, model: "opus", claude_pid: "2",
    }));

    const { agents, errors } = await readAllAgents([
      { path: tempDir1, name: "repo1" },
      { path: tempDir2, name: "repo2" },
    ], false);
    expect(errors.length).toBe(0);
    expect(agents.length).toBe(2);
    expect(agents.map((a) => a.repoName).sort()).toEqual(["repo1", "repo2"]);
  });

  test("returns orphanedTmuxSessions field (empty when no stale sessions)", async () => {
    const { orphanedTmuxSessions } = await readAllAgents([
      { path: tempDir1, name: "repo1" },
    ], false);
    // orphanedTmuxSessions should be an array (may be empty depending on system state)
    expect(Array.isArray(orphanedTmuxSessions)).toBe(true);
  });

  test("includeArchived flag controls whether archived agents are returned", async () => {
    // repo1: one active agent
    const active = join(tempDir1, ".ittybitty", "agents", "agent-active");
    await mkdir(active, { recursive: true });
    await Bun.write(join(active, "meta.json"), JSON.stringify({
      id: "agent-active", session_id: "s1", tmux_session: "t1",
      prompt: "p1", manager: null, created: "2026-03-05",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true, worker: false, model: "sonnet", claude_pid: "1",
    }));

    // repo2: one archived agent (and an empty agents/ dir)
    const archived = join(tempDir2, ".ittybitty", "archive", "agent-old");
    await mkdir(archived, { recursive: true });
    await mkdir(join(tempDir2, ".ittybitty", "agents"), { recursive: true });
    await Bun.write(join(archived, "meta.json"), JSON.stringify({
      id: "agent-old", session_id: "s2", tmux_session: "t2",
      prompt: "p2", manager: null, created: "2026-03-04",
      created_epoch: Math.floor(Date.now() / 1000) - 86400,
      worktree: true, worker: true, model: "opus", claude_pid: "2",
    }));

    const repos = [
      { path: tempDir1, name: "repo1" },
      { path: tempDir2, name: "repo2" },
    ];

    // false → only the active agent
    const excluded = await readAllAgents(repos, false);
    expect(excluded.agents.map((a) => a.id).sort()).toEqual(["agent-active"]);
    expect(excluded.agents.some((a) => a.archived)).toBe(false);

    // explicit true → both
    const includedExplicit = await readAllAgents(repos, true);
    expect(includedExplicit.agents.map((a) => a.id).sort()).toEqual(["agent-active", "agent-old"]);
  });
});

describe("isRecentlyCreated", () => {
  test("returns true for agent created less than 6 seconds ago", () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(isRecentlyCreated(nowEpoch)).toBe(true);
    expect(isRecentlyCreated(nowEpoch - 2)).toBe(true);
    expect(isRecentlyCreated(nowEpoch - 5)).toBe(true);
  });

  test("returns false for agent created more than 6 seconds ago", () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(isRecentlyCreated(nowEpoch - 7)).toBe(false);
    expect(isRecentlyCreated(nowEpoch - 60)).toBe(false);
    expect(isRecentlyCreated(nowEpoch - 3600)).toBe(false);
  });

  test("returns false at exactly 6 seconds (boundary)", () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(isRecentlyCreated(nowEpoch - 6)).toBe(false);
  });

  test("returns false for zero epoch", () => {
    expect(isRecentlyCreated(0)).toBe(false);
  });

  test("returns false for undefined/NaN epoch", () => {
    expect(isRecentlyCreated(NaN)).toBe(false);
    expect(isRecentlyCreated(undefined as unknown as number)).toBe(false);
  });
});

describe("writeAgentState / readAgentState", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agents-state-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("writes state and reads it back", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent", prompt: "hello" }));

    await writeAgentState(tempDir, "waiting");
    const state = await readAgentState(tempDir);
    expect(state).toBe("waiting");
  });

  test("writes state_updated_at alongside state", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent" }));

    const before = Math.floor(Date.now() / 1000);
    await writeAgentState(tempDir, "complete");
    const after = Math.floor(Date.now() / 1000);

    const data = await Bun.file(metaPath).json();
    expect(data.state).toBe("complete");
    expect(data.state_updated_at).toBeGreaterThanOrEqual(before);
    expect(data.state_updated_at).toBeLessThanOrEqual(after);
  });

  test("preserves existing meta.json fields", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent", prompt: "do stuff", model: "opus" }));

    await writeAgentState(tempDir, "running");
    const data = await Bun.file(metaPath).json();
    expect(data.id).toBe("test-agent");
    expect(data.prompt).toBe("do stuff");
    expect(data.model).toBe("opus");
    expect(data.state).toBe("running");
  });

  test("no-op if meta.json doesn't exist", async () => {
    // Should not throw
    await writeAgentState(tempDir, "running");
    const state = await readAgentState(tempDir);
    expect(state).toBeUndefined();
  });

  test("readAgentState returns undefined if state field is absent", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent" }));
    const state = await readAgentState(tempDir);
    expect(state).toBeUndefined();
  });

  test("overwrites previous state", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "test-agent", state: "waiting" }));

    await writeAgentState(tempDir, "complete");
    const state = await readAgentState(tempDir);
    expect(state).toBe("complete");
  });
});

describe("mutateAgentMeta — concurrent RMW (codex SessionStart vs PreToolUse race)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agents-meta-mutate-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("two concurrent writers both land — writeAgentState + captureCodexSessionId equivalent", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-x", model: "codex:gpt-5.4-mini" }));

    // Race the equivalent of: SessionStart writes state=running,
    // PreToolUse writes codex_session_id. Both must land.
    await Promise.all([
      writeAgentState(tempDir, "running"),
      mutateAgentMeta(tempDir, (m) => { m.codex_session_id = "rollout-aaa"; }),
    ]);

    const meta = await Bun.file(metaPath).json();
    expect(meta.id).toBe("agent-x");
    expect(meta.state).toBe("running");
    expect(meta.codex_session_id).toBe("rollout-aaa");
  });

  test("ten concurrent counter-bumps all land (lock is correct, not just lucky)", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-y", counter: 0 }));

    const N = 10;
    await Promise.all(
      Array.from({ length: N }, () =>
        mutateAgentMeta(tempDir, (m) => { m.counter = ((m.counter as number) ?? 0) + 1; }),
      ),
    );

    const meta = await Bun.file(metaPath).json();
    expect(meta.counter).toBe(N);
  });

  test("mutator returning null is a no-op (idempotent capture)", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-z", codex_session_id: "original" }));

    const wrote = await mutateAgentMeta(tempDir, (m) => {
      if (m.codex_session_id) return null;
      m.codex_session_id = "newer";
    });

    expect(wrote).toBe(false);
    const meta = await Bun.file(metaPath).json();
    expect(meta.codex_session_id).toBe("original");
  });

  test("returns false when meta.json is missing (best-effort)", async () => {
    const wrote = await mutateAgentMeta(tempDir, (m) => { m.foo = "bar"; });
    expect(wrote).toBe(false);
  });

  test("uses a unique tmp suffix — concurrent writes don't clobber each other's tmp files", async () => {
    // Regression guard for HIGH 2: writeAgentState used to write to
    // metaPath + ".tmp" unconditionally, which two concurrent writers would
    // clobber. The new code uses metaPath + ".tmp.<pid>.<uuid>". This test
    // ensures no stray .tmp file is left behind after a successful write
    // and no shared-suffix collision could happen.
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-tmp" }));

    await Promise.all([
      writeAgentState(tempDir, "running"),
      mutateAgentMeta(tempDir, (m) => { m.codex_session_id = "rollout-tmp"; }),
      mutateAgentMeta(tempDir, (m) => { m.tag = "x"; }),
    ]);

    const { readdir } = await import("fs/promises");
    const files = await readdir(tempDir);
    const stray = files.filter((f) => f.startsWith("meta.json.tmp"));
    expect(stray).toEqual([]);
    const finalMeta = await Bun.file(metaPath).json();
    expect(finalMeta.state).toBe("running");
    expect(finalMeta.codex_session_id).toBe("rollout-tmp");
    expect(finalMeta.tag).toBe("x");
  });

  // HIGH 2 from Phase 4 review: simulate the race the new `ib write-pid`
  // subcommand prevents. The inline `bun -e readFileSync...writeFileSync`
  // in the OLD start.sh had a read-then-write window the codex SessionStart
  // hook could fall inside, losing codex_session_id. Replacing the inline
  // write with `ib write-pid` (which routes through mutateAgentMeta) closes
  // the race. This test asserts the equivalent mutator pattern is safe.
  test("HIGH 2: concurrent claude_pid write + codex_session_id write both land", async () => {
    const metaPath = join(tempDir, "meta.json");
    await Bun.write(metaPath, JSON.stringify({ id: "agent-codex01", model: "codex:gpt-5.4-mini" }));

    // Race the equivalent of: start.sh writing claude_pid via
    // `ib write-pid`, and codex SessionStart writing codex_session_id.
    // Both must land in the final file — neither is lost.
    await Promise.all([
      mutateAgentMeta(tempDir, (m) => { m.claude_pid = "12345"; }),
      mutateAgentMeta(tempDir, (m) => { m.codex_session_id = "rollout-bbb"; }),
    ]);

    const meta = await Bun.file(metaPath).json();
    expect(meta.id).toBe("agent-codex01");
    expect(meta.claude_pid).toBe("12345");
    expect(meta.codex_session_id).toBe("rollout-bbb");
  });
});

describe("isCompacting", () => {
  test("detects compacting in last 5 lines", () => {
    const output = "line1\nline2\nline3\nCompacting conversation\nline5";
    expect(isCompacting(output)).toBe(true);
  });

  test("does not detect compacting beyond the compacting window", () => {
    // The window is 10 (sized to clear the TUI chrome below a current banner).
    // Put the banner at the top of a 12-line buffer → 12th-from-last → out of range.
    const lines = Array.from({ length: 12 }, (_, i) => `line${i}`);
    lines[0] = "Compacting conversation";
    expect(isCompacting(lines.join("\n"))).toBe(false);
  });

  test("strips ANSI before checking", () => {
    const output = "line1\nline2\nline3\n\x1b[32mCompacting conversation\x1b[0m\nline5";
    expect(isCompacting(output)).toBe(true);
  });
});

describe("isRateLimited", () => {
  test("detects rate_limit_error", () => {
    const lines = Array.from({ length: 14 }, (_, i) => `line${i}`);
    lines.push("rate_limit_error");
    expect(isRateLimited(lines.join("\n"))).toBe(true);
  });

  test("detects usage limit reached (case insensitive)", () => {
    const output = "line1\nline2\nUsage Limit Reached\nline4";
    expect(isRateLimited(output)).toBe(true);
  });

  test("detects hit your limit", () => {
    const output = "line1\nhit your limit\nline3";
    expect(isRateLimited(output)).toBe(true);
  });

  test("detects codex out-of-usage (real captured sample, wrapped across two lines)", () => {
    // Real codex out-of-usage message — wraps in the terminal so the ■ glyph +
    // "You've hit your usage limit" sit on line 1 and "try again at …" on line 2.
    // The status bar still shows "5h 0% left" etc, so the message text is the
    // only reliable signal.
    const output = [
      "› Improve documentation in @filename",
      "",
      "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit",
      "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:29 AM.",
      "",
      "  gpt-5.5 high · Context 88% left · 5h 0% left · weekly 78% left",
    ].join("\n");
    expect(isRateLimited(output)).toBe(true);
  });

  test("codex out-of-usage — apostrophe-agnostic (curly ’ still matches)", () => {
    // Anchor drops the apostrophe-bearing word ("you've") so a straight vs. curly
    // apostrophe rendering can't break detection.
    const output = "■ You’ve hit your usage limit. try again at 4:29 AM.";
    expect(isRateLimited(output)).toBe(true);
  });

  test("codex out-of-usage — Plus tier variant (cross-tier stem)", () => {
    // A different plan tier renders a different upsell ("Upgrade to Plus", no
    // "purchase more credits") but keeps the stem "hit your usage limit". Locks
    // in that the anchor is the stable cross-tier stem, not over-fit to the Pro
    // wording of the original sample. (This variant lives in the repo fixtures:
    // src/fixtures/codex-snapshot-input-fail-*.txt.)
    const output = "■ You've hit your usage limit. Upgrade to Plus to continue using Codex\n(https://chatgpt.com/explore/plus), or try again at Jun 6th, 2026 6:01 PM.";
    expect(isRateLimited(output)).toBe(true);
  });

  test("returns false when no rate limit patterns", () => {
    const output = "line1\nline2\nline3";
    expect(isRateLimited(output)).toBe(false);
  });

  test("does NOT match server-side transient throttle (routed to api_error instead)", () => {
    // "API Error: Server is temporarily limiting requests (not your usage limit)"
    // is a transient server throttle, NOT a usage-limit exhaustion. It must be
    // handled by isApiError's "please retry" backoff, not the usage-limit path.
    const output = "  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(isRateLimited(output)).toBe(false);
  });
});

describe("isApiError", () => {
  test("detects Stream idle timeout (real example)", () => {
    const output = "line1\nline2\n  ⎿  API Error: Stream idle timeout - partial response received\nline4";
    expect(isApiError(output)).toBe(true);
  });

  test("detects 500 status code", () => {
    const output = "  ⎿  API Error: 500 Internal Server Error";
    expect(isApiError(output)).toBe(true);
  });

  test("detects 502 status code", () => {
    const output = "  ⎿  API Error: 502 Bad Gateway";
    expect(isApiError(output)).toBe(true);
  });

  test("detects 503 status code", () => {
    const output = "  ⎿  API Error: 503 Service Unavailable";
    expect(isApiError(output)).toBe(true);
  });

  test("detects Connection error", () => {
    const output = "  ⎿  API Error: Connection error";
    expect(isApiError(output)).toBe(true);
  });

  test("detects fetch failed", () => {
    const output = "  ⎿  API Error: fetch failed";
    expect(isApiError(output)).toBe(true);
  });

  test("detects Request was aborted", () => {
    const output = "  ⎿  API Error: Request was aborted";
    expect(isApiError(output)).toBe(true);
  });

  test("detects ETIMEDOUT", () => {
    const output = "  ⎿  API Error: ETIMEDOUT";
    expect(isApiError(output)).toBe(true);
  });

  test("detects ECONNRESET", () => {
    const output = "  ⎿  API Error: ECONNRESET";
    expect(isApiError(output)).toBe(true);
  });

  test("detects socket connection closed unexpectedly", () => {
    const output = "  ⎿  API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
    expect(isApiError(output)).toBe(true);
  });

  test("detects server-side transient throttle (not usage limit)", () => {
    const output = "  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(isApiError(output)).toBe(true);
  });

  test("strips ANSI before checking", () => {
    const output = "line1\n\x1b[31m  ⎿  API Error: Stream idle timeout\x1b[0m\nline3";
    expect(isApiError(output)).toBe(true);
  });

  test("returns false on plain text without API Error marker", () => {
    const output = "line1\nline2\nrunning some task\nline4";
    expect(isApiError(output)).toBe(false);
  });

  test("returns false when 'API Error' lacks ⎿ marker (avoids quoting false-positive)", () => {
    // Watchdog nudge that quotes the phrase shouldn't re-fire detection.
    const output = "[watchdog] previous tick observed an API Error: Stream idle timeout — see log";
    expect(isApiError(output)).toBe(false);
  });

  test("returns false when API Error marker present but no recovery-eligible variant matches", () => {
    // Conservative — unknown shapes should NOT match so we don't loop on
    // things we don't know how to recover from.
    const output = "  ⎿  API Error: invalid_request_error - prompt too long";
    expect(isApiError(output)).toBe(false);
  });

  test("only inspects last 15 lines", () => {
    // API Error far above the window — should NOT be detected.
    const oldLines = Array.from({ length: 20 }, () => "filler");
    const output = ["  ⎿  API Error: Stream idle timeout", ...oldLines].join("\n");
    expect(isApiError(output)).toBe(false);
  });

  test("detects retry-countdown line after API Error scrolls out", () => {
    // Real-world capture: original ⎿ API Error line has scrolled out of the
    // last-15 window; only the watchdog nudge + retry countdown remain.
    const output = [
      "❯ [sent by watchdog]: please retry",
      "  ⎿  Retrying in 35s · attempt 9/10",
    ].join("\n");
    expect(isApiError(output)).toBe(true);
  });

  test("detects retry-countdown with single-digit attempt", () => {
    const output = "  ⎿  Retrying in 5s · attempt 1/10";
    expect(isApiError(output)).toBe(true);
  });

  test("returns false on empty input", () => {
    expect(isApiError("")).toBe(false);
  });

  test('detects "Connection closed mid-response" with ⏺ prefix (response message)', () => {
    const output = "⏺ API Error: Connection closed mid-response. The response above may be incomplete.";
    expect(isApiError(output)).toBe(true);
  });

  test('detects "Connection closed mid-response" with ⎿ prefix (defensive)', () => {
    // Defensive in case Claude ever renders this variant as a tool-result.
    const output = "  ⎿  API Error: Connection closed mid-response. The response above may be incomplete.";
    expect(isApiError(output)).toBe(true);
  });

  test('still rejects quoted "API Error" with neither ⏺ nor ⎿ marker', () => {
    // Preserve the false-positive guard: a watchdog nudge that quotes the
    // phrase without a real Claude-rendered prefix must not retrigger detection.
    const output = "[watchdog] previous tick observed an API Error: Connection closed mid-response — see log";
    expect(isApiError(output)).toBe(false);
  });

  test("strips ANSI before checking (⏺ variant)", () => {
    const output = "line1\n\x1b[31m⏺ API Error: Connection closed mid-response. The response above may be incomplete.\x1b[0m\nline3";
    expect(isApiError(output)).toBe(true);
  });
});

describe("isApiErrorRateLimited", () => {
  test("detects the server-side rate-limit variant", () => {
    const output = "  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(isApiErrorRateLimited(output)).toBe(true);
  });

  test("returns false for Stream idle timeout (non-rate-limited variant)", () => {
    const output = "  ⎿  API Error: Stream idle timeout - partial response received";
    expect(isApiErrorRateLimited(output)).toBe(false);
  });

  test("returns false for 5xx api_error variants", () => {
    expect(isApiErrorRateLimited("  ⎿  API Error: 500 Internal Server Error")).toBe(false);
    expect(isApiErrorRateLimited("  ⎿  API Error: 502 Bad Gateway")).toBe(false);
    expect(isApiErrorRateLimited("  ⎿  API Error: 503 Service Unavailable")).toBe(false);
  });

  test("returns false for plain text without API Error marker", () => {
    const output = "running some task — temporarily limiting requests is just a string here";
    expect(isApiErrorRateLimited(output)).toBe(false);
  });

  test("returns false when 'API Error' lacks ⎿ marker (avoids quoting false-positive)", () => {
    // A watchdog nudge quoting the phrase should not retrigger detection.
    const output = "[watchdog] previous tick saw API Error: Server is temporarily limiting requests — see log";
    expect(isApiErrorRateLimited(output)).toBe(false);
  });

  test("returns false on empty input", () => {
    expect(isApiErrorRateLimited("")).toBe(false);
  });

  test("strips ANSI before checking", () => {
    const output = "\x1b[31m  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited\x1b[0m";
    expect(isApiErrorRateLimited(output)).toBe(true);
  });

  test("returns false for ⏺-prefixed 'Connection closed mid-response' (intentional ⎿-only divergence from isApiError)", () => {
    // isApiError accepts both ⎿ and ⏺ markers, but isApiErrorRateLimited stays
    // ⎿-only because the "temporarily limiting requests" variant has never been
    // observed with ⏺. Lock in that divergence so a future reader doesn't
    // "fix" the inconsistency without evidence.
    const output = "⏺ API Error: Connection closed mid-response. The response above may be incomplete.";
    expect(isApiErrorRateLimited(output)).toBe(false);
  });
});

describe("isApiTerms", () => {
  test("detects Usage Policy violation message", () => {
    const output = [
      "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
      "(https://www.anthropic.com/legal/aup). Please double press esc to edit your last message or start a new",
      "session for Claude Code to assist with a different task.",
    ].join("\n");
    expect(isApiTerms(output)).toBe(true);
  });

  test("detects the message even when only the aup URL is present", () => {
    const output = [
      "API Error: Claude Code is unable to respond to this request",
      "see https://www.anthropic.com/legal/aup for details",
    ].join("\n");
    expect(isApiTerms(output)).toBe(true);
  });

  test("returns false for plain api_error (no Usage Policy phrase)", () => {
    const output = "  ⎿  API Error: Stream idle timeout - partial response received";
    expect(isApiTerms(output)).toBe(false);
  });

  test("returns false for the rate-limit variant", () => {
    const output = "  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";
    expect(isApiTerms(output)).toBe(false);
  });

  test("returns false when 'Usage Policy' appears without 'unable to respond' phrase", () => {
    const output = "[watchdog] earlier we discussed our Usage Policy in passing";
    expect(isApiTerms(output)).toBe(false);
  });

  test("only inspects last 15 lines", () => {
    const oldLines = Array.from({ length: 20 }, () => "filler");
    const output = [
      "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
      ...oldLines,
    ].join("\n");
    expect(isApiTerms(output)).toBe(false);
  });

  test("returns false on empty input", () => {
    expect(isApiTerms("")).toBe(false);
  });

  test("strips ANSI before checking", () => {
    const output = "\x1b[31mAPI Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy\x1b[0m";
    expect(isApiTerms(output)).toBe(true);
  });
});

describe("isApiSafeguard", () => {
  // The exact banner Claude Code renders when a model's input-safety classifier
  // flags a message — captured verbatim from a real retired Fable 5 agent.
  const SAFEGUARD_BANNER = [
    "⏺ API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.",
    "",
    "  Double press esc to edit your last message, or try a different model with /model.",
    "",
    "  Send feedback with /feedback or learn more: https://support.claude.com/en/articles/15363606",
    "",
    "  Request ID: req_011CdvREyTYsVU79o9958tFR",
  ];
  // Realistic idle TUI chrome that renders BELOW the banner (interior blank
  // separator + input box + 3 status-bar lines), plus tmux -E - blank padding —
  // same shape as the F1 follow-up fixtures above.
  const chrome = [
    "",
    "────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────",
    "  repo | Model: Fable 5",
    "  agent/agent-ac7b5633",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
  ];
  const trailingBlanks = ["", "", ""];
  /** The verbatim banner wrapped in a realistic tmux tail. */
  const safeguardTail = [...SAFEGUARD_BANNER, ...chrome, ...trailingBlanks].join("\n");

  test("detects the exact model-safeguard banner behind the TUI chrome", () => {
    expect(isApiSafeguard(safeguardTail)).toBe(true);
  });

  test("is model-agnostic — matches a different model's safeguard banner", () => {
    // Future models render "<OtherModel>'s safeguards flagged this message"; the
    // detector anchors on the stable phrase, not the model name.
    const output = [
      "⏺ API Error: Sonnet 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). Claude Code can't respond to this message with Sonnet 5.",
    ].join("\n");
    expect(isApiSafeguard(output)).toBe(true);
  });

  test("matches on 'usage policy' wording without the aup URL", () => {
    const output = "⏺ API Error: Fable 5's safeguards flagged this message; see our Usage Policy for details.";
    expect(isApiSafeguard(output)).toBe(true);
  });

  test("returns false for a genuine api_terms Usage-Policy refusal", () => {
    const output = [
      "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
      "(https://www.anthropic.com/legal/aup).",
    ].join("\n");
    expect(isApiSafeguard(output)).toBe(false);
  });

  test("returns false for a plain api_error banner", () => {
    expect(isApiSafeguard("  ⎿  API Error: Stream idle timeout - partial response received")).toBe(false);
  });

  test("returns false when the phrase is quoted without an API Error line", () => {
    // Ordinary output can mention the phrase (e.g. a reviewer discussing this
    // very feature); without an "API Error:" line it must NOT match.
    const output = "the reviewer noted 'safeguards flagged this message' is documented at /legal/aup";
    expect(isApiSafeguard(output)).toBe(false);
  });

  test("returns false when the safeguard phrase lacks an AUP reference", () => {
    // Marker + phrase on the same line (passes the primary anchor), but no
    // /legal/aup or "usage policy" → the secondary AUP check rejects it.
    const output = "⏺ API Error: Some model's safeguards flagged this message and nothing else";
    expect(isApiSafeguard(output)).toBe(false);
  });

  test("only inspects last 15 lines", () => {
    const oldLines = Array.from({ length: 20 }, () => "filler");
    const output = [...SAFEGUARD_BANNER, ...oldLines].join("\n");
    expect(isApiSafeguard(output)).toBe(false);
  });

  test("returns false on empty input", () => {
    expect(isApiSafeguard("")).toBe(false);
  });

  test("strips ANSI before checking", () => {
    const output = "\x1b[31m⏺ API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). Claude Code can't respond to this message with Fable 5.\x1b[0m";
    expect(isApiSafeguard(output)).toBe(true);
  });

  // Cross-checks — this is the bug the state fixes: the safeguard banner is
  // caught by NEITHER isApiError NOR isApiTerms, and adding api_safeguard must
  // not regress api_terms detection for its own banner.
  test("cross-check: the safeguard banner is NOT isApiError and NOT isApiTerms", () => {
    expect(isApiError(safeguardTail)).toBe(false);
    expect(isApiTerms(safeguardTail)).toBe(false);
  });

  test("cross-check: a genuine api_terms banner is still isApiTerms and NOT isApiSafeguard", () => {
    const terms = [
      "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy",
      "(https://www.anthropic.com/legal/aup).",
    ].join("\n");
    expect(isApiTerms(terms)).toBe(true);
    expect(isApiSafeguard(terms)).toBe(false);
  });

  // REGRESSION (review round 2): a RECOVERABLE api_error must NOT be misread as
  // terminal api_safeguard just because a QUOTED safeguard phrase (it now lives
  // in our SPEC/tests/docs) and an /legal/aup URL sit elsewhere in the window on
  // OTHER lines. The old detector matched its three tokens independently and
  // returned true here; the same-line anchor returns false. Because
  // api_safeguard is checked before api_error, the old bug would have made a
  // recoverable error never retry.
  const recoverableWithQuotedPhraseAndAup = [
    ...Array.from({ length: 8 }, (_, i) => `earlier conversation line ${i}`),
    "  ⎿  API Error: Stream idle timeout - partial response received",
    "The reviewer discussed how a model's safeguards flagged this message in some safe conversations.",
    "See the policy at https://www.anthropic.com/legal/aup for details.",
    "",
    "────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────",
    "  repo | Model: Sonnet 4.6",
    "  agent/agent-a1",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
    "", "", "",
  ].join("\n");

  test("REGRESSION: split-line api_error + quoted phrase + aup URL is NOT api_safeguard", () => {
    expect(isApiSafeguard(recoverableWithQuotedPhraseAndAup)).toBe(false);
    // It is a genuine recoverable api_error and must classify as such.
    expect(isApiError(recoverableWithQuotedPhraseAndAup)).toBe(true);
    expect(isApiTerms(recoverableWithQuotedPhraseAndAup)).toBe(false);
  });
});

describe("hasBackgroundTasks", () => {
  test("detects background task pattern", () => {
    const output = "line1\n⏵⏵ tasks · 3 running\nline3";
    expect(hasBackgroundTasks(output)).toBe(true);
  });

  test("returns false without pattern", () => {
    const output = "line1\nline2\nline3";
    expect(hasBackgroundTasks(output)).toBe(false);
  });

  test("strips ANSI before checking", () => {
    const output = "line1\n\x1b[33m⏵⏵ tasks · 2 running\x1b[0m\nline3";
    expect(hasBackgroundTasks(output)).toBe(true);
  });
});

describe("isDeadPane", () => {
  test("matches the literal 'Pane is dead' banner", () => {
    expect(isDeadPane("Pane is dead (status 0, ...)\n")).toBe(true);
  });
  test("matches when banner is on its own line in a longer pane snapshot", () => {
    const output = [
      "$ tmux capture-pane",
      "Pane is dead (status 143, signal SIGTERM)",
      "",
    ].join("\n");
    expect(isDeadPane(output)).toBe(true);
  });
  test("returns false for normal Claude output", () => {
    expect(isDeadPane("⏵⏵ accept edits on (shift+tab to cycle)")).toBe(false);
  });
  test("returns false for empty input", () => {
    expect(isDeadPane("")).toBe(false);
  });
});

// ── is* detectors on tmux -J logical-line captures ──────────────────────────
// captureTmuxOutput now passes -J, so these detectors receive UNWRAPPED logical
// lines. A banner that used to soft-wrap across several physical rows is now one
// long line; the last-N-line windows therefore measure real content. These
// tests feed realistic -J-shaped (wide, single-line) markers.
describe("is* detectors on -J logical-line captures", () => {
  test("isRateLimited detects a wide single-line usage-limit banner", () => {
    const lines = Array.from({ length: 12 }, () =>
      "prior agent output that would have wrapped in a physical capture but is one logical line under -J ".repeat(2),
    );
    lines.push(
      "You've hit your limit for the 5-hour window; your limit will reset at 3pm — run /upgrade to increase your usage limit if you need to keep going",
    );
    expect(isRateLimited(lines.join("\n"))).toBe(true);
  });

  test("isApiError detects a wide single-line API Error banner", () => {
    const lines = Array.from({ length: 12 }, () => "narration ".repeat(20));
    lines.push(
      "  ⎿  API Error: Stream idle timeout - partial response received after a very long wait; the connection was closed mid-response and the request will be retried",
    );
    expect(isApiError(lines.join("\n"))).toBe(true);
  });

  test("isApiTerms detects a wide single-line usage-policy refusal", () => {
    const lines = Array.from({ length: 10 }, () => "narration ".repeat(15));
    lines.push(
      "API Error: Claude Code is unable to respond to this request because it appears to violate Anthropic's Usage Policy; see https://www.anthropic.com/legal/aup for details",
    );
    expect(isApiTerms(lines.join("\n"))).toBe(true);
  });

  test("isApiSafeguard detects a wide single-line model-safeguard refusal", () => {
    const lines = Array.from({ length: 10 }, () => "narration ".repeat(15));
    lines.push(
      "⏺ API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.",
    );
    expect(isApiSafeguard(lines.join("\n"))).toBe(true);
  });

  test("isCompacting requires the marker within the last 10 logical lines (F1 window, chrome-sized)", () => {
    // F1 tightened the compacting window from the historical 5; the follow-up
    // fix re-sized it to 10 so it clears the input-box + status-bar chrome below
    // a CURRENT banner (7 non-blank lines) while still aging out a finished
    // banner sooner than the old 15. A marker 11+ logical lines back is out of
    // range; within 10 it matches.
    const recent = [
      "Compacting conversation ".repeat(6),
      ...Array.from({ length: 10 }, (_, i) => `later output line ${i} follows the compaction banner`),
    ];
    // Compacting is the 11th-from-last line → out of the last-10 window.
    expect(isCompacting(recent.join("\n"))).toBe(false);

    // Boundary: a marker exactly 11 logical lines back is OUT under window=10.
    const justOutside = [
      "Compacting conversation on a wide logical line under -J",
      ...Array.from({ length: 10 }, (_, i) => `line ${i}`),
    ];
    expect(isCompacting(justOutside.join("\n"))).toBe(false);

    // But when it is within the last 10, it matches on a wide logical line.
    const recent2 = [
      "line a",
      "line b",
      "Compacting conversation across a very large context window that under -J stays on one logical line",
      ...Array.from({ length: 7 }, (_, i) => `line ${i}`),
    ];
    // Compacting is the 8th-from-last line → inside the last-10 window.
    expect(isCompacting(recent2.join("\n"))).toBe(true);
  });

  test("hasBackgroundTasks detects the status bar on a wide logical status line", () => {
    const lines = Array.from({ length: 12 }, () => "output ".repeat(20));
    lines.push(
      "⏵⏵ accept edits on (shift+tab to cycle) · 3 background tasks running in the current session right now",
    );
    expect(hasBackgroundTasks(lines.join("\n"))).toBe(true);
  });

  // ── F1: recovered-agent (false-positive) direction ──────────────────────
  // The failure F1 identified: under -J one logical line carries more content,
  // so a finished banner lingered in the old wide windows and could re-classify
  // (and, for rate_limited, re-nudge) an agent that has already resumed working.
  // After the F1 tightening the banner ages out of range once enough fresh
  // logical output has arrived. These tests pin the recovery direction.
  describe("F1 recovered-agent no longer re-classified once fresh output arrives", () => {
    test("rate_limited: a usage-limit banner followed by 12 fresh logical lines is NOT rate_limited", () => {
      // Banner, then 12 logical lines of ordinary work output. The banner is now
      // the 13th-from-last line → outside the 12-line rate-limit window. The
      // window widened from F1's original 8 to clear the chrome below a current
      // banner, so a recovered agent needs a few more fresh lines to age out —
      // a deliberate trade (a re-nudge is acceptable; a missed rate limit is not).
      const lines = [
        "Claude Usage Limit Reached — your limit will reset at 3pm; run /upgrade to increase your usage limit",
        ...Array.from({ length: 12 }, (_, i) => `fresh work output line ${i} produced after the agent resumed`),
      ];
      expect(isRateLimited(lines.join("\n"))).toBe(false);
    });

    test("rate_limited: a still-current banner within 12 logical lines IS rate_limited", () => {
      // 11 fresh lines only → banner is the 12th-from-last → still inside the
      // window, so a genuinely current banner is not missed.
      const lines = [
        "Claude Usage Limit Reached — your limit will reset at 3pm; run /upgrade to increase your usage limit",
        ...Array.from({ length: 11 }, (_, i) => `output line ${i}`),
      ];
      expect(isRateLimited(lines.join("\n"))).toBe(true);
    });

    test("compacting: a compaction banner followed by 10 fresh logical lines is NOT compacting", () => {
      // Banner is the 11th-from-last → outside the 10-line window.
      const lines = [
        "Compacting conversation across a large context window",
        ...Array.from({ length: 10 }, (_, i) => `fresh output line ${i} after compaction finished`),
      ];
      expect(isCompacting(lines.join("\n"))).toBe(false);
    });

    test("hasBackgroundTasks: a status bar 9 logical lines back is NOT reported", () => {
      // Under -J a stale ⏵⏵ status bar lingered in the old 15-line window; the
      // tightened 8-line window drops it once 8 fresh lines have scrolled past.
      const lines = [
        "⏵⏵ accept edits on (shift+tab to cycle) · 2 bashes",
        ...Array.from({ length: 8 }, (_, i) => `later output line ${i}`),
      ];
      expect(hasBackgroundTasks(lines.join("\n"))).toBe(false);
    });
  });

  // ── F1 follow-up: CURRENT banner behind the live TUI chrome must be caught ──
  // The false-NEGATIVE the reviewer found: `tmux capture-pane -J -E -` includes
  // the live TUI chrome (input box + status bar) PLUS trailing blank padding
  // rows. A CURRENT rate-limit / compacting banner renders ABOVE that chrome,
  // so it sits ~8 logical lines from the (blank-stripped) tail. The detectors
  // must (a) strip trailing blanks before slicing and (b) use a window wide
  // enough to clear the chrome, or a genuinely-current banner is MISSED — worse
  // than the stale re-nudge F1 set out to avoid. These pin both properties.
  describe("F1 follow-up: current banner behind TUI chrome is detected", () => {
    // Realistic chrome shape, taken from src/fixtures/snapshot-idle-prompt-*.txt:
    // an interior blank separator + input box (top border, ❯ prompt, bottom
    // border) + three status-bar lines = 7 non-blank lines below any banner.
    const chrome = [
      "", // blank separator between the banner and the input box (interior, not stripped)
      "────────────────────────────────────────────────────────────", // input box top border
      "❯ ", // input prompt (empty)
      "────────────────────────────────────────────────────────────", // input box bottom border
      "  repo | Model: Sonnet 4.6", // status bar line 1
      "  agent/agent-ac7b5633", // status bar line 2
      "  ⏵⏵ accept edits on (shift+tab to cycle)", // status bar line 3
    ];
    // tmux -E - pads the capture with blank rows below the status bar.
    const trailingBlanks = ["", "", ""];

    test("isRateLimited: a current usage-limit banner above the chrome IS detected", () => {
      const capture = [
        ...Array.from({ length: 20 }, (_, i) => `earlier conversation line ${i}`),
        "Claude Usage Limit Reached — your limit will reset at 3pm; run /upgrade to increase your usage limit",
        ...chrome,
        ...trailingBlanks,
      ].join("\n");
      // Banner sits at [-8] after trailing-blank strip; window must clear the chrome.
      expect(isRateLimited(capture)).toBe(true);
    });

    test("isRateLimited: a two-line usage-limit banner box above the chrome IS detected", () => {
      // Some renderings split the banner across a heading + a reset-detail line,
      // pushing the matched phrase up to [-9]. The window must still catch it.
      const capture = [
        ...Array.from({ length: 20 }, (_, i) => `earlier conversation line ${i}`),
        "Claude Usage Limit Reached",
        "Your limit will reset at 3pm — run /upgrade to increase your usage limit if you need to keep going",
        ...chrome,
        ...trailingBlanks,
      ].join("\n");
      expect(isRateLimited(capture)).toBe(true);
    });

    test("isCompacting: a current compaction banner above the chrome IS detected", () => {
      const capture = [
        ...Array.from({ length: 20 }, (_, i) => `earlier conversation line ${i}`),
        "Compacting conversation",
        ...chrome,
        ...trailingBlanks,
      ].join("\n");
      // Banner at [-8] after the blank strip → inside the 10-line window.
      expect(isCompacting(capture)).toBe(true);
    });

    test("hasBackgroundTasks: a current ⏵⏵ status line survives trailing blank padding", () => {
      // The ⏵⏵ marker is IN the status bar at the very tail; trailing blank
      // padding below it must be stripped so the status bar returns to [-1].
      const capture = [
        ...Array.from({ length: 20 }, (_, i) => `earlier line ${i}`),
        "────────────────────────────────────────────────────────────",
        "❯ ",
        "────────────────────────────────────────────────────────────",
        "  repo | Model: Sonnet 4.6",
        "  agent/agent-ac7b5633",
        "  ⏵⏵ accept edits on (shift+tab to cycle) · 2 bashes running",
        ...trailingBlanks,
      ].join("\n");
      expect(hasBackgroundTasks(capture)).toBe(true);
    });

    // Strongest form: splice a current banner into the REAL idle fixture's chrome.
    test("isRateLimited/isCompacting: current banner spliced into the real idle fixture IS detected", async () => {
      const fixture = await Bun.file(new URL("fixtures/snapshot-idle-prompt-1.txt", import.meta.url)).text();
      const fixtureLines = fixture.split("\n");

      // Locate the input-box top border just above the bare "❯ " prompt near the tail.
      let boxTopIdx = -1;
      for (let i = fixtureLines.length - 1; i >= 0; i--) {
        const s = stripAnsi(fixtureLines[i] ?? "").trim();
        if (/^─+$/.test(s) && stripAnsi(fixtureLines[i + 1] ?? "").trim() === "❯") {
          boxTopIdx = i;
          break;
        }
      }
      expect(boxTopIdx).toBeGreaterThan(0); // sanity: found the chrome

      const spliceBanner = (banner: string): string => {
        const copy = [...fixtureLines];
        // Insert the banner + a blank separator just above the input-box chrome,
        // exactly where a live capture would render a current banner.
        copy.splice(boxTopIdx, 0, banner, "");
        return copy.join("\n");
      };

      expect(
        isRateLimited(
          spliceBanner("Claude Usage Limit Reached — your limit will reset at 3pm; run /upgrade to increase your usage limit"),
        ),
      ).toBe(true);
      expect(isCompacting(spliceBanner("Compacting conversation"))).toBe(true);
    });

    // Sanity: the unmodified idle fixture (no banner) must NOT trip either detector.
    test("isRateLimited/isCompacting: the plain idle fixture is NOT a false positive", async () => {
      const fixture = await Bun.file(new URL("fixtures/snapshot-idle-prompt-1.txt", import.meta.url)).text();
      expect(isRateLimited(fixture)).toBe(false);
      expect(isCompacting(fixture)).toBe(false);
    });
  });
});

// ── anyChildActive ─────────────────────────────────────────────────────────

describe("anyChildActive", () => {
  const oldEpoch = Math.floor(Date.now() / 1000) - 3600;

  test("returns true for child with meta.state === running", () => {
    const child = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "running", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(true);
  });

  test("returns true for recently created child (creating)", () => {
    const recent = Math.floor(Date.now() / 1000); // within grace period
    const child = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "waiting", created_epoch: recent } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(true);
  });

  test("returns false for child with meta.state === waiting (not recently created)", () => {
    const child = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "waiting", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(false);
  });

  test("returns false for child with meta.state === complete", () => {
    const child = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "complete", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(false);
  });

  test("skips archived children even when state === running", () => {
    const child = makeAgent({
      id: "c1",
      archived: true,
      meta: { manager: "p1", state: "running", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(false);
  });

  test("skips children whose manager field does not match", () => {
    const child = makeAgent({
      id: "c1",
      meta: { manager: "other-parent", state: "running", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [child])).toBe(false);
  });

  test("returns true when at least one of many children is active", () => {
    const waitingChild = makeAgent({
      id: "c1",
      meta: { manager: "p1", state: "waiting", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    const runningChild = makeAgent({
      id: "c2",
      meta: { manager: "p1", state: "running", created_epoch: oldEpoch } as Partial<AgentMeta> as AgentMeta,
    });
    expect(anyChildActive("p1", [waitingChild, runningChild])).toBe(true);
  });

  test("returns false when allAgents is empty", () => {
    expect(anyChildActive("p1", [])).toBe(false);
  });
});

// ── detectAgentStates — background-shell override ──────────────────────────

describe("detectAgentStates — waiting + background shell override", () => {
  /** Install a tmux-poller spawn runner that returns the given pane text for all capture-pane calls. */
  function installTmuxRunner(output: string | null): void {
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (isCapture && output === null) {
        return {
          stdout: new ReadableStream({
            start(c) { c.close(); },
          }),
          stderr: new ReadableStream({ start(c) { c.close(); } }),
          exited: Promise.resolve(1), // non-zero → captureTmuxOutput returns null
        };
      }
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? (output ?? "") : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    // The 'complete' fast-path now verifies claude_pid liveness — stub alive
    // so existing assertions (which use makeAgent's default claude_pid) still
    // resolve through that path.
    isPidAliveCtx.set(() => true);
    // The 'complete' fast-path also verifies the tmux session is alive —
    // stub the live-session set to include the test session name.
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
  }

  afterEach(() => {
    tmuxPollerSpawnCtx.reset();
    isPidAliveCtx.reset();
    liveTmuxSessionsCtx.reset();
  });

  test("waiting + bg shell → running", async () => {
    installTmuxRunner("⏵⏵ accept edits on · 1 shell");
    const a = makeAgent({
      id: "a1",
      meta: { state: "waiting", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("running");
  });

  test("waiting + no bg shell → waiting", async () => {
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    const a = makeAgent({
      id: "a1",
      meta: { state: "waiting", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("waiting");
  });

  test("complete + bg shell → complete (not overridden)", async () => {
    installTmuxRunner("⏵⏵ accept edits on · 1 shell");
    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("complete");
  });

  test("running + bg shell → running (unchanged)", async () => {
    installTmuxRunner("⏵⏵ accept edits on · 1 shell");
    const a = makeAgent({
      id: "a1",
      meta: { state: "running", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("running");
  });

  test("waiting + unavailable tmux capture → preserves waiting", async () => {
    installTmuxRunner(null);
    const a = makeAgent({
      id: "a1",
      meta: {
        state: "waiting",
        tmux_session: "ib-a1",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("waiting");
  });
});

// ── detectAgentStates — api_safeguard classification (fresh capture) ────────

describe("detectAgentStates — api_safeguard from fresh tmux capture", () => {
  /** Install a tmux-poller spawn runner that returns the given pane text for all capture-pane calls. */
  function installTmuxRunner(output: string): void {
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? output : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
  }

  afterEach(() => {
    tmuxPollerSpawnCtx.reset();
    isPidAliveCtx.reset();
    liveTmuxSessionsCtx.reset();
  });

  // The model-safeguard banner (verbatim) wrapped in realistic idle TUI chrome —
  // no meta.transient.json exists for this agent (default /tmp/test repoPath),
  // so detection falls through to the live-capture classifier path.
  const safeguardCapture = [
    "⏺ API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup). This sometimes happens with safe, normal conversations. Claude Code can't respond to this message with Fable 5.",
    "",
    "  Double press esc to edit your last message, or try a different model with /model.",
    "",
    "  Request ID: req_011CdvREyTYsVU79o9958tFR",
    "",
    "────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────",
    "  repo | Model: Fable 5",
    "  agent/agent-a1",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
    "", "", "",
  ].join("\n");

  test("safeguard banner → api_safeguard (terminal, before api_error)", async () => {
    installTmuxRunner(safeguardCapture);
    const a = makeAgent({
      id: "a1",
      meta: { state: "running", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("api_safeguard");
  });

  // REGRESSION (review round 2): a recoverable api_error line with a QUOTED
  // safeguard phrase + an /legal/aup URL on OTHER lines must resolve to the
  // recoverable api_error, NOT the terminal api_safeguard.
  const recoverableCapture = [
    ...Array.from({ length: 8 }, (_, i) => `earlier conversation line ${i}`),
    "  ⎿  API Error: Stream idle timeout - partial response received",
    "The reviewer discussed how a model's safeguards flagged this message in some safe conversations.",
    "See the policy at https://www.anthropic.com/legal/aup for details.",
    "",
    "────────────────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────────────────",
    "  repo | Model: Sonnet 4.6",
    "  agent/agent-a1",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
    "", "", "",
  ].join("\n");

  test("split-line api_error + quoted phrase + aup → api_error (NOT api_safeguard)", async () => {
    installTmuxRunner(recoverableCapture);
    const a = makeAgent({
      id: "a1",
      meta: { state: "running", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("api_error");
  });
});

// ── detectAgentStates — complete agent fast-path (Change A) ────────────────

describe("detectAgentStates — 'complete' agents skip capture-pane", () => {
  afterEach(() => {
    tmuxPollerSpawnCtx.reset();
    isPidAliveCtx.reset();
    liveTmuxSessionsCtx.reset();
  });

  test("complete agent with tmux session does not invoke captureTmuxOutput", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1", claude_pid: "12345" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("complete");
    expect(captureCalls).toBe(0);
  });

  test("complete agent with dead claude_pid → stopped", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1", claude_pid: "12345" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(captureCalls).toBe(0);
  });

  test("complete agent with empty claude_pid trusts meta.state (legacy)", async () => {
    let pidChecks = 0;
    isPidAliveCtx.set(() => {
      pidChecks++;
      return false;
    });
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1", claude_pid: "" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("complete");
    expect(pidChecks).toBe(0);
  });

  test("complete agent with live PID but dead tmux session → stopped", async () => {
    // Bug fix: Claude can outlive its tmux session if the tmux server is
    // killed/restarted — the process becomes orphaned, attached to a regular
    // tty. PID alone passes liveness, but the user sees no working pane.
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true);
    // tmux session list is empty — session "ib-a1" is gone
    liveTmuxSessionsCtx.set(async () => new Set([]));
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-a1",
    }));

    const a = makeAgent({
      id: "a1",
      meta: { state: "complete", tmux_session: "ib-a1", claude_pid: "12345" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(captureCalls).toBe(0);
  });

  test("capture-bound agent checks live tmux sessions once", async () => {
    let liveCalls = 0;
    liveTmuxSessionsCtx.set(async () => {
      liveCalls++;
      return new Set(["ib-a1"]);
    });
    isPidAliveCtx.set(() => true);
    tmuxPollerSpawnCtx.set(((_args: any[]) => ({
      stdout: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("⏵⏵ accept edits on")); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
    })) as any);

    const a = makeAgent({
      id: "a1",
      meta: { state: "running", tmux_session: "ib-a1", claude_pid: "12345" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(liveCalls).toBe(1);
  });

  test("complete agent with no tmux session resolves to 'stopped' (existing path)", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    const a = makeAgent({
      id: "a1",
      meta: {
        state: "complete",
        tmux_session: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(captureCalls).toBe(0);
  });

  test("running agent still invokes captureTmuxOutput (no regression)", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (isCapture) captureCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? "ordinary output\n" : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "a1",
      meta: { state: "running", tmux_session: "ib-a1" } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });
});

// ── detectAgentStates — slow worktree spawn (no tmux + spawn log) ──────────

describe("detectAgentStates — no tmux_session falls back to spawn log", () => {
  afterEach(() => {
    classifySpawnLogCtx.reset();
    nowMsCtx.reset();
  });

  test("no tmux + in_progress spawn within window → creating", async () => {
    classifySpawnLogCtx.set(async () => ({
      kind: "in_progress",
      startEpochMs: Date.now() - 30_000,
    }));
    const a = makeAgent({
      id: "a1",
      meta: {
        // Past 6s grace — without spawn log fallback, would resolve to "stopped".
        tmux_session: "",
        created_epoch: Math.floor(Date.now() / 1000) - 60,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("creating");
  });

  test("no tmux + spawn log orphan + old created_epoch → stopped", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    const a = makeAgent({
      id: "a1",
      meta: {
        tmux_session: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
  });

  test("no tmux + spawn log orphan + recent created_epoch → creating (6s grace fast path)", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    const a = makeAgent({
      id: "a1",
      meta: {
        tmux_session: "",
        // Within 6s grace — preserves existing fast path when spawn log absent.
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("creating");
  });

  test("no tmux + spawn log orphan + old created_epoch (no in-progress signal) → stopped", async () => {
    // Same as case 2 but framed as the auto-recovery scenario: spawn died
    // (5-minute window expired or terminator written), and the agent is no
    // longer recently created — should resolve to "stopped".
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    const a = makeAgent({
      id: "a1",
      meta: {
        tmux_session: "",
        created_epoch: Math.floor(Date.now() / 1000) - SPAWN_IN_PROGRESS_WINDOW_MS / 1000 - 60,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
  });
});

// ── detectAgentStates — orphan Claude PID reaping ─────────────────────────

describe("detectAgentStates — reapOrphanedClaude", () => {
  let tmpLogDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "orphan-kill-log-"));
    logPath = join(tmpLogDir, "watch.log");
    resetReapedTmuxSessions();
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
  });

  afterEach(async () => {
    classifySpawnLogCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    liveTmuxSessionsCtx.reset();
    tmuxPollerSpawnCtx.reset();
    resetReapedTmuxSessions();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  test("no tmux_session + live PID + not creating → SIGTERMs PID and logs", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toEqual([{ pid: 12345, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM sent");
    expect(log).toContain("kind=claude");
    expect(log).toContain("pid=12345");
    expect(log).toContain("agent=");
    expect(log).toContain("agent-1");
    expect(log).toContain("state=stopped");
  });

  test("no tmux_session + live PID but resolved state is 'creating' → does not kill", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        // Within 6s grace → resolves to "creating", NOT "stopped"
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("creating");
    expect(killCalls).toBe(0);
  });

  test("no tmux_session + spawn log in_progress → does not kill (creating path)", async () => {
    classifySpawnLogCtx.set(async () => ({
      kind: "in_progress",
      startEpochMs: Date.now() - 10_000,
    }));
    isPidAliveCtx.set(() => true);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 60,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("creating");
    expect(killCalls).toBe(0);
  });

  test("no tmux_session + dead PID → does not kill", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0);
  });

  test("no tmux_session + empty claude_pid → does not kill", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0);
  });

  test("unavailable fresh process identity never authorizes SIGTERM", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidIdentityCurrentCtx.reset();
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(() => null);
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });
    const a = makeAgent({
      id: "agent-identity-unknown",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(killCalls).toBe(0);
    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("pid alive but process start unavailable or changed");
  });

  test("legacy PID without a write epoch never authorizes SIGTERM", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidIdentityCurrentCtx.reset();
    isPidAliveCtx.set(() => true);
    let startTimeCalls = 0;
    processStartEpochSecondsCtx.set(() => {
      startTimeCalls++;
      return 1_700_000_000;
    });
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });
    const a = makeAgent({
      id: "agent-identity-legacy",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        claude_pid_epoch: undefined,
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(killCalls).toBe(0);
    expect(startTimeCalls).toBe(0);
  });

  test("fresh recycled PID observation never authorizes SIGTERM", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidIdentityCurrentCtx.reset();
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(
      () => 1_700_000_000 + CLAUDE_PID_START_MARGIN_SECONDS + 1,
    );
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });
    const a = makeAgent({
      id: "agent-identity-recycled",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(killCalls).toBe(0);
  });

  test("complete agent with live PID but dead tmux session → SIGTERMs and logs", async () => {
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set([])); // tmux session "ib-a1" is gone
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-a1",
    }));
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "complete",
        tmux_session: "ib-a1",
        claude_pid: "12345",
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toEqual([{ pid: 12345, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM sent");
    expect(log).toContain("pid=12345");
    expect(log).toContain("tmux=ib-a1");
    expect(log).toContain("complete agent: tmux session gone");
  });

  // ── audit-log volume ──────────────────────────────────────────────────────
  // Regression: the identity guard logged "signal skipped" whenever
  // _isPidIdentityCurrent returned false — including for a merely DEAD pid,
  // where the pre-guard code returned silently. reapOrphanedClaude runs on
  // every watcher pass for every already-stopped agent (2s pollStates plus the
  // 10s refresh) and only the kill-session is memoized, so ten stopped agents
  // produced ~300 lines/min and rotated the whole 1 MB x 3 audit trail away in
  // about 20 minutes — exactly the harm TMUX_OBSERVATION_LOG_INTERVAL_MS was
  // added to prevent, reintroduced on the PID side.
  test("repeated reaping passes over a stopped agent write no identity lines", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-quiet",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    for (let pass = 0; pass < 25; pass++) {
      await detectAgentStates([a], { reap: true });
    }

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8").catch(() => "");
    expect(log).not.toContain("[orphan-kill] signal skipped");
    expect(log.split("\n").filter((l) => l.includes("[orphan-kill]"))).toEqual([]);
  });

  test("an unverifiable but LIVE pid logs once, not once per pass", async () => {
    // The informative cases (no recorded epoch, unreadable or changed process
    // start) are worth reporting, but they hold for many passes — so they are
    // rate-limited rather than emitted per pass.
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    isPidIdentityCurrentCtx.set(() => false);
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-recycled",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    for (let pass = 0; pass < 25; pass++) {
      await detectAgentStates([a], { reap: true });
    }

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    const skipped = log.split("\n").filter((l) => l.includes("[orphan-kill] signal skipped"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("reason=pid alive but process start unavailable or changed");
  });

  test("a live pid with no recorded epoch is reported as such", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    isPidIdentityCurrentCtx.set(() => false);
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-legacy-epoch",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("reason=pid alive but no recorded pid epoch");
  });

  test("a not-live tmux session is skipped entirely (no kill-session spawn, no log)", async () => {
    // D3: a long-stopped agent whose tmux_session names a session that died
    // weeks ago must NOT pay a `tmux kill-session` spawn (nor log a redundant
    // "already gone" line) on every new `ib watch` process. When the recorded
    // session is absent from the live set detection already resolved, the husk
    // teardown is skipped outright.
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    killPidCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set()); // ib-gone is not live
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-gone",
    }));
    let killSessionSpawns = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "kill-session") killSessionSpawns++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    const a = makeAgent({
      id: "agent-gone",
      meta: {
        state: "running",
        tmux_session: "ib-gone",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("stopped");
    // No kill-session spawn and no "[orphan-kill] tmux ..." teardown line. The
    // skip logs NOTHING, so the watch log may not exist at all — that is even
    // stronger proof than an empty line set, so only assert content if present.
    expect(killSessionSpawns).toBe(0);
    const { existsSync } = await import("fs");
    if (existsSync(logPath)) {
      const { readFile } = await import("fs/promises");
      const log = await readFile(logPath, "utf8");
      expect(log).not.toContain("[orphan-kill] tmux");
    }
  });

  test("a genuine tmux teardown failure is still reported as failed", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    killPidCtx.set(() => true);
    // D3: a genuine kill-session failure only arises when the session IS live
    // (otherwise the teardown is skipped). Model a live husk whose kill-session
    // fails for a real reason (tmux server connection error, not "already gone").
    liveTmuxSessionsCtx.set(async () => new Set(["ib-broken"]));
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-broken",
    }));
    tmuxPollerSpawnCtx.set(((args: any[]) => ({
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({
        start(c) {
          if (args[1] === "kill-session") {
            c.enqueue(new TextEncoder().encode("error connecting to /tmp/tmux-501/default"));
          }
          c.close();
        },
      }),
      exited: Promise.resolve(args[1] === "kill-session" ? 1 : 0),
    })) as any);

    const a = makeAgent({
      id: "agent-broken",
      meta: {
        state: "running",
        tmux_session: "ib-broken",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] tmux kill-session failed");
  });

  test("reap aborts when lifecycle metadata changes after observation", async () => {
    reapReadAgentMetaCtx.reset();
    const repoTmp = await mkdtemp(join(tmpdir(), "reap-revalidation-"));
    const agentDir = join(repoTmp, ".ittybitty", "agents", "agent-race");
    await mkdir(agentDir, { recursive: true });

    const a = makeAgent({
      id: "agent-race",
      repoPath: repoTmp,
      meta: {
        id: "agent-race",
        state: "running",
        tmux_session: "ib-race",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    const { writeFile } = await import("fs/promises");
    await writeFile(
      join(agentDir, "meta.json"),
      JSON.stringify({ ...a.meta, claude_pid: "99999" })
    );

    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set());
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-race",
    }));
    let killPidCalls = 0;
    let killSessionCalls = 0;
    killPidCtx.set(() => {
      killPidCalls++;
      return true;
    });
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "kill-session") killSessionCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("stopped");
    expect(killPidCalls).toBe(0);
    expect(killSessionCalls).toBe(0);
    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("lifecycle metadata changed before teardown");
    await rm(repoTmp, { recursive: true, force: true });
  });

  test("reap aborts when only the PID generation changes before teardown", async () => {
    const a = makeAgent({
      id: "agent-generation",
      meta: {
        state: "running",
        tmux_session: "ib-generation",
        claude_pid: "12345",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    reapReadAgentMetaCtx.set(async () => ({
      ...a.meta,
      claude_pid_epoch: 1_700_000_001,
    }));
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set());
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-generation",
    }));
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    await detectAgentStates([a], { reap: true });

    expect(killCalls).toBe(0);
    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("lifecycle metadata changed before teardown");
  });

  test("reap aborts when only the lifecycle generation changes before teardown", async () => {
    // Same session, same PID, same PID epoch — only created_epoch moved, which
    // is how a recreated agent generation looks to an observation taken against
    // the previous one.
    const a = makeAgent({
      id: "agent-lifecycle-generation",
      meta: {
        state: "running",
        tmux_session: "ib-lifecycle-generation",
        claude_pid: "12345",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: 1_700_000_000,
      } as Partial<AgentMeta> as AgentMeta,
    });
    reapReadAgentMetaCtx.set(async () => ({
      ...a.meta,
      created_epoch: 1_700_000_500,
    }));
    isPidAliveCtx.set(() => true);
    isPidIdentityCurrentCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set());
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-lifecycle-generation",
    }));
    let killPidCalls = 0;
    let killSessionCalls = 0;
    killPidCtx.set(() => {
      killPidCalls++;
      return true;
    });
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "kill-session") killSessionCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    await detectAgentStates([a], { reap: true });

    expect(killPidCalls).toBe(0);
    expect(killSessionCalls).toBe(0);
    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("lifecycle metadata changed before teardown");
  });

  test("lifecycle operation cannot start between final validation and teardown", async () => {
    acquireAgentLifecycleLockCtx.reset();
    const repoTmp = await mkdtemp(join(tmpdir(), "reap-lock-race-"));
    const agentDir = join(repoTmp, ".ittybitty", "agents", "agent-lock-race");
    await mkdir(agentDir, { recursive: true });
    const a = makeAgent({
      id: "agent-lock-race",
      repoPath: repoTmp,
      meta: {
        id: "agent-lock-race",
        state: "running",
        tmux_session: "ib-lock-race",
        claude_pid: "12345",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    const events: string[] = [];
    let claimPromise: Promise<ReturnType<typeof claimAgentOperation> extends Promise<infer T> ? T : never> | null = null;
    reapReadAgentMetaCtx.set(async () => {
      claimPromise = claimAgentOperation(agentDir, "restarting").then((result) => {
        events.push("operation-claimed");
        return result;
      });
      await Bun.sleep(75);
      expect(events).not.toContain("operation-claimed");
      return a.meta;
    });
    isPidAliveCtx.set(() => true);
    isPidIdentityCurrentCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set());
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-lock-race",
    }));
    killPidCtx.set(() => {
      events.push("pid-signaled");
      return true;
    });
    tmuxPollerSpawnCtx.set((() => ({
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
    })) as any);

    await detectAgentStates([a], { reap: true });
    expect(claimPromise).not.toBeNull();
    expect(await claimPromise!).toEqual({ ok: true });
    expect(events.indexOf("pid-signaled")).toBeLessThan(events.indexOf("operation-claimed"));

    await rm(repoTmp, { recursive: true, force: true });
  });

  test("reap aborts when final lifecycle metadata is unavailable", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    reapReadAgentMetaCtx.set(async () => null);
    let killPidCalls = 0;
    killPidCtx.set(() => {
      killPidCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-unavailable",
      meta: {
        state: "running",
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("stopped");
    expect(killPidCalls).toBe(0);
    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("lifecycle metadata unavailable before teardown");
  });

  test("kills both Claude and watchdog when transient file exists", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    // Create a real agent dir with meta.transient.json so readAgentTransient
    // returns the watchdog_pid we expect.
    const agentTmp = await mkdtemp(join(tmpdir(), "orphan-kill-agent-"));
    const agentDir = join(agentTmp, ".ittybitty", "agents", "agent-1");
    await mkdir(agentDir, { recursive: true });
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 67890,
    };
    const { writeFile } = await import("fs/promises");
    await writeFile(join(agentDir, "meta.transient.json"), JSON.stringify(transient));

    const a = makeAgent({
      id: "agent-1",
      repoPath: agentTmp,
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // Both PIDs should be SIGTERMed
    expect(killCalls).toEqual([
      { pid: 12345, signal: "SIGTERM" },
      { pid: 67890, signal: "SIGTERM" },
    ]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("kind=claude");
    expect(log).toContain("pid=12345");
    expect(log).toContain("kind=watchdog");
    expect(log).toContain("pid=67890");

    await rm(agentTmp, { recursive: true, force: true });
  });

  test("kills only watchdog when claude_pid is empty", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    const agentTmp = await mkdtemp(join(tmpdir(), "orphan-kill-agent-"));
    const agentDir = join(agentTmp, ".ittybitty", "agents", "agent-1");
    await mkdir(agentDir, { recursive: true });
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 67890,
    };
    const { writeFile } = await import("fs/promises");
    await writeFile(join(agentDir, "meta.transient.json"), JSON.stringify(transient));

    const a = makeAgent({
      id: "agent-1",
      repoPath: agentTmp,
      meta: {
        tmux_session: "",
        claude_pid: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(killCalls).toEqual([{ pid: 67890, signal: "SIGTERM" }]);

    await rm(agentTmp, { recursive: true, force: true });
  });

  test("logs SIGTERM failed when killPid returns false", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true);
    killPidCtx.set(() => false); // simulate ESRCH/EPERM

    const a = makeAgent({
      id: "agent-1",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM failed");
  });
});

// ── detectAgentStates — claude_pid liveness gate (dead-claude detection) ────

describe("detectAgentStates — claude_pid liveness gate", () => {
  let tmpLogDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "claude-liveness-log-"));
    logPath = join(tmpLogDir, "watch.log");
    resetReapedTmuxSessions();
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
  });

  afterEach(async () => {
    classifySpawnLogCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    liveTmuxSessionsCtx.reset();
    tmuxPollerSpawnCtx.reset();
    resetReapedTmuxSessions();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  /** Install a tmux-poller spawn runner that returns the given pane text for capture-pane. */
  function installTmuxRunner(output: string, captureCalls?: { count: number }): void {
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (isCapture && captureCalls) captureCalls.count++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? output : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
  }

  // Test 1: regression guard for happy path — running + alive PID + alive tmux → still running
  test("running + claude_pid alive + tmux alive → state stays 'running'", async () => {
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("running");
    expect(killCalls).toBe(0);
  });

  test("resumed agent uses current claude_pid_epoch instead of original created_epoch", async () => {
    const nowEpoch = Math.floor(Date.now() / 1000);
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    isPidAliveCtx.set(() => true);
    isPidAliveSinceCtx.reset();
    resetProcessStartEpochSecondsCache();
    processStartEpochSecondsCtx.set(() => nowEpoch);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "23456",
        claude_pid_epoch: nowEpoch,
        created_epoch: nowEpoch - 8 * 24 * 60 * 60,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("running");
  });

  test("recycled PID false-positive + missing live tmux session stops without capture", async () => {
    let pidChecks = 0;
    isPidAliveCtx.set(() => {
      pidChecks++;
      return true;
    });
    // Recreate the old bare-PID false-positive so this test independently
    // exercises the live-session defense-in-depth path.
    isPidAliveSinceCtx.set((pid) => isPidAliveCtx.fn(pid));
    liveTmuxSessionsCtx.set(async () => new Set());
    let captureCalls = 0;
    captureTmuxOutputResultCtx.set(async () => {
      captureCalls++;
      return { status: "ok", output: "unexpected capture" };
    });
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-stale",
    }));

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-stale",
        claude_pid: "18825",
        created_epoch: Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(pidChecks).toBe(1);
    expect(captureCalls).toBe(0);
  });

  test("recycled claude_pid is never signaled during destructive cleanup", async () => {
    const pidWriteEpoch = 1_700_000_000;
    isPidAliveSinceCtx.reset();
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(
      () => pidWriteEpoch + CLAUDE_PID_START_MARGIN_SECONDS + 1
    );
    const killPidCalls: number[] = [];
    killPidCtx.set((pid) => {
      killPidCalls.push(pid);
      return true;
    });
    tmuxPollerSpawnCtx.set((() => ({
      stdout: new ReadableStream({ start(c) { c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(0),
    })) as any);

    const a = makeAgent({
      id: "agent-recycled",
      meta: {
        state: "running",
        tmux_session: "ib-recycled",
        claude_pid: "18825",
        claude_pid_epoch: pidWriteEpoch,
        created_epoch: pidWriteEpoch - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("stopped");
    expect(killPidCalls).toEqual([]);
  });

  // Regression (live-agent kill): the claude_pid gate does not only RENDER —
  // it is the branch that calls reapOrphanedClaude, whose `tmux kill-session`
  // is gated on the resolved state alone. So a CACHED process-start verdict is
  // not merely a label that can lag: a stale entry (exactly what a since-
  // recycled PID leaves behind, held for PROCESS_START_CACHE_TTL_MS) turns a
  // live agent into `stopped` and takes its tmux session with it. Reproduced
  // against a real tmux session; here the cache is poisoned directly.
  //
  // The fix must NOT be a shorter TTL: the hole is open at any TTL. The dead
  // verdict has to be confirmed uncached before it is acted on.
  test("stale process-start cache must not stop-and-reap a LIVE claude_pid", async () => {
    const pidWriteEpoch = 1_700_000_000;
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (args[0] === "tmux" && args[1] === "kill-session") {
        killSessionCalls.push(String(args[3]));
      }
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              isCapture ? "⏵⏵ accept edits on (shift+tab to cycle)" : ""
            ));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    // Exercise the real guarded implementation, not the bare-PID seam.
    isPidAliveSinceCtx.reset();
    isPidAliveCtx.set(() => true); // the recorded pid is alive RIGHT NOW
    liveTmuxSessionsCtx.set(async () => new Set(["ib-live"]));
    let killPidCalls = 0;
    killPidCtx.set(() => { killPidCalls++; return true; });

    // Poison the cache the way an ordinary rendering pass does while the
    // PREVIOUS owner of this pid is still alive, then hand the pid to the
    // truthful start time. Only the cache entry differs from the control.
    resetProcessStartEpochSecondsCache();
    processStartEpochSecondsCtx.set(() => pidWriteEpoch - 5_000);
    isPidAliveSinceCtx.fn(18825, pidWriteEpoch);
    processStartEpochSecondsCtx.set(() => pidWriteEpoch);

    const a = makeAgent({
      id: "agent-live",
      meta: {
        state: "running",
        tmux_session: "ib-live",
        claude_pid: "18825",
        claude_pid_epoch: pidWriteEpoch,
        created_epoch: pidWriteEpoch - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("running");
    expect(killSessionCalls).toEqual([]);
    expect(killPidCalls).toBe(0);
  });

  // Regression (backstop at the site where the session actually dies): husk
  // teardown had NO identity check of any kind — `skipClaudePid` and the
  // identity guard protect the SIGTERM only. When the ONLY evidence that an
  // agent is stopped is a claude_pid liveness read, that PID must be re-checked
  // before its session is destroyed.
  //
  // Drives the liveness seam and the identity seam apart on purpose: the gate
  // says dead, identity says live-and-current. That is what a regression in the
  // gate would look like from here, and it must not cost the agent its session.
  test("husk teardown is vetoed when a pid-derived verdict meets a provably live pid", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "kill-session") {
        killSessionCalls.push(String(args[3]));
      }
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveSinceCtx.set(() => false); // the gate believes the pid is gone
    isPidIdentityCurrentCtx.set(() => true); // the OS says otherwise
    liveTmuxSessionsCtx.set(async () => new Set(["ib-live-veto"]));
    let killPidCalls = 0;
    killPidCtx.set(() => { killPidCalls++; return true; });

    const a = makeAgent({
      id: "agent-live-veto",
      meta: {
        state: "running",
        tmux_session: "ib-live-veto",
        claude_pid: "18825",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: 1_700_000_000 - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(killSessionCalls).toEqual([]);
    expect(killPidCalls).toBe(0); // skipClaudePid still holds on this branch
    const { readFile } = await import("fs/promises");
    expect(await readFile(logPath, "utf8")).toContain("teardown skipped");
  });

  // Regression (the veto ran too late): the backstop sat BELOW the signal
  // block, so on the exact stale-cache case it exists for the session was
  // spared but the watchdog had already been SIGTERMed. That leaves a live
  // agent running with no watchdog — no outbox delivery, no state updates —
  // which is most of the damage the veto is meant to prevent. Proof of life
  // must withhold every destructive act on this path, not just the last one.
  test("a vetoed pid-derived verdict withholds the watchdog SIGTERM too", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "kill-session") {
        killSessionCalls.push(String(args[3]));
      }
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    // The whole agent is alive; only the gate's (cached) read disagrees.
    isPidAliveCtx.set(() => true);
    isPidAliveSinceCtx.set(() => false); // the gate believes the pid is gone
    isPidIdentityCurrentCtx.set(() => true); // the OS says otherwise
    liveTmuxSessionsCtx.set(async () => new Set(["ib-live-veto-wd"]));
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    // Real on-disk agent dir so reapOrphanedClaude finds a watchdog to kill.
    const agentTmp = await mkdtemp(join(tmpdir(), "claude-liveness-agent-"));
    const agentDir = join(agentTmp, ".ittybitty", "agents", "agent-live-veto-wd");
    await mkdir(agentDir, { recursive: true });
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false,
      tmux_api_terms: false,
      tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: 0, // stale on purpose so the transient fast-path is skipped
      watchdog_pid: 67890,
      watchdog_pid_epoch: 1_700_000_000,
    };
    const { writeFile } = await import("fs/promises");
    await writeFile(join(agentDir, "meta.transient.json"), JSON.stringify(transient));

    const a = makeAgent({
      id: "agent-live-veto-wd",
      repoPath: agentTmp,
      meta: {
        state: "running",
        tmux_session: "ib-live-veto-wd",
        claude_pid: "18825",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: 1_700_000_000 - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    // The veto withholds destruction, not the label: rendering `stopped` off a
    // cached read is the bounded cost the cache is allowed to have.
    expect(a.state).toBe("stopped");
    expect(killSessionCalls).toEqual([]);
    // No SIGTERM to ANYTHING — the watchdog is the one this branch would
    // otherwise still reach (claude_pid is already covered by skipClaudePid).
    expect(killCalls).toEqual([]);
    const { readFile } = await import("fs/promises");
    expect(await readFile(logPath, "utf8")).not.toContain("kind=watchdog");

    await rm(agentTmp, { recursive: true, force: true });
  });

  // Companion to the backstop: a genuinely dead agent must still lose its husk.
  // The veto keys on AFFIRMATIVE proof of life, so absent or weak evidence has
  // to keep tearing down exactly as before. (The dead-pane husk case — a LIVE
  // pid with an authoritatively dead pane — is covered in the dead-pane
  // describe block, and must also still tear down.)
  test("husk teardown still fires for a dead claude_pid", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "kill-session") {
        killSessionCalls.push(String(args[3]));
      }
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveSinceCtx.reset();
    isPidIdentityCurrentCtx.reset();
    resetProcessStartEpochSecondsCache();
    processStartEpochSecondsCtx.set(() => 1_700_000_000);
    isPidAliveCtx.set(() => false); // affirmatively gone
    liveTmuxSessionsCtx.set(async () => new Set(["ib-husk"]));
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-husk",
      meta: {
        state: "running",
        tmux_session: "ib-husk",
        claude_pid: "18825",
        claude_pid_epoch: 1_700_000_000,
        created_epoch: 1_700_000_000 - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("stopped");
    expect(killSessionCalls).toEqual(["=ib-husk:"]);
  });

  test("recent agent + missing live tmux session stays creating without capture", async () => {
    isPidAliveCtx.set(() => true);
    isPidAliveSinceCtx.set((pid) => isPidAliveCtx.fn(pid));
    liveTmuxSessionsCtx.set(async () => new Set());
    let captureCalls = 0;
    captureTmuxOutputResultCtx.set(async () => {
      captureCalls++;
      return { status: "ok", output: "unexpected capture" };
    });
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-starting",
    }));

    const a = makeAgent({
      id: "agent-new",
      meta: {
        state: "running",
        tmux_session: "ib-starting",
        claude_pid: "18825",
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("creating");
    expect(captureCalls).toBe(0);
  });

  test("capture failure is unknown and never reaps a live agent", async () => {
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-live"]));
    captureTmuxOutputResultCtx.set(async () => ({
      status: "error",
      error: "capture-pane temporarily unavailable",
      exitCode: 1,
    }));
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-capture-failure",
      meta: {
        state: "running",
        tmux_session: "ib-live",
        claude_pid: "70544",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("running");
    expect(killCalls).toBe(0);
    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[tmux-observation] status=unknown operation=capture-pane");
    expect(log).toContain("capture-pane temporarily unavailable");
    expect(log).not.toContain("[orphan-kill]");
  });

  test("a live-but-unreadable session logs one diagnostic per interval", async () => {
    // The session is listed live on every poll while capture keeps failing
    // identically. Re-arming the husk memo on that liveness must not also reset
    // the capture diagnostic's rate limit, or every poll re-logs and rotates
    // away the lifecycle history TMUX_OBSERVATION_LOG_INTERVAL_MS protects.
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-unreadable"]));
    captureTmuxOutputResultCtx.set(async () => ({
      status: "error",
      error: "capture-pane: no current client",
      exitCode: 1,
    }));

    const a = makeAgent({
      id: "agent-unreadable",
      meta: {
        state: "running",
        tmux_session: "ib-unreadable",
        claude_pid: "70544",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });
    await detectAgentStates([a], { reap: true });
    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("running");
    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    const diagnostics = log
      .split("\n")
      .filter((line) => line.includes("[tmux-observation]") && line.includes("operation=capture-pane"));
    expect(diagnostics).toHaveLength(1);
  });

  test("a recovered capture re-arms the diagnostic for the next failure", async () => {
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-recovering"]));
    let captureFails = true;
    captureTmuxOutputResultCtx.set(async () =>
      captureFails
        ? { status: "error", error: "capture-pane: no current client", exitCode: 1 }
        : { status: "ok", output: "ordinary output\n" }
    );

    const a = makeAgent({
      id: "agent-recovering",
      meta: {
        state: "running",
        tmux_session: "ib-recovering",
        claude_pid: "70544",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });
    captureFails = false;
    await detectAgentStates([a], { reap: true });
    captureFails = true;
    await detectAgentStates([a], { reap: true });

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    const diagnostics = log
      .split("\n")
      .filter((line) => line.includes("[tmux-observation]") && line.includes("operation=capture-pane"));
    expect(diagnostics).toHaveLength(2);
  });

  test("unknown exact-session probe preserves state and never reaps", async () => {
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set());
    probeTmuxSessionCtx.set(async () => ({
      status: "unknown",
      error: "posix_spawn tmux: EPERM",
      exitCode: null,
    }));
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-probe-unknown",
      meta: {
        state: "waiting",
        tmux_session: "ib-unknown",
        claude_pid: "70544",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("waiting");
    expect(killCalls).toBe(0);
    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[tmux-observation] status=unknown operation=has-session");
    expect(log).toContain("posix_spawn tmux: EPERM");
    expect(log).not.toContain("[orphan-kill]");
  });

  test("watcher requires two consecutive confirmed missing-session probes before reaping", async () => {
    let observationNow = 10_000;
    nowMsCtx.set(() => observationNow);
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set());
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-missing",
    }));
    let killCalls = 0;
    killPidCtx.set(() => {
      killCalls++;
      return true;
    });
    installTmuxRunner("");

    const a = makeAgent({
      id: "agent-confirmed-missing",
      meta: {
        state: "running",
        tmux_session: "ib-missing",
        claude_pid: "70544",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], {
      reap: true,
      confirmTmuxMissingAcrossPolls: true,
    });
    expect(a.state).toBe("running");
    expect(killCalls).toBe(0);

    // A concurrent/duplicate call in the same polling window cannot count as
    // the second confirmation.
    await detectAgentStates([a], {
      reap: true,
      confirmTmuxMissingAcrossPolls: true,
    });
    expect(a.state).toBe("running");
    expect(killCalls).toBe(0);

    observationNow += TMUX_MISSING_CONFIRMATION_MIN_INTERVAL_MS;
    await detectAgentStates([a], {
      reap: true,
      confirmTmuxMissingAcrossPolls: true,
    });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(1);
  });

  // Test 2: running + dead PID + not recently created → reaped to 'stopped'.
  // Use a transient file with an alive watchdog_pid so reapOrphanedClaude has
  // something to actually kill — that way the watch.log entry confirms the
  // reap path ran. (claude_pid itself is dead, so it doesn't get SIGTERMed.)
  test("running + claude_pid dead + NOT recently created → 'stopped' + reapOrphanedClaude called", async () => {
    // claude_pid (12345) is dead, watchdog_pid (67890) is alive
    isPidAliveCtx.set((pid) => pid === 67890);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killCalls.push({ pid, signal });
      return true;
    });

    // Real on-disk agent dir so readAgentTransient finds the watchdog_pid
    const agentTmp = await mkdtemp(join(tmpdir(), "claude-liveness-agent-"));
    const agentDir = join(agentTmp, ".ittybitty", "agents", "agent-1");
    await mkdir(agentDir, { recursive: true });
    const transient: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: 0, // stale on purpose so the transient fast-path is skipped
      watchdog_pid: 67890,
    };
    const { writeFile } = await import("fs/promises");
    await writeFile(join(agentDir, "meta.transient.json"), JSON.stringify(transient));

    const a = makeAgent({
      id: "agent-1",
      repoPath: agentTmp,
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // claude_pid was dead → not killed. watchdog_pid was alive → SIGTERMed.
    expect(killCalls).toEqual([{ pid: 67890, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM sent");
    expect(log).toContain("kind=watchdog");
    expect(log).toContain("pid=67890");
    expect(log).toContain("claude_pid not alive");

    await rm(agentTmp, { recursive: true, force: true });
  });

  // Test 3: running + dead PID + recently created → grace window protects, stays 'running'
  test("running + claude_pid dead + IS recently created (within 6s) → unaffected, no reap", async () => {
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        // Within the 6s grace window (CREATING_GRACE_PERIOD_MS)
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    // The pid liveness gate is skipped during the grace window; falls
    // through to the existing logic. captureTmuxOutput returns benign
    // output, no overrides match, meta.state="running" is trusted.
    expect(a.state).toBe("running");
    expect(killCalls).toBe(0);
  });

  // Test 4: waiting + dead PID → 'stopped' (proves fix isn't scoped to 'running')
  test("waiting + claude_pid dead → 'stopped'", async () => {
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "waiting",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0); // dead PID — no kill issued
  });

  // Test 5: regression guard for the case previously handled inline in the
  // 'complete' branch — make sure removing that inner check didn't break it.
  test("complete + claude_pid dead → 'stopped'", async () => {
    let captureCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "capture-pane") captureCalls++;
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "complete",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(captureCalls).toBe(0); // complete fast-path still skips capture
  });

  // Regression: the user-hit case where BOTH the pid liveness gate fires
  // (dead claude_pid) AND the tmux session is a dead-pane husk. The pid
  // gate previously short-circuited before the husk-kill path could run,
  // so reapOrphanedClaude reaped the PIDs but left the husk session alive
  // (still counted by listTmuxSessions on subsequent ticks). Husk teardown
  // now happens inside reapOrphanedClaude for resolvedState === "stopped",
  // which covers this branch uniformly.
  test("running + claude_pid dead + dead-pane husk → 'stopped' + kill-session called", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false); // claude_pid is dead
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killPidCalls = 0;
    killPidCtx.set(() => { killPidCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // Husk session should have been torn down via reapOrphanedClaude.
    expect(killSessionCalls).toEqual(["=ib-a1:"]);
    // claude_pid was dead → no SIGTERM to it.
    expect(killPidCalls).toBe(0);
  });

  // Regression: detectAgentStates runs every ~2s over ALL agents. A stopped
  // agent whose meta.json still carries a stale tmux_session must not re-spawn
  // `tmux kill-session` on every tick forever. The reapedTmuxSessions memo
  // guarantees the husk is torn down AT MOST ONCE.
  test("stopped husk → kill-session called once across repeated ticks (memoized)", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false); // claude_pid is dead → resolves to stopped
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    // Three consecutive pollStates ticks over the same stopped agent.
    await detectAgentStates([a], { reap: true });
    await detectAgentStates([a], { reap: true });
    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("stopped");
    // kill-session must have fired exactly ONCE, not once per tick.
    expect(killSessionCalls).toEqual(["=ib-a1:"]);
  });

  // Regression (resume re-arm): the reapedTmuxSessions memo must be CLEARED
  // when an agent is observed alive again, so a stopped -> resume -> stopped
  // cycle re-kills the husk. `resumeAgent` re-creates the tmux session under
  // the SAME name and writes state "running"; without clear-on-alive the memo
  // still holds that name and the second stop would skip teardown, leaking a
  // husk session. We drive three ticks: stop (kill #1, memo set) -> running
  // (memo cleared via the live capture path) -> stop again (kill #2).
  test("stopped -> running -> stopped re-arms husk teardown (kill-session fires twice)", async () => {
    // phase toggles the agent between a dead husk and a live, running pane.
    let phase: "stopped" | "running" = "stopped";
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      // When stopped: capture-pane shows a dead husk pane. When running:
      // capture-pane shows a live Claude pane so detectAgentStates resolves
      // running and clears the memo.
      const paneText =
        phase === "stopped"
          ? "Pane is dead (status 0, signal SIGTERM)\n"
          : "⏵⏵ accept edits on (shift+tab to cycle)";
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? paneText : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    // claude_pid liveness tracks the phase: dead while stopped (drives the
    // husk teardown), alive while running (passes the pid gate so the live
    // capture path runs and clears the memo).
    isPidAliveCtx.set(() => phase === "running");
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    // Tick 1: stopped husk → kill #1, memo arms ib-a1.
    phase = "stopped";
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killSessionCalls).toEqual(["=ib-a1:"]);

    // Tick 2: resumed → live pane → running, memo cleared for ib-a1.
    phase = "running";
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("running");
    // No new kill-session on the running tick.
    expect(killSessionCalls).toEqual(["=ib-a1:"]);

    // Tick 3: stopped again → husk teardown re-armed → kill #2.
    phase = "stopped";
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // The core guarantee: kill-session fired a SECOND time after the resume.
    expect(killSessionCalls).toEqual(["=ib-a1:", "=ib-a1:"]);
  });

  // The memo is per-session-name: a different stopped session is still killed
  // even after another session was already reaped this run.
  test("memo is keyed per session — a different stopped session is still killed", async () => {
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => false);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1", "ib-a2"]));
    killPidCtx.set(() => true);

    const a1 = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    const a2 = makeAgent({
      id: "agent-2",
      meta: {
        state: "running",
        tmux_session: "ib-a2",
        claude_pid: "23456",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a1, a2], { reap: true });
    // Re-run: neither should be re-killed.
    await detectAgentStates([a1, a2], { reap: true });

    expect(killSessionCalls.sort()).toEqual(["=ib-a1:", "=ib-a2:"]);
  });

  // Test 8: empty/legacy claude_pid → no false positive, falls through normally
  test("running + claude_pid='' (empty/legacy) + normal tmux → state follows existing logic, no reap", async () => {
    installTmuxRunner("⏵⏵ accept edits on (shift+tab to cycle)");
    // isPidAlive should never be called since claude_pid parses to NaN (≤ 0).
    let pidChecks = 0;
    isPidAliveCtx.set(() => {
      pidChecks++;
      return false;
    });
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("running");
    expect(pidChecks).toBe(0);
    expect(killCalls).toBe(0);
  });
});

// ── detectAgentStates — dead-pane (remain-on-exit) detection ───────────────

describe("detectAgentStates — dead-pane husk handling", () => {
  let tmpLogDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "dead-pane-log-"));
    logPath = join(tmpLogDir, "watch.log");
    resetReapedTmuxSessions();
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
  });

  afterEach(async () => {
    classifySpawnLogCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    liveTmuxSessionsCtx.reset();
    tmuxPollerSpawnCtx.reset();
    resetReapedTmuxSessions();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  // Test 6: dead pane + alive PID + not recently created → stopped + kill-session called
  test("running + claude_pid alive + 'Pane is dead' output + NOT recently created → 'stopped', kill-session called", async () => {
    probeTmuxPaneCtx.set(async () => ({ status: "dead" }));
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) {
        // args is ["tmux", "kill-session", "-t", "ib-a1"]
        killSessionCalls.push(String(args[3]));
      }
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              isCapture ? "Pane is dead (status 0, signal SIGTERM)\n" : ""
            ));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true); // claude_pid still alive (zombie state)
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    const killPidCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      killPidCalls.push({ pid, signal });
      return true;
    });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    // Husk session should have been torn down
    expect(killSessionCalls).toEqual(["=ib-a1:"]);
    // reapOrphanedClaude should have been invoked (alive PID → SIGTERMed)
    expect(killPidCalls).toEqual([{ pid: 12345, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[orphan-kill] SIGTERM sent");
    expect(log).toContain("tmux pane is dead");
  });

  test("quoted 'Pane is dead' text in a live pane never stops or reaps the agent", async () => {
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-review"]));
    captureTmuxOutputResultCtx.set(async () => ({
      status: "ok",
      output: "Reviewing isDeadPane: ordinary output may contain Pane is dead",
    }));
    probeTmuxPaneCtx.set(async () => ({ status: "live" }));
    let killPidCalls = 0;
    killPidCtx.set(() => {
      killPidCalls++;
      return true;
    });

    const a = makeAgent({
      id: "agent-review",
      meta: {
        state: "running",
        tmux_session: "ib-review",
        claude_pid: "38743",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });

    await detectAgentStates([a], { reap: true });

    expect(a.state).toBe("running");
    expect(killPidCalls).toBe(0);
  });

  // Test 7: dead pane + recently created → creating, kill-session NOT called
  test("running + 'Pane is dead' output + IS recently created → 'creating', kill-session NOT called", async () => {
    probeTmuxPaneCtx.set(async () => ({ status: "dead" }));
    const killSessionCalls: string[] = [];
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      const isKill = args[0] === "tmux" && args[1] === "kill-session";
      if (isKill) killSessionCalls.push(String(args[3]));
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              isCapture ? "Pane is dead (status 0, ...)\n" : ""
            ));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a1"]));
    let killPidCalls = 0;
    killPidCtx.set(() => { killPidCalls++; return true; });

    const a = makeAgent({
      id: "agent-1",
      meta: {
        state: "running",
        tmux_session: "ib-a1",
        claude_pid: "12345",
        // Within 6s grace window
        created_epoch: Math.floor(Date.now() / 1000) - 1,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("creating");
    expect(killSessionCalls).toEqual([]); // grace window protects husk-kill
    expect(killPidCalls).toBe(0); // reapOrphanedClaude returns early on 'creating'
  });
});

// ── readAllAgents — listTmuxSessions TTL cache (Change D) ──────────────────

describe("readAllAgents — listTmuxSessions cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-listcache-"));
    resetListTmuxSessionsCache();
  });

  afterEach(async () => {
    tmuxPollerSpawnCtx.reset();
    resetListTmuxSessionsCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("two consecutive readAllAgents within TTL invoke list-sessions only once", async () => {
    let listCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "list-sessions") listCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    await readAllAgents([{ path: tempDir, name: "test-repo" }], false);
    await readAllAgents([{ path: tempDir, name: "test-repo" }], false);
    expect(listCalls).toBe(1);
  });

  test("after cache reset, list-sessions is invoked again", async () => {
    let listCalls = 0;
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      if (args[0] === "tmux" && args[1] === "list-sessions") listCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);

    await readAllAgents([{ path: tempDir, name: "test-repo" }], false);
    resetListTmuxSessionsCache();
    await readAllAgents([{ path: tempDir, name: "test-repo" }], false);
    expect(listCalls).toBe(2);
  });
});

// ── readAgentTransient / writeAgentTransient ─────────────────────────────────

describe("readAgentTransient / writeAgentTransient", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-transient-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns null when meta.transient.json is missing", async () => {
    const result = await readAgentTransient(tempDir);
    expect(result).toBeNull();
  });

  test("happy path: writes data and reads it back", async () => {
    const data: TransientState = {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: true,
      updated_at_ms: 1_700_000_000_000,
      watchdog_pid: 12345,
    };
    await writeAgentTransient(tempDir, data);
    const result = await readAgentTransient(tempDir);
    // Fields added after the original transient shape read back with null
    // back-compat defaults when absent.
    expect(result).toEqual({
      ...data,
      last_restarted_at_ms: null,
      restart_compact_escape_sent_at_ms: null,
      operation: null,
    });
  });

  test("round-trips tmux_api_safeguard: true", async () => {
    const data: TransientState = {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: true,
      has_background_tasks: false,
      updated_at_ms: 1_700_000_000_000,
      watchdog_pid: 12345,
    };
    await writeAgentTransient(tempDir, data);
    const result = await readAgentTransient(tempDir);
    expect(result!.tmux_api_safeguard).toBe(true);
  });

  test("defaults tmux_api_safeguard to false when absent from an older file", async () => {
    // A meta.transient.json written before the field existed omits it; the read
    // must default it to false (back-compat) rather than reject the whole read.
    await Bun.write(
      join(tempDir, "meta.transient.json"),
      JSON.stringify({
        tmux_compacting: false,
        tmux_rate_limited: false,
        tmux_api_error: false,
        tmux_api_terms: false,
        has_background_tasks: false,
        updated_at_ms: 1_700_000_000_000,
        watchdog_pid: 999,
      }),
    );
    const result = await readAgentTransient(tempDir);
    expect(result).not.toBeNull();
    expect(result!.tmux_api_safeguard).toBe(false);
  });

  test("returns null when file is malformed", async () => {
    await Bun.write(join(tempDir, "meta.transient.json"), "{ not json");
    const result = await readAgentTransient(tempDir);
    expect(result).toBeNull();
  });

  test("returns null when fields have wrong types", async () => {
    await Bun.write(
      join(tempDir, "meta.transient.json"),
      JSON.stringify({ tmux_compacting: "yes", tmux_rate_limited: false, has_background_tasks: true, updated_at_ms: 0, watchdog_pid: 1 }),
    );
    const result = await readAgentTransient(tempDir);
    expect(result).toBeNull();
  });

  test("write is atomic (.tmp + rename) — second write replaces first", async () => {
    const first: TransientState = { tmux_compacting: true, tmux_rate_limited: false, tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false, has_background_tasks: false, updated_at_ms: 1, watchdog_pid: 100 };
    const second: TransientState = { tmux_compacting: false, tmux_rate_limited: true, tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false, has_background_tasks: false, updated_at_ms: 2, watchdog_pid: 200 };
    await writeAgentTransient(tempDir, first);
    await writeAgentTransient(tempDir, second);
    expect(await readAgentTransient(tempDir)).toEqual({
      ...second,
      last_restarted_at_ms: null,
      restart_compact_escape_sent_at_ms: null,
      operation: null,
    });
  });

  test("deleteAgentTransient removes the file", async () => {
    const data: TransientState = { tmux_compacting: false, tmux_rate_limited: false, tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false, has_background_tasks: false, updated_at_ms: 1, watchdog_pid: 1 };
    await writeAgentTransient(tempDir, data);
    expect(await readAgentTransient(tempDir)).not.toBeNull();
    await deleteAgentTransient(tempDir);
    expect(await readAgentTransient(tempDir)).toBeNull();
  });

  test("deleteAgentTransient is a no-op when file is missing", async () => {
    await deleteAgentTransient(tempDir);
    expect(await readAgentTransient(tempDir)).toBeNull();
  });
});

// Regression: lock-owner reclaim was safe only because LIFECYCLE_LOCK_STALE_MS
// happened to exceed PROCESS_START_CACHE_TTL_MS — a poisoned cache entry always
// expired before the age gate opened. Nothing said so and nothing enforced it,
// and the TTL had already been raised 12x (5s -> 60s) without anyone weighing
// it. One more raise past 120s and LIVE locks become stealable. The ordering is
// no longer load-bearing (both gates re-probe uncached) and must never quietly
// become load-bearing again.
describe("lifecycle timing invariant", () => {
  test("the shipped constants satisfy the ordering", () => {
    expect(LIFECYCLE_LOCK_STALE_MS).toBeGreaterThan(PROCESS_START_CACHE_TTL_MS);
  });

  test("the ordering is enforced, not merely documented", () => {
    // Equal is not enough: the poisoned entry must expire STRICTLY before the
    // age gate opens.
    expect(() => assertLifecycleTimingInvariant(60_000, 60_000)).toThrow(
      /timing invariant violated/
    );
    expect(() => assertLifecycleTimingInvariant(60_000, 120_000)).toThrow(
      /timing invariant violated/
    );
    expect(() => assertLifecycleTimingInvariant(120_000, 60_000)).not.toThrow();
  });

  test("the assertion runs at module load, so a bad pair cannot ship", async () => {
    // Importing this module already ran it against the real constants; this
    // pins that the call site exists rather than only the helper.
    const { readFile } = await import("fs/promises");
    const source = await readFile(new URL("./agents.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "assertLifecycleTimingInvariant(LIFECYCLE_LOCK_STALE_MS, PROCESS_START_CACHE_TTL_MS);"
    );
  });
});

// ── lifecycle lock: stale-lock reclamation must never admit two owners ───────

describe("acquireAgentLifecycleLock — stale-lock reclamation", () => {
  let tempDir: string;
  let agentDir: string;
  let lockPath: string;

  /** PID seeded into the stale lock; reported affirmatively dead below. */
  const DEAD_OWNER_PID = 424242;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-lifecycle-lock-"));
    agentDir = join(tempDir, "agent-stale");
    await mkdir(agentDir, { recursive: true });
    lockPath = `${agentDir}.lifecycle.lock`;
    isPidAliveCtx.set((pid) => pid !== DEAD_OWNER_PID);
  });

  afterEach(async () => {
    isPidAliveCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Write a lock file whose owner is long gone and whose age is past stale. */
  async function seedStaleLock(token: string): Promise<void> {
    await Bun.write(
      lockPath,
      JSON.stringify({
        pid: DEAD_OWNER_PID,
        created_at_ms: Date.now() - 10 * 60_000,
        token,
      })
    );
  }

  test("a dead owner's lock is reclaimed by a single contender", async () => {
    await seedStaleLock("stale-single");
    const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
    expect(lock).not.toBeNull();
    const held = await Bun.file(lockPath).json();
    expect(held.token).not.toBe("stale-single");
    expect(held.pid).toBe(process.pid);
    await lock!.release();
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  // Regression: `open(lockPath, "wx")` published the lock at ZERO BYTES and
  // wrote the JSON body on the next line. A process killed in that window left
  // a bodyless lock that reclamation refused to parse — and nothing in the
  // codebase ever deletes a *.lifecycle.lock — so the agent was wedged
  // permanently: acquire returned null forever, `ib merge` reported it busy
  // forever, and every watchdog transient write blocked the full wait and
  // dropped. The lock is now linked into place fully formed, and an aged
  // bodyless lock left by an older binary is still recoverable via mtime.
  test("a bodyless lock left by the old create-then-write window is recoverable", async () => {
    await writeFile(lockPath, "");
    const aged = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, aged, aged);

    const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
    expect(lock).not.toBeNull();
    const held = await Bun.file(lockPath).json();
    expect(held.pid).toBe(process.pid);
    await lock!.release();
    expect(await Bun.file(lockPath).exists()).toBe(false);
    // Reclaiming a bodyless generation must not litter the agents directory.
    expect(await readdir(tempDir)).toEqual(["agent-stale"]);
  });

  test("a freshly created bodyless lock is left alone until it goes stale", async () => {
    // A publisher mid-flight is indistinguishable from a crashed one except by
    // age, so the bodyless backstop waits out the full stale threshold.
    await writeFile(lockPath, "");
    expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
    expect(await Bun.file(lockPath).exists()).toBe(true);
  });

  test("an aged but truncated body is recoverable; an unreadable lock is not", async () => {
    // Truncated JSON reads fine and is definitively not a record → recoverable.
    await writeFile(lockPath, '{"pid":42,"created_at_ms"');
    const aged = new Date(Date.now() - 10 * 60_000);
    await utimes(lockPath, aged, aged);
    const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
    expect(lock).not.toBeNull();
    await lock!.release();

    // A lock that cannot be read AT ALL stays unavailable evidence: a
    // directory at the lock path fails every read, and must never be removed.
    await mkdir(lockPath, { recursive: true });
    expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
    expect((await readdir(tempDir)).sort()).toEqual(
      ["agent-stale", "agent-stale.lifecycle.lock"]
    );
    await rm(lockPath, { recursive: true, force: true });
  });

  // ── PID identity, not bare liveness ───────────────────────────────────────
  // Regression: the lock record and the reclaim-claim record carried a bare
  // pid, checked with isPidAliveCtx. One recycled PID therefore made a
  // long-dead holder look alive forever and wedged that generation
  // permanently — far more reachable than exhausting the 16 claim slots.
  describe("recycled-PID identity", () => {
    /** Reported alive, but its process start disagrees with the record. */
    const RECYCLED_PID = 515151;
    const OWNER_START = 1_700_000_000;

    beforeEach(() => {
      // The suite-wide stub collapses isPidAliveSince onto bare liveness;
      // these tests need the real identity rule.
      isPidAliveSinceCtx.reset();
      resetProcessStartEpochSecondsCache();
      processStartEpochSecondsCtx.set((pid) =>
        pid === RECYCLED_PID
          ? OWNER_START + CLAUDE_PID_START_MARGIN_SECONDS + 1
          : OWNER_START
      );
    });

    /** A stale lock held by a PID that is alive but is no longer its owner. */
    async function seedRecycledLock(token: string, pidEpoch?: number): Promise<void> {
      await Bun.write(
        lockPath,
        JSON.stringify({
          pid: RECYCLED_PID,
          ...(pidEpoch === undefined ? {} : { pid_epoch: pidEpoch }),
          created_at_ms: Date.now() - 10 * 60_000,
          token,
        })
      );
    }

    test("a stale lock whose PID was recycled is reclaimed", async () => {
      await seedRecycledLock("stale-recycled", OWNER_START);
      const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
      expect(lock).not.toBeNull();
      const held = await Bun.file(lockPath).json();
      expect(held.token).not.toBe("stale-recycled");
      expect(held.pid).toBe(process.pid);
      await lock!.release();
    });

    test("a lock written by an older binary with no epoch is never stolen", async () => {
      // An absent epoch is "cannot confirm the holder is gone", not permission.
      await seedRecycledLock("stale-legacy");
      expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
      expect((await Bun.file(lockPath).json()).token).toBe("stale-legacy");
    });

    test("a live owner whose start time is unavailable is never stolen", async () => {
      processStartEpochSecondsCtx.set(() => null);
      await seedRecycledLock("stale-unknown-start", OWNER_START);
      expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
      expect((await Bun.file(lockPath).json()).token).toBe("stale-unknown-start");
    });

    test("a live owner whose start time still matches is never stolen", async () => {
      processStartEpochSecondsCtx.set(() => OWNER_START);
      await seedRecycledLock("stale-live-owner", OWNER_START);
      expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
      expect((await Bun.file(lockPath).json()).token).toBe("stale-live-owner");
    });

    test("a claim whose reclaimer PID was recycled is stepped over", async () => {
      await seedStaleLock("stale-claim-recycled");
      // Left by a reclaimer that died; its PID now belongs to something else.
      // Aged past LIFECYCLE_LOCK_STALE_MS: a claim must clear the age gate as
      // well as the liveness one before anyone may step over it.
      await Bun.write(
        `${lockPath}.reclaim.stale-claim-recycled.0`,
        JSON.stringify({
          pid: RECYCLED_PID,
          pid_epoch: OWNER_START,
          created_at_ms: Date.now() - 10 * 60_000,
        })
      );

      const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
      expect(lock).not.toBeNull();
      expect((await Bun.file(lockPath).json()).token).not.toBe("stale-claim-recycled");
      await lock!.release();
    });

    // Regression: 8a2f663 routed both lock gates through the CACHED liveness
    // read. A cache entry left by a since-recycled PID therefore made a LIVE
    // reclaimer look gone — so acquire stepped over that reclaimer's claim and
    // then DELETED its claim file on the way out, breaking the invariant that
    // at most one process may ever remove a given generation. The only
    // difference from the control is one cache entry.
    test("a stale cache entry must not let a LIVE reclaimer's claim be stepped over", async () => {
      await seedStaleLock("stale-claim-live-cached");
      const claimPath = `${lockPath}.reclaim.stale-claim-live-cached.0`;
      // Aged well past the gate, so liveness is the only thing under test.
      await Bun.write(
        claimPath,
        JSON.stringify({
          pid: process.pid,
          pid_epoch: OWNER_START,
          created_at_ms: Date.now() - 10 * 60_000,
        })
      );

      // Cache a start time observed while the PREVIOUS owner of this pid was
      // alive, then let the pid be truthfully ours again.
      resetProcessStartEpochSecondsCache();
      processStartEpochSecondsCtx.set(
        () => OWNER_START + CLAUDE_PID_START_MARGIN_SECONDS + 1
      );
      isPidAliveSinceCtx.fn(process.pid, OWNER_START);
      processStartEpochSecondsCtx.set(() => OWNER_START);

      expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
      expect((await Bun.file(lockPath).json()).token).toBe("stale-claim-live-cached");
      expect(await Bun.file(claimPath).exists()).toBe(true);
    });

    // Same poisoning against the OWNER gate. Age cannot save this one: the
    // owner of a long-stale lock can be alive and merely slow, which is
    // exactly the publisher the round-1 protocol protects at 119s.
    test("a stale cache entry must not let a LIVE owner's lock be reclaimed", async () => {
      await Bun.write(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          pid_epoch: OWNER_START,
          created_at_ms: Date.now() - 10 * 60_000,
          token: "stale-live-owner-cached",
        })
      );

      resetProcessStartEpochSecondsCache();
      processStartEpochSecondsCtx.set(
        () => OWNER_START + CLAUDE_PID_START_MARGIN_SECONDS + 1
      );
      isPidAliveSinceCtx.fn(process.pid, OWNER_START);
      processStartEpochSecondsCtx.set(() => OWNER_START);

      expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
      expect((await Bun.file(lockPath).json()).token).toBe("stale-live-owner-cached");
    });

    test("a claim written with no epoch still blocks every other reclaimer", async () => {
      await seedStaleLock("stale-claim-legacy");
      // Aged past LIFECYCLE_LOCK_STALE_MS so the AGE gate is open and the
      // liveness term is the only thing holding this claim. A fixture inside
      // the age window passes no matter what liveness says, which is how the
      // trap this test exists for — a strict verdict making every legacy
      // no-epoch claim instantly steppable — went uncaught.
      await Bun.write(
        `${lockPath}.reclaim.stale-claim-legacy.0`,
        JSON.stringify({ pid: RECYCLED_PID, created_at_ms: Date.now() - 10 * 60_000 })
      );

      expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
      expect((await Bun.file(lockPath).json()).token).toBe("stale-claim-legacy");
    });

    test("a published lock stamps this process's real start time", async () => {
      // The stamp is the writer's process START, not the wall clock at write
      // time: a long-running `ib watch` acquires locks hours after it started,
      // and a write-time stamp would sit outside the margin and read as
      // recycled on the very next pass.
      const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
      expect(lock).not.toBeNull();
      const held = await Bun.file(lockPath).json();
      expect(held.pid).toBe(process.pid);
      expect(held.pid_epoch).toBe(OWNER_START);
      await lock!.release();
    });

    test("this process's start time is read once, not per acquisition", async () => {
      let selfProbes = 0;
      processStartEpochSecondsCtx.set((pid) => {
        if (pid === process.pid) selfProbes++;
        return OWNER_START;
      });
      for (let i = 0; i < 5; i++) {
        const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
        await lock!.release();
      }
      expect(selfProbes).toBe(1);
    });

    test("an unreadable own start time omits the epoch rather than guessing", async () => {
      processStartEpochSecondsCtx.set(() => null);
      const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
      expect(lock).not.toBeNull();
      expect((await Bun.file(lockPath).json()).pid_epoch).toBeUndefined();
      await lock!.release();
    });
  });

  test("every published lock is observable only fully formed", async () => {
    // Pre-fix, a concurrent reader could catch the zero-byte file between the
    // exclusive create and the body write. Interleave a reader with many
    // acquire/release cycles and require every observation to parse.
    const halfWritten: string[] = [];
    let running = true;
    const reader = (async () => {
      while (running) {
        try {
          const body = await Bun.file(lockPath).text();
          if (body.length > 0) JSON.parse(body);
          else halfWritten.push("zero-byte lock observed");
        } catch {
          /* absent or mid-rename — not an observation of a bad lock */
        }
        await Bun.sleep(0);
      }
    })();

    for (let i = 0; i < 400; i++) {
      const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
      expect(lock).not.toBeNull();
      await lock!.release();
    }
    running = false;
    await reader;

    expect(halfWritten).toEqual([]);
  }, 60_000);

  // Regression: the staging write used `handle.write`, which is allowed to
  // write FEWER bytes than it was handed and to report how many it took. A
  // short write there publishes a TRUNCATED record — and the entire point of
  // staging is that nothing is ever linked into place half-written, so a
  // partial body defeats the fix it is part of. (The malformed-body path
  // handles the result safely today, which is what keeps this a latent defect
  // rather than a live one.)
  //
  // Forced at the only place a short write is deterministic:
  // FileHandle.prototype.write. `writeFile` drains the whole buffer, so it
  // survives the same patch that truncates a raw `write`.
  test("a short write can never publish a truncated lock body", async () => {
    const probe = await open(join(tempDir, "write-probe"), "wx");
    const handleProto: any = Object.getPrototypeOf(probe);
    await probe.close();
    const realWrite = handleProto.write;
    // One byte per call, and only for the lifecycle record bodies — this patch
    // is process-wide for as long as it is installed.
    handleProto.write = function (this: any, data: any, ...rest: any[]) {
      if (typeof data === "string" && data.startsWith('{"pid":')) {
        return realWrite.call(this, data.slice(0, 1), ...rest);
      }
      return realWrite.call(this, data, ...rest);
    };

    let lock: Awaited<ReturnType<typeof acquireAgentLifecycleLock>>;
    try {
      lock = await acquireAgentLifecycleLock(agentDir, 2_000);
    } finally {
      handleProto.write = realWrite;
    }

    expect(lock).not.toBeNull();
    // Fully formed, not a prefix of itself.
    const held = await Bun.file(lockPath).json();
    expect(held.pid).toBe(process.pid);
    expect(typeof held.token).toBe("string");
    await lock!.release();
  });

  // Regression: publishing the lock via a staging file moved the create from
  // `open(wx)` to Bun.write, which makes missing parent directories. Acquiring
  // under a removed `.ittybitty/agents` tree therefore recreated it instead of
  // failing with ENOENT.
  test("acquiring under a deleted agents directory does not resurrect it", async () => {
    const goneDir = join(tempDir, "gone", "agent-x");

    expect(await acquireAgentLifecycleLock(goneDir, 0)).toBeNull();
    expect(await readdir(tempDir)).toEqual(["agent-stale"]);
  });

  test("a live owner's lock is never reclaimed", async () => {
    await Bun.write(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        created_at_ms: Date.now() - 10 * 60_000,
        token: "live-owner",
      })
    );
    // waitMs 0 → one pass, then fail safe.
    expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
    expect((await Bun.file(lockPath).json()).token).toBe("live-owner");
  });

  test("a live reclaimer's claim blocks every other reclaimer", async () => {
    await seedStaleLock("stale-claimed");
    // A reclaimer that is still running owns this generation's steal. Aged past
    // LIFECYCLE_LOCK_STALE_MS on purpose: liveness must block this claim on its
    // own. A fresh fixture is blocked by the age gate whatever liveness says, so
    // it cannot witness the liveness term at all — the fresh-claim case has its
    // own test below.
    await Bun.write(
      `${lockPath}.reclaim.stale-claimed.0`,
      JSON.stringify({ pid: process.pid, created_at_ms: Date.now() - 10 * 60_000 })
    );

    expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
    // The stale generation must be exactly where the live reclaimer left it.
    expect((await Bun.file(lockPath).json()).token).toBe("stale-claimed");
  });

  test("a crashed reclaimer's claim does not wedge the lock", async () => {
    await seedStaleLock("stale-crashed");
    // Left behind by a reclaimer that died mid-steal, and aged past
    // LIFECYCLE_LOCK_STALE_MS. It is never unlinked to take over (that race is
    // the bug); the next slot is claimed instead. The wait is the whole cost of
    // the age gate — the lock is delayed, never wedged.
    await Bun.write(
      `${lockPath}.reclaim.stale-crashed.0`,
      JSON.stringify({ pid: DEAD_OWNER_PID, created_at_ms: Date.now() - 10 * 60_000 })
    );

    const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
    expect(lock).not.toBeNull();
    expect((await Bun.file(lockPath).json()).token).not.toBe("stale-crashed");
    await lock!.release();
  });

  // Regression: claims stamped created_at_ms and NOTHING ever read it, so a
  // claim had no age gate at all — an incorrect liveness verdict was by itself
  // enough to step over one. A claim is held for microseconds, so a fresh one
  // is a live reclaimer, whatever a PID read says about it.
  test("a fresh claim is not stepped over even when its reclaimer reads dead", async () => {
    await seedStaleLock("stale-claim-fresh");
    await Bun.write(
      `${lockPath}.reclaim.stale-claim-fresh.0`,
      JSON.stringify({ pid: DEAD_OWNER_PID, created_at_ms: Date.now() })
    );

    expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
    // Neither the generation nor the other process's claim may be touched.
    expect((await Bun.file(lockPath).json()).token).toBe("stale-claim-fresh");
    expect(await Bun.file(`${lockPath}.reclaim.stale-claim-fresh.0`).exists()).toBe(true);
  });

  // A claim written by an older binary carries no created_at_ms. `link`
  // publishes it without changing the staging file's mtime, so the file itself
  // dates the claim; without that fallback such a claim would block its
  // generation forever.
  test("a claim with no created_at_ms is aged by its file mtime", async () => {
    await seedStaleLock("stale-claim-nostamp");
    const claimPath = `${lockPath}.reclaim.stale-claim-nostamp.0`;
    await Bun.write(claimPath, JSON.stringify({ pid: DEAD_OWNER_PID }));

    // Fresh on disk → still someone else's live claim.
    expect(await acquireAgentLifecycleLock(agentDir, 0)).toBeNull();
    expect((await Bun.file(lockPath).json()).token).toBe("stale-claim-nostamp");

    // Aged out → recoverable, so no permanent wedge.
    const aged = new Date(Date.now() - 10 * 60_000);
    await utimes(claimPath, aged, aged);
    const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
    expect(lock).not.toBeNull();
    expect((await Bun.file(lockPath).json()).token).not.toBe("stale-claim-nostamp");
    await lock!.release();
  });

  test("the reclaim path collects staging files abandoned by a dead writer", async () => {
    // Both publishers remove their staging file in a `finally`, so these only
    // ever appear when the process died mid-call — and nothing else collects
    // them. Removal requires a dead writer AND an aged file, so a live
    // contender's in-flight staging file is never touched.
    const aged = new Date(Date.now() - 10 * 60_000);
    const abandoned = [
      `${lockPath}.staging.${DEAD_OWNER_PID}.aaaa`,
      `${lockPath}.reclaim.staging.${DEAD_OWNER_PID}.bbbb`,
    ];
    for (const path of abandoned) {
      await Bun.write(path, "{}");
      await utimes(path, aged, aged);
    }
    // Must survive: a live writer's file, and a dead writer's FRESH file.
    const livePath = `${lockPath}.reclaim.staging.${process.pid}.cccc`;
    const freshPath = `${lockPath}.reclaim.staging.${DEAD_OWNER_PID}.dddd`;
    await Bun.write(livePath, "{}");
    await utimes(livePath, aged, aged);
    await Bun.write(freshPath, "{}");

    await seedStaleLock("stale-with-debris");
    const lock = await acquireAgentLifecycleLock(agentDir, 2_000);
    expect(lock).not.toBeNull();
    await lock!.release();

    for (const path of abandoned) {
      expect(await Bun.file(path).exists()).toBe(false);
    }
    expect(await Bun.file(livePath).exists()).toBe(true);
    expect(await Bun.file(freshPath).exists()).toBe(true);
  });

  test("concurrent contenders racing one stale lock never overlap", async () => {
    // Every contender starts each round already past the stale check, which is
    // exactly the interleaving that let two of them reclaim the same lock: the
    // first unlinked the stale file and reacquired, the second then unlinked
    // the NEW lock and acquired its own. waitMs 0 keeps each contender to a
    // single pass so the rounds stay cheap.
    const CONTENDERS = 32;
    const ROUNDS = 200;

    let owners = 0;
    let maxOwners = 0;
    let reclaims = 0;
    const overlaps: string[] = [];
    const stolen: string[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      await seedStaleLock(`stale-round-${round}`);
      await Promise.all(
        Array.from({ length: CONTENDERS }, async () => {
          const lock = await acquireAgentLifecycleLock(agentDir, 0);
          if (!lock) return;
          reclaims++;
          owners++;
          maxOwners = Math.max(maxOwners, owners);
          if (owners > 1) overlaps.push(`round ${round}: ${owners} simultaneous owners`);
          const mine = await Bun.file(lockPath).json().catch(() => null);
          // Yield so an overlapping owner is observed rather than missed.
          await Bun.sleep(0);
          // A second reclaimer shows up here even when the two critical
          // sections don't overlap in wall-clock: it removes the file this
          // owner holds. The lock must be untouched for a held generation.
          const now = await Bun.file(lockPath).json().catch(() => null);
          if (now?.token !== mine?.token) {
            stolen.push(`round ${round}: held lock replaced (${mine?.token} -> ${now?.token})`);
          }
          owners--;
          await lock.release();
        })
      );
      // Every round must end with the lock free for the next seed.
      if (await Bun.file(lockPath).exists()) await unlink(lockPath);
    }

    expect(overlaps).toEqual([]);
    expect(stolen).toEqual([]);
    expect(maxOwners).toBe(1);
    // Sanity: reclamation really happened — exactly one contender per round.
    expect(reclaims).toBeGreaterThanOrEqual(ROUNDS);
    // Reclamation bookkeeping must not litter the agents directory.
    expect(await readdir(tempDir)).toEqual(["agent-stale"]);
  }, 120_000);
});

// ── operation marker: RMW helper, set/clear, back-compat ─────────────────────

describe("updateAgentTransient / setAgentOperation / clearAgentOperation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-op-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("updateAgentTransient seeds a zeroed transient when none exists", async () => {
    await updateAgentTransient(tempDir, (cur) => ({ ...cur, watchdog_pid: 777 }));
    const result = await readAgentTransient(tempDir);
    expect(result).toEqual({
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: 0,
      watchdog_pid: 777,
      last_restarted_at_ms: null,
      restart_compact_escape_sent_at_ms: null,
      operation: null,
    });
  });

  test("a transient write dropped for want of the lock leaves a trace", async () => {
    // Silently dropping is not free: clearAgentOperation routes through
    // updateAgentTransient, so a lock timeout leaves a stale operation marker
    // and the agent renders merging/restarting for up to OP_STUCK_TIMEOUT_MS
    // with nothing in the audit trail to explain it.
    const logDir = await mkdtemp(join(tmpdir(), "transient-drop-log-"));
    const logPath = join(logDir, "watch.log");
    const { setWatchLogPath, resetWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
    // A live owner holding the lock: never reclaimable, so acquisition times out.
    await Bun.write(
      `${tempDir}.lifecycle.lock`,
      JSON.stringify({ pid: process.pid, created_at_ms: Date.now(), token: "held" })
    );
    try {
      await updateAgentTransient(tempDir, (cur) => ({ ...cur, watchdog_pid: 5 }));
      expect(await readAgentTransient(tempDir)).toBeNull();

      const { readFile } = await import("fs/promises");
      const log = await readFile(logPath, "utf8");
      expect(log).toContain("[lifecycle] transient write dropped");
      expect(log).toContain("reason=lifecycle lock unavailable");

      // Rate-limited: the watchdog retries every 5s, and a flood would rotate
      // away the history this line exists to provide.
      await updateAgentTransient(tempDir, (cur) => ({ ...cur, watchdog_pid: 6 }));
      const after = await readFile(logPath, "utf8");
      expect(
        after.split("\n").filter((l) => l.includes("transient write dropped"))
      ).toHaveLength(1);
    } finally {
      resetWatchLogPath();
      resetLifecycleLogState();
      await rm(`${tempDir}.lifecycle.lock`, { force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("updateAgentTransient is ENOENT-safe (missing dir does not throw)", async () => {
    const missing = join(tempDir, "does", "not", "exist");
    // Should not throw — best-effort.
    await updateAgentTransient(missing, (cur) => ({ ...cur, watchdog_pid: 1 }));
    expect(await readAgentTransient(missing)).toBeNull();
  });

  test("setAgentOperation writes the operation field, preserving other fields", async () => {
    await writeAgentTransient(tempDir, {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: true,
      updated_at_ms: 42,
      watchdog_pid: 9,
    });
    const op: AgentOperation = { kind: "merging", pid: 1234, started_at_ms: 99 };
    await setAgentOperation(tempDir, op);
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toEqual(op);
    // Other fields untouched (RMW, not overwrite).
    expect(result?.tmux_compacting).toBe(true);
    expect(result?.has_background_tasks).toBe(true);
    expect(result?.updated_at_ms).toBe(42);
    expect(result?.watchdog_pid).toBe(9);
  });

  test("clearAgentOperation removes the operation, preserving other fields", async () => {
    // The marker must belong to THIS process for the compare-and-swap clear to fire.
    await setAgentOperation(tempDir, { kind: "restarting", pid: process.pid, started_at_ms: 7 });
    await updateAgentTransient(tempDir, (cur) => ({ ...cur, watchdog_pid: 321 }));
    await clearAgentOperation(tempDir);
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toBeNull();
    expect(result?.watchdog_pid).toBe(321);
  });

  test("clearAgentOperation (CAS) clears a marker owned by THIS process", async () => {
    await setAgentOperation(tempDir, { kind: "merging", pid: process.pid, started_at_ms: 7 });
    await clearAgentOperation(tempDir);
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toBeNull();
  });

  test("clearAgentOperation (CAS) does NOT clear a marker owned by a DIFFERENT pid", async () => {
    // Models the age-reclaim race: op B reclaimed an old marker (so the on-disk
    // pid is B's, not ours), then op A's late `finally` calls clearAgentOperation.
    // A must NOT wipe B's marker. Use a sentinel pid that is not this process.
    const otherPid = process.pid + 1;
    const op: AgentOperation = { kind: "restarting", pid: otherPid, started_at_ms: 7 };
    await setAgentOperation(tempDir, op);
    await clearAgentOperation(tempDir);
    const result = await readAgentTransient(tempDir);
    // The other process's marker survives unchanged.
    expect(result?.operation).toEqual(op);
  });

  test("clearAgentOperation on a removed dir does not throw (ENOENT swallowed)", async () => {
    await setAgentOperation(tempDir, { kind: "merging", pid: 5, started_at_ms: 7 });
    await rm(tempDir, { recursive: true, force: true });
    // No throw — mirrors the post-merge success path where the dir is gone.
    await clearAgentOperation(tempDir);
    expect(await readAgentTransient(tempDir)).toBeNull();
  });

  test("watchdog-style write preserves an existing operation field", async () => {
    // Simulate: merge sets the op, then the watchdog's 5s tick writes its tmux
    // snapshot via updateAgentTransient. The op must survive.
    await setAgentOperation(tempDir, { kind: "merging", pid: 100, started_at_ms: 50 });
    await updateAgentTransient(tempDir, (cur) => ({
      ...cur,
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: 5000,
      watchdog_pid: 200,
    }));
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toEqual({ kind: "merging", pid: 100, started_at_ms: 50 });
    expect(result?.tmux_compacting).toBe(true);
    expect(result?.watchdog_pid).toBe(200);
  });

  test("concurrent transient writers are serialized without lost fields", async () => {
    await Promise.all([
      updateAgentTransient(tempDir, (cur) => ({
        ...cur,
        watchdog_pid: 200,
        watchdog_pid_epoch: 1_700_000_000,
      })),
      updateAgentTransient(tempDir, (cur) => ({
        ...cur,
        tmux_compacting: true,
      })),
    ]);

    const result = await readAgentTransient(tempDir);
    expect(result?.watchdog_pid).toBe(200);
    expect(result?.watchdog_pid_epoch).toBe(1_700_000_000);
    expect(result?.tmux_compacting).toBe(true);
  });

  test("concurrent lifecycle claims admit exactly one operation", async () => {
    isPidAliveCtx.set(() => true);

    const results = await Promise.all([
      claimAgentOperation(tempDir, "merging"),
      claimAgentOperation(tempDir, "restarting"),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const refused = results.find((result) => !result.ok);
    expect(refused && !refused.ok ? refused.operation?.pid : undefined).toBe(process.pid);
  });

  test("back-compat: transient without operation reads with operation: null", async () => {
    await Bun.write(
      join(tempDir, "meta.transient.json"),
      JSON.stringify({
        tmux_compacting: false,
        tmux_rate_limited: false,
        tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
        has_background_tasks: false,
        updated_at_ms: 1,
        watchdog_pid: 1,
      }),
    );
    const result = await readAgentTransient(tempDir);
    expect(result?.operation).toBeNull();
  });

  test("back-compat: malformed operation is ignored without failing the read", async () => {
    const cases: unknown[] = [
      "not-an-object",
      { kind: "bogus_kind", pid: 1, started_at_ms: 1 }, // invalid kind
      { kind: "merging", pid: 0, started_at_ms: 1 }, // pid not > 0
      { kind: "merging", pid: -3, started_at_ms: 1 }, // negative pid
      { kind: "merging", pid: 1, started_at_ms: 0 }, // started_at_ms not > 0
      { kind: "merging", pid: "x", started_at_ms: 1 }, // pid wrong type
      { pid: 1, started_at_ms: 1 }, // missing kind
    ];
    for (const bad of cases) {
      await Bun.write(
        join(tempDir, "meta.transient.json"),
        JSON.stringify({
          tmux_compacting: false,
          tmux_rate_limited: false,
          tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
          has_background_tasks: false,
          updated_at_ms: 1,
          watchdog_pid: 1,
          operation: bad,
        }),
      );
      const result = await readAgentTransient(tempDir);
      // The whole read still succeeds; the malformed op is treated as absent.
      expect(result).not.toBeNull();
      expect(result?.operation).toBeNull();
    }
  });

  test("a well-formed operation of each kind round-trips", async () => {
    for (const kind of ["merge_check", "merging", "restarting"] as const) {
      await setAgentOperation(tempDir, { kind, pid: 11, started_at_ms: 22 });
      const result = await readAgentTransient(tempDir);
      expect(result?.operation).toEqual({ kind, pid: 11, started_at_ms: 22 });
    }
  });
});

// ── detectAgentStates — operation op-branch (merging/restarting/op_stuck) ─────

describe("detectAgentStates — operation op-branch", () => {
  let tempDir: string;

  /** Build an agent backed by a real dir, with an explicit claude_pid. */
  async function makeOpAgent(id: string, claudePid: string): Promise<Agent> {
    const agentDir = join(tempDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    return makeAgent({
      id,
      repoPath: tempDir,
      meta: {
        state: "running",
        tmux_session: `ib-${id}`,
        created_epoch: Math.floor(Date.now() / 1000) - 60,
        claude_pid: claudePid,
      } as Partial<AgentMeta> as AgentMeta,
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-opbranch-"));
  });
  afterEach(async () => {
    isPidAliveCtx.reset();
    nowMsCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("fresh, live merging op → state=merging", async () => {
    const a = await makeOpAgent("agent-m", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true); // op holder + claude both alive
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("merging");
  });

  test("fresh, live merge_check op → state=merging (collapsed render label)", async () => {
    const a = await makeOpAgent("agent-mc", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merge_check", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("merging");
  });

  test("fresh, live restarting op → state=restarting", async () => {
    const a = await makeOpAgent("agent-r", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "restarting", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("restarting");
  });

  test("op older than OP_STUCK_TIMEOUT_MS → state=op_stuck", async () => {
    const a = await makeOpAgent("agent-old", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true); // holder alive, but op too old
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, {
      kind: "merging",
      pid: 4242,
      started_at_ms: now - OP_STUCK_TIMEOUT_MS - 1, // just past the timeout
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("op_stuck");
  });

  test("op just under OP_STUCK_TIMEOUT_MS stays merging (boundary)", async () => {
    const a = await makeOpAgent("agent-edge", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => true);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, {
      kind: "merging",
      pid: 4242,
      started_at_ms: now - OP_STUCK_TIMEOUT_MS, // exactly at the timeout → not yet stuck (> comparison)
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("merging");
  });

  test("op holder dead → state=op_stuck (even with a fresh started_at)", async () => {
    const a = await makeOpAgent("agent-deadholder", "12345");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    // claude_pid 12345 alive, op holder 4242 dead.
    isPidAliveCtx.set((pid: number) => pid !== 4242);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: now - 100 });

    await detectAgentStates([a]);
    expect(a.state).toBe("op_stuck");
  });

  // THE ORDERING REGRESSION GUARD (the showstopper):
  // A wedged merge KILLS claude_pid before removing the dir. The op-branch
  // must run ABOVE the claude_pid liveness gate. This case has a DEAD
  // claude_pid but a LIVE, fresh op holder, so the correct result is the
  // in-flight `merging` label — NOT `stopped`. If the op-branch were placed
  // below the claude_pid gate, the dead claude_pid would paint "stopped"
  // first and the op state would never be reached. (The op_stuck variant —
  // dead holder — is covered by the next test.)
  test("operation set + dead claude_pid + live holder → merging, NOT stopped (op-branch runs above the claude_pid gate)", async () => {
    const a = await makeOpAgent("agent-wedged", "99999");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    // claude_pid 99999 is DEAD; the op holder 4242 is ALIVE (the merge is
    // still grinding away in another process).
    isPidAliveCtx.set((pid: number) => pid === 4242);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("merging"); // live holder, fresh → merging, definitely not stopped
  });

  test("operation set + DEAD claude_pid + DEAD holder → op_stuck (NOT stopped)", async () => {
    const a = await makeOpAgent("agent-crashed", "99999");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    // Both the recorded claude_pid AND the op holder are dead (crash mid-merge).
    // The claude_pid gate, if it ran first, would paint "stopped"; the op-branch
    // above it must win and paint "op_stuck".
    isPidAliveCtx.set(() => false);
    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await setAgentOperation(agentDir, { kind: "merging", pid: 4242, started_at_ms: now - 1_000 });

    await detectAgentStates([a]);
    expect(a.state).toBe("op_stuck");
  });

  test("no operation + dead claude_pid still resolves to stopped (gate unchanged)", async () => {
    const a = await makeOpAgent("agent-nostop", "99999");
    const now = 10_000_000;
    nowMsCtx.set(() => now);
    isPidAliveCtx.set(() => false); // claude_pid dead, no op
    // No operation set.

    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
  });
});

// ── detectAgentStates — meta.transient.json fast-path ────────────────────────

describe("detectAgentStates — meta.transient.json fast-path", () => {
  let tempDir: string;
  let captureCalls: number;

  /** Mock spawn runner that counts capture-pane calls and returns plain output. */
  function installSpyCapture(output = "ordinary output\n"): void {
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const isCapture = args[0] === "tmux" && args[1] === "capture-pane";
      if (isCapture) captureCalls++;
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(isCapture ? output : ""));
            c.close();
          },
        }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
  }

  /** Build an agent backed by a real .ittybitty/agents/<id>/ directory. */
  async function makeBackedAgent(id: string, metaState: "running" | "waiting" = "running"): Promise<Agent> {
    const agentDir = join(tempDir, ".ittybitty", "agents", id);
    await mkdir(agentDir, { recursive: true });
    return makeAgent({
      id,
      repoPath: tempDir,
      meta: {
        state: metaState,
        tmux_session: `ib-${id}`,
        created_epoch: Math.floor(Date.now() / 1000) - 60,
      } as Partial<AgentMeta> as AgentMeta,
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-fastpath-"));
    captureCalls = 0;
    liveTmuxSessionsCtx.set(async () => new Set([
      "ib-agent-deadwd",
      "ib-agent-stale",
      "ib-agent-missing",
      "ib-agent-seed",
      "ib-agent-wdrecycled",
      "ib-agent-wdlegacy",
    ]));
  });

  afterEach(async () => {
    tmuxPollerSpawnCtx.reset();
    isPidAliveCtx.reset();
    liveTmuxSessionsCtx.reset();
    nowMsCtx.reset();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("trusts fresh transient file (watchdog alive) — no tmux capture", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-fastpath");

    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 1_000, // 1s old, fresh
      watchdog_pid: 99999,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(0);
  });

  test("trusts fresh transient with tmux_compacting → state=compacting", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-compact");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("compacting");
    expect(captureCalls).toBe(0);
  });

  test("trusts fresh transient with tmux_rate_limited → state=rate_limited", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-rl");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: true,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("rate_limited");
    expect(captureCalls).toBe(0);
  });

  test("trusts fresh transient with tmux_api_safeguard → state=api_safeguard", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-safeguard");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: true,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("api_safeguard");
    expect(captureCalls).toBe(0);
  });

  test("waiting + has_background_tasks via fast-path → state=running", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-bg", "waiting");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: true,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(0);
  });

  test("falls back to tmux capture when watchdog PID is dead", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-deadwd");
    isPidAliveCtx.set(() => false);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true, // would say compacting via fast-path
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 99999,
    });

    await detectAgentStates([a]);
    // With dead watchdog, fast-path is bypassed; tmux capture sees plain output.
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("falls back when the watchdog PID was recycled", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-wdrecycled");
    // Exercise the real guarded liveness check instead of the bare-PID seam.
    isPidAliveSinceCtx.reset();
    resetProcessStartEpochSecondsCache();
    // Signal 0 says the numeric PID exists, but it started long after the
    // watchdog wrote its epoch — a different process wearing the same number.
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(() => 1_800_000_000);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true, // would say compacting via fast-path if trusted
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 99999,
      watchdog_pid_epoch: 1_700_000_000,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("trusts a legacy transient that predates watchdog_pid_epoch", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-wdlegacy");
    isPidAliveSinceCtx.reset();
    resetProcessStartEpochSecondsCache();
    isPidAliveCtx.set(() => true);
    // Would fail an epoch comparison — but there is no epoch to compare, so the
    // historical PID-only behavior must be preserved.
    processStartEpochSecondsCtx.set(() => 1_800_000_000);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 99999,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("compacting");
    expect(captureCalls).toBe(0);
  });

  test("falls back when transient is older than TRANSIENT_FRESH_MS", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-stale");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true, // would say compacting via fast-path
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - TRANSIENT_FRESH_MS - 1,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("falls back when transient file is missing", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-missing");
    isPidAliveCtx.set(() => true);

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("falls back when transient.updated_at_ms is 0 (PID-only seed)", async () => {
    installSpyCapture();
    const a = await makeBackedAgent("agent-seed");
    isPidAliveCtx.set(() => true);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);
    await writeAgentTransient(agentDir, {
      tmux_compacting: true, // would say compacting via fast-path if trusted
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: 0,
      watchdog_pid: 12345,
    });

    await detectAgentStates([a]);
    expect(a.state).toBe("running");
    expect(captureCalls).toBe(1);
  });

  test("re-reads disk snapshot every call (no in-memory caching of transient state)", async () => {
    // detectAgentStates was previously refactored to prefer a preloaded
    // `agent.transient` field over the disk read. That broke pollStates'
    // 2s polling cadence: the watcher reuses _lastAgents from a 10s-old
    // refresh() while the watchdog writes fresh disk snapshots every 5s,
    // so the in-memory copy aged out of the freshness window before disk
    // staleness ever became an issue. The fix removed Agent.transient
    // entirely; this test guards against re-introducing a memory cache
    // by verifying the disk snapshot drives the resolved state on every
    // call (no preload setup possible).
    installSpyCapture();
    const a = await makeBackedAgent("agent-disk-read");
    isPidAliveCtx.set(() => true);
    const fakeNow = 5_000_000;
    nowMsCtx.set(() => fakeNow);

    const agentDir = join(tempDir, ".ittybitty", "agents", a.id);

    // First call: disk says rate_limited
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: true,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 100,
      watchdog_pid: 12345,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("rate_limited");

    // Second call after the watchdog rewrites disk: state must follow
    // the new disk content, not the old. If detectAgentStates were
    // caching transient in-memory, it would still return rate_limited.
    await writeAgentTransient(agentDir, {
      tmux_compacting: true,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: fakeNow - 50,
      watchdog_pid: 12345,
    });
    await detectAgentStates([a]);
    expect(a.state).toBe("compacting");
    expect(captureCalls).toBe(0);
  });
});

// ── archive cleanup deletes meta.transient.json ─────────────────────────────

describe("archive cleanup deletes meta.transient.json", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-archive-transient-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("archiveAgent deletes meta.transient.json", async () => {
    const { archiveAgent } = await import("./agent-lifecycle");

    const agentDir = join(tempDir, ".ittybitty", "agents", "agent-arch");
    await mkdir(agentDir, { recursive: true });
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({ id: "agent-arch" }));
    await writeAgentTransient(agentDir, {
      tmux_compacting: false,
      tmux_rate_limited: false,
      tmux_api_error: false, tmux_api_terms: false, tmux_api_safeguard: false,
      has_background_tasks: false,
      updated_at_ms: Date.now(),
      watchdog_pid: 12345,
    });

    expect(await readAgentTransient(agentDir)).not.toBeNull();
    await archiveAgent(tempDir, "agent-arch", agentDir);
    expect(await readAgentTransient(agentDir)).toBeNull();
  });
});

// ── readAgentMeta mtime cache (Phase 2) ─────────────────────────────────────

describe("readAgentMeta mtime cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "itsybitsy-metacache-"));
    resetReadAgentMetaCache();
  });

  afterEach(async () => {
    resetReadAgentMetaCache();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns same data on consecutive reads", async () => {
    const agentDir = tempDir;
    await Bun.write(join(agentDir, "meta.json"), JSON.stringify({
      id: "agent-cache",
      tmux_session: "ib-agent-cache",
    }));
    const a = await readAgentMeta(agentDir);
    const b = await readAgentMeta(agentDir);
    expect(a.meta?.id).toBe("agent-cache");
    expect(b.meta?.id).toBe("agent-cache");
  });

  test("re-parses when mtime changes", async () => {
    const agentDir = tempDir;
    const path = join(agentDir, "meta.json");
    await Bun.write(path, JSON.stringify({ id: "agent-cache" }));
    const a = await readAgentMeta(agentDir);
    expect(a.meta?.tmux_session).toBe("");

    // Bump mtime by writing different content. Sleep 5ms first to ensure
    // the new mtime differs from the old one even on coarse-grained FS clocks.
    await Bun.sleep(5);
    await Bun.write(path, JSON.stringify({ id: "agent-cache", tmux_session: "ib-new" }));
    const b = await readAgentMeta(agentDir);
    expect(b.meta?.tmux_session).toBe("ib-new");
  });

  test("final pre-teardown read bypasses the mtime cache", async () => {
    const { stat, utimes } = await import("fs/promises");
    const path = join(tempDir, "meta.json");
    await Bun.write(path, JSON.stringify({ id: "agent-gen", created_epoch: 1_700_000_000 }));
    const stamps = await stat(path);
    expect((await readAgentMeta(tempDir)).meta?.created_epoch).toBe(1_700_000_000);

    // A rewrite landing inside the filesystem's timestamp granularity is
    // indistinguishable from no write at all to an mtime-keyed cache.
    await Bun.write(path, JSON.stringify({ id: "agent-gen", created_epoch: 1_700_000_500 }));
    await utimes(path, stamps.atime, stamps.mtime);
    expect((await readAgentMeta(tempDir)).meta?.created_epoch).toBe(1_700_000_000);

    // The destructive path must never revalidate against that copy.
    reapReadAgentMetaCtx.reset();
    const latest = await reapReadAgentMetaCtx.fn(tempDir, makeAgent({ id: "agent-gen" }));
    expect(latest?.created_epoch).toBe(1_700_000_500);
  });

  test("returns 'Missing' error when meta.json absent", async () => {
    const result = await readAgentMeta(tempDir);
    expect(result.meta).toBeNull();
    expect(result.error).toContain("Missing");
  });

  test("caller can mutate returned meta without polluting cache", async () => {
    await Bun.write(join(tempDir, "meta.json"), JSON.stringify({
      id: "agent-mut",
      tmux_session: "ib-original",
    }));
    const first = await readAgentMeta(tempDir);
    if (first.meta) first.meta.tmux_session = "ib-mutated";
    const second = await readAgentMeta(tempDir);
    expect(second.meta?.tmux_session).toBe("ib-original");
  });

  test("caller can mutate nested spawned_by without polluting cache", async () => {
    await Bun.write(join(tempDir, "meta.json"), JSON.stringify({
      id: "agent-nested",
      tmux_session: "ib-orig",
      spawned_by: { agent_id: "spawner-1", repo_path: "/orig/path" },
    }));
    const first = await readAgentMeta(tempDir);
    if (first.meta?.spawned_by) {
      first.meta.spawned_by.agent_id = "POLLUTED";
      first.meta.spawned_by.repo_path = "/polluted/path";
    }
    const second = await readAgentMeta(tempDir);
    expect(second.meta?.spawned_by?.agent_id).toBe("spawner-1");
    expect(second.meta?.spawned_by?.repo_path).toBe("/orig/path");
  });

  // copyAgentMeta replaced structuredClone for performance. The cache-HIT path
  // must keep the same isolation: mutating spawned_by on a copy returned from a
  // cache hit must not pollute a subsequent cached read, and the two returned
  // copies must not share the same object/spawned_by reference.
  test("cache-hit copies are isolated — distinct objects, mutation does not leak", async () => {
    await Bun.write(join(tempDir, "meta.json"), JSON.stringify({
      id: "agent-hit",
      tmux_session: "ib-orig",
      spawned_by: { agent_id: "spawner-1", repo_path: "/orig/path" },
    }));
    // First read = cache miss (populates cache).
    const miss = await readAgentMeta(tempDir);
    // Second read = cache hit.
    const hit1 = await readAgentMeta(tempDir);
    // Distinct top-level objects and distinct nested spawned_by objects.
    expect(hit1.meta).not.toBe(miss.meta);
    expect(hit1.meta?.spawned_by).not.toBe(miss.meta?.spawned_by);
    // Mutate the cache-hit copy's nested object.
    if (hit1.meta?.spawned_by) {
      hit1.meta.spawned_by.agent_id = "POLLUTED";
      hit1.meta.spawned_by.repo_path = "/polluted/path";
    }
    if (hit1.meta) hit1.meta.tmux_session = "ib-mutated";
    // A subsequent cache hit must still see the original canonical values.
    const hit2 = await readAgentMeta(tempDir);
    expect(hit2.meta?.spawned_by?.agent_id).toBe("spawner-1");
    expect(hit2.meta?.spawned_by?.repo_path).toBe("/orig/path");
    expect(hit2.meta?.tmux_session).toBe("ib-orig");
  });

  // FIX 3 (sync guard): copyAgentMeta must deep-copy EVERY nested mutable
  // (object/array) field of AgentMeta — a shallow spread aliases such fields
  // between the cached canonical reference and the returned copy, so a caller
  // mutation would silently pollute the cache for every later reader. This
  // test has two layers that together fail if a future nested field is added
  // without a matching deep copy in copyAgentMeta:
  //
  //  1. Compile-time: REQUIRED_DEEP_COPY is typed as a record over exactly the
  //     nested-mutable keys of AgentMeta. Adding a new object/array field to
  //     AgentMeta makes this object literal fail to typecheck until the field
  //     is listed here (and, by the reviewer's intent, deep-copied in
  //     copyAgentMeta) — caught by `bunx tsc --noEmit`.
  //  2. Runtime: every nested field is populated, read through the cache twice,
  //     and the first copy's nested fields are mutated; the second cached read
  //     must be untouched, and each nested field must be a DISTINCT object
  //     reference from the cached canonical one. A forgotten deep copy makes
  //     the references identical and the mutation leak — failing the asserts.
  test("copyAgentMeta isolates every nested AgentMeta field (deep-copy guard)", async () => {
    // Distinguish nested mutable (object/array) fields from primitive ones,
    // stripping the optional `undefined`/`null` parts of each field's type.
    type NonNull<T> = Exclude<T, null | undefined>;
    type IsNested<V> = NonNull<V> extends object ? true : false;
    type NestedMutableKeys<T> = {
      [K in keyof T]-?: IsNested<T[K]> extends true ? K : never;
    }[keyof T];

    // The author MUST list every nested-mutable AgentMeta field here. If a new
    // object/array field is added to AgentMeta, this literal stops compiling
    // ("Property '<field>' is missing") — the type-level half of the guard.
    const REQUIRED_DEEP_COPY: Record<NestedMutableKeys<AgentMeta>, true> = {
      spawned_by: true,
    };

    // Construct a meta with every known nested mutable field populated.
    const spawnedBy: SpawnedBy = { agent_id: "spawner-1", repo_path: "/orig/path" };
    await Bun.write(join(tempDir, "meta.json"), JSON.stringify({
      id: "agent-deepcopy",
      tmux_session: "ib-orig",
      spawned_by: spawnedBy,
    }));

    // First read = cache miss (populates the canonical cache entry).
    const first = await readAgentMeta(tempDir);
    expect(first.meta).not.toBeNull();

    // Every nested field on the returned copy must be a DISTINCT object from a
    // subsequent canonical read — the necessary condition for deep isolation.
    // Driven off REQUIRED_DEEP_COPY so a newly-added (and listed) field is
    // automatically exercised here too.
    const canonicalProbe = await readAgentMeta(tempDir);
    for (const key of Object.keys(REQUIRED_DEEP_COPY) as NestedMutableKeys<AgentMeta>[]) {
      const a = first.meta?.[key];
      const b = canonicalProbe.meta?.[key];
      if (a != null && typeof a === "object") {
        expect(a).not.toBe(b);
      }
    }

    // Mutate every nested field on the first copy.
    if (first.meta?.spawned_by) {
      first.meta.spawned_by.agent_id = "POLLUTED";
      first.meta.spawned_by.repo_path = "/polluted/path";
    }

    // A fresh read must see the original canonical values — no leak.
    const second = await readAgentMeta(tempDir);
    expect(second.meta?.spawned_by?.agent_id).toBe("spawner-1");
    expect(second.meta?.spawned_by?.repo_path).toBe("/orig/path");
  });

  test("invalidates cache after .tmp + rename write pattern", async () => {
    const path = join(tempDir, "meta.json");
    const tmpPath = path + ".tmp";
    await Bun.write(path, JSON.stringify({ id: "agent-rename", tmux_session: "ib-v1" }));
    const a = await readAgentMeta(tempDir);
    expect(a.meta?.tmux_session).toBe("ib-v1");

    // Sleep so the new file's mtime is observably newer than the old one.
    await Bun.sleep(5);
    // .tmp + rename is the actual production write pattern (writeAgentState,
    // writeAgentTransient). The cache must invalidate when the inode behind
    // meta.json changes via rename, not just in-place writes.
    await Bun.write(tmpPath, JSON.stringify({ id: "agent-rename", tmux_session: "ib-v2" }));
    const { rename } = await import("fs/promises");
    await rename(tmpPath, path);
    const b = await readAgentMeta(tempDir);
    expect(b.meta?.tmux_session).toBe("ib-v2");
  });
});

describe("isPidAliveSinceCtx — recycled PID guard", () => {
  const pidWriteEpoch = 1_700_000_000;

  beforeEach(() => {
    isPidAliveSinceCtx.reset();
  });

  afterEach(() => {
    isPidAliveCtx.reset();
  });

  test("recycled live PID started after claude_pid_epoch plus margin is not alive", () => {
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(
      () => pidWriteEpoch + CLAUDE_PID_START_MARGIN_SECONDS + 1
    );

    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(false);
  });

  test("unrelated live PID started before claude_pid_epoch minus margin is not alive", () => {
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(
      () => pidWriteEpoch - CLAUDE_PID_START_MARGIN_SECONDS - 1
    );

    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(false);
  });

  test("live PID started at or before claude_pid_epoch plus margin is alive", () => {
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(
      () => pidWriteEpoch + CLAUDE_PID_START_MARGIN_SECONDS
    );

    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(true);
  });

  test("live PID with unavailable process start time fails open as alive", () => {
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(() => null);

    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(true);
  });

  test("missing claude_pid_epoch preserves PID-only compatibility", () => {
    let startTimeCalls = 0;
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(() => {
      startTimeCalls++;
      return pidWriteEpoch;
    });

    expect(isPidAliveSinceCtx.fn(18825, undefined)).toBe(true);
    expect(startTimeCalls).toBe(0);
  });

  test("repeated checks for one PID within the TTL read process start once", () => {
    let startTimeCalls = 0;
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(() => {
      startTimeCalls++;
      return pidWriteEpoch;
    });

    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(true);
    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(true);
    expect(startTimeCalls).toBe(1);
  });

  // The rendering-side cache is deliberately long-lived (PROCESS_START_CACHE_TTL_MS)
  // because each miss costs a posix_spawn of `ps` on the watch loop's hot path,
  // twice per agent per pass. That is only sound because destructive signalling
  // never reads it — _isPidIdentityCurrent drops the entry and re-probes.
  // Without that bypass, a longer TTL WOULD weaken teardown safety.
  test("destructive identity check ignores the rendering cache, however stale", () => {
    isPidIdentityCurrentCtx.reset();
    isPidAliveCtx.set(() => true);
    processStartEpochSecondsCtx.set(() => pidWriteEpoch);
    // Warm the rendering cache with a matching start.
    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(true);

    // The PID is recycled: same number, a process that started much later.
    processStartEpochSecondsCtx.set(
      () => pidWriteEpoch + CLAUDE_PID_START_MARGIN_SECONDS + 1
    );
    // Rendering still trusts the cached value — that is the whole point of it.
    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(true);
    // Signalling must not. It re-probes and sees the recycled generation.
    expect(isPidIdentityCurrentCtx.fn(18825, pidWriteEpoch)).toBe(false);
  });

  test("dead PID is not alive and does not query its start time", () => {
    let startTimeCalls = 0;
    isPidAliveCtx.set(() => false);
    processStartEpochSecondsCtx.set(() => {
      startTimeCalls++;
      return pidWriteEpoch;
    });

    expect(isPidAliveSinceCtx.fn(18825, pidWriteEpoch)).toBe(false);
    expect(startTimeCalls).toBe(0);
  });
});

// Regression: inside a codex agent sandbox, process.kill(pid, 0) against a PID
// owned by another sandbox (or root) returns EPERM, not ESRCH. The previous
// catch-all branch returned `false` for EPERM and detectAgentStates resolved
// every external agent to "stopped" → reapOrphanedClaude SIGTERM'd them all.
describe("_isPidAlive — EPERM vs ESRCH classification", () => {
  let origKill: typeof process.kill;
  beforeEach(() => {
    origKill = process.kill;
  });
  afterEach(() => {
    process.kill = origKill;
  });

  test("returns true when process.kill throws EPERM (alive but unsignal-able)", () => {
    process.kill = ((_pid: number, _sig?: any) => {
      const err: any = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    }) as unknown as typeof process.kill;
    expect(_isPidAliveForTests(99999)).toBe(true);
  });

  test("returns false when process.kill throws ESRCH (no such process)", () => {
    process.kill = ((_pid: number, _sig?: any) => {
      const err: any = new Error("no such process");
      err.code = "ESRCH";
      throw err;
    }) as unknown as typeof process.kill;
    expect(_isPidAliveForTests(99999)).toBe(false);
  });

  test("unexpected process probe errors are unknown and fail open as alive", () => {
    process.kill = ((_pid: number, _sig?: any) => {
      const err: any = new Error("invalid signal");
      err.code = "EINVAL";
      throw err;
    }) as unknown as typeof process.kill;
    expect(_isPidAliveForTests(99999)).toBe(true);
  });

  test("returns true when process.kill succeeds (signal delivered, process alive)", () => {
    process.kill = ((_pid: number, _sig?: any) => true) as unknown as typeof process.kill;
    expect(_isPidAliveForTests(99999)).toBe(true);
  });
});

// Regression: read-only callers (ib list, ib roster, ib info, inject-status)
// must NOT reap. Previously detectAgentStates unconditionally SIGTERM'd any
// agent whose claude_pid looked dead — inside a codex sandbox EPERM was
// misread as dead, so every read of agent state tore down the world.
//
// reapOrphanedClaude has two visible side-effects:
//   1. SIGTERM via killPidCtx (only fires when the inner isPidAliveCtx says
//      the PID is alive)
//   2. `tmux kill-session` via tmuxPollerSpawnCtx (always fires for
//      resolvedState === "stopped" + tmux_session set, regardless of PID
//      liveness)
//
// These tests assert side-effect #2 — it's the unconditional one and the
// most direct proof that reapOrphanedClaude was (or wasn't) reached.
describe("detectAgentStates — reap option", () => {
  let tmpLogDir: string;
  let logPath: string;
  let killSessionCalls: string[];

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "reap-option-log-"));
    logPath = join(tmpLogDir, "watch.log");
    resetReapedTmuxSessions();
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
    killSessionCalls = [];
    // Stub the tmux runner so a `tmux kill-session -t <name>` invocation is
    // captured (and otherwise lets capture-pane / other commands succeed).
    tmuxPollerSpawnCtx.set(((args: any[]) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv[0] === "tmux" && argv[1] === "kill-session") {
        const tIdx = argv.indexOf("-t");
        if (tIdx >= 0 && typeof argv[tIdx + 1] === "string") {
          killSessionCalls.push(argv[tIdx + 1]);
        }
      }
      return {
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
      };
    }) as any);
  });

  afterEach(async () => {
    classifySpawnLogCtx.reset();
    isPidAliveCtx.reset();
    killPidCtx.reset();
    liveTmuxSessionsCtx.reset();
    tmuxPollerSpawnCtx.reset();
    resetReapedTmuxSessions();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  test("reap: false — does NOT call reapOrphanedClaude when claude_pid reads dead", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-2",
      meta: {
        state: "running",
        tmux_session: "ib-a2",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: false });
    // State still resolves correctly — only the reap side-effect is skipped.
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0);
    expect(killSessionCalls).toEqual([]);
  });

  test("reap: false — does NOT tear down husk tmux for complete-with-dead-session", async () => {
    isPidAliveCtx.set(() => true);
    liveTmuxSessionsCtx.set(async () => new Set([])); // session is gone
    probeTmuxSessionCtx.set(async () => ({
      status: "missing",
      error: "can't find session: ib-a3",
    }));
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const a = makeAgent({
      id: "agent-3",
      meta: {
        state: "complete",
        tmux_session: "ib-a3",
        claude_pid: "12345",
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: false });
    expect(a.state).toBe("stopped");
    expect(killCalls).toBe(0);
    expect(killSessionCalls).toEqual([]);
  });

  test("reap: false — does NOT reap in the no-tmux_session branch", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => true); // PID looks alive → SIGTERM would fire if reaped
    const killCalls: number[] = [];
    killPidCtx.set((pid) => { killCalls.push(pid); return true; });

    const a = makeAgent({
      id: "agent-4",
      meta: {
        tmux_session: "",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    await detectAgentStates([a], { reap: false });
    expect(a.state).toBe("stopped");
    expect(killCalls).toEqual([]);
  });

  test("reap: true — DOES reap when claude_pid reads dead (husk tmux torn down)", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    killPidCtx.set(() => true);
    // D3: the husk session must be LIVE for teardown to fire — a husk that
    // outlived Claude is exactly the session we want to kill.
    liveTmuxSessionsCtx.set(async () => new Set(["ib-a5"]));

    const a = makeAgent({
      id: "agent-5",
      meta: {
        state: "running",
        tmux_session: "ib-a5",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    // Explicit opt-in. The husk tmux teardown fires inside reapOrphanedClaude
    // when resolvedState === "stopped", tmux_session is set, AND the session is
    // still live — proves we reached it.
    await detectAgentStates([a], { reap: true });
    expect(a.state).toBe("stopped");
    expect(killSessionCalls).toEqual(["=ib-a5:"]);
  });

  test("default (no opts) — does NOT reap (opt-in semantics)", async () => {
    classifySpawnLogCtx.set(async () => ({ kind: "orphan" }));
    isPidAliveCtx.set(() => false);
    killPidCtx.set(() => true);

    const a = makeAgent({
      id: "agent-6",
      meta: {
        state: "running",
        tmux_session: "ib-a6",
        claude_pid: "12345",
        created_epoch: Math.floor(Date.now() / 1000) - 3600,
      } as Partial<AgentMeta> as AgentMeta,
    });
    // No opts → reap defaults to false. Husk tmux must remain intact.
    await detectAgentStates([a]);
    expect(a.state).toBe("stopped");
    expect(killSessionCalls).toEqual([]);
  });
});

// ── terminateProcess — canonical kill funnel ─────────────────────────────────
//
// Verifies the structural fix: every kill site outside agents.ts now routes
// through terminateProcess, which itself uses isPidAliveCtx + killPidCtx.
// The EPERM-as-alive regression — fixed in _isPidAlive — is the load-bearing
// behaviour that makes these tests meaningful.
describe("terminateProcess", () => {
  let tmpLogDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpLogDir = await mkdtemp(join(tmpdir(), "terminate-process-log-"));
    logPath = join(tmpLogDir, "watch.log");
    const { setWatchLogPath } = await import("./watch-log");
    setWatchLogPath(logPath);
    // Make grace-period sleeps a no-op so escalation runs instantly.
    sleepMsCtx.set(async () => {});
  });

  afterEach(async () => {
    isPidAliveCtx.reset();
    killPidCtx.reset();
    sleepMsCtx.reset();
    const { resetWatchLogPath } = await import("./watch-log");
    resetWatchLogPath();
    await rm(tmpLogDir, { recursive: true, force: true });
  });

  test("happy path: PID alive → SIGTERM lands → exits in grace → killed, not escalated", async () => {
    let alive = true;
    isPidAliveCtx.set(() => alive);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      calls.push({ pid, signal });
      if (signal === "SIGTERM") alive = false; // SIGTERM lands → process exits
      return true;
    });

    const result = await terminateProcess({
      pid: 4242,
      label: "test-claude",
      agentId: "agent-abc",
      repoName: "myrepo",
      tmuxSession: "ib-x",
    });

    expect(result).toEqual({ outcome: "term-exited", killed: true, escalated: false });
    expect(calls).toEqual([{ pid: 4242, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[terminate] outcome=term-exited");
    expect(log).toContain("label=test-claude");
    expect(log).toContain("agent=myrepo/agent-abc");
    expect(log).toContain("pid=4242");
    expect(log).toContain("tmux=ib-x");
  });

  test("escalation: PID stays alive after SIGTERM → SIGKILL fires → killed + escalated", async () => {
    let alive = true;
    isPidAliveCtx.set(() => alive);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      calls.push({ pid, signal });
      if (signal === "SIGKILL") alive = false; // only SIGKILL succeeds
      return true;
    });

    const result = await terminateProcess({
      pid: 1234,
      label: "stuck-proc",
      gracePeriodMs: 200, // 2 polls → fast
    });

    expect(result).toEqual({ outcome: "kill-exited", killed: true, escalated: true });
    expect(calls).toEqual([
      { pid: 1234, signal: "SIGTERM" },
      { pid: 1234, signal: "SIGKILL" },
    ]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[terminate] outcome=kill-exited");
  });

  test("already-dead: liveness probe returns false → no signal sent → not-alive", async () => {
    isPidAliveCtx.set(() => false);
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const result = await terminateProcess({ pid: 999, label: "dead" });

    expect(result).toEqual({ outcome: "not-alive", killed: true, escalated: false });
    expect(killCalls).toBe(0);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[terminate] outcome=not-alive");
  });

  // The original EPERM-as-dead bug: a sandboxed view of a foreign PID returns
  // EPERM from process.kill(pid, 0). Before the fix, callers treated EPERM as
  // "already dead" and silently skipped SIGTERM. Inject isPidAliveCtx → true
  // (mimicking the canonical _isPidAlive's EPERM-aware behaviour) and verify
  // SIGTERM is actually sent.
  test("EPERM-as-alive: probe returns true → SIGTERM IS sent (regression)", async () => {
    isPidAliveCtx.set(() => true); // stays alive throughout — escalation path
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      calls.push({ pid, signal });
      return true;
    });

    const result = await terminateProcess({
      pid: 5555,
      label: "claude",
      agentId: "agent-eperm",
      gracePeriodMs: 100,
    });

    // SIGTERM MUST have been sent — pre-fix code would have early-returned
    // with "already dead" on the same EPERM and never sent any signal.
    expect(calls).toContainEqual({ pid: 5555, signal: "SIGTERM" });
    // Final state: liveness still says alive (stub never flips) → SIGKILL
    // also fires and final outcome is kill-failed.
    expect(calls).toContainEqual({ pid: 5555, signal: "SIGKILL" });
    expect(result.escalated).toBe(true);
    expect(result.outcome).toBe("kill-failed");
  });

  test("invalid pid (NaN / 0 / negative) → no signals, not-alive outcome", async () => {
    isPidAliveCtx.set(() => true);
    let killCalls = 0;
    killPidCtx.set(() => { killCalls++; return true; });

    const r1 = await terminateProcess({ pid: NaN, label: "bad" });
    const r2 = await terminateProcess({ pid: 0, label: "bad" });
    const r3 = await terminateProcess({ pid: -1, label: "bad" });

    expect(r1.outcome).toBe("not-alive");
    expect(r2.outcome).toBe("not-alive");
    expect(r3.outcome).toBe("not-alive");
    expect(killCalls).toBe(0);
  });

  test("term-failed: SIGTERM syscall returns false → no escalation", async () => {
    isPidAliveCtx.set(() => true);
    const calls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    killPidCtx.set((pid, signal) => {
      calls.push({ pid, signal });
      return false; // SIGTERM fails
    });

    const result = await terminateProcess({ pid: 7777, label: "term-fail" });

    expect(result).toEqual({ outcome: "term-failed", killed: false, escalated: false });
    // No SIGKILL — escalation only happens if SIGTERM landed.
    expect(calls).toEqual([{ pid: 7777, signal: "SIGTERM" }]);

    const { readFile } = await import("fs/promises");
    const log = await readFile(logPath, "utf8");
    expect(log).toContain("[terminate] outcome=term-failed");
  });
});
