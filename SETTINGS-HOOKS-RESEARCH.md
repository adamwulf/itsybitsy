# Settings & Hooks: Claude Code vs Codex CLI

Research compiled 2026-05-30 by `agent-a41479cc` for the `codex-agent` integration effort.

This document maps how Claude Code and the OpenAI Codex CLI each load settings and hooks, so itsybitsy can express its existing Claude-agent contract (path isolation, intercept-task, session-start injection, status injection, permission allowlists, model selection) on top of Codex.

## Evidence tags

Every claim below is tagged with where it came from:

- **[OFFICIAL]** — fetched from an official documentation URL (URL given inline)
- **[LOCAL]** — observed on this machine at the path given
- **[CLI-HELP]** — `claude --help` / `codex --help` / `codex exec --help` output
- **[INFER]** — inferred from other tagged sources

### Harness limitations encountered

1. `claude --help`, `codex --help`, and `codex exec --help` were **blocked by the harness allowlist** (`Tool not in allow list`). All CLI-flag claims below are sourced from official online help pages (`developers.openai.com/codex/cli/reference`, `code.claude.com/docs/en/cli-reference`) rather than running the binaries. **No [CLI-HELP] tag appears in this report** because every attempt to run `--help` was rejected.
2. WebSearch must be cited in a `Sources:` section per its tool prompt — that section is at the bottom of this file.
3. Two official Codex pages disagree about whether `/etc/codex/config.toml` and `CODEX_HOME` exist; the disagreement is called out in §B1.

---

# PART A — Claude Code

## A1. Settings file precedence

**Highest → lowest** [OFFICIAL: code.claude.com/docs/en/settings, code.claude.com/docs/en/permissions]:

| # | Layer | Path / source |
|---|---|---|
| 1 | **Managed settings** (cannot be overridden by anything below — including CLI flags) | macOS: `/Library/Application Support/ClaudeCode/managed-settings.json` + `managed-settings.d/`; Linux/WSL: `/etc/claude-code/managed-settings.json` + `managed-settings.d/`; Windows: `C:\Program Files\ClaudeCode\managed-settings.json` + `managed-settings.d/`; macOS managed plist domain `com.anthropic.claudecode`; Windows registry `HKLM\SOFTWARE\Policies\ClaudeCode` and `HKCU\SOFTWARE\Policies\ClaudeCode`; server-managed settings pushed via the Anthropic admin console. |
| 2 | **Command-line arguments** (session-only override) | `--model`, `--permission-mode`, `--settings`, `--effort`, `--add-dir`, `--allowedTools`, `--disallowedTools`, `--agents`, `--mcp-config`, `--strict-mcp-config`, `--setting-sources`, `--system-prompt[-file]`, `--append-system-prompt[-file]`, etc. |
| 3 | **Project local settings** | `.claude/settings.local.json` (not committed) |
| 4 | **Project shared settings** | `.claude/settings.json` (checked into git) |
| 5 | **User settings** | `~/.claude/settings.json` |

> Verbatim: *"If a tool is denied at any level, no other level can allow it. For example, a managed settings deny cannot be overridden by `--allowedTools`, and `--disallowedTools` can add restrictions beyond what managed settings define."* [OFFICIAL: permissions]

> Verbatim: *"Embedding hosts can supply additional managed policy via the SDK `managedSettings` option when `parentSettingsBehavior` is set to `merge`; embedder values can tighten policy but not loosen it."* [OFFICIAL: permissions]

### Merge rules

[OFFICIAL: code.claude.com/docs/en/settings]

- **Scalars** (string, boolean, number) — higher priority **completely replaces** lower priority.
  > *"When the same setting appears in multiple scopes, Claude Code applies them in priority order... if your user settings set `spinnerTipsEnabled` to `true` and project settings set it to `false`, the project value applies."*
- **Arrays** — generally **concatenated and de-duplicated** across scopes.
  > *"arrays are concatenated and de-duplicated"* (in context of managed-settings.d ordering)
- **Objects** — **deep-merged** recursively.
  > *"objects are deep-merged"*
- **Permission rule arrays (`allow`, `ask`, `deny`)** — **always merge across scopes**, regardless of priority.
  > *"Permission rules behave differently because they merge across scopes rather than override."* (Higher-priority scopes *add* rules; they never eliminate lower-scope rules. Deny always wins regardless of which scope it sits in.)
- **Managed-settings drop-in `.d/`** — sorted alphabetically, later files override scalars / arrays concatenate. Use numeric prefixes (`10-…`, `20-…`).

### Hot reload

> Verbatim: *"Claude Code watches your settings files and reloads them when they change, so edits to most keys apply to the running session without a restart."* [OFFICIAL: settings]
> Live: `permissions`, `hooks`, `apiKeyHelper`, `env`, credential helpers (fires `ConfigChange` hook). Requires restart: `model`, `outputStyle`.

### A note on `~/.claude.json`

[OFFICIAL: settings] Per-project state (allowed tools, trust), OAuth session, MCP server configs, caches, and a small set of "global config" keys (`autoConnectIde`, `autoInstallIdeExtension`, `externalEditorContext`, `teammateDefaultModel`) live in `~/.claude.json`, **not** in `~/.claude/settings.json`. itsybitsy already touches `~/.claude/settings.json` and does *not* need to touch `~/.claude.json` for hooks or permissions.

[LOCAL: /Users/adamwulf/.claude/settings.json] confirms the user-level layer in use on this machine — `permissions.allow` array, `hooks.{PreToolUse,UserPromptSubmit,PostToolUse,SessionStart}` block, `model: "claude-opus-4-7"`. itsybitsy's `installSafetyHooks` / `installInterceptHook` already write to this file.

