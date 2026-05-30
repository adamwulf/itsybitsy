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

---

## Phase 2 spike findings — 2026-05-30

> Spike performed by `agent-6e76ccd2` (worker) under `codex-agent` manager. All tests on `codex-cli 0.135.0`, macOS Darwin 25.3.0 (Mac OS 26.3.1), zsh inside tmux 3.6a. ChatGPT-account auth (no API key billing). Worktree: `/Users/adamwulf/Developer/bun/itsybitsy/.ittybitty/agents/agent-6e76ccd2/repo`.

### THE canonical launch line (Phase 2 verified, use exactly this shape)

This is the single authoritative shape itsybitsy should use to launch a codex agent with our custom PreToolUse hook. Every claim below is verified empirically (see Q1–Q4 sections for evidence). **If anything in the SPEC or implementation diverges from this line, follow this line — not the SPEC's older §3.3.**

```
codex \
  -m <MODEL> \
  -a never \
  -s workspace-write \
  --dangerously-bypass-hook-trust \
  -c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="<HOOK_CMD>",timeout=30}]}]' \
  "<prompt>"
```

**Slot-by-slot:**

| Slot | Value | Notes |
|---|---|---|
| `<MODEL>` | parsed model half of `codex:<model>` | Server-validated; under ChatGPT auth on this machine only `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review` work. `gpt-5-codex` returns HTTP 400 on ChatGPT plans. |
| `-a never` | fixed | "Never ask for user approval; execution failures are immediately returned to the model" — the load-bearing flag for D4. |
| `-s workspace-write` | fixed | OS-level sandbox boundary (macOS Seatbelt). Real boundary for `apply_patch` since hooks don't fire on it (open issue #16732). |
| `--dangerously-bypass-hook-trust` | always on | Hook trust is hash-pinned in codex. Our hook command changes hash on every spawn (agent-id is in the command line). Without this flag, every spawn would silently disable the hook. |
| `-c 'hooks.PreToolUse=[...]'` | **inline, NOT on-disk** | Registering the hook here (rather than in `<worktree>/.codex/config.toml`) bypasses codex's project-trust gate entirely. NO `~/.codex/config.toml` modification is needed; NO `<worktree>/.codex/config.toml` file needs to exist. (See Q2 below for why on-disk fails.) |
| `<HOOK_CMD>` | `ib hooks codex-pre-tool-use <agent-id>` (recommended) | Free-form shell command. Same architecture as Claude's hooks. The handler lives in `src/hooks/codex-pre-tool-use.ts`. Can alternatively be an absolute path to a small dispatch script in `<worktree>/.codex/hooks/pre-tool-use.sh` that calls `ib`. |
| `timeout=30` | seconds | codex's default is 600s. Tighten to 30 to match Claude's behavior; tune later if needed. |
| `matcher=".*"` | regex | Matches every tool name. We rely on the handler (not the matcher) to do allow/deny — same as Claude. If we ever want to restrict to Bash only, use `"^Bash$"`. |
| `"<prompt>"` | initial prompt | Positional, like `claude "<prompt>"`. Seeds the session. |
| `-C <worktree>` | OPTIONAL | If tmux is already cd'd into the worktree (which itsybitsy already does for Claude), `-C` is unnecessary. Add it only as belt-and-braces. |

**What the PreToolUse handler must emit (verified):**

| Decision | stdout | Exit code | Codex's behavior |
|---|---|---|---|
| **Deny** | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<why>"}}` | `0` | Silent block in TUI: `• PreToolUse hook (blocked) — feedback: <why>`. No modal. Deny reason returned to the model. |
| **Allow** | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":<echo of tool_input>}}` | `0` | Tool call proceeds normally. The `updatedInput` echo-back is REQUIRED; standalone `permissionDecision:"allow"` triggers the unsupported-decision path. |
| **Anything else** (crash, malformed JSON, no decision, missing field) | — | any | **FAIL-OPEN**: codex marks the hook failed and **proceeds with the tool call anyway**. Documented behavior at developers.openai.com/codex/hooks. The handler MUST never crash. |

**One-line summary:** `codex -m … -a never -s workspace-write --dangerously-bypass-hook-trust -c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="ib hooks codex-pre-tool-use <id>",timeout=30}]}]' "<prompt>"`. No on-disk `.codex/config.toml`. No `~/.codex` mutation. Deny-by-default in the handler. Echo-back-allow for matched commands. Try/catch wrapper to prevent fail-open.

---

### Question 1 — THE CRUX: silent-deny in interactive `-a never` mode?

**Verdict: YES — silent deny confirmed.**

When a PreToolUse hook returns `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}` while codex runs interactively with `-a never -s workspace-write`:

- **No modal, no prompt, no approval UI.** Just a one-line status entry in the TUI:
  ```
  • PreToolUse hook (blocked)
    feedback: spike: deny-all test
  ```
- The model received the deny feedback ("spike: deny-all test") as tool-output and gracefully reported back to the user: *"I couldn't run ls here because the workspace blocked the command with a pre-tool hook (deny-all test). If you want, I can still help interpret the directory contents..."*
- No human intervention required; the session continued autonomously after the deny.

