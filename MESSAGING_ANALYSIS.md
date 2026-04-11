# ib send Messaging System — Complete Analysis

## 1. Every Way a Message Can Be Sent

### 1.1 CLI: `ib send <target> <message>`
**File**: `src/index.ts:477-536`

The CLI `send` command has two distinct paths:

**Path A — System Coordinator (`ib send coordinator "msg"`):**
- Checked FIRST, before any agent ID resolution (line 492)
- Routes to `inboxWrite()` from `src/inbox.ts`
- Writes a `.msg` file to `~/.itsybitsy/coordinator-inbox/`
- Supports `--from <id>` flag (passed as `source` to inbox)
- Supports stdin piping for message body
- Source auto-detection: agent ID from CWD if in a worktree, else "manual"
- Does NOT use tmux send-keys — purely file-based
- Works even when coordinator tmux session isn't running

**Path B — Any Agent (`ib send <agent-id> "msg"`):**
- Resolves target via `requireAgent()` → `findAgentById()` → `matchAgentById()`
- Calls `sendMessage(agent, message, opts)` from `src/ib-commands.ts`
- Supports `--from <id>` flag (explicit sender identification)
- Supports stdin piping for message body
- Uses tmux send-keys to inject text into the agent's tmux session

### 1.2 TUI: `s` Key or Input Fields
**File**: `src/tui/agent-actions.ts:358-421`, `src/tui/dashboard.ts:618-668`

Three distinct TUI send paths:

**Path A — Send to Regular Agent (via `s` key):**
- `handleSend()` in `agent-actions.ts:358`
- Opens a textarea dialog, calls `sendMessage(agent, text, { cwd: "/" })`
- Has a "Send All" toggle that broadcasts to ALL non-archived agents with active tmux sessions
- Always passes `{ cwd: "/" }` to prevent auto-detecting sender from TUI's CWD

**Path B — Send to System Coordinator (via `s` key when coordinator selected):**
- `handleSendToCoordinator()` in `agent-actions.ts:405`
- Opens a textarea dialog
- Sanitizes with `sanitizeTmuxInput()` (strips control chars < 0x20 and 0x7F)
- Calls `sendTmuxKeys(IB_COORDINATOR_SESSION, sanitized)` — direct tmux injection
- Does NOT use the inbox system — goes straight to tmux

**Path C — Input Field Components (always-visible input at bottom of panes):**
- Regular agent input field: `dashboard.ts:618-625` → `sendMessage(agent, text, { cwd: "/" })`
- System coordinator input field: `dashboard.ts:636-650` → `sendTmuxKeys(IB_COORDINATOR_SESSION, sanitized)` (direct tmux)
- Per-repo coordinator input field: `dashboard.ts:654-668` → `sendMessage(agent, text, { cwd: "/" })` (treats it like a regular agent)

### 1.3 Programmatic: `sendMessage()` Function
**File**: `src/ib-commands.ts:1074-1164`

The core implementation used by both CLI Path B and all TUI agent sends:

1. Validates agent has a `tmux_session` field
2. Verifies tmux session exists via `tmux has-session`
3. Auto-detects sender from CWD (regex: `/.ittybitty/agents/(?:[^/]+)/repo`) — reads sender's meta.json to get ID
4. Formats message: if sender known, prepends `[sent by agent <id>]: `
5. Calculates delay: `0.1 + (len / 100) * 0.5`, clamped to [0.2, 3.0] seconds
6. Sends via `tmux send-keys -t <session> -l <message>`, sleeps, then sends `Enter`
7. Logs to recipient's `agent.log`: "Received message from <sender>: <msg>" or "Received message: <msg>"
8. Logs to sender's `agent.log` (if sender known): "Sent message to <recipient>: <msg>"
9. Writes `state: "running"` to recipient's `meta.json` (agent just received input)

### 1.4 Programmatic: `inboxWrite()` Function
**File**: `src/inbox.ts:56-107`

Used for system coordinator messaging:
1. Determines source: explicit > CWD auto-detect > "manual"
2. Validates source against `/^[\w-]+$/`
3. Writes to `~/.itsybitsy/coordinator-inbox/<epoch>-<hex4>-<source>.msg`
4. Enforces retention limit (max 100 messages, oldest deleted)

### 1.5 Direct tmux: `sendTmuxKeys()` Function
**File**: `src/tmux-poller.ts:228-246`

Low-level tmux injection used for system coordinator TUI messaging:
1. `tmux send-keys -t <session> -l <text>` (literal mode)
2. `tmux send-keys -t <session> Enter`
3. No sender identification, no logging, no state updates

---

## 2. Agent ID Resolution

**File**: `src/index.ts:60-99`

### `matchAgentById(id, agents)` — Core Resolution Algorithm
1. **Exact match**: `agents.find(a => a.id === id)` — returns immediately if found
2. **Prefix match**: `agents.filter(a => a.id.startsWith(id))`
   - If exactly 1 prefix match → return it
   - If > 1 prefix matches → return `{ match: null, ambiguous: [...ids] }` (error)
   - If 0 matches → return `{ match: null, ambiguous: [] }` (not found)

