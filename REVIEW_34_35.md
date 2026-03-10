# Review: PLAN.md Phases 34 & 35 — Accuracy Validation

## Phase 34: Code Quality & Dead Code Cleanup

### 34a: Fix duplicate `merge-check` case in CLI — **ACCURATE**

**Claim:** `merge-check` case appears twice at lines 433 and 451.

**Evidence:** Confirmed. Both cases are identical:

```ts
// Line 433-438:
case "merge-check": {
  const repos = await listRepos();
  const agent = await requireAgent(args[1], repos);
  const { mergeCheckAgent } = await import("./ib-commands");
  await printAndExit(await mergeCheckAgent(agent));
  break;
}

// Line 451-457:
case "merge-check": {
  const repos = await listRepos();
  const agent = await requireAgent(args[1], repos);
  const { mergeCheckAgent } = await import("./ib-commands");
  await printAndExit(await mergeCheckAgent(agent));
  break;
}
```

The second case (line 451) is dead code — JavaScript switch statements match the first case and never reach the second. The first `break` at line 438 exits the switch. Both are identical, so the fix is simply removing the second one.

**Verdict:** Keep as-is. Description is correct.

---

### 34b: Consolidate spawn runner injection — **ACCURATE (undercount)**

**Claim:** 10+ separate module-level mutable spawn runners.

**Evidence:** There are actually **12** distinct spawn runners across 6 files:

| # | File | Variable | set/reset exports |
|---|------|----------|-------------------|
| 1 | `src/ib-commands.ts:36` | `killPauseSpawnRunner` | `setKillPauseSpawnRunner`/`resetKillPauseSpawnRunner` |
| 2 | `src/ib-commands.ts:97` | `nukeResumeSpawnRunner` | `setNukeResumeSpawnRunner`/`resetNukeResumeSpawnRunner` |
| 3 | `src/ib-commands.ts:700` | `mergeSpawnRunner` | `setMergeSpawnRunner`/`resetMergeSpawnRunner` |
| 4 | `src/ib-commands.ts:980` | `sendSpawnRunner` | `setSendSpawnRunner`/`resetSendSpawnRunner` |
| 5 | `src/ib-commands.ts:1112` | `newAgentSpawnRunner` | `setNewAgentSpawnRunner`/`resetNewAgentSpawnRunner` |
| 6 | `src/ib-commands.ts:1878` | `diffStatusSpawnRunner` | `setDiffStatusSpawnRunner`/`resetDiffStatusSpawnRunner` |
| 7 | `src/tmux-poller.ts:11` | `spawnRunner` | `setSpawnRunner`/`resetSpawnRunner` |
| 8 | `src/watchdog.ts:77` | `spawnRunner` | `setWatchdogSpawnRunner`/`resetWatchdogSpawnRunner` |
| 9 | `src/agent-lifecycle.ts:12` | `spawnRunner` | `setSpawnRunner`/`resetSpawnRunner` |
| 10 | `src/usage.ts:27` | `spawnFn` | `setTestSpawn`/`resetTestSpawn` |
| 11 | `src/auto-compact.ts:139` | `compactSpawnRunner` | `setCompactSpawnRunner`/`resetCompactSpawnRunner` |
| 12 | `src/ghostty.ts:14` | `spawnFn` | `setSpawn`/`resetSpawn` |

