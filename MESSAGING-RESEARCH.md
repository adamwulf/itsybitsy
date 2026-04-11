# itsybitsy Message Sending Research Report

## Executive Summary

itsybitsy has a **two-tier messaging system**: regular agent-to-agent communication via `ib send <agent-id> "message"` (tmux-based), and programmatic coordinator notifications via `ib inbox write` (file-based message queue). Agent ID resolution supports exact matching and prefix matching, with special handling for coordinators. This report documents every code path, addressing mechanism, and edge case.

---

## 1. Ways to Send Messages Today

### 1.1 CLI (`ib send` command)

**Entry point**: `src/index.ts` lines 477–536

```typescript
case "send": {
  const repos = await listRepos();
  // Parse --from flag
  // Special case: 'ib send coordinator' routes to system coordinator inbox
  if (filteredSendArgs[0] === "coordinator") {
    const { inboxWrite } = await import("./inbox");
    const result = await inboxWrite(coordMessage, fromAgent ? { source: fromAgent } : undefined);
    // Output: "Sent to system coordinator"
  } else {
    const agent = await requireAgent(filteredSendArgs[0], repos);
    const { sendMessage } = await import("./ib-commands");
    await printAndExit(await sendMessage(agent, message, fromAgent ? { fromAgent } : undefined));
  }
}
```

**Two subpaths**:
- **`ib send coordinator "message"`** → Routes to system coordinator inbox (§1.2)
- **`ib send <agent-id> "message"`** → Finds agent by ID, calls `sendMessage()` (§1.3)

**Syntax**:
```bash
ib send [--from <id>] <agent-id> <message...>
ib send [--from <id>] coordinator <message...>
```

**stdin support**: If no message args provided and stdin is not TTY, reads message from stdin (lines 519–527).

### 1.2 System Coordinator Messaging: `ib inbox write`

**Entry point**: `src/index.ts` lines 875–936 (inbox subcommand)

**Implementation**: `src/inbox.ts` (lines 56–107)

```typescript
export async function inboxWrite(
  message: string,
  options?: { source?: string; cwd?: string },
): Promise<IbCommandResult> {
  // Source priority: (1) explicit --source, (2) auto-detected from CWD, (3) "manual"
  let source = options?.source;
  if (!source) {
    const detected = detectAgentIdFromCwd(options?.cwd ?? process.cwd());
    source = detected ?? "manual";
  }
  
  // Validate source against /^[\w-]+$/
  // Generate filename: <epoch_ms>-<random4hex>-<source>.msg
  // Enforce retention limit: keep last 100 messages
}
```

**Subcommands**:
- `ib inbox write --source <name> "message"` — Write to inbox (returns filename)
- `ib inbox list` — List all messages (newest first, tab-separated)
- `ib inbox read <filename>` — Read full message content
- `ib inbox ack <filename>` — Delete processed message (idempotent)
- `ib inbox count` — Count pending messages

**Inbox directory**: `~/.itsybitsy/coordinator-inbox/`

**Filename format**: `<epoch_ms>-<random4hex>-<source>.msg` (e.g., `1704825000123-a3f1-watchdog.msg`)

**Source detection** (priority order):
1. `--source <name>` flag (explicit)
2. `detectAgentIdFromCwd()` — auto-detect agent ID from CWD matching `/.ittybitty/agents/([^/]+)/repo`
3. `"manual"` — fallback for direct user calls or scripts

**Validation**: Source must match `/^[\w-]+$/` (word chars + hyphen)

**Routing** (`ib send coordinator`): Special case in `index.ts` line 492 detects exact string "coordinator" and routes to `inboxWrite()` before standard agent resolution (lines 507–514).

### 1.3 Agent-to-Agent Messaging: `ib send <agent-id> "message"`

**Entry point**: `index.ts` line 517 (after special "coordinator" case)

**Agent resolution**: `matchAgentById()` → `findAgentById()` (§2.1)

**Implementation**: `src/ib-commands.ts` lines 1074–1164

