# Claude Code Skills Format Research

## Overview

Claude Code has two generations of extensibility files: **commands** (older, user-invoked only) and **skills** (newer, supports both user and model invocation). Both use Markdown files with YAML frontmatter. Skills live in `.claude/skills/<name>/SKILL.md`; commands live in `.claude/commands/<name>.md`.

Some skills are **built-in** to Claude Code (e.g., `loop`, `simplify`, `update-config`, `claude-api`, `schedule`, `commit`) and have no on-disk `.md` file — they're compiled into the binary. Others are **user-defined** (in `.claude/skills/`) or come from **plugins** (in `.claude/plugins/`).

---

## Skill File Structure

```
.claude/skills/
└── my-skill/
    ├── SKILL.md           # Main skill definition (required, must be named SKILL.md)
    ├── references/        # Optional reference materials
    │   └── patterns.md
    ├── examples/          # Optional examples
    │   └── sample.md
    └── scripts/           # Optional helper scripts
        └── helper.sh
```

The filename **must** be `SKILL.md` (case-sensitive). The directory name becomes part of the skill's identity.

---

## Frontmatter Fields

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Skill identifier. Used in `/name` invocation and in system-reminder listings. |
| `description` | string | When/why Claude should use this skill. This is the **trigger condition** — Claude reads it to decide whether to auto-invoke. Also shown in skill listings. |

### Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowed-tools` | string or list | all tools | Restricts which tools are available when the skill is active. Can be a comma-separated string (`"Read, Grep, Glob"`) or a YAML list. Supports glob patterns for Bash: `Bash(git add:*)`. |
| `disable-model-invocation` | boolean | `false` | If `true`, only the user can invoke via `/name`. Claude cannot auto-invoke. Use for skills with side effects (deploy, send, mutate). |
| `user-invocable` | boolean | `true` | If `false`, only Claude can invoke (background knowledge). User cannot trigger via `/name`. |
| `argument-hint` | string | none | Hint shown to the user for what arguments the skill accepts (e.g., `<agent-id>`, `<url> [-w width]`). |
| `context` | string | none | Set to `"fork"` to run the skill in an isolated subagent. |
| `agent` | string | none | Which agent type to use when `context: fork` (e.g., `"Explore"`). |
| `version` | string | none | Semantic version (e.g., `"1.0.0"`). |
| `license` | string | none | License info or reference. |

### Invocation Control Matrix

| Setting | User can invoke | Claude can invoke | Use case |
|---------|:-:|:-:|-----------|
| *(defaults)* | Yes | Yes | General-purpose skills |
| `disable-model-invocation: true` | Yes | No | Side effects (deploy, send, DB mutations) |
| `user-invocable: false` | No | Yes | Background knowledge, conventions |

---

## Prompt Body

Everything below the `---` closing the frontmatter is the **prompt body**. It is injected into the conversation as a system message when the skill is invoked.

### `$ARGUMENTS` Placeholder

If the body contains `$ARGUMENTS`, it is replaced with whatever the user typed after the skill name:
- `/deploy staging` → `$ARGUMENTS` = `"staging"`
- `/websnap http://localhost:3000 -w 1920` → `$ARGUMENTS` = `"http://localhost:3000 -w 1920"`

If `$ARGUMENTS` is **not** present in the body, arguments are appended as `ARGUMENTS: <value>` at the end.

### Dynamic Context Injection (`!` backtick)

Shell commands wrapped in `` !`command` `` are executed **before** the prompt is shown to Claude, and their stdout replaces the placeholder:

```markdown
## Current State
- Branch: !`git branch --show-current`
- Status: !`git status --short`
```

This runs the commands at invocation time and injects live output into the prompt.

### Relative File References

Skills can reference supporting files with relative markdown links:
```markdown
Use the template in [openapi-template.yaml](openapi-template.yaml) as the structure.
Reference these examples: [examples/unit-test.ts](examples/unit-test.ts)
Review against [checklist.md](checklist.md).
```

Claude reads these files when it encounters the links.

---

## Commands (Legacy Format)

Commands live in `.claude/commands/<name>.md`. They use the same frontmatter mechanism but are always user-invoked (no model invocation). Commands predate skills.

### Command Frontmatter

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | What the command does |
| `allowed_tools` | list | Note: uses **underscore** (`allowed_tools`), not hyphen |

Commands do **not** have `name`, `disable-model-invocation`, `user-invocable`, `context`, or `agent` fields.

---

## Where Skills Can Be Defined

1. **User global**: `~/.claude/skills/<name>/SKILL.md` — available in all projects
2. **Project**: `.claude/skills/<name>/SKILL.md` — checked into repo, available to all users
3. **Plugin**: `~/.claude/plugins/.../skills/<name>/SKILL.md` — installed via plugin system
4. **Built-in**: Compiled into Claude Code binary (no file on disk)

Plugin skills can use a namespaced invocation: `/plugin-name:skill-name`.

---

## How Skills Appear in Conversation

Skills are listed in `<system-reminder>` blocks at the start of conversations:

```
The following skills are available for use with the Skill tool:
- review-cycle: Iterative review cycle: commit work, spawn 2 independent reviewer agents...
- websnap: Take a stateless screenshot of any web page...
```

Claude uses the `Skill` tool to invoke them: `Skill(skill: "review-cycle")` or `Skill(skill: "websnap", args: "http://localhost:3000")`.

---

## Real-World Frontmatter Examples

### Minimal (just name + description)
```yaml
---
name: citation
description: "Write, verify, and fix citations in research-to-summary workflows."
---
```

### With tool restrictions
```yaml
---
name: ib-merge
description: Review and merge an ittybitty agent's work...
argument-hint: <agent-id>
allowed-tools: [Bash, Read, Grep, Glob]
---
```

### With tool glob patterns
```yaml
---
name: access
description: Manage Discord channel access...
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---
```

### Fork context
```yaml
---
name: pr-check
description: Review PR against project checklist
disable-model-invocation: true
context: fork
---
```

### Background knowledge only
```yaml
---
name: project-conventions
description: Code style and patterns for this project. Apply when writing or reviewing code.
user-invocable: false
---
```
