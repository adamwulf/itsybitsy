# Test Cases for resolveTarget, Coordinator Rejection, and Reserved Name Checks

## 1. resolveTarget Function Tests

### 1.1 @system Addressing

| Test Case | Setup | Input | Expected Result |
|-----------|-------|-------|-----------------|
| **@system-exact** | Any repos configured | `"@system"` | `{ agent: null, isSystemCoordinator: true }` (fast path, no readAllAgents call) |
| **@system-case-sensitive** | Any repos | `"@System"` or `"@SYSTEM"` | Error message: "Agent not found: @System" (fails through bare search) |
| **@system-with-args** | Any repos | `"@system/something"` | Error: "repo not found: system/something" (fails repo lookup) |

### 1.2 @coordinator Addressing (own repo detection)

#### Setup: Repo structure with multiple repos and various CWD scenarios

**Repos:**
- Repo A: `/home/user/projects/app` (name: "app")
- Repo B: `/home/user/projects/lib` (name: "lib")
- Repo C: `/home/user/projects/api` (nickname: "api-server", basename: "api")

#### CWD Resolution Tests

| Test Case | CWD | Expected ownRepo | Routing |
|-----------|-----|------------------|---------|
| **cwd-exact-match** | `/home/user/projects/app` | Repo A | ✓ Finds exact repo |
| **cwd-inside-repo** | `/home/user/projects/app/src/components` | Repo A | ✓ Prefix match |
| **cwd-worktree-basic** | `/home/user/projects/app/.ittybitty/agents/agent-abc/repo` | Repo A | ✓ Extracts root from worktree path |
| **cwd-worktree-nested** | `/home/user/projects/app/.ittybitty/agents/agent-with-hyphens-123/repo` | Repo A | ✓ Handles agent-id with hyphens |
| **cwd-worktree-not-at-end** | `/home/user/projects/app/.ittybitty/agents/agent-abc/repo/src` | Repo A | ✗ Does NOT match (worktree path doesn't end with `/repo`) |
| **cwd-outside-all-repos** | `/home/other/place` | null | No ownRepo found |
| **cwd-prefix-collision-exact-first** | `/home/user/projects/app-data` (inside `app`? NO) | Repo A or null? | ✓ Exact match takes precedence; prefix match is `cwd.startsWith(r.path + "/")` so `/home/user/projects/app-data` does NOT match `/home/user/projects/app/` |

#### @coordinator Routing Tests

| Test Case | CWD Context | Coordinator Status | Expected |
|-----------|-------------|-------------------|----------|
| **@coordinator-found** | Inside Repo A, coordinator exists | ✓ Coordinator agent-id in meta.json | `{ agent: <coordinator agent>, isSystemCoordinator: false }` |
| **@coordinator-not-found** | Inside Repo A, no coordinator | ✗ checkCoordinatorExists returns `{ exists: false }` | Error: "no coordinator found for repo app" |
| **@coordinator-outside-repo** | CWD outside all repos | N/A | Error: "@coordinator requires running from within a repo" |
| **@coordinator-case-sensitive** | Inside Repo A, coordinator exists | ✓ | Error: "Agent not found: @coordinator" (NOT treated as special keyword due to case) — WAIT, the code checks `target === "@coordinator"` (exact string match), so only lowercase works. Check if this is correct behavior or a bug. |

### 1.3 @<repo-name> Addressing (repo coordinator)

#### Setup:
- Repo A: path `/home/user/projects/app`, name: "app", no nickname
- Repo B: path `/home/user/projects/lib`, name: "lib", nickname: "libs"
- Repo C: path `/home/user/projects/api`, name: "api", nickname: "backend"

#### Tests

| Test Case | Input | Expected Lookup | Expected Result |
|-----------|-------|------------------|-----------------|
| **@repo-by-name** | `"@app"` | Find repo with repoDisplayName === "app" | ✓ Finds Repo A |
| **@repo-by-nickname** | `"@libs"` | Find repo with repoDisplayName === "libs" | ✓ Finds Repo B (via nickname) |
| **@repo-by-nickname-not-basename** | `"@lib"` | Find repo with repoDisplayName === "lib" | ✗ Fails; "lib" != "libs" (nickname overrides basename) |
| **@repo-nonexistent** | `"@unknown"` | Find repo repoDisplayName === "unknown" | Error: "repo not found: unknown" |
| **@repo-case-sensitive** | `"@App"` or `"@APP"` | Find repo repoDisplayName === "App" | Error: "repo not found: App" (case-sensitive lookup) |
| **@repo-coordinator-exists** | `"@app"` (Repo A has coordinator) | checkCoordinatorExists returns `{ exists: true, isCoordinator: true, agentId: "coord-xyz" }` | `{ agent: coord-xyz agent object, isSystemCoordinator: false }` |
| **@repo-coordinator-not-exists** | `"@app"` (Repo A has no coordinator) | checkCoordinatorExists returns `{ exists: false }` | Error: "no coordinator found for repo app" |

### 1.4 @<repo-name>/<agent-id> Addressing (agent in specific repo)

#### Setup:
- Repo A has agents: "agent-111", "agent-abc", "worker-001"
- Repo B has agents: "agent-222", "agent-abd", "manager-xyz"

#### Tests

| Test Case | Input | Setup | Expected Match Logic | Expected Result |
|-----------|-------|-------|----------------------|-----------------|
| **@repo/agent-exact** | `"@app/agent-111"` | Repo A exists, agent-111 in Repo A | Exact match in repoAgents | `{ agent: agent-111, isSystemCoordinator: false }` |
| **@repo/agent-prefix-unique** | `"@app/agent-1"` | Repo A has agent-111, no other agent-1xx | Prefix match returns 1 result | `{ agent: agent-111, isSystemCoordinator: false }` |
| **@repo/agent-prefix-ambiguous** | `"@app/agent-a"` | Repo A has agent-abc, agent-abd (wait, Repo B has agent-abd, not Repo A) | Prefix match in repoAgents only (not global) | Filter agents to Repo A: `agents.filter((a) => a.repoPath === repo.path)`, then matchAgentById; ambiguous: ["agent-abc"] only (not agent-abd from Repo B) |
| **@repo/agent-not-in-repo** | `"@app/agent-222"` | Repo A does not have agent-222; it's in Repo B | repoAgents filtered to Repo A, no match | Error: "Agent not found: agent-222 in repo app" |
| **@repo/repo-nonexistent** | `"@unknown/agent-111"` | No repo named "unknown" | Repo lookup fails | Error: "repo not found: unknown" |
| **@repo/agent-cross-repo-forbidden** | `"@lib/agent-111"` | agent-111 is in Repo A, not Repo B | Search scoped to Repo B agents | Error: "Agent not found: agent-111 in repo lib" (even though agent-111 exists globally) |
| **@repo/agent-prefix-ambiguous-same-repo** | `"@app/agent-a"` | Repo A has agent-abc, agent-abd | Prefix match finds 2 in Repo A | Error: 'Ambiguous ID "agent-a" in repo app matches: agent-abc, agent-abd' |
| **@repo/agent-empty-id** | `"@app/"` | N/A | agentId extracted as "" (substring after "/" is "") | matchAgentById("", agents) — does prefix matching on "" match all agents? YES, every agent-id starts with "". Ambiguous. | Error: 'Ambiguous ID "" in repo app matches: [all agents in app]' |

### 1.5 Bare Agent-ID Addressing (same-repo first, then global fallback)

#### Setup for all bare tests:
- Repo A: `/home/user/projects/app`, agents: "agent-111", "agent-abc", "worker-001"
- Repo B: `/home/user/projects/lib`, agents: "agent-222", "agent-abd", "worker-002"
- Global all agents: agent-111, agent-abc, worker-001 (Repo A), agent-222, agent-abd, worker-002 (Repo B)

#### CWD context determines ownRepo

| Test Case | CWD | Input | Expected |
|-----------|-----|-------|----------|
| **bare-exact-same-repo** | Inside Repo A | `"agent-111"` | ✓ Exact match in Repo A agents; returns agent-111 from Repo A (does not search global) |
| **bare-prefix-same-repo-unique** | Inside Repo A | `"agent-1"` | ✓ Prefix matches agent-111 in Repo A (unique in same-repo); returns agent-111 |
| **bare-prefix-same-repo-ambiguous** | Inside Repo A | `"agent-a"` | ✗ Prefix matches agent-abc in same-repo; matches 1 agent; returns agent-abc (NOT ambiguous because only 1 match) |
| **bare-prefix-same-repo-ambiguous-2-matches** | Inside Repo A (hypothetically has agent-abc and agent-abd) | `"agent-a"` | ✗ Ambiguous in same-repo; Error: 'Ambiguous ID "agent-a" in app matches: agent-abc, agent-abd'; **does NOT fall back to global** |
| **bare-not-in-same-repo-found-global** | Inside Repo A | `"agent-222"` | No match in Repo A, falls back to global search; agent-222 is in Repo B; returns agent-222 |
| **bare-not-in-same-repo-prefix-global** | Inside Repo A | `"agent-2"` | No match in Repo A, falls back to global; prefix matches agent-222 in Repo B (unique globally); returns agent-222 |
| **bare-not-in-same-repo-ambiguous-global** | Inside Repo A | `"worker-"` | No match in Repo A (worker-001 is in Repo A, so it IS in same repo); let me reconsider: same-repo agents = [agent-111, agent-abc, worker-001]. Prefix "worker-" matches worker-001 (1 match, not ambiguous, exact prefix in same repo). Wait, recheck: if CWD is inside Repo A, then sameRepoAgents includes worker-001. So no fallback. |
| **bare-global-ambiguous** | Inside Repo A | `"agent-"` | No exact in Repo A. Prefix "agent-" in Repo A agents: agent-111, agent-abc (2 matches, ambiguous). **Report ambiguous, do NOT fall back**. Error: 'Ambiguous ID "agent-" in app matches: agent-111, agent-abc' |
| **bare-global-ambiguous-cross-repo** | Inside Repo A | Hypothetical: both Repo A and Repo B have agent-xyz | Input: `"agent-xyz"` (exact) | Exact match in Repo A (same-repo) returns agent-xyz from Repo A; **same-repo match takes precedence over global** |
| **bare-not-in-same-repo-prefix-ambiguous-global** | Inside Repo A | Both Repo B agents have agent-2xx (agent-222, agent-2yy hypothetically) | `"agent-2"` | No match in Repo A. Fall back to global. Prefix "agent-2" matches agent-222, agent-2yy (2 matches, ambiguous). Error: 'Ambiguous ID "agent-2" matches: agent-222, agent-2yy' |
| **bare-outside-all-repos** | `/home/other` (outside all repos) | `"agent-111"` | ownRepo = null. Skip same-repo search. Global search: matchAgentById("agent-111", all agents); finds agent-111. Returns agent-111. (Same-repo search is skipped, not error) |
| **bare-not-found-no-repo** | `/home/other` | `"nonexistent-id"` | ownRepo = null. Global search: no match. Error: "Agent not found: nonexistent-id" |
| **bare-empty-string** | Inside Repo A | `""` | Prefix "" matches all agents in Repo A (all strings start with ""). Ambiguous. Error: 'Ambiguous ID "" in app matches: [all agent ids in Repo A]' |

### 1.6 Edge Cases: Prefix Matching and Ambiguity Resolution

| Test Case | Setup | Input | Expected Behavior |
|-----------|-------|-------|-------------------|
| **prefix-no-match-empty** | Repo A agents: agent-111 | Input: `"agent-2"` | No match (no agent starts with "agent-2"). Returns null. |
| **prefix-exact-vs-prefix** | Repo A agents: agent-1, agent-11, agent-111 | Input: `"agent-1"` | Exact match "agent-1"; returns that agent (does NOT prefix-match agent-11, agent-111). |
| **prefix-single-match** | Repo A agents: agent-111, worker-001 | Input: `"agent-1"` | Prefix "agent-1" matches agent-111 (single match); returns agent-111. |
| **prefix-partial-word** | Agents: agent-abc, agent-abd | Input: `"agent-ab"` | Prefix "agent-ab" matches both; ambiguous. Error. |
| **case-sensitive-prefix** | Agents: agent-ABC | Input: `"Agent-"` or `"agent-"` | Input "Agent-" does NOT prefix-match "agent-ABC" (case-sensitive). No match. |
| **hyphen-in-id** | Agents: agent-foo-bar, agent-foo-baz | Input: `"agent-foo-"` | Prefix matches both; ambiguous. |
| **underscore-in-id** | Agents: agent_foo, agent-bar | Input: `"agent_"` | Exact match none. Prefix "agent_" matches agent_foo; returns agent_foo. |

### 1.7 Worktree Path Detection

| Test Case | CWD | Expected Behavior |
|-----------|-----|-------------------|
| **worktree-exact-end** | `/home/user/projects/app/.ittybitty/agents/agent-45c1e811/repo` | ✓ Matches regex `\/\.ittybitty\/agents\/[^/]+\/repo$`. Extracts `/home/user/projects/app` as repoRoot. |
| **worktree-trailing-slash** | `/home/user/projects/app/.ittybitty/agents/agent-45c1e811/repo/` | ✗ Does NOT match regex (ends with `/`). Falls back to prefix matching. If `/home/user/projects/app` is in repos, prefix match succeeds. |
| **worktree-subdir** | `/home/user/projects/app/.ittybitty/agents/agent-45c1e811/repo/src` | ✗ Does NOT match regex (ends with `repo/src`, not `repo`). Falls back to prefix match. |
| **worktree-similar-path** | `/home/user/projects/app/.ittybitty/agents-backup/agent-xyz/repo` | ✗ Does NOT match regex (`.ittybitty/agents-backup`, not `.ittybitty/agents`). |
| **worktree-extract-reporoot** | `/home/user/projects/deep/nested/app/.ittybitty/agents/agent-xyz/repo` | ✓ `cwd.lastIndexOf("/.ittybitty")` finds the rightmost `/.ittybitty`, extracts `/home/user/projects/deep/nested/app`. Must match a repo.path exactly. |
| **worktree-extract-no-matching-repo** | `/home/user/projects/unknown/.ittybitty/agents/agent-xyz/repo` | Extracts `/home/user/projects/unknown`, but no repo with path === that. Returns null (ownRepo not found). |

### 1.8 readAllAgents Call Minimization (implementation detail, but affects test setup)

| Test Case | Purpose | Expected |
|-----------|---------|----------|
| **@system-no-readAllAgents** | @system is a fast path | Should NOT call readAllAgents (returns immediately with isSystemCoordinator: true). |
| **@coordinator-readAllAgents-once** | @coordinator needs coordinator agent object | Calls readAllAgents once to find the coordinator agent by ID. |
| **@repo-coordinator-readAllAgents-once** | @repo needs coordinator | Calls readAllAgents once. |
| **@repo/agent-readAllAgents-once** | @repo/agent needs to search repo's agents | Calls readAllAgents once, filters by repo.path. |
| **bare-same-repo-readAllAgents-once** | Bare search (same-repo found) | Calls readAllAgents once, searches same-repo agents. |
| **bare-global-fallback-same-readAllAgents** | Bare search (not in same-repo, fallback to global) | Same readAllAgents call; uses both same-repo and global filters. |

---

## 2. newAgent Coordinator Name Rejection Tests

**Code location:** `src/ib-commands.ts` lines 1614–1631

**Logic:**
1. If `opts?.name` is provided:
   - Must match regex `/^[a-zA-Z0-9_\-]+$/`
   - Cannot be "coordinator" (rejects if === "coordinator")
   - Used as agent ID
2. Else: Generate random `agent-XXXXXXXX` (always skips "coordinator" check because generated IDs never equal "coordinator")
3. Reserved name check after ID generation (lines 1629–1630): if `id === "coordinator"`, reject

**Test cases:**

| Test Case | Input | Expected |
|-----------|-------|----------|
| **coordinator-explicit-name** | `--name coordinator` or opts.name = "coordinator" | Rejects at line 1618 with error: 'Error: "coordinator" is a reserved name (used for system coordinator addressing)' |
| **coordinator-case-mismatch** | `--name Coordinator` or `--name COORDINATOR` | Passes regex (contains uppercase). Does NOT match "coordinator" (case-sensitive). Generated as agent ID. SUCCESS (no rejection). |
| **coordinator-suffix** | `--name coordinator-foo` or `--name foo-coordinator` | Passes regex. Does NOT match "coordinator" exactly. SUCCESS. |
| **coordinator-substring** | `--name my-coordinator` or `--name coordinator2` | Passes regex. Does NOT match "coordinator" exactly. SUCCESS. |
| **name-regex-invalid** | `--name agent@id` or `--name agent id` or `--name agent.py` | Rejects regex at line 1615 with error: 'Error: agent name may only contain letters, digits, hyphens, and underscores' |
| **name-hyphen-allowed** | `--name agent-foo-bar` | Matches regex. Not "coordinator". SUCCESS. |
| **name-underscore-allowed** | `--name agent_foo_bar` | Matches regex. Not "coordinator". SUCCESS. |
| **name-digit-prefix** | `--name 123agent` | Matches regex (digits are allowed). Not "coordinator". SUCCESS. |
| **name-empty-string** | `--name ""` | Does NOT match regex (must have at least one char from `[a-zA-Z0-9_\-]`). Rejects. |
| **no-name-random-id** | opts?.name is not provided (default) | Generates `agent-XXXXXXXX`. Will never equal "coordinator". SUCCESS. |
| **random-id-fallback** | opts?.name undefined after some operation | Generates random. SUCCESS. |
| **coordinator-double-check-redundant** | Hypothetically, if name === "coordinator" is provided | Should be caught at line 1618. The second check at line 1629 is redundant (only triggers if id === "coordinator" after assignment, which can only happen if name === "coordinator" somehow bypassed line 1618, or future code path assigns "coordinator"). **This test verifies the redundancy or documents the intent as defensive.** |

---

## 3. Reserved Name Checks in registry.ts

**Code locations:**
- `addRepo()`: line 54 (reserved name check)
- `renameRepo()`: line 99 (reserved name check)

### 3.1 addRepo Reserved Name Rejection

| Test Case | Input repoPath | Input name | Expected |
|-----------|-----------------|-----------|----------|
| **addRepo-coordinator-by-name** | `/home/user/projects/app` | name = "coordinator" | Rejects at line 54 with error: '"coordinator" is a reserved name — rename the directory or use a custom name' |
| **addRepo-coordinator-basename** | `/home/user/projects/coordinator` | name not provided (uses basename) | repoName = "coordinator" (basename). Rejects at line 54. |
| **addRepo-coordinator-case-mismatch** | `/home/user/projects/Coordinator` | name not provided | repoName = "Coordinator". Does NOT match "coordinator" (case-sensitive). SUCCESS. |
| **addRepo-coordinator-suffix** | `/home/user/projects/my-coordinator` | name not provided | repoName = "my-coordinator". Does NOT match "coordinator" exactly. SUCCESS. |
| **addRepo-custom-name-not-coordinator** | `/home/user/projects/anything` | name = "myrepo" | repoName = "myrepo". Not "coordinator". SUCCESS. |
| **addRepo-custom-name-overrides-basename** | `/home/user/projects/coordinator` | name = "api" | repoName = "api". Not "coordinator". SUCCESS. (Custom name overrides reserved basename.) |
| **addRepo-duplicate-path** | `/home/user/projects/app` | (Already in registry with same path) | Rejects at line 61 with error: 'Already registered: /home/user/projects/app' (before reserved name check, so order is: reserved check, then duplicate check). **WAIT**: reserved check is at line 54, duplicate check is at line 61, so reserved is first. |
| **addRepo-no-name-uses-basename** | `/home/user/projects/myapp` | name not provided | repoName = basename("/home/user/projects/myapp") = "myapp". Not "coordinator". SUCCESS. |

### 3.2 renameRepo Reserved Name Rejection

| Test Case | Input repoPath | Input nickname | Expected |
|-----------|-----------------|----------------|----------|
| **renameRepo-coordinator** | `/home/user/projects/app` (exists in registry) | nickname = "coordinator" | Rejects at line 99 with error: '"coordinator" is a reserved name' |
| **renameRepo-coordinator-case-mismatch** | `/home/user/projects/app` | nickname = "Coordinator" | Does NOT match "coordinator" (case-sensitive). SUCCESS. |
| **renameRepo-coordinator-suffix** | `/home/user/projects/app` | nickname = "my-coordinator" | Does NOT match "coordinator" exactly. SUCCESS. |
| **renameRepo-empty-nickname** | `/home/user/projects/app` | nickname = "" (empty string) | trimmed = "". The condition `if (trimmed)` is false; skips reserved check and unsets nickname (line 101). SUCCESS. |
| **renameRepo-whitespace-only** | `/home/user/projects/app` | nickname = "   " (spaces) | trimmed = "". Skips reserved check. SUCCESS. |
| **renameRepo-not-found** | `/home/user/projects/unknown` (not in registry) | nickname = "alias" | Rejects at line 94 with error: 'Not found: /home/user/projects/unknown' (before reserved check). |
| **renameRepo-valid-nickname** | `/home/user/projects/app` (exists) | nickname = "myalias" | trimmed = "myalias". Not "coordinator". SUCCESS. Sets nickname in registry. |
| **renameRepo-clear-nickname** | `/home/user/projects/app` (has nickname "old") | nickname = "" | trimmed = "". Clears nickname. SUCCESS. (repoDisplayName will fall back to basename.) |

---

## 4. Integration Tests: Cross-Cutting Scenarios

### 4.1 Multi-Repo Addressing with Coordinators

| Test Case | Setup | Action | Expected |
|-----------|-------|--------|----------|
| **multi-repo-same-agent-id** | Repo A and B each have agent-123 | Send to `agent-123` from inside Repo A | ✓ Finds agent-123 from Repo A (same-repo first) |
| **multi-repo-same-agent-id-explicit** | Repo A and B each have agent-123 | Send to `@lib/agent-123` (Repo B is "lib") | ✓ Finds agent-123 from Repo B (explicit repo scoping) |
| **multi-repo-same-agent-id-wrong-repo** | Repo A and B each have agent-123; agent-123 is in Repo A | Send to `@lib/agent-123` from anywhere | ✗ Not found in Repo B. Error: "Agent not found: agent-123 in repo lib" |
| **multi-repo-coordinator-routing** | Repo A and B each have coordinators | Send to `@coordinator` from inside Repo A | ✓ Routes to Repo A's coordinator |
| **multi-repo-coordinator-routing-explicit** | Repo A and B have coordinators | Send to `@lib` from anywhere | ✓ Routes to Repo B's coordinator |

### 4.2 Coordinator Name Rejection in Multi-Agent Scenario

| Test Case | Setup | Action | Expected |
|-----------|-------|--------|----------|
| **create-agent-named-coordinator** | Within a repo (any context) | Spawn agent with `--name coordinator` | ✗ Rejects before agent creation. Error: 'Error: "coordinator" is a reserved name' |
| **add-repo-named-coordinator** | Registry has repos | Try to add a repo named "coordinator" | ✗ Rejects. Error: '"coordinator" is a reserved name — rename the directory or use a custom name' |
| **rename-repo-to-coordinator** | Registry has repo "myrepo" | Rename to "coordinator" | ✗ Rejects. Error: '"coordinator" is a reserved name' |

### 4.3 CWD Detection Priority (exact > prefix > worktree)

| Test Case | CWD | Repos | Expected ownRepo |
|-----------|-----|-------|-----------------|
| **priority-exact** | `/home/user/app` | [{path: "/home/user/app", ...}, {path: "/home/user/", ...}] | Exact match `/home/user/app` (does not use prefix match) |
| **priority-prefix** | `/home/user/app/src` | [{path: "/home/user/app", ...}] | Prefix match (no exact match) |
| **priority-worktree** | `/home/user/app/.ittybitty/agents/agent-xyz/repo` | [{path: "/home/user/app", ...}] | Worktree extraction (no exact or prefix match, worktree regex matches) |
| **priority-no-match** | `/other/location` | [{path: "/home/user/app", ...}] | null (no match via any method) |

### 4.4 Agent Lookup Across All Addressing Forms

| Scenario | Repos | Agents | Test Cases |
|----------|-------|--------|-----------|
| **single-repo-single-agent** | Repo A only | agent-111 only | Bare "agent-111" works. @A works (coordinator). @A/agent-111 works. |
| **single-repo-multiple-agents** | Repo A only | agent-111, agent-222, worker-001 | Bare exact/prefix work. Bare ambiguous IDs rejected. @A/agent-1 works. |
| **multi-repo-overlapping-ids** | Repo A: agent-111, agent-222; Repo B: agent-111, agent-333 | When inside Repo A, bare agent-111 → finds Repo A's agent-111. Bare agent-222 → unique in Repo A. Bare agent-333 → not in Repo A, falls back to global, finds Repo B's. Bare agent-333 from inside Repo B → finds in same-repo. |
| **cross-repo-explicit-addressing** | Repo A: agent-111; Repo B: agent-222 | From inside Repo A, @B/agent-222 → finds Repo B's agent-222. From inside Repo A, agent-222 → falls back to global, finds Repo B's. |

---

## 5. Error Handling and Edge Cases

### 5.1 Invalid Input Formats

| Test Case | Input | Expected Error |
|-----------|-------|-----------------|
| **empty-string-input** | `""` | Treated as bare ID. Prefix matches all agents. Ambiguous or not found. |
| **whitespace-only** | `" "` or `"\t"` | Treated as literal bare ID. No match. "Agent not found:  " |
| **special-chars-bare** | `"agent@123"` or `"agent.id"` | Treated as literal bare ID (no regex validation for bare IDs, only for --name). No match unless agent literally has that ID. |
| **special-chars-at-addressing** | `"@repo@name"` or `"@repo.name"` | Parsed as repo name "repo@name" or "repo.name". Repo lookup fails (exact string match on repoDisplayName). Error: "repo not found: repo@name" |
| **multiple-slashes** | `"@repo/agent/extra"` | afterAt = "repo/agent/extra". slashIdx finds first "/". repoName = "repo". agentId = "agent/extra". Agent lookup for "agent/extra" (literal string, no further parsing). No match. |
| **at-sign-edge-cases** | `"@"` | target.startsWith("@") = true. afterAt = "". repoName = "" (slashIdx = -1, so substring(0, -1) = ""). Repo lookup for empty string. Error: "repo not found: " |
| **slash-only** | `"/"` | Does NOT start with "@". Treated as bare ID. No match. |

### 5.2 Performance: Minimize Agent Tree Traversal

| Test Case | Purpose | Expected Behavior |
|-----------|---------|-------------------|
| **no-tree-traversal-for-bare** | Bare agent lookup | matchAgentById works on flat agent list (readAllAgents returns flat list). No tree walking. |
| **no-tree-traversal-for-explicit** | @repo/agent lookup | Filters agents by repoPath, then matchAgentById on filtered list. No tree walking. |

---

## 6. Test Organization by Complexity

### 6.1 Unit Tests (isolated logic)

- `matchAgentById()`: exact match, prefix match, ambiguous, no match
- Regex validation: `^[a-zA-Z0-9_\-]+$` (for --name and reserved checks)
- Worktree path regex: `\/\.ittybitty\/agents\/[^/]+\/repo$`
- CWD-to-repo lookup (exact, prefix, worktree extraction)
- repoDisplayName (nickname > basename)

### 6.2 Integration Tests (resolveTarget with mocked file system)

- Mock repos with specific paths and names
- Mock agents with specific IDs and repoPaths
- Mock checkCoordinatorExists return values
- Test each addressing form with various agent configurations
- Verify error messages match expected format

### 6.3 End-to-End Tests (with real .ittybitty structure, optional)

- Create temporary repos with real .ittybitty/agents/ directories
- Real coordinator detection via checkCoordinatorExists
- Real agent metadata reading (via readAllAgents)
- Verify routing with real CWD changes

---

## 7. Testing Strategy Notes

### 7.1 Mock Points

1. `readAllAgents()` — inject agents with specific IDs, repoPaths, coordinator flags
2. `checkCoordinatorExists()` — inject return values for each repo
3. `process.cwd()` — override with test CWD values
4. `repoDisplayName()` — verify fallback to nickname, then basename

### 7.2 Assertion Pattern

For each test, verify:
1. **Correct return value** (agent object, coordinator flag, null)
2. **Correct error message** (exact string match, or regex pattern)
3. **No unexpected calls** (e.g., @system should not call readAllAgents)
4. **Isolation** (agent from Repo A is not returned when scoped to Repo B)
5. **Determinism** (same input, setup always produces same output)

### 7.3 Coverage Checklist

- [ ] All addressing forms: @system, @coordinator, @repo, @repo/agent, bare
- [ ] All CWD scenarios: exact match, prefix match, worktree, outside all repos
- [ ] All error cases: repo not found, agent not found, ambiguous, invalid input
- [ ] All naming validation: regex, reserved name, case sensitivity
- [ ] All coordinator lifecycle: create, rename, add repo, reserved name conflicts
- [ ] Multi-repo routing: same-repo first, global fallback, explicit scoping
- [ ] Edge cases: empty strings, whitespace, special chars, multiple slashes