```typescript
export async function sendMessage(
  agent: Agent,
  message: string,
  opts?: { fromAgent?: string; cwd?: string }
): Promise<IbCommandResult> {
  const tmuxSession = agent.meta.tmux_session;
  if (!tmuxSession) {
    return { ok: false, exitCode: 1, stdout: "", stderr: "Agent has no tmux session" };
  }

  // 1. Verify tmux session exists
  // 2. Auto-detect sender from cwd if not provided
  // 3. Format message with [sent by agent <id>]: prefix
  // 4. Calculate delay: 0.1 + (msg_len / 100) * 0.5, clamped [0.2, 3.0]
  // 5. Send via tmux send-keys -l (literal mode to prevent key interpretation)
  // 6. Sleep for calculated delay
  // 7. Send Enter
  // 8. Log to both recipient's and sender's agent.log
  // 9. Write state: "running" to recipient's meta.json (marks agent as receiving input)
}
```

**Message flow**:
1. Extract `tmux_session` from agent metadata
2. Verify session exists via `tmux has-session -t <session>`
3. Auto-detect sender from CWD if `fromAgent` not provided (lines 1096–1108):
   - Match CWD against pattern `/.ittybitty/agents/(?:[^/]+)/repo`
   - Read sender's `meta.json` to extract agent ID
4. Prepend `[sent by agent <id>]: ` to message if sender detected (line 1113)
5. Calculate delay based on message length: `0.1 + (len / 100) * 0.5` seconds, clamped to [0.2, 3.0]
6. Send via `tmux send-keys -t <session> -l <message>` (literal mode prevents tmux from interpreting escape sequences)
7. Sleep for calculated delay (testable via `sendDelayOverrideMs`)
8. Send Enter via `tmux send-keys -t <session> Enter`
9. Log to recipient's `agent.log`: `"Received message from <sender>: <message>"` or `"Received message: <message>"`
10. Log to sender's `agent.log` (if sender detected): `"Sent message to <agent-id>: <message>"`
11. Update recipient's state to "running" (line 1160: `writeAgentState(agentDir, "running")`)

**Return value**: On success, `stdout` is empty (sender logs the send separately). On failure, exits with code 1 and stderr message.

### 1.4 TUI Messaging

**Implementation**: `src/tui/dashboard.ts` (large file, messaging delegated to CLI commands)

**Keybinding**: `s` key when agent is selected

**TUI message flow**:
1. Open input dialog
2. User enters message text
3. Run `ib send <agent-id> "<message>"` via `executeAndRefresh()`
4. Dialog closes, dashboard refreshes

**Coordinator messaging** (TUI):
- System coordinator: `s` key routes to input field at bottom of coordinator tmux pane
- Input uses `tmux send-keys -t ib-coordinator -l "<message>"` + `Enter` (manual version of agent messaging)
- Per-repo coordinator: Treated as regular agent (uses `ib send <repo-basename> "message"`)

---

## 2. Agent ID Resolution

### 2.1 Overview

**Two-stage process**:
1. **Exact match** — Check all agents for exact ID match
2. **Prefix match** — If no exact match, check for prefix matches; error if ambiguous

**Code**: `src/index.ts` lines 60–79

```typescript
export function matchAgentById(id: string, agents: Agent[]): 
  { match: Agent | null; ambiguous: string[] } {
  const exact = agents.find((a) => a.id === id);
  if (exact) return { match: exact, ambiguous: [] };
  
  const matches = agents.filter((a) => a.id.startsWith(id));
  if (matches.length === 1) return { match: matches[0]!, ambiguous: [] };
  if (matches.length > 1) return { match: null, ambiguous: matches.map((a) => a.id) };
  return { match: null, ambiguous: [] };
}
```

### 2.2 Exact Match Priority

**Highest priority**: Exact agent ID match (line 61–62)

Example:
```bash
ib send itsybitsy "message"  # Exact match on per-repo coordinator ID
ib send agent-a1b2c3d4 "message"  # Exact match on agent ID
```

**Edge case**: If a per-repo coordinator has agent ID `agent` and a regular agent has ID `agent-a1b2c3d4`, then:
- `ib send agent "msg"` → Exact match on coordinator (coordinator ID has priority)
- `ib kill agent` → Same exact match (no separate resolution logic for management vs messaging commands)

### 2.3 Prefix Matching

**Fallback**: If no exact match, prefix-match against all agent IDs (lines 63–66)

