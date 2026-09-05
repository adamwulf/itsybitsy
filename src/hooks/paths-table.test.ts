import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { setUserHome, resetUserHome } from "../home";
import {
  agentPathAccessTable,
  buildAgentAccessTable,
  buildSystemAccessTable,
  claudeProjectDirFor,
  claudeScratchpadDirFor,
  pathDenialReason,
} from "./paths-table";
import {
  generateProfile,
  prepareAccessTable,
  resolvePathAccess,
  resolvePreparedAccess,
  type PathsConfig,
  type SandboxConfig,
  type SandboxProfileParams,
} from "../sandbox";
import { parseDenials } from "../agents";

const AGENT_DIR = "/repo/.ittybitty/agents/agent-abc123";
const WORKTREE = `${AGENT_DIR}/repo`;
const AGENTS_DIR = "/repo/.ittybitty/agents";
const ROOT_REPO = "/repo";
const UID = process.getuid?.() ?? 0;

/** Build a raw PathAccessTable for the fixture agent from a partial paths config. */
function table(
  paths: Partial<PathsConfig> = {},
  opts: { canSpawnChildren?: boolean; tmuxSock?: string } = {},
) {
  return agentPathAccessTable({
    paths: { allowRead: [], allowWrite: [], deny: [], ...paths },
    agentDir: AGENT_DIR,
    worktreePath: WORKTREE,
    agentsDir: AGENTS_DIR,
    rootRepo: ROOT_REPO,
    gitDir: "/repo/.git",
    tmuxSock: opts.tmuxSock ?? "/private/tmp/tmux-501",
    canSpawnChildren: opts.canSpawnChildren ?? false,
  });
}

// ── Parity: the prepared resolver and the one-shot resolver agree ────────────

describe("agentPathAccessTable — resolver parity", () => {
  test("resolvePreparedAccess == resolvePathAccess for every fixture row", () => {
    const raw = table({
      allowRead: ["/data/ro"],
      allowWrite: ["/data/rw"],
      deny: ["/data/rw/secret"],
    });
    const prepared = prepareAccessTable(raw);
    const fixtures: Array<[string, "read" | "write"]> = [
      [`${WORKTREE}/src/x.ts`, "read"],
      [`${WORKTREE}/src/x.ts`, "write"],
      ["/etc/passwd", "read"],
      ["/etc/passwd", "write"],
      ["/data/ro/a", "read"],
      ["/data/ro/a", "write"],
      ["/data/rw/a", "read"],
      ["/data/rw/a", "write"],
      ["/data/rw/secret/a", "read"],
      ["/data/rw/secret/a", "write"],
    ];
    for (const [p, op] of fixtures) {
      expect(resolvePreparedAccess(prepared, p, op)).toBe(resolvePathAccess(p, op, raw));
    }
  });
});

// ── buildAgentAccessTable (from a meta object) ───────────────────────────────

describe("buildAgentAccessTable", () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "paths-table-")); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  async function build(meta: Record<string, unknown>) {
    const worktreePath = join(tmp, "repo");
    await mkdir(worktreePath, { recursive: true });
    return buildAgentAccessTable({
      meta,
      agentDir: tmp,
      worktreePath,
      agentsDir: join(tmp, "agents"),
      rootRepo: tmp,
      home: tmp,
    });
  }

  test("meta WITHOUT a paths key: worktree allowed, outside denied (strict)", async () => {
    const prepared = await build({ agentType: "worker" });
    const worktreePath = join(tmp, "repo");
    expect(resolvePreparedAccess(prepared, join(worktreePath, "x.ts"), "write")).toBe("allow");
    expect(resolvePreparedAccess(prepared, "/etc/passwd", "read")).toBe("deny");
  });

  test("meta WITH an empty paths block: identical to a missing key (strict)", async () => {
    const prepared = await build({ agentType: "worker", paths: { allowRead: [], allowWrite: [], deny: [] } });
    const worktreePath = join(tmp, "repo");
    expect(resolvePreparedAccess(prepared, join(worktreePath, "x.ts"), "write")).toBe("allow");
    expect(resolvePreparedAccess(prepared, "/etc/passwd", "read")).toBe("deny");
  });

  test("meta.paths.allowRead widens reads only", async () => {
    const prepared = await build({ agentType: "worker", paths: { allowRead: ["/data/ro"], allowWrite: [], deny: [] } });
    expect(resolvePreparedAccess(prepared, "/data/ro/f", "read")).toBe("allow");
    expect(resolvePreparedAccess(prepared, "/data/ro/f", "write")).toBe("deny");
  });

  test.each(["claude:opus", "codex:gpt-5.6-sol", "fugu:fugu", "agy:default"])(
    "%s grants only its CLI runtime directories", async (model) => {
      const prepared = await build({ agentType: "worker", model });
      const worktreePath = join(tmp, "repo");
      const expected = model.startsWith("claude:") ? "allow" : "deny";
      expect(resolvePreparedAccess(prepared, claudeProjectDirFor(worktreePath), "write")).toBe(expected);
      expect(resolvePreparedAccess(prepared, claudeScratchpadDirFor(worktreePath, UID), "write")).toBe(expected);
    },
  );
});

