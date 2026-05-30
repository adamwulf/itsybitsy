# Codex CLI as an alternative agent model — working notes

> Scratch/handoff notes for the "add OpenAI Codex CLI as an optional model" feature.
> Captured 2026-05-30 mid-discussion (laptop closing for an appointment). Not the final SPEC — that's still to be written.
> Branch: `agent/codex-agent`.

## Goal (one line)

Let a user pick a **Codex model name** as an agent's `model`, and itsybitsy will launch the **`codex` CLI** (interactive, in tmux) for that agent instead of `claude` — with permissions controlled by hooks the same way Claude agents are, and **deny-by-default, never prompting**.

---

## Decisions made so far (authoritative — these are the user's instructions)

1. **Selector = the model name, not a separate `cli` field.**
   - Do NOT add a `cli: "codex"` field. Keep the single `model` string.
   - Use **Codex's own model names as the `model` value** (e.g. `gpt-5-codex`, `o3`, etc.). itsybitsy infers "this is a Codex model ⇒ use the codex CLI" from the model name.
   - ⇒ We need a **model → CLI resolver** (e.g. `resolveCli(model): "claude" | "codex"`) backed by a known/extensible set of Codex model names. Unknown/Claude model names ⇒ claude (default, unchanged).

2. **Headed / interactive in a tmux window — NOT headless.**
   - Do **not** use `codex exec` (headless) for the agent's main loop.
   - Launch the **interactive `codex` TUI inside tmux**, exactly like Claude is launched today (via the `start.sh` template that tmux runs).
   - This preserves the `C` key (open-in-Ghostty): attaching gives a live interactive codex session, same UX as Claude.
   - Launch form (interactive): `codex -m <model> -a never -s workspace-write [hook/config flags] "<prompt>"` running inside the tmux session. (`exec --json` may still be useful for *helper* one-shot calls, but NOT the agent loop.)

3. **Permissions: reuse the same agent-type permissions + hook structure; auto-deny everything not granted by a hook; never prompt.**
   - Reuse the existing agent-type `.md` permission lists (`_all.md`, `_non_coordinator.md`, `<type>.md`) — translate them into Codex hook rules.
   - Mechanism for "auto-deny unless a hook grants it, never prompt":
     - `-a never` / `approval_policy = "never"` ⇒ Codex never escalates to a human approval prompt; a blocked/failed action is returned to the model instead.
     - Our **PreToolUse hook** is the gatekeeper: returns `permissionDecision: "allow"` for allow-listed tools/commands, `"deny"` for everything else (deny-by-default).
   - Runs unattended in tmux most of the time → must never show an approval modal.

4. **Scope right now = SPEC ONLY.** Write a phased design doc (build step-by-step, verify along the way). No implementation yet.

### OPEN / to verify (do NOT assume in the SPEC — make it a Phase-1 verification step)
- In **interactive** mode with `-a never`, when the PreToolUse hook returns `deny`, does Codex **silently block + return to model** (desired), or does it still pop an interactive approval modal? Docs strongly imply no modal ("never ask for user approval; execution failures are immediately returned to the model"), but verify empirically before relying on it.

---

## Codex CLI facts (CONFIRMED against installed binary + official docs)