```bash
ib send agent-a "message"  # Matches agent-a1b2c3d4 (if unique)
ib send agent-a1b "message"  # Matches agent-a1b2c3d4 (if unique)
```

**Ambiguity handling**: If multiple agents match the prefix, error with list of candidates (line 74–76):
```
Ambiguous ID "agent-a" matches: agent-a1b2c3d4, agent-a1b2c3d5
```

### 2.4 Cross-Repo ID Resolution

**All agents resolved globally**: `findAgentById()` (lines 70–79) loads all agents from all registered repos, then calls `matchAgentById()` against the flattened list.

```typescript
export async function findAgentById(id: string, repos: RepoEntry[]): 
  Promise<Agent | null> {
  const { readAllAgents } = await import("./agents");
  const { agents } = await readAllAgents(
    repos.map((r) => ({ path: r.path, name: repoDisplayName(r) }))
  );
  const { match, ambiguous } = matchAgentById(id, agents);
  if (ambiguous.length > 0) {
    console.error(`Ambiguous ID "${id}" matches: ${ambiguous.join(", ")}`);
    process.exit(1);
  }
  return match;
}
```

**Impact**: An agent ID like `agent-a1b2c3d4` is unique across all registered repos. If two repos have agents with the same ID (rare but possible), the command fails with ambiguity error.

### 2.5 Special Case: `ib send coordinator`

**Handled before standard resolution** (`index.ts` line 492):

```typescript
if (filteredSendArgs[0] === "coordinator") {
  // Route to system coordinator inbox (inboxWrite)
  // Do NOT attempt standard agent resolution
}
```

**Why**: The string `"coordinator"` is reserved and cannot be used as an agent ID (`newAgent()` rejects it at lines 1618–1631 in ib-commands.ts). This ensures `ib send coordinator` always unambiguously routes to the system coordinator inbox, never to a per-repo coordinator or regular agent.

**Error message** (line 1619 / 1630):
```
Error: "coordinator" is a reserved name (used for system coordinator addressing)
```

### 2.6 How the Current Repo is Detected

**In `ib send`**: No CWD-based repo detection for message sending. The recipient agent is always resolved globally from all registered repos.

**In `ib inbox write`**: CWD-based source detection via `detectAgentIdFromCwd()` (inbox.ts lines 47–50):

```typescript
export function detectAgentIdFromCwd(cwd: string): string | undefined {
  const match = cwd.match(/\/\.ittybitty\/agents\/([^/]+)\/repo/);
  return match ? match[1] : undefined;
}
```

Pattern: If CWD is inside an agent worktree at `/.ittybitty/agents/<agent-id>/repo/*`, extract the agent ID.

**For agent creation** (`ib new-agent`): CWD-based repo detection (lines 659–669 in ib-commands.ts):

```typescript
const cwd = process.cwd();
const cwdMatch = repos.find((r) => cwd === r.path || cwd.startsWith(r.path + "/"));
if (cwdMatch) {
  repoPath = cwdMatch.path;
} else if (repos.length === 1) {
  repoPath = repos[0]!.path;
} else {
  console.error("Cannot determine target repo...");
  process.exit(1);
}
```

---

## 3. Instructions Each Agent Role Receives

**Implementation**: `src/hooks/session-start.ts` (all role instructions are generated here)

### 3.1 Primary Claude (User Session)

**Role detection**: CWD does not match `/.ittybitty/agents/...` pattern (lines 33–42)

**Instructions** (lines 135–188):
- Spawn **manager** agents (not `--worker`)
- Always use `ib` from PATH (not `./ib`)
- Bash rules: no piping, chaining, or subshells within single Bash call
- Commands table: `ib new-agent`, `ib list`, `ib look`, `ib send`, `ib status`, `ib diff`, `ib merge`, `ib kill`, `ib resume`, `ib questions`, `ib acknowledge`
- **No messaging examples** for primary Claude — messaging is agent-to-agent

### 3.2 Manager Agents

**Role detection**: `meta.worker !== true && meta.coordinator !== true && meta.type === undefined` (lines 62–71)

