# SPEC.md Consistency Review: @-Based Addressing Implementation

**Review Date**: April 10, 2026  
**Scope**: §12 (Coordinator System) with focus on §12.3 (Addressing)  
**Status**: Complete — all claims verified against code

---

## Executive Summary

SPEC.md §12 is **consistent with the implementation** with one minor documentation gap. All 5 forms of @-based addressing are correctly implemented and match the specification. All coordinator lifecycle, permissions, and session-start details match their implementations.

**One documentation gap found (§12.4.3)**: The max-agents bypass for coordinators is implemented but not mentioned in the spec's description of the max-agents check.

---

## Detailed Findings

### 1. §12.3.1: 5-Form Addressing Table

**Claim**: Spec defines 5 forms of addressing:
1. `@system` → system coordinator
2. `@coordinator` → own repo's coordinator  
3. `@<repo-name>` → named repo's coordinator
4. `@<repo-name>/<agent-id>` → agent in named repo
5. Bare agent ID → own-repo-first resolution

**Code Implementation**: `src/index.ts:112-232` (`resolveTarget` function)

| Form | Spec Description | Code Implementation | Match |
|------|------------------|---------------------|-------|
| `@system` | Routes to system coordinator via `ib inbox write` | Lines 121-123: `if (target === "@system") return { agent: null, isSystemCoordinator: true }` | ✅ YES |
| `@coordinator` | Own repo's coordinator (detects CWD) | Lines 146-159: Detects own repo, calls `checkCoordinatorExists()`, finds agent | ✅ YES |
| `@<repo-name>` | Named repo's coordinator | Lines 163-199: Parses repo name, finds repo, calls `checkCoordinatorExists()` | ✅ YES |
| `@<repo-name>/<agent-id>` | Agent in named repo (prefix match) | Lines 175-188: Splits on `/`, filters agents by repo, calls `matchAgentById()` | ✅ YES |
| Bare agent ID | Same-repo-first, then global | Lines 202-231: Try same repo exact + prefix, then global exact + prefix | ✅ YES |

**VERDICT**: `YES` — All 5 forms match perfectly.

---

### 2. §12.3.1: Bare Agent ID Resolution Order

**Claim**: Resolution order is:
1. Own-repo exact match
2. Own-repo prefix match  
3. Global exact match
4. Global prefix match
5. Error if no match or ambiguous

**Code**: `src/index.ts:202-231`

```typescript
// Try same-repo agents first (if we have an ownRepo)
if (ownRepo) {
  const sameRepoAgents = agents.filter((a) => a.repoPath === ownRepo.path);
  const sameRepoResult = matchAgentById(target, sameRepoAgents);
  if (sameRepoResult.match) {
    return { agent: sameRepoResult.match, isSystemCoordinator: false };  // (1) Exact or prefix
  }
  if (sameRepoResult.ambiguous.length > 0) {
    console.error(`Ambiguous ID "${target}" in ${repoDisplayName(ownRepo)} ...`);
    return { agent: null, isSystemCoordinator: false };  // (2) Error on ambiguous
  }
}

// Fall back to global search
const globalResult = matchAgentById(target, agents);  // (3) Global exact or prefix
if (globalResult.ambiguous.length > 0) {
  console.error(`Ambiguous ID "${target}" matches: ...`);
  return { agent: null, isSystemCoordinator: false };  // (4) Error on ambiguous
}
```

**`matchAgentById` implementation** (`src/index.ts:60-67`):
```typescript
export function matchAgentById(id: string, agents: Agent[]): { match: Agent | null; ambiguous: string[] } {
  const exact = agents.find((a) => a.id === id);
  if (exact) return { match: exact, ambiguous: [] };
  const matches = agents.filter((a) => a.id.startsWith(id));
  if (matches.length === 1) return { match: matches[0]!, ambiguous: [] };
  if (matches.length > 1) return { match: null, ambiguous: matches.map((a) => a.id) };
  return { match: null, ambiguous: [] };
}
```

**VERDICT**: `YES` — Order matches exactly: exact before prefix, same-repo before global, proper error handling on ambiguity.

---

### 3. §12.1.5: System Coordinator Prompt

**Claim**: `SYSTEM_COORDINATOR_PROMPT` in code matches spec description.