**This validates the D4 guarantee in SPEC-CODEX-MODEL.md.** itsybitsy can safely run codex agents unattended in tmux with deny-by-default hook semantics.

**Evidence (tmux capture):**
```
› run ls in the current directory and tell me what you see

⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.

• I’m checking the current directory contents now so I can report exactly what’s there.

• PreToolUse hook (blocked)
  feedback: spike: deny-all test

• I couldn’t run ls here because the workspace blocked the command with a pre-tool hook (deny-all test). If you want, I can still help interpret the directory contents if you paste them, or try a
  different way to inspect the repo.
```

**Hook stdin payload captured (`.codex/hook.log`):**
```json
{
  "session_id": "019e7b21-cb7d-7f23-8674-11036ed141ef",
  "turn_id": "019e7b21-cbce-7d00-8e6d-1fa40d030352",
  "transcript_path": "/Users/adamwulf/.codex/sessions/2026/05/30/rollout-2026-05-30T18-04-32-019e7b21-cb7d-7f23-8674-11036ed141ef.jsonl",
  "cwd": "/Users/adamwulf/Developer/bun/itsybitsy/.ittybitty/agents/agent-6e76ccd2/repo",
  "hook_event_name": "PreToolUse",
  "model": "gpt-5.4-mini",
  "permission_mode": "bypassPermissions",
  "tool_name": "Bash",
  "tool_input": {"command": "ls"},
  "tool_use_id": "call_Qwjy8dya7IBgFSX8Ygj5sZ99"
}
```

Note: codex maps our `-a never -s workspace-write` combo to `permission_mode: "bypassPermissions"` in the hook payload — surprising, since "bypass" suggests no enforcement, yet our hook still gates. **Read this as a Codex-internal label, not a guarantee about which rules apply.** Treat the hook decision as authoritative.

### Question 2 — Does the worktree-local hook actually fire?

**Verdict: YES — but ONLY when registered via the `-c` inline override, NOT via on-disk `<worktree>/.codex/config.toml`.**

This is a load-bearing departure from SPEC §5.4 step 2. Details:

**What does NOT work:**
- Putting `[[hooks.PreToolUse]]` blocks in `<worktree>/.codex/config.toml` alone is silently ignored when the project is not trusted in `~/.codex/config.toml`. The hook does not fire; the `ls` command runs unhindered; no warning is emitted.
- Adding `-c 'projects."<abs-worktree-path>".trust_level="trusted"'` as a runtime override does NOT activate the project config — the project-config-walk's trust check runs against the on-disk `~/.codex/config.toml` BEFORE the `-c` override layer is applied. So inline trust overrides don't help.

**What DOES work:**
- Registering hooks ENTIRELY via inline `-c` overrides:
  ```
  -c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="<abs path to hook script>",timeout=30}]}]'
  ```
- No on-disk `.codex/config.toml` is required at all. No trust entry in `~/.codex/config.toml` is required. The hook fires reliably; the deny payload reaches the model; the call is blocked.
- This is the cleanest architecture for itsybitsy: **`~/.codex/config.toml` is never modified per-spawn.** Each agent gets its hook injected at launch time via `-c`.

**Implications for the SPEC:**
- §5.4 step 2 ("Writes `<worktree>/.codex/config.toml` containing... `[[hooks.PreToolUse]]`...") should be **replaced** with "passes the hook block as a `-c hooks.PreToolUse=...` inline override on the codex CLI". The worktree's `.codex/` dir can still hold the hook script file, but the config.toml is unnecessary.
- §5.4 step 4 ("Adds `[projects."<abs worktree path>"].trust_level = "trusted"` to `~/.codex/config.toml`") can be **deleted entirely**. No trust entry needed.
- §5.4 step 5 (gitignore `.codex/`) still applies because the hook script lives there.
- Risk #10 ("`~/.codex/config.toml` trust list grows per worktree") is **resolved** by this change — we never touch that file.

**Evidence:**
- Tried `<worktree>/.codex/config.toml` alone, NO trust entry: hook did NOT fire (no log, no sentinel; `ls` ran).
- Tried `<worktree>/.codex/config.toml` + `-c 'projects."$PWD".trust_level="trusted"'`: hook did NOT fire.
- Tried inline-only `-c 'hooks.PreToolUse=[...]'` with NO on-disk config and NO trust entry: hook DID fire (log + sentinel populated; deny shown in TUI; model received deny).

### Question 3 — Session-id capture for resume

**Verdict: Three ways to capture, each more reliable than the last.**

**Capture path (best → worst):**