**Instructions** (lines 190–299):
- Agent ID: `${ctx.agentId}` (line 209)
- Branch: `${ctx.branchName}` forked from `${ctx.parentBranch}` (lines 210, 234–236)
- Manager: `${ctx.agentManager}` if applicable (line 211)
- **Messaging**: No explicit messaging instructions for managers in the template
- Spawn workers: `ib new-agent --worker "task"` (line 243)
- Commands: `ib send <id> "msg"` (line 246) — **targets sub-agents by ID**
- **Top-level managers only**: Can ask user questions via `ib ask "question"` (lines 195–203)
- State management: End with `WAITING` or `I HAVE COMPLETED THE GOAL` (lines 255–259)

### 3.3 Worker Agents

**Role detection**: `meta.worker === true || meta.type === "worker"` (lines 67–68)

**Instructions** (lines 301–373):
- Agent ID: `${ctx.agentId}` (line 310)
- Manager: `${ctx.agentManager}` (line 312) — **Always set for workers**
- Branch: `${ctx.branchName}` forked from `${ctx.parentBranch}` (lines 334–335)
- **Messaging to manager**: Line 344 — `ib send ${managerSendTarget} "msg"`
  - `managerSendTarget` is `ctx.agentManager` (line 305)
  - This is the manager's agent ID
- Commands: `ib send ${managerSendTarget} "msg"` (line 359)
- **No spawning**: Workers cannot spawn sub-agents (no `ib new-agent --worker` in instructions)
- Communication section (lines 357–362):
  - Report progress/completion: `ib send ${managerSendTarget} "message"`
  - Ask questions if unclear
  - If stuck: `ib send ${managerSendTarget} "[STUCK] description"`, then WAITING
  - Manager can send messages even after completion — worker will restart

### 3.4 Per-Repo Coordinators

**Role detection**: `meta.coordinator === true` (lines 57, 65–66)

**Instructions** (lines 375–453):
- Repo name: `${repoName}` — `basename(ctx.rootRepoPath)` (line 376)
- **Agent ID is repo basename** (line 381): "Your agent ID is `${repoName}`"
- Branch: `${ctx.branchName}` forked from `${ctx.parentBranch}` (lines 403–404)
- **Messaging**:
  - To system coordinator: `ib send coordinator "message"` (line 417) — **Routes to inbox**
  - To sub-agents: `ib send <id> "msg"` (line 416)
  - Workers send to coordinator: `ib send ${repoName} "message"` (detected from worker instructions line 344)
- Spawn workers: `ib new-agent --worker "task"` (line 413)
- Commands: List workers, send messages, review work, merge (lines 413–421)
- Workflow: Read code, break down tasks, spawn workers, review, merge/redirect (lines 433–438)

### 3.5 Custom Agent Types

**Role detection**: `meta.type` is set and not "manager", "worker", or "coordinator" (lines 59, 63–64)

**Instructions generation** (lines 455–530+ in session-start.ts):
- Resolve type definition via `resolveAgentType(ctx.typeName)` (line 111)
- **Messaging**: Depends on `canSpawnChildren` flag in type definition
  - If `canSpawnChildren`: Can spawn workers and send to them (same as manager)
  - If not `canSpawnChildren` and has manager: `ib send ${managerSendTarget} "msg"` (same as worker)
  - If no manager and cannot spawn: Limited messaging (only `ib diff`, `ib status`, `ib log`)
- Prompt: Type definition's `description` field (line 492)
- Communication section: Conditional on manager presence (lines 481–487)

---

## 4. Name Collisions Across Repos

### 4.1 Cross-Repo Agent ID Uniqueness

**Current behavior**: Agent IDs are **globally unique** across all registered repos. No namespacing by repo.

**Example**:
- Repo `itsybitsy`: Agent `agent-a1b2c3d4` spawned
- Repo `muse-ios`: Agent `agent-a1b2c3d4` also spawned
- Result: `ib send agent-a1b2c3d4 "msg"` is **ambiguous**, command fails

**Mitigation**: Agent IDs are randomly generated (4 random hex bytes, ~16M unique IDs), making collisions extremely unlikely in practice.

### 4.2 Per-Repo Coordinator Name Collisions

**Coordinator agent ID**: `getCoordinatorAgentId(repoPath)` returns `basename(repoPath)` (coordinator.ts line 439–440)

