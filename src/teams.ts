/**
 * Team registry — the data layer for the Teams feature (SPEC §16).
 *
 * A team is a named, cross-repo group of agents that share a "chat room":
 * `ib send @<team>` fans out to every member except the sender. Because teams
 * span repos, their state cannot live in any one repo's `.ittybitty/` directory
 * — it lives at the user-wide tier alongside `repos.json` and `config.json`, at
 * `~/.itsybitsy/teams.json` (§16.2).
 *
 * This module owns ONLY the registry (read/write/lock + name validation +
 * collision + prune helpers). The resolver integration, the fan-out, the
 * delivery-prefix extension, the leave/join notices, and the session-start
 * awareness all live in OTHER modules (index.ts, ib-commands.ts,
 * session-start.ts) — see §16.8. Nothing here ever emits a notice; notices are
 * the command layer's job (§16.5).
 *
 * Concurrency (§16.2). Atomic rename guarantees no *torn* file, but NOT no
 * *lost update*: a bare read-modify-write race (A reads {m1}, B reads {m1}, A
 * writes {m1,m2}, B writes {m1,m3} → m2 is lost) is real here because
 * `ib team add`/`remove`, lazy send-time pruning, and teardown pruning all do
 * read-modify-write on the single shared `teams.json`. The outbox solves the
 * analogous problem with `.outbox.lock`; teams gets the same treatment via
 * `.teams.lock`. The lock helpers below MIRROR `acquireOutboxLock`/`steal`
 * exactly so the two locks behave identically — this is a single GLOBAL lock
 * (one `teams.json`), unlike the per-agent outbox lock, but team mutations are
 * infrequent (membership changes, not message traffic) so a single lock is not
 * a throughput concern.
 *
 * Three classes of access (§16.2):
 *   1. Pure reads (`readTeams`, `getTeam`, `listTeams`) — never take the lock;
 *      atomic rename guarantees they see either the whole pre- or whole
 *      post-image, never a torn one.
 *   2. Unconditional mutations (`createTeam`, `addMember`, `removeMember`,
 *      `deleteTeam`, eager teardown prune) — read → modify → write entirely
 *      under the lock, released in a `finally`. `withTeamsLock` packages this.
 *   3. Conditional mutations / lazy prune (`pruneDeadMembers`, used by
 *      `ib roster` / `ib send`) — read UNLOCKED first; only IF a dead member is
 *      detected do they acquire the lock, RE-READ inside it, recompute the
 *      prune against the fresh copy, write, and release.
 */

import { join } from "path";
import { rename, unlink, stat, readFile, open, mkdir } from "fs/promises";
import { getCoordinatorHome } from "./coordinator";
import { SYSTEM_AGENT_ID } from "./hooks/shared";
import { BARE_RENDERED_SENTINELS } from "./ib-commands";
import { listRepos, repoDisplayName } from "./registry";
import { isValidTeamName as isValidTeamNameAllowlist } from "./validation";

/** Filename for the cross-repo team registry under `~/.itsybitsy/`. */
export const TEAMS_FILENAME = "teams.json";
/** Filename for the global team-registry mutation lock under `~/.itsybitsy/`. */
export const TEAMS_LOCK_FILENAME = ".teams.lock";

/**
 * One team. The map key in `TeamsRegistry.teams` is the BARE team name (no `@`
 * prefix — the `@` is the addressing sigil, not part of the stored name).
 */
export interface Team {
  /** Unix epoch SECONDS at creation (§16.2). */
  created_epoch: number;
  /** The sentinel or agent ID that created the team (`@system`, an agent ID, or `""` for a human/CLI creation). */
  created_by: string;
  /** Member agent IDs. Membership is by agent ID — see §16.5 for ephemerality. */
  members: string[];
}

/** The full on-disk shape of `teams.json`. */
export interface TeamsRegistry {
  teams: Record<string, Team>;
}

/** Absolute path to `~/.itsybitsy/teams.json`. Honors the `setCoordinatorHome` test override. */
export function teamsPath(): string {
  return join(getCoordinatorHome(), TEAMS_FILENAME);
}