1. **From the PreToolUse hook stdin JSON** (`session_id` field): captured the instant the first tool call fires. Best for `meta.codex_session_id` because the hook is something itsybitsy controls at every spawn.
2. **From codex's stdout on session exit**: codex prints `To continue this session, run codex resume <UUID>` as its last line. Parseable from `tail -1` of the tmux pane or session stdout.
3. **From the filesystem**: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO8601>-<UUID>.jsonl` where the first JSONL line is `{"type":"session_meta","payload":{"id":"<UUID>","cwd":"...","git":{...},...}}`.

**Rollout file path scheme:**
```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO8601-Z>-<UUID>.jsonl
```
Example: `~/.codex/sessions/2026/05/30/rollout-2026-05-30T18-04-32-019e7b21-cb7d-7f23-8674-11036ed141ef.jsonl`

**JSON shape (first line):**
```json
{
  "timestamp": "2026-05-30T22:59:36.303Z",
  "type": "session_meta",
  "payload": {
    "id": "<UUID>",
    "timestamp": "2026-05-30T22:59:36.222Z",
    "cwd": "/Users/adamwulf/.../repo",
    "originator": "codex-tui",
    "cli_version": "0.135.0",
    "source": "cli",
    "model_provider": "openai",
    "base_instructions": {"text": "<system prompt...>"},
    "git": {"commit_hash": "...", "branch": "...", "repository_url": "..."}
  }
}
```

**Recommendation for Phase 7 (resume):**
- Capture the session id via **method 1** (hook stdin) at the very first tool call. Write it to `meta.codex_session_id` from `src/hooks/codex-pre-tool-use.ts` if the field is empty.
- Fallback: parse codex's stdout on session exit (method 2) — useful if no tool call fires in a session.
- `codex resume <UUID>` re-attaches the session (subcommand form; not the `--resume` flag pattern claude uses).
- Note: rollout files live in `~/.codex/sessions/` regardless of where the agent's worktree is — they are NOT under the worktree. If we ever wanted them under the worktree, we'd need to redirect `CODEX_HOME`, which breaks auth (see "CODEX_HOME breaks auth" below).

### Question 4 — Exact working launch line

**Verdict: SPEC §3.3 is mostly correct, with three deltas.**

**Working line (confirmed end-to-end):**
```
codex \
  -m gpt-5.4-mini \
  -a never \
  -s workspace-write \
  --dangerously-bypass-hook-trust \
  -c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="<abs-path-to-hook-script>",timeout=30}]}]' \
  "<prompt>"
```

**Deltas vs SPEC §3.3:**

1. **`-C <worktree>` is OPTIONAL.** If you already cd'd to the worktree (or tmux was created with `-c <worktree>`), `-C` is unnecessary. Codex picks up cwd correctly. SPEC §3.3 should note this is optional, not mandatory.
2. **Model name validation matters.** SPEC §3 vaguely references "Codex model names" — but reality: under a **ChatGPT-plan account** only the models in `~/.codex/models_cache.json` are available. On this machine: `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review`. The originally-tried `gpt-5-codex` returns: *"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."* — and codex's `-m` is server-validated, so itsybitsy can't pre-check this client-side. SPEC should list the realistic ChatGPT-account model set with a note that the API/Plus tiers may have different sets.
3. **Hook registration moves from on-disk config → inline `-c`.** See Q2 above.

**Other observations:**
- The `--dangerously-bypass-hook-trust` warning prints ONCE on launch and AGAIN when the first hook fires (twice total in the TUI). Cosmetic but visible.
- `codex --help` v0.135.0 confirms all SPEC-required flags exist with the documented spelling: `-a/--ask-for-approval`, `-s/--sandbox`, `-m/--model`, `-C/--cd`, `-c/--config`, `--dangerously-bypass-hook-trust`. No deprecation warnings on the four-flag combination.
- `--ask-for-approval on-failure` is marked DEPRECATED in v0.135.0 help text — confirms SPEC §3.1's claim is current.

### Bonus findings (not in the original 4 questions, but SPEC-relevant)

**B1. `permissionDecision: "allow"` is only supported PAIRED with `updatedInput` (not standalone).**

The allow-test produced this error in the TUI:
```
• PreToolUse hook (failed)
  error: PreToolUse hook returned unsupported permissionDecision:allow
```

After re-reading the official doc at `developers.openai.com/codex/hooks` (verbatim):

> "To rewrite a supported tool call without blocking, return `permissionDecision: "allow"` with `updatedInput`"

> "`permissionDecision: "ask"`, legacy `decision: "approve"`, `continue: false`, `stopReason`, and `suppressOutput` are parsed but not supported yet. Codex **marks the hook run as failed, reports the error, and continues the tool call**." (emphasis added)

So:
- `permissionDecision: "allow"` ALONE (no `updatedInput`) is rejected by codex 0.135.0 (our error message confirms this).
- `permissionDecision: "allow"` PAIRED with `updatedInput: {...}` is the only documented "allow" form. It's intended for rewriting/sanitizing the tool input, not as a no-op allow.
- The doc does NOT document a "plain allow / no rewrite" form. There appears to be no first-class "explicit allow" path; the implicit allow path is "emit no decision, exit 0".
- Hook failures (including unsupported decisions) are **fail-open**: codex continues the tool call.

**Implications:**
- A buggy or crashing hook script results in **silent allow**, not silent deny — the OPPOSITE of fail-safe. This is documented behavior, not a bug. Production deployments must monitor hook-fail rate via PostToolUse, Stop, or external telemetry to detect when our hook stops gating.
- The codex hook contract is fundamentally weaker than Claude's: Claude has `exit 2 = hard block before permission rules` AND `permissionDecision: "deny" = soft block`. Codex only has the soft path; exit 2 is documented as deny-equivalent but a CRASH (exit code 1, segfault, malformed JSON) is allow-equivalent. We should always exit 0 + emit JSON, never let the hook process crash.
- The SETTINGS-HOOKS-RESEARCH.md §B3 doc claim that `allow` is a valid value alongside `deny` should be **refined**: it's valid ONLY when paired with `updatedInput`.

**Recommended `codex-pre-tool-use.ts` shape:**
- If command matches the deny list → emit `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`, exit 0.
- If command matches the allow list → emit either:
  - **Option A (preferred):** `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":<the original tool_input echoed back verbatim>}}`. This uses the documented allow path with a no-op rewrite — explicit, deterministic, doesn't rely on "no decision = proceed" inference.
  - **Option B (simpler but undocumented):** emit `{}` or `{"hookSpecificOutput":{"hookEventName":"PreToolUse"}}` — relies on codex defaulting to allow when no decision is returned. Empirically works but is not in the documented contract.