### `findAgentById(id, repos)` — Cross-Repo Resolution
1. Calls `readAllAgents()` across ALL registered repos
2. Passes all agents (from all repos) to `matchAgentById()`
3. On ambiguous match: prints error to stderr, exits with code 1
4. Returns null if not found

### `requireAgent(idArg, repos)` — CLI Wrapper
1. Validates ID argument exists
2. Calls `findAgentById()`
3. On null result: prints "Agent not found: <id>", exits with code 1

### Key Properties:
- Resolution is **global** — searches ALL repos, not just the current one
- No repo scoping — `ib send foo "msg"` searches everywhere
- Per-repo coordinators have ID = repo basename (e.g., `itsybitsy`), so they're found by exact match
- Prefix matching means `ib send agent "msg"` could match `agent-a1b2c3d4` if no exact match exists

---

## 3. Instructions Each Agent Role Receives About Messaging

**File**: `src/hooks/session-start.ts`

### Primary Claude (not an agent)
- Told: `ib send <id> "msg"` — Send input to agent
- No specific addressing instructions for coordinators
- No `--from` flag documentation

### Manager Agents
- Told: `ib send <id> "msg"` — Send input to an agent (in commands table)
- Communication section says: `ib send <id> "feedback"` to redirect workers
- Can send to completed/stopped agents (they restart)
- NOT told about `ib send coordinator` or how to reach system coordinator
- No `--from` flag documentation

### Worker Agents
- Told: `ib send <managerSendTarget> "msg"` — Send a message to your manager
- `managerSendTarget` = `ctx.agentManager` (the actual manager agent ID)
- Communication section: "Report progress or completion to your manager: `ib send <managerTarget> "message"`"
- "[STUCK]" prefix convention documented
- NOT told about `ib send coordinator` or cross-repo messaging

### Per-Repo Coordinator Agents
- Told: `ib send <id> "msg"` — Send input to an agent
- Told: `ib send coordinator "msg"` — Send message to system coordinator
- Told: Workers send to them with `ib send <repoName> "message"` (in `perRepoCoordinatorPrompt()`)
- Has both sub-agent management AND coordinator communication

### Custom Type Agents
- If `canSpawnChildren`: gets full command table including `ib send <id> "msg"`
- If has manager: gets `ib send <managerTarget> "msg"` to communicate with manager
- Communication section same as worker pattern (if has manager)

### System Coordinator (hardcoded prompt)
- From `coordinator.ts:55`: Told `ib send <agent-id> "message"` for messaging agents
- Told `ib send <repo-name> "message"` for per-repo coordinators (e.g., `ib send itsybitsy "review the latest PR"`)
- Told "Do NOT use `ib send coordinator` — that routes back to you"
- Told to check `ib inbox count` for incoming notifications

---

## 4. What Happens When Agent Names Collide Across Repos

### Scenario: Two repos each have `agent-a1b2c3d4`

`readAllAgents()` returns agents from ALL repos in a flat list. `matchAgentById()` does exact match first — if two agents have the same ID, `agents.find()` returns the FIRST one found (whichever repo was iterated first). **This is undefined behavior** — the order depends on `Promise.all` resolution order of `readRepoAgents()` calls.

### Scenario: Prefix collision across repos

If repo A has `agent-a1b2c3d4` and repo B has `agent-a1b2ffff`, then `ib send agent-a1b2 "msg"` triggers the ambiguous match path → error and exit.

### Scenario: Per-repo coordinator vs regular agent

If a per-repo coordinator has ID `itsybitsy` and another repo has an agent also named `itsybitsy` (unlikely but possible via `--name`), exact match returns the first one found. The `newAgent()` function only checks for uniqueness within the SAME repo (`agentDir` existence check at line 1639), not across repos.

### Coordinator collision handling

When creating a coordinator, `newAgent()` calls `checkCoordinatorExists()`. If a NON-coordinator agent already has the repo basename as its ID, it appends a random 4-char hex suffix (e.g., `itsybitsy-a3f1`). This prevents the coordinator from shadowing an existing agent, but it means `ib send itsybitsy "msg"` would still route to the non-coordinator agent, not the coordinator.

---

## 5. How 'Current Repo' Is Detected (CWD-Based)

### For `ib send` CLI command
- The `ib send` command does NOT use CWD for repo detection
- It loads ALL repos via `listRepos()` and searches globally
- CWD is only used for sender auto-detection (in `sendMessage()`)

### Sender Auto-Detection in `sendMessage()`
**File**: `src/ib-commands.ts:1096-1108`
- Regex: `/.ittybitty/agents/(?:[^/]+)/repo/`
- Extracts agent dir from CWD, reads `meta.json` to get sender ID
- Falls back to empty string (no sender prefix) if not in a worktree