**Note:** ghostty.ts also has a `setWhich`/`resetWhich` pair (not in the task description's file list).

**Correction needed:** The file list in 34b is missing `src/ghostty.ts`. Should say "12 separate" rather than "10+".

**Verdict:** Keep, but update count and file list.

---

### 34c: Consolidate `runCmd` helpers — **ACCURATE (minor file list errors)**

**Claim:** 5 near-identical `runCmd` wrappers with different stderr handling.

**Evidence:** Confirmed 5 `runCmd`-style functions:

| # | File | Function | Returns stderr? | Drains stderr? |
|---|------|----------|-----------------|----------------|
| 1 | `src/agent-lifecycle.ts:45` | `runCmd()` | No | No (piped but not read) |
| 2 | `src/ib-commands.ts:116` | `nukeResumeRunCmd()` | No | No (piped but not read) |
| 3 | `src/ib-commands.ts:716` | `mergeRunCmd()` | Yes | Yes (`Promise.all`) |
| 4 | `src/ib-commands.ts:1131` | `newAgentRunCmd()` | No | Yes (reads and discards) |
| 5 | `src/ib-commands.ts:1893` | `diffStatusRunCmd()` | Yes | Yes (`Promise.all`) |

**Note:** The claim mentions "3 variants" in ib-commands.ts but there are actually **4** in that file (nukeResumeRunCmd, mergeRunCmd, newAgentRunCmd, diffStatusRunCmd). Plus 1 in agent-lifecycle.ts. Total = 5.

The claim also says `src/tmux-poller.ts` has a variant — it does NOT. tmux-poller uses `spawnRunner` directly without a `runCmd` wrapper.

**Correction needed:** Files list should say `src/ib-commands.ts (4 variants), src/agent-lifecycle.ts (1 variant)`. Remove `src/tmux-poller.ts` from the file list.

**Verdict:** Keep, but fix the file list and variant count.

---

### 34d: Extract shared constants (AGENT_CWD_PATTERN) — **PARTIALLY ACCURATE**

**Claim:** `AGENT_CWD_PATTERN` regex duplicated across 3 hook files.

**Evidence:** The constant exists in all 3 files, BUT the patterns are NOT identical:

```ts
// intercept-task.ts:25
const AGENT_CWD_PATTERN = /\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/;

// inject-status.ts:37
const AGENT_CWD_PATTERN = /\.ittybitty\/agents\/[^/]+\/repo(\/|$)/;

// session-start.ts:18
const AGENT_CWD_PATTERN = /\.ittybitty\/agents\/([^/]+)\/repo(\/|$)/;
```

`inject-status.ts` does NOT have the `([^/]+)` capture group — it uses `[^/]+` (non-capturing). The other two files capture the agent ID.

**Correction needed:** The description should note that the patterns differ slightly. Extracting to a shared constant would need to use the version WITH the capture group (from intercept-task.ts and session-start.ts), but inject-status.ts may intentionally omit the capture group since it doesn't need the agent ID.

**Verdict:** Keep, but add a note about the pattern difference and the need to decide on a single canonical version.

---

### 34e: Fix `as any` in production code — **ACCURATE**

**Claim:** `(baseSettings as any)?.hooks?.PreToolUse` at line 1255.

**Evidence:** Confirmed exactly:

```ts
// ib-commands.ts:1255
const preToolUse = (baseSettings as any)?.hooks?.PreToolUse;
```

This is the ONLY `as any` in non-test production code across ib-commands.ts. (There is also 1 `as any` in tmux-poller.ts, not mentioned in this item.)

**Note:** The `as SpawnFn` casts throughout are technically type assertions too, but `as any` is the unsafe one.

**Verdict:** Keep as-is. Consider adding the tmux-poller.ts occurrence as a bonus fix.

---

### 34f: Rename conflicting `AgentProvider` type — **ACCURATE**

**Claim:** Two different `AgentProvider` types at `watchdog.ts:30` and `inject-status.ts:120-124`.

**Evidence:**

```ts
// watchdog.ts:30
export type AgentProvider = () => Agent[] | Promise<Agent[]>;

// inject-status.ts:120-124
export interface AgentProvider {
  getRepos(): Promise<RepoEntry[]>;
  getAgents(repos: RepoEntry[]): Promise<{ agents: Agent[] }>;
  detectStates(agents: Agent[]): Promise<void>;
}
```

These are completely different types with the same name. The watchdog one is a simple function type; the inject-status one is a multi-method interface.

**Verdict:** Keep as-is. Description is accurate.

---

### 34g: Annotate empty catch blocks — **INACCURATE (misleading)**

**Claim:** 128 empty catch blocks across 23 files.

**Evidence:** There are **128 `catch {` blocks** (catch-without-error-binding) across 23 source files. However, they are **NOT empty**. They contain:

- Comments: `catch { /* ignore */ }`, `catch { /* agents dir may not exist */ }`
- Return statements: `catch { return true; }`, `catch { return {}; }`
- Continue statements: `catch { continue; }`
- Increment statements: `catch { failed++; }`

These are catch blocks that intentionally don't bind the error variable (TypeScript's `catch {` syntax). This is a legitimate pattern for expected errors. The count of 128 matches `catch {` (no error variable), NOT truly empty catch blocks.

If the intent is to audit catch blocks that swallow errors silently, many of these already have explanatory comments. A more accurate description would be: "128 catch blocks that don't capture the error variable".