**Collision handling** (ib-commands.ts lines 1606–1613):
```typescript
if (coordinatorMode) {
  id = getCoordinatorAgentId(rootRepoPath);  // e.g., "itsybitsy"
  const coordCheck = await checkCoordinatorExists(rootRepoPath);
  if (!coordCheck.exists && coordCheck.collision) {
    // A non-coordinator agent already has this basename
    const suffix = // random 4-char hex
    id = `${id}-${suffix}`;  // e.g., "itsybitsy-a3f1"
  }
}
```

**Collision check** (coordinator.ts lines 453–495):
```typescript
export async function checkCoordinatorExists(repoPath: string): Promise<
  | { exists: true; isCoordinator: true; agentId: string }
  | { exists: false; collision: boolean }
> {
  // 1. Check if any agent has coordinator: true in meta.json
  // 2. Check if any non-coordinator agent has ID matching repo basename
  // 3. Return { exists: true, ... } or { exists: false, collision: hasCollision }
}
```

**Steps**:
1. Scan all agent directories in `.ittybitty/agents/`
2. Parse each agent's `meta.json`
3. If found `coordinator: true`: Return `{ exists: true, isCoordinator: true, agentId: "<agent-id>" }`
4. If any agent ID equals `basename(repoPath)`: Set `collision = true`
5. Return `{ exists: false, collision }` (no coordinator, but note if collision exists)

**Result**: If repo basename is "itsybitsy" and a regular agent already has ID "itsybitsy", the coordinator gets ID "itsybitsy-a3f1" instead. They can coexist, but the coordinator is addressed as "itsybitsy-a3f1", not "itsybitsy".

### 4.3 Reserved Name "coordinator"

**Reserved globally**: The string `"coordinator"` cannot be an agent ID (ib-commands.ts lines 1618–1631)

**Two checks**:
```typescript
if (opts?.name) {
  // ...
  if (opts.name === "coordinator") {
    return { ok: false, exitCode: 1, ..., stderr: 'Error: "coordinator" is a reserved name...' };
  }
  id = opts.name;
}

// ... later ...

if (id === "coordinator") {
  return { ok: false, exitCode: 1, ..., stderr: 'Error: "coordinator" is a reserved name...' };
}
```

**Repo name check** (index.ts, `ib add` command): Rejects repos whose basename is "coordinator" (not shown in code snippets, but documented in SPEC.md)

---

## 5. Edge Cases and Failure Modes

### 5.1 Message to Non-Running Agent

**Symptom**: `ib send <agent-id> "message"` fails

**Code** (ib-commands.ts lines 1085–1093):
```typescript
const hasSessionProc = sendSpawnCtx.runner(
  ["tmux", "has-session", "-t", tmuxSession],
  { stdout: "pipe", stderr: "pipe" }
);
await new Response(hasSessionProc.stderr).text(); // drain
const hasSessionExit = await hasSessionProc.exited;
if (hasSessionExit !== 0) {
  return { ok: false, exitCode: 1, stdout: "", stderr: `Agent '${agent.id}' is not running` };
}
```

**Exit code**: 1

**Error message**: `"Agent '<id>' is not running"`

**Recovery**: 
- If agent is stopped: `ib resume <id>` to restart it
- If agent is running but tmux session crashed: The watchdog will recreate the tmux session
- If agent is merged/killed: Message is lost

### 5.2 Agent with No Metadata

**Symptom**: `ib send <agent-id> "message"` with agent that has invalid/missing `meta.json`

**Current behavior**: The agent won't be found by `readAllAgents()` (agents.ts) because it filters for agents with valid `meta.json`. The `send` command will fail with `"Agent not found: <id>"`.

**Prevention**: `readAllAgents()` only includes agents with valid `meta.json` in the result list.

### 5.3 Message Sender Not Detected

**Symptom**: `ib send <agent-id> "message"` called without `--from` flag and CWD is not an agent worktree

**Behavior** (ib-commands.ts lines 1095–1108):
```typescript
let fromId = opts?.fromAgent ?? "";
if (!fromId) {
  const cwd = opts?.cwd ?? process.cwd();
  const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/(?:[^/]+)\/repo/);
  if (worktreeMatch) {
    // Read sender's meta.json
    const senderAgentDir = cwd.replace(/(\/\.ittybitty\/agents\/[^/]+)\/repo.*/, "$1");
    try {
      const senderMeta = await Bun.file(join(senderAgentDir, "meta.json")).json();
      if (senderMeta?.id) fromId = senderMeta.id;
    } catch { /* ignore */ }
  }
}
```