- If command matches neither (deny-by-default) → emit deny as above.
- **Never let the hook crash or emit malformed JSON** — codex will silently allow.
- Wrap all hook logic in a try/catch that emits a `deny` payload on exception. Failing closed is the only safe default.

**Verified empirically (third spike run):** a hook returning `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"ls"}}}` (echoing the original tool_input as updatedInput) ran cleanly — no "hook failed" error, `ls` executed normally, codex showed the standard `• Explored └ List ls` tool output. The documented allow-with-rewrite form works as advertised; the echo-back-original-input pattern is the right way to express explicit allow.

**B2. `CODEX_HOME` relocation breaks auth.**

Setting `CODEX_HOME=<per-agent-path>` causes codex to show the first-time ChatGPT login flow on every spawn, because `~/.codex/auth.json` is not present in the redirected home. This rules out per-agent CODEX_HOME as a way to isolate config/sessions/state unless we also seed `auth.json` into the per-agent home (read-copy or symlink).

**Implication:** the SPEC should NOT pivot to per-agent CODEX_HOME without addressing auth seeding. Sticking with the global `~/.codex/` + inline `-c` hook approach (no on-disk per-worktree config) is the right answer.

**B3. Mixed-auth warning.**

`codex doctor` reported:
```
⚠ auth         mixed auth signals: ChatGPT login plus API key env var; HTTP reachability uses API-key mode
```

This means the user has both `OPENAI_API_KEY` (or similar) set AND a ChatGPT login. Codex prefers the API key path for HTTP reachability. May affect which models are available — worth surfacing as a config-time check at spawn (`codex doctor` parse, or environment-variable detection). Out of scope for Phase 2 but a note for Phase 8.

**B4. Tool call telemetry visible in the TUI.**

When a hook denies, the TUI shows:
- `• PreToolUse hook (blocked)` with the `feedback: <reason>` line.
- The model's subsequent reasoning treats this as a tool error and may surface a user-readable explanation.

When a hook errors (e.g. unsupported decision), the TUI shows:
- `• PreToolUse hook (failed)` with the `error: <message>` line.
- Codex defaults to allowing the call after the error (see B1).

The string `"hook returned decision:block without a non-empty reason"` mentioned in CODEX-CLI-NOTES.md line 46 was NOT observed in this spike — likely only fires when a deny is returned without a reason. We always passed `permissionDecisionReason`.

**B5. `apply_patch` PreToolUse caveat NOT tested.**

