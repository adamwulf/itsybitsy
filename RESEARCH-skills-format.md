# Research: Claude Code Skills/CLAUDE.md Format & itsybitsy Custom Prompts

## 1. Claude Code CLAUDE.md Format

### Locations & Scope

| Scope | Location | Purpose |
|-------|----------|---------|
| Managed policy | `/Library/Application Support/ClaudeCode/CLAUDE.md` (macOS) | Org-wide, cannot be excluded |
| Project | `./CLAUDE.md` or `./.claude/CLAUDE.md` | Team-shared via source control |
| User | `~/.claude/CLAUDE.md` | Personal, all projects |
| Subdirectory | `subdir/CLAUDE.md` | Loaded on-demand when Claude reads files there |

Files walk up the directory tree from cwd. More specific locations take precedence.

### YAML Front Matter Fields (CLAUDE.md)

CLAUDE.md files support **optional** YAML front matter between `---` markers:

```yaml
---
description: "What this file covers"
globs: "*.ts, *.tsx, *.html"
alwaysApply: false
---
```

However, based on the official docs, CLAUDE.md files are **plain markdown** — the front matter is not officially documented as a CLAUDE.md feature. The front matter seen in this repo's CLAUDE.md appears to be treated as context rather than enforced configuration.

### `.claude/rules/` Files

Rules files in `.claude/rules/` support one front matter field:

| Field | Description |
|-------|-------------|
| `paths` | Glob patterns for when the rule applies. Without it, the rule loads unconditionally. |

```yaml
---
paths:
  - "src/api/**/*.ts"
---
# API rules here...
```

### Imports

CLAUDE.md files can import other files with `@path/to/file` syntax. Relative paths resolve from the importing file. Max depth: 5 hops.

---

## 2. Claude Code Skills Format (SKILL.md)

Skills are `.md` files in `.claude/skills/<skill-name>/SKILL.md` with YAML front matter + markdown body. They replace the older `.claude/commands/` system (which still works).

### Locations

| Location | Scope |
|----------|-------|
| `~/.claude/skills/<name>/SKILL.md` | Personal, all projects |
| `.claude/skills/<name>/SKILL.md` | Project only |
| `<plugin>/skills/<name>/SKILL.md` | Where plugin is enabled |
| Enterprise managed settings | All users in org |

Skills can also include supporting files alongside SKILL.md (templates, examples, scripts).

### Frontmatter Reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Display name / slash command. Defaults to directory name. Lowercase, hyphens, max 64 chars. |
| `description` | Recommended | What the skill does. Used for auto-matching. Truncated at 250 chars in listings. |
| `argument-hint` | No | Hint shown during autocomplete, e.g. `[issue-number]`. |
| `disable-model-invocation` | No | `true` = only user can invoke (not auto-triggered). Default: `false`. |
| `user-invocable` | No | `false` = hidden from `/` menu, only Claude can invoke. Default: `true`. |
| `allowed-tools` | No | Tools Claude can use without permission when skill is active. |
| `model` | No | Model override when skill is active. |
| `effort` | No | Effort level override: `low`, `medium`, `high`, `max`. |
| `context` | No | `fork` = run in a forked subagent context. |
| `agent` | No | Which subagent type to use when `context: fork`. |
| `hooks` | No | Hooks scoped to this skill's lifecycle. |
| `paths` | No | Glob patterns limiting when skill auto-activates. |
| `shell` | No | `bash` (default) or `powershell` for inline shell commands. |

### String Substitutions

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when invoking |
| `$ARGUMENTS[N]` / `$N` | Specific argument by 0-based index |
| `${CLAUDE_SESSION_ID}` | Current session ID |
| `${CLAUDE_SKILL_DIR}` | Directory containing the SKILL.md |

### Dynamic Context Injection

`` !`<command>` `` syntax runs shell commands before skill content is sent to Claude. Output replaces the placeholder.

### Invocation Control

| Frontmatter | User can invoke | Claude can invoke |
|-------------|-----------------|-------------------|
| (default) | Yes | Yes |
| `disable-model-invocation: true` | Yes | No |
| `user-invocable: false` | No | Yes |

---

## 3. Claude Code Subagent Format (.claude/agents/*.md)

Subagents are Markdown files with YAML frontmatter, stored in `.claude/agents/`.

### Locations & Priority

| Priority | Location | Scope |
|----------|----------|-------|
| 1 (highest) | `--agents` CLI flag (JSON) | Current session |
| 2 | `.claude/agents/` | Project |
| 3 | `~/.claude/agents/` | Personal/all projects |
| 4 (lowest) | Plugin `agents/` | Where plugin enabled |

### Frontmatter Reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier, lowercase + hyphens |
| `description` | Yes | When Claude should delegate to this subagent |
| `tools` | No | Tools the subagent can use (inherits all if omitted) |
| `disallowedTools` | No | Tools to deny |
| `model` | No | `sonnet`, `opus`, `haiku`, full model ID, or `inherit` (default) |
| `permissionMode` | No | `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan` |
| `maxTurns` | No | Max agentic turns |
| `skills` | No | Skills to preload into subagent context |
| `mcpServers` | No | MCP servers available to subagent |
| `hooks` | No | Lifecycle hooks scoped to subagent |
| `memory` | No | Persistent memory scope: `user`, `project`, `local` |
| `background` | No | `true` to always run as background task |
| `effort` | No | Effort level: `low`, `medium`, `high`, `max` |
| `isolation` | No | `worktree` for isolated git worktree |
| `initialPrompt` | No | Auto-submitted first user turn when running as main agent |

