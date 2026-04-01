# Research: itsybitsy Configuration & Permission System

## 1. Complete Config Key Inventory

All keys are defined in `src/config.ts` `CONFIG_KEYS` array. Config is read from `~/.itsybitsy/config.json` (user source) with typed defaults.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxAgents` | number | `10` | Maximum concurrent agents per repo. Coordinators bypass this limit. |
| `model` | string | `"opus"` | Default model for manager/worker agents. |
| `createPullRequests` | boolean | `false` | When true, managers create PRs on completion (if `gh` and remote available). |
| `allowAgentQuestions` | boolean | `true` | Whether agents can ask the user questions via `ib ask`. |
| `autoCompactThreshold` | number | `undefined` | Context window usage % that triggers auto-compact. |
| `externalDiffTool` | string | `undefined` | External diff tool command for `ib diff`. |
| `hooks.injectStatus` | boolean | `true` | Whether status injection hook runs. |
| `hooks.statusVisible` | boolean | `true` | Whether injected status is visible (systemMessage) vs silent (additionalContext). |
| `coordinator.model` | string | `"opus"` | Model for both system and per-repo coordinators. Per-repo can override with `--model`. |
| `permissions.all.allow` | string[] | `[]` | Additional allow permissions applied to ALL agent types (manager, worker, coordinator). |
| `permissions.all.deny` | string[] | `[]` | Additional deny permissions applied to ALL agent types. |
| `permissions.manager.allow` | string[] | `[]` | Additional allow permissions for manager agents only. |
| `permissions.manager.deny` | string[] | `[]` | Additional deny permissions for manager agents only. |
| `permissions.worker.allow` | string[] | `[]` | Additional allow permissions for worker agents only. |
| `permissions.worker.deny` | string[] | `[]` | Additional deny permissions for worker agents only. |
| `permissions.coordinator.allow` | string[] | `[]` | Additional allow permissions for per-repo coordinators. |
| `permissions.coordinator.deny` | string[] | `[]` | Additional deny permissions for per-repo coordinators. |
| `permissions.repo.allow` | string[] | `[]` | **DEFINED BUT UNUSED** - exists in CONFIG_KEYS but never read by any code. |
| `permissions.repo.deny` | string[] | `[]` | **DEFINED BUT UNUSED** - exists in CONFIG_KEYS but never read by any code. |

### Config Read/Write

- **Read**: `readConfig()` reads `~/.itsybitsy/config.json`, iterates CONFIG_KEYS, returns `Record<string, ConfigEntry>` where each entry has `{ value, source: "user" | "default" }`.
- **Write**: `writeConfig(filePath, key, value)` reads existing file, sets nested value, writes back.
- **Nested keys**: Dot-separated keys like `permissions.manager.allow` are resolved via `getNestedValue`/`setNestedValue` to traverse nested JSON objects.
- **Validation**: `validateConfigValue()` checks type matches (number, boolean, string, string[]).

## 2. Permission Layering

### For Manager/Worker Agents (`buildAgentSettings()`)

Permissions are layered in this order (all merged via set union + dedup):

1. **Existing permissions** — from `<repo>/.claude/settings.local.json` `permissions.allow`/`deny` (if file exists)
2. **Mandatory permissions** (hardcoded `ibPerms`):
   - `Bash(ib:*)` + git commands (`git status`, `git add`, `git commit`, `git diff`, `git show`, `git log`, `git ls-files`, `git grep`, `git rm`, `git merge`, `git rebase`, `git checkout`, `git restore`, `git reset`)
   - Filesystem inspection: `Bash(pwd:*)`, `Bash(ls:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(cat:*)`, `Bash(grep:*)`
   - Claude Code tools: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `TodoWrite`, `Task`, `Agent`, `TaskOutput`, `KillShell`, `NotebookEdit`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ToolSearch`
3. **Config role-specific permissions** — `permissions.manager.allow`/`deny` OR `permissions.worker.allow`/`deny` (based on agent type)
4. **Config global permissions** — `permissions.all.allow`/`deny` (merged with role-specific)
5. **Always denied** (hardcoded): `EnterPlanMode`, `ExitPlanMode`

**Merge formula** (in `newAgent()`):
```
configAllow = dedupe(roleAllow + allAllow)
configDeny = dedupe(roleDeny + allDeny)
```

Then in `buildAgentSettings()`:
```
finalAllow = dedupe(existingAllow + mandatoryPerms + configAllow)
finalDeny = dedupe(existingDeny + blockedTools + configDeny)
```

**CLI overrides** (`--allow`/`--deny`): These are passed as `--allowedTools`/`--disallowedTools` flags to the `claude` CLI in `start.sh`, which are separate from `settings.local.json` permissions. They are additive to the settings file.

### For Per-Repo Coordinators (`buildPerRepoCoordinatorSettings()`)

Different layering — hardcoded base is more restrictive:

1. **Hardcoded allow** (`PER_REPO_COORDINATOR_ALLOW`):
   - `Bash(ib:*)` + read-only git: `git status`, `git log`, `git diff`, `git show`, `git ls-files`
   - `Bash(pwd:*)`, `Bash(ls:*)`
   - `Read`, `Glob`, `Grep`, `LS`, `TodoWrite`, `AskUserQuestion`, `ToolSearch`
2. **Hardcoded deny** (`PER_REPO_COORDINATOR_DENY`):
   - `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task`, `TaskOutput`, `Agent`, `KillShell`, `EnterPlanMode`, `ExitPlanMode`
3. **Config merge**:
   - `permissions.coordinator.allow` + `permissions.all.allow` — but entries that appear in hardcoded deny are **silently dropped**
   - `permissions.coordinator.deny` + `permissions.all.deny` — appended to hardcoded deny

### For System Coordinator (`buildSystemCoordinatorSettings()`)

Fixed permissions, no config merge at all:
- **Allow**: `Bash(ib:*)`, `ToolSearch`
- **Deny**: `Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Task`, `TaskOutput`, `Agent`, `KillShell`, `EnterPlanMode`, `ExitPlanMode`

### Additional Hook-Based Restrictions

- **Path isolation** (`hook-check-path`): Agents can only access their own worktree, `~/.claude`, `/tmp`, and system paths. Cannot access main repo or other agents' worktrees.
- **Intercept-task** (`intercept-task.ts`): Intercepts `Task`/`Agent` tool calls from managers, spawns ib agents instead. Workers are skipped (native Task allowed). Certain subagent_types are skipped: `Bash`, `statusline-setup`, `claude-code-guide`, `meta-agent`, `ib-merge`.
- **Coordinator Bash restrictions**: Per-repo coordinators cannot use shell metacharacters (`;`, `|`, `&`, `` ` ``, `>`, `<`, `$()`, etc.) in Bash commands. Also blocks `--output` in git commands.

## 3. Model Selection

### Manager/Worker Agents
Priority chain: `--model` CLI flag > `config.model` > `"opus"` (hardcoded default)

### Coordinators
Priority chain: `--model` CLI flag > `config["coordinator.model"]` > `"opus"` (hardcoded default)

### Validation
- `isValidModel()`: Must match `/^[a-zA-Z0-9._-]+$/` (alphanumeric, dots, hyphens, underscores)
- `intercept-task.ts` `VALID_MODELS`: Only `"sonnet"`, `"opus"`, `"haiku"`, `""` are accepted. Invalid models are silently reset to `""`.

## 4. New-Agent CLI Flags

Defined in `NewAgentOptions` interface:

| Flag | Type | Description |
|------|------|-------------|
| `--worker` | boolean | Spawn as worker (cannot manage sub-agents, uses worker permissions, native Task allowed) |
| `--coordinator` | boolean | Spawn as per-repo coordinator (read-only, one per repo, bypasses maxAgents) |
| `--model` | string | Override model (takes precedence over config) |
| `--yolo` | boolean | Skip permissions (`--dangerously-skip-permissions`). Blocked unless parent is also yolo (escalation prevention). |
| `--name` | string | Custom agent ID (must match `/^[a-zA-Z0-9_\-]+$/`) |
| `--no-worktree` | boolean | Run in main repo (no git worktree). Not allowed with `--coordinator`. |
| `--allow` | string | Additional allowed tools (passed as `--allowedTools` to claude CLI) |
| `--deny` | string | Additional denied tools (passed as `--disallowedTools` to claude CLI) |
| `--print` | boolean | Run in print mode (`--print` flag to claude CLI) |
| `--manager` | string | Explicit parent agent ID (auto-detected from cwd if in an agent worktree) |

Mutual exclusivity: `--coordinator` + `--worker` = error. `--coordinator` + `--no-worktree` = error.

## 5. Custom Prompts

Read from `.ittybitsy/prompts/` directory:
- `all.md` — injected for all agents as `[CUSTOM INSTRUCTIONS]`
- `manager.md` — injected for managers as `[CUSTOM MANAGER INSTRUCTIONS]`
- `worker.md` — injected for workers as `[CUSTOM WORKER INSTRUCTIONS]`

No coordinator-specific custom prompt file is loaded.

## 6. Session-Start Role Detection

`session-start.ts` detects 4 roles: `primary`, `manager`, `worker`, `coordinator`. Each gets a different instruction template injected via the SessionStart hook. Role detection reads `meta.json` fields: `worker: true` → worker, `coordinator: true` → coordinator, otherwise → manager. Non-agent cwd → primary.

## 7. Hooks Installed Per Agent Type

| Hook | Manager | Worker | Coordinator |
|------|---------|--------|-------------|
| `hook-check-path` (PreToolUse, matcher: `*`) | Yes | Yes | Yes |
| `hook-status` (Stop, matcher: `*`) | Yes | Yes | Yes |
| `hook-permission-denied` (PermissionRequest, matcher: `*`) | Yes | Yes | Yes |
| `session-start` (SessionStart) | Yes | Yes | Yes |
| `intercept-task` (PreToolUse, matcher: `Task\|Agent`) | Only if parent repo has it | No | Yes (matcher: `Task\|Agent\|Bash`) |

## 8. Knobs Needed for Per-Agent-Type Definitions

If agent types were user-definable, each type would need:

### Permission knobs
- **allow**: List of tool/bash patterns to add to the allow list
- **deny**: List of tool/bash patterns to add to the deny list
- **mandatory allow base**: Which hardcoded set to use (full manager set vs restricted coordinator set vs custom)
- **mandatory deny base**: Which blocked tools apply
- **config allow conflict resolution**: Whether config allow entries conflicting with hardcoded deny are silently dropped (coordinator behavior) or allowed through (manager/worker behavior)

### Model knobs
- **default model**: What model to use when `--model` is not specified (currently `config.model` for manager/worker, `config["coordinator.model"]` for coordinator)
- **model validation**: Whether to restrict to VALID_MODELS set or allow any valid model string

### Behavioral knobs
- **can_spawn_agents**: Whether Task/Agent tools are intercepted to spawn ib agents (manager: yes via intercept hook, worker: no/native, coordinator: yes via intercept hook)
- **can_write_code**: Whether Write/Edit/MultiEdit are allowed (manager/worker: yes, coordinator: no)
- **can_access_web**: Whether WebFetch/WebSearch are allowed
- **max_agents_bypass**: Whether this type bypasses the maxAgents limit (coordinator: yes, others: no)
- **one_per_repo**: Whether only one agent of this type can exist per repo (coordinator: yes, others: no)
- **bash_restrictions**: Whether shell metacharacters are blocked (coordinator: yes, others: no)
- **read_only_git**: Whether git write commands (add, commit, merge, rebase) are excluded from allow list
- **yolo_allowed**: Whether `--yolo` can be used
- **custom_prompt_file**: Which file from `.ittybitty/prompts/` to load (currently `manager.md` or `worker.md`, not coordinator)
- **session_instructions_template**: Which instruction template to use at session start
- **create_prs**: Whether PR creation instructions are injected
- **auto_detect_manager**: Whether to auto-detect parent from cwd (coordinator: never, others: yes)
- **naming**: How agent IDs are generated (coordinator: repo basename, others: random hex or `--name`)

### Hook knobs
- **intercept_task_hook**: Whether the intercept-task PreToolUse hook is installed
- **intercept_task_matcher**: What tool matcher to use (`Task|Agent` vs `Task|Agent|Bash`)

## 9. Validation Rules & Constraints

| Validator | Regex/Rule | Used For |
|-----------|-----------|----------|
| `isValidModel` | `/^[a-zA-Z0-9._-]+$/` | Model names before shell interpolation |
| `isValidToolList` | `/^[a-zA-Z0-9_*()\-:,. ]+$/` | `--allow`/`--deny` tool lists |
| `isValidAgentId` | `/^[a-zA-Z0-9_-]+$/` | Agent IDs |
| `isValidTmuxSession` | `/^[a-zA-Z0-9_-]+$/` | Tmux session names |
| `isValidSessionId` | `/^[a-fA-F0-9-]+$/` | Claude session UUIDs |
| `isValidShellPath` | No null bytes or newlines | Repo paths in shell scripts |
| `isValidSource` | `/^[\w-]+$/` | Inbox message sources |
| `isValidInboxFilename` | `/^\d+-[0-9a-f]{4}-[\w-]+\.msg$/` | Inbox filenames |
| `shellQuote` | Replace `'` with `'\''`, wrap in `'` | All shell-interpolated values |
| Agent name | `/^[a-zA-Z0-9_\-]+$/` | Custom `--name` values |
| `VALID_MODELS` (intercept) | Set: `sonnet`, `opus`, `haiku`, `""` | Models in intercepted Task/Agent calls |

## 10. Summary: Current Type System

Today there are effectively 4 agent types, but they are **not user-definable**. Each has hardcoded behavior scattered across multiple files:

| Aspect | Manager | Worker | Per-Repo Coordinator | System Coordinator |
|--------|---------|--------|---------------------|-------------------|
| Config permissions key | `permissions.manager.*` | `permissions.worker.*` | `permissions.coordinator.*` | None (fixed) |
| Can write code | Yes | Yes | No | No |
| Can read code | Yes | Yes | Yes | No |
| Can spawn agents | Yes (intercepted) | No (native Task) | Yes (intercepted) | No |
| Bash restrictions | None | None | No metacharacters | Only `ib:*` |
| Model config key | `model` | `model` | `coordinator.model` | `coordinator.model` |
| Custom prompt | `manager.md` | `worker.md` | None | Fixed prompt |
| One per repo | No | No | Yes | One globally |
| Bypasses maxAgents | No | No | Yes | N/A |
