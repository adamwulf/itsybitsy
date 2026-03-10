# Slack Integration Design Document

## Overview

This document describes how to integrate itsybitsy (`ib`) with Slack, enabling users to interact with the agent management system through a Slack channel. The integration supports:

1. Listening to a Slack channel for messages
2. Conversing with users (respond to questions, commands, status requests)
3. Spawning ib agents based on Slack conversations
4. Notifying Slack when agents complete, wait, or hit errors

---

## 1. Recommended Architecture

### Option B: Standalone `ib slack` daemon

**Selected approach**: A standalone `ib slack` daemon that runs independently of the TUI dashboard.

**Why this option wins:**

| Criteria | Option A (Extend TUI) | Option B (Standalone daemon) | Option C (Watchdog thread) |
|----------|----------------------|------------------------------|---------------------------|
| Lifetime | Tied to TUI — Slack disconnects when TUI exits | Runs independently, can be a background service | Tied to watchdog lifetime |
| Complexity | High — TUI event loop + WebSocket event loop in same process | Low — single-purpose process | Medium — shared concerns with watchdog |
| Separation of concerns | Poor — TUI code mixed with Slack code | Clean — own process, own lock file | Moderate — watchdog already does agent monitoring |
| Restartability | Must restart TUI to restart Slack | Restart Slack daemon independently | Must restart watchdog |
| Resource usage | TUI already uses significant terminal I/O | Minimal — WebSocket + periodic API calls | Shares watchdog's memory/CPU |
| Multiple users | N/A (TUI is single-user) | Multiple Slack users naturally | N/A |

The daemon follows the same pattern as `ib watchdog`: a long-running background process with a PID lock file at `~/.itsybitsy/slack.lock`.

### Process relationship

```
ib slack          (standalone daemon — Slack WebSocket + agent monitoring)
ib watchdog       (standalone daemon — agent state monitoring + notifications)
ib watch          (TUI dashboard — interactive)
```

The Slack daemon reuses the same agent-reading and command infrastructure as the watchdog and TUI, but adds a Slack WebSocket connection and message handling layer.

---

## 2. Slack API Setup

### Approach: Socket Mode (no public endpoint required)

Socket Mode uses WebSocket connections instead of HTTP webhooks. This is ideal because:
- No public URL or ngrok needed — works behind firewalls
- Works on developer laptops running `ib slack` locally
- Real-time bidirectional messaging
- Up to 10 simultaneous WebSocket connections supported

### Setup steps at api.slack.com

1. **Create a new Slack App** at https://api.slack.com/apps
   - Choose "From scratch"
   - Name it (e.g., "itsybitsy" or "ib-bot")
   - Select your workspace

2. **Enable Socket Mode**
   - Go to **Settings > Socket Mode**
   - Toggle "Enable Socket Mode" ON
   - This switches the app from HTTP webhooks to WebSocket delivery

3. **Generate an App-Level Token**
   - Go to **Settings > Basic Information > App-Level Tokens**
   - Click "Generate Token and Scopes"
   - Name: `socket-mode`
   - Add scope: `connections:write`
   - Save the token (starts with `xapp-`)

4. **Configure Bot Token Scopes**
   - Go to **Features > OAuth & Permissions > Scopes > Bot Token Scopes**
   - Add these scopes:
     - `app_mentions:read` — receive @mentions
     - `chat:write` — send messages
     - `channels:history` — read channel messages (for command parsing)
     - `channels:read` — list channels (for channel validation)
     - `users:read` — look up user info (for allowlist verification)

5. **Subscribe to Events**
   - Go to **Features > Event Subscriptions**
   - Toggle "Enable Events" ON
   - Under "Subscribe to bot events", add:
     - `app_mention` — when someone @mentions the bot
     - `message.channels` — messages in public channels the bot is in

6. **Install the App to Workspace**
   - Go to **Settings > Install App**
   - Click "Install to Workspace"
   - Authorize the requested scopes
   - Save the Bot User OAuth Token (starts with `xoxb-`)

### Tokens summary

| Token | Prefix | Purpose | Where configured |
|-------|--------|---------|-----------------|
| App-Level Token | `xapp-` | WebSocket connection (Socket Mode) | `.ittybitsy.json` or env var |
| Bot Token | `xoxb-` | Slack Web API calls (post messages, read users) | `.ittybitsy.json` or env var |

