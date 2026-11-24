import { realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { accountHome } from "../home";
import { registeredRepoRoots } from "../hooks/agent-context";
import { readWorktreeCaller, resolveCallerAgentContext, resolveRemoteSharedCaller, type ResolvedCallerContext } from "../ib-commands";
import { checkCoordinatorExists, IB_COORDINATOR_SESSION } from "../coordinator";
import { isCoordinatorType } from "../coordinator-type-names";
import { hasGitWorktreeBacklink, registeredWorktreeRecord } from "../no-worktree-caller";
import { metadataRealpath, orderedEntryMatches, prepareAccessTable, resolvePathsConfig, type PathsConfig } from "../sandbox";
import { isAgentTmuxSession, matchWorktreeCaller } from "../runtime-names";
import { isHumanSendTerminal, isSystemPaneCaller } from "./remote-start-caller";

export const remoteCliCaller = { isHuman: isHumanSendTerminal, isSystem: isSystemPaneCaller };

export type VerifiedSendCaller = { kind: "user" } | { kind: "system" } | { kind: "agent"; caller: ResolvedCallerContext };

/** For local attribution, a human can use their own tmux session. Resolve the
 * invoking pane explicitly: tmux's default target can be another client. */
export async function localHumanInCheckout(cwd: string, recordedSession: unknown): Promise<boolean> {
  if (!matchWorktreeCaller(cwd)) return false;
  if (!process.env.TMUX) return remoteCliCaller.isHuman();
  const pane = process.env.TMUX_PANE;
  if (!pane || !/^%\d+$/.test(pane)) return false;
  try {
    const probe = Bun.spawnSync(["tmux", "display-message", "-p", "-t", pane, "#{session_name}"], {
      stdout: "pipe", stderr: "ignore", timeout: 2000,
    });
    const session = probe.stdout.toString().trim();
    return probe.exitCode === 0 && session !== "" && session !== recordedSession &&
      session !== IB_COORDINATOR_SESSION && !isAgentTmuxSession(session) &&
      await remoteCliCaller.isHuman(undefined, "local-send");
  } catch { return false; }
}

/** Local commands accept an explicit actor when the caller cannot be identified.
 * Spawning keeps its existing fail-closed caller permission gate. */
export async function localCliActor(cwd = process.cwd(), options: { forSpawn?: boolean; checkHuman?: boolean } = {}): Promise<VerifiedSendCaller> {
  let caller: ResolvedCallerContext | null;
  try {
    caller = await resolveCallerAgentContext(cwd, { includeWorktreePids: true, allowSessionFallback: !options.forSpawn });
  } catch (error) {
    if (options.forSpawn) throw error;
    // A restricted process table can still leave the caller's own worktree
    // metadata readable. Preserve that positive attribution.
    caller = await readWorktreeCaller(cwd);
  }
  if (caller && typeof caller.meta.id === "string") {
    // A human terminal can open an agent checkout and use the local override.
    if (options.checkHuman && await localHumanInCheckout(cwd, caller.meta.tmux_session)) {
      return { kind: "user" };
    }
    return { kind: "agent", caller };
  }
  return { kind: await remoteCliCaller.isSystem() ? "system" : "user" };
}

export function cliActorId(actor: VerifiedSendCaller, explicit?: string, flag = "--from"): string {
  if (actor.kind === "agent") {
    const id = String(actor.caller.meta.id);
    if (explicit !== undefined && explicit !== id) {
      throw new Error(`Error: agents can only act as themselves; drop ${flag}`);
    }
    return id;
  }
  return explicit ?? (actor.kind === "system" ? "@system" : "");
}

async function directoryIdentity(path: string): Promise<string | undefined> {
  try {
    const dir = await stat(path, { bigint: true });
    if (dir.isDirectory()) return `${dir.dev}:${dir.ino}`;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Match the closest registered directory by metadata, including APFS case aliases. */
async function registeredCallerRepo(roots: readonly string[], cwd: string, worktreeRepo?: string) {
  const registered = new Set<string>();
  for (const root of roots) {
    const id = await directoryIdentity(root);
    if (id) registered.add(id);
  }
  for (let dir = worktreeRepo ?? cwd; ; dir = dirname(dir)) {
    const id = await directoryIdentity(dir);
    if (id && registered.has(id)) return dir;
    if (worktreeRepo || dir === dirname(dir)) return undefined;
  }
}

/** Only the repo coordinator needs process ancestry in a shared checkout. */
export async function verifiedSendCaller(cwd: string, purpose: "attachments" | "remote", roots?: readonly string[]): Promise<VerifiedSendCaller> {
  if (await remoteCliCaller.isHuman()) return { kind: "user" };
  const refusal = purpose === "attachments"
    ? "cannot verify the sender for attachments; send from the agent's worktree or from a terminal"
    : "cannot verify the sender of a remote send; run it from a terminal or from the agent's worktree";
  const path = await realpath(cwd);
  const systemDir = join(accountHome(), ".itsybitsy");
  if (path === systemDir || path.startsWith(systemDir + "/")) {
    if (await remoteCliCaller.isSystem()) return { kind: "system" };
    throw new Error(refusal);
  }
  const worktree = matchWorktreeCaller(path);
  const repo = await registeredCallerRepo(roots ?? await registeredRepoRoots(accountHome()), path, worktree?.[1]);
  if (!repo) {
    if (worktree && purpose === "remote") throw new Error("Remote sends require the requester's repo to be registered");
    throw new Error(refusal);
  }
  if (worktree) {
    const caller = await registeredWorktreeRecord(path, [repo]);
    if (!caller || caller.meta.worktree !== true || isCoordinatorType(caller.meta.agentType)) throw new Error(refusal);
    // A remote worktree is only a broker destination here. Its watchdog
    // checks the seal, registration and backlink before publishing anything.
    if (purpose === "attachments") {
      const { deny } = prepareAccessTable({ ...resolvePathsConfig(caller.meta.paths as PathsConfig | undefined), runtimeRoots: [], runtimeDenyRoots: [] });
      const verified = await hasGitWorktreeBacklink(caller, true, file => {
        const canonical = metadataRealpath(file);
        if (!canonical || deny.some(entry => orderedEntryMatches(entry, canonical))) throw new Error(refusal);
        return file;
      });
      if (!verified) throw new Error(refusal);
    }
    return { kind: "agent", caller };
  }
  const coordinator = await checkCoordinatorExists(repo);
  if (!coordinator.exists || !coordinator.isCoordinator) throw new Error(refusal);
  const caller = await resolveRemoteSharedCaller(path, repo, coordinator.agentId).catch(() => null);
  if (!caller) throw new Error(refusal);
  return { kind: "agent", caller };
}