## A2. Hooks via settings (JSON shape)

The `hooks` block can live in **any of the settings files** (managed, user, project, project-local) [OFFICIAL: code.claude.com/docs/en/hooks]. Skill/agent frontmatter and plugin `hooks/hooks.json` are additional sources.

| Location | Scope |
|---|---|
| `~/.claude/settings.json` | All your projects |
| `.claude/settings.json` | Single project (committed) |
| `.claude/settings.local.json` | Single project (gitignored) |
| Managed policy settings | Organization-wide |
| Plugin `hooks/hooks.json` | When plugin enabled |
| Skill/agent frontmatter | While component active |

**Combining rule** [OFFICIAL: hooks]: *"When a plugin is enabled, its hooks merge with your user and project hooks."* Plus managed `allowManagedHooksOnly: true` blocks all user/project/plugin hooks — only managed (and force-enabled-plugin) hooks run. itsybitsy does not currently use plugin or managed hooks; it relies on the user layer only.

### Canonical block shape

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|mcp__.*|*",
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/script.sh",
            "args": [],
            "timeout": 600,
            "shell": "bash",
            "if": "Bash(git *)"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "..." } ] }
    ]
  },
  "disableAllHooks": false,
  "allowManagedHooksOnly": false
}
```

### Event names

[OFFICIAL: hooks] Complete list as of 2026-05:
```
SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse,
PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure,
PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop,
TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle,
InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate,
WorktreeRemove, PreCompact, PostCompact, Elicitation, ElicitationResult,
SessionEnd
```

itsybitsy currently registers `PreToolUse`, `UserPromptSubmit`, `PostToolUse`, and `SessionStart` only. [LOCAL: /Users/adamwulf/.claude/settings.json]

### Matcher semantics

[OFFICIAL: hooks]

- `*`, `""`, or omitted → match all
- Only letters/digits/`_`/`|` → exact string or pipe-separated list (e.g. `Bash`, `Edit|Write`)
- Any other char → JavaScript regex (e.g. `^Notebook`, `mcp__memory__.*`)
- **Tool events** (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`) match on **tool name**.
- `SessionStart` matches `startup|resume|clear|compact` (session source).
- `Setup` matches `init|maintenance` (CLI flag).
- `UserPromptExpansion` matches command name. `Notification` matches notification type. `FileChanged` matches literal filenames.
- No-matcher events: `UserPromptSubmit`, `PostToolBatch`, `Stop`, `CwdChanged`, `SessionEnd`, `SessionStart`, `InstructionsLoaded`.
- [INFER] Note: the docs list `SessionStart` in *both* the "matcher supported" table and the "no matcher" list — they're inconsistent. itsybitsy already uses a `SessionStart` block with no matcher and that works.

### PreToolUse I/O contract

**stdin (JSON)** [OFFICIAL: hooks]:
```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/dir",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "effort": { "level": "low|medium|high|xhigh|max" }
}
```