---

## 3. Config Schema

### Additions to `.ittybitsy.json`

```json
{
  "slack": {
    "appToken": "xapp-1-...",
    "botToken": "xoxb-...",
    "channel": "C0123456789",
    "allowedUsers": ["U0123456789", "U9876543210"],
    "notifyOnComplete": true,
    "notifyOnWaiting": true,
    "notifyOnError": true,
    "notifyOnRateLimit": false,
    "defaultRepo": "muse-ios"
  }
}
```

### Environment variable overrides

Tokens can also be set via environment variables (preferred for security):

```bash
export IB_SLACK_APP_TOKEN="xapp-1-..."
export IB_SLACK_BOT_TOKEN="xoxb-..."
```

Environment variables take precedence over config file values.

### New CONFIG_KEYS entries

```typescript
// In src/config.ts
{ key: "slack.appToken", type: "string", default: undefined },
{ key: "slack.botToken", type: "string", default: undefined },
{ key: "slack.channel", type: "string", default: undefined },
{ key: "slack.allowedUsers", type: "string[]", default: [] },
{ key: "slack.notifyOnComplete", type: "boolean", default: true },
{ key: "slack.notifyOnWaiting", type: "boolean", default: true },
{ key: "slack.notifyOnError", type: "boolean", default: true },
{ key: "slack.notifyOnRateLimit", type: "boolean", default: false },
{ key: "slack.defaultRepo", type: "string", default: undefined },
```

### User-level config (`~/.ittybitsy.json`)

Tokens should live in the user-level config (not checked into repos):

```json
{
  "slack": {
    "appToken": "xapp-1-...",
    "botToken": "xoxb-..."
  }
}
```

Channel, allowed users, and notification preferences can live in either project or user config.

---

## 4. Message Protocol

### Command syntax

Users interact with the bot by @mentioning it or sending messages in the configured channel. Commands are parsed from the message text after stripping the bot mention.

| Command | Example | Description |
|---------|---------|-------------|
| `status` / `list` | `@ib status` | List all agents with states |
| `spawn <prompt>` | `@ib spawn fix the login bug in muse-ios` | Spawn a new agent |
| `spawn --worker <prompt>` | `@ib spawn --worker review the auth changes` | Spawn a worker agent |
| `spawn --repo <name> <prompt>` | `@ib spawn --repo muse-ios fix the crash` | Spawn in a specific repo |
| `kill <id>` | `@ib kill agent-abc123` | Kill an agent |
| `merge <id>` | `@ib merge agent-abc123` | Merge an agent's work |
| `send <id> <msg>` | `@ib send agent-abc123 please also fix the tests` | Send a message to an agent |
| `look <id>` | `@ib look agent-abc123` | Show agent's recent output |
| `diff <id>` | `@ib diff agent-abc123` | Show agent's git diff summary |
| `help` | `@ib help` | Show available commands |
| `repos` | `@ib repos` | List registered repos |
| `questions` | `@ib questions` | Show pending agent questions |
| `answer <qid> <answer>` | `@ib answer q-123 yes, proceed` | Answer a pending question |

### Response format

Responses use Slack's Block Kit for rich formatting:

```
Status Update
━━━━━━━━━━━━━━━━━━━━━
muse-ios → /Users/adam/Developer/muse/muse-ios
  ◆ agent-abc123  running  2h  sonnet
  ⚙ agent-def456  complete  15m  sonnet
  ◆ agent-ghi789  waiting  5m  opus
```

### Threading approach

- **Agent spawn confirmations**: Reply in the original thread where the spawn was requested
- **Status/list responses**: Reply in thread to the requesting message
- **Proactive notifications** (completion, errors): Post as new messages in the channel
- **Agent output** (`look` command): Reply in thread (can be long)
- **Long diffs**: Upload as a Slack file snippet attached to the thread

### Rate limiting

Slack allows ~1 message/second/channel. The daemon should:
- Queue outgoing messages with a 1-second minimum interval
- Batch rapid state changes (e.g., if 5 agents complete within seconds, send one summary)
- Use a debounce window (5 seconds) for notification batching
- Never stream agent output in real-time — only send snapshots on request