/** Absolute path to `~/.itsybitsy/.teams.lock`. Honors the `setCoordinatorHome` test override. */
export function teamsLockPath(): string {
  return join(getCoordinatorHome(), TEAMS_LOCK_FILENAME);
}

// ---------------------------------------------------------------------------
// Access class 1: pure reads (no lock)
// ---------------------------------------------------------------------------

/**
 * UNLOCKED pure read of the entire registry (access class 1, §16.2). Returns
 * `{ teams: {} }` when the file is missing OR malformed — NEVER throws. A
 * concurrently-rewritten file is tolerated because the atomic rename guarantees
 * we see either the whole pre- or whole post-image, never a torn one.
 */
export async function readTeams(): Promise<TeamsRegistry> {
  let content: string;
  try {
    content = await readFile(teamsPath(), "utf-8");
  } catch {
    return { teams: {} }; // missing file → no teams yet
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { teams: {} }; // malformed → treat as empty rather than throwing
  }
  if (!parsed || typeof parsed !== "object") {
    return { teams: {} };
  }
  const rawTeams = (parsed as { teams?: unknown }).teams;
  if (!rawTeams || typeof rawTeams !== "object") {
    return { teams: {} };
  }
  // Reconstruct field-by-field so a malformed individual entry can't poison the
  // whole read — a team whose shape is wrong is simply skipped.
  const teams: Record<string, Team> = {};
  for (const [name, value] of Object.entries(rawTeams as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as { created_epoch?: unknown; created_by?: unknown; members?: unknown };
    const members = Array.isArray(v.members)
      ? v.members.filter((m): m is string => typeof m === "string")
      : [];
    teams[name] = {
      created_epoch: typeof v.created_epoch === "number" ? v.created_epoch : 0,
      created_by: typeof v.created_by === "string" ? v.created_by : "",
      members,
    };
  }
  return { teams };
}

/**
 * Atomic write (tmp + rename) of the whole registry. Mkdir's the home dir first
 * (recursive — a no-op when it already exists) so a write never fails on a
 * missing `~/.itsybitsy/`. The CALLER is responsible for holding `.teams.lock`
 * around its read-modify-write; this function only performs the write half.
 */
export async function writeTeams(reg: TeamsRegistry): Promise<void> {
  const home = getCoordinatorHome();
  await mkdir(home, { recursive: true });
  const path = teamsPath();
  const tmpPath = path + ".tmp";
  await Bun.write(tmpPath, JSON.stringify(reg, null, 2) + "\n");
  await rename(tmpPath, path);
}

/** UNLOCKED read of one team by BARE name (null if absent). Access class 1. */
export async function getTeam(name: string): Promise<Team | null> {
  const reg = await readTeams();
  return reg.teams[name] ?? null;
}

/** UNLOCKED read of all teams as a list (access class 1). Each entry carries its bare name. */
export async function listTeams(): Promise<Array<{ name: string } & Team>> {
  const reg = await readTeams();
  const out: Array<{ name: string } & Team> = [];
  for (const [name, team] of Object.entries(reg.teams)) {
    out.push({
      name,
      created_epoch: team.created_epoch,
      created_by: team.created_by,
      members: team.members,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lock helpers — MIRROR src/outbox.ts exactly (§16.2). The lock dir is always
// the coordinator home (`~/.itsybitsy/`), so unlike the per-agent outbox lock
// this is a single GLOBAL lock.
// ---------------------------------------------------------------------------

/** A held team-registry lock — pass to `releaseTeamsLock` (always in a finally block). */
export interface TeamsLock {
  dir: string;
  path: string;
  /**
   * Unique ownership token written into the lock file at acquire time.
   * `releaseTeamsLock` only removes the file when the on-disk token still
   * matches this — so if our lock was stolen (stale-steal by another process)
   * and re-created by the thief, our release is a no-op and we never delete the
   * thief's lock out from under them. Identical guarantee to the outbox lock.
   */
  token: string;
}

export interface AcquireLockOpts {
  /** Total time to keep retrying before giving up, in ms. Default 5000. */
  timeoutMs?: number;
  /** Backoff between attempts, in ms. Default 25. */
  backoffMs?: number;
  /**
   * If true and the held lock looks stale (mtime older than `staleMs`), steal
   * it. The mutation helpers below set this so a crashed holder can't wedge
   * team mutations forever.
   */
  steal?: boolean;
  /** Age past which a lock is considered stale and stealable. Default 30000. */
  staleMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable now (tests). */
  now?: () => number;
}

/** Serialize the holder pid + a unique token into the lock file body. */
function lockBody(token: string): string {
  return `${process.pid}:${token}`;
}

/** Parse the token out of a lock-file body (everything after the first `:`). */
function tokenFromBody(body: string): string {
  const idx = body.indexOf(":");
  return idx >= 0 ? body.slice(idx + 1) : body;
}

/**
 * Acquire the global team-registry lock via exclusive file creation
 * (O_CREAT|O_EXCL). On EEXIST the lock is held by someone else; retry with
 * backoff up to `timeoutMs`. Writes `<pid>:<token>` into the lock file (token
 * for ownership verification on release, pid for debuggability). Returns the
 * lock handle on success, or null on timeout.
 *
 * Stealing: when `steal` is set and the existing lock's mtime is older than
 * `staleMs`, the stale lock is removed and re-created. This is the safety valve
 * against a crashed holder. The token (verified on release) ensures a
 * stolen-from holder never deletes the thief's lock. Mirrors `acquireOutboxLock`.
 */
export async function acquireTeamsLock(opts?: AcquireLockOpts): Promise<TeamsLock | null> {
  const dir = getCoordinatorHome();
  const path = teamsLockPath();
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const backoffMs = opts?.backoffMs ?? 25;
  const staleMs = opts?.staleMs ?? 30_000;
  const sleep = opts?.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = opts?.now ?? (() => Date.now());

  // The lock lives in the home dir; ensure it exists so the O_EXCL open can't
  // fail with ENOENT on a fresh install (no agents/coordinator created yet).
  await mkdir(dir, { recursive: true });

  const deadline = now() + timeoutMs;
  // First attempt is unconditional; subsequent attempts are gated on the
  // deadline so a timeoutMs of 0 still tries exactly once.
  for (;;) {
    const token = crypto.randomUUID();
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(lockBody(token));
      } finally {
        await handle.close();
      }
      return { dir, path, token };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== "EEXIST") {
        // Unexpected error (e.g. dir missing) — treat as un-acquirable.
        return null;
      }
      // Held by someone. Optionally steal if stale.
      if (opts?.steal) {
        try {
          const st = await stat(path);
          if (now() - st.mtimeMs > staleMs) {
            // Steal: read the current token so we only remove the lock we
            // observed as stale (don't unlink a fresh lock a third party may
            // have just created in the race window). The subsequent O_EXCL
            // open is the real arbiter — a racing stealer loses with EEXIST
            // and retries.
            let staleToken: string | null = null;
            try {
              staleToken = tokenFromBody(await readFile(path, "utf-8"));
            } catch {
              /* lock vanished — retry immediately */
              continue;
            }
            await unlinkIfToken(path, staleToken);
            continue; // retry immediately after steal attempt
          }
        } catch {
          /* lock vanished between EEXIST and stat — retry immediately */
          continue;
        }
      }
    }
    if (now() >= deadline) return null;
    await sleep(backoffMs);
  }
}

/**
 * Remove the lock file ONLY if its on-disk token still matches `token`. This
 * is the ownership guard shared by release and steal: it prevents deleting a
 * lock that has since been re-created by a different holder.
 */
async function unlinkIfToken(path: string, token: string): Promise<void> {
  try {
    const body = await readFile(path, "utf-8");
    if (tokenFromBody(body) !== token) return; // not our lock anymore — leave it
  } catch {
    return; // already gone
  }
  try {
    await unlink(path);
  } catch {
    /* raced with another release/steal — fine */
  }
}

/**
 * Release a held lock — removes the lock file only when the on-disk token still
 * matches the handle's token (i.e. we still hold it). If our lock was stolen
 * and re-created by another process, this is a no-op so we never delete the new
 * holder's lock. Best-effort. Mirrors `releaseOutboxLock`.
 */
export async function releaseTeamsLock(lock: TeamsLock | null): Promise<void> {
  if (!lock) return;
  await unlinkIfToken(lock.path, lock.token);
}

// ---------------------------------------------------------------------------
// Access class 2: unconditional locked mutation
// ---------------------------------------------------------------------------

/**
 * Run a locked read-modify-write against the registry (access class 2, §16.2).
 *
 * Return contract: `fn` receives the FRESH registry re-read INSIDE the lock,
 * mutates it in place (add/remove members, create/delete teams), and returns
 * either:
 *   - a plain value `T` — the (in-place-mutated) registry is written back, then
 *     `T` is returned; OR
 *   - `{ reg, result }` — `reg` is written back (use this when you want to
 *     hand back a different registry object than the one passed in), and
 *     `result` is returned.
 *
 * In both cases the registry is written back exactly once and the lock is
 * released in a `finally`. `steal: true` is used so a crashed holder can't
 * wedge team mutations forever (matches the eager/lazy prune helpers).
 *
 * Throws if the lock can't be acquired within the timeout — callers must not
 * proceed with an un-serialized write (that would reintroduce the lost-update
 * race §16.2 describes).
 */
export async function withTeamsLock<T>(
  fn: (reg: TeamsRegistry) => Promise<{ reg: TeamsRegistry; result: T } | T>,
): Promise<T> {
  const lock = await acquireTeamsLock({ steal: true });
  if (!lock) {
    throw new Error("could not acquire .teams.lock — team registry is busy");
  }
  try {
    // Re-read INSIDE the lock so we modify the latest committed image, closing
    // the read-modify-write race window (§16.2).
    const reg = await readTeams();
    const outcome = await fn(reg);
    if (outcome && typeof outcome === "object" && "reg" in outcome && "result" in outcome) {
      const wrapped = outcome as { reg: TeamsRegistry; result: T };
      await writeTeams(wrapped.reg);
      return wrapped.result;
    }
    // Plain value: write back the (in-place-mutated) registry we passed in.
    await writeTeams(reg);
    return outcome as T;
  } finally {
    await releaseTeamsLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Name validation, normalization, and collision (§16.1)
// ---------------------------------------------------------------------------

/**
 * Strip ONE leading `@` from a team name if present, leaving the rest verbatim.
 * The `@` is the addressing sigil, not part of the stored name (§16.2/§16.3).
 *
 *   "@foo"  -> "foo"
 *   "foo"   -> "foo"
 *   "@@foo" -> "@foo"   (only the first `@` is the sigil)
 *
 * Case is NOT folded — team names are case-SENSITIVE (§16.1), matching the
 * resolver's strict `===` comparisons.
 */
export function normalizeTeamName(name: string): string {
  return name.startsWith("@") ? name.slice(1) : name;
}

/**
 * Validate a NORMALIZED team name against the allowlist `/^[A-Za-z0-9_-]+$/`
 * (§16.1). Wraps `validation.isValidTeamName` so callers have one import for
 * all team-name concerns. Used by create. Pass an ALREADY-normalized name (no
 * leading `@`) — a raw `@foo` would fail the allowlist on the `@`.
 */
export function isValidTeamName(name: string): boolean {
  return isValidTeamNameAllowlist(name);
}

/**
 * Build the reserved-word set as the UNION of three distinct source constants
 * (§16.1/§16.8), each with its leading `@` stripped, plus every registered
 * repo's display name and nickname. Derived dynamically so the spec and code
 * cannot drift:
 *   (a) SYSTEM_AGENT_ID ("@system") → "system"
 *   (b) the literal "coordinator" (mirrors registry.ts's repo-name refusal)
 *   (c) each member of BARE_RENDERED_SENTINELS (currently {"@watchdog"}) → "watchdog"
 *   (d) every repo's repoDisplayName(r) AND its nickname (both forms route to
 *       that repo's coordinator, so either is a collision).
 *
 * All comparisons are case-SENSITIVE strict `===` to match the resolver
 * (§16.1) — "System" does NOT collide with the reserved "system".
 */
async function reservedTeamNames(): Promise<Set<string>> {
  const reserved = new Set<string>();
  // (a) system coordinator id, @ stripped
  reserved.add(normalizeTeamName(SYSTEM_AGENT_ID));
  // (b) literal coordinator
  reserved.add("coordinator");
  // (c) bare-rendered sentinels, @ stripped — derived so a growing set stays correct
  for (const sentinel of BARE_RENDERED_SENTINELS) {
    reserved.add(normalizeTeamName(sentinel));
  }
  // (d) every repo's basename AND configured nickname — BOTH route to that
  // repo's coordinator (`@<repo>` by either form), so either is a collision.
  // Mirrors registry.ts, which checks `repoDisplayName(r) === x || r.name === x`
  // (note `repoDisplayName` returns the nickname when set, so the basename
  // `r.name` must be added explicitly — it is NOT covered by the display name
  // once a nickname exists).
  const repos = await listRepos();
  for (const repo of repos) {
    reserved.add(repo.name); // basename — always present
    reserved.add(repoDisplayName(repo)); // nickname if set, else basename again
    if (repo.nickname) {
      reserved.add(repo.nickname);
    }
  }
  return reserved;
}

/**
 * True if the NORMALIZED form of `name` collides (case-SENSITIVE, strict `===`)
 * with ANY reserved word — the union from §16.1/§16.8. This is the
 * collision check `ib team create` runs before storing a name. The repo set is
 * read live (so a repo added after this process started is still honored).
 */
export async function isReservedTeamName(name: string): Promise<boolean> {
  const normalized = normalizeTeamName(name);
  const reserved = await reservedTeamNames();
  return reserved.has(normalized);
}

// ---------------------------------------------------------------------------
// Access class 2: membership primitives + create/delete (all locked)
// ---------------------------------------------------------------------------

/**
 * Create a new team (locked, access class 2). `createdEpoch` is passed in for
 * testability — the CLI caller supplies `Math.floor(Date.now() / 1000)`.
 *
 * Re-checks existence UNDER the lock to close the TOCTOU race: the caller
 * pre-validates reserved/collision/format, but two concurrent `ib team create`
 * of the same name must not both succeed. Throws if the name already exists.
 * Returns the created team.
 */
export async function createTeam(name: string, createdBy: string, createdEpoch: number): Promise<Team> {
  return withTeamsLock(async (reg) => {
    if (reg.teams[name]) {
      throw new Error(`team @${name} already exists`);
    }
    const team: Team = {
      created_epoch: createdEpoch,
      created_by: createdBy,
      members: [],
    };
    reg.teams[name] = team;
    return team;
  });
}

/**
 * Delete a team (locked, access class 2). Returns true if a team was removed,
 * false if it did not exist. Does not notify — the team is gone (§16.3).
 */
export async function deleteTeam(name: string): Promise<boolean> {
  return withTeamsLock(async (reg) => {
    if (!reg.teams[name]) return false;
    delete reg.teams[name];
    return true;
  });
}

/**
 * Add an agent id to a team (locked, access class 2). Used by `ib team add`.
 *
 * Return contract: `{ added, team }`.
 *   - `team === null` signals the TEAM WAS NOT FOUND (caller should error
 *     `team @<name> not found`, §16.3). We return null rather than throw so the
 *     command layer can map it to its own non-zero-exit message uniformly.
 *   - `added === false` with a non-null `team` is the documented no-op success
 *     (§16.3): the agent was ALREADY a member.
 *   - `added === true` with a non-null `team`: the agent was appended.
 */
export async function addMember(
  name: string,
  agentId: string,
): Promise<{ added: boolean; team: Team | null }> {
  return withTeamsLock(async (reg) => {
    const team = reg.teams[name];
    if (!team) {
      return { added: false, team: null };
    }
    if (team.members.includes(agentId)) {
      return { added: false, team }; // already a member — no-op success
    }
    team.members.push(agentId);
    return { added: true, team };
  });
}

/**
 * Remove an agent id from a team (locked, access class 2). Used by
 * `ib team remove`.
 *
 * Return contract: `{ removed, team }`.
 *   - `team === null` signals the TEAM WAS NOT FOUND (§16.3 — error).
 *   - `removed === false` with a non-null `team`: the agent was not a member.
 *   - `removed === true` with a non-null `team`: the agent was removed.
 */
export async function removeMember(
  name: string,
  agentId: string,
): Promise<{ removed: boolean; team: Team | null }> {
  return withTeamsLock(async (reg) => {
    const team = reg.teams[name];
    if (!team) {
      return { removed: false, team: null };
    }
    const before = team.members.length;
    team.members = team.members.filter((m) => m !== agentId);
    const removed = team.members.length < before;
    return { removed, team };
  });
}

// ---------------------------------------------------------------------------
// Prune helpers (§16.5)
// ---------------------------------------------------------------------------

/**
 * EAGER prune used by teardown (§16.5). Removes `agentId` from every team's
 * members where present and returns the list of `(team, id)` pairs actually
 * removed (empty array if the agent was in no team).
 *
 * This is access class 3's conditional-mutation pattern (§16.2): a quick
 * UNLOCKED pre-check first; only IF a hit is found do we take the lock, RE-READ
 * inside it (the roster may have changed since the unlocked read), recompute
 * the hits against the fresh copy, write, and release. The common case (the
 * torn-down agent was in no team) never touches the lock.
 *
 * NEVER emits a notice — leave-notice fan-out is the command layer's job
 * (§16.5); `archiveAgent` only does the membership write.
 */
export async function pruneAgentFromAllTeams(
  agentId: string,
): Promise<Array<{ team: string; id: string }>> {
  // Unlocked pre-check: if the agent is in no team, do nothing and never lock.
  const snapshot = await readTeams();
  const hasAnyHit = Object.values(snapshot.teams).some((t) => t.members.includes(agentId));
  if (!hasAnyHit) {
    return [];
  }
  // A hit exists — upgrade to a locked re-read + write so concurrent mutations
  // serialize and we prune against the freshest roster.
  return withTeamsLock(async (reg) => {
    const removed: Array<{ team: string; id: string }> = [];
    for (const [teamName, team] of Object.entries(reg.teams)) {
      if (team.members.includes(agentId)) {
        team.members = team.members.filter((m) => m !== agentId);
        removed.push({ team: teamName, id: agentId });
      }
    }
    return removed;
  });
}

/**
 * LAZY prune used by `ib roster` / `ib send` (§16.2 access class 3 + §16.5).
 *
 * Read the team UNLOCKED. Test each member with `isAlive` (injected so this
 * module has no dependency on agent-existence logic — the caller supplies it,
 * typically a directory-existence check). If NO dead members are found, return
 * `{ team, pruned: [] }` WITHOUT touching the lock (the common case).
 *
 * If dead members ARE found, acquire the lock, RE-READ the team inside it (the
 * roster may have changed since the unlocked read), recompute which members are
 * dead against the FRESH copy, remove them, write, release, and return
 * `{ team: freshTeam, pruned: [...removedIds] }`.
 *
 * If the team does not exist, returns `{ team: null, pruned: [] }`. Lazy
 * pruning is SILENT — it fires no leave notice (§16.5).
 */
export async function pruneDeadMembers(
  name: string,
  isAlive: (agentId: string) => Promise<boolean> | boolean,
): Promise<{ team: Team | null; pruned: string[] }> {
  const team = await getTeam(name);
  if (!team) {
    return { team: null, pruned: [] };
  }
  // Unlocked liveness scan over the current roster.
  const deadInSnapshot: string[] = [];
  for (const member of team.members) {
    const alive = await isAlive(member);
    if (!alive) {
      deadInSnapshot.push(member);
    }
  }
  if (deadInSnapshot.length === 0) {
    // Common case: everyone alive — never touch the lock.
    return { team, pruned: [] };
  }
  // Dead members found — upgrade to a locked re-read + recompute against the
  // fresh copy, since the roster may have changed since the unlocked read.
  return withTeamsLock<{ team: Team | null; pruned: string[] }>(async (reg) => {
    const fresh = reg.teams[name];
    if (!fresh) {
      // Team was deleted between our unlocked read and acquiring the lock.
      return { reg, result: { team: null, pruned: [] } };
    }
    const pruned: string[] = [];
    const survivors: string[] = [];
    for (const member of fresh.members) {
      // Re-test liveness against the fresh roster — a member added in the race
      // window must be tested, and one removed must not be double-reported.
      const alive = await isAlive(member);
      if (alive) {
        survivors.push(member);
      } else {
        pruned.push(member);
      }
    }
    fresh.members = survivors;
    return { reg, result: { team: fresh, pruned } };
  });
}
