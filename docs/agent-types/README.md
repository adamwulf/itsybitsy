# Agent Type Reference Templates

These `.md` files are **reference templates** — they are NOT loaded at runtime.

To customize an agent type, copy the desired file to `~/.itsybitsy/agent-types/`:

```sh
mkdir -p ~/.itsybitsy/agent-types
cp docs/agent-types/worker.md ~/.itsybitsy/agent-types/worker.md
```

Then edit the copy. itsybitsy loads agent types from `~/.itsybitsy/agent-types/` at runtime. User-defined files override the built-in defaults for `manager`, `worker`, and `coordinator`.

To create a new custom type, add a new `.md` file (e.g., `~/.itsybitsy/agent-types/researcher.md`) and use `--type researcher` when spawning agents.