**Correction needed:** Reword from "128 empty catch blocks" to "128 catch blocks that don't bind the error variable (using `catch {` instead of `catch (err) {`)". Many already have inline comments or meaningful bodies. The task should focus on auditing which ones should log unexpected errors, not annotating "empty" blocks.

**Verdict:** Reword significantly. The issue is real (error swallowing) but the description is misleading.

---

### 34h: Fix `nukeResumeRunCmd` stderr deadlock — **ACCURATE**

**Claim:** Stderr is piped but never drained at lines 116-121.

**Evidence:**

```ts
// ib-commands.ts:116-121
async function nukeResumeRunCmd(cmd: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = nukeResumeSpawnRunner(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), exitCode };
}
```

Stderr IS piped (`stderr: "pipe"`) but never read. Compare with `mergeRunCmd`:

```ts
// ib-commands.ts:716-724
async function mergeRunCmd(cmd: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = mergeSpawnRunner(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}
```

The same issue also affects `agent-lifecycle.ts:45-50` (`runCmd`), which similarly pipes stderr without draining it. The description only mentions `nukeResumeRunCmd` but the problem is shared.

**Note:** `newAgentRunCmd` (line 1131-1137) correctly drains stderr with `await new Response(proc.stderr).text()` even though it doesn't return it.

**Correction needed:** Also mention `agent-lifecycle.ts:runCmd()` has the same issue.

**Verdict:** Keep, but expand scope to include agent-lifecycle.ts.

---

### 34i: Use `sed` alternative for JSON modification — **ACCURATE**

**Claim:** `sed` used at lines 392-395 of ib-commands.ts for JSON modification.

**Evidence:**

```bash
# ib-commands.ts:390-395 (inside a bash heredoc string for start.sh)
# Store PID in meta.json using sed (no jq dependency)
# This adds claude_pid field to existing JSON
if [[ -f "${agentDir}/meta.json" ]]; then
    # Insert claude_pid before the closing brace
    sed -i '' "s/}$/,\\n  \\"claude_pid\\": \\"$CLAUDE_PID\\"\\n}/" "${agentDir}/meta.json"
fi
```

This is inside a bash script template (start.sh) that ib-commands.ts generates. It uses `sed` to insert a field before the closing `}` of the JSON file. This is indeed brittle — it assumes single-line JSON ending with `}` on the last line, and would break with nested objects or formatted JSON.

**Verdict:** Keep as-is. Description is accurate.

---

## Phase 35: Test Coverage Improvements

### 35a: CLI entrypoint tests — **ACCURATE**

**Claim:** `src/index.ts` (708 lines, no test file); `collect()` and `findManager()` are inline closures.

**Evidence:**
- `src/index.ts` is 707 lines (close enough to 708 — likely a minor difference from when the review was written)
- No `src/index.test.ts` exists (confirmed by glob search)
- `collect()` is a nested function at line 110, defined inside a `for` loop body
- `findManager()` is a nested function at line 131, defined inside an `else` block within the `collect()` scope

Both are truly inline closures that cannot be tested independently without extraction.

**Verdict:** Keep as-is. Description is accurate.

---

### 35b: TUI module tests — **ACCURATE**

**Claim:** `agent-actions.ts`, `pane-manager.ts`, `dialog-handler.ts` have no dedicated test files.

**Evidence:**
- `src/tui/agent-actions.ts` — EXISTS, no `agent-actions.test.ts` found
- `src/tui/pane-manager.ts` — EXISTS, no `pane-manager.test.ts` found
- `src/tui/dialog-handler.ts` — EXISTS, no `dialog-handler.test.ts` found

All three files exist but have zero test coverage. Some TUI testing is done in `dashboard.test.ts`, but these modules have no dedicated test files.

**Verdict:** Keep as-is. Description is accurate.

---

### 35c: Test infrastructure improvements (as any count) — **ACCURATE**

**Claim:** 70+ `as any` occurrences in test files.

**Evidence:** Actual count is **81 `as any` occurrences across 7 test files**:

| File | Count |
|------|-------|
| `src/tui/dashboard.test.ts` | 45 |
| `src/watcher.test.ts` | 14 |
| `src/ib-commands.test.ts` | 11 |
| `src/usage.test.ts` | 8 |
| `src/watchdog.test.ts` | 1 |
| `src/agents.test.ts` | 1 |
| `src/tui/setup-dialog.test.ts` | 1 |

