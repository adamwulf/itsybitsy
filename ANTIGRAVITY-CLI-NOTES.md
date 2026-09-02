# Antigravity CLI (`agy`) as an alternative agent model — research notes

> Status: **RESEARCH — no code.** Written 2026-09-01 by researcher agent `antigravity` on branch `agent/antigravity`.
> Scope: answer "how do we add `agy` next to `claude`, `codex`, and `fugu`", with the same shape as the codex work in `SPEC-CODEX-MODEL.md`[^54].
> Auth is out of scope. The user signs in once by hand.
> The facts below come from the official docs, the local `agy` install (v1.1.23), the open GitHub issue tracker, and the itsybitsy code. Claims that only a live run can settle are collected in §16 (spike plan). Do not implement before the spike.

---

## 0. Short answers

| Question | Answer |
|---|---|
| CLAUDE.md vs AGENTS.md | `agy` reads `GEMINI.md` and `AGENTS.md` (walk-up from cwd to the repo root), `.agents/rules/*.md`, and global `~/.gemini/GEMINI.md`. It does not read `CLAUDE.md`[^22][^23][^13][^30]. Generate the per-agent instructions into an `agy` custom-agent file (`.agents/agents/ittybitty/agent.md`, body = system prompt) or into `.agents/rules/ittybitty.md`, and inline the project and user `CLAUDE.md` text into it. Do not overwrite a repo's own `AGENTS.md` (§3). |
| Hooks for tool permissions | Yes. `agy` has `PreToolUse` hooks in `.agents/hooks.json` with a `decision: allow \| deny \| ask \| force_ask \| deny_unless_prior_grant` output and `permissionOverrides`[^21][^30]. Same architecture as the codex PreToolUse handler[^58]. Two things need a spike: whether `deny` blocks without an approval card on 1.1.23 (it did not on 1.1.2[^34]), and whether a crashed hook fails open or closed (undocumented[^21]). |
| Hooks for directory reads | Mostly not needed for the file tools. `agy` fences `view_file` / `write_to_file` to the workspace by default (`allowNonWorkspaceAccess: off`, workspace read/write auto-allowed, outside = ask)[^3][^4][^32]. The hook is still required for `run_command` path checks (`cat ../x`, `cd`, `git -C`) and for any root we add with `--add-dir` (§7). |
| CLI settings instead of hooks | Use flags, not the global `settings.json`: `--mode=accept-edits` (no per-file diff review card), `--agent <name>` (custom agent with a scoped `tools:` list that omits the sub-agent tools), `--add-dir`, `--model`, `--effort`, `--conversation <id>`, `--log-file`, `--title`[^7][^19][^18][^50][^6][^30]. The `permissions.allow/deny` engine lives only in the user-global `~/.gemini/antigravity-cli/settings.json`[^3] and has open correctness bugs[^43][^37], so it cannot be the per-agent boundary. |
| Forgotten items | Trust prompt per new worktree (§9), alt-screen TUI vs tmux scrollback (§14.1), hooks silently not running under API-key auth (§5.4), Stop hook not firing on Linux (§10), `invoke_subagent` ignoring hook blocks (§11), in-worktree `.agents/` and `.gemini/` files to git-exclude (§3.3), resume via `conversationId` (§12), headless `-p` is not usable (§2.3), quota/license 403 seen on this machine (§13). |

Recommended shape (details in §8 and §15): `agy:<model>` selector → `agy --agent ittybitty --mode=accept-edits --model <m> --effort <e> --add-dir ~/.itsybitsy --log-file <agentDir>/agy.log --title <agentId> "<prompt>"` inside tmux, with `<worktree>/.agents/hooks.json` registering `PreToolUse` → `ib hooks agy-pre-tool-use <id>`, `PreInvocation` → `ib hooks agy-pre-invocation <id>`, `Stop` → `ib hooks agy-stop <id>`, all git-excluded.

> **Superseded by the spike (§17, same day).** The spike changed three things: (1) use `--dangerously-skip-permissions` plus a deny-by-default hook, because a hook `allow` cannot suppress the permission card but a hook `deny` is a silent hard block and the hook is **fail-closed**; (2) do not use `--agent` — workspace custom agents are not discovered and a global one drops the workspace rules — put the instructions in `<worktree>/.agents/rules/ittybitty-agent.md` with `trigger: always_on`; (3) `--title` does not exist. The design source of truth is now `SPEC-ANTIGRAVITY-CLI.md`.

---

## 1. What `agy` is, and what is on this machine

- Antigravity CLI is Google's terminal TUI agent. It shares the agent core and settings with the Antigravity 2.0 desktop app and imports Gemini CLI extensions, skills, and settings on first run[^1][^13].
- Binary name `agy`, installed by `curl -fsSL https://antigravity.google/cli/install.sh | bash`; sign-in opens a browser (or prints a URL over SSH); credentials go to the OS keyring; an API-key path exists via `modelProvider: "gemini"` + `GEMINI_API_KEY`[^2].
- On this Mac: `/opt/homebrew/bin/agy` → Homebrew cask `antigravity-cli` **1.1.23**[^30]. The app data dir `~/.gemini/antigravity-cli/` was created 2026-09-01 17:39 when the user ran `agy` once from the itsybitsy checkout; it holds `settings.json`, `conversations/<uuid>.db` (sqlite), `cache/last_conversations.json`, `log/cli-*.log`, and a `builtin/skills/agy-customizations/docs/` folder with the hooks/rules/plugins reference used below[^26][^27][^28][^21].
- The one local run ended with a quota fetch error: `PERMISSION_DENIED (code 403): You do not have a valid license of this product`[^27]. Confirm the account works before the spike (§13).
- `~/.gemini/config/` is the shared "global customization root" (skills, agents, hooks, mcp) for the CLI and the app[^22][^25].

## 2. Launch surface

### 2.1 Flags (from `agy --help`, v1.1.23)

```
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  -c                              Short alias for --continue
  --continue                      Continue the most recent conversation
  --conversation                  Resume a previous conversation by ID
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --disable-slash-commands        Disable slash command and skill expansion in print mode
  --effort                        Reasoning effort for the current CLI session (low|medium|high)
  -i                              Short alias for --prompt-interactive
  --input-format                  Input format for print mode (text, stream-json). ...
  --json-schema                   Optional JSON schema string or path to a schema file ...
  --log-file                      Override CLI log file path
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
  --model                         Model for the current CLI session
  --new-project                   Create a new project for this session
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
  -p                              Short alias for --print
  --print                         Run a single prompt non-interactively and print the response
  --print-timeout                 Timeout for print mode wait (default 5m0s)
  --project                       Project ID or project name for the current CLI session
  --prompt                        Alias for --print
  --prompt-interactive            Run an initial prompt interactively and continue the session
  --sandbox                       Run in a sandbox with terminal restrictions enabled

Available subcommands: agent, agents, changelog, help, install, mcp, mic-serve, models, plugin, plugins, update
```

