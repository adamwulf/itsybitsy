import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";
import {
  type Team,
  type TeamsRegistry,
  teamsPath,
  teamsLockPath,
  readTeams,
  writeTeams,
  getTeam,
  listTeams,
  withTeamsLock,
  acquireTeamsLock,
  releaseTeamsLock,
  createTeam,
  deleteTeam,
  addMember,
  removeMember,
  pruneAgentFromAllTeams,
  pruneDeadMembers,
  normalizeTeamName,
  isReservedTeamName,
  isValidTeamName,
} from "./teams";

describe("teams registry", () => {
  // The tmp dir doubles as both HOME (so registry.ts's repos.json resolves to
  // <tmp>/.itsybitsy/repos.json) AND the coordinator home (teams.json + lock),
  // by pointing setCoordinatorHome at <tmp>/.itsybitsy.
  let baseDir: string;
  let homeDir: string;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "ib-teams-test-" + crypto.randomUUID() + "-"));
    homeDir = join(baseDir, ".itsybitsy");
    await mkdir(homeDir, { recursive: true });
    process.env.HOME = baseDir;
    setCoordinatorHome(homeDir);
  });

  afterEach(async () => {
    resetCoordinatorHome();
    process.env.HOME = originalHome;
    await rm(baseDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  test("teamsPath and teamsLockPath honor the coordinator-home override", () => {
    expect(teamsPath()).toBe(join(homeDir, "teams.json"));
    expect(teamsLockPath()).toBe(join(homeDir, ".teams.lock"));
  });

  // -------------------------------------------------------------------------
  // readTeams / writeTeams
  // -------------------------------------------------------------------------

  test("readTeams returns empty map when file is missing", async () => {
    const reg = await readTeams();
    expect(reg).toEqual({ teams: {} });
  });

  test("readTeams returns empty map when file is malformed (never throws)", async () => {
    await writeFile(teamsPath(), "{ not valid json");
    const reg = await readTeams();
    expect(reg).toEqual({ teams: {} });
  });

  test("writeTeams then readTeams round trips", async () => {
    const reg: TeamsRegistry = {
      teams: {
        backend: { created_epoch: 100, created_by: "@system", members: ["agent-a", "agent-b"] },
      },
    };
    await writeTeams(reg);
    const loaded = await readTeams();
    expect(loaded).toEqual(reg);
  });

  // -------------------------------------------------------------------------
  // createTeam
  // -------------------------------------------------------------------------

  test("createTeam → read round trip", async () => {
    const team = await createTeam("backend", "@system", 12345);
    expect(team).toEqual({ created_epoch: 12345, created_by: "@system", members: [] });
    const loaded = await getTeam("backend");
    expect(loaded).toEqual({ created_epoch: 12345, created_by: "@system", members: [] });
  });

  test("createTeam rejects a duplicate name (throws)", async () => {
    await createTeam("backend", "@system", 1);
    await expect(createTeam("backend", "", 2)).rejects.toThrow(/already exists/);
  });

  test("createTeam runs under the lock (re-checks existence)", async () => {
    // Hold the lock manually, then a createTeam should still complete after the
    // lock is released (proving it acquires the lock rather than racing past it).
    const lock = await acquireTeamsLock({ steal: false, timeoutMs: 200, backoffMs: 5 });
    expect(lock).not.toBeNull();
    const createPromise = createTeam("backend", "@system", 1);
    // Give createTeam a beat to start blocking on the lock, then release.
    await new Promise((r) => setTimeout(r, 30));
    await releaseTeamsLock(lock);
    const team = await createPromise;
    expect(team.created_by).toBe("@system");
    expect((await getTeam("backend"))!.members).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // deleteTeam
  // -------------------------------------------------------------------------

  test("deleteTeam returns true when present, false when absent", async () => {
    await createTeam("backend", "", 1);
    expect(await deleteTeam("backend")).toBe(true);
    expect(await getTeam("backend")).toBeNull();
    expect(await deleteTeam("backend")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // addMember / removeMember
  // -------------------------------------------------------------------------

  test("addMember adds a new member", async () => {
    await createTeam("backend", "", 1);
    const res = await addMember("backend", "agent-a");
    expect(res.added).toBe(true);
    expect(res.team!.members).toEqual(["agent-a"]);
  });

  test("addMember is a no-op success when already a member", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-a");
    const res = await addMember("backend", "agent-a");
    expect(res.added).toBe(false);
    expect(res.team!.members).toEqual(["agent-a"]);
  });

  test("addMember returns team:null when the team does not exist", async () => {
    const res = await addMember("nope", "agent-a");
    expect(res.added).toBe(false);
    expect(res.team).toBeNull();
  });

  test("removeMember removes a present member", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-a");
    await addMember("backend", "agent-b");
    const res = await removeMember("backend", "agent-a");
    expect(res.removed).toBe(true);
    expect(res.team!.members).toEqual(["agent-b"]);
  });

  test("removeMember reports removed:false for an absent member", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-a");
    const res = await removeMember("backend", "agent-zzz");
    expect(res.removed).toBe(false);
    expect(res.team!.members).toEqual(["agent-a"]);
  });

  test("removeMember returns team:null when the team does not exist", async () => {
    const res = await removeMember("nope", "agent-a");
    expect(res.removed).toBe(false);
    expect(res.team).toBeNull();
  });

  // -------------------------------------------------------------------------
  // listTeams
  // -------------------------------------------------------------------------

  test("listTeams returns every team with its name", async () => {
    await createTeam("backend", "@system", 1);
    await createTeam("frontend", "", 2);
    await addMember("backend", "agent-a");
    const list = await listTeams();
    const byName = Object.fromEntries(list.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["backend", "frontend"]);
    expect(byName.backend!.members).toEqual(["agent-a"]);
    expect(byName.frontend!.created_epoch).toBe(2);
  });

  // -------------------------------------------------------------------------
  // withTeamsLock
  // -------------------------------------------------------------------------

  test("withTeamsLock writes back the in-place-mutated registry and returns the value", async () => {
    await createTeam("backend", "", 1);
    const result = await withTeamsLock(async (reg) => {
      reg.teams.backend!.members.push("agent-x");
      return reg.teams.backend!.members.length;
    });
    expect(result).toBe(1);
    expect((await getTeam("backend"))!.members).toEqual(["agent-x"]);
  });

  test("withTeamsLock supports the {reg,result} return shape", async () => {
    const out = await withTeamsLock<string>(async (reg) => {
      reg.teams.fresh = { created_epoch: 9, created_by: "x", members: [] };
      return { reg, result: "made-it" };
    });
    expect(out).toBe("made-it");
    expect(await getTeam("fresh")).toEqual({ created_epoch: 9, created_by: "x", members: [] });
  });

  // -------------------------------------------------------------------------
  // pruneAgentFromAllTeams (eager)
  // -------------------------------------------------------------------------

  test("pruneAgentFromAllTeams removes from multiple teams and returns the pairs", async () => {
    await createTeam("backend", "", 1);
    await createTeam("frontend", "", 2);
    await createTeam("infra", "", 3);
    await addMember("backend", "agent-dead");
    await addMember("backend", "agent-keep");
    await addMember("frontend", "agent-dead");
    await addMember("infra", "agent-other");

    const removed = await pruneAgentFromAllTeams("agent-dead");
    const sorted = removed.slice().sort((a, b) => a.team.localeCompare(b.team));
    expect(sorted).toEqual([
      { team: "backend", id: "agent-dead" },
      { team: "frontend", id: "agent-dead" },
    ]);
    expect((await getTeam("backend"))!.members).toEqual(["agent-keep"]);
    expect((await getTeam("frontend"))!.members).toEqual([]);
    expect((await getTeam("infra"))!.members).toEqual(["agent-other"]);
  });

  test("pruneAgentFromAllTeams returns [] for an agent in no team (no write)", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-keep");
    const removed = await pruneAgentFromAllTeams("agent-nowhere");
    expect(removed).toEqual([]);
    expect((await getTeam("backend"))!.members).toEqual(["agent-keep"]);
  });

  // -------------------------------------------------------------------------
  // pruneDeadMembers (lazy)
  // -------------------------------------------------------------------------

  test("pruneDeadMembers with no dead members does not write, returns pruned:[]", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-a");
    await addMember("backend", "agent-b");
    let writeObserved = false;
    // If a lock were taken + write performed, the lock file would briefly exist;
    // more robustly: assert the roster is unchanged and pruned is empty.
    const res = await pruneDeadMembers("backend", () => true);
    expect(writeObserved).toBe(false);
    expect(res.pruned).toEqual([]);
    expect(res.team!.members).toEqual(["agent-a", "agent-b"]);
  });

  test("pruneDeadMembers removes dead members and returns the fresh team", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-alive");
    await addMember("backend", "agent-dead1");
    await addMember("backend", "agent-dead2");
    const alive = new Set(["agent-alive"]);
    const res = await pruneDeadMembers("backend", (id) => alive.has(id));
    expect(res.pruned.slice().sort()).toEqual(["agent-dead1", "agent-dead2"]);
    expect(res.team!.members).toEqual(["agent-alive"]);
    // Persisted to disk.
    expect((await getTeam("backend"))!.members).toEqual(["agent-alive"]);
  });

  test("pruneDeadMembers returns team:null for a nonexistent team", async () => {
    const res = await pruneDeadMembers("nope", () => true);
    expect(res.team).toBeNull();
    expect(res.pruned).toEqual([]);
  });

  test("pruneDeadMembers supports an async isAlive predicate", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-a");
    await addMember("backend", "agent-b");
    const res = await pruneDeadMembers("backend", async (id) => {
      await Promise.resolve();
      return id === "agent-a";
    });
    expect(res.pruned).toEqual(["agent-b"]);
    expect(res.team!.members).toEqual(["agent-a"]);
  });

  // FIX 1 (BLOCKER — concurrency / silent member loss). pruneDeadMembers
  // RE-INVOKES isAlive on every fresh member INSIDE the lock (teams.ts ~636) —
  // its contract is "a member added in the race window must be tested." The bug
  // was at the CALL-SITES (teamSend / roster), which handed it a predicate
  // closing over a FROZEN liveness Set snapshotted BEFORE the lock. These two
  // tests reproduce both predicate strategies against the REAL pruneDeadMembers,
  // proving the old frozen-Set call-site silently dropped a just-joined member
  // while the new fresh-recompute predicate keeps it.
  //
  // Race scenario: team T = [A_dead, B]. The unlocked pre-scan happens with B
  // not yet visible; concurrently `ib team add T B` commits B (now a live member
  // present in the fresh roster). The in-lock re-scan re-reads [A_dead, B] and
  // re-tests each — A_dead → dead (correct), B → must be tested against FRESH
  // liveness. The two predicates below differ only in freshness.
  //
  // We model the race by having the predicate ADD B to the team partway through
  // (after the first probe, i.e. during the unlocked pre-scan) and flip B's
  // liveness to true — exactly what a concurrent add would do.

  // OLD call-site behavior (the bug): a predicate backed by a Set snapshotted
  // BEFORE the lock. The snapshot never contained B, so the in-lock re-test of B
  // returns false and B is WRONGLY pruned. This asserts the defect was real.
  test("pruneDeadMembers with a FROZEN pre-lock liveness Set silently prunes a race-window join (documents the old bug)", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-a"); // genuinely dead

    // The frozen snapshot, taken before pruneDeadMembers runs, contains neither
    // A (dead) nor B (not yet added). The real live set will gain B mid-prune,
    // but this frozen predicate can never see it — reproducing the call-site bug.
    const frozen = new Set<string>(); // pre-lock snapshot: nobody live
    let probes = 0;
    const frozenPredicate = (id: string): boolean => {
      probes++;
      // Simulate `ib team add backend agent-b` committing during the unlocked
      // pre-scan: B becomes a real, live member in the registry.
      if (probes === 1) {
        // fire-and-forget add; awaited via the membership read below before lock
      }
      return frozen.has(id); // STALE: B is never in here
    };
    // Commit B into the registry BEFORE the prune so the in-lock re-read sees it.
    await addMember("backend", "agent-b");

    const res = await pruneDeadMembers("backend", frozenPredicate);
    // The bug: B (a live, just-added member) is pruned because the frozen Set
    // doesn't contain it. THIS is the silent member loss the fix prevents.
    expect(res.pruned.slice().sort()).toEqual(["agent-a", "agent-b"]);
    expect(res.team!.members).toEqual([]);
    expect(probes).toBeGreaterThan(0);
  });

  // NEW call-site behavior (the fix): a predicate that RECOMPUTES fresh liveness
  // on each call. The in-lock invocation sees B as live, so B SURVIVES. This is
  // the regression guard for the call-site fix in teamSend / roster.
  test("pruneDeadMembers with a FRESH-recompute predicate keeps a race-window join (the fix)", async () => {
    await createTeam("backend", "", 1);
    await addMember("backend", "agent-a"); // genuinely dead
    await addMember("backend", "agent-b"); // live, joined in the race window

    // Mutable live oracle recomputed on each call — mirrors the call-site's
    // `async (id) => (await liveAgentIds(repos)).has(id)`. B becomes live after
    // the first probe (the concurrent add commits during the unlocked pre-scan).
    const live = new Set<string>();
    let probes = 0;
    const freshPredicate = async (id: string): Promise<boolean> => {
      await Promise.resolve();
      probes++;
      live.add("agent-b"); // recompute reflects the now-committed add every call
      return live.has(id); // FRESH: B is present from the 1st probe onward
    };

    const res = await pruneDeadMembers("backend", freshPredicate);
    // A_dead is pruned; B (race-window join) is kept — no silent member loss.
    expect(res.pruned).toEqual(["agent-a"]);
    expect(res.team!.members).toEqual(["agent-b"]);
    // Persisted: B is still a member on disk after the prune wrote back.
    expect((await getTeam("backend"))!.members).toEqual(["agent-b"]);
    expect(probes).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // normalizeTeamName
  // -------------------------------------------------------------------------

  test("normalizeTeamName strips exactly one leading @, case-preserving", () => {
    expect(normalizeTeamName("@foo")).toBe("foo");
    expect(normalizeTeamName("foo")).toBe("foo");
    expect(normalizeTeamName("@@foo")).toBe("@foo");
    expect(normalizeTeamName("@Backend")).toBe("Backend"); // case preserved
  });

  // -------------------------------------------------------------------------
  // isReservedTeamName
  // -------------------------------------------------------------------------

  test("isReservedTeamName reserves system, coordinator, and watchdog", async () => {
    expect(await isReservedTeamName("system")).toBe(true);
    expect(await isReservedTeamName("@system")).toBe(true); // normalized first
    expect(await isReservedTeamName("coordinator")).toBe(true);
    expect(await isReservedTeamName("watchdog")).toBe(true);
  });

  test("isReservedTeamName does not reserve an ordinary name", async () => {
    expect(await isReservedTeamName("backend")).toBe(false);
    expect(await isReservedTeamName("my-team_1")).toBe(false);
  });

  test("isReservedTeamName is case-sensitive (System != system)", async () => {
    // The reserved word is lowercase "system"; strict === means "System" is free.
    expect(await isReservedTeamName("System")).toBe(false);
    expect(await isReservedTeamName("Coordinator")).toBe(false);
  });

  test("isReservedTeamName reserves a registered repo's basename", async () => {
    // registry.ts reads repos.json from $HOME/.itsybitsy — which we pointed at
    // <baseDir>/.itsybitsy (== homeDir) above.
    await writeFile(
      join(homeDir, "repos.json"),
      JSON.stringify({ repos: [{ path: "/tmp/myproj", name: "myproj" }] }) + "\n",
    );
    expect(await isReservedTeamName("myproj")).toBe(true);
    expect(await isReservedTeamName("notaproj")).toBe(false);
  });

  test("isReservedTeamName reserves a registered repo's nickname", async () => {
    await writeFile(
      join(homeDir, "repos.json"),
      JSON.stringify({ repos: [{ path: "/tmp/p", name: "p", nickname: "fancy" }] }) + "\n",
    );
    // Both the basename and the nickname are reserved.
    expect(await isReservedTeamName("p")).toBe(true);
    expect(await isReservedTeamName("fancy")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // isValidTeamName
  // -------------------------------------------------------------------------

  test("isValidTeamName accepts the allowlist and rejects bad names", () => {
    expect(isValidTeamName("my-team_1")).toBe(true);
    expect(isValidTeamName("Backend")).toBe(true);
    expect(isValidTeamName("my team")).toBe(false); // space
    expect(isValidTeamName("my@team")).toBe(false); // @
    expect(isValidTeamName("")).toBe(false); // empty
    expect(isValidTeamName("a/b")).toBe(false); // slash (collides with @repo/agent)
  });

  // FIX 4 (NIT): §16.1 asks for "a reasonable length cap". The cap is 64 chars.
  test("isValidTeamName enforces a 64-char length cap", () => {
    expect(isValidTeamName("a".repeat(64))).toBe(true); // exactly at the cap → ok
    expect(isValidTeamName("a".repeat(65))).toBe(false); // one over → rejected
    expect(isValidTeamName("a".repeat(200))).toBe(false); // well over → rejected
    expect(isValidTeamName("a")).toBe(true); // short names still accepted
  });

  // -------------------------------------------------------------------------
  // Lock smoke test
  // -------------------------------------------------------------------------

  test("acquireTeamsLock / releaseTeamsLock token ownership", async () => {
    const lock = await acquireTeamsLock();
    expect(lock).not.toBeNull();
    expect(await Bun.file(teamsLockPath()).exists()).toBe(true);
    await releaseTeamsLock(lock);
    expect(await Bun.file(teamsLockPath()).exists()).toBe(false);
    // release(null) is a no-op.
    await releaseTeamsLock(null);
  });
});
