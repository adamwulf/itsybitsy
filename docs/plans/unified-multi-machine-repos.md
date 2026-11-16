# Unified repos across machines (future idea)

Status: an idea Adam recorded on 2026-11-16, for after iroh peering v1
([iroh-peering.md](iroh-peering.md)). Not planned or scheduled.

## The idea

v1 shows each paired install as its own read-only section in the sidebar
tree. The longer-term shape is different:

- **One repo list.** Repos from every paired machine merge into a single list.
  A repo appears once, even if it exists on several machines.
- **Agents belong to a machine.** Each agent row shows which computer it runs
  on. Agents on different machines work like agents on the same machine: they
  can message each other, and so on.
- **Repos appear on demand.** You can add an agent for a repo on a machine
  that doesn't have that repo yet. That machine clones the repo and then
  creates the agent. You don't set the repo up on the second machine by hand.

## How it relates to v1

- v1's per-install tree sections are a stepping stone. The pairing, trust, and
  reconnection work carries over unchanged.
- The trusted `itsybitsy/peer/1` link becomes the transport for more ops:
  cross-machine `ib send`, remote new-agent, and later possibly remote
  retire/merge.
- v1 is strictly read-only. This idea adds remote *mutations*. Each one means
  one machine makes another start or drive agents, which amounts to running
  code there. That needs its own trust decision.

## Questions to answer before planning

1. **Repo identity across machines.** How do we know two machines hold the
   same repo? Options include the `.itsybitsy/repo-id` file, the git remote
   URL, or the root commit hash. Different clones of one repo must merge, and
   unrelated repos with the same name must not.
2. **Cloning source.**
   - Clone from the shared git remote (GitHub, etc.). This needs credentials
     on the second machine.
   - Or fetch over iroh from the machine that has the repo. That works for
     local-only repos, but it means building git transfer over iroh.
3. **Choosing a machine.** How does the new-agent form pick the machine? Is
   there a default? What happens when the chosen machine is offline?
4. **Cross-machine messaging.** `ib send` to a remote agent must deliver into
   that machine's outbox. How do the sender id, the watchdog notes, and
   manager/child relationships work when the manager and the worker are on
   different machines?
5. **Permissions.** Which remote actions need confirmation on the target
   machine, and which are trusted automatically once paired? Do agents get
   to start cross-machine actions, or only the human?
6. **Merging and branches.** When an agent's worktree is on machine B, where
   do `ib merge` and `ib diff` run, and how do the results get back to the
   repo on machine A?
7. **Offline machines.** How should the unified list show agents and repos
   on a machine that is asleep or unreachable?

## Cheap things v1 could do now to make this easier (optional, not in scope)

- Have the `agents` op also send a stable repo identity (for example the
  `.itsybitsy/repo-id` contents or the git remote URL) next to `repoName` and
  `repoPath`. Then a later unified tree can merge repos without changing the
  protocol.