---

## 5. Source Files

### New files

| File | Responsibility |
|------|---------------|
| `src/slack/socket.ts` | WebSocket connection to Slack Socket Mode — connect, reconnect, heartbeat, event dispatch |
| `src/slack/commands.ts` | Parse incoming messages into commands, dispatch to handlers, format responses |
| `src/slack/notifications.ts` | Agent state change → Slack notification mapping, debouncing, batching |
| `src/slack/api.ts` | Thin wrapper around Slack Web API (chat.postMessage, users.info, etc.) using `fetch()` |
| `src/slack/auth.ts` | User allowlist checking, token validation |
| `src/slack/daemon.ts` | Main daemon entry point — orchestrates socket, watcher, notifications, shutdown |
| `src/slack/sanitize.ts` | Input sanitization for user-supplied prompts before passing to `newAgent()` |

### Modified files

| File | Changes |
|------|---------|
| `src/config.ts` | Add `slack.*` config keys |
| `src/index.ts` | Add `case "slack":` command to launch the daemon |
| `src/validation.ts` | Add `isValidSlackId()` for channel/user ID validation |

---

## 6. Detailed Component Design

### 6.1 `src/slack/socket.ts` — Socket Mode Connection

Uses Bun's native `WebSocket` class (no external dependencies).

```typescript
// Connection lifecycle:
// 1. POST https://slack.com/api/apps.connections.open with xapp- token
// 2. Receive { ok: true, url: "wss://..." }
// 3. Connect to WebSocket URL
// 4. Receive { type: "hello", ... }
// 5. Receive events as { type: "events_api", envelope_id: "...", payload: {...} }
// 6. Acknowledge each event: send { envelope_id: "..." }
// 7. Handle { type: "disconnect", reason: "refresh_requested" } → reconnect

export interface SlackSocketEvents {
  onEvent: (envelope: SlackEnvelope) => void;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
  onError: (error: Error) => void;
}

export class SlackSocket {
  private ws: WebSocket | null = null;
  private appToken: string;
  private events: SlackSocketEvents;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  constructor(appToken: string, events: SlackSocketEvents) { ... }

  async connect(): Promise<void> {
    // 1. Call apps.connections.open
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.appToken}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Socket Mode connect failed: ${data.error}`);

    // 2. Open WebSocket
    this.ws = new WebSocket(data.url);
    this.ws.addEventListener("message", (event) => this.handleMessage(event));
    this.ws.addEventListener("close", () => this.handleClose());
    this.ws.addEventListener("error", (e) => this.events.onError(new Error(String(e))));
  }

  private handleMessage(event: MessageEvent) {
    const data = JSON.parse(String(event.data));
    if (data.type === "hello") {
      this.connected = true;
      this.events.onConnected();
      return;
    }
    if (data.type === "disconnect") {
      this.events.onDisconnected(data.reason);
      if (data.reason === "refresh_requested") this.scheduleReconnect(0);
      return;
    }
    // Acknowledge the event
    if (data.envelope_id) {
      this.ws?.send(JSON.stringify({ envelope_id: data.envelope_id }));
    }
    this.events.onEvent(data);
  }

  private handleClose() {
    this.connected = false;
    this.scheduleReconnect(5000); // Reconnect after 5s
  }

  private scheduleReconnect(delayMs: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  disconnect() {
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
```

### 6.2 `src/slack/api.ts` — Slack Web API Client

Uses `fetch()` — no external dependencies needed.

```typescript
export class SlackAPI {
  private botToken: string;
  private messageQueue: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  private sending = false;

  constructor(botToken: string) { ... }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    this.messageQueue.push({ channel, text, thread_ts: threadTs });
    this.drainQueue();
  }

  // Rate-limited queue: sends at most 1 message per second
  private async drainQueue() {
    if (this.sending) return;
    this.sending = true;
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(msg),
      });
      await Bun.sleep(1100); // Respect 1 msg/s/channel rate limit
    }
    this.sending = false;
  }

  async getUserInfo(userId: string): Promise<{ ok: boolean; user?: { real_name: string } }> {
    const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${this.botToken}` },
    });
    return res.json();
  }
}
```

### 6.3 `src/slack/commands.ts` — Command Parser

```typescript
export interface ParsedCommand {
  command: string;          // "spawn", "status", "kill", etc.
  args: string[];           // remaining tokens
  rawText: string;          // original message text
  userId: string;           // Slack user ID
  channelId: string;        // Slack channel ID
  threadTs?: string;        // thread timestamp (for threading replies)
  messageTs: string;        // message timestamp
}

export function parseCommand(text: string): { command: string; args: string[] } {
  // Strip bot mention: "<@U12345> spawn fix the bug" → "spawn fix the bug"
  const stripped = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const parts = stripped.split(/\s+/);
  const command = (parts[0] || "help").toLowerCase();
  const args = parts.slice(1);
  return { command, args };
}
```

### 6.4 `src/slack/notifications.ts` — State Change Notifications

Integrates with the existing `AgentWatcher` to detect state transitions and post to Slack.

```typescript
export class SlackNotifier {
  private api: SlackAPI;
  private channel: string;
  private config: SlackNotifyConfig;
  private previousStates: Map<string, AgentState> = new Map();
  private pendingNotifications: SlackNotification[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Called on each watcher update
  onAgentUpdate(agents: Agent[]) {
    for (const agent of flattenAll(agents)) {
      const prev = this.previousStates.get(agent.id);
      if (prev && prev !== agent.state) {
        this.queueNotification(agent, prev, agent.state);
      }
      this.previousStates.set(agent.id, agent.state);
    }
  }

  private queueNotification(agent: Agent, from: AgentState, to: AgentState) {
    // Debounce: wait 5s, then send batched notifications
    this.pendingNotifications.push({ agent, from, to, time: Date.now() });
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), 5000);
  }

  private async flush() {
    const notifications = this.pendingNotifications.splice(0);
    if (notifications.length === 0) return;

    // Group by type and format a single message
    const completions = notifications.filter(n => n.to === "complete");
    const errors = notifications.filter(n => n.to === "stopped" && n.from === "running");
    const waiting = notifications.filter(n => n.to === "waiting");

    const lines: string[] = [];
    if (completions.length > 0 && this.config.notifyOnComplete) {
      lines.push(`*Completed:* ${completions.map(n => n.agent.id).join(", ")}`);
    }
    if (errors.length > 0 && this.config.notifyOnError) {
      lines.push(`*Stopped:* ${errors.map(n => n.agent.id).join(", ")}`);
    }
    if (waiting.length > 0 && this.config.notifyOnWaiting) {
      lines.push(`*Waiting:* ${waiting.map(n => n.agent.id).join(", ")}`);
    }

    if (lines.length > 0) {
      await this.api.postMessage(this.channel, lines.join("\n"));
    }
  }
}
```

### 6.5 `src/slack/sanitize.ts` — Input Sanitization

Prevents prompt injection and shell injection from Slack messages.

```typescript
/**
 * Sanitize user-supplied prompt text before passing to newAgent().
 * - Strip Slack formatting (<@U123>, <#C123|channel>, <url|label>)
 * - Remove control characters
 * - Limit length (max 2000 chars)
 * - Do NOT strip natural language — agents need the full context
 */
export function sanitizePrompt(text: string): string {
  let clean = text
    .replace(/<@[A-Z0-9]+>/g, "")           // user mentions
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "$1") // channel mentions → name
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)") // links
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")  // bare links
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
    .trim();

  if (clean.length > 2000) {
    clean = clean.slice(0, 2000) + "... (truncated)";
  }

  return clean;
}
```

### 6.6 `src/slack/auth.ts` — Authorization

```typescript
export function isUserAllowed(userId: string, allowedUsers: string[]): boolean {
  // Empty allowlist = all users allowed (workspace-level trust)
  if (allowedUsers.length === 0) return true;
  return allowedUsers.includes(userId);
}

// Commands that require explicit authorization
const PRIVILEGED_COMMANDS = new Set(["spawn", "kill", "nuke", "merge", "send", "answer"]);

export function requiresAuth(command: string): boolean {
  return PRIVILEGED_COMMANDS.has(command);
}
```

### 6.7 `src/slack/daemon.ts` — Main Daemon

```typescript
export async function startSlackDaemon(): Promise<void> {
  // 1. Acquire lock file (~/.itsybitsy/slack.lock)
  // 2. Load config (tokens, channel, allowed users)
  // 3. Validate tokens exist
  // 4. Initialize SlackAPI, SlackSocket, SlackNotifier
  // 5. Start AgentWatcher (reuses same watcher as TUI/watchdog)
  // 6. Connect WebSocket
  // 7. Wire up:
  //    - Socket events → command parser → command handlers
  //    - Watcher updates → notifier → Slack messages
  // 8. Handle SIGTERM/SIGINT for clean shutdown
}
```

---

## 7. Integration with Existing Systems

### Reusing existing infrastructure

| Component | Existing code | How Slack daemon uses it |
|-----------|--------------|------------------------|
| Agent reading | `readAllAgents()` in `agents.ts` | Same as watchdog — reads `.ittybitty/agents/` |
| State detection | `detectAgentStates()` in `agents.ts` | Same as watchdog — tmux capture + parseState |
| Agent spawning | `newAgent()` in `ib-commands.ts` | Called directly with sanitized prompt |
| Sending messages | `sendMessage()` in `ib-commands.ts` | Called directly for `send` command |
| Killing agents | `killAgent()` in `ib-commands.ts` | Called directly for `kill` command |
| Merging agents | `mergeAgent()` in `ib-commands.ts` | Called directly for `merge` command |
| Config | `readConfig()` in `config.ts` | Extended with `slack.*` keys |
| File watching | `AgentWatcher` in `watcher.ts` | Creates its own watcher instance |
| Questions | `readPendingQuestions()` in `agents.ts` | Called for `questions` command |
| Question answers | `acknowledgeQuestion()` in `ib-commands.ts` | Called for `answer` command |

### CLI entry point addition

In `src/index.ts`, add a new case:

```typescript
case "slack": {
  const { acquireSlackLock, releaseSlackLock, readSlackLockPid } = await import("./slack/daemon");
  const { startSlackDaemon, stopSlackDaemon } = await import("./slack/daemon");

  if (!acquireSlackLock()) {
    const pid = readSlackLockPid();
    console.log(`Slack daemon already running (pid: ${pid})`);
    process.exit(0);
  }

  await startSlackDaemon();

  const cleanup = () => {
    stopSlackDaemon();
    releaseSlackLock();
    process.exit(0);
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("exit", () => releaseSlackLock());
  break;
}
```

### Watchdog coordination

The Slack daemon and watchdog can run simultaneously. They share the same agent data (filesystem-based), so there's no conflict. However:

- The Slack daemon should NOT duplicate watchdog notifications to managers (those go via tmux `sendMessage`)
- The Slack daemon handles Slack-specific notifications only (posting to the Slack channel)
- If both are running, agents get manager notifications via watchdog AND Slack channel notifications via the daemon — this is intentional (different audiences)

---

## 8. WebSocket Protocol Details

### Connection lifecycle

```
1. daemon starts
2. POST apps.connections.open → get wss:// URL
3. new WebSocket(url)
4. ← { type: "hello", approximate_connection_time: 3600 }
5. ← { type: "events_api", envelope_id: "e1", payload: { event: { type: "app_mention", ... } } }
6. → { envelope_id: "e1" }  (acknowledge)
7. ... repeat 5-6 for each event ...
8. ← { type: "disconnect", reason: "refresh_requested" }
9. goto step 2 (reconnect)
```

### Reconnection strategy

- On `refresh_requested` disconnect: reconnect immediately (0ms delay)
- On unexpected close: reconnect after 5s
- On repeated failures: exponential backoff (5s → 10s → 20s → 40s → cap at 60s)
- Reset backoff on successful connection

### Event envelope format

```json
{
  "envelope_id": "unique-id",
  "type": "events_api",
  "accepts_response_payload": false,
  "payload": {
    "event": {
      "type": "app_mention",
      "user": "U0123456789",
      "text": "<@U_BOT_ID> spawn fix the login bug",
      "channel": "C0123456789",
      "ts": "1234567890.123456",
      "thread_ts": "1234567890.000000"
    }
  }
}
```

---

## 9. Security

### User authorization

- **Allowlist by Slack user ID**: Only users in `slack.allowedUsers` can run privileged commands (spawn, kill, merge, send)
- **Read-only commands** (status, list, look, help) are available to all channel members
- **Empty allowlist** = all workspace members trusted (for small teams)

### Prompt sanitization

User messages from Slack go through `sanitizePrompt()` before being passed to `newAgent()`:
- Strip Slack-specific formatting (`<@mentions>`, `<#channels>`, `<url|labels>`)
- Remove control characters
- Truncate to 2000 characters
- The existing `newAgent()` validation handles the rest (model validation, tool list validation, etc.)

### Token security

- Tokens should be in `~/.ittybitsy.json` (user config, not repo config) or environment variables
- Never log tokens
- The daemon validates token format on startup (`xapp-` and `xoxb-` prefixes)

---

## 10. Estimated Complexity

### Lines of code (approximate)

| File | Lines | Notes |
|------|-------|-------|
| `src/slack/socket.ts` | ~120 | WebSocket connection, reconnect, event dispatch |
| `src/slack/api.ts` | ~80 | Slack Web API wrapper with rate-limited queue |
| `src/slack/commands.ts` | ~200 | Command parser + handlers for all commands |
| `src/slack/notifications.ts` | ~120 | State change detection, debouncing, batching |
| `src/slack/daemon.ts` | ~100 | Main entry point, lock file, wiring |
| `src/slack/auth.ts` | ~30 | User allowlist, privilege checking |
| `src/slack/sanitize.ts` | ~40 | Input sanitization |
| Config/CLI changes | ~30 | Config keys + index.ts case |
| **Tests** | ~400 | Unit tests for each module |
| **Total** | **~1120** | Production + tests |

### New dependencies

**None.** The entire integration uses:
- Bun's native `WebSocket` class for Socket Mode
- Bun's native `fetch()` for Slack Web API calls
- Existing ib infrastructure for all agent operations

This is a significant advantage — no `@slack/bolt`, `@slack/socket-mode`, or `@slack/web-api` packages needed. The Socket Mode protocol is simple enough (WebSocket + JSON + event acknowledgment) to implement directly, and the Web API calls are just HTTP POST requests.

### Why not use `@slack/bolt`?

- Bolt brings in `@slack/socket-mode`, `@slack/web-api`, `axios`, and other dependencies
- Bolt's Node.js assumptions may have edge cases with Bun
- The protocol is simple: one WebSocket connection + `fetch()` calls
- Keeping zero dependencies aligns with itsybitsy's existing approach
- Full control over reconnection logic and error handling

---

## 11. Example Interactions

### Spawning an agent
```
User:   @ib spawn fix the login timeout bug in the auth service
Bot:    Spawning agent in muse-ios...
        ◆ agent-a1b2c3d4 created (sonnet) — "fix the login timeout bug in the auth service"

        (30 minutes later, automatically)
Bot:    *Completed:* agent-a1b2c3d4
        Prompt: "fix the login timeout bug in the auth service"
        Use `@ib look a1b2` to see output, `@ib merge a1b2` to merge.
```

### Checking status
```
User:   @ib status
Bot:    muse-ios → /Users/adam/Developer/muse/muse-ios
          ◆ agent-a1b2c3d4  running  32m  sonnet  fix the login timeout...
          ⚙ agent-e5f6g7h8  complete  15m  sonnet  review the auth changes

        itsybitsy → /Users/adam/Developer/bun/itsybitsy
          (no agents)
```

### Answering a question
```
Bot:    *Question from agent-a1b2c3d4:*
        "Should I also update the session refresh logic, or just the timeout?"

User:   @ib answer q-xyz123 yes, update the session refresh logic too
Bot:    Answer sent to agent-a1b2c3d4.
```

---

## 12. Future Extensions (Out of Scope)

These are not part of the initial implementation but noted for future consideration:

- **Slash commands** (`/ib status`) — requires HTTP endpoint, not Socket Mode compatible
- **Interactive buttons** (Block Kit actions for merge/kill/approve) — requires `interactive_messages` event subscription
- **Multi-workspace support** — would need OAuth flow for each workspace
- **Agent output streaming** — periodic updates in a thread while agent runs
- **File upload for diffs** — upload large diffs as Slack file snippets
- **Claude-powered natural language** — use Claude to interpret ambiguous commands instead of rigid parsing