// ── buildSystemAccessTable (@system, no meta.json) ───────────────────────────

describe("buildSystemAccessTable", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paths-sys-"));
    setUserHome(home);
    const typesDir = join(home, ".itsybitsy", "agent-types");
    await mkdir(typesDir, { recursive: true });
    await writeFile(
      join(typesDir, "_all.md"),
      "---\nname: _all\ndescription: shared\nspawnable: false\npaths:\n  allowRead:\n    - \"~/shared\"\n---\n",
    );
    await writeFile(
      join(typesDir, "system.md"),
      "---\nname: system\ndescription: system coord\nspawnable: false\n---\n",
    );
  });
  afterEach(async () => { resetUserHome(); await rm(home, { recursive: true, force: true }); });

  test("roots at <home>/.itsybitsy and honors the merged _all layer paths", async () => {
    const prepared = await buildSystemAccessTable(home);
    // WORKTREE root = <home>/.itsybitsy
    expect(resolvePreparedAccess(prepared, join(home, ".itsybitsy", "teams.json"), "write")).toBe("allow");
    // _all.md allowRead ~/shared → read allowed, write denied
    expect(resolvePreparedAccess(prepared, join(home, "shared", "f"), "read")).toBe("allow");
    expect(resolvePreparedAccess(prepared, join(home, "shared", "f"), "write")).toBe("deny");
    // Anything else is denied (never permissive).
    expect(resolvePreparedAccess(prepared, "/etc/passwd", "read")).toBe("deny");
  });

  test("a layer that fails to load yields a strict table, never permissive", async () => {
    // Remove the agent-types dir so loadAgentType cannot find the files.
    await rm(join(home, ".itsybitsy", "agent-types"), { recursive: true, force: true });
    const prepared = await buildSystemAccessTable(home);
    expect(resolvePreparedAccess(prepared, "/etc/passwd", "read")).toBe("deny");
    // Its own home root still resolves (a runtime root, not a paths entry).
    expect(resolvePreparedAccess(prepared, join(home, ".itsybitsy", "x"), "write")).toBe("allow");
  });
});

// ── Spawn-keyed roots (REPOAGENTS, PARENTCLAUDE) at the table level ──────────

describe("agentPathAccessTable — spawn-keyed runtime roots", () => {
  test("REPOAGENTS is a write root only for a spawner", () => {
    const child = `${AGENTS_DIR}/agent-child/meta.json`;
    const spawner = prepareAccessTable(table({}, { canSpawnChildren: true }));
    const worker = prepareAccessTable(table({}, { canSpawnChildren: false }));
    expect(resolvePreparedAccess(spawner, child, "write")).toBe("allow");
    expect(resolvePreparedAccess(spawner, child, "read")).toBe("allow");
    // A non-spawner has REPOAGENTS as a READ root: write is denied, read allowed.
    expect(resolvePreparedAccess(worker, child, "write")).toBe("deny");
    expect(resolvePreparedAccess(worker, child, "read")).toBe("allow");
  });

  test("PARENTCLAUDE (<repo>/.claude) is a write root only for a spawner", () => {
    const target = `${ROOT_REPO}/.claude/settings.local.json`;
    const spawner = prepareAccessTable(table({}, { canSpawnChildren: true }));
    const worker = prepareAccessTable(table({}, { canSpawnChildren: false }));
    expect(resolvePreparedAccess(spawner, target, "write")).toBe("allow");
    expect(resolvePreparedAccess(worker, target, "write")).toBe("deny");
    expect(resolvePreparedAccess(worker, target, "read")).toBe("deny");
  });
});

// ── tmux socket deny (non-spawner) vs kept (spawner) ─────────────────────────

describe("agentPathAccessTable — tmux socket deny", () => {
  const TMUX = "/private/tmp/tmux-501";
  const sock = `${TMUX}/default`;

  test("denied for a non-spawner even when /private/tmp is writable", () => {
    const worker = prepareAccessTable(
      table({ allowWrite: ["/private/tmp"] }, { canSpawnChildren: false, tmuxSock: TMUX }),
    );
    expect(resolvePreparedAccess(worker, sock, "write")).toBe("deny");
    expect(resolvePreparedAccess(worker, sock, "read")).toBe("deny");
    // A sibling under /private/tmp (not the tmux dir) stays writable.
    expect(resolvePreparedAccess(worker, "/private/tmp/other/x", "write")).toBe("allow");
  });

  test("kept for a spawner (accepted escape): /private/tmp write covers it", () => {
    const spawner = prepareAccessTable(
      table({ allowWrite: ["/private/tmp"] }, { canSpawnChildren: true, tmuxSock: TMUX }),
    );
    expect(resolvePreparedAccess(spawner, sock, "write")).toBe("allow");
  });
});