### Sender Auto-Detection in `inboxWrite()`
**File**: `src/inbox.ts:47-49`
- Regex: `/.ittybitty/agents/([^/]+)/repo/`
- Extracts agent ID directly from CWD path
- Falls back to "manual" if not in a worktree

### TUI Send Path
- All TUI sends pass `{ cwd: "/" }` — deliberately bypasses sender auto-detection
- This means TUI-sent messages have no sender prefix

### Agent Role Detection in Session-Start Hook
**File**: `src/hooks/session-start.ts:28-105`
- Uses `AGENT_CWD_PATTERN` to detect agent context from CWD
- Extracts `rootRepoPath` from CWD (everything before `/.ittybitty/agents/`)
- This determines which repo the agent belongs to

---

## 6. Edge Cases and Failure Modes

### 6.1 Sending to a Stopped/Dead Agent
- `sendMessage()` checks `tmux has-session` — if session is dead, returns error: "Agent '<id>' is not running"
- The TUI and CLI both document that you can send to completed/stopped agents to restart them, but `sendMessage()` itself doesn't restart the agent
- `resumeAgent()` is a separate function — must be called first to restart the tmux session

### 6.2 Race Condition: Message During Compaction
- If an agent is compacting context, the tmux send-keys injection will queue the text in the terminal
- The agent will see it after compaction completes
- No protection against this — text accumulates in the terminal buffer

### 6.3 System Coordinator: Two Different Messaging Paths
- **TUI**: Direct `tmux send-keys` (real-time, but can race with active responses)
- **CLI `ib send coordinator`**: Inbox file system (queued, no race, but requires coordinator to poll `ib inbox`)
- These paths are NOT unified — TUI bypass the inbox entirely

### 6.4 `--from` Flag Behavior
- CLI: Optional, manually specified
- `sendMessage()`: Auto-detects from CWD if not provided
- TUI: Always passes `{ cwd: "/" }`, so no sender ever detected from TUI
- If `fromId` is set: message is prefixed with `[sent by agent <id>]: ` and bilateral logging occurs
- If `fromId` is empty: no prefix, simpler log message, stdout says "Sent to <id>"
- Quirk: if fromId is set, stdout is EMPTY (line 1162: `const stdout = fromId ? "" : \`Sent to ${agent.id}\``)

### 6.5 No Sender Logging from TUI
- Because TUI passes `cwd: "/"`, sender is never auto-detected
- Messages sent from TUI have no `[sent by agent ...]` prefix
- Recipient's agent.log just says "Received message: <msg>" with no indication it came from the TUI

### 6.6 Per-Repo Coordinator Input Field vs Regular Agent Input
- Per-repo coordinators have their OWN input field (`repoCoordinatorInputField`)
- But it uses `sendMessage()` (same as regular agents), not the inbox system
- System coordinator input field uses `sendTmuxKeys()` directly (different codepath)

### 6.7 "Send All" Broadcast
- Only available via TUI `s` key dialog (textarea has sendAll toggle)
- Sends to ALL non-archived agents with tmux sessions, across ALL repos
- No way to scope to a single repo
- Sequential sends (not parallel) — each awaits `sendMessage()`

### 6.8 Coordinator Name Reservation
- `"coordinator"` is reserved: rejected by `newAgent()` (both explicit `--name coordinator` and derived coordinator ID)
- Also rejected by `addRepo()` and `renameRepo()` — repos can't be named "coordinator"
- This ensures `ib send coordinator` always routes to the system coordinator inbox

### 6.9 Prefix Match Ambiguity
- If user types `ib send agent "msg"` and multiple agents start with "agent", the command fails with "Ambiguous ID" error
- But if there's exactly one match, it succeeds (convenient but potentially surprising)

### 6.10 Cross-Repo Agent ID Collision
- `matchAgentById()` uses `agents.find()` for exact match — returns first found
- Order depends on repo iteration order (from `Promise.all` of `readRepoAgents()`)
- No warning or error for exact duplicates across repos — silently picks one
- Prefix matches across repos DO trigger ambiguity errors if >1 match

### 6.11 State Update After Send
- `sendMessage()` writes `state: "running"` to recipient's `meta.json` (line 1160)
- This happens AFTER the tmux send-keys succeeds
- If the agent is actually dead (but tmux session exists as a zombie), state gets incorrectly set to "running"

### 6.12 Message Delay Calculation
- Delay: `0.1 + (msgLen / 100) * 0.5`, clamped [0.2, 3.0] seconds
- For a 100-char message: 0.6s delay between send-keys and Enter
- For a 580+ char message: hits 3.0s cap
- Purpose: give tmux time to process the literal text before Enter is sent
- Test override: `sendDelayOverrideMs` can be set to 0 for tests

### 6.13 Sender Log Path Assumes Same Repo
- Line 1155: `const senderDir = join(agent.repoPath, ".ittybitty", "agents", fromId)`
- If sender and recipient are in DIFFERENT repos, this path is wrong
- The sender's log entry would be written to a non-existent directory in the RECIPIENT's repo
- This silently fails (logAgent is best-effort)