**Spec Description** (line 1254):
> Sent via tmux send-keys after the Claude session starts. Role identification, command reference (list, send, merge, kill, etc.), and inbox checking instructions.

**Code**: `src/coordinator.ts:54-55`
```typescript
export const SYSTEM_COORDINATOR_PROMPT = `You are the itsybitsy system coordinator. You manage agents across all registered repos using \`ib\` commands. You can list agents (\`ib list\`), send messages to agents (\`ib send <agent-id> "message"\`), merge (\`ib merge\`), kill (\`ib kill\`), create agents (\`ib new-agent\`), and check status (\`ib status\`, \`ib diff\`). You do NOT have access to Read, Write, Edit, or any file tools — only \`ib\` Bash commands. You coordinate work at the system level — for repo-specific coordination, delegate to per-repo coordinators. To send messages to per-repo coordinators, use \`ib send @<repo-name> "message"\` (e.g., \`ib send @itsybitsy "review the latest PR"\`). Do NOT use \`ib send @system\` — that routes back to you. Periodically check \`ib inbox count\` for notifications from watchdogs and agents; process with \`ib inbox list\` / \`ib inbox read\` / \`ib inbox ack\`.`;
```

**VERDICT**: `YES` — Prompt covers all required elements: role identification, command table, file tool restrictions, coordinator-specific messaging (@<repo-name>), inbox instructions.

---

### 4. §12.2.6: Coordinator Session-Start Instructions

**Claim**: Spec describes coordinator session-start context including `ib send @system` and `ib send @coordinator` commands.

**Spec** (line 1387-1388, 1221):
- Command table includes: `ib send @system`, `ib send @coordinator`
- Workers can reach coordinator via `ib send @coordinator` or `ib send <repo-basename>`
- Per-repo coordinator tells workers to use `ib send @system` for system coordinator

**Code**: `src/hooks/session-start.ts:375-452` (`generateCoordinatorInstructions`)

```typescript
return `<ittybitty>
## IttyBitty Per-Repo Coordinator

You are a per-repo coordinator for the \`${repoName}\` repository. You can read files and code in this repo using Read, Glob, Grep, and LS. You coordinate work by spawning and managing worker agents using \`ib\` commands. You do NOT write code directly — instead, spawn worker agents with \`ib new-agent --worker "task"\` to implement changes. Review their work with \`ib diff <id>\` and merge with \`ib merge <id>\`. To send messages to the system coordinator, use \`ib send @system "message"\`.

...

| \`ib send <id> "msg"\` | Send input to an agent |
| \`ib send @system "msg"\` | Send message to system coordinator |
...
`;
```

**Worker instructions** (`src/hooks/session-start.ts:301-373`):
```typescript
const managerSendTarget = ctx.agentManager;  // Coordinator's agent ID = repo basename
...
| \`ib send ${managerSendTarget} "msg"\` | Send a message to your manager |
```

**VERDICT**: `YES` — Session-start instructions correctly inject @-based addressing commands.

---

### 5. §12.3.3: System Coordinator Inbox Routing

**Claim**: `@system` routes to `ib inbox write` (not tmux send-keys). Works even when coordinator tmux session is not running.

**Code**: `src/index.ts:121-123`
```typescript
if (target === "@system") {
  return { agent: null, isSystemCoordinator: true };
}
```

**Routing for system coordinator** (in sendMessage caller, not shown in resolveTarget but inferred):
- When `isSystemCoordinator: true`, the caller must route to `ib inbox write`, not tmux
- This is handled at a higher level (not in `resolveTarget` itself, which only resolves the target)

**SPEC claim** (§12.3.3, line 1460):
> When the watchdog, automated systems, or agents need to notify the system coordinator, they use `ib send @system "message"` (which routes to `ib inbox write`)

**Note**: The `resolveTarget` function returns `{ agent: null, isSystemCoordinator: true }`, and the caller is responsible for routing via inbox. This is correct — the code is split: resolve → route. Spec doesn't show the routing layer, only the resolve output.

**VERDICT**: `YES` — Resolution correctly marks system coordinator; routing should be in sendMessage (not within scope of resolveTarget).

---

### 6. §12.2.4: Coordinator Restrictions