This spike only triggered Bash tool calls (`ls`). The SPEC §3.2 caveat about `apply_patch` not firing PreToolUse hooks (openai/codex#16732) was not empirically verified. Recommend a separate micro-spike before Phase 3 that asks codex to edit a file and checks whether the hook fires.

### Spike scratch artifacts

Left in the worktree for codex-agent's inspection (gitignored / not committed):
- `<worktree>/.codex/hooks/pre-deny.sh` — deny-all PreToolUse hook script (proved Q1 silent-deny)
- `<worktree>/.codex/hooks/pre-allow.sh` — naive allow-all hook returning `permissionDecision:"allow"` standalone (produced the unsupported-decision error; fail-open behavior observed)
- `<worktree>/.codex/hooks/pre-allow-echo.sh` — documented allow form: `permissionDecision:"allow"` + `updatedInput:<echo of tool_input>` (verified working — no hook errors, tool ran)
- `<worktree>/.codex/hook.log` — captured stdin payloads from hook invocations
- `<worktree>/.codex/hook-fired.flag` — sentinel file from the last hook run
- `<worktree>/.codex/config.toml.disabled` — the on-disk config that didn't fire (renamed to prove inline-only works)
- `<worktree>/.codex-home/` — abandoned attempt at CODEX_HOME redirect (auth-flow trap)

The user explicitly directed **NOT** to modify `~/.codex/config.toml`. That directive was honored; no trust entry was added. The spike succeeded WITHOUT trust entries because the inline-`-c` hook-registration path doesn't require project trust.

### Recommended SPEC §3 patch (for codex-agent to review and apply)

Suggested diff in `SPEC-CODEX-MODEL.md`:

**1. Replace §3.3 launch line:**

```diff
 ### 3.3 Canonical codex launch line (target)

 ```
-codex -m <MODEL> -a never -s workspace-write \
-      -C <worktree> \
-      --dangerously-bypass-hook-trust \
-      "<prompt>"
+codex -m <MODEL> -a never -s workspace-write \
+      --dangerously-bypass-hook-trust \
+      -c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="<abs path>",timeout=30}]}]' \
+      "<prompt>"
 ```
 
-Where `<MODEL>` is the **model half** of the parsed `<cli>:<model>` (the `codex:` prefix is stripped). The per-worktree `<worktree>/.codex/config.toml` (written at spawn time) supplies the `[hooks]` block + any other config. `--dangerously-bypass-hook-trust` is **mandatory on every invocation** because the generated hook script's hash changes every spawn.
+Where `<MODEL>` is the **model half** of the parsed `<cli>:<model>` (the `codex:` prefix is stripped) and the inline `-c` override registers our PreToolUse hook entirely in-memory (no on-disk `.codex/config.toml` required — see Phase 2 spike findings in `CODEX-CLI-NOTES.md` for why the on-disk path is silently ignored without a trust entry). `--dangerously-bypass-hook-trust` is **mandatory on every invocation** because the inline hook command's hash changes every spawn.
+
+`-C <worktree>` is optional — codex picks up cwd if tmux was created in the worktree (which itsybitsy already does). Add it only as a defensive belt-and-braces.

-`~/.codex/config.toml` must have `[projects."<abs worktree path>"].trust_level = "trusted"` for the project layer to load. This is set once during the worktree setup.
+**No `~/.codex/config.toml` modification required.** Because we register the hook via inline `-c`, codex's project-config-walk and trust gate are bypassed entirely. This avoids unbounded growth of `~/.codex/config.toml`'s trust list and resolves Risk #10.
+
+**Model availability:** under a ChatGPT-plan account, only models listed in `~/.codex/models_cache.json` work. As of v0.135.0 + ChatGPT auth: `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review`. API-key billing may expose others. `gpt-5-codex` is NOT available on ChatGPT auth (returns HTTP 400). itsybitsy cannot pre-validate model availability client-side — invalid model surfaces as an HTTP 400 in the TUI after first prompt.
```

**2. Update §5.4 "Permissions → generated PreToolUse hook script":**

```diff
 At spawn (Phase 3), `buildCodexConfig()`:
 1. Reads the SAME merged allow/deny lists (`_all.md` + `_non_coordinator.md` + `<type>.md`).
-2. Writes `<worktree>/.codex/config.toml` containing:
-   - `model = "<parsed model half>"`
-   - `approval_policy = "never"`
-   - `sandbox_mode = "workspace-write"`
-   - `[[hooks.PreToolUse]]` registering a generated hook script under `<worktree>/.codex/hooks/pre-tool-use.sh` (or similar).
-   - Optionally additional `[[hooks.SessionStart]]` / `[[hooks.Stop]]` for state-detection (§5.6).
+2. Generates the inline `-c` payload for codex's CLI:
+   - `-c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="ib hooks codex-pre-tool-use <agentId>",timeout=30}]}]'`
+   - The `model`, `approval_policy`, and `sandbox_mode` are passed as CLI flags (`-m`, `-a`, `-s`), not via config.
+   - Optionally add inline `-c hooks.SessionStart=[...]` / `-c hooks.Stop=[...]` for state-detection (§5.6).
 3. Writes a generated `<worktree>/.codex/hooks/pre-tool-use.sh` script that reads the codex stdin JSON, matches `tool_name` + `tool_input.command` against the merged allow/deny lists, and prints the deny-by-default JSON contract.
    - Alternative: have the script call `ib hooks codex-pre-tool-use <agentId>` and put the matching logic in TypeScript (`src/hooks/codex-pre-tool-use.ts`) — preferred for consistency with the existing claude hooks. The script then is a one-liner.
-4. Adds `[projects."<abs worktree path>"].trust_level = "trusted"` to `~/.codex/config.toml` (once per worktree) so the project layer loads. **This is the one cross-worktree write** we make; required by the codex trust model.
-5. Adds `.codex/` to the worktree's `.gitignore` (no `.local`-style file exists in codex).
+4. **No `~/.codex/config.toml` modification needed** — inline `-c` overrides don't pass through the project-config trust gate. (Phase 2 spike confirmed.)
+5. Adds `.codex/hooks/` to the worktree's `.gitignore` (the hook script lives there; no config.toml is written).
 6. Writes a per-agent `<worktree>/AGENTS.md` containing the role/session-start instructions (replaces what `session-start.ts` injects for Claude).

 **Trust:** `--dangerously-bypass-hook-trust` is passed on **every** spawn (hash-pinned trust requires this; see §3.2).