**Result**: `fromId` remains empty string, no sender prefix added to message (line 1112–1114):
```typescript
if (fromId) {
  fullMessage = `[sent by agent ${fromId}]: ${message}`;
}
```

**Impact**: Message sent without prefix, recipient log shows `"Received message: <message>"` instead of `"Received message from <sender>: <message>"`. Sender log not written.

### 5.4 Circular Manager References

**Symptom**: Agent A has manager B, agent B has manager A

**Prevention**: `reassignAgent()` (ib-commands.ts lines 654–658) checks for circular dependencies:
```typescript
const descendants = await getDescendantsRecursive(agentsDir, agent.id);
if (descendants.includes(newManager)) {
  return { ok: false, exitCode: 1, ..., stderr: `Circular dependency: '${newManager}' is a descendant of '${agent.id}'` };
}
```

**Note**: This only prevents **reassignment** into a descendant. The original spawn path (line 1659 in newAgent):
```typescript
const baseRef = manager ? `agent/${manager}` : "HEAD";
```
does not validate manager existence/circularity at creation time — validation happens during `reassignAgent()`.

### 5.5 Inbox Message with Invalid Source

**Symptom**: `ib inbox write --source "evil/../../etc/passwd" "message"`

**Prevention** (inbox.ts lines 68–75):
```typescript
if (!isValidSource(source)) {
  return {
    ok: false,
    exitCode: 1,
    stdout: "",
    stderr: `Invalid source: ${source}`,
  };
}
```

**Validation** (validation.ts): `isValidSource()` — must match `/^[\w-]+$/` (word chars + hyphen)

**Error**: Rejected before file write

### 5.6 Very Long Messages

**Symptom**: Message > 3000 characters

**Behavior** (ib-commands.ts lines 1116–1120):
```typescript
const msgLen = fullMessage.length;
let delay = 0.1 + (msgLen / 100) * 0.5;
if (delay < 0.2) delay = 0.2;
if (delay > 3.0) delay = 3.0;
```

**Result**: Delay clamped to 3.0 seconds. Message sent via `tmux send-keys -l` which has no length limit in practice.

**Risk**: Very long messages could exceed terminal input buffer or Claude's input processing limit, but this is handled by Claude Code's prompt handling, not itsybitsy.

### 5.7 Message with Control Characters

**Symptom**: Message contains `\n`, `\x03` (Ctrl-C), etc.

**TUI coordinator messaging** (coordinator.ts lines 108–121):
```typescript
export function sanitizeTmuxInput(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) {
      result += text[i]!;
    }
  }
  return result;
}
```

**Applies to**: System coordinator tmux send-keys (SPEC §12.3.3)

**Does NOT apply to**: Regular agent messaging via `ib send` or `ib inbox write` (no sanitization). Agent receiving tmux input may interpret control characters.

**Impact**: Control characters in `ib send` messages are passed through literally to the tmux session, where Claude Code's terminal may interpret them (risk: abort input with Ctrl-C, etc.).

### 5.8 Inbox Message Retention

**Symptom**: Many messages queued in inbox

**Enforcement** (inbox.ts lines 100–104):
```typescript
const files = await listMessageFiles();
if (files.length > MAX_MESSAGES) {
  const toDelete = files.slice(0, files.length - MAX_MESSAGES);
  await Promise.all(toDelete.map((f) => unlink(join(inboxDir, f)).catch(() => {})));
}
```

**MAX_MESSAGES**: 100 (line 14)

**Behavior**: After writing a new message, if inbox > 100, delete oldest messages until exactly 100 remain.

**Old messages deleted without notification**. System coordinator should process messages regularly via `ib inbox list` / `ib inbox read` / `ib inbox ack`.

### 5.9 Ambiguous Prefix Match

**Symptom**: `ib send agent-a "message"` with agents `agent-a1b2c3d4` and `agent-a5f6e7d8`

