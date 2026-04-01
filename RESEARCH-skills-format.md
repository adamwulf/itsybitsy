# Research: Claude Code Skills Format and Agent Prompts System

## Executive Summary

Claude Code skills use YAML frontmatter to configure behavior and markdown content to define instructions. The itsybitsy system has a parallel custom prompts system for injecting role-specific instructions into spawned agents. Both systems can be unified using consistent YAML frontmatter + markdown body structures.

## Claude Code CLAUDE.md / Skills Front Matter Format

### Core Concept

Claude Code supports skill files (typically `SKILL.md` or `.claude/CLAUDE.md`) with YAML front matter between `---` markers, followed by markdown content. The front matter controls behavior, and the body contains instructions.

### Frontmatter Fields Reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | No | string | Display name for the skill. If omitted, uses directory name. Lowercase letters, numbers, and hyphens only (max 64 characters). Also becomes the slash command name. |
| `description` | Recommended | string | What the skill does and when to use it. Claude uses this to decide when to apply the skill. Front-load the key use case. Descriptions over 250 characters are truncated in skill listings. |
| `argument-hint` | No | string | Hint shown during autocomplete for expected arguments. Example: `[issue-number]` or `[filename] [format]`. |
| `disable-model-invocation` | No | boolean | Set to `true` to prevent Claude from automatically loading this skill. Use for workflows you want to trigger manually with `/name`. Default: `false`. |
| `user-invocable` | No | boolean | Set to `false` to hide from the `/` menu. Use for background knowledge users shouldn't invoke directly. Default: `true`. |
| `allowed-tools` | No | string | Tools Claude can use without asking permission when this skill is active. Comma-separated list: `Read, Grep, Glob`. |
| `model` | No | string | Model to use when this skill is active. Overrides session model. |
| `effort` | No | enum | Effort level when this skill is active: `low`, `medium`, `high`, `max` (Opus 4.6 only). Overrides session effort level. |
| `context` | No | enum | Set to `fork` to run in a forked subagent context. Skill becomes the prompt for an isolated agent. |
| `agent` | No | string | Which subagent type to use when `context: fork` is set. Options: `Explore`, `Plan`, `general-purpose`, or custom agent from `.claude/agents/`. |
| `hooks` | No | object | Hooks scoped to this skill's lifecycle. See hooks documentation for configuration format. |
| `paths` | No | string/array | Glob patterns that limit when this skill is activated. Comma-separated string or YAML list. Claude loads the skill only when working with matching files. |
| `shell` | No | enum | Shell to use for `` !`command` `` blocks: `bash` (default) or `powershell`. Requires `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` for PowerShell. |

### String Substitutions Available in Skill Content

Skills support dynamic variable substitution in the markdown body:

| Variable | Description |
|----------|-------------|
| `$ARGUMENTS` | All arguments passed when invoking the skill. If not present, appended as `ARGUMENTS: <value>`. |
| `$ARGUMENTS[N]` or `$N` | Access specific argument by 0-based index (e.g., `$0`, `$1`). |
| `${CLAUDE_SESSION_ID}` | Current session ID. Useful for logging and session-specific files. |
| `${CLAUDE_SKILL_DIR}` | Directory containing the skill's `SKILL.md` file. Use for referencing bundled scripts/files. |

### Example SKILL.md Structure

```yaml
---
name: explain-code
description: Explains code with visual diagrams and analogies. Use when explaining how code works, teaching about a codebase, or when the user asks "how does this work?"
allowed-tools: Read, Grep
---

When explaining code, always include:

1. **Start with an analogy**: Compare the code to something from everyday life
2. **Draw a diagram**: Use ASCII art to show the flow, structure, or relationships
3. **Walk through the code**: Explain step-by-step what happens
4. **Highlight a gotcha**: What's a common mistake or misconception?

Keep explanations conversational. For complex concepts, use multiple analogies.
```

### Key Behaviors

1. **Description as Trigger**: The description field is Claude's primary mechanism for deciding when to use a skill. Make descriptions include specific keywords users would naturally say.
2. **Automatic Loading**: By default, Claude automatically loads skills when their description matches the current context. Skills can be invoked manually with `/skill-name` regardless of `disable-model-invocation`.
3. **Full Skill on Invocation**: Only the description is kept in context; full skill content loads when invoked (either by Claude or user).
4. **Supporting Files**: Skills can include additional files in their directory. Reference them from `SKILL.md` so Claude knows when to load them.

## itsybitsy Custom Prompts System

### Current Implementation

The itsybitsy system has a parallel custom prompts mechanism located at `.ittybitty/prompts/` with three files:
- `all.md`: Applied to all agent types
- `manager.md`: Applied to manager agents only
- `worker.md`: Applied to worker agents only