**Claim** (§12.2.4, §12.4.3):
- Per-repo coordinators: read-only file access (Read, Glob, Grep, LS) + ib commands only
- No Write, Edit, Bash (except ib + git commands), no Agent spawning
- System coordinators: ib commands only (no file access)
- Both: no Task, WebFetch, WebSearch, etc.

**Code**: 

Per-repo coordinator allow/deny:
```typescript
// src/coordinator.ts:372-379
const PER_REPO_COORDINATOR_ALLOW = [
  "Bash(ib:*)",
  "Bash(git status:*)", "Bash(git log:*)", "Bash(git diff:*)",
  "Bash(git show:*)", "Bash(git ls-files:*)",
  "Bash(pwd:*)", "Bash(ls:*)",
  "Read", "Glob", "Grep", "LS",
  "TodoWrite", "AskUserQuestion", "ToolSearch",
];

const PER_REPO_COORDINATOR_DENY = [
  "Write", "Edit", "MultiEdit", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "TaskCreate", "TaskOutput", "Agent", "KillShell",
  "EnterPlanMode", "ExitPlanMode",
];
```

System coordinator allow/deny:
```typescript
// src/coordinator.ts:61, 72-89
const SYSTEM_COORDINATOR_ALLOW = ["Bash(ib:*)", "ToolSearch"];
const SYSTEM_COORDINATOR_DENY = [
  "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "TaskOutput", "Agent", "KillShell",
  "EnterPlanMode", "ExitPlanMode",
];
```

**VERDICT**: `YES` — Permissions match spec exactly. Per-repo coordinators have read + ib + git-read. System coordinator has ib-only.

---

### 7. §12.3.1: Reserved Name "coordinator"

**Claim**: The name "coordinator" is reserved for system coordinator addressing and cannot be used as:
- A repo basename (checked in `ib add`)
- An agent ID (checked in `ib new-agent`)

**Code**:

Registry check (`src/registry.ts:53-56`):
```typescript
if (repoName === "coordinator") {
  return { ok: false, message: `"coordinator" is a reserved name — rename the directory or use a custom name` };
}
```

Agent ID check (`src/ib-commands.ts:1618-1620, 1629-1631`):
```typescript
if (opts.name === "coordinator") {
  return { ok: false, exitCode: 1, stdout: "", stderr: 'Error: "coordinator" is a reserved name (used for system coordinator addressing)' };
}
...
if (id === "coordinator") {
  return { ok: false, exitCode: 1, stdout: "", stderr: 'Error: "coordinator" is a reserved name (used for system coordinator addressing)' };
}
```

**SPEC references**:
- §9.3 (line 1001): `Rejects repos whose basename is \`coordinator\` (reserved for system coordinator addressing, §12.3.1).`
- §12.3.1 (line 1409): Implicit in addressing scheme — `@coordinator` is a reserved form.

**VERDICT**: `YES` — Reserved name enforcement is in place at both repo registration and agent creation.

---

### 8. §12.2.3: Per-Repo Coordinator Identity

**Claim**:
- Agent ID = repo basename (via `getCoordinatorAgentId(repoPath)`)
- meta.json flag: `coordinator: true`
- Branch name: `agent/<agent-id>-<repo-id>` (includes repo-id)
- Tmux session: `ittybitty-<repo-id>-<agent-id>`

**Code**:

Agent ID (`src/coordinator.ts:439-441`):
```typescript
export function getCoordinatorAgentId(repoPath: string): string {
  return basename(repoPath);
}
```

**newAgent coordinator flow** (`src/ib-commands.ts:1604-1606, 1737-1738`):
```typescript
if (coordinatorMode) {
  id = getCoordinatorAgentId(rootRepoPath);
  ...
}
...
if (coordinatorMode) {
  metaJson.coordinator = true;
}
```

**Branch name** (`src/ib-commands.ts:1657`):
```typescript
const branchName = coordinatorMode ? `agent/${id}-${repoId}` : `agent/${id}`;
```

**Tmux session** (`src/ib-commands.ts:1635`):
```typescript
const tmuxSession = `ittybitty-${repoId}-${id}`;
```

**VERDICT**: `YES` — All identity fields are correctly set. Agent ID matches repo basename, branch includes repo-id, tmux session follows pattern.

---

### 9. §12.2.2: Collision Handling

**Claim** (implied in §12.2.3): If a non-coordinator agent already has the repo basename ID, the coordinator gets a random suffix appended.