**stdout** — JSON containing `hookSpecificOutput`:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "Explanation for the decision",
    "modifiedToolInput": { "command": "new command" },
    "additionalContext": "Context for Claude"
  }
}
```

**Exit codes** [OFFICIAL: hooks]:

| Code | Behaviour |
|---|---|
| `0` | Success — stdout JSON honored. If `permissionDecision: "deny"` is present, tool is blocked. |
| `2` | Blocking error. Tool call is prevented. `stderr` is shown to Claude. JSON in stdout is **ignored**. |
| other | Non-blocking error. Execution continues. `stderr` logged. |

`permissionDecision` values: `"allow"`, `"deny"`, `"ask"`, `"defer"` ("apply the normal permission flow") [OFFICIAL: hooks].

### Hook handler types

[OFFICIAL: hooks] `type` can be `"command"`, `"http"`, `"mcp_tool"`, `"prompt"`, or `"agent"`. itsybitsy uses only `"command"`. Common fields: `if` (permission rule filter), `timeout` (default 600s for command/http/mcp), `statusMessage`, `once`.

## A3. Hooks via command line

There is **no direct CLI flag to register a hook**. The only ways the CLI itself can introduce hooks are:

- `--settings <path-or-JSON-string>` — inline session-only settings, which can include a `hooks` block. [OFFICIAL: cli-reference]
  > *"Path to a settings JSON file or an inline JSON string. Values you set here override the same keys in your `settings.json` files for this session. Keys you omit keep their file-based values."*
- `--setting-sources user,project,local` — restrict which on-disk settings layers (and therefore which on-disk hook blocks) get loaded. [OFFICIAL: cli-reference]
- `--plugin-dir <dir>` / `--plugin-url <url>` — load a plugin (whose `hooks/hooks.json` may register hooks) for one session. [OFFICIAL: cli-reference]
- `--init-only` — run `Setup` + `SessionStart` hooks then exit. [OFFICIAL: cli-reference]
- `--init` / `--maintenance` — fire `Setup` hooks with that matcher in `-p`/print mode. [OFFICIAL: cli-reference]
- `--include-hook-events` — include hook lifecycle events in `--output-format stream-json`. [OFFICIAL: cli-reference]

[INFER] Practically, itsybitsy already takes the right approach: it edits the user-level `~/.claude/settings.json` rather than building a per-session settings string.

## A4. Other relevant CLI flags for config / permissions

All [OFFICIAL: code.claude.com/docs/en/cli-reference]. Verbatim help-text quoted in italics.

| Flag | Meaning |
|---|---|
| `--settings <path or JSON>` | *"Values you set here override the same keys in your settings.json files for this session. Keys you omit keep their file-based values."* |
| `--setting-sources user,project,local` | *"Comma-separated list of setting sources to load."* |
| `--permission-mode <mode>` | *"Begin in a specified permission mode. Accepts `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, or `bypassPermissions`. Overrides `defaultMode` from settings files."* |
| `--allowedTools "<rules>"` | *"Tools that execute without prompting for permission."* Same pattern syntax as `permissions.allow`. |
| `--disallowedTools "<rules>"` | *"Deny rules. A bare tool name removes that tool from the model's context. A scoped rule such as `Bash(rm *)` leaves the tool available and denies only matching calls."* |
| `--tools "Bash,Edit,Read"` | *"Restrict which built-in tools Claude can use. Use `""` to disable all, `"default"` for all."* (Different from `--allowedTools`: it restricts the *visible toolset*, not what auto-approves.) |
| `--dangerously-skip-permissions` | *"Skip permission prompts. Equivalent to `--permission-mode bypassPermissions`."* |
| `--allow-dangerously-skip-permissions` | *"Add `bypassPermissions` to the Shift+Tab mode cycle without starting in it."* |
| `--model <id-or-alias>` | *"Sets the model for the current session… `sonnet`, `opus`, or a model's full name. Overrides the `model` setting and `ANTHROPIC_MODEL`."* |
| `--fallback-model <id>` | *"Enable automatic fallback to a specified model when the default model is overloaded or not available… Takes effect in print mode (`-p`) and in background sessions; ignored in interactive."* |
| `--append-system-prompt "<text>"` / `--append-system-prompt-file <path>` | Append to default system prompt. Preserves Claude's tool guidance / safety. |
| `--system-prompt "<text>"` / `--system-prompt-file <path>` | *"Replace the entire system prompt with custom text."* Drops default tool/safety prompt. |
| `--session-id <uuid>` | *"Use a specific session ID for the conversation (must be a valid UUID)."* |
| `--resume <id-or-name>`, `-r` | Resume specific session by ID or name. Background sessions appear marked `bg` since v2.1.144. |
| `--continue`, `-c` | Load most recent conversation in current directory. |
| `--fork-session` | When resuming, create a new session ID. |
| `--add-dir <path>...` | *"Add additional working directories for Claude to read and edit files."* Grants file access; most `.claude/` config is NOT discovered from these. |
| `--agents '<JSON>'` | Define custom subagents inline. |
| `--mcp-config <file-or-json>` / `--strict-mcp-config` | Add MCP servers; strict mode ignores all other MCP sources. |
| `--bare` | Skip auto-discovery of hooks/skills/plugins/MCP/auto-memory/CLAUDE.md. Useful for scripted speed. |
| `-p`, `--print` | Non-interactive print mode (Agent SDK). |
| `--output-format text|json|stream-json` | Print-mode output format. |
| `--max-turns N`, `--max-budget-usd N` | Print-mode caps. |

[INFER] For itsybitsy spawning Claude, the relevant flags it already uses (or could use) are `--model`, `--permission-mode`, `--allowedTools`, `--disallowedTools`, `--dangerously-skip-permissions`, `--append-system-prompt`, `--session-id`, `--resume`, `--add-dir`, `--settings`.

## A5. Permissions in settings

[OFFICIAL: code.claude.com/docs/en/permissions]

### Shape

```json
{
  "permissions": {
    "allow": ["Bash(npm run *)", "Read(./docs)"],
    "ask":   ["Bash(git push *)"],
    "deny":  ["Bash(curl *)", "Read(./.env)", "Read(./secrets/**)"],
    "defaultMode": "default|acceptEdits|plan|auto|dontAsk|bypassPermissions",
    "additionalDirectories": ["../docs/"],
    "disableBypassPermissionsMode": "disable",
    "skipDangerousModePermissionPrompt": true
  }
}
```

### Evaluation order

> Verbatim: *"Rules are evaluated in order: **deny → ask → allow**. The first matching rule wins, so deny rules always take precedence."*

### Interaction with hooks

> Verbatim: *"PreToolUse hooks run before the permission prompt. The hook output can deny the tool call, force a prompt, or skip the prompt to let the call proceed."*
>
> *"Hook decisions do not bypass permission rules. Deny and ask rules are evaluated regardless of what a PreToolUse hook returns, so a matching deny rule blocks the call and a matching ask rule still prompts even when the hook returned `"allow"` or `"ask"`. This preserves the deny-first precedence... including deny rules set in managed settings."*
>
> *"A blocking hook also takes precedence over allow rules. A hook that exits with code 2 stops the tool call before permission rules are evaluated, so the block applies even when an allow rule would otherwise let the call proceed."*

So the **full effective order** for a tool call is:

1. **Hook `exit 2`** → blocks unconditionally (before settings rules)
2. **Settings `deny`** (from any scope, including managed) → blocks
3. **Settings `ask`** → prompts
4. **Hook `permissionDecision: "deny"`** → blocks with reason
5. **Hook `permissionDecision: "ask"` / `"allow"`** → upgrades/skips the prompt that would otherwise happen
6. **Settings `allow`** → silent allow
7. **Else** → permission-mode default behaviour

### Cross-scope merging for permission arrays

> Verbatim: *"Permission rules behave differently because they merge across scopes rather than override."* All `allow`/`ask`/`deny` arrays concatenate across user/project/local/managed. Higher-priority scopes add rules; they never eliminate lower-scope rules. [OFFICIAL: settings]

This is **different from generic arrays**, which also concatenate-and-dedupe in the managed-settings.d context but are described differently in other contexts — for permission arrays the spec is unambiguous: always merge, never replace.

---

# PART B — Codex CLI (codex-cli 0.135.0 installed at `/opt/homebrew/bin/codex`)

