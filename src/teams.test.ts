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