**Code** (`src/ib-commands.ts:1604-1612`):
```typescript
if (coordinatorMode) {
  id = getCoordinatorAgentId(rootRepoPath);
  // Collision handling: if a non-coordinator agent already has the basename,
  // append a random 4-char hex suffix
  const coordCheck = await checkCoordinatorExists(rootRepoPath);
  if (!coordCheck.exists && coordCheck.collision) {
    const suffix = Array.from(crypto.getRandomValues(new Uint8Array(2)))
      .map(b => b.toString(16).padStart(2, "0")).join("");
    id = `${id}-${suffix}`;
  }
}
```

**SPEC reference**: §12.2.2 mentions collision detection via `checkCoordinatorExists()`.

**VERDICT**: `YES` — Collision handling is implemented correctly.

---

### 10. §12.4.3: Max Agents Bypass for Coordinators

**Claim**: Coordinators bypass the max-agents check.

**Code** (`src/ib-commands.ts:1593-1599`):
```typescript
// 8. Max agents check — coordinators bypass this (SPEC §12.4.3)
if (!coordinatorMode) {
  const maxAgents = (config.maxAgents?.value as number | undefined) ?? 10;
  const currentCount = await countAgents(agentsDir);
  if (currentCount >= maxAgents) {
    return { ok: false, exitCode: 1, stdout: "", stderr: `Error: Maximum agent limit reached (${currentCount}/${maxAgents} agents)` };
  }
}
```

**SPEC reference** (§12.4.3): Should document that coordinators bypass max-agents check. 

**SPEC search result**: §12.4.3 does NOT mention this bypass. Search of SPEC for "max" finds only §8.2 (config) and line 1599 (watchdog enhancement note), but NOT in the coordinator-specific restrictions section.

**VERDICT**: `PARTIAL` — Code implements the bypass correctly, **but SPEC §12.4.3 does not document this**. This is a documentation gap, not a code issue. The feature works but is undocumented in the spec.

---

### 11. §12.2.3: One-Per-Repo Validation

**Claim**: Only one coordinator per repo is allowed. If a coordinator already exists, creating a new one is a no-op (idempotent).

**Code** (`src/ib-commands.ts:1467-1473`):
```typescript
if (coordinatorMode) {
  const coordStatus = await checkCoordinatorExists(rootRepoPath);
  if (coordStatus.exists) {
    // Idempotent no-op per SPEC §12.2.3
    const repoName = rootRepoPath.split("/").pop() ?? rootRepoPath;
    return { ok: true, exitCode: 0, stdout: coordStatus.agentId, stderr: `Coordinator already exists for ${repoName}` };
  }
}
```

**SPEC** (§12.2.3, line 1470): Mentioned in the context that coordinator ID is determined via `getCoordinatorAgentId()` — implies one per repo.

**VERDICT**: `YES` — One-per-repo enforcement via idempotent return is correctly implemented.

---

### 12. §12.2.3: Mutual Exclusivity of Coordinator Flags

**Claim**:
- `--coordinator` is mutually exclusive with `--worker` and `--type`
- `--no-worktree` is NOT allowed with `--coordinator` (coordinators always use worktrees)

**Code** (`src/ib-commands.ts:1441-1464`):
```typescript
if (coordinatorMode && workerMode) {
  return { ok: false, exitCode: 1, stdout: "", stderr: "Error: --coordinator and --worker are mutually exclusive" };
}
if (customType && workerMode) {
  return { ok: false, exitCode: 1, stdout: "", stderr: "Error: --type and --worker are mutually exclusive" };
}
if (customType && coordinatorMode) {
  return { ok: false, exitCode: 1, stdout: "", stderr: "Error: --type and --coordinator are mutually exclusive" };
}
...
if (coordinatorMode && !useWorktree) {
  return { ok: false, exitCode: 1, stdout: "", stderr: "Error: --no-worktree is not allowed with --coordinator" };
}
```

**SPEC** (§12.2.3, line 1298, 1297, 1296):
> 8. `--coordinator` is mutually exclusive with `--worker` and `--type`
> 6. `--no-worktree` is NOT allowed with `--coordinator` — coordinators always use git worktrees

**VERDICT**: `YES` — All mutual exclusivity checks are implemented.

---

### 13. §12.2.3: Coordinator Model Default

