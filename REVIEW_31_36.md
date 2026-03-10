# Review: PLAN.md Phases 31 & 36 Accuracy Validation

## Phase 31: Parity Fixes — Hooks & Agent Status

### 31a: Delayed nudge recheck in stop hook (must-fix)

**Verdict: ACCURATE**

**Evidence:**
- Bash (`ib:9341-9346`) schedules a background recheck:
  ```bash
  local recheck_file="$AGENT_DIR/nudge-recheck"
  if [[ ! -f "$recheck_file" ]]; then
      echo "1" > "$recheck_file"
      ( sleep 5 && rm -f "$recheck_file" && ib hooks agent-status "$ID" ) >> "$AGENT_DIR/agent.log" 2>&1 &
      disown
  fi
  ```
- TS (`agent-status.ts:240-250`) only writes the timestamp and returns `debounced` — no background recheck is scheduled:
  ```ts
  if (lastNudgeTime > 0 && currentTime - lastNudgeTime < 5) {
    return { state, action: "debounced" };
  }
  await writeFile(nudgePath, String(currentTime));
  ```
- The TS version lacks the `recheck_file` guard and the `Bun.spawn` background call.

**Recommendation:** Keep as-is. This is a real gap — debounced agents may never get a follow-up check if no further Stop hooks fire.

---

### 31b: Stop hook tmux send-keys timing (must-fix)

**Verdict: ACCURATE**

**Evidence:**
- Bash (`ib:9371-9373`) sends message and Enter separately with a 0.1s sleep:
  ```bash
  tmux send-keys -t "$TMUX_SESSION" "$prompt"
  sleep 0.1
  tmux send-keys -t "$TMUX_SESSION" Enter
  ```
- TS (`agent-status.ts:356-358`) sends both in a single call:
  ```ts
  ["tmux", "send-keys", "-t", tmuxSession, result.message, "Enter"]
  ```
  This passes `result.message` and `"Enter"` as separate args to tmux send-keys. Tmux interprets each arg as a separate key sequence, which may work for short messages but risks issues with long messages or special characters.
- For comparison, `sendMessage()` in `ib-commands.ts:1057-1077` correctly uses two separate calls with `-l` flag and a calculated delay between them.
- Also note: bash uses the bare `tmux send-keys` without `-l` in the stop hook too, so the bash version also has a theoretical issue with special chars, but the sleep mitigates timing problems.

**Recommendation:** Keep. The fix description is correct — split into two calls matching `sendMessage()` pattern. Consider also adding `-l` to protect against tmux key interpretation of special characters in message text.

---

### 31c: Complete + unfinished children message (should-fix)

**Verdict: ACCURATE**

**Evidence:**
- Bash (`ib:9403`) sends a detailed message with command suggestions:
  ```bash
  local prompt="You have $child_count unfinished sub-agent(s) that need attention: $child_list. Before you can complete, you must merge or kill each sub-agent using 'ib merge <id>' or 'ib kill <id>'. Use 'ib list' to check their status, 'ib look <id>' to see their output, 'ib status <id>' for their commits, and 'ib diff <id>' to review their changes."
  ```
- TS (`agent-status.ts:193-194`) sends a much shorter message:
  ```ts
  message: `You have unfinished child agents: ${unfinishedChildren.join(", ")}. Check on them before completing.`
  ```
- Missing from TS: child count, specific command suggestions (`ib merge`, `ib kill`, `ib list`, `ib look`, `ib status`, `ib diff`), "sub-agent(s)" terminology.

**Recommendation:** Keep as-is. The description accurately captures the divergence.

---

### 31d: Nudge message formatting (cosmetic)

**Verdict: ACCURATE — but priority should be upgraded**

**Evidence:**
- Bash (`ib:9369`):
  ```bash
  local prompt="Resume your work, or end with 'WAITING' or 'I HAVE COMPLETED THE GOAL' as your final line."
  ```
- TS (`agent-status.ts:255-256`):
  ```ts
  message: "Resume your work, or end with WAITING or I HAVE COMPLETED THE GOAL as your final line."
  ```
- Single quotes around `WAITING` and `I HAVE COMPLETED THE GOAL` are indeed missing in TS.

**Additional note:** This is more than cosmetic — the bash `parse_state` function (`ib:4901`) specifically strips quoted occurrences of `'I HAVE COMPLETED THE GOAL'` from the text before checking for the completion signal, precisely to avoid false positives from nudge messages appearing in tmux output. Without the quotes in the TS nudge message, the nudge prompt itself could be mistakenly interpreted as a completion signal in tmux captures.

**Recommendation:** Upgrade priority from "cosmetic" to "should-fix" — the quotes serve a functional purpose in `parse_state` to prevent false completion detection.

---

### 31e: main-path comment stripping (should-fix)

**Verdict: ACCURATE**