Captured on this machine on 2026-09-01[^75]. There is no `--title`, no trust flag, no per-process settings file, no `--no-subagents`, no `--yolo`, no `--resume`. `agy models` prints `<slug>\t<label>` pairs (e.g. `gemini-3.7-flash-low`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`); `--model` takes the slug[^75].

### 2.2 Flags that matter for us

| Flag | What it does | Source |
|---|---|---|
| `--mode=default\|accept-edits\|plan` | `default` pauses for an interactive diff review before every file write; `accept-edits` auto-approves file edits and creations; `run_command` stays governed by permission rules in all modes | [^7] |
| `--agent <name>` | Select a custom agent (`.agents/agents/<name>/agent.md` or `~/.gemini/config/agents/<name>/agent.md`) as the primary agent | [^17][^19][^32] |
| `--add-dir <path>` | Add a directory to the workspace (repeatable) | [^50][^53] |
| `--model <slug\|label>` / `--effort low\|medium\|high` | Model and reasoning effort; `agy models` lists models | [^6][^50] |
| `--continue` / `--conversation <uuid>` | Resume last conversation for this workspace / a specific one | [^8][^9] |
| `--dangerously-skip-permissions` | Auto-approve all tool requests | [^6] |
| `--sandbox` | Enable terminal sandbox for this session (overrides `enableTerminalSandbox`) | [^4][^51] |
| `--log-file <path>` | Override the CLI log path | [^50][^53] |
| `--title <text>` | Window/terminal title (also `/title`) | [^30][^1] |
| `--project <id\|name>` / `--new-project` | Project selection; default is `default-cli-project` | [^10][^31] |

### 2.3 Headless mode is not a fit (confirms the codex D2 decision)

`agy -p` streams to stdout and soft-denies any tool that needs approval; permissions must be pre-granted in the global `settings.json` or bypassed with `--dangerously-skip-permissions`[^6]. Issue #548 (open) reports `-p` ignoring `permissions.allow` entirely and hanging past `--print-timeout`[^33]. So, as with codex, launch the **interactive TUI inside tmux**[^54]. The `--input-format stream-json` multi-turn stdin mode[^6] is worth a note for a future "no tmux send-keys" delivery path, but it is a print-mode feature and inherits the same permission problem.

## 3. Context files: `CLAUDE.md` vs `AGENTS.md`

### 3.1 What `agy` reads

- "Directory-Based Rules (`GEMINI.md` / `AGENTS.md`)": the system walks up from cwd to the repository root and loads them; they apply to their directory and below; these standalone files do not support frontmatter and are always active[^23].
- Workspace customization roots: `.agents/` (or `.agent/`, `_agents/`, `_agent/`) at the project root; rules also in `.agents/rules/*.md`; global root `~/.gemini/config/`; only `always_on` rules load unconditionally, `trigger: model_decision` rules are lazy[^22].
- Migration doc: "`.gemini/GEMINI.md` and `AGENTS.md`" locally, `~/.gemini/GEMINI.md` globally; existing files work unchanged[^13].
- The binary contains the strings `AGENTS.md` and `GEMINI.md` and no `CLAUDE.md`[^30]. Nothing in the docs mentions `CLAUDE.md`.
- The first local run logged `prompt section "user_rules"` as empty (the itsybitsy checkout has `CLAUDE.md` only)[^27].

### 3.2 What codex does today, and why not to copy it verbatim

`writeCodexAgentsMd` renders the same session-start template Claude gets, strips the `<ittybitty>` wrapper, appends a `@./CLAUDE.md` import (a codex-specific syntax) plus the inlined user-global `~/.claude/CLAUDE.md`, and **overwrites `<worktree>/AGENTS.md`**[^67]. Two problems for `agy`:

1. `agy` has no documented `@file` import in rule files, so both the project `CLAUDE.md` and the user `CLAUDE.md` must be inlined (or the user adds an `AGENTS.md` to the repo).
2. Overwriting `AGENTS.md` dirties the worktree in any repo that tracks that file, and the agent may commit it. Prefer a file no repo tracks.

### 3.3 Recommendation

Write **one generated file** per agent: `<worktree>/.agents/agents/ittybitty/agent.md`, an `agy` custom agent[^17][^19]. Its frontmatter carries the pass-through settings from our own agent-type `.md` (model tier, `tools:` list, `commandExecutionPolicy`, optional `hooks:`), and its markdown body is the system prompt built from our session-start template[^19][^20]. Launch with `--agent ittybitty`. If the spike shows the body is not injected as a system prompt in the CLI, fall back to `<worktree>/.agents/rules/ittybitty.md` with `trigger: always_on`[^22].

Git hygiene: `.agents/hooks.json`, `.agents/agents/ittybitty/`, and `.gemini/antigravity-cli/` (transcript and artifacts, if they land in the worktree — see §10) must be excluded. The codex precedent appends to the worktree `.gitignore`[^68]; for `agy` prefer the per-repo `.git/info/exclude` so a tracked `.gitignore` stays clean. Note `.agents/` itself may be tracked by a repo (skills, `mcp_config.json`)[^13][^16], so exclude only our files, not the directory.

## 4. The permissions engine (settings, no hooks)

- Every sensitive action is `action(target)`: `read_file`, `write_file` (implies read), `read_url`, `execute_url`, `command` (prefix or anchored regex), `unsandboxed`, `mcp`. Lists `deny` > `ask` > `allow`. Defaults: workspaces auto-allowed for read/write; web actions ask; unconfigured commands, MCP, and non-workspace files ask[^3].
- Configured only in `~/.gemini/antigravity-cli/settings.json`[^3][^4]; the CLI also reads shared permissions from `~/.gemini/config/config.json` and per-project grants (`ApplyProjectPermissionGrants`)[^27]. No workspace-level `settings.json` is documented.
- `toolPermission`: `request-review` (default), `proceed-in-sandbox`, `strict`, `always-proceed`; `artifactReviewPolicy`: `asks-for-review` (default), `agent-decides`, `always-proceed`; `allowNonWorkspaceAccess` (default off)[^4]. Changelog: the non-workspace setting "now grants only read access"; default review mode auto-grants workspace-scoped reads; `always-proceed` also auto-approves MCP calls and page reads[^32][^31].
- Interactive approval card lets the user edit the target string; keys `y` (approve) / `n` (reject) / `A` (approve all artifacts)[^3][^74].
- Reliability today: #798 (1.1.13, open) shows a path-specific `read_file(...)` deny bypassed, `deny: ["read_file(*)"]` beating a narrower allow, and no way to disable file tools[^43]; #565 and #814 show allow-listed commands still prompting[^37][^44]. A wildcard allow that "tokenizes to zero command words" once auto-approved everything (fixed)[^32].

Conclusion: the engine is global, not per-agent, and not yet trustworthy as a security boundary. Use it for nothing itsybitsy depends on. Keep the hook as the boundary, exactly as for codex[^54].

## 5. Hooks

### 5.1 Where and how they are registered

- One `hooks.json` in a customization root: `<workspace>/.agents/hooks.json` (walk-up discovery) or `~/.gemini/config/hooks.json`; also inside a plugin[^21][^24][^15]. The CLI log prints `loaded N named hooks from M hooks.json file(s)` at start[^27] — a cheap spawn-time check that our file was picked up.
- Format: top-level key = hook name; `enabled` (default true); `PreToolUse` / `PostToolUse` are grouped `{matcher, hooks:[...]}`; `PreInvocation` / `PostInvocation` / `Stop` are flat handler lists. Handler: `type: "command"` only, `command` run via `sh -c` with **cwd = the directory containing `hooks.json`**, `~` expanded, `timeout` seconds (default 30). Hooks run synchronously and block the loop[^21].
- Matcher: `""`/`"*"` all, exact tool name, `a|b`, regex; tool names are the lowercased step types[^21].
- Custom agents can also carry `hooks:` in their frontmatter (PreInvocation / PreToolUse)[^20]. Unverified in the CLI; §16 Q6.

### 5.2 Payloads (camelCase)

Common fields on every event: `conversationId`, `workspacePaths[]`, `transcriptPath` (`<workspace>/.gemini/antigravity-cli/transcript.jsonl` for the CLI), `artifactDirectoryPath`, `modelName`[^21][^15]. There is **no `cwd` field**; use `workspacePaths[0]`.

| Event | Input | Output |
|---|---|---|
| `PreToolUse` | `toolCall.name`, `toolCall.args` (e.g. `CommandLine` for `run_command`), `stepIdx` | `decision` (required) `allow` / `deny` / `ask` / `force_ask` (+ `deny_unless_prior_grant` in the 2.0 docs and in the binary's enum), `reason`, `permissionOverrides[]` (e.g. `"read_file(/path)"`), `overwrite{}` (shallow arg merge) | [^21][^15][^30]
| `PostToolUse` | `stepIdx`, `error` if failed | `{}` | [^21]
| `PreInvocation` | `invocationNum`, `initialNumSteps` | `injectSteps[]` of `{toolCall}` / `{userMessage}` / `{ephemeralMessage}` | [^21]
| `PostInvocation` | same as PreInvocation | `injectSteps[]`, `terminationBehavior: force_continue \| terminate` | [^21]
| `Stop` | `executionNum`, `terminationReason` (`model_stop`, `max_steps_exceeded`, `error`), `error`, `fullyIdle` | `decision: "continue"` + `reason` blocks the stop; anything else lets it stop | [^21]

Tool names seen in the docs: `view_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `list_dir`, `find_by_name`, `grep_search`, `search_web`, `read_url_content`, `run_command`, `manage_task`, `schedule`, `list_permissions`, `ask_permission`, `invoke_subagent`, `define_subagent`, `send_message`, `manage_subagents`, `ask_question`, `generate_image`, `browser_*`[^15]. The arg key names for the file tools are not documented; §16 Q9 dumps them.

There is no `SessionStart` event (#809, open)[^40]. `PreInvocation` with `invocationNum == 1` is the closest thing.

### 5.3 Decision semantics — the crux

- Docs: `allow` "Automatically allow the tool execution", `deny` "Hard block the execution immediately", `ask` prompts (respects Always Allow), `force_ask` always prompts[^21]. The binary's JSON schema for `decision` is `enum=allow,deny,ask,force_ask,deny_unless_prior_grant`[^30]; the `"block"` value mentioned in #640 is not in that enum.
- Issue #628 (1.1.2, open, assigned): a hook `deny` "does not block tool execution. Instead, the CLI treats it as a permission request and displays its own approval prompt to the user, allowing them to override"[^34]. Issue #640 (1.1.4, open): a hook block **did** stop `write_to_file` with feedback, but not `invoke_subagent`[^35]. Issue #575 (1.0.2–1.1.0): the permission review runs against the original call, ignoring `overwrite`[^36].
- No changelog entry says `deny` became a hard block[^32][^31]. Assume "deny may show a card" until the spike says otherwise. In unattended tmux a card is a stall, not a bypass, and the watchdog can answer it with `n`.

### 5.4 Failure mode and liveness

- The builtin doc does not say what happens when a hook exits non-zero, times out, or prints bad JSON[^21]. 1.1.23 "caught hook panics"[^31]. Treat the direction as unknown; §16 Q3.
- Hooks load but never execute under `GEMINI_API_KEY` auth (#893, 1.1.22, open); they do execute under Google OAuth[^38]. `Stop` never executed on Linux 1.1.11 (#770, open)[^42]. Hooks receive nothing when an interactive approval card is shown (#804)[^39].
- Mitigation: a **hook-liveness precheck**. `PreInvocation` writes a heartbeat file under `<agentDir>` on `invocationNum == 1`; the spawn script or watchdog refuses to consider the agent healthy until it appears, and kills the session if it does not appear within a bound. This closes the "hooks silently off" hole that no dry-run can see. Also verify the `loaded 1 named hooks` log line via `--log-file`.

## 6. `agy` custom agents (generated from our agent-type `.md`)

Our agent-type `.md` files are itsybitsy's own format; the fields we define there are passed through to whichever CLI runs the agent. For `agy` the target is its custom-agent file.

- Locations: `.agents/agents/<name>/agent.md` (workspace) or `~/.gemini/config/agents/<name>/agent.md` (global); markdown with YAML frontmatter[^17][^12]. Select with `--agent <name>`; the `/agents` panel switches agents and shows sub-agents[^17][^32].
- Frontmatter fields documented across sources: `name`, `description`, `model` (`inherit` / `flash` / `pro`, or a tier), `tools: string[]` ("Explicit list of tools permitted"), `mainAgent`, `subagent`, `hidden`, `inheritMcp`, `inheritCustomizations` (single switch: adopt your skills, rules, plugins, subagents, MCP servers), `commandExecutionPolicy` (`off` / `auto` / `eager` / `sandbox`), `permissionMode` (e.g. `acceptEdits`), `skills`, `plugins`, `rules:` (1.1.15), `mcpServers`, `hooks`[^18][^19][^20][^31][^32]. The binary also carries `allowed_tools`, `disabled_tools`, `enable_mcp_tools`, `max_steps`[^30].
- "Custom agents receive only their specified tools rather than all workspace tools"[^19]. Warning: a misspelled tool name in `tools` "may cause the subagent process to hang"[^18].
- Body: the agent's own instructions, loaded when the agent is active (the blog calls custom agents "specialized agents with their own instructions, tools, models, permissions, skills and hooks")[^19][^20].

Why this matters: it is the only per-agent, file-based, non-global place to (a) scope the toolset (drop `invoke_subagent`, `define_subagent`, `manage_subagents`, `generate_image`, browser tools), (b) set the model tier and command policy, and (c) inject role instructions, without touching the user's global settings. All of it needs the §16 Q6 spike, because the CLI docs page documents only `name` and `description`[^17], and #858 reports a custom primary agent cannot invoke any sub-agent at all (open)[^48] — a bug for them, the behavior we want.

## 7. Sandbox and directory isolation

### 7.1 File tools

Workspace = the launch directory plus `--add-dir` roots; workspace read/write is auto-allowed, outside is ask; `allowNonWorkspaceAccess` grants read only[^3][^4][^32]. For a worktree this is the fence we want, with two caveats:

1. Every `--add-dir` root joins the workspace. Codex today adds `~/.itsybitsy` (outbox, team channels) and `~/Library/Caches` plus the git common dir as writable roots[^57][^73]. Under `agy` those roots become file-tool-writable too, so the PreToolUse hook must keep denying file-tool access into `~/.itsybitsy` and the main repo `.git`, mirroring `checkPathAccess`[^60].
2. Sibling worktrees `<repo>/.ittybitty/agents/*` are outside the workspace, so the engine would *ask*; the hook must *deny* first so no card appears.

### 7.2 `run_command`

The engine matches commands by prefix/regex only[^3]; it does not look at paths inside a command. Port the Bash path checks (`cd`, path tokens, `git -C`, `--git-dir`, `--work-tree`, `ib` sub-command rules) from `checkPathAccess`[^60] to `run_command` with `toolCall.args.CommandLine`[^21].

### 7.3 Terminal sandbox

- `enableTerminalSandbox` (global) or `--sandbox` (per session) wraps `run_command` in `sandbox-exec` on macOS, `nsjail` on Linux[^5][^4]. The changelog says the sandbox grants read-only access to a repo's `.git` directory[^32] — in a worktree, `git commit` writes to the common dir under the main checkout, so this will likely break git unless `--add-dir <git common dir>` is honored by the sandbox. `--sandbox` also errored on glob roots (#798)[^43].
- `ib send` run by the agent writes to `~/.itsybitsy` from inside the sandboxed command[^64].
- Recommendation: **Phase 1 without the terminal sandbox**, like Claude agents today and like codex where the hook is the primary boundary and the leaky sandbox is defense-in-depth[^54]. Revisit `--sandbox` as an optional later phase after §16 Q12.

## 8. Never-prompt design (D4 analog)

Prompt sources in an interactive `agy` session: the workspace trust card (§9), per-file diff review in `default` mode[^7], the tool approval card for unconfigured commands / non-workspace files / MCP / web[^3], artifact review (`artifactReviewPolicy`)[^4], and hook `ask` / `force_ask` / (today) `deny`[^21][^34].

| Option | Launch | Prompt-free because | If the hook does not run |
|---|---|---|---|
| **A (recommended)** | `--mode=accept-edits`, no skip-permissions; hook returns `allow` for allow-listed + in-worktree calls, `deny` otherwise | hook `allow` auto-approves[^21]; `accept-edits` removes the diff card[^7]; workspace file tools are auto-allowed[^3] | unconfigured commands fall back to *ask* → the agent stalls on a visible card (safe); watchdog flags it |
| B (fallback) | `--dangerously-skip-permissions` + same hook, deny-by-default | nothing ever asks[^6] | everything is auto-approved → **unsafe**; requires the §5.4 liveness precheck, and it is unknown whether skip-permissions also overrides a hook `deny` |
| C | global `permissions.*` lists | — | not per-agent; engine bugs[^43][^37]; rejected |

Both A and B mirror the codex handler: allow-list from `_all.md` + `_non_coordinator.md` + `<type>.md`[^66], path isolation, deny by default, always emit JSON, always exit 0[^58]. Tool-name translation for the merged lists:

| Claude / codex pattern | `agy` tool | Note |
|---|---|---|
| `Bash(prefix:*)`, `Bash(exact)` | `run_command` with `args.CommandLine` | same prefix matcher[^60] |
| `Read`, `Glob`, `Grep`, `LS` | `view_file`, `find_by_name`, `grep_search`, `list_dir` | |
| `Write`, `Edit`, `MultiEdit` | `write_to_file`, `replace_file_content`, `multi_replace_file_content` | path from args (key name TBD, §16 Q9) |
| `WebFetch`, `WebSearch` | `read_url_content`, `search_web` | |
| `TodoWrite` | `manage_task` | |
| `Task`, `Agent`, `TaskCreate` | `invoke_subagent`, `define_subagent`, `manage_subagents` | deny; see §11 |
| — | `ask_question`, `schedule`, `generate_image`, `send_message`, `browser_*` | deny unless a type lists them |

The default allow floor lives in `REGULAR_AGENT_DEFAULT_ALLOW`[^65]; it will need an `agy` translation table next to it rather than a second copy.

## 9. Workspace trust

- `settings.json` gained `trustedWorkspaces: ["/Users/adamwulf/Developer/bun/itsybitsy"]` after the first run[^26]. The binary contains the card text `Do you trust the contents of this project?` and the answer `Yes, I trust this folder`[^30]. A user-published settings file shows the same `trustedWorkspaces` key, so it is a normal user-level setting, not something itsybitsy owns[^49].
- Every new worktree is a new directory, so every spawn will show the card once. Options: (1) watchdog auto-accept, like the Claude `trust this folder` handling in `parseClaudeState`[^70] and the `enter to confirm` Enter-sender in the watchdog[^69]; (2) append the realpath of the worktree to `trustedWorkspaces` before spawn and remove it on retire (a user-global file mutation, which the codex design deliberately avoided for `~/.codex/config.toml`[^54]). Recommend (1); (2) is the fallback. #189 shows a `/tmp` vs `/private/tmp` mismatch on macOS, so realpath the worktree either way[^41].

## 10. State detection and the watchdog

Codex reaches `running` / `waiting` / `complete` through hooks, with tmux scraping only for override states[^64][^55]. Same plan here:

- `PreInvocation` → `running` (fires before every model call)[^21]. Also the heartbeat of §5.4.
- `Stop` → `waiting` or `complete`. The payload has `terminationReason` (`model_stop` / `max_steps_exceeded` / `error`), `error`, and `fullyIdle`[^21] — `error` can drive `api_error` deterministically. The completion sentinel needs the last assistant message; `Stop` does not carry it, so read the tail of `transcriptPath`[^21] the way codex leaves room for[^59]. `decision: "continue"` + `reason` can push back "commit your work" exactly like `hookCodexStop`[^59]; the changelog caps consecutive continuations so a hook cannot wedge the agent[^32].
- Keep a tmux fallback in `parseStateForCli`[^63] because `Stop` has an open never-fires bug on Linux[^42]. Idle-prompt shape, spinner text, approval-card text, and quota-exhausted text must be captured from a real session (§16 Q8); nothing in the docs gives them.
- Watchdog gating: extend `classifyAgentCli`[^62] so the Claude-only rate-limit / api-error / auto-accept branches skip `agy`, then add an `agy` branch for the trust card (§9) and, under option A, for a hook-deny approval card (`n`).

`transcriptPath` is documented as `<workspace>/.gemini/antigravity-cli/transcript.jsonl`[^21]. If that is inside the worktree, exclude `.gemini/antigravity-cli/` (§3.3). Verify in §16 Q10; a checked-in `.gemini/GEMINI.md` is a legitimate rules file[^13], so do not exclude `.gemini/` wholesale.

## 11. Sub-agent gating (intercept-task analog)

- `agy` spawns native sub-agents through `invoke_subagent` / `define_subagent` / `manage_subagents`; a `PreToolUse` block is ignored for these three (#640, open)[^35]; there is no flag or setting to disable sub-agents (#241, open)[^47]; sub-agent tool calls fire `PreToolUse` with no agent identity (#809)[^40].
- Codex solved this with `-c features.multi_agent=false`[^57]. The `agy` equivalent is the custom agent's scoped `tools:` list (§6) — omit the three sub-agent tools — plus a hook deny (logs the attempt) plus the instruction text. #858 suggests `--agent` already blocks sub-agents today[^48]; do not rely on a bug, verify in §16 Q6.
- Managers keep spawning through `ib new-agent`; nothing in the Claude-side `intercept-task` redirect[^71] carries over, same as codex[^54].

## 12. Resume

- Every hook payload carries `conversationId`[^21]; conversations are UUIDs stored in `~/.gemini/antigravity-cli/conversations/<uuid>.db` and mapped per workspace in `cache/last_conversations.json`[^28][^9]. Resume with `agy --conversation <uuid>` from the same worktree; `-c` resumes the last one for the cwd[^8][^9].
- Store it as `meta.agy_conversation_id` next to `codex_session_id`[^55], captured in the first `PreInvocation` (the codex `SessionStart` capture point[^58] has no `agy` equivalent).
- `--conversation` on resume plus the same `--agent` / `--mode` / `--add-dir` flags, re-passed defensively as codex does[^56].

## 13. Quota, rate limits, licensing

- `/usage` refreshes model quotas in a TUI panel; no non-interactive or file-based quota read is documented[^14]. Quota is shared across the desktop app, CLI, and sub-agents, and the agent does not self-throttle[^52].
- The rate-limited UI string is unknown; capture it in §16 Q8. Until then `agy` agents surface `unknown` for that override, like codex before its string was captured[^55].
- This machine's first run got a 403 license error from the quota endpoint[^27]. The user should confirm a prompt actually answers before anyone spikes.

## 14. Other things to not forget

1. **Alt-screen TUI vs tmux capture.** `altScreenMode` defaults to alt-screen locally and inline over SSH; `never` forces inline[^4]. Alt-screen apps leave no scrollback for `capture-pane -J`, which the dashboard and `ib look` depend on[^64]. No per-process flag is documented; the only knob is the global setting. Spike first (§16 Q8); if alt-screen is in force, either set `altScreenMode: never` globally (user decision) or accept screen-only capture for `agy` agents.
2. **Pinned 1000-col tmux width** and the chrome slicer `computeChromeSlice(raw, isCodex)` are Claude/codex-specific[^64]; `agy` needs its own input-box detector or no trimming.
3. **`--title <agentId>`** helps `ib state` orphan detection, which today greps `claude --resume` / `--session-id` command lines[^64]; add an `agy` pattern.
4. **Nesting env vars.** Claude spawns clear `CLAUDECODE`[^56]; check what `agy` exports (§16 Q14).
5. **Hook cwd** is the `hooks.json` directory, not the worktree root[^21]; the handler must resolve the agent from `workspacePaths[0]` or from its `<agentId>` argv, never from `process.cwd()`.
6. **`--log-file <agentDir>/agy.log`** mirrors codex's `log_dir`[^57]; `archiveAgent` moves the dir wholesale.
7. **Model selector.** `agy:<model>` where the model half is whatever `--model` accepts (a label such as `"Gemini 3.5 Flash"` per the settings doc; `/model` also takes name, slug, or label since 1.1.22)[^4][^31]; add `agy` to `KNOWN_CLIS`[^61] and a few entries to `ib list-models`; effort maps like `mapEffortForCodex` (`xhigh`/`max` → `high`)[^72][^6].
8. **Coordinators:** reject `agy` for `--coordinator` at first, as codex is rejected today[^55].
9. **Commit attribution / co-author trailers:** codex needed `commit_attribution=""`[^57]; check whether `agy` adds one (§16 Q8).
10. **Skills:** `.agents/skills/` and `~/.gemini/antigravity-cli/skills/` become slash commands[^11]; the codex `buildSkillsSection` catalogue of `~/.claude/skills`[^67] is reusable text.
11. **Telemetry** (`enableTelemetry`) is a user setting; leave it[^26].

## 15. Seam mapping (what changes where)

| Seam | Codex today | `agy` |
|---|---|---|
| Selector | `KNOWN_CLIS = {claude, codex, fugu}`, `parseModel`[^61] | add `agy` |
| Launch builder | `buildCodexLaunchArgs` (inline `-c`)[^57] | `src/agy-config.ts`: render `hooks.json`, `agent.md`, argv (`--agent --mode --model --effort --add-dir --log-file --title`) |
| Spawn / resume scripts | `buildCodexStartContent` / `buildCodexResumeContent`[^56] | `src/agy-spawn.ts`, same setsid + SIGHUP + `ib write-pid` skeleton; resume = `--conversation <uuid>` |
| Worktree files | `.gitignore` `.codex/` + `AGENTS.md`[^68][^67] | `.agents/hooks.json` + `.agents/agents/ittybitty/agent.md`, excluded via `.git/info/exclude` |
| Hooks | `codex-pre-tool-use` / `codex-session-start` / `codex-stop` via `codex-dispatcher`[^64] | `agy-pre-tool-use` / `agy-pre-invocation` / `agy-stop` via an `agy-dispatcher`; output `{decision, reason}` / `{}` / `{decision:"continue"}` |
| Meta | `codex_session_id`[^55] | `agy_conversation_id`, `agy_hook_heartbeat_epoch` |
| Watchdog | `classifyAgentCli` gates[^62] | same gate + trust-card / deny-card answers |
| State | `parseStateForCli`[^63] | `agy` branch after the spike strings exist |
| Dashboard | model rendered verbatim[^55] | unchanged; chrome slicer TBD |
| Docs | SPEC.md §18[^55] | SPEC.md §19 + `SPEC-ANTIGRAVITY-CLI.md` after the spike |

Cross-cutting checklist: agent functionality (new spawn/resume branch, one meta field), hooks (three new handlers + hooks.json writer), watchdog (gate + two card answers), `ib watch` (chrome slicer, alt-screen capture) — all affected.

## 16. Spike plan (the Phase 2 analog — run before any design freeze)

Run each from a throwaway git worktree under a repo that also has a root `AGENTS.md`, with a probe hook that appends every stdin payload to a file. Record the exact TUI strings.

| # | Question | Pass condition |
|---|---|---|
| Q1 | Hook `deny` in interactive mode on 1.1.23: silent block, card, or model-visible reason? Repeat with `--dangerously-skip-permissions` | no card, model sees the reason |
| Q2 | Hook `allow` for an unlisted command and for a non-workspace read: card suppressed? | no card |
| Q3 | Hook crash / non-JSON / timeout: does the call proceed? | documented either way; deny-on-crash still emitted |
| Q4 | Under this machine's OAuth login: `loaded 1 named hooks` in the log and a `PreInvocation` heartbeat within 10 s | both present |
| Q5 | Worktree launch: `workspacePaths`, which `AGENTS.md`/rules load (worktree only, or the main checkout too?), trust card text and the keystroke that accepts it, conversation scoping | worktree-only scope |
| Q6 | `--agent ittybitty`: body used as system prompt? `tools:` honored for the primary agent? sub-agent tools absent? `inheritCustomizations: false` effect? `hooks:` in frontmatter fires? | all yes |
| Q7 | `--mode=accept-edits`: no diff card; artifact review card behavior | no cards |
| Q8 | Rendering in tmux at 1000 cols: alt-screen or inline; idle prompt, spinner, approval card, quota-exhausted, api-error strings; commit trailer | strings captured |
| Q9 | `toolCall.args` key names for every file/search/web tool | table filled |
| Q10 | `Stop` fires on macOS each turn; payload; `transcriptPath` location and line format; `decision: continue` re-enters | yes; path known |
| Q11 | `conversationId` capture → `agy --conversation <id>` resumes from the worktree with hooks re-loaded | resumes |
| Q12 | (optional) `--sandbox` + `git commit` in a worktree + `ib send` | works or documented |
| Q13 | `--add-dir ~/.itsybitsy`: file tools inside it auto-allowed? hook deny still applies? | hook wins |
| Q14 | Env vars visible to hooks and to `run_command`; any nesting marker | list captured |

## 17. Open risks

1. `deny` may still surface a card (#628 open)[^34] — option A tolerates a stall, option B does not.
2. Hooks can be loaded but not executed (#893, #770)[^38][^42] — the liveness precheck is mandatory under either option.
3. Sub-agent tools ignore hook blocks (#640)[^35] — the custom-agent `tools:` scope is the only lever and is unverified in the CLI.
4. Worktree workspace detection had bugs (#68 fixed, #253 open on Windows)[^46][^45].
5. Alt-screen rendering may defeat tmux scrollback capture (§14.1)[^4].
6. Version drift: all facts pinned to 1.1.23; the changelog moves weekly[^31]. Stamp `agy --version` into meta at spawn.
7. The permissions engine bugs (#798)[^43] mean workspace fencing of file tools is best-effort; the hook path checks stay the boundary.

---

## 17. Spike results (2026-09-01, agy 1.1.23, macOS, Google OAuth sign-in)

Method: a throwaway workspace under the session scratchpad with `git init`, a probe hook (`bash hook.sh <Event>`) registered for all five events in `<ws>/.agents/hooks.json` that appends every stdin payload to a log and answers from a decision file, and `agy` launched inside dedicated tmux sessions (200×50) with `--model gemini-3.7-flash-low --mode=accept-edits --log-file <path>`. Ten sessions total. Everything below was observed directly; pane captures are quoted verbatim[^75].

### 17.1 Trust card (Q5)

Every new directory shows this card once, including a git worktree:

```
Accessing workspace:

<abs path>

Do you trust the contents of this project?

Antigravity CLI requires permission to read, edit, and execute files here.

> Yes, I trust this folder
  No, exit

  ↑/↓ Navigate · enter Confirm
```

`Enter` accepts. On accept, agy appends the path to `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` and rewrites that file (key order changes). Workspace `hooks.json` is loaded only after trust: the log prints `loaded 0 named hooks from 0 hooks.json file(s)` at start and `loaded 1 named hooks from 1 hooks.json file(s)` right after the accept. The same line appears when launched inside a git worktree whose `.git` is a file, so worktree hook discovery works.

### 17.2 Hook decisions (Q1, Q2)

| Hook output | Without skip-permissions | With `--dangerously-skip-permissions` |
|---|---|---|
| `{"decision":"allow"}` on `run_command echo …` | permission card still shown | runs, no card |
| `{"decision":"allow","permissionOverrides":["command(*)",…]}` | permission card still shown | runs, no card |
| `{"decision":"deny","reason":"probe deny: …"}` | **silent hard block, no card** | **silent hard block, no card** |
| same, on `invoke_subagent` | — | silent hard block (issue #640 is fixed in 1.1.23) |

The model sees the deny as tool output: `tool call denied by pre-tool hook: probe deny: blocked by itsybitsy policy`, and continues its turn. The permission card (no skip-permissions) reads:

```
Requesting permission for:
   echo hello-from-agy

Do you want to proceed?
> 1. Yes
  2. Yes, and always allow in this conversation for commands that start with 'echo'
  3. Yes, and always allow for commands that start with 'echo' (Persist to settings.json)
  4. No

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
esc to cancel
```

Conclusion: the never-prompt launch is `--dangerously-skip-permissions --mode=accept-edits` plus a deny-by-default PreToolUse hook. Under that launch, a hook `allow` on `view_file ../outside/secret.txt` read a file outside the workspace with no card, so the hook must do the path isolation for file tools as well as `run_command`.

### 17.3 Hook failure mode (Q3) — FAIL-CLOSED

| Hook behaviour | Result |
|---|---|
| exit 1 with non-JSON stdout | tool not run; model sees `JSON hook "jsonhook__itsybitsy-probe_PreToolUse_0_0" failed: command failed: exit status 1, stderr:` |
| `{}` (no `decision`) | tool not run; model sees `tool call denied by pre-tool hook:` (empty reason) |
| sleeps past `timeout` | tool not run; model sees `… failed: command failed: signal: killed, stderr:` |

This is the opposite of codex. The dispatcher still needs try/catch for clean logging, but a crash cannot open the gate.

### 17.4 Payloads (Q9, Q10)

Common fields on every event: `conversationId`, `workspacePaths` (the launch dir), `modelName` (the slug), `transcriptPath` = `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`, `artifactDirectoryPath` = `~/.gemini/antigravity-cli/brain/<conversationId>`. Nothing is written inside the worktree. The hook runs with cwd `<ws>/.agents`, the full user `PATH`, `TMUX`/`TMUX_PANE`, and `ANTIGRAVITY_CONVERSATION_ID=<uuid>` in its environment.

Tool argument names (`toolCall.args`, all tools also carry `toolAction` and `toolSummary`):

| Tool | Args | TUI line |
|---|---|---|
| `run_command` | `CommandLine`, `Cwd`, `WaitMsBeforeAsync` | `● Bash(echo hello-from-agy) (ctrl+o to expand)` |
| `view_file` | `AbsolutePath` | `● Read(<path>) (ctrl+o to expand)` |
| `list_dir` | `DirectoryPath` | `● ListDir(<path>)` |
| `write_to_file` | `TargetFile`, `CodeContent`, `Overwrite`, `Description` | `● Edit(<path>) (ctrl+o to expand)` |
| `replace_file_content` | `TargetFile`, `TargetContent`, `ReplacementContent`, `StartLine`, `EndLine`, `AllowMultiple`, `Instruction`, `Description` | `● Edit(<path>)` |
| `invoke_subagent` | `Subagents: [{Model, Prompt, Role, TypeName, Workspace}]` | `● Agent(self: Greeting Subagent)(<prompt>)` |
| `find_by_name` | not captured | `● Find(<summary>)` |

`PreInvocation`: `invocationNum` starts at 0 and counts within a turn; `initialNumSteps` grows over the conversation. `PostInvocation`: same fields. `Stop`: `terminationReason: "NO_TOOL_CALL"` (not `model_stop`), `error: ""`, `executionNum: 0`, `fullyIdle: true`. `Stop` output `{"decision":"continue","reason":"…"}` re-enters the loop and the reason is injected; agy stopped honouring it after about eight consecutive continuations (the documented cap), so a stuck continue cannot wedge an agent. The transcript is JSONL with `step_index`, `source` (`USER_EXPLICIT` / `MODEL`), `type` (`USER_INPUT` / `PLANNER_RESPONSE`), `status`, `created_at`, `content`, `tool_calls`; the last assistant message is the last `PLANNER_RESPONSE` line with `content`.

### 17.5 Rules and instructions (Q5, Q6)

| File | Loaded? |
|---|---|
| `<ws>/AGENTS.md` (repo root) | yes |
| `<parent of ws>/AGENTS.md` (outside the repo root) | no |
| `<main checkout>/AGENTS.md` when launched in that repo's git worktree | no — the walk-up stops at the worktree root |
| `<ws>/.agents/rules/x.md` without frontmatter | no |
| `<ws>/.agents/rules/x.md` with `trigger: always_on` frontmatter | yes, together with `AGENTS.md` |

Custom agents: `<ws>/.agents/agents/<name>/agent.md` and `<ws>/.agents/agents/<name>.md` were **not** discovered (`agy agents` empty; log `Agent "ittybitty" not found, falling back to default`). `~/.gemini/config/agents/<name>/agent.md` **is** discovered: the body became the system prompt, `tools:` scoping worked (the model reported it had no `invoke_subagent`; `manage_task` and `schedule` are always present), an agent without `tools:` had only read tools, and the status bar showed `accept-edits · ittybitty (Gemini 3.7 Flash · low)  /agents`. But a custom agent dropped the workspace `AGENTS.md` and rules even with `inheritCustomizations: true`. Decision: do not use `--agent`; ship the instructions as an always-on rule file and gate tools in the hook.

### 17.6 Resume (Q11)

`agy --conversation <uuid>` from the same directory restored the full transcript and reloaded the workspace hooks. The model was not carried over (the status bar showed the account default `Gemini 3.7 Flash · high`), so resume must re-pass `--model`.

### 17.7 Rendering (Q8)

- Default is the alternate screen (`tmux display #{alternate_on}` = 1, `history_size` = 0): the pane always shows the current agy screen and tmux keeps no scrollback.
- `altScreenMode: "never"` (global setting only) renders inline and tmux scrollback grows, but agy repaints the whole transcript on updates, so the scrollback contains duplicate stale frames.
- Setting `SSH_TTY`/`SSH_CONNECTION` to force inline mode is not usable: agy then shows a "You are currently not signed in" login screen (keyring path disabled).
- Chrome: a 5-line logo banner with account, model, and workspace path; `────` separator lines; the input line is `>` alone (placeholder `Accept-edits mode: file edits auto-approved (shift+tab to cycle)` on the first draw); bottom line `? for shortcuts` (idle) or `esc to cancel` (working) on the left and `accept-edits · Gemini 3.7 Flash · low` on the right. Working indicators: `⢿  Running command...`, `⣯  Generating...`, `⣻  Reading file...` followed by `└ Tip: …`. Thought line: `▸ Thought for 1s, 215 tokens`. A survey overlay `How's the CLI experience so far? Help us improve:  [1] Good  [2] Fine  [3] Bad  [0] Skip` appeared after some turns; `0` dismisses it (`showFeedbackSurvey: false` in the global settings would suppress it).

### 17.8 Model and effort

`--model gemini-3.7-flash-low` (slug) applied; the log first prints `failed to apply model override: … not recognized` before models are fetched, then `Propagating selected model override to backend: label="Gemini 3.7 Flash (Low)"`. `--mode` accepts only `accept-edits` or `plan`.

### 17.9 Initial prompt and the trust race (load-bearing)

`agy -i "<prompt>"` runs the prompt and then stays interactive. But in an **untrusted** directory the conversation is created and the first model call goes out about two seconds after launch, **before** the trust card is answered: the log shows `Created conversation` at +1.5 s, `prompt section "user_rules"` empty, and `loaded 1 named hooks` only at +10 s when Enter was pressed; the probe recorded **no** payloads for that conversation and the reply ignored the workspace rules. In a **pre-trusted** directory the order is `loaded 1 named hooks` at +30 ms, `Created conversation` at +900 ms, and the first turn's `run_command` was denied by the hook with both `AGENTS.md` and the always-on rule applied.

Consequence: itsybitsy must add the worktree's realpath to `trustedWorkspaces` in `~/.gemini/antigravity-cli/settings.json` **before** launching, and may remove it at teardown. The watchdog trust-card auto-accept is only a fallback for a resumed or hand-launched session; it must never be the primary path with `-i`, because that first turn would run with no hook.

### 17.10 Live spawn gate through `ib` (2026-09-02 02:17–02:25 CDT, Phase 2 merged at `288a577`)

Run with the branch binary first on PATH from a helper tmux shell: `ib new-agent --model agy:gemini-3.7-flash-low --type worker "…"`.

- The itsybitsy side worked end to end: worktree created, `.agents/hooks.json` + `.agents/rules/ittybitty-agent.md` written, `.gitignore` appended (the worktree shows `M .gitignore`, as with codex's `.codex/`), the worktree realpath added to `trustedWorkspaces` before `tmux new-session`, dispatcher prechecks passed, tmux session + watchdog started, `start.sh` launched the D2 line with `setsid=none` (macOS has no `setsid`). `ib retire <id> --force` through the same binary removed the trust entry again.
- Bug found: the `agy --version` stamping subprocess hung for 80 s because the spawn runner leaves the child's stdin pipe open and agy 1.1.23 blocks on an inherited unclosed stdin (its own release notes mention the fix on their side for a different path). Fix queued for Phase 3: probe with stdin ignored and a 5 s timeout; stamp `""` on failure.
- Environment blocker, not a code bug: after that, every `agy` exec on the machine — the agent, four probes with different launch shapes, and a bare `agy --version` — sat in `_dyld_start` with a 112 K footprint, no agy log, no sockets. `log show` for `syspolicyd`/kernel: `(AppleSystemPolicy) ASP: Security policy would not allow process: <pid>, /opt/homebrew/Caskroom/antigravity-cli/1.1.23,…/antigravity`, preceded by a 30 s QUIC connection to Apple with 0 bytes transferred. The binary still carries `com.apple.quarantine: 0381;…`. `codex` and `gh` exec normally. Remedy is on the user side (approve the binary once, or `xattr -d com.apple.quarantine` on it); the gate has to be rerun afterwards.

---

## Sources

[^1]: [Antigravity CLI Overview](https://antigravity.google/docs/cli/overview/)
[^2]: [Installation & Auth](https://antigravity.google/docs/cli/install/)
[^3]: [Permissions](https://antigravity.google/docs/cli/permissions/)
[^4]: [Settings, Rendering & Keybindings](https://antigravity.google/docs/cli/settings/)
[^5]: [Sandbox](https://antigravity.google/docs/cli/sandbox/)
[^6]: [Headless Mode](https://antigravity.google/docs/cli/headless/)
[^7]: [Choose an execution mode](https://antigravity.google/docs/cli/modes/)
[^8]: [Managing Conversations](https://antigravity.google/docs/cli/conversations/)
[^9]: [Resume Command](https://antigravity.google/docs/cli/commands/resume/)
[^10]: [Projects](https://antigravity.google/docs/cli/projects/)
[^11]: [Plugins & Skills](https://antigravity.google/docs/cli/plugins/)
[^12]: [Background Tasks & Subagents (CLI)](https://antigravity.google/docs/cli/subagents/)
[^13]: [Migrating from Gemini CLI](https://antigravity.google/docs/cli/gcli-migration/)
[^14]: [Model Quotas (/usage)](https://antigravity.google/docs/cli/commands/usage/)
[^15]: [Hooks (Antigravity 2.0 docs)](https://antigravity.google/docs/hooks/)
[^16]: [MCP](https://antigravity.google/docs/cli/mcp/)
[^17]: [Agents Command (/agents)](https://antigravity.google/docs/cli/commands/agents/)
[^18]: [Subagents (Antigravity 2.0 docs, agent.md frontmatter table)](https://antigravity.google/docs/subagents/)
[^19]: [Introducing Custom Agents (Antigravity blog)](https://antigravity.google/blog/introducing-custom-agents)
[^20]: [Antigravity custom agents explained (i-scoop, third party)](https://www.i-scoop.eu/antigravity-custom-agents-explained/)
[^21]: [Builtin hooks reference shipped with agy 1.1.23](/Users/adamwulf/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md)
[^22]: [Builtin customization guide shipped with agy 1.1.23](/Users/adamwulf/.gemini/antigravity-cli/builtin/skills/agy-customizations/SKILL.md)
[^23]: [Builtin rules reference shipped with agy 1.1.23](/Users/adamwulf/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/rules.md)
[^24]: [Builtin plugins reference shipped with agy 1.1.23](/Users/adamwulf/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/plugins.md)
[^25]: [Builtin JSON configs reference shipped with agy 1.1.23](/Users/adamwulf/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/json_configs.md)
[^26]: [Local agy settings after first run, 2026-09-01](/Users/adamwulf/.gemini/antigravity-cli/settings.json)
[^27]: [Local agy CLI log of the first run, 2026-09-01 17:39](/Users/adamwulf/.gemini/antigravity-cli/log/cli-20260901_173910.log)
[^28]: [Local workspace → conversation map](/Users/adamwulf/.gemini/antigravity-cli/cache/last_conversations.json)
[^30]: [agy 1.1.23 binary, string grep evidence (flags, `Do you trust the contents of this project?`, `Yes, I trust this folder`, decision enum, `AGENTS.md`/`GEMINI.md`, frontmatter keys)](/opt/homebrew/Caskroom/antigravity-cli/1.1.23,6260551186251776/antigravity)
[^31]: [antigravity-cli GitHub releases 1.1.14–1.1.23](https://github.com/google-antigravity/antigravity-cli/releases)
[^32]: [antigravity-cli CHANGELOG.md](https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/CHANGELOG.md)
[^33]: [Issue #548: --print ignores permissions.allow](https://github.com/google-antigravity/antigravity-cli/issues/548)
[^34]: [Issue #628: PreToolUse hook needs a hard-deny signal (1.1.2)](https://github.com/google-antigravity/antigravity-cli/issues/628)
[^35]: [Issue #640: PreToolUse block ignored for invoke_subagent (1.1.4)](https://github.com/google-antigravity/antigravity-cli/issues/640)
[^36]: [Issue #575: PreToolHookResult overwrite broken under request-review](https://github.com/google-antigravity/antigravity-cli/issues/575)
[^37]: [Issue #565: allow-listed commands still prompt](https://github.com/google-antigravity/antigravity-cli/issues/565)
[^38]: [Issue #893: hooks loaded but never executed under GEMINI_API_KEY (1.1.22)](https://github.com/google-antigravity/antigravity-cli/issues/893)
[^39]: [Issue #804: permission telemetry blindspots, matcher ergonomics](https://github.com/google-antigravity/antigravity-cli/issues/804)
[^40]: [Issue #809: no SessionStart hook; subagent tool events lack identity](https://github.com/google-antigravity/antigravity-cli/issues/809)
[^41]: [Issue #189: trusted workspace still prompts (macOS symlink)](https://github.com/google-antigravity/antigravity-cli/issues/189)
[^42]: [Issue #770: Stop hook loads but never executes on Linux (1.1.11)](https://github.com/google-antigravity/antigravity-cli/issues/770)
[^43]: [Issue #798: path-specific deny bypassed, Deny>Allow broken, --sandbox globs error (1.1.13)](https://github.com/google-antigravity/antigravity-cli/issues/798)
[^44]: [Issue #814: permissions config ignored (1.1.14)](https://github.com/google-antigravity/antigravity-cli/issues/814)
[^45]: [Issue #253: no workspace when launched from a git worktree (1.0.3, Windows)](https://github.com/google-antigravity/antigravity-cli/issues/253)
[^46]: [Issue #68: .git file in worktrees not detected (closed)](https://github.com/google-antigravity/antigravity-cli/issues/68)
[^47]: [Issue #241: no way to disable subagent spawning](https://github.com/google-antigravity/antigravity-cli/issues/241)
[^48]: [Issue #858: custom primary agent cannot invoke any subagent](https://github.com/google-antigravity/antigravity-cli/issues/858)
[^49]: [A user's agy settings.json (gist, third party)](https://gist.github.com/akunzai/dd0e6000065e8e1dfb22a7a3c844c9c3)
[^50]: [agy CLI cheat sheet (toolsbase, third party)](https://toolsbase.dev/en/reference/antigravity-cli-commands)
[^51]: [Operating agy programmatically (Hermes Agent skill page, third party)](https://hermes-agent.nousresearch.com/docs/user-guide/skills/optional/autonomous-ai-agents/autonomous-ai-agents-antigravity-cli)
[^52]: [Antigravity CLI: commands, modes, auto-approve (aibuilderclub, third party)](https://www.aibuilderclub.com/blog/antigravity-cli-guide)
[^53]: [Antigravity CLI hands-on guide (dev.to, third party)](https://dev.to/arindam_1729/antigravity-cli-a-hands-on-guide-to-googles-terminal-coding-agent-5bc7)
[^54]: [SPEC-CODEX-MODEL.md §2–§5 (decisions D1–D9, hook-as-boundary, never-prompt)](SPEC-CODEX-MODEL.md)
[^55]: [SPEC.md §18 Codex CLI as Alternative Agent Model](SPEC.md:2875-3106)
[^56]: [codex start/resume script builders](src/codex-spawn.ts:buildCodexStartContent)
[^57]: [codex launch-arg builder (add-dir roots, multi_agent=false, commit_attribution, log_dir)](src/codex-config.ts:buildCodexLaunchArgs)
[^58]: [codex PreToolUse handler](src/hooks/codex-pre-tool-use.ts:checkCodexPreToolUse)
[^59]: [codex Stop handler](src/hooks/codex-stop.ts:hookCodexStop)
[^60]: [claude-side path isolation decision logic](src/hooks/agent-path.ts:checkPathAccess)
[^61]: [model selector parser](src/agent-cli.ts:parseModel)
[^62]: [watchdog CLI gate](src/watchdog.ts:classifyAgentCli)
[^63]: [per-CLI tmux state parser dispatch](src/parse-state.ts:parseStateForCli)
[^64]: [docs/implementation-notes.md (hooks, codex integration, state detection, TUI capture, ib state)](docs/implementation-notes.md)
[^65]: [default allow floor](src/settings-builder.ts:REGULAR_AGENT_DEFAULT_ALLOW)
[^66]: [merged agent-type permission loader](src/hooks/shared.ts:loadMergedAgentTypePermissions)
[^67]: [codex AGENTS.md generator (CLAUDE.md import + skills catalogue)](src/codex-spawn.ts:buildCodexAgentsMd)
[^68]: [codex .gitignore appender](src/codex-spawn.ts:appendCodexGitignoreEntry)
[^69]: [watchdog permission-prompt auto-accept (Enter on trust / MCP cards)](src/watchdog.ts:runPerAgentWatchdog)
[^70]: [claude trust-prompt strings in the legacy state parser](src/parse-state.ts:parseClaudeState)
[^71]: [claude Task interception hook](src/hooks/intercept-task.ts)
[^72]: [effort mapping for codex](src/agent-cli.ts:mapEffortForCodex)
[^73]: [newAgent codex branch (git common dir as extra writable root)](src/ib-commands.ts:newAgent)
[^74]: [CLI Reference (slash commands, keybindings, tool confirmation keys)](https://antigravity.google/docs/cli/reference/)
[^75]: [Spike run by researcher agent `antigravity` on 2026-09-01: `agy --help`, `agy models`, tmux pane captures, and the probe-hook payload log; captures are reproduced verbatim in §17 because the scratchpad is session-local](/private/tmp/claude-501/-Users-adamwulf-Developer-bun-itsybitsy--ittybitty-agents-antigravity-repo/d1300c90-81ec-4127-8470-f6530a3e7a88/scratchpad/agy-spike/payloads.tsv)