- **Version / install:** `codex-cli 0.135.0`, at `/opt/homebrew/bin/codex` (npm: `@openai/codex`, darwin-arm64). `CODEX_HOME = ~/.codex`. Config: `~/.codex/config.toml`. Auth: ChatGPT login stored in `~/.codex/auth.json` (no API key needed; `codex doctor` showed `stored ChatGPT tokens true`). State in `~/.codex/state_5.sqlite` etc.
- **Sub-models exist:** `-m, --model <MODEL>` selects the model (this is what makes decision #1 work — Codex model names become our `model` values). `codex doctor` → default provider `openai`, `model <default>`.

### Hooks (the key capability — near-1:1 with Claude Code)
Confirmed via the official doc `developers.openai.com/codex/hooks` AND the binary's embedded strings (Rust modules `hooks/src/events/pre_tool_use.rs`, `post_tool_use.rs`; types `HookRunSummary`, `HookOutputEntry`, `HookTrustStatus`; strings "Command blocked by PreToolUse hook:", "Tool call blocked by PreToolUse hook:", "hook returned decision:block without a non-empty reason").

- **Events:** `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`.
- **Declared in `~/.codex/config.toml`:**
  ```toml
  [[hooks.PreToolUse]]
  matcher = "^Bash$"            # regex on tool name; omit = match all
  [[hooks.PreToolUse.hooks]]
  type          = "command"     # only "command" supported
  command       = '/path/to/hook ...'
  timeout       = 30            # seconds (default 600)
  statusMessage = "Checking Bash command"   # optional UI label
  ```
- **Hook input (stdin JSON):** shared fields `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode` (`default|acceptEdits|plan|dontAsk|bypassPermissions`). Tool events add `tool_name` ("Bash", "apply_patch", or MCP id) and `tool_input` (Bash → `tool_input.command`). PostToolUse adds `tool_response`.
- **PreToolUse decision (stdout JSON)** — the exact Claude-equivalent allow/deny:
  ```json
  { "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Blocked by hook." } }
  ```
  - `"allow"` may include `"updatedInput": {"command": "…"}` to **rewrite** the command.
  - Or exit code 2 + reason on stderr to block. Exit 0 + `{ "continue": true, … }` otherwise.
  - `PermissionRequest` event returns `{ "decision": { "behavior": "allow"|"deny", "message": … } }`; **"any deny wins"** across multiple matching hooks.
- **Hook TRUST model (the one real difference vs Claude):** new/changed local command hooks won't run until trusted (hash-pinned; reviewed in-TUI via `/hooks`). For automation: top-level flag **`--dangerously-bypass-hook-trust`** (confirmed in `codex --help`). "Managed" hooks (requirements.toml / MDM `allow_managed_hooks_only`) are trusted-by-policy.
  - ⇒ Our spawn must either pre-trust the hook (preferred, once) or pass `--dangerously-bypass-hook-trust`.
- **Enforcement caveat (OpenAI's own doc):** PreToolUse is not an airtight boundary — the model may route around a blocked tool via another tool path. For hard guarantees, pair hooks with the **sandbox** + **execpolicy `.rules`**. (Same posture as Claude: sandbox = real boundary, hooks = policy/logging.)
- Legacy `notify` config still exists but is folded into hooks (`hooks/src/legacy_notify.rs`) — prefer `Stop`/`PostToolUse`.

### Approval & sandbox (defense in depth)
- **Approval `-a/--ask-for-approval`:** `untrusted` | `on-failure` (DEPRECATED) | `on-request` | **`never`** (never ask; failures returned to model — this is our setting).
- **Sandbox `-s/--sandbox`:** `read-only` | **`workspace-write`** | `danger-full-access` (OS-enforced: macOS Seatbelt / Linux Landlock+seccomp). Seatbelt profile syntax visible in binary (`(allow network-outbound...)`, `(deny file-read* (regex...))`).
- **execpolicy** engine: `.rules` files (allow/deny), runtime "execpolicy amendment" (persisted "always allow this command"). `--ignore-rules` skips them.
- `--full-auto` is REMOVED in 0.135.0 (errors → use `-s workspace-write`). No exposed `--yolo`.

### Per-agent isolation knobs (useful for spawning many codex agents)
- `-c key=value` — inline TOML config override (dotted path), e.g. `-c approval_policy="never"`, `-c model="o3"`.
- `-p, --profile <name>` — layer `$CODEX_HOME/<name>.config.toml` over base config.
- `-C, --cd <DIR>` working root; `--add-dir <DIR>` extra writable dirs.
- `--ignore-user-config` (don't load `$CODEX_HOME/config.toml`), `--ignore-rules`.
- `CODEX_HOME` env var relocates the whole config/state home (per-agent home is possible).

### Headless / other (NOT used for the agent loop per decision #2, but for reference)
- `codex exec [PROMPT]` (alias `e`): non-interactive. Flags: `-a`, `-s`, `-m`, `--json` (JSONL events), `--output-schema`, `-o/--output-last-message`, `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`. Sub: `codex exec resume`, `codex exec review`.
- `codex mcp` (manage external MCP servers), `codex mcp-server` (run Codex AS an MCP server, stdio), `codex review`, `codex apply` (git apply last diff), `codex resume`/`fork` (interactive session picker), `codex sandbox <cmd>`, `codex doctor`.

---

## itsybitsy seams to touch (file anchors — verify exact line #s when implementing)

> Gathered from a read-only exploration of the spawn/hook/state code. Lines are approximate and should be re-confirmed before editing.

1. **Spawn command construction** — `src/ib-commands.ts`, `newAgent()`. The `start.sh` template that tmux runs assembles the `claude ...` command (~lines 2991–3113). This is where a `codex` launch variant branches in. Also see `src/spawn.ts`.
2. **Resume command** — `src/ib-commands.ts` ~lines 490–680 (`claude --resume <id>` form). Needs a codex resume variant (`codex resume` model differs — see session-id note).
3. **Model precedence** — `src/ib-commands.ts` ~lines 2553–2566 resolves model from `--model` arg / agent-type frontmatter / config default. `src/config.ts` holds the `model` default. This is where `resolveCli(model)` slots in.
4. **AgentMeta type** — `src/agents.ts:49` (`export interface AgentMeta`). Has `model`, `agentType`, `agentIcon`, `worker`, `coordinator`, `session_id`, `created_epoch`, `spawned_by`, `nickname`, `watchdog_pid`, `claude_pid`, `state`, etc. `MetaState = "creating"|"running"|"waiting"|"complete"|"stopped"`. Writer: `writeMetaJsonAtomic` (agents.ts). `model` already exists ⇒ likely **no new field needed** (resolver reads `model`); MAY want a derived/cached `cli` or a `codex_session_id` field — TBD.
5. **Hook registration + permissions** — `src/settings-builder.ts` + `buildAgentSettings()` in `ib-commands.ts` (~2163–2267) write `settings.local.json` (`hooks` block referencing `ib hook-check-path <id>` etc. + `permissions.allow/deny` merged from agent-type `.md`). Written ~2881–2920. **Codex equivalent:** write `~/.codex/config.toml` (or a per-agent `CODEX_HOME`/profile) with `[[hooks.*]]` blocks + trust step, translating the same `.md` permission lists into PreToolUse allow/deny logic. NEW writer needed: `buildCodexConfig()` / `codex-settings-builder.ts`.
6. **Permission `.md` merge** — agent-type layer files merged: `_all.md` (every agent), `_non_coordinator.md` (non-coordinators), `<type>.md`. Source of truth to translate into codex hook rules. See `src/agent-types.ts`.
7. **Hook command dispatch** — `src/index.ts` routes `hook-check-path`, `hook-status`, `hooks intercept-task`, `hooks session-start`, etc. to `src/hooks/*.ts`. Codex hooks will likely reuse/parallel these (a codex-shaped PreToolUse handler that emits Codex's JSON contract instead of Claude's). NEW: `src/hooks/codex-pre-tool-use.ts` (or adapt existing to emit both shapes).
8. **State detection** — `detectAgentStates()` in `src/agents.ts` + `src/parse-state.ts` (priority order). **Claude-UI-specific** (greps Claude tmux strings). ⇒ **Biggest new piece:** codex-specific tmux parsing for running/waiting/complete/etc. Stop hook (`ib hook-status`) writes `state` to meta.json via `writeAgentState()` — codex needs an equivalent state-writing path (its `Stop` hook).
9. **Watchdog** — `src/watchdog.ts` (`runPerAgentWatchdog`). Claude-specific behaviors: rate-limit bypass via bare Enter, permission auto-accept, nudge messages — all assume Claude's tmux UI. ⇒ codex variant needed (different rate-limit/idle signatures; with `-a never` + hooks, permission auto-accept may be unnecessary).
10. **session_id** — Claude `--session-id <uuid>` generated in `newAgent`, stored in meta `session_id`, reused on resume. **Codex differs:** it has its own session/rollout id model (`codex resume <id>` / `--last`; rollouts in `~/.codex` sqlite). Spec must define how we capture/track the codex session id for resume + Ghostty attach.

### Cross-cutting checklist (per CLAUDE.md) — all four need codex treatment
- **General agent functionality:** new launch path, possibly meta fields, model resolver.
- **Hooks:** codex hook-config writer + codex PreToolUse handler emitting Codex's JSON; trust handling.
- **Watchdog:** codex state signatures, idle/rate-limit detection, whether bare-Enter nudges apply.
- **`ib watch` / dashboard:** state detection feeding the TUI; `C`/Ghostty attach to interactive codex; icon/model display.

---

## Proposed phased build (DRAFT — to be refined into the real SPEC)

- **Phase 0 — Model→CLI resolver + meta plumbing.** `resolveCli(model)`, known Codex model set, wire `model` through. No behavior change for Claude. Verify: claude agents unchanged; resolver unit-tested.
- **Phase 1 — Verify codex interactive + hook deny semantics (manual spike).** Confirm interactive `codex -a never` + a PreToolUse deny hook blocks silently (no modal), in tmux. Resolve the OPEN question above. Document the exact launch command + trust step.
- **Phase 2 — Codex config/hook writer.** `buildCodexConfig()` translating agent-type `.md` allow/deny into `[[hooks.PreToolUse]]` rules; deny-by-default; per-agent `CODEX_HOME`/profile or `-c` overrides; trust/bypass. Verify: generated config.toml is valid (`codex` loads it), denies non-allow-listed, allows allow-listed.
- **Phase 3 — Spawn path (headed, in tmux).** Branch `start.sh` assembly on `resolveCli(model)`: launch interactive `codex` with `-a never -s workspace-write` + hook config. Verify: agent appears in tmux, `C`/Ghostty attaches, does work, never prompts.
- **Phase 4 — State detection for codex.** Codex-specific tmux parsing (or `Stop`-hook-driven state writes) → running/waiting/complete/etc. Verify: dashboard shows correct states for a codex agent through a full task.
- **Phase 5 — Watchdog for codex.** Idle/nudge/rate-limit handling tuned to codex UI; drop Claude-only behaviors that don't apply. Verify: stuck codex agent gets nudged; rate-limit recovery works.
- **Phase 6 — Resume + lifecycle.** Codex session-id capture + `codex resume`; kill/merge/diff unaffected (git-level). Verify: resume re-attaches the same session.
- **Phase 7 — Docs/SPEC.md + tests + `bunx tsc --noEmit`.** Update SPEC.md, CLAUDE.md notes, add tests.

---

## Status / next step on resume
- This is **notes only**; no code changed. Next deliverable the user asked for: a **phased SPEC** for this feature (the draft phases above → formalize, re-confirm file:line anchors, write the OPEN-question verification into Phase 1).
- Re-confirm before writing SPEC: exact AgentMeta fields (`src/agents.ts:104`), `config.ts` model default, watchdog Claude-specific functions, and the interactive-deny-no-modal behavior.
- Two read-only research agents were spawned and closed during this session (no commits): codex research + seam mapping. Findings are captured above.