## B1. Config file precedence

**Highest → lowest** [OFFICIAL: developers.openai.com/codex/config-basic, /codex/config-advanced]:

| # | Layer | Path / source |
|---|---|---|
| 1 | **CLI flags & `--config` (`-c key=value`) overrides** | One-off inline TOML overrides. Values parse as JSON if possible; otherwise treated as literal string. |
| 2 | **Project `.codex/config.toml`** (walks from project root down to cwd; closest wins for any given key) | Loaded only when project is trusted (`[projects."<abs path>"].trust_level = "trusted"`). |
| 3 | **Profile file** `~/.codex/<name>.config.toml` (or `$CODEX_HOME/<name>.config.toml`) — selected with `--profile <name>` | A **separate file**, not a `[profiles.<name>]` section. |
| 4 | **User config** `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) | |
| 5 | **System config** `/etc/codex/config.toml` (Unix only) | See conflict note below. |
| 6 | **Built-in defaults** | |

### Profile syntax — confirmed

> Verbatim [OFFICIAL: config-sample]: *"To create a config profile, put overrides in a separate profile file under $CODEX_HOME. Select it with `codex --profile ci`."*

Profiles are **separate files** (e.g. `~/.codex/ci.config.toml`), **not** TOML `[profiles.ci]` sections inside the main config. (This contradicts what some third-party blog posts say.) `--profile <name>` resolves to `$CODEX_HOME/<name>.config.toml`.

### Project config discovery — confirmed

> Verbatim [OFFICIAL: config-advanced]: *"Codex walks from the project root to your current working directory and loads every `.codex/config.toml` it finds."*
>
> *"By default, Codex treats a directory containing `.git` as the project root. To customize this behavior, set `project_root_markers` in `config.toml`."*

So nested `.codex/config.toml` files **do** merge (multiple loaded, closest-to-cwd wins on conflict). You can disable parent-walking with `project_root_markers = []`. Project root detection respects `.git` by default.

### Trust requirement

> Verbatim [OFFICIAL: config-basic]: *"If you mark a project as untrusted, Codex skips project-scoped `.codex/` layers, including project-local config, hooks, and rules."*

`[projects."/absolute/path/to/project"].trust_level = "trusted"` (or `"untrusted"`) in `~/.codex/config.toml`. [LOCAL: /Users/adamwulf/.codex/config.toml] has exactly one such entry — `/Users/adamwulf/Developer/bun/itsybitsy` is marked `trust_level = "trusted"`.

### Restricted project-scoped keys

> Verbatim [OFFICIAL: config-reference]: *"Project-scoped config can't override machine-local provider, auth, host-owned app request metadata, notification, configuration profile selection, or telemetry routing keys."*
>
> Specifically blocked in project configs: `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `model_provider`, `model_providers`, `notify`, `profile`, `profiles`, `experimental_realtime_ws_base_url`, `otel`.

### CODEX_HOME

[OFFICIAL: config-reference] `$CODEX_HOME` overrides the base directory for user-level config, profile files, and logs. Defaults to `~/.codex`. The basic-config page does **not** mention it, but the reference and sample pages do — [INFER] the reference is authoritative.

### `.local` override file

[OFFICIAL: config-advanced] *"The documentation mentions no `.codex/config.local.toml` pattern."*

**Confirmed: no `.local`-style override file exists** for Codex. There is no equivalent of `.claude/settings.local.json` — your two choices for "machine-local but project-aware" config are (a) put it in `~/.codex/config.toml` (lose project-locality) or (b) put it in `.codex/config.toml` and `.gitignore` it.

### Documentation conflict — `/etc/codex/config.toml` and `CODEX_HOME`

The **config-reference** page lists `/etc/codex/config.toml` as a layer and documents `$CODEX_HOME`.
The **config-advanced** page explicitly says: *"The documentation mentions no… `/etc/codex/config.toml` system-wide file, or managed enforcement settings like `allow_managed_hooks_only`."*
But the **hooks** page describes managed `requirements.toml` and `allow_managed_hooks_only` in detail. [INFER] The advanced page is partial; reference + hooks pages are authoritative. Both `/etc/codex/config.toml` and `CODEX_HOME` exist; the advanced page is just silent on them. We should test on a real install when convenient.

### Key config sections

[OFFICIAL: config-reference, config-sample, hooks]

| Section | Purpose |
|---|---|
| `model = "..."` | Active model |
| `[model_providers.<name>]` | Provider definitions (user/profile/system only — blocked in project) |
| `[sandbox_workspace_write]` | Sandbox tuning (e.g. `network_access = true`) |
| `approval_policy = "..."` or granular table | Approval mode |
| `sandbox_mode = "..."` | Sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) |
| `[mcp_servers.<id>]` | MCP server defs |
| `[permissions.<name>]` | Named permission profiles |
| `[projects."<abs path>"]` | `trust_level` per project |
| `[hooks]` and `[[hooks.<Event>]]` | Hook registration |
| `project_root_markers = [".git"]` | Project root detection |
| `[features.*]` | Feature flags including hooks engine |

## B2. Hook sources

[OFFICIAL: developers.openai.com/codex/hooks]

> Verbatim: *"If more than one hook source exists, Codex loads all matching hooks. Higher-precedence config layers don't replace lower-precedence hooks."*

Sources, in declared precedence order (HIGHEST → LOWEST):

1. **User-level**: `~/.codex/hooks.json` OR `[hooks]` table in `~/.codex/config.toml`
2. **Project-level**: `<repo>/.codex/hooks.json` OR `[hooks]` table in `<repo>/.codex/config.toml`
3. **Plugin-bundled**: `hooks/hooks.json` in plugin root or manifest-specified paths
4. **Managed / enterprise**: `[hooks]` in `requirements.toml` (system, MDM, cloud)

