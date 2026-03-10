# Security Review: itsybitsy

**Date:** 2026-03-10
**Reviewer:** Claude Opus 4.6 (automated security audit)
**Scope:** All files in `src/`, `src/hooks/`, `src/tui/`

---

## Executive Summary

The itsybitsy codebase demonstrates a generally security-conscious design. Process spawning consistently uses argument arrays (not shell strings) via `Bun.spawn`, and a `validation.ts` module provides strict character allowlists for shell-interpolated values. However, several findings warrant attention, primarily around **tmux `send-keys` injection**, **shell script interpolation in generated bash scripts**, and **inconsistent validation** of values read from `meta.json` files.

### Severity Distribution

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 5 |
| Low | 4 |
| Informational | 5 |

---

## Findings

### HIGH-1: tmux send-keys message injection

**Severity:** High
**Files:** `src/ib-commands.ts:1057-1058`, `src/hooks/agent-status.ts:356-358`, `src/hooks/agent-status.ts:369-376`

**Description:** The `sendMessage()` function sends user-provided messages via `tmux send-keys -l`. While the `-l` (literal) flag disables tmux key-name interpretation (so `Enter` won't be interpreted as a keypress), the message is still delivered to Claude Code's stdin as raw text. A malicious agent could craft messages containing Claude Code slash commands (e.g., `/compact`, `/exit`), tool invocations, or manipulative prompts that the receiving Claude instance would process as user input.

In `agent-status.ts`, the stop hook sends nudge messages **without** the `-l` flag (lines 356-358, 369-376), meaning tmux key names within the message content would be interpreted. The `result.message` is internally generated (not user-controlled), but `managerSession` is read from `meta.json` without validation.

**Impact:** An agent that controls its own `meta.json` could:
- Craft a message to another agent that injects commands
- The stop hook sends to `managerSession` read from disk without `isValidTmuxSession()` check

**Recommended Fix:**
1. Always use `-l` flag with `tmux send-keys` when sending variable content
2. Validate `tmuxSession` and `managerSession` with `isValidTmuxSession()` in `agent-status.ts` before passing to `Bun.spawn`
3. Consider sanitizing or length-limiting messages sent between agents

---

### HIGH-2: Shell script interpolation of untrusted values in start.sh / resume.sh

**Severity:** High
**Files:** `src/ib-commands.ts:1669-1692` (start.sh), `src/ib-commands.ts:379-402` (resume.sh)

**Description:** The `newAgent()` and `resumeAgent()` functions generate bash scripts (`start.sh`, `resume.sh`) that interpolate several values directly into shell code:

```bash
export PATH="${rootRepoPath}:$PATH"
claude --session-id "${sessionUuid}" ${claudeArgs} "$(cat '${absPromptFile}')" &
sed -i '' "s/}$/,\\n  \\"claude_pid\\": \\"$CLAUDE_PID\\"\\n}/" "${agentDir}/meta.json"
```

While `sessionUuid` is generated via `crypto.randomUUID()` (safe), `claudeArgs` is built from validated `model`, `allowTools`, and `denyTools` values. However, `rootRepoPath`, `agentDir`, and `absPromptFile` are filesystem paths that could theoretically contain shell metacharacters (spaces, quotes, `$`, backticks) if the repository is in a directory with unusual naming.

**Specific concern:** `${claudeArgs}` is concatenated as an unquoted string in the bash script. The individual components are validated, but the concatenated result is written directly into the script without quoting each argument separately.

**Impact:** If a repository path contains shell metacharacters (e.g., spaces, backticks, `$`), the generated scripts could execute unintended commands.

**Recommended Fix:**
1. Quote all path interpolations in generated scripts with proper escaping
2. Consider using `Bun.spawn` arrays directly instead of generating intermediate shell scripts
3. Validate that `rootRepoPath` doesn't contain shell metacharacters, or properly escape it

---

### MEDIUM-1: Missing tmux session validation in hooks and lifecycle functions

**Severity:** Medium
**Files:** `src/hooks/agent-status.ts:347,366`, `src/agent-lifecycle.ts:108,184`, `src/auto-compact.ts:155`, `src/watchdog.ts:209,315`

**Description:** `isValidTmuxSession()` is only called in `resumeAgent()` (ib-commands.ts:340). Everywhere else, tmux session names read from `meta.json` are passed directly to `Bun.spawn` arguments without validation. While `Bun.spawn` uses argument arrays (not shell strings), tmux itself could behave unexpectedly with crafted session names containing certain characters.

The tmux session names are constructed as `ittybitty-{repoId}-{agentId}` in `newAgent()`, where both components are validated. However, values read from existing `meta.json` files on disk could have been tampered with.

**Impact:** A tampered `meta.json` with a malicious `tmux_session` value could cause unexpected behavior when passed to tmux commands. Since `Bun.spawn` uses arrays, this is not a direct command injection, but tmux's `-t` flag interpretation could be abused.

**Recommended Fix:** Add `isValidTmuxSession()` checks wherever tmux session names are read from `meta.json` before use.

---

### MEDIUM-2: Ghostty command string interpolation

**Severity:** Medium
**File:** `src/ghostty.ts:51`

**Description:** The `openInGhostty()` function validates the session name with `/^[\w-]+$/` (good), then interpolates it into a `--command` string:

```ts
const proc = spawnFn(["ghostty", `--command=bash -c 'tmux set-option -t "$1" window-size latest && tmux attach -t "$1"' -- ${tmuxSession}`], {
```

While the regex validation prevents shell injection characters, the session name is appended after `--` without quotes. If the validation regex were ever relaxed, this would become a direct shell injection vector. The session name is also used inside a `bash -c` string, where `$1` is used as a positional parameter (good pattern), but the `-- ${tmuxSession}` at the end is outside the quoted bash -c string.

**Impact:** Currently mitigated by the regex check, but fragile. If the `tmuxSession` value passed a relaxed regex (e.g., containing spaces), it would break the bash command or be interpreted as additional arguments to bash.

**Recommended Fix:** Quote the tmux session in the command string: `'-- "${tmuxSession}"'` or restructure to avoid string interpolation entirely.

---

### MEDIUM-3: Path traversal via symlinks in agent-path.ts checkFilePath()

**Severity:** Medium
**File:** `src/hooks/agent-path.ts:216-222`

**Description:** `checkFilePath()` resolves symlinks via `realpathSync()`, but falls back to the `resolve()` result if the path doesn't exist yet. This creates a TOCTOU (time-of-check-time-of-use) race condition:

1. Agent requests to create a file at `<worktree>/foo` (doesn't exist yet → passes resolve() check)
2. Between the check and the actual file operation, a symlink `<worktree>/foo → /etc/passwd` could be created
3. The subsequent file operation follows the symlink

However, the practical exploitability is very low since:
- The agent would need to create the symlink itself (which requires a separate tool call that would also be checked)
- File creation typically fails if a symlink already exists at the target

**Impact:** Theoretical TOCTOU race; very unlikely to be exploitable in practice.

**Recommended Fix:** Document the limitation. Consider checking for symlinks post-operation in sensitive contexts.

---

### MEDIUM-4: Bash command path checking is bypassable with encoded/indirect paths

**Severity:** Medium
**File:** `src/hooks/agent-path.ts:154-195`

**Description:** `checkBashCommandPaths()` performs simple string matching on bash commands to detect references to restricted paths. This can be bypassed through:

1. **Variable expansion:** `$HOME/../.ittybitty/agents/other-agent/...`
2. **Subshell/backtick:** `` cat `echo /path/to/restricted` ``
3. **Heredoc/pipe:** `echo /restricted/path | xargs cat`
4. **Indirect reference:** `dir=/restricted/path; cat $dir/file`
5. **Encoded paths:** The function only checks for exact string matches of `agentsDir + "/"` and `rootRepo + "/"`, so relative paths or paths with extra slashes could bypass

The allow-list pattern `Bash(prefix:*)` also only checks `command.startsWith(prefix)`, so `git status; cat /etc/passwd` would match `Bash(git status:*)`.

**Impact:** An agent could potentially read or modify files outside its worktree via indirect bash commands. This is mitigated by Claude Code's own safety mechanisms and the fact that agents are LLM-driven (not adversarial scripts), but a jailbroken or prompt-injected agent could exploit this.

**Recommended Fix:**
1. Document that path checking is best-effort for bash commands
2. Consider using a more restrictive approach: deny bash by default, only allow specific well-known commands
3. For `Bash(prefix:*)` patterns, also check that the command doesn't contain shell operators (`;`, `&&`, `||`, `|`, backticks) after the prefix

---

### MEDIUM-5: Hook stdin JSON parsing without schema validation

**Severity:** Medium
**Files:** `src/hooks/agent-path.ts:258-263`, `src/hooks/intercept-task.ts:160-161`, `src/hooks/session-start.ts:291`, `src/hooks/agent-status.ts:307-313`

**Description:** All hook entry points parse JSON from stdin with `JSON.parse()` but perform minimal schema validation. Fields are accessed with fallback defaults (`json.tool_name ?? ""`, `json.tool_input ?? {}`), but there's no validation that the types are correct. For example:

- `tool_input` is cast to `Record<string, unknown>` without verifying it's actually an object
- If `tool_input` is a string or number, the cast would succeed silently and subsequent property access would return `undefined`
- `checkPathAccess()` reads `toolInput.file_path` etc. — if `toolInput` is unexpectedly `null`, this would throw

Claude Code controls the stdin input, so this is low risk in practice, but malformed input from a compromised or buggy Claude Code instance could cause crashes.

**Impact:** Unexpected crashes or bypasses if stdin JSON has unexpected schema. Low practical risk since Claude Code controls the input.

**Recommended Fix:** Add basic type guards: verify `tool_input` is a non-null object, `tool_name` is a string, etc. Return "allow" early on schema violations to avoid breaking Claude Code.

---

### LOW-1: Agent ID validation not applied at all entry points in ib-commands.ts

**Severity:** Low
**Files:** `src/ib-commands.ts` (various functions)

**Description:** Functions like `killAgent()`, `mergeAgent()`, `sendMessage()`, `nukeAgent()`, `diffAgent()`, `statusAgent()`, and `pauseAgent()` accept an `Agent` object and use `agent.id` in file paths and log messages without re-validating the ID. The `Agent` objects are typically constructed by `readAllAgents()` which reads directory names from the filesystem, so they should be safe. However, there's no validation at the `Agent` type level.

The CLI entry points in `index.ts` do validate with `isValidAgentId()` (lines 571, 579, 587), so the external attack surface is covered. The internal functions rely on the caller providing valid `Agent` objects.

**Impact:** If an `Agent` object were constructed with a malicious `id` (e.g., via a test or internal bug), it would be used in file path construction without validation. Low risk since all external entry points validate.

**Recommended Fix:** Consider adding validation in the `Agent` constructor or at the boundaries of public API functions.

---

### LOW-2: TOCTOU race in lock file management

**Severity:** Low
**File:** `src/watchdog.ts:392-411`

**Description:** `acquireWatchdogLock()` reads the lock file, checks if the PID is alive, then writes its own PID. Between the read and write, another process could also acquire the lock, leading to two watchdog instances running simultaneously.

**Impact:** Two watchdog instances could send duplicate notifications to agents. This is more of a correctness issue than a security issue.

**Recommended Fix:** Use `O_EXCL` flag for lock file creation, or use advisory file locking.

---

### LOW-3: Unvalidated manager tmux session in agent-status stop hook

**Severity:** Low
**File:** `src/hooks/agent-status.ts:362-380`

**Description:** The stop hook reads `meta.manager` to find the manager's `meta.json` and its `tmux_session`. Neither the manager ID nor the manager's tmux session are validated before use in `Bun.spawn`. The manager ID is used in a path join (`join(agentsDir, managerId)`), which could traverse directories if it contained `../`.

**Impact:** A crafted `meta.json` could cause the hook to read an arbitrary directory's `meta.json`. Since this is within the hooks system (called by Claude Code), practical exploitation requires filesystem access to modify meta.json.

**Recommended Fix:** Validate `managerId` with `isValidAgentId()` and `managerSession` with `isValidTmuxSession()`.

---

### LOW-4: Missing `-l` (literal) flag in stop hook tmux send-keys

**Severity:** Low
**File:** `src/hooks/agent-status.ts:356-358`

**Description:** The stop hook sends nudge messages via:
```ts
["tmux", "send-keys", "-t", tmuxSession, result.message, "Enter"]
```

Without the `-l` flag, tmux interprets special key names within `result.message`. While `result.message` is internally generated (not user-controlled), if it ever contained tmux key names like `C-c` or `Escape`, they would be interpreted as keypresses rather than literal text.

**Impact:** Currently the messages are hardcoded strings that don't contain tmux key names. But this is a correctness/defense-in-depth issue.

**Recommended Fix:** Add `-l` flag before the message argument and send `Enter` as a separate `send-keys` call (matching the pattern used in `sendMessage()`).

---

### INFO-1: All Bun.spawn calls use argument arrays (safe pattern)

**Severity:** Informational

**Description:** Every `Bun.spawn()` call in the codebase uses argument arrays rather than shell strings. This is the correct and safe pattern that prevents shell injection. The codebase consistently follows this practice across all files: `agent-lifecycle.ts`, `ib-commands.ts`, `tmux-poller.ts`, `ghostty.ts`, `auto-compact.ts`, `watchdog.ts`, and all hook files.

---

### INFO-2: No hardcoded secrets or credentials

**Severity:** Informational

**Description:** The codebase contains no hardcoded API keys, tokens, passwords, or other credentials. No `.env` files are read. The only sensitive data handled is file paths and process IDs.

---

### INFO-3: validation.ts provides good coverage for direct CLI inputs

**Severity:** Informational

**Description:** The validation module provides strict character allowlists:
- `isValidModel()`: `[a-zA-Z0-9._-]+`
- `isValidToolList()`: `[a-zA-Z0-9_*()\-:,. ]+`
- `isValidAgentId()`: `[a-zA-Z0-9_-]+`
- `isValidTmuxSession()`: `[a-zA-Z0-9_-]+`
- `isValidSessionId()`: `[a-fA-F0-9-]+`

These are used at CLI entry points (`index.ts`) and in `newAgent()`/`resumeAgent()`. The patterns are appropriately strict.

---

### INFO-4: Path isolation hook is well-designed

**Severity:** Informational

**Description:** The `checkPathAccess()` function in `agent-path.ts` follows a deny-by-default approach for file paths:
1. Checks an explicit allow list
2. Resolves paths to absolute (including symlink resolution)
3. Allows within worktree, denies other agents and main repo
4. Falls through to allow for system paths

The logic is pure and testable, with a separate CLI entry point handling I/O.

---

### INFO-5: New agent name validation is appropriately strict

**Severity:** Informational
**File:** `src/ib-commands.ts:1457`

**Description:** Custom agent names are validated with `/^[a-zA-Z0-9_\-]+$/`, matching the `isValidAgentId()` pattern. Auto-generated IDs use `crypto.getRandomValues()` for secure random hex generation.

---

## Recommendations Summary

### Priority Actions

1. **HIGH-2 Fix:** Properly quote all path interpolations in generated bash scripts, or migrate to direct `Bun.spawn` calls
2. **HIGH-1 Fix:** Add `-l` flag to all tmux send-keys calls that include variable content; validate tmux sessions read from meta.json
3. **MEDIUM-1 Fix:** Add `isValidTmuxSession()` / `isValidAgentId()` checks wherever values are read from meta.json before use in spawn calls

### Architectural Suggestions

- Consider eliminating shell script generation (`start.sh`, `resume.sh`) in favor of a TypeScript-based agent launcher that uses `Bun.spawn` arrays directly
- Add JSON schema validation (or at minimum type guards) at hook stdin parsing boundaries
- Document that bash command path checking is best-effort and relies on Claude Code's own safety mechanisms as the primary defense layer
