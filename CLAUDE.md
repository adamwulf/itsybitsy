---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## itsybitsy Implementation Notes

Phases 1-3 are complete. 79 tests across 4 files. Key architecture decisions for Phase 4+:

### State detection flow
1. `watcher.ts` calls `detectAgentStates()` (in `agents.ts`) on every refresh
2. `detectAgentStates()` calls `captureTmuxOutput()` (in `tmux-poller.ts`) for each active agent, then feeds output through `parseState()` (in `parse-state.ts`)
3. Archived agents are always set to `stopped` without tmux capture
4. `parseState()` is pure string matching on ANSI-stripped tmux output — never call it on raw ANSI text

### SplitPane (src/tui/split-pane.ts)
pi-tui's `Box` is vertical-only. `SplitPane` renders two child components side-by-side by calling each child's `render(width)` independently, then merging lines: left is padded to exact width, separator char inserted, right is truncated. Left width is configurable.

### TmuxPoller (src/tmux-poller.ts)
- Polls only the SELECTED agent at ~1s via `setInterval`
- `setAgent(session)` switches target; triggers immediate poll
- Race condition guard: snapshots `targetSession` before async `Bun.spawn`, discards result if agent changed during await
- `captureTmuxOutput()` is a separate one-shot export used by `detectAgentStates()` in the watcher

### Agent data (src/agents.ts)
- `readAllAgents()` returns `{ agents, errors }` — always check errors
- `FlatAgent` type lives here (not in watcher.ts) since `flattenAgentTree()` produces it
- `detectAgentStates()` is the single source of truth for state detection — both CLI and watcher use it
- `buildAgentTree()` mutates `agent.children` in place; call it after state detection

### parse-state.ts priority order
Compacting (last 5) > Active running (last 5) > Tool waiting (last 15) > Rate limited (last 15) > Complete (last 15) > WAITING (last 15) > Other running (last 15) > Spinners (last 15) > Permission prompts (last 15) > Broader spinners (last 20) > Background tasks (last 15) > Race condition hook > Unknown

### Dashboard (src/tui/dashboard.ts)
- Agent tree: max 7 visible rows with scroll indicators
- Right pane mode is global state — persists across agent selection changes
- `a` toggles archived agents visibility
- `p`/`n` cycle pane modes (p=forward, n=backward); arrow keys mapped counterintuitively to match ib watch