Critical: **all matching hooks run** — sources don't replace each other. The "precedence" affects only display order, not whether they fire.

### Combining rule for decisions

> Verbatim: *"If multiple matching hooks return decisions, any `deny` wins. Otherwise, an `allow` lets the request proceed without surfacing the approval prompt."* (Documented for `PermissionRequest`; same model applies to `PreToolUse`.)

So Codex is **deny-wins** across multiple hooks, like Claude — but unlike Claude, multiple hooks for the same event run **concurrently** and their decisions are merged, rather than one user-defined hook running in a single registered slot.

## B3. Hook shape — TOML and JSON

### TOML form (inside config.toml)

```toml
[hooks]

[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = '/usr/bin/python3 "path/to/script.py"'
timeout = 30
statusMessage = "Checking Bash command"
```

### JSON form (hooks.json)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 script.py",
            "statusMessage": "Checking Bash command"
          }
        ]
      }
    ]
  }
}
```

[INFER] The JSON shape mirrors Claude Code's `hooks` block almost exactly — same `matcher` → `hooks[]` → `{type, command, ...}` structure. This was a deliberate design choice (per the WebSearch hit on `agenticcontrolplane.com/blog/codex-cli-hooks-reference`, multiple GitHub issues, and the Codex hooks docs describing it as "modeled on Claude Code's").

### Event names (Codex)

[OFFICIAL: hooks + WebSearch corroboration]

```
SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest,
PostToolUse, SubagentStart, SubagentStop, Stop
```

[INFER] Smaller event vocabulary than Claude — no `Notification`, `PreCompact`, `FileChanged`, `ConfigChange`, etc. The four itsybitsy already uses (`PreToolUse`, `UserPromptSubmit`, `PostToolUse`, `SessionStart`) all exist on Codex.

> **Caveat from open Codex issues** (WebSearch: openai/codex#16732, #14754, #18888): *"hooks reliably fire for shell calls, not for apply_patch edits or most MCP tool calls."* Recent PRs have generalized hook paths for MCP, but **`PreToolUse` for the file-edit tools (`apply_patch`) historically did not fire**. itsybitsy's `intercept-task` for blocking subagent spawning may need a different approach because Codex does not have an equivalent `Task`/`Agent` tool — its sub-agent model is `SubagentStart`/`SubagentStop` events.

### PreToolUse contract

**stdin fields** [OFFICIAL: hooks]:
- `tool_name` (canonical, e.g. `"Bash"`, `"apply_patch"`)
- `tool_input` (JSON; Bash/apply_patch use `tool_input.command`)
- `tool_use_id`, `turn_id`, `session_id`, `permission_mode`, `cwd`, `model`

**stdout decision** [OFFICIAL: hooks]:

Allow (optionally rewriting input):
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": { "command": "echo rewritten" }
  }
}
```

Deny:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Reason text"
  }
}
```

**Exit codes:** *"exit code `2` and write the blocking reason to `stderr`"* is an alternative to JSON output. Exit `0` with no output = no decision (defer to normal flow). [OFFICIAL: hooks]

### Differences vs Claude PreToolUse contract

[INFER from cross-comparing OFFICIAL sources]

- Field name in JSON: Codex uses `updatedInput`; Claude uses `modifiedToolInput`. Otherwise the `hookSpecificOutput` shape is identical.
- `permissionDecision` values: Codex docs the page show only `allow` and `deny` explicitly; `ask` is not shown (though `PermissionRequest` event suggests it exists). Claude has `allow|deny|ask|defer`.
- `additionalContext` (Claude) — not documented in Codex's PreToolUse shape.
- Exit code 2 has identical meaning on both.

## B4. Hook trust model

[OFFICIAL: hooks]

> Verbatim: *"Codex records trust against the hook's current hash, so new or changed hooks are marked for review and skipped until trusted."*

Trust is **hash-pinned**: any edit to the hook command/script invalidates trust and the hook is skipped until re-trusted. Trust is reviewed via the `/hooks` slash command at runtime.

Managed hooks (in `requirements.toml`) bypass trust: *"marked as managed, trusted by policy, and can't be disabled from the user hook browser."*

### Running hooks non-interactively (for itsybitsy spawning)

> Verbatim [OFFICIAL: hooks, cli-reference]: *"For one-off automation that already vets hook sources outside Codex, pass `--dangerously-bypass-hook-trust` to run enabled hooks without requiring persisted hook trust."*

This is the **critical flag for unattended/agent spawning**. Without it, every new or modified hook would block silently until a human runs `/hooks` and trusts it. itsybitsy MUST pass `--dangerously-bypass-hook-trust` (or pre-trust the hook hash via some other mechanism — not currently documented as a config key) when spawning Codex agents.

### Managed / enterprise enforcement

```toml
allow_managed_hooks_only = true

[features]
hooks = true