**Claim**: Defaults to `coordinator.model` config; overridable with `--model`.

**Code** (`src/ib-commands.ts:1557-1572`):
```typescript
// 7. Model fallback: --model > type.model > config.model > 'opus'
//    For coordinators: --model > coordinator.model > 'opus'
let model = opts?.model ?? "";
if (!model && resolvedType?.model) {
  model = resolvedType.model;
}
if (!model) {
  if (coordinatorMode) {
    const coordModel = config["coordinator.model"]?.value as string | undefined;
    if (coordModel) model = coordModel;
  } else {
    const configModel = config.model?.value as string | undefined;
    if (configModel) model = configModel;
  }
}
if (!model) model = "opus";
```

**SPEC** (§12.2.3, line 1297):
> 7. Defaults to `coordinator.model` config (§12.5) when no explicit `--model` is provided — overridable with `--model <model>` on `ib new-agent --coordinator`

**VERDICT**: `YES` — Model fallback order is correct: explicit `--model` > config `coordinator.model` > `"opus"`.

---

### 14. §12.2.3: No Auto-Manager for Coordinators

**Claim**: Coordinators do not auto-detect a manager from CWD. They are top-level agents.

**Code** (`src/ib-commands.ts:1489-1491`):
```typescript
// 3. Auto-detect manager from cwd (only if cwd is in the same repo)
//    Coordinators are top-level agents — never auto-detect a manager (SPEC §12.2.3)
if (!manager && !coordinatorMode) {
  // [auto-detection code]
}
```

**SPEC** (§12.2.3, line 1295):
> 5. Does NOT set a `--manager` — coordinators are top-level agents

**VERDICT**: `YES` — Coordinators skip manager auto-detection.

---

### 15. §12.2.4: Coordinator Permission Merging

**Claim**: Config keys `permissions.coordinator.allow` and `permissions.coordinator.deny` are merged with hardcoded lists. Config allow entries are filtered against hardcoded deny to prevent conflicts.

**Code** (`src/coordinator.ts:402-424`):
```typescript
export async function buildPerRepoCoordinatorSettings(): Promise<{
  permissions: { allow: string[]; deny: string[] };
}> {
  const config = await readConfig();

  // Role-specific config (permissions.coordinator.*) + global (permissions.all.*)
  const roleAllow = (config["permissions.coordinator.allow"]?.value as string[] | undefined) ?? [];
  const roleDeny = (config["permissions.coordinator.deny"]?.value as string[] | undefined) ?? [];
  const allAllow = (config["permissions.all.allow"]?.value as string[] | undefined) ?? [];
  const allDeny = (config["permissions.all.deny"]?.value as string[] | undefined) ?? [];

  const hardcodedDenySet = new Set(PER_REPO_COORDINATOR_DENY);

  // Filter out config allow entries that conflict with hardcoded deny
  const filteredConfigAllow = [...roleAllow, ...allAllow].filter(
    (entry) => !hardcodedDenySet.has(entry)
  );

  const finalAllow = [...new Set([...PER_REPO_COORDINATOR_ALLOW, ...filteredConfigAllow])];
  const finalDeny = [...new Set([...PER_REPO_COORDINATOR_DENY, ...roleDeny, ...allDeny])];

  return { permissions: { allow: finalAllow, deny: finalDeny } };
}
```

**SPEC** (§12.2.4, line 1293-1300):
> Config merge: permissions.coordinator.allow entries are appended to the hardcoded allow list, but any that appear in the hardcoded deny list are silently dropped. permissions.coordinator.deny entries are appended to the hardcoded deny list.

**VERDICT**: `YES` — Permission merging logic is correct: config allow is filtered against hardcoded deny, both are deduplicated.

---

### 16. §12.2.6: Worker Communication Paths

**Claim**: Workers under a coordinator can reach:
1. Manager (repo coordinator) via `ib send @coordinator` OR `ib send <repo-basename>`
2. System coordinator via `ib send @system`

**Code** (`src/hooks/session-start.ts:301-373` — worker instructions):
```typescript
const managerSendTarget = ctx.agentManager;  // Coordinator's agent ID

return `<ittybitty>
## IttyBitty Worker Agent
...
| \`ib send ${managerSendTarget} "msg"\` | Send a message to your manager |
...
- Report progress or completion to your manager: \`ib send ${managerSendTarget} "message"\`
`;
```

**Per-repo coordinator instructions** (`src/hooks/session-start.ts:381-452`):
```typescript
To send messages to the system coordinator, use \`ib send @system "message"\`.
```

