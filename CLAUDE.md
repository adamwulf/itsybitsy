---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- `bun <file>` instead of `node <file>` or `ts-node <file>`
- `bun test` instead of `jest` or `vitest`
- `bun build <file>` instead of `webpack` or `esbuild`
- `bun install` / `bun run <script>` / `bunx <package>` instead of npm/yarn/pnpm/npx equivalents
- Bun auto-loads `.env` — don't use dotenv

## APIs

- `Bun.serve()` for HTTP/WebSockets/HTTPS/routes (not `express`)
- `bun:sqlite` for SQLite (not `better-sqlite3`)
- `Bun.redis` for Redis (not `ioredis`)
- `Bun.sql` for Postgres (not `pg` / `postgres.js`)
- `WebSocket` is built-in (not `ws`)
- Prefer `Bun.file` over `node:fs` readFile/writeFile
- ``Bun.$`ls` `` instead of execa

For Bun API docs: `node_modules/bun-types/docs/**.mdx`.

## Testing

```ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()` (not vite). HTML files can import `.tsx`/`.jsx`/`.js` directly — Bun's bundler transpiles + bundles. `<link>` tags to stylesheets are bundled by Bun's CSS bundler.

```ts
import index from "./index.html"

Bun.serve({
  routes: { "/": index, "/api/users/:id": { GET: (req) => Response.json({ id: req.params.id }) } },
  development: { hmr: true, console: true },
})
```

Run with `bun --hot ./index.ts`.

## Building the `ib` binary

```sh
bun build --compile --minify --sourcemap index.ts --outfile ib
```

Produces a single `ib` binary with no runtime dependencies. Install to PATH (`sudo cp ib /usr/local/bin/ib`) or add the project dir to PATH. Hook commands like `ib hooks main-path` reference the binary by its installed name.

## Specifications

- **SPEC.md** is the authoritative behavioral spec. Read it before changing agent lifecycle, hooks, or orchestration behavior. It documents intentional divergences from the bash reference implementation.
- **SPEC-CODEX-MODEL.md** is the design source-of-truth for codex CLI support (`<cli>:<model>` selector, codex hook architecture, spawn/resume paths). SPEC.md §18 carries a summary.
- **docs/implementation-notes.md** is a field guide for finding code: what lives where, non-obvious wiring, and module-level pointers that complement the spec.

## Code Quality

After any code change, run both:
1. `bun test` — all tests must pass
2. `bunx tsc --noEmit` — zero TypeScript errors

## Cross-Cutting Review Checklist

Every change must be evaluated from these four perspectives before it's done. A change that looks local often has implications in one of these — explicitly confirm each, even if only to note "not affected":

1. **General agent functionality** — what an agent can do, how it's spawned, meta.json shape, lifecycle.
2. **Hooks** — agent-session hooks (agent-path, agent-status, permission-denied, intercept-task, session-start) or primary-Claude hooks (main-path, inject-status). New paths, tool categories, and agent metadata usually require hook updates.
3. **Watchdog** — state detection, nudge timing, rate-limit recovery, background monitoring.
4. **`ib watch` / dashboard** — what the TUI displays, modes, focus/input handling, layout.

## Manager / coordinator agent workflow

When a manager spawns sub-agents, the manager's job is to **review and integrate**, not re-implement:

- Work is correct → merge with `ib merge <id> --force`
- Work has fixable issues → send feedback with `ib send <id> "..."` and let the agent fix it
- Work is unsalvageable or no longer needed → retire with `ib retire <id> --force`

Trust the sub-agent's output, review it, and act accordingly. Never duplicate a sub-agent's work by re-implementing it directly.

## Codebase orientation

The interesting modules and their entry points:

| Area | Module(s) |
|---|---|
| Message-delivery queue | `src/outbox.ts`, `src/watchdog.ts` |
| State detection | `src/agents.ts` (`detectAgentStates`, `writeAgentState`), `src/parse-state.ts` (legacy) |
| Hooks | `src/hooks/` |
| Agent types | `src/agent-types.ts`, `docs/agent-types/*.md` (embedded) |
| Codex CLI | `src/codex-spawn.ts`, `src/codex-config.ts`, `src/hooks/codex-*.ts` |
| Mutations | `src/ib-commands.ts`, `src/agent-lifecycle.ts` |
| TUI | `src/tui/dashboard.ts`, `src/tui/split-pane.ts`, `src/tui/widths.ts`, `src/tmux-poller.ts` |
| Config | `src/config.ts` (user-wide; per-agent permissions live in agent-type `.md` files) |
| Validation | `src/validation.ts` (shell-injection allowlists) |
| Debug / orphans | `src/state-command.ts` (`ib state`, `ib state --cleanup`) |
| Ghostty integration | `src/ghostty.ts` |

For module-level detail see `docs/implementation-notes.md`. For behavioral spec see SPEC.md.