**Behavior** (index.ts lines 73–77):
```typescript
const { match, ambiguous } = matchAgentById(id, agents);
if (ambiguous.length > 0) {
  console.error(`Ambiguous ID "${id}" matches: ${ambiguous.join(", ")}`);
  process.exit(1);
}
```

**Output**:
```
Ambiguous ID "agent-a" matches: agent-a1b2c3d4, agent-a5f6e7d8
```

**Exit code**: 1

**Resolution**: Use full agent ID or longer prefix

### 5.10 Message to Coordinator from Non-Worker Agent

**Symptom**: Manager agent (not a worker) sends message to its own agent ID

**Current code path**: `ib send <own-id> "message"`

**Behavior**: Standard agent resolution finds self, `tmux send-keys` injects message into own tmux session. Agent receives own message.

**Intended behavior**: Managers should use `ib new-agent --worker` to spawn children, not message themselves.

**No validation** prevents this edge case.

### 5.11 Workers Messaging Each Other

**Symptom**: Worker agent A tries to send message to worker agent B under same manager

**Current behavior**: `ib send <agent-b-id> "message"` works normally (standard agent resolution, tmux send-keys).

**Instructions contradict this**: Worker instructions (session-start.ts line 359) say `ib send ${managerSendTarget} "msg"` — workers should only message their manager, not siblings.

**No enforcement** prevents workers from messaging peers. They can do it, but it's outside the designed workflow.

---

## 6. Summary Table: Agent Role Messaging

| Role | Can Receive Messages From | Can Send Messages To | How |
|------|--------------------------|---------------------|-----|
| **Primary Claude** | All agents | All agents | `ib send <id> "msg"` (CLI) |
| **Manager** | Primary, peer managers, own workers | Own workers, higher managers | `ib send <id> "msg"` |
| **Worker** | Primary, own manager, peer workers* | Own manager | `ib send <manager> "msg"` |
| **Per-Repo Coordinator** | System coordinator, own workers | Own workers, system coordinator | `ib send <id> "msg"` or `ib send coordinator "msg"` |
| **System Coordinator** | Per-repo coordinators, agents via inbox | Per-repo coordinators, agents | `ib inbox list/read/ack` (inbox), `ib send <id> "msg"` (to agents) |

*Not enforced by instructions; technically possible via standard agent resolution.

---

## 7. Implementation Files Summary

| File | Purpose | Messaging Code |
|------|---------|-----------------|
| `src/index.ts` | CLI entry point | `ib send` command parsing (lines 477–536), special `"coordinator"` routing |
| `src/ib-commands.ts` | Agent mutation commands | `sendMessage()` implementation (lines 1074–1164) |
| `src/inbox.ts` | System coordinator message queue | `inboxWrite()`, `inboxList()`, `inboxRead()`, `inboxAck()` |
| `src/coordinator.ts` | Coordinator lifecycle and settings | `sanitizeTmuxInput()` for control char stripping, per-repo coordinator prompt generation |
| `src/hooks/session-start.ts` | Role-based instruction generation | Role detection, messaging instructions for each role (manager, worker, coordinator) |
| `src/agents.ts` | Agent metadata and state | Agent tree building, state detection (used by messaging to find agents) |
| `SPEC.md §12.3` | Specification | Addressing coordinators, special "coordinator" routing, inbox command spec |

---

## 8. Key Design Decisions

1. **Global agent ID resolution**: All agent IDs are unique across repos. No namespace isolation. Enables cross-repo messaging but requires CWD-based detection for multi-repo workflows.

2. **Exact match priority**: Exact IDs take priority over prefix matches, but there's no separate logic for management vs messaging commands — both use the same resolution.

3. **Reserved "coordinator" name**: Ensures `ib send coordinator` always unambiguously routes to system coordinator inbox, never a per-repo coordinator or regular agent.

4. **Two messaging tiers**:
   - **Regular agent-to-agent**: Via tmux `send-keys` (requires agent to be running)
   - **Programmatic coordinator notifications**: Via file-based inbox (asynchronous, queued)

5. **No sender authentication**: Sender ID auto-detected from CWD or explicitly provided via `--from`. No cryptographic signature or verification.

6. **Message delivery guarantees**: `ib send` returns immediately after tmux injection; no delivery confirmation. Inbox messages can be lost if > 100 messages queue up.

I HAVE COMPLETED THE GOAL