```

**3. Update §5.5 with the no-`allow`-decision constraint:**

```diff
 New `src/hooks/codex-pre-tool-use.ts`, dispatched from `src/index.ts`:
 - Reads codex's stdin JSON (`tool_name`, `tool_input.command`, `cwd`, `session_id`, …).
 - Applies the same allow/deny matching used for Claude (reuse the matcher logic, not a fork of the rules — share with `intercept-task` / `agent-path` as a library function).
-- Emits codex's stdout contract: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny","permissionDecisionReason":…}}`. **Default = deny.**
+- Emits codex's stdout contract (verified against developers.openai.com/codex/hooks):
+  - **Deny** (any unmatched / explicit-deny command): `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`, exit 0.
+  - **Allow** (matched allow-list): emit `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":<echo of the original tool_input>}}`. The doc allows `permissionDecision:"allow"` ONLY paired with `updatedInput` (intended for rewriting the command). Standalone `allow` (no `updatedInput`) is rejected as "unsupported permissionDecision:allow" — codex marks the hook failed and continues the call (documented fail-open). Use a no-op rewrite (echo back original input) for explicit allows.
+  - **Default = deny.**
+  - Also write `meta.codex_session_id` from the stdin payload's `session_id` field on first hook firing (resume capture).
+- **Defense-in-depth caveat:** codex's hook failure mode is FAIL-OPEN per the docs: any crash, malformed JSON, unrecognized decision, or non-zero exit (other than `2`) results in the tool call PROCEEDING. This is the opposite of fail-safe. The handler must (a) wrap all logic in try/catch and emit a `deny` payload on exception, (b) never throw uncaught errors, (c) monitor hook-fail rate via PostToolUse or external logging.
 - Also covers path isolation (the codex analog of `agent-path`/`main-path`) so codex agents stay in their worktree. (Caveat: `.git`, `.codex`, `.agents` are already OS-enforced read-only under `workspace-write` per research §B5.)
```

**4. Update §7 risks:**

```diff
-10. **`~/.codex/config.toml` trust list grows per worktree.** Each spawn adds one `[projects."<abs>"].trust_level = "trusted"`. This is user-global state; cleanup on agent archive is worth considering (low priority).
+10. **RESOLVED (Phase 2 spike).** Inline `-c hooks.PreToolUse=...` registration bypasses the project-trust gate entirely. `~/.codex/config.toml` is never modified by itsybitsy. No per-worktree cleanup needed.
+11. **NEW (Phase 2 spike).** Codex's PreToolUse contract supports `permissionDecision: "allow"` ONLY paired with `updatedInput` (a tool-input rewrite). Standalone `allow` triggers the "unsupported decision" path, which is FAIL-OPEN per the documented behavior at developers.openai.com/codex/hooks: "Codex marks the hook run as failed, reports the error, and continues the tool call." Same fail-open behavior applies to crashes, malformed JSON, or any non-`2` non-zero exit. Our handler must (a) emit an echo-back allow (`updatedInput` = original `tool_input`) for allow-listed commands, (b) wrap all logic in try/catch and emit deny on exception, (c) monitor hook-fail rate via PostToolUse or external telemetry.
+12. **NEW (Phase 2 spike).** Under a ChatGPT-plan account, only the models in `~/.codex/models_cache.json` are reachable (currently `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review`). `gpt-5-codex` and other API-tier models return HTTP 400 *"not supported when using Codex with a ChatGPT account"*. itsybitsy cannot pre-validate this client-side; surface a clear error after first prompt if the model is rejected.
+13. **NEW (Phase 2 spike).** `CODEX_HOME` relocation breaks auth (no `auth.json` in the redirected home → first-time-login flow appears every spawn). Per-agent CODEX_HOME is NOT a usable isolation strategy without seeding `auth.json`. Stick with global `~/.codex/` + inline `-c` overrides.
```

---

**End of Phase 2 spike findings.** Manager (codex-agent) should review the recommended SPEC patch, then merge or send feedback.

---

### Phase 2 follow-up — apply_patch / sandbox boundary (2026-05-30)

Manager (codex-agent) requested a follow-up micro-spike to verify the `-s workspace-write` sandbox actually blocks file edits outside the worktree, since SPEC §3.2 took this on faith from the codex docs. Five tests run against codex-cli v0.135.0, ChatGPT-auth, `gpt-5.4-mini`.

**TL;DR — major findings, two of which flip SPEC assumptions:**

1. **PreToolUse hook DOES fire for `apply_patch` on v0.135.0.** openai/codex#16732 appears FIXED (or at least mitigated). This is the OPPOSITE of SPEC §3.2's load-bearing assumption. Our PreToolUse hook can gate file edits, not just Bash/MCP.
2. **The hook receives the FULL `tool_input.command` payload for apply_patch**, including the `*** Add File:` / `*** Update File:` / `*** Delete File:` directives with target paths. itsybitsy's codex hook handler can implement the SAME path-isolation pattern Claude's `agent-path` uses — parse paths from the patch body, deny when path is inside parent-repo or a sibling worktree, allow otherwise (matching Claude's existing semantics).
3. **`-s workspace-write` is NOT a hard boundary by itself.** Codex's default `writable_roots` on macOS includes `/private/tmp` (= `/tmp`) and `/private/var/folders/.../T` (`$TMPDIR`). A codex agent can write to /tmp through `apply_patch` WITHOUT the hook firing if the hook isn't registered. The hook is the primary boundary — sandbox is secondary defense.
4. **For paths in writable_roots but outside the worktree, the hook IS the only barrier.** Without our hook, an agent could write `/tmp/whatever` freely. With our hook (deny-all), writes are blocked even to `/tmp`.

### Test 1 — write inside the worktree (control)

**Setup (no hook, sandbox only):**
```
codex -m gpt-5.4-mini -a never -s workspace-write \
  "create a file called spike-inside.txt in the current directory with the content hello"
