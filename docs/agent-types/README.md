# Agent Type Definitions

These `.md` files are the canonical agent type definitions for itsybitsy's built-in types (`manager`, `worker`, `coordinator`). They are embedded in the itsybitsy binary at build time and auto-populated to `~/.itsybitsy/agent-types/` on first run.

## How it works

- On first run, itsybitsy creates `~/.itsybitsy/agent-types/` and writes the embedded templates to disk.
- At runtime, itsybitsy loads agent types from `~/.itsybitsy/agent-types/` — that directory is the sole source of truth.
- Editing these files in `docs/agent-types/` will only affect future binary builds. To change agent behavior for an existing install, edit the files in `~/.itsybitsy/agent-types/` directly.

## Customizing agent types

To modify a built-in type, edit the file in `~/.itsybitsy/agent-types/` directly:

```sh
$EDITOR ~/.itsybitsy/agent-types/worker.md
```

To create a custom type, add a new `.md` file (e.g., `~/.itsybitsy/agent-types/researcher.md`) and use `--type researcher` when spawning agents.

## Restoring defaults

To restore any missing built-in types without overwriting your customizations, run:

```sh
ib init-types
```

To fully reset to defaults, delete the directory and run `ib init-types`:

```sh
rm -rf ~/.itsybitsy/agent-types
ib init-types
```

## Inheriting from another type (`inherits:`)

A type can build on top of another by declaring `inherits: <parent-type>` in its frontmatter. The parent name is a filename (no `.md`) in the same `~/.itsybitsy/agent-types/` directory. The chain is resolved parent-first; scalar fields declared in the child **override** the parent, while `permissions.allow` and `permissions.deny` lists are **unioned** across the entire chain (deduplicated via `Set`). `allowedPaths` and `repos` **replace** (not merge) when the child declares them — merging a child's strict `allowedPaths: []` with a parent's permissive list would quietly widen access. The markdown body inherits from the nearest ancestor whose body is non-empty.

Example — `researcher.md` inheriting from `worker` and adding WebFetch/WebSearch:

```markdown
---
name: researcher
description: Specialized research worker
inherits: worker
icon: 🔍
permissions:
  allow:
    - WebFetch
    - WebSearch
---

## Research Notes

Use the web tools to investigate. Worker-level Bash and filesystem access
is inherited from `worker.md`.
```

Rules:

- **`name` and `spawnable` are never inherited.** The resolved `name` is always the filename (basename minus `.md`); `spawnable` is always read from the type file's own frontmatter. A type that wants to be non-spawnable must say so in its own file.
- **Layer files (`spawnable: false`) cannot use `inherits:`.** A layer inheriting another type's body would silently prepend that body to every spawned agent's prompt. Validation rejects this combination.
- **Cycles and missing parents are errors.** `A → B → A`, self-inheritance, or pointing `inherits:` at a file that doesn't exist all surface as errors at `ib watch` startup via `validateAllAgentTypes`.
- **Empty-string `inherits: ""` is treated as absent** (no parent). Matches the `model: ""` → inherit convention.

## Restricting a type to specific repos (`repos:`)

A type can declare a `repos:` list to restrict which registered repos it may be spawned in. The value must be a non-empty YAML list of strings — each entry matches either the repo's basename or its registered nickname (see `ib add-repo --nickname`).

Example — a type that can only run in `muse-ios` or `muse-mac`:

```markdown
---
name: muse-dev
description: Dev helper scoped to the muse repos
inherits: manager
repos: [muse-ios, muse-mac]
---

...
```

From any other repo, `ib new-agent --type muse-dev "task"` fails with an explicit error message before any worktree or tmux session is created — a rejection leaves no residue.

Rules:

- **`repos: []` (empty list) is rejected at validation.** An unspawnable type is almost always a YAML typo rather than an intentional setting, and failing loudly at `ib watch` startup beats silently disabling a type.
- **Bare-string `repos: muse-ios` is rejected.** Use `repos: [muse-ios]` or a multi-line list.
- **Case-sensitive** matching. Entries are trimmed of surrounding whitespace.
- Inheritable via `inherits:` — the child's `repos:` replaces the parent's list entirely. To undo a parent's restriction, either remove `inherits:` or use an intermediate parent without `repos`. There is no sentinel-string escape hatch in v1.
- The check runs after `loadAgentType` so inherited restrictions are honored, and before the coordinator idempotency check so a restricted `coordinator.md` fails loudly in the wrong repo rather than silently succeeding.

## Backward compatibility with older `ib` binaries

Older `ib` binaries that predate `inherits:` and `repos:` simply ignore unknown frontmatter keys — the child file is read standalone (missing any fields the parent would have contributed). The type still loads, just without the merged values. This is a graceful downgrade rather than a hard failure. If you rely on inheritance or repo restriction, make sure your installed `ib` binary is a build that supports them.
