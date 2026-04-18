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