```

**Result: SUCCEEDED.**
- Codex called `apply_patch` with `*** Add File: spike-inside.txt\n+hello`.
- TUI showed: `• Added spike-inside.txt (+1 -0)  1 +hello`
- `ls -la spike-inside.txt` → file exists, 6 bytes.

### Test 2 — write to `/tmp` (outside worktree, in default writable_roots)

**Setup (no hook):**
```
codex -m gpt-5.4-mini -a never -s workspace-write \
  "create a file called /tmp/codex-sandbox-escape.txt with the content I escaped"
```

**Result: SUCCEEDED — ESCAPE.** This is the SPEC-altering finding.
- Codex wrote `/tmp/codex-sandbox-escape.txt` via apply_patch.
- TUI showed: `• Added /tmp/codex-sandbox-escape.txt (+1 -0)  1 +I escaped`
- `ls -la /tmp/codex-sandbox-escape.txt` → file exists, 10 bytes.

**Why it succeeded:** the rollout-file's system prompt explicitly lists writable roots:
```
The writable roots are /Users/adamwulf/.codex/memories,
  /Users/adamwulf/Developer/bun/itsybitsy/.ittybitty/agents/agent-6e76ccd2/repo,
  /private/tmp,
  /private/var/folders/n3/nm2j2qb55ss7ystx9_vps3lw0000gn/T
```

So `/private/tmp` (= `/tmp` via macOS symlink) AND the user's `~/.codex/memories` dir AND the per-user temp dir under `/private/var/folders/` are writable by default. **The `workspace-write` sandbox alone is NOT enough to keep a codex agent inside its worktree.**

### Test 3 — write to `~/Documents` (outside writable_roots, user-owned)

**Setup (no hook):**
```
codex -m gpt-5.4-mini -a never -s workspace-write \
  "create a file at ~/Documents/codex-sandbox-escape.txt with the content also escaped"
```

**Result: BLOCKED (model-level decline).**
- Codex refused without attempting the write. TUI verbatim:
  ```
  • I can't create files in ~/Documents from this sandbox. That path is outside the writable workspace.
  
    If you want, I can create the file in one of these writable locations instead:
    1. /private/tmp/codex-sandbox-escape.txt
    2. inside the repo
    3. /Users/adamwulf/.codex/memories/codex-sandbox-escape.txt
  ```
- `ls -la ~/Documents/codex-sandbox-escape.txt` → does not exist.

**Important nuance:** This is a MODEL-LEVEL decline, not a sandbox-level rejection. Codex's system prompt tells the model what the writable roots are, and the model self-restricts. An adversarial prompt that explicitly tells the model to ignore the writable_roots list might bypass this. Our hook is still essential — sandbox alone is not enough.

### Test 4 — write to `../../escape.txt` (parent dir, outside writable_roots)

**Setup (no hook):**
```
codex -m gpt-5.4-mini -a never -s workspace-write \
  "create a file at ../../escape.txt with the content parent escape"
```

**Result: BLOCKED (model-level decline).**
- Codex refused without attempting. TUI verbatim:
  ```
  • I can't create ../../escape.txt from the current workspace because that path resolves outside the writable area.
  ```
- `find` for `escape.txt` in the parent itsybitsy tree → nothing found.

**Same model-level decline pattern as Test 3.** Codex resolved the relative path and recognized it was outside writable_roots.

### Test 5 — PreToolUse fires for apply_patch + writable_roots /tmp escape blocked by hook

**Setup (deny-all hook re-enabled):**
```
codex -m gpt-5.4-mini -a never -s workspace-write --dangerously-bypass-hook-trust \
  -c 'hooks.PreToolUse=[{matcher=".*",hooks=[{type="command",command="<abs>/.codex/hooks/pre-deny.sh",timeout=30}]}]' \
  "create a file called /tmp/codex-sandbox-escape.txt with the content I escaped"
```

**Result: BLOCKED — both apply_patch and Bash-fallback denied by hook.**

TUI trace:
```
• I'm creating the requested file in /tmp with the exact content you provided
• PreToolUse hook (blocked)
  feedback: apply_patch sandbox test: deny-all
• apply_patch is blocked by the sandbox hook for this path, so I'm writing the file directly with a shell command and then checking the result.
• PreToolUse hook (blocked)
  feedback: apply_patch sandbox test: deny-all