[hooks]
managed_dir = "/enterprise/hooks"
```

This blocks user/project/plugin hooks; only managed hooks run.

## B5. CLI flags relevant to config / approval / sandbox / hooks

All [OFFICIAL: developers.openai.com/codex/cli/reference]. Verbatim quotes in italics.

| Flag | Meaning |
|---|---|
| `-a, --ask-for-approval <mode>` | *"Control when Codex pauses for human approval before running a command. `untrusted | on-request | never`."* |
| `-s, --sandbox <mode>` | *"Select the sandbox policy for model-generated shell commands: `read-only | workspace-write | danger-full-access`."* |
| `-m, --model <id>` | *"Override the model set in configuration (for example `gpt-5.4`)."* |
| `-c, --config <key=value>` | *"Override configuration values. Values parse as JSON if possible; otherwise the literal string is used."* (repeatable inline TOML overrides) |
| `-p, --profile <name>` | *"Layer `$CODEX_HOME/profile-name.config.toml` on top of the base user config."* |
| `-C, --cd <path>` | *"Set the working directory for the agent before it starts processing your request."* |
| `--add-dir <path>` | *"Grant additional directories write access alongside the main workspace. Repeat for multiple paths."* |
| `--dangerously-bypass-hook-trust` | *"Run enabled hooks without requiring persisted hook trust for this invocation. Intended only for automation that already vets hook sources."* |
| `--dangerously-bypass-approvals-and-sandbox` (aka `--yolo`) | *"Run every command without approvals or sandboxing. Only use inside an externally hardened environment."* |
| `--ignore-user-config` (exec subcommand) | *"Do not load `$CODEX_HOME/config.toml`. Authentication still uses `CODEX_HOME`."* |
| `--ignore-rules` (exec subcommand) | *"Do not load user or project execpolicy `.rules` files for this run."* |
| `--skip-git-repo-check` (exec subcommand) | *"Allow running outside a Git repository (useful for one-off directories)."* |
| `--json` / `--experimental-json` (exec) | *"Print newline-delimited JSON events instead of formatted text."* |
| `--output-schema <file>` (exec) | *"JSON Schema file describing the expected final response shape. Codex validates tool output against it."* |
| `-o, --output-last-message <file>` (exec) | *"Write the assistant's final message to a file. Useful for downstream scripting."* |
| `--ephemeral` (exec) | *"Run without persisting session rollout files to disk."* |

### Approval modes ([OFFICIAL: agent-approvals-security])

- `never` — disables approval prompts; runs autonomously within sandbox
- `on-request` — default; asks for approval when escalation needed
- `untrusted` — runs only safe read operations automatically; everything mutating prompts

### Sandbox modes ([OFFICIAL: agent-approvals-security])

- `read-only` — reads + answers only; all edits/commands/network require approval
- `workspace-write` — default; auto file edits + command execution within cwd; network off by default
- `danger-full-access` — no sandbox/approval

OS enforcement: macOS Seatbelt (`sandbox-exec`), Linux `bwrap`+`seccomp`, Windows WSL2.

`.git` is read-only even in `workspace-write`. `.codex` and `.agents` are read-only when they exist (protects local config from agent overwrites — relevant to itsybitsy's path-isolation hook port).

---

# PART C — Mapping table (Claude → Codex)

| Concept | Claude Code | Codex CLI | Mapping notes |
|---|---|---|---|
| **User-level config file** | `~/.claude/settings.json` (JSON) | `~/.codex/config.toml` (TOML) | Codex respects `$CODEX_HOME` to relocate; Claude doesn't have a single equivalent env var. |
| **Project shared config (in-repo)** | `.claude/settings.json` (committed) | `.codex/config.toml` (committed) + `.codex/hooks.json` | Codex walks from project root to cwd loading every `.codex/config.toml`, closest wins. |
| **Project machine-local config** | `.claude/settings.local.json` (gitignored) | **No equivalent** — no `.local`-style file in Codex | Need to gitignore your `.codex/config.toml` if you want it machine-local, or use a profile. |
| **Managed / enterprise policy** | macOS `/Library/Application Support/ClaudeCode/managed-settings.json`; Linux `/etc/claude-code/managed-settings.json`; Windows `%ProgramFiles%/ClaudeCode/managed-settings.json`; MDM plist; HKLM/HKCU registry; server-managed | `requirements.toml` (system/MDM/cloud) with `allow_managed_hooks_only`, `[features.hooks]`, `[hooks.managed_dir]` | Both support "managed overrides everything" + "only managed hooks may run" flags. |
| **CLI: load extra config file** | `--settings <path-or-JSON>` (session-only override) | `-c key=value` (inline TOML over­rides; repeatable). No "load a whole file" flag — must use `--profile` or `CODEX_HOME` redirect. | Codex has no `--settings file.toml` equivalent. Closest equivalent is "set `CODEX_HOME` then run". |
| **CLI: select config sources** | `--setting-sources user,project,local` | `--ignore-user-config` (exec) + `--ignore-rules` (exec) — coarser; no per-source allowlist | Codex is coarser. Claude can include/exclude any subset; Codex only "skip user" or "skip rules". |
| **CLI: select a profile / persona** | `--agent <name>` (subagent) or settings `agent` key | `-p, --profile <name>` → loads `$CODEX_HOME/<name>.config.toml` | Different concepts: Claude `--agent` selects a subagent persona; Codex `--profile` swaps the whole layer of model/sandbox/approval defaults. |
| **Hooks file** | `hooks` block inside any settings.json | Either `[hooks]` block in config.toml OR a separate `hooks.json` file | Same Cooke-shape JSON schema between Codex `hooks.json` and Claude `settings.json` hooks block; only the wrapping differs. |
| **Hook events used by itsybitsy** | `PreToolUse`, `UserPromptSubmit`, `PostToolUse`, `SessionStart` | All four exist | Direct port. But Codex `PreToolUse` does NOT reliably fire for `apply_patch` or MCP tools (open issue #16732). |
| **PreToolUse JSON output: rewrite input** | `modifiedToolInput` field | `updatedInput` field | Single rename. |
| **Hook block matcher syntax** | `"Bash|Edit|Write"` (regex if non-trivial chars) | `matcher = "^Bash$"` (regex string) | Both regex-capable. itsybitsy's current `"Bash"`, `"Task|Agent"`, `"Bash|Task"` matchers are valid in both. |
| **No matcher = match all** | omit `matcher` / use `"*"` or `""` | [INFER] same convention from Codex examples | |
| **Combining multiple hooks for same event** | Multiple objects in the array all fire | All matching hooks across all sources fire concurrently; **any `deny` wins** | Codex is more explicit about concurrent execution. |
| **Exit code 2 = block** | Yes | Yes | Same semantics. |
| **`permissionDecision` values** | `allow | deny | ask | defer` | `allow | deny` (and `ask` for `PermissionRequest`) | Codex doesn't doc `ask`/`defer` on PreToolUse. |
| **`permissions.allow` / `deny` rules** | `permissions.{allow,ask,deny}` arrays in settings (rule syntax `Bash(git push *)`, `Read(./.env)`, etc.) | **No direct equivalent.** Allow/deny is enforced by (a) `--ask-for-approval` + `--sandbox`, (b) hook decisions (`permissionDecision: "deny"`), (c) `.rules` execpolicy files (file format not in official docs), (d) `[permissions.<name>]` named profiles in TOML | This is the biggest mapping gap. itsybitsy's per-agent-type `allow/deny` lists become a PreToolUse hook script (the same `ib hooks intercept-task` pattern, but on Bash and apply_patch) + sandbox/approval flag tuning. |
| **`--permission-mode`** | `default | acceptEdits | plan | auto | dontAsk | bypassPermissions` | Combination of `-a {untrusted | on-request | never}` × `-s {read-only | workspace-write | danger-full-access}` | Two-dimensional in Codex. Closest analogues: `bypassPermissions` ≈ `-a never -s danger-full-access` (or `--yolo`); `acceptEdits` ≈ `-a never -s workspace-write`; `plan` ≈ `-a untrusted -s read-only`. |
| **`--dangerously-skip-permissions`** | Single flag | `--dangerously-bypass-approvals-and-sandbox` (aka `--yolo`) | Direct equivalent. |
| **`--allowedTools` / `--disallowedTools`** | CLI list of permission rules | **No direct CLI flag.** Either bake into hook script, into `[permissions.<name>]` profile, or into `.rules` execpolicy | Big gap — Codex doesn't have first-class tool allowlist on the CLI. Translate to hook-driven decisions or sandbox tuning. |
| **`--add-dir`** | Read/edit access for additional dirs | `--add-dir` (same name) | Direct equivalent — both extend writable workspace. |
| **`--system-prompt` / `--append-system-prompt`** | Yes (4 variants) | No system-prompt CLI flags documented in the reference | Codex equivalent is `AGENTS.md` (in repo) or `~/.codex/instructions.md` (user) — file-based, not CLI-based. |
| **`--session-id <uuid>`, `--resume`, `--continue`** | Yes | `codex resume <id>` subcommand; `--ephemeral` for "do not persist" | Different shape (subcommand vs flag). |
| **Hook trust model** | None — any hook in a settings file you load runs | **Hash-pinned trust.** New/changed hooks are skipped until `/hooks`-approved | Critical: itsybitsy MUST pass `--dangerously-bypass-hook-trust` to Codex (analogous to Claude having no trust gate at all). |
| **Hot-reload of settings** | Yes — `permissions`/`hooks`/`env` reload live; fires `ConfigChange` hook | Not documented; assume restart required | [INFER] If we mutate a Codex agent's hooks mid-session, we likely need to spawn a fresh session to pick them up. |
| **Hook input field: `cwd`** | Yes | Yes | Direct port. |
| **Hook input field: `session_id`** | Yes | Yes | Direct port. |
| **Hook input field: `permission_mode`** | Yes | Yes (named the same) | Codex's permission_mode values will be different — likely the `-a` value. |
| **`SessionStart` matcher = `startup|resume|clear|compact`** | Yes | [INFER] not documented for Codex; safe to omit matcher | itsybitsy's current `SessionStart` block has no matcher, so this is a non-issue for port. |
| **`Stop` hook / agent-status detection** | `Stop` event fires when Claude goes idle | `Stop` event exists | Should map directly. itsybitsy's current `agent-status` hook is wired to Claude Code's `Stop` event indirectly via the `hooks` block — Codex side should be the same. |
| **Subagent / Task interception** | `PreToolUse` matcher `Task|Agent` → `ib hooks intercept-task` | `SubagentStart` event (no `Task` tool to intercept on Codex) | Different mechanism. Codex has `SubagentStart`/`SubagentStop` events; itsybitsy's intercept logic would need to convert from "block Task tool" to "veto SubagentStart". |
| **Path isolation** | `PreToolUse` matcher `Bash` → `ib hooks main-path` returns `permissionDecision: "deny"` | Same pattern works with TOML/JSON hook block, returning the same JSON shape (rename `modifiedToolInput`→`updatedInput`). | Port: change the matcher to `^Bash$` and rewrite the deny reason key. **Important caveat:** Codex's sandbox already enforces `.git`, `.codex`, `.agents` as read-only — that's OS-level enforcement and is independent of hooks. So some of what `main-path` checks is already covered by `-s workspace-write` + read-only protected paths. |
| **Status injection on prompt submit** | `UserPromptSubmit` hook returning `additionalContext` | `UserPromptSubmit` event exists | Should port cleanly. Confirm Codex honors `additionalContext` field — not explicitly documented but is part of the shared shape. |
| **Hooks visible from `/hooks` UI** | Yes | Yes — Codex `/hooks` is also where trust prompts appear | UX-equivalent. |

### Where there is NO clean equivalent

1. **`.claude/settings.local.json` (per-machine, per-project, gitignored)** — Codex has no `.local` config file. Either accept that project config is shared, or `.gitignore` your `.codex/config.toml`, or shift overrides into `~/.codex/<profile>.config.toml`.
2. **`permissions.{allow,ask,deny}` arrays** — Codex has no array-based allowlist. The closest analog is a PreToolUse hook script that grep-matches the command and returns `deny`/`allow`. itsybitsy can keep its data model and translate at agent-spawn time into a generated hook script (Bash/Python).
3. **`--allowedTools` / `--disallowedTools` CLI flags** — no Codex equivalent. Same workaround: bake into a generated hook.
4. **`--setting-sources user,project,local`** — Codex's `--ignore-user-config` is the only coarse switch; you cannot ask Codex to load *only* project config, for instance.
5. **`Task|Agent` PreToolUse interception** — Codex has no `Task` tool, so itsybitsy's `intercept-task` hook becomes a no-op or moves to a `SubagentStart` event (and `SubagentStart` is documented but [INFER] not yet widely battle-tested per open issues).
6. **`--system-prompt` / `--append-system-prompt`** — Codex relies on file-based `AGENTS.md` instead. itsybitsy's "session-start injection of role instructions" pattern translates better to writing per-agent `AGENTS.md` files in the worktree at spawn time than to a CLI flag.
7. **Hot-reload of hooks/permissions** — Claude reloads `settings.json` live; Codex appears to require fresh sessions.

---

## Quick recommendations for the codex-agent integration

[INFER] from the mapping above:

1. **At agent spawn, write a per-agent `.codex/config.toml`** in the worktree containing: `model`, `approval_policy`, `sandbox_mode`, `[hooks]` block, and `[projects."<abs path>"].trust_level = "trusted"` (so the project config layer is honored).
2. **Always pass `--dangerously-bypass-hook-trust`** when spawning Codex — otherwise hook edits between spawns will silently disable hooks.
3. **Map our `permissions.allow`/`deny` data** into a generated PreToolUse hook script (Python or Bash) that returns `permissionDecision: "deny"` when no allow-rule matches. Don't try to find a config-file equivalent — there isn't one.
4. **Map `--permission-mode acceptEdits`** to `-a never -s workspace-write` (Codex's two-dimensional model).
5. **Drop `intercept-task`** from Codex agents (no `Task` tool); rely on `SubagentStart` if/when itsybitsy needs to gate it.
6. **Write `AGENTS.md` in the worktree** to deliver session-start instructions instead of porting `session-start.ts`'s inline-injection model. Codex reads `AGENTS.md` natively.
7. **Path isolation (`main-path`) port:** rewrite the existing `ib hooks main-path` script to emit `updatedInput`/`permissionDecision` per the Codex contract, register it as `[[hooks.PreToolUse]] matcher = "^Bash$"`, and remember that `.git`/`.codex`/`.agents` read-only is already OS-enforced by Codex.
8. **`inject-status` port:** straightforward — Codex's `UserPromptSubmit` accepts the same hook shape; verify `additionalContext` is honored before relying on it.

---

## Sources

### Claude Code (official)
- [Settings — code.claude.com/docs/en/settings](https://code.claude.com/docs/en/settings)
- [Hooks reference — code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)
- [Permissions — code.claude.com/docs/en/permissions](https://code.claude.com/docs/en/permissions)
- [CLI reference — code.claude.com/docs/en/cli-reference](https://code.claude.com/docs/en/cli-reference)

### Codex CLI (official, developers.openai.com)
- [Configuration Reference — /codex/config-reference](https://developers.openai.com/codex/config-reference)
- [Config basics — /codex/config-basic](https://developers.openai.com/codex/config-basic)
- [Advanced Configuration — /codex/config-advanced](https://developers.openai.com/codex/config-advanced)
- [Sample Configuration — /codex/config-sample](https://developers.openai.com/codex/config-sample)
- [Hooks — /codex/hooks](https://developers.openai.com/codex/hooks)
- [Command line options — /codex/cli/reference](https://developers.openai.com/codex/cli/reference)
- [Agent Approvals & Security — /codex/agent-approvals-security](https://developers.openai.com/codex/agent-approvals-security)

### WebSearch corroboration (third-party context, NOT authoritative)
- [Codex CLI hook governance: what works today (and what doesn't) — agenticcontrolplane.com](https://agenticcontrolplane.com/blog/codex-cli-hooks-reference)
- [GitHub: ApplyPatchHandler doesn't emit PreToolUse/PostToolUse hook event — openai/codex#16732](https://github.com/openai/codex/issues/16732)
- [GitHub: Add PreToolUse and PostToolUse hook events for code quality enforcement — openai/codex#14754](https://github.com/openai/codex/issues/14754)
- [GitHub: Proposal: add PreToolUse/PostToolUse lifecycle hooks — openai/codex#14882](https://github.com/openai/codex/issues/14882)
- [GitHub: Hooks: PostToolUse is missing for tools that complete via exec session — openai/codex#16246](https://github.com/openai/codex/issues/16246)
- [GitHub: Support MCP tools in hooks — openai/codex#18385 (PR)](https://github.com/openai/codex/pull/18385)
- [GitHub: hooks: emit Bash PostToolUse when exec_command completes via write_stdin — openai/codex#18888 (PR)](https://github.com/openai/codex/pull/18888)

### Observed on this machine
- `/Users/adamwulf/.claude/settings.json` — itsybitsy's currently-installed Claude hooks + permissions
- `/Users/adamwulf/.codex/config.toml` — minimal: one trusted project entry + a TUI nux counter; no hooks, no profiles, no `requirements.toml`