// ── Canonicalization: /tmp and /private/tmp resolve identically ──────────────

describe("agentPathAccessTable — canonicalization", () => {
  test("/tmp/x and /private/tmp/x resolve identically", () => {
    const prepared = prepareAccessTable(table({ allowWrite: ["/private/tmp/shared"] }));
    expect(resolvePreparedAccess(prepared, "/tmp/shared/f", "write")).toBe("allow");
    expect(resolvePreparedAccess(prepared, "/private/tmp/shared/f", "write")).toBe("allow");
  });
});

// ── deny inside the worktree beats the worktree runtime allow (§6.10) ────────

describe("agentPathAccessTable — deny wins inside the worktree", () => {
  test("deny **/.env denies <worktree>/.env for read AND write; <worktree>/src/x stays allowed", () => {
    const prepared = prepareAccessTable(table({ deny: ["**/.env"] }));
    expect(resolvePreparedAccess(prepared, `${WORKTREE}/.env`, "read")).toBe("deny");
    expect(resolvePreparedAccess(prepared, `${WORKTREE}/.env`, "write")).toBe("deny");
    expect(resolvePreparedAccess(prepared, `${WORKTREE}/src/x.ts`, "write")).toBe("allow");
  });
});

// ── Runtime roots: worktree, agent.log dir, project dir, scratchpad (empty) ──

describe("agentPathAccessTable — runtime roots allowed with EMPTY paths lists", () => {
  test("worktree, own agent dir (agent.log), project dir and scratchpad all resolve", () => {
    const prepared = prepareAccessTable(table());
    expect(resolvePreparedAccess(prepared, `${WORKTREE}/x`, "write")).toBe("allow");
    // agent.log lives directly under the agent dir (AGENTDIR runtime root).
    expect(resolvePreparedAccess(prepared, `${AGENT_DIR}/agent.log`, "write")).toBe("allow");
    const projectDir = claudeProjectDirFor(WORKTREE);
    expect(resolvePreparedAccess(prepared, `${projectDir}/session.jsonl`, "write")).toBe("allow");
    const scratch = claudeScratchpadDirFor(WORKTREE, UID);
    expect(resolvePreparedAccess(prepared, `${scratch}/tmp.txt`, "write")).toBe("allow");
  });
});

// ── pathDenialReason wording ─────────────────────────────────────────────────

describe("pathDenialReason", () => {
  test("no matching allow entry", () => {
    const prepared = prepareAccessTable(table());
    const reason = pathDenialReason(prepared, "/etc/passwd", "read");
    expect(reason).toContain("is not in paths.allowRead/allowWrite");
    expect(reason).toContain("read");
  });

  test("a deny entry match", () => {
    const prepared = prepareAccessTable(table({ deny: ["**/.env"] }));
    const reason = pathDenialReason(prepared, `${WORKTREE}/.env`, "write");
    expect(reason).toContain("matches a paths.deny entry");
    expect(reason).toContain("write");
  });
});

// ── generateProfile: byte-identical when SCRATCHPAD/PROJECTDIR absent ────────

describe("generateProfile — optional PROJECTDIR/SCRATCHPAD roots", () => {
  const config: SandboxConfig = { enabled: true, rawAllow: [], domains: [] };
  const paths: PathsConfig = { allowRead: [], allowWrite: [], deny: [] };
  const base: SandboxProfileParams = {
    AGENTDIR: AGENT_DIR,
    WORKTREE,
    GITDIR: "/repo/.git",
    REPOAGENTS: AGENTS_DIR,
    PARENTCLAUDE: "/repo/.claude",
    TMUXSOCK: "/private/tmp/tmux-501",
    canSpawnChildren: false,
  };

  test("output is byte-identical whether the fields are absent or explicitly undefined", () => {
    const withUndefined: SandboxProfileParams = { ...base, PROJECTDIR: undefined, SCRATCHPAD: undefined };
    expect(generateProfile(config, paths, withUndefined)).toBe(generateProfile(config, paths, base));
  });

  test("present roots add rows and are emitted like the other params", () => {
    const withRoots: SandboxProfileParams = {
      ...base,
      PROJECTDIR: "/some/project",
      SCRATCHPAD: "/private/tmp/claude-501/x",
    };
    const out = generateProfile(config, paths, withRoots);
    expect(out).not.toBe(generateProfile(config, paths, base));
    expect(out).toContain('param "PROJECTDIR"');
    expect(out).toContain('param "SCRATCHPAD"');
  });
});

// ── parseDenials still matches the new denial log line ───────────────────────

describe("parseDenials compatibility", () => {
  test("the new '[PreToolUse] Permission denied: <tool><suffix> — <reason>' line is parsed", () => {
    const line =
      "[2026-09-05 12:00:00] [PreToolUse] Permission denied: Write (file_path=/x) — " +
      "Access denied: write /x is not in paths.allowRead/allowWrite";
    const denials = parseDenials([line]);
    expect(denials.length).toBe(1);
    expect(denials[0]!.line).toBe(line);
  });
});