The markdown body becomes the subagent's **system prompt**.

---

## 4. How itsybitsy Custom Prompts Work Today

### Prompt Files

itsybitsy reads from `.ittybitty/prompts/` in the repo root:

| File | Applied to |
|------|------------|
| `all.md` | All agents (prepended before role-specific) |
| `manager.md` | Manager agents only |
| `worker.md` | Worker agents only |

### Loading (`loadCustomPrompts()` in `src/ib-commands.ts:1215`)

```typescript
async function loadCustomPrompts(repoPath: string): Promise<{
  all: string; manager: string; worker: string;
}>
```

Reads each file from `{repoPath}/.ittybitty/prompts/`. If a file doesn't exist, its value is empty string. No front matter parsing — raw markdown content only.

### Injection into Agent Prompt (`newAgent()` at line ~1728)

Custom prompts are injected as prefixes to the user's prompt:

```
[completionInstructions]     ← worktree/completion instructions
[CUSTOM INSTRUCTIONS]        ← all.md content (if present)
[CUSTOM WORKER INSTRUCTIONS] ← worker.md or manager.md (if present)
[user's prompt]              ← the actual task prompt
```

This goes into `prompt.txt` which is passed to `claude --resume --prompt-file`.

### Session-Start Hook Injection (separate path)

The session-start hook (`src/hooks/session-start.ts`) injects role-specific instructions via Claude Code's `SessionStart` hook mechanism. This is **separate** from custom prompts — it provides the `<ittybitty>` block with commands, state management, and workflow instructions. It does NOT read from `.ittybitty/prompts/`.

### Two Separate Injection Paths

1. **prompt.txt** (via `newAgent()`): completionInstructions + customPrompts + user prompt → written to file, passed as `--prompt-file`
2. **SessionStart hook** (via `session-start.ts`): role-based instructions injected as `additionalContext` in the hook output → appears in the system reminder

---

## 5. Recommendations for Agent Type .md Files

Based on the Claude Code skills/subagent format and itsybitsy's needs, here's a recommended structure for agent type definition files:

### Proposed Format

```yaml
---
name: researcher
description: "Research agent that investigates codebases and reports findings"
roles:
  - worker
model: sonnet
tools:
  allow: Read, Grep, Glob, Bash(git log:*), Bash(git diff:*)
  deny: Write, Edit
maxTurns: 50
---

## Instructions

You are a research specialist. When given a research task:

1. Explore the codebase using read-only tools
2. Take detailed notes on what you find
3. Write a comprehensive report

## Constraints

- Do not modify any files
- Focus on understanding, not implementing
- Report findings with specific file:line references
```

### Recommended Front Matter Fields

| Field | Purpose | Maps to |
|-------|---------|---------|
| `name` | Agent type identifier | Directory name fallback |
| `description` | What this agent type does | Shown in agent listings |
| `roles` | Which roles can use this type: `manager`, `worker`, `coordinator`, `all` | Replaces `all.md`/`manager.md`/`worker.md` split |
| `model` | Default model for this type | `--model` flag override |
| `tools.allow` | Tool allowlist | Maps to Claude settings `permissions.allow` |
| `tools.deny` | Tool denylist | Maps to Claude settings `permissions.deny` |
| `maxTurns` | Safety limit on agent turns | Prevents runaway agents |
| `extends` | Inherit from another type definition | Composability |

### Markdown Body

The markdown body serves as the **system prompt / instructions** for the agent type. It replaces the current hardcoded instructions in `session-start.ts` and the raw markdown from `.ittybitty/prompts/`.

### Key Design Decisions

1. **YAML front matter + markdown body** — matches Claude Code's own format for skills and subagents, so it's familiar to users
2. **`roles` field** — replaces the current `all.md`/`manager.md`/`worker.md` split with a single file that declares which roles it applies to
3. **Tool restrictions in front matter** — currently itsybitsy sets tools via `config.json` permission lists; this moves them into the type definition
4. **Body replaces hardcoded prompts** — the markdown body would replace or augment the `generateManagerInstructions()`/`generateWorkerInstructions()` in `session-start.ts`
5. **Directory structure** — store in `.ittybitty/types/<name>.md` (or `.ittybitty/agent-types/<name>/TYPE.md` for types with supporting files)

### Migration Path

1. Keep `.ittybitty/prompts/` working as-is (backward compat)
2. Add `.ittybitty/types/` as new agent type definitions
3. Type definitions take precedence over prompts when both exist
4. `loadCustomPrompts()` checks for type definitions first, falls back to `prompts/`
5. Gradually move hardcoded instructions from `session-start.ts` into default type definitions that ship with itsybitsy