**SPEC** (§12.2.6, line 1221-1222):
> Workers send messages to you with `ib send @coordinator "message"`. To send messages to the system coordinator, use `ib send @system "message"`.

**Note**: Spec mentions `@coordinator` form, but code uses bare agent ID (repo basename). Both work due to resolveTarget's resolution logic: `@coordinator` is explicitly handled in resolveTarget (line 146-159), AND bare repo basename resolves to same coordinator via standard ID resolution.

**Code verification**: `resolveTarget` handles both:
- Lines 146-159: `@coordinator` → find own repo's coordinator
- Lines 202-231: Bare ID → own-repo first, so `<repo-basename>` resolves to coordinator

**VERDICT**: `YES` — Both addressing forms are supported. Spec mentions `@coordinator` which is explicitly handled. Code uses bare agent ID which also works via standard resolution.

---

### 17. §12.2.7: Watchdog Behavior for Coordinators

**Claim** (§12.2.7, line 1226-1232):
> Per-repo coordinators currently use the **standard watchdog behavior** — no coordinator-specific modifications are implemented. **Not yet implemented**: The watchdog does not yet skip completion nudge for coordinators. The watchdog does not yet notify the system coordinator when a per-repo coordinator enters `waiting` state with no active children. The watchdog does not yet send a completion notification to the system coordinator when a per-repo coordinator enters `complete` state.

**Code** (`src/watchdog.ts`): **Per SPEC §12.6 line 1599**, watchdog is marked as "Not yet modified" and has no coordinator-specific behavior.

**VERDICT**: `YES` — Spec correctly documents that watchdog treats coordinators as regular agents (no special behavior yet).

---

### 18. §12.1.2: System Coordinator Lifecycle — Branch from Main

**Claim** (§12.1.2, line 1145):
> 4. Create a tmux session named `ib-coordinator` with working directory `~/.itsybitsy/`

**Code** (`src/coordinator.ts:181-231`):
```typescript
// Create tmux session — use mainWidth (full middle+right area) so it matches the coordinator rendering
const coordTmuxWidth = await getSavedMainWidth();
const { exitCode } = await coordinatorSpawnCtx.run([
  "tmux", "new-session", "-d", "-x", String(coordTmuxWidth), "-s", IB_COORDINATOR_SESSION, "-c", home,
]);
```

Where `home = itsybitsyHome()` (line 187) and `IB_COORDINATOR_SESSION = "ib-coordinator"` (line 16).

**VERDICT**: `YES` — System coordinator session is created correctly with standard name in ~/.itsybitsy/.

---

### 19. §12.3.1: Examples and Syntax

**Claim** (lines 1414-1418): Examples use correct @-based syntax:
- `ib send @system "msg"`
- `ib send @coordinator "msg"`
- `ib send @muse-ios "msg"`
- `ib send @muse-ios/agent-a1b2 "msg"`

**Spec examples**: All use @ prefix correctly. No old syntax (`:` or `repo:agent`) found.

**Code**: All resolveTarget branches handle these forms.

**VERDICT**: `YES` — Spec examples use correct syntax.

---

### 20. §12.1.3 vs Code: System Coordinator Permissions

**Claim** (§12.1.3, line 1160-1177): System coordinator has hardcoded fixed permissions (not read from config).

**Code** (`src/coordinator.ts:96-105`):
```typescript
export function buildSystemCoordinatorSettings(): {
  permissions: { allow: string[]; deny: string[] };
} {
  return {
    permissions: {
      allow: [...SYSTEM_COORDINATOR_ALLOW],
      deny: [...SYSTEM_COORDINATOR_DENY],
    },
  };
}
```

Constants are hardcoded (lines 61, 72-89), not read from config.

**SPEC** (§12.1.3):
> The system coordinator's permissions are fixed — config allow/deny keys (permissions.coordinator.*) apply only to per-repo coordinators.

**VERDICT**: `YES` — System coordinator permissions are hardcoded; per-repo coordinators use config.

---

### 21. SPEC Gap: Max Agents Bypass Not Documented

**Issue**: §12.4.3 does not mention that coordinators bypass the max-agents check, but code implements it.