The "70+" claim is conservative — actual count is 81.

**Verdict:** Keep, but could update to say "80+" for accuracy.

---

### 35d: Validate `readAgentMeta` more thoroughly — **ACCURATE**

**Claim:** Only `id` and `tmux_session` are type-checked at line 84; other fields cast without validation.

**Evidence:**

```ts
// agents.ts:70-84
async function readAgentMeta(agentDir: string): Promise<{ meta: AgentMeta | null; error?: string }> {
  try {
    const metaPath = join(agentDir, "meta.json");
    const file = Bun.file(metaPath);
    if (!(await file.exists())) return { meta: null };
    const data = await file.json();
    // Basic validation: id is required
    if (!data || typeof data.id !== "string") {
      return { meta: null, error: `Malformed ${metaPath}: missing or invalid 'id'` };
    }
    // Default tmux_session to empty string if missing
    if (typeof data.tmux_session !== "string") {
      data.tmux_session = "";
    }
    return { meta: data as AgentMeta };
  } catch (err) {
    return { meta: null, error: `Failed to read ${join(agentDir, "meta.json")}: ${err}` };
  }
}
```

Only `id` is validated (must be string). `tmux_session` gets a default but isn't validated per se. Everything else (`created_epoch`, `worker`, `model`, `branch`, `manager`, `parent_branch`, etc.) is blindly cast via `data as AgentMeta`.

**Verdict:** Keep as-is. Description is accurate.

---

### 35e: Config type validation — **ACCURATE**

**Claim:** Values from `.ittybitsy.json` are stored without type checking against `ConfigKeyDef.type` at lines 88-106.

**Evidence:**

```ts
// config.ts:88-106
for (const def of CONFIG_KEYS) {
  const projectVal = getNestedValue(projectData, def.key);
  if (projectVal !== undefined) {
    result[def.key] = { value: projectVal, source: "project" };
    continue;
  }

  const userVal = getNestedValue(userData, def.key);
  if (userVal !== undefined) {
    result[def.key] = { value: userVal, source: "user" };
    continue;
  }

  const defaultVal = Array.isArray(def.default) ? [...def.default] : def.default;
  result[def.key] = { value: defaultVal, source: "default" };
}
```

Each `ConfigKeyDef` declares a `type` field (e.g., `"number"`, `"boolean"`, `"string"`, `"string[]"`), but `readConfig()` never checks whether the loaded value matches the declared type. A config file with `"maxAgents": "ten"` would be accepted and stored as a string, potentially causing runtime errors downstream.

**Verdict:** Keep as-is. Description is accurate.

---

## Summary

| Item | Verdict | Notes |
|------|---------|-------|
| 34a | **ACCURATE** | Keep as-is |
| 34b | **ACCURATE** (undercount) | Update to 12 runners, add ghostty.ts to file list |
| 34c | **ACCURATE** (minor errors) | Fix: 4 variants in ib-commands.ts, remove tmux-poller.ts |
| 34d | **PARTIALLY ACCURATE** | Note that patterns differ (capture group difference) |
| 34e | **ACCURATE** | Keep as-is; optionally add tmux-poller.ts `as any` |
| 34f | **ACCURATE** | Keep as-is |
| 34g | **INACCURATE** | Not "empty" catch blocks — they have bodies. Reword to "catch blocks without error binding" |
| 34h | **ACCURATE** | Expand scope to include agent-lifecycle.ts same issue |
| 34i | **ACCURATE** | Keep as-is |
| 35a | **ACCURATE** | Keep as-is |
| 35b | **ACCURATE** | Keep as-is |
| 35c | **ACCURATE** (conservative) | Actual count is 81, not "70+" |
| 35d | **ACCURATE** | Keep as-is |
| 35e | **ACCURATE** | Keep as-is |

### Overall Assessment

Phases 34 and 35 are well-researched and substantively correct. The main issues are:

1. **34g is misleadingly worded** — the catch blocks are not empty; they just don't capture the error variable. This is the most significant inaccuracy.
2. **34c file list is slightly wrong** — tmux-poller.ts doesn't have a runCmd variant; ib-commands.ts has 4 (not 3).
3. **34d patterns aren't identical** — one file omits the capture group.
4. **34h should be expanded** — agent-lifecycle.ts has the same stderr deadlock issue.

No items should be removed. All describe real issues worth addressing.