### How It Works (src/ib-commands.ts, lines 1211-1237)

```typescript
async function loadCustomPrompts(repoPath: string): Promise<{
  all: string;
  manager: string;
  worker: string;
}> {
  const promptsDir = join(repoPath, ".ittybitty", "prompts");
  const result = { all: "", manager: "", worker: "" };

  for (const [key, filename] of [
    ["all", "all.md"],
    ["manager", "manager.md"],
    ["worker", "worker.md"],
  ] as const) {
    try {
      const file = Bun.file(join(promptsDir, filename));
      if (await file.exists()) {
        result[key] = await file.text();
      }
    } catch { /* ignore */ }
  }

  return result;
}
```

### Prompt Injection (src/ib-commands.ts, lines 1707-1744)

Custom prompts are injected into the agent's `prompt.txt` file in this order:

1. **Completion instructions** (optional, based on config)
   - "IMPORTANT: ..." instructions about how to complete the task
   - Includes optional PR creation instructions and exit instructions

2. **Custom all.md** (if exists)
   - Wrapped in `[CUSTOM INSTRUCTIONS]\n...\n\n`
   - Applied to all agents

3. **Role-specific custom prompts** (if exists)
   - Wrapped in `[CUSTOM MANAGER INSTRUCTIONS]\n...\n\n` or `[CUSTOM WORKER INSTRUCTIONS]\n...\n\n`
   - Applied only to matching agent type

4. **User prompt** (the actual task)
   - The prompt provided to `newAgent()`

Example composition:
```
${completionInstructions}${customAllPrompt}${customRolePrompt}${prompt}
```

## Recommendations for Agent Type .md Files Structure

### Option 1: Unified Frontmatter (Recommended)

Adopt Claude Code's YAML frontmatter + markdown body pattern for all agent type .md files:

```
---
name: manager-instructions
description: Base instructions and conventions for manager agents in this repo
applies-to: manager
version: "1.0.0"
---

# Manager Agent Instructions

Manager agents coordinate and review work from sub-agents. When spawning sub-agents:

1. Clearly define success criteria in your agent prompt
2. Review sub-agent work before merging
3. ...
```

**Advantages:**
- Consistent with Claude Code standards
- Enables version tracking
- Supports conditional application via metadata
- Allows future tooling to process and validate these files
- Frontmatter can include author, deprecation notices, or compatibility info

### Option 2: Markdown Comments

Use HTML comments in markdown to embed metadata:

```markdown
<!-- name: manager-instructions -->
<!-- applies-to: manager -->

# Manager Agent Instructions

...
```

**Advantages:**
- Simpler parsing
- More lightweight
- Still readable as markdown
- Backward compatible with existing tools

### Option 3: Plain Markdown + Sibling Config

Keep `all.md`, `manager.md`, `worker.md` as-is, but add a `.ittybitty/prompts/config.json`:

```json
{
  "all": {
    "file": "all.md",
    "description": "Base instructions for all agents",
    "version": "1.0.0"
  },
  "manager": {
    "file": "manager.md",
    "description": "Instructions specific to manager agents",
    "version": "1.0.0"
  }
}
```

**Advantages:**
- Minimal changes to existing system
- Config lives in structured format (JSON/YAML)
- Decoupled from markdown content
- Easy to add tooling

## Comparison to Claude Code Skills

| Aspect | Claude Code Skills | itsybitsy Prompts |
|--------|-------------------|-------------------|
| Storage | `.claude/skills/`, `.claude/commands/` | `.ittybitty/prompts/` |
| Metadata | YAML frontmatter | None (currently) |
| Application | Automatic (Claude decides) + manual (`/name`) | Injected by system at agent creation |
| Scope | Global or per-file patterns | Per-agent-type |
| Versioning | Not built-in | Not built-in |
| Content | Instructions for Claude + tasks | Instructions for Claude agents |

## Implementation Path

If adopting frontmatter for itsybitsy prompts:

1. **Phase 1**: Add optional YAML frontmatter parsing to `loadCustomPrompts()`
2. **Phase 2**: Rename files to match directory structure (`.ittybitty/prompts/all/INSTRUCTIONS.md`, etc.) to align with skills directory pattern
3. **Phase 3**: Add validation and metadata extraction (version, author, deprecation notices)
4. **Phase 4**: CLI commands to list and validate custom prompts with `ib prompts list` and `ib prompts validate`

## Sources

- [Extend Claude with skills - Claude Code Docs](https://code.claude.com/docs/en/skills)
- [Skill authoring best practices - Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [skills/skill-creator/SKILL.md at main · anthropics/skills](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md)