**Evidence:**
- Bash (`ib:12744-12750`) strips `#` comments:
  ```bash
  cd_target="${cd_target%% #*}"   # stop at # (comment)
  ```
- TS (`main-path.ts:52-56`) only handles `&&`, `||`, `;`, `|`:
  ```ts
  const compoundMatch = cdTarget.match(/^([^&|;]*?)(\s*&&|\s*\|\||\s*;\s*|\s*\|)/);
  ```
  The regex `[^&|;]` does not include `#`. A command like `cd /foo # comment` would be resolved as the path `/foo # comment` (with trailing space and comment), which would likely fail the path resolution silently (allowing access when it shouldn't).

**Additional note:** The PLAN says the file is `main-path.ts`, which is correct — this is the primary Claude's path hook (not the agent path hook in `agent-path.ts`). The TS `agent-path.ts` doesn't handle compound cd commands at all (it just strips quotes), so that's a separate but related gap.

**Recommendation:** Keep. Also consider noting that `agent-path.ts` has the same issue (no compound command stripping at all for cd targets).

---

### 31f: inject-status question counts (should-fix)

**Verdict: ACCURATE**

**Evidence:**
- Bash (`ib:13353-13359`) appends question count to brief summary:
  ```bash
  if [[ $pending_questions -gt 0 ]]; then
      if [[ $pending_questions -eq 1 ]]; then
          brief_summary="$brief_summary (1 question pending)"
      else
          brief_summary="$brief_summary ($pending_questions questions pending)"
      fi
  fi
  ```
  And in full mode (`ib:13366-13368`), it also appends a `generate_questions_block()` to the full status output.
- TS (`inject-status.ts:95-116`) `briefSummary()` only counts agent states — no question counting whatsoever:
  ```ts
  const order = ["running", "waiting", "complete", "rate_limited", "stopped", "creating"];
  ```
- TS would need to read `user-questions.json` from each repo's `.ittybitty/` directory.

**Recommendation:** Keep as-is. Description is accurate and fix steps are clear.

---

### 31g: Debug file content in stop hook (nice-to-have)

**Verdict: ACCURATE**

**Evidence:**
- Bash (`ib:9281-9289`) saves rich debug content:
  ```bash
  printf '%s\n' "$_GET_STATE_CAPTURE" > "$debug_file"
  printf '\n--- parse-state -v output ---\n%s (matched: %s)\n' "$_PARSE_STATE_RESULT" "$_PARSE_STATE_REASON" >> "$debug_file"
  printf '\n--- last_assistant_message ---\n%s\n' "$last_msg" >> "$debug_file"
  ```
  This includes: (1) tmux capture output, (2) parse_state result & reason, (3) last_assistant_message.
- TS (`agent-status.ts:100-108`) only saves `lastMessage`:
  ```ts
  await writeFile(debugPath, lastMessage || "(no message)");
  ```
  Missing: tmux capture output and parse_state reason.

- The PLAN also mentions watchdog debug logging. Bash (`ib:14590-14601`) saves tmux capture on unknown state:
  ```bash
  local debug_file="$debug_dir/watchdog-${debug_timestamp}-unknown.txt"
  tmux capture-pane -t "$TMUX_SESSION" -p -S - > "$debug_file"
  ```
  TS `watchdog.ts` `handleUnknown()` (lines 248-262) does NOT save any debug log — it only increments counters and notifies the manager.

**Recommendation:** Keep. Both sub-points (stop hook debug content and watchdog debug logs) are accurately described.

---

## Phase 36: Watchdog & Lifecycle Improvements

### 36a: Watchdog lock file atomicity (medium priority)

**Verdict: ACCURATE**

**Evidence:**
- TS (`watchdog.ts:392-411`) has a clear TOCTOU race:
  ```ts
  export function acquireWatchdogLock(): boolean {
    // ...
    // Step 1: Read existing lock
    try {
      const content = readFileSync(lockFilePath, "utf-8").trim();
      const pid = parseInt(content, 10);
      if (!isNaN(pid) && isPidAlive(pid)) {
        return false; // Another live watchdog holds the lock
      }
    } catch { /* no lock file */ }

    // Step 2: Write our PID (RACE: another process could write between step 1 and 2)
    writeFileSync(lockFilePath, String(process.pid), "utf-8");
    return true;
  }
  ```
- Between reading the lock file (checking if PID is alive) and writing our PID, another process could also read the stale lock and write its own PID. Both would believe they acquired the lock.
- The suggestion to use `O_EXCL` is appropriate — `fs.openSync(path, 'wx')` (exclusive create) would atomically create the file only if it doesn't exist.
- The `require("fs")` sync APIs observation is also accurate — the function uses `require("fs")` inline rather than Bun APIs.

**Recommendation:** Keep as-is. The TOCTOU race is real. In practice, the window is tiny and the watchdog is typically started once, so this is correctly rated as medium priority. The `O_EXCL` suggestion is the right fix.

---

### 36b: Watchdog debug logs on unknown state (nice-to-have)

**Verdict: ACCURATE**

**Evidence:**
- Bash (`ib:14585-14601`) saves debug log on unknown state transitions:
  ```bash
  if [[ "$prev_state" != "unknown" ]]; then
      # ...
      local debug_file="$debug_dir/watchdog-${debug_timestamp}-unknown.txt"
      tmux capture-pane -t "$TMUX_SESSION" -p -S - > "$debug_file"
  ```
- TS `watchdog.ts` `handleUnknown()` (lines 248-262) only:
  ```ts
  async function handleUnknown(agent: Agent, tracker: AgentTracker, allAgents: Agent[]): Promise<void> {
    tracker.waitCounter++;
    if (tracker.waitCounter >= tracker.notifyInterval) {
      await notifyManager(agent, `[watchdog]: Your subtask ${agent.id} state is unknown...`, allAgents);
      tracker.waitCounter = 0;
      tracker.notifyInterval = Math.min(tracker.notifyInterval * 2, MAX_NOTIFY_TICKS);
    }
  }
  ```
  No debug log saving at all. Also note: bash only saves on the first occurrence (transition into unknown), which is an efficiency detail the phase description could mention.

**Recommendation:** Keep. Add a note that bash only saves on state *transitions* to unknown (not every tick).

---

### 36c: Auto-compact wiring in watchdog

**Verdict: INACCURATE — auto-compact IS already wired into watchdog**

**Evidence:**
- `watchdog.ts` line 24: `import { checkAndCompact } from "./auto-compact";`
- `watchdog.ts` lines 547-563 in `processAgents()`:
  ```ts
  // Auto-compact check with per-agent cooldown
  if (agent.state === "running" || agent.state === "waiting") {
    const now = nowFn();
    if (now - tracker.lastCompactCheckMs >= COMPACT_CHECK_COOLDOWN_MS) {
      tracker.lastCompactCheckMs = now;
      try {
        const config = await readConfigFn(agent.repoPath);
        const thresholdEntry = config["autoCompactThreshold"];
        const threshold = thresholdEntry?.value as number | undefined;
        if (threshold != null && threshold > 0) {
          await checkAndCompact(agent, threshold, tracker.compactState);
        }
      } catch { /* skip */ }
    }
  }
  ```
- This already respects `autoCompactThreshold` config and the 60s per-agent cooldown (`COMPACT_CHECK_COOLDOWN_MS`).
- The `AgentTracker` type includes `compactState` and `lastCompactCheckMs` fields, confirming this is fully integrated.

**Recommendation:** **REMOVE this item entirely** — it was likely written based on an earlier codebase state (Phase 28 era) and is now fully resolved. All three sub-items (wire into watchdog, respect config, respect cooldown) are already implemented.

---

### 36d: Model context size configuration (low priority)

**Verdict: PARTIALLY ACCURATE**

**Evidence:**
- TS (`auto-compact.ts:44-52`) does hardcode model sizes:
  ```ts
  export function contextSizeForModel(model: string): number {
    if (model.includes("4-5") || model.includes("4.5")) {
      return 1_000_000;
    }
    if (model.includes("4-6") || model.includes("4.6")) {
      return 200_000;
    }
    return 200_000;
  }
  ```
- The models listed are: 4.5/4-5 → 1M, 4.6/4-6 → 200K, default → 200K.
- The claim that new models "silently get 200K default" is accurate — there's no warning or logging when falling back.
- However, the PLAN description says "hardcoded model context sizes with substring matching" — this is fair but slightly misleading. The substring matching approach is the same as bash's implementation, so this isn't a divergence from bash; it's an improvement suggestion for both.

**Minor correction:** 4.6 models currently have 200K context windows. The code correctly handles this. The main issue is maintainability: when new model families (e.g., 5.0) are released, they'd silently default to 200K with no warning. The code also doesn't handle potential future 1M+ context models other than the 4.5 family.

**Recommendation:** Keep, but clarify that this is an improvement over both bash and TS (not a parity issue). The "log a warning" suggestion is the most valuable part.

---

## Summary Table

| Item | Verdict | Action |
|------|---------|--------|
| 31a | ACCURATE | Keep |
| 31b | ACCURATE | Keep |
| 31c | ACCURATE | Keep |
| 31d | ACCURATE | Upgrade priority to should-fix (quotes prevent false completion detection in parse_state) |
| 31e | ACCURATE | Keep; note that agent-path.ts has the same gap |
| 31f | ACCURATE | Keep |
| 31g | ACCURATE | Keep |
| 36a | ACCURATE | Keep |
| 36b | ACCURATE | Keep; add note about transition-only saving |
| 36c | **INACCURATE** | **REMOVE** — auto-compact is already fully wired into watchdog |
| 36d | PARTIALLY ACCURATE | Keep; clarify this is an improvement, not a parity issue |