• I couldn't create /tmp/codex-sandbox-escape.txt because the workspace is blocking file-write commands with a sandbox hook.
```

`ls -la /tmp/codex-sandbox-escape.txt` → does NOT exist. Hook successfully blocked.

**Hook log shows both tool calls fired the hook with full path visibility:**

```
===== PreToolUse fired at 1780183579 =====
{
  "tool_name": "apply_patch",
  "tool_input": {
    "command": "*** Begin Patch\n*** Add File: /private/tmp/codex-sandbox-escape.txt\n+I escaped\n*** End Patch\n"
  },
  "cwd": "/Users/adamwulf/Developer/bun/itsybitsy/.ittybitty/agents/agent-6e76ccd2/repo",
  ...
}

===== PreToolUse fired at 1780183581 =====
{
  "tool_name": "Bash",
  "tool_input": {
    "command": "printf '%s\n' 'I escaped' > /private/tmp/codex-sandbox-escape.txt && cat /private/tmp/codex-sandbox-escape.txt"
  },
  ...
}
```

**Key observations:**
- `apply_patch` fires PreToolUse with the FULL patch body in `tool_input.command`. Path is `/private/tmp/codex-sandbox-escape.txt` (already canonicalized).
- The patch body uses git-style markers: `*** Begin Patch` / `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** End Patch`. A handler can parse these directly to extract the affected paths.
- After apply_patch is denied, the model auto-falls-back to Bash. The hook catches that too. So a single PreToolUse handler protects both edit paths.
- `cwd` is the worktree, so handlers can compare against it without needing to resolve symlinks.

### Conclusion

**The codex hook is a stronger boundary than the SPEC originally assumed.** The hook fires for both `apply_patch` AND Bash with full path information, so itsybitsy can port Claude's `agent-path` path-isolation logic essentially verbatim:

- **Parse paths from `tool_input.command`** — for `apply_patch`, grep for `*** Add File:`, `*** Update File:`, `*** Delete File:` and extract paths; for `Bash`, do the existing shell-command path detection.
- **Apply Claude's existing allow/deny semantics** — deny if path is inside parent repo or a sibling worktree, allow otherwise (so writes to `/tmp`, `~/Documents`, etc. are fine, but writes to the main itsybitsy repo or another agent's worktree are blocked).
- **Don't rely on `-s workspace-write` alone.** It allows `/tmp` + `$TMPDIR` + `~/.codex/memories` by default. These are usually fine but require positive consent from the hook layer if we want to gate them.

The SPEC §3.1 claim ("OS enforcement: macOS Seatbelt") and §3.2 claim ("Sandbox is the real boundary; hooks are policy + logging") are misleading on v0.135.0. The hook IS the real boundary for apply_patch — and that's good news for itsybitsy because Claude's path-isolation pattern translates directly.

### Implications for SPEC §3.1 and §3.2

**§3.1 ("What works as we hoped") — update:**
> "**PreToolUse fires for apply_patch on v0.135.0.** Earlier docs (openai/codex#16732) suggested apply_patch was exempt; empirical verification in the Phase 2 follow-up shows the hook fires with full `tool_input.command` containing the patch body (Add/Update/Delete File directives). itsybitsy can gate file edits via the same hook handler that gates Bash, with no separate enforcement path needed."

**§3.2 ("Real gaps we must work around") — REMOVE or refine:**
> "~~**`apply_patch` does NOT fire PreToolUse hooks** (open issue openai/codex#16732). [research §B3] ⇒ Hooks gate Bash but not file edits. The OS **sandbox** (`-s workspace-write`) is the real boundary for file edits.~~ **REVISED (Phase 2 follow-up):** apply_patch DOES fire PreToolUse on v0.135.0. The hook receives the patch body with full paths. issue #16732 appears resolved or never affected the path itsybitsy uses. Sandbox `-s workspace-write` is secondary defense; the hook is primary."

**§3.2 (sandbox boundary) — add:**
> "**`workspace-write` permits writes to `/tmp`, `$TMPDIR`, and `~/.codex/memories` by default.** These are part of codex's default `writable_roots` along with cwd. If itsybitsy wants to restrict writes to the worktree only, the hook MUST be the enforcement layer — the sandbox alone allows writes to these paths."

**§5.5 — restore the path-isolation responsibility on the codex hook:**
> "Also covers path isolation (the codex analog of `agent-path`/`main-path`) so codex agents stay in their worktree. **Path extraction is feasible for both apply_patch (parse `*** Add/Update/Delete File:` directives) and Bash (existing shell-command path detection in `agent-path.ts`).** Reuse Claude's path-isolation matcher; the only difference is the apply_patch parsing helper. (Caveat: `.git`, `.codex`, `.agents` are already OS-enforced read-only under `workspace-write` per research §B5; the hook adds the broader worktree boundary on top.)"

### Spike artifacts (re-created for this round; will be deleted before commit)

- `<worktree>/.codex/hooks/pre-deny.sh` — deny-all PreToolUse hook
- `<worktree>/.codex/hook.log` — Test 1 + Test 5 captured hook payloads
- `<worktree>/.codex/hook-fired.flag` — sentinel
- `<worktree>/spike-inside.txt` — Test 1 result file (will rm)
- `/tmp/codex-sandbox-escape.txt` — Test 2 escape file (will rm)