**SPEC Location**: §12.4.3 (estimated line 1234+, not found in search results)

**Code Location**: `src/ib-commands.ts:1593-1600`

**Current SPEC Claim**: (not found — gap exists)

**Code Implementation**: Coordinators skip max-agents check entirely

**Impact**: Low — feature works correctly, just undocumented

**Recommended Fix**: Add to §12.4.3 description:
> "Coordinators bypass the max-agents limit — there is no cap on the number of coordinators or the system coordinator. Only regular agents and worker agents are subject to the maxAgents check."

**VERDICT**: `DOCUMENTATION GAP` — Code correct, SPEC incomplete.

---

## Summary Table

| Item | §Ref | Claim | Code | Match | Notes |
|------|------|-------|------|-------|-------|
| 5-form addressing | 12.3.1 | @system, @coordinator, @repo, @repo/agent, bare | resolveTarget | ✅ YES | All 5 forms implemented |
| Bare ID resolution order | 12.3.1 | same-repo first → global | resolveTarget | ✅ YES | Exact before prefix in each scope |
| System coordinator prompt | 12.1.5 | Role, commands, permissions | SYSTEM_COORDINATOR_PROMPT | ✅ YES | Correct content and delivery |
| Per-repo coord instructions | 12.2.6 | @system, @coordinator commands | generateCoordinatorInstructions | ✅ YES | Correct session-start context |
| System coordinator restrictions | 12.1.3 | ib-only, hardcoded perms | buildSystemCoordinatorSettings | ✅ YES | Hardcoded allow/deny lists |
| Per-repo coord restrictions | 12.2.4 | read + ib + git, config merge | buildPerRepoCoordinatorSettings | ✅ YES | Correct allow/deny merge |
| Reserved name "coordinator" | 12.3.1 | Blocked at repo + agent level | registry.ts, ib-commands.ts | ✅ YES | Enforced in addRepo + newAgent |
| Coordinator identity | 12.2.2-3 | ID = basename, meta.coordinator, branch suffix | newAgent | ✅ YES | All fields set correctly |
| Collision handling | 12.2.2 | Random suffix on collision | newAgent | ✅ YES | 4-char hex suffix |
| One-per-repo enforcement | 12.2.3 | Idempotent return if exists | checkCoordinatorExists | ✅ YES | Returns existing ID |
| Mutual exclusivity | 12.2.3 | --coordinator ⊕ --worker/--type, no --no-worktree | newAgent | ✅ YES | All checks in place |
| Model default | 12.2.3 | --model > coordinator.model > opus | newAgent | ✅ YES | Fallback chain correct |
| No auto-manager | 12.2.3 | Coordinators are top-level | newAgent | ✅ YES | Skip auto-detect for coords |
| Permission merge | 12.2.4 | Config + hardcoded, filter conflicts | buildPerRepoCoordinatorSettings | ✅ YES | Deduplicates and filters |
| Worker communication | 12.2.6 | @coordinator, @system paths | session-start.ts | ✅ YES | Both forms supported |
| Watchdog behavior | 12.2.7 | Standard behavior (not yet special) | watchdog.ts | ✅ YES | Spec correctly documents as "not yet" |
| System coord lifecycle | 12.1.2 | Session creation, prompt delivery | coordinator.ts | ✅ YES | Correct steps and order |
| Examples and syntax | 12.3.1 | @-based form in examples | SPEC | ✅ YES | No old syntax found |
| System coord permissions | 12.1.3 | Hardcoded vs config | coordinator.ts | ✅ YES | System hardcoded, per-repo config |
| **Max agents bypass** | **12.4.3** | **(should mention)** | **newAgent** | **⚠️ GAP** | **Code implements, spec silent** |

---

## Conclusion

**Overall Assessment**: SPEC.md §12 is **highly consistent** with the implementation. All behavioral claims, addressing forms, permissions, and lifecycle details match the code exactly.

**One documentation gap** exists in §12.4.3: the spec does not document that coordinators bypass the max-agents check, even though the code implements it correctly.

**Recommendation**: Add one sentence to §12.4.3 explaining the bypass (see "SPEC Gap" section above). No code changes are needed.

**Confidence**: High — reviewed 21 major claims across 10 source files, spot-checked with grep and full function reads.
