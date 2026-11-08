import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, chmod, readdir, readFile, lstat, realpath, rename, readlink, symlink } from "node:fs/promises";
import { join, resolve, dirname, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { readAllAgents, resetListTmuxSessionsCache } from "./agents";
import { rehireAgent, setRehireSpawnRunner, resetRehireSpawnRunner, setNukeResumeSpawnRunner, resetNukeResumeSpawnRunner } from "./ib-commands";
import { setUserHome, resetUserHome } from "./home";
import { spawnCtx as tmuxCtx } from "./tmux-poller";
import { makeSpawnResult } from "./test-utils";
import type { SpawnFn, SpawnResult } from "./types";

const script = resolve(import.meta.dir, "../scripts/update-repos.sh");
const fixtures: Fixture[] = [];
type Result = { code: number; out: string; err: string };

async function command(argv: string[], cwd: string, env: Record<string, string>): Promise<Result> {
  const child = Bun.spawn(argv, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}
async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, text);
}

class Fixture {
  root!: string;
  home!: string;
  repo!: string;
  second!: string;
  stubs!: string;
  env!: Record<string, string>;
  id = "ittybitty-agent";
  key = "20261107-120000-retired";
  head!: string;
  worktree!: string;
  nested!: string;
  admin!: string;
  staleAdmin!: string;
  transcript!: string;
  realTranscript!: string;
  newTranscript!: string;
  restores: string[] = [];

  async git(cwd: string, ...args: string[]) {
    const result = await command(["/usr/bin/git", "--no-optional-locks", ...args], cwd, this.env);
    if (result.code) throw new Error(`git ${args.join(" ")}: ${result.err}`);
    return result.out.trim();
  }
  async init(repo: string) {
    await mkdir(repo, { recursive: true });
    await this.git(repo, "init");
    await this.git(repo, "config", "user.name", "Migration Test");
    await this.git(repo, "config", "user.email", "test@example.com");
    await write(join(repo, ".gitignore"), ".ittybitty/\n.agents/hooks.json\n.agents/rules/ittybitty-agent.md\n.claude/\n");
    await write(join(repo, "tracked.txt"), "base\n");
    await this.git(repo, "add", ".gitignore", "tracked.txt");
    await this.git(repo, "commit", "-m", "base");
  }
  async setup() {
    // Keep the public /var spelling on macOS; Git repair writes /private/var.
    this.root = await mkdtemp(join(tmpdir(), "ib-update-repos-"));
    this.root = this.root.replace(/^\/private\/var\//, "/var/");
    this.home = join(this.root, "home");
    this.stubs = join(this.root, "stubs");
    this.repo = join(this.root, "ittybitty project");
    this.second = join(this.root, "second");
    for (const d of [this.home, this.stubs, join(this.root, "tmp")]) await mkdir(d, { recursive: true });
    this.env = {
      HOME: this.home, PATH: `${this.stubs}:/usr/bin:/bin`, TMPDIR: join(this.root, "tmp"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(this.root, "gitconfig"),
      GIT_CEILING_DIRECTORIES: this.root, STUB_ROOT: this.stubs, LC_ALL: "C",
    };
    await write(this.env.GIT_CONFIG_GLOBAL!, "");
    for (const name of ["tmux", "ps", "lsof"]) {
      await write(join(this.stubs, name), `#!/bin/sh\ncat "$STUB_ROOT/${name}.out"\ncat "$STUB_ROOT/${name}.err" >&2\nexit "$(cat "$STUB_ROOT/${name}.code")"\n`);
      await chmod(join(this.stubs, name), 0o755);
      await this.stub(name, "", 0);
    }
    await write(join(this.stubs, "ib"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$STUB_ROOT/ib.log"\nexit 97\n');
    await chmod(join(this.stubs, "ib"), 0o755);
    await write(join(this.stubs, "git"), `#!/bin/sh
printf '%s\n' "$*" >> "$STUB_ROOT/git.log"
case " $* " in
  *" gc "*|*" worktree prune "*|*" worktree remove "*) echo forbidden >&2; exit 98;;
esac
if [ -f "$STUB_ROOT/rev-fail" ]; then
  case " $* " in *" rev-parse "*) cat "$STUB_ROOT/rev-fail" >&2; exit 128;; esac
fi
if [ -f "$STUB_ROOT/repair-fail" ]; then
  case " $* " in *" worktree repair "*) echo 'injected repair failure' >&2; exit 1;; esac
fi
if [ -f "$STUB_ROOT/repair-noop" ]; then
  case " $* " in *" worktree repair "*) exit 0;; esac
fi
if [ -f "$STUB_ROOT/repair-unrelated-error" ]; then
  case " $* " in *" worktree repair "*) /usr/bin/git "$@"; echo 'unrelated admin entry is invalid' >&2; exit 1;; esac
fi
exec /usr/bin/git "$@"
`);
    await chmod(join(this.stubs, "git"), 0o755);
    await this.init(this.repo);
    await this.init(this.second);
    for (const repo of [this.repo, this.second]) await write(join(repo, ".ittybitty", "repo-id"), "1234abcd\n");
    await write(join(this.home, ".itsybitsy", "repos.json"), JSON.stringify({ repos: [{ path: this.repo, name: "project" }, { path: this.second, name: "second" }] }));
    await write(join(this.home, ".itsybitsy", "agent-types", "worker.md"), "IttyBitty worker in the ittybitty system\n");
    this.worktree = join(this.repo, ".ittybitty", "agents", this.id, "repo");
    await this.git(this.repo, "worktree", "add", this.worktree, "-b", `agent/${this.id}`);
    this.admin = await this.git(this.worktree, "rev-parse", "--path-format=absolute", "--git-dir");
    this.nested = join(this.worktree, ".claude", "worktrees", "wip");
    await this.git(this.repo, "worktree", "add", this.nested, "-b", "nested");
    for (const w of [this.worktree, this.nested]) {
      await write(join(w, "tracked.txt"), "staged\n");
      await this.git(w, "add", "tracked.txt");
    }
    const stale = join(this.repo, ".ittybitty", "agents", "gone", "repo");
    await this.git(this.repo, "worktree", "add", stale, "-b", "gone");
    this.staleAdmin = await this.git(stale, "rev-parse", "--path-format=absolute", "--git-dir");
    await rm(dirname(stale), { recursive: true });
    this.head = await this.git(this.repo, "rev-parse", "HEAD");
    const realRepo = await realpath(this.repo);
    expect(realRepo).not.toBe(this.repo);
    for (const dir of [join(this.repo, ".ittybitty", "agents", this.id), join(this.repo, ".ittybitty", "agents", "no-worktree"), join(this.repo, ".ittybitty", "archive", this.key), join(this.repo, ".ittybitty", "agents", this.id, ".retirement", "runtime")]) {
      const id = dir.includes("archive") ? "retired" : dir.endsWith("no-worktree") ? "no-worktree" : this.id;
      await write(join(dir, "meta.json"), JSON.stringify({ id, tmux_session: `ittybitty-1234abcd-${id}`, state: "stopped", created_epoch: 1, model: "codex:gpt-5.5", worktree: id !== "no-worktree", sandbox: { enabled: false, rawAllow: [], domains: [] } }));
      await write(join(dir, "start.sh"), `#!/bin/bash\n# ${this.worktree}\n# ${realRepo}/.ittybitty/agents/${this.id}/repo\n`);
      await chmod(join(dir, "start.sh"), 0o755);
      await write(join(dir, "exit-check.sh"), "#!/bin/bash\nexit 0\n");
      await write(join(dir, "resume.sh"), this.worktree);
      await write(join(dir, ".claude", "settings.local.json"), JSON.stringify({ path: this.worktree }));
    }
    await write(join(this.worktree, ".claude", "settings.local.json"), JSON.stringify({ path: this.worktree }));
    await write(join(this.worktree, ".agents", "rules", "ittybitty-agent.md"), "rule content\n");
    await write(join(this.worktree, ".agents", "hooks.json"), '{"ittybitty":{"hooks":{}}}\n');
    const archive = join(this.repo, ".ittybitty", "archive", this.key);
    await write(join(archive, "retirement.json"), JSON.stringify({ version: 1, agentId: "retired", retiredAt: "2026-11-07T12:00:00Z", repoPath: this.repo, archiveKey: this.key, worktree: true, gitHead: this.head, headRef: `refs/ittybitty/retired/${this.key}/head`, untrackedFiles: [], prunedTeams: [] }));
    await write(join(archive, "worktree.patch"), "");
    await this.git(this.repo, "update-ref", `refs/ittybitty/retired/${this.key}/head`, this.head);
    const enc = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
    this.transcript = join(this.home, ".claude", "projects", `${enc(this.repo)}--ittybitty-agents-${this.id}-repo`);
    this.realTranscript = join(this.home, ".claude", "projects", `${enc(realRepo)}--ittybitty-agents-${this.id}-repo`);
    this.newTranscript = this.transcript.replace("--ittybitty-agents-", "--itsybitsy-agents-");
    await write(join(this.transcript, "session.jsonl"), "history /.ittybitty/ stays untouched\n");
    await write(join(this.realTranscript, "session.jsonl"), "history /.ittybitty/ stays untouched\n");
    return this;
  }
  async stub(name: string, out: string, code: number, err = "") {
    await write(join(this.stubs, `${name}.out`), out);
    await write(join(this.stubs, `${name}.err`), err);
    await write(join(this.stubs, `${name}.code`), String(code));
  }
  async run(...args: string[]) {
    const result = await command(["/bin/bash", script, ...args], this.root, this.env);
    expect(await Bun.file(join(this.stubs, "ib.log")).exists()).toBe(false);
    const calls = await Bun.file(join(this.stubs, "git.log")).text().catch(() => "");
    expect(calls).not.toMatch(/(?:^|\s)gc(?:\s|$)|worktree (?:prune|remove)/);
    return { ...result, text: result.out + result.err };
  }
  moved(path: string) { return path.replace("/.ittybitty/", "/.itsybitsy/"); }
  async assertAdminLinks(ignored: string[] = []) {
    let checked = 0;
    for (const entry of await readdir(dirname(this.admin), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const admin = join(dirname(this.admin), entry.name);
      if (admin === this.staleAdmin || ignored.includes(admin)) continue;
      const back = (await Bun.file(join(admin, "gitdir")).text()).trim();
      expect(back).toContain("/.itsybitsy/");
      expect(back).not.toContain("/.ittybitty/");
      const forward = (await Bun.file(back).text()).trim();
      expect(forward).toStartWith("gitdir: ");
      expect(await realpath(resolve(dirname(back), forward.slice("gitdir: ".length)))).toBe(await realpath(admin));
      expect(await Bun.file(join(admin, "locked")).exists()).toBe(false);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2); // main agent and nested worktree
    expect(await Bun.file(join(this.staleAdmin, "gitdir")).text()).toContain("/.ittybitty/");
  }
  async snapshot() {
    const entries: Record<string, string> = {};
    const walk = async (dir: string) => {
      for (const name of (await readdir(dir)).sort()) {
        const file = join(dir, name);
        // The stub trace is test instrumentation; apply's audit log is an
        // intentional append-only side effect, separate from migrated data.
        if (file === this.stubs || file === join(this.home, ".itsybitsy", "migrations")) continue;
        const stat = await lstat(file);
        entries[relative(this.root, file)] = stat.isSymbolicLink() ? `link:${await readlink(file)}` : stat.isDirectory() ? `dir:${stat.mode & 0o777}` : `${stat.mode & 0o777}:${new Bun.CryptoHasher("sha256").update(await readFile(file)).digest("hex")}`;
        if (stat.isDirectory()) await walk(file);
      }
    };
    await walk(this.root);
    return entries;
  }
}

async function fixture() {
  const f = new Fixture(); fixtures.push(f); return f.setup();
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const path of f.restores) await chmod(path, 0o755).catch(() => {});
    if (f.root) await rm(f.root, { recursive: true, force: true });
  }
});

describe("update-repos.sh isolated migration", () => {
  test("dry run leaves all data and indexes byte-identical", async () => {
    const f = await fixture(); const before = await f.snapshot();
    const result = await f.run();
    expect(result.code).toBe(0);
    expect(result.out).toContain("would mv .ittybitty -> .itsybitsy");
    expect(result.out).toContain("would repair worktree");
    expect(result.out).toContain("would rename Claude transcript");
    expect(await f.snapshot()).toEqual(before);
  });

  test("apply preserves staged work, nested links, refs, modes and history; rerun is idempotent", async () => {
    const f = await fixture();
    await write(join(f.admin, "..", "..", "info", "exclude"), "*.log");
    await write(join(f.repo, "kept.log"), "ignored\n");
    const manifest = await Bun.file(join(f.repo, ".ittybitty", "archive", f.key, "retirement.json")).text();
    await write(join(dirname(f.worktree), ".start.sh.update-repos-tmp"), "interrupted write");
    const result = await f.run("--apply");
    expect(result.code, result.text).toBe(0);
    for (const w of [f.worktree, f.nested]) {
      expect(await f.git(f.moved(w), "rev-parse", "--show-toplevel")).toBe(await realpath(f.moved(w)));
      expect(await f.git(f.moved(w), "diff", "--cached", "--name-only")).toBe("tracked.txt");
      expect(await f.git(f.moved(w), "show", ":tracked.txt")).toBe("staged");
    }
    await f.assertAdminLinks();
    expect(await Bun.file(join(f.staleAdmin, "gitdir")).exists()).toBe(true);
    expect(await Bun.file(join(f.admin, "locked")).exists()).toBe(false);
    const active = f.moved(dirname(f.worktree));
    for (const d of [active, join(f.repo, ".itsybitsy", "archive", f.key), join(active, ".retirement", "runtime")]) {
      expect((await Bun.file(join(d, "meta.json")).json()).tmux_session).toStartWith("itsybitsy-1234abcd-");
      expect(await Bun.file(join(d, "start.sh")).text()).not.toContain("/.ittybitty/");
      expect((await lstat(join(d, "start.sh"))).mode & 0o777).toBe(0o755);
    }
    expect(await Bun.file(join(active, ".start.sh.update-repos-tmp")).exists()).toBe(false);
    expect(await Bun.file(join(f.repo, ".itsybitsy", "archive", f.key, "retirement.json")).text()).toBe(manifest);
    expect(await f.git(f.repo, "rev-parse", `refs/ittybitty/retired/${f.key}/head`)).toBe(f.head);
    expect(await f.git(f.repo, "for-each-ref", "--format=%(refname)", "refs/itsybitsy/")).toBe("");
    expect(await Bun.file(join(f.newTranscript, "session.jsonl")).text()).toContain("/.ittybitty/");
    const newRealTranscript = f.realTranscript.replace("--ittybitty-agents-", "--itsybitsy-agents-");
    expect(await Bun.file(join(newRealTranscript, "session.jsonl")).text()).toContain("/.ittybitty/");
    expect(await Bun.file(join(f.realTranscript, "session.jsonl")).exists()).toBe(false);
    expect(await Bun.file(join(f.moved(f.worktree), ".agents", "rules", "itsybitsy-agent.md")).text()).toBe("rule content\n");
    expect(await Bun.file(join(f.moved(f.worktree), ".agents", "hooks.json")).json()).toEqual({ itsybitsy: { hooks: {} } });
    expect(await f.git(f.repo, "status", "--porcelain")).toBe("");
    expect(await f.git(f.repo, "check-ignore", "kept.log")).toBe("kept.log");
    expect(await Bun.file(join(f.home, ".itsybitsy", "agent-types", "worker.md")).text()).toBe("ItsyBitsy worker in the itsybitsy system\n");
    expect(await readdir(join(f.home, ".itsybitsy", "agent-types"))).toEqual(["worker.md"]);
    const before = await f.snapshot(); const again = await f.run("--apply");
    expect(again.code, again.text).toBe(0);
    expect(again.out.match(/already migrated — nothing to do/g)).toHaveLength(2);
    expect(await f.snapshot()).toEqual(before);
    await write(join(active, ".start.sh.update-repos-tmp"), "interrupted old bytes");
    await write(join(f.home, ".itsybitsy", "agent-types", ".worker.md.update-repos-tmp"), "interrupted old prose");
    await write(join(f.repo, ".git", "info", ".exclude.update-repos-tmp"), "interrupted ignore");
    expect((await f.run("--apply")).code).toBe(0);
    expect(await f.snapshot()).toEqual(before);
  });

  test("initialized submodule remains usable after its worktree moves", async () => {
    const f = await fixture(); const source = join(f.root, "submodule-source");
    await f.init(source);
    await f.git(f.worktree, "-c", "protocol.file.allow=always", "submodule", "add", `file://${source}`, "module");
    await f.git(f.worktree, "-c", "protocol.file.allow=always", "submodule", "add", `file://${source}`, "logs");
    const moduleGit = await f.git(join(f.worktree, "module"), "rev-parse", "--absolute-git-dir");
    const logsGit = await f.git(join(f.worktree, "logs"), "rev-parse", "--absolute-git-dir");
    await write(join(moduleGit, "refs", "heads", "config"), f.head + "\n");
    await write(join(moduleGit, "logs", "refs", "heads", "config"), "not a git config\n");
    await mkdir(join(moduleGit, "branches", "config"), { recursive: true });
    const before = await f.git(f.worktree, "diff", "--cached", "--name-only");
    const result = await f.run("--apply"); expect(result.code, result.text).toBe(0);
    expect(await f.git(join(f.moved(f.worktree), "module"), "status", "--porcelain")).toBe("");
    expect(await f.git(join(f.moved(f.worktree), "logs"), "status", "--porcelain")).toBe("");
    const logsWorktree = await f.git(f.repo, "config", "--file", join(logsGit, "config"), "--get", "core.worktree");
    expect(logsWorktree).toContain("/.itsybitsy/agents/");
    expect(logsWorktree).not.toContain("/.ittybitty/");
    expect(await f.git(f.moved(f.worktree), "diff", "--cached", "--name-only")).toBe(before);
    expect(await Bun.file(join(moduleGit, "refs", "heads", "config")).text()).toBe(f.head + "\n");
  });

  test("a malformed submodule config does not block later config rewrites", async () => {
    const f = await fixture();
    const modules = join(f.admin, "modules");
    for (const name of ["aaa", "zzz"]) await write(join(modules, name, "HEAD"), "ref: refs/heads/main\n");
    await write(join(modules, "aaa", "config"), "[broken\n");
    await write(join(modules, "zzz", "config"), `[core]\n\tworktree = ${f.worktree}/module\n`);
    const result = await f.run("--apply");
    expect(result.code).toBe(1);
    expect(result.out).toContain("read submodule config:");
    expect(await Bun.file(join(modules, "zzz", "config")).text()).toContain(f.moved(f.worktree));
    await f.assertAdminLinks();
  });

  for (const interrupted of ["move", "exclude"]) {
    test(`finishes interrupted ${interrupted} stage`, async () => {
      const f = await fixture();
      if (interrupted === "move") await rename(join(f.repo, ".ittybitty"), join(f.repo, ".itsybitsy"));
      else await write(join(f.repo, ".git", "info", "exclude"), ".itsybitsy/\n.agents/rules/itsybitsy-agent.md\n");
      const result = await f.run("--apply"); expect(result.code, result.text).toBe(0);
      expect(await f.git(f.moved(f.worktree), "rev-parse", "--show-toplevel")).toBe(await realpath(f.moved(f.worktree)));
      await f.assertAdminLinks();
    });
  }

  for (const realData of [false, true]) {
    test(`both dirs: ${realData ? "ordered merge guidance" : "repo-id-only removal hint"}; continues other repos`, async () => {
      const f = await fixture();
      await write(join(f.repo, ".itsybitsy", "repo-id"), "deadbeef\n");
      if (realData) await write(join(f.repo, ".itsybitsy", "agents", "new", "meta.json"), "{}");
      const result = await f.run("--apply"); expect(result.code).toBe(1);
      expect(result.out).toContain("Keep this repo registered");
      expect(result.out).not.toContain("ib remove");
      if (realData) {
        expect(result.out).toContain("1 agents");
        expect(result.out.indexOf("(1) Keep OLD")).toBeLessThan(result.out.indexOf("(2) Keep the repo"));
        expect(result.out.indexOf("(2) Keep the repo")).toBeLessThan(result.out.indexOf("(3) Set aside"));
        expect(result.out).not.toContain("remove NEW:");
      } else expect(result.out).toContain("remove NEW: rm -rf");
      expect(await Bun.file(join(f.second, ".itsybitsy", "repo-id")).exists()).toBe(true);
      expect(await Bun.file(join(f.repo, ".ittybitty", "repo-id")).exists()).toBe(true);
    });
  }

  test("failed repair stays locked across reruns; verified manual repair unlocks only our exact reason", async () => {
    const f = await fixture();
    await write(join(f.stubs, "repair-fail"), "1");
    // Broken forward link makes the failure persistent rather than merely a
    // transient command failure.
    await write(join(f.worktree, ".git"), `gitdir: ${f.repo}/.git/worktrees/missing\n`);
    const first = await f.run("--apply"); expect(first.code).toBe(1);
    expect(first.text).toContain("injected repair failure");
    expect(first.out).toContain("Manual repair: git -C");
    expect(first.out).toContain("worktree unlock");
    expect(await Bun.file(join(f.admin, "locked")).text()).toBe("update-repos.sh: repair failed\n");
    expect(await Bun.file(join(f.second, ".itsybitsy", "repo-id")).exists()).toBe(true);
    await rm(join(f.stubs, "repair-fail"));
    expect((await f.run("--apply")).code).toBe(1);
    // Moving only the back-link is not a completed manual repair: the forward
    // .git still names a nonexistent admin directory, so our lock must remain.
    await write(join(f.admin, "gitdir"), join(f.moved(f.worktree), ".git") + "\n");
    const incomplete = await f.run("--apply");
    expect(incomplete.code).toBe(1);
    expect(incomplete.out).toContain("previous repair failure still unresolved");
    expect(await Bun.file(join(f.admin, "locked")).exists()).toBe(true);
    await write(join(f.moved(f.worktree), ".git"), `gitdir: ${f.admin}\n`);
    await f.git(f.repo, "worktree", "repair", f.moved(f.worktree), f.moved(f.nested));
    const before = await f.snapshot(); const dry = await f.run();
    expect(dry.code, dry.text).toBe(0); expect(dry.out).toContain("worktree unlock");
    expect(await f.snapshot()).toEqual(before);
    const fixed = await f.run("--apply"); expect(fixed.code, fixed.text).toBe(0);
    expect(fixed.out).toContain("unlocked (repaired by hand)");
    expect(await Bun.file(join(f.admin, "locked")).exists()).toBe(false);
    for (const reason of ["someone else\n", "update-repos.sh: repair failed\nextra\n", "update-repos.sh: repair failed\n\n"]) {
      await write(join(f.admin, "locked"), reason);
      expect((await f.run("--apply")).code).toBe(0);
      expect(await Bun.file(join(f.admin, "locked")).text()).toBe(reason);
    }
  });

  test("relative OLD gitdir is locked and reported, never pruned", async () => {
    const f = await fixture();
    await write(join(f.admin, "gitdir"), relative(f.admin, join(f.worktree, ".git")) + "\n");
    const result = await f.run("--apply"); expect(result.code).toBe(1);
    expect(result.text).toContain("relative gitdir");
    expect(await Bun.file(join(f.admin, "locked")).exists(), result.text).toBe(true);
    await write(join(f.admin, "gitdir"), relative(f.admin, join(f.moved(f.worktree), ".git")) + "\n");
    const dry = await f.run();
    expect(dry.code, dry.text).toBe(0);
    expect(dry.out).toContain("worktree unlock");
    const fixed = await f.run("--apply");
    expect(fixed.code, fixed.text).toBe(0);
    expect(fixed.out).toContain("unlocked (repaired by hand)");
    expect(await Bun.file(join(f.admin, "locked")).exists()).toBe(false);
  });

  test("a successful no-op repair is detected by link verification and locked", async () => {
    const f = await fixture();
    await write(join(f.stubs, "repair-noop"), "1");
    const result = await f.run("--apply");
    expect(result.code, result.text).toBe(1);
    expect(result.out).toContain("repair failed:");
    expect(result.out).toContain("admin entry:");
    expect(result.out).toContain("Manual repair: git -C");
    for (const entry of await readdir(dirname(f.admin), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const admin = join(dirname(f.admin), entry.name);
      if (admin === f.staleAdmin) continue;
      expect(await Bun.file(join(admin, "gitdir")).text()).toContain("/.ittybitty/");
      expect(await Bun.file(join(admin, "locked")).text()).toBe("update-repos.sh: repair failed\n");
    }
  });

  test("verified repairs succeed even when Git reports an unrelated admin error", async () => {
    const f = await fixture();
    await write(join(f.stubs, "repair-unrelated-error"), "1");
    const result = await f.run("--apply");
    expect(result.code, result.text).toBe(0);
    expect(result.out).toContain("unrelated admin entry is invalid");
    await f.assertAdminLinks();
  });

  test("stray files and symlinks are skipped without errors or changes to their targets", async () => {
    const f = await fixture();
    const outside = join(f.root, "untouched");
    await write(join(outside, "meta.json"), '{"tmux_session":"ittybitty-1234abcd-untouched"}');
    const outsideGitdir = join(f.worktree, ".git") + "\n";
    await write(join(outside, "gitdir"), outsideGitdir);
    const oldDirs = [join(f.repo, ".ittybitty", "agents"), join(f.repo, ".ittybitty", "archive"), dirname(f.admin)];
    for (const dir of oldDirs) {
      await write(join(dir, ".DS_Store"), "Finder metadata");
      await symlink(outside, join(dir, "000-symlink"));
    }
    const result = await f.run("--apply");
    expect(result.code, result.text).toBe(0);
    expect(result.out).not.toMatch(/^\s*ERROR /m);
    for (const dir of oldDirs) {
      const moved = f.moved(dir);
      expect(await Bun.file(join(moved, ".DS_Store")).text()).toBe("Finder metadata");
      expect((await lstat(join(moved, "000-symlink"))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(moved, "000-symlink"))).toBe(outside);
    }
    expect(await Bun.file(join(outside, "meta.json")).text()).toBe('{"tmux_session":"ittybitty-1234abcd-untouched"}');
    expect(await Bun.file(join(outside, "gitdir")).text()).toBe(outsideGitdir);
    expect(await Bun.file(join(outside, "locked")).exists()).toBe(false);
    await f.assertAdminLinks();
  });

  test("malformed metadata and an unreadable admin entry do not block other entries", async () => {
    const f = await fixture();
    const bad = join(f.repo, ".ittybitty", "agents", "000-malformed");
    await write(join(bad, "meta.json"), "{broken");
    await write(join(bad, "start.sh"), f.worktree);
    const unreadable = join(dirname(f.admin), "000-unreadable");
    await write(join(unreadable, "gitdir"), "/unreadable/.git\n");
    await chmod(join(unreadable, "gitdir"), 0);
    f.restores.push(join(unreadable, "gitdir"));
    const result = await f.run("--apply");
    expect(result.code).toBe(1);
    expect(result.out).toContain("malformed meta.json");
    expect(result.out).toContain("000-unreadable");
    await f.assertAdminLinks([unreadable]);
    for (const dir of [f.moved(dirname(f.worktree)), join(f.repo, ".itsybitsy", "agents", "no-worktree"), join(f.repo, ".itsybitsy", "archive", f.key)]) {
      expect((await Bun.file(join(dir, "meta.json")).json()).tmux_session).toStartWith("itsybitsy-");
      for (const file of ["start.sh", "resume.sh", ".claude/settings.local.json"]) {
        expect(await Bun.file(join(dir, file)).text()).not.toContain("/.ittybitty/");
      }
    }
    expect(await Bun.file(join(f.moved(f.worktree), ".agents", "rules", "itsybitsy-agent.md")).exists()).toBe(true);
    expect(await Bun.file(join(f.moved(f.worktree), ".agents", "hooks.json")).json()).toEqual({ itsybitsy: { hooks: {} } });
    expect(await Bun.file(join(f.moved(bad), "meta.json")).text()).toBe("{broken");
    expect(await Bun.file(join(f.moved(bad), "start.sh")).text()).toBe(f.worktree);
    expect(await Bun.file(join(f.newTranscript, "session.jsonl")).exists()).toBe(true);
  });

  for (const mode of ["parent-stat", "runtime-stat", "git-error", "not-git-worktree"]) {
    test(`fail-closed classification: ${mode}`, async () => {
      const f = await fixture();
      if (mode === "parent-stat") {
        const parent = join(f.root, "denied"); await mkdir(parent); f.restores.push(parent);
        await write(join(f.home, ".itsybitsy", "repos.json"), JSON.stringify({ repos: [{ path: join(parent, "repo") }] }));
        await chmod(parent, 0);
      } else if (mode === "runtime-stat") { f.restores.push(f.repo); await chmod(f.repo, 0); }
      else await write(join(f.stubs, "rev-fail"), mode === "git-error" ? "fatal: permission denied" : "fatal: not a git repository");
      const result = await f.run("--apply"); expect(result.code, result.text).toBe(1);
      expect(result.text).toContain("ERROR");
      expect(result.text).not.toContain("missing — skipped");
      expect(result.text).not.toContain("no runtime dir — skipped");
      for (const path of f.restores) await chmod(path, 0o755);
      if (mode !== "parent-stat") expect(await Bun.file(join(f.repo, ".ittybitty", "repo-id")).exists()).toBe(true);
    });
  }

  test("absent, non-git and no-runtime positive classifications; HOME refusal", async () => {
    const f = await fixture();
    const absent = join(f.root, "offline repo"); const plain = join(f.root, "plain"); const empty = join(f.root, "empty");
    await write(join(plain, ".ittybitty", "repo-id"), "plain"); await f.init(empty);
    const result = await f.run("--apply", absent, plain, empty, f.home);
    expect(result.code).toBe(1);
    expect(result.out).toContain("missing — skipped"); expect(result.out).toContain("no runtime dir");
    expect(result.out).toContain(`--apply '${absent}'`);
    expect(result.out).toContain("repo is $HOME; ib remove");
    expect(await Bun.file(join(plain, ".itsybitsy", "repo-id")).text()).toBe("plain");
  });

  test("failed move leaves records and transcripts untouched and gives keep-registered advice", async () => {
    const f = await fixture(); f.restores.push(f.repo); await chmod(f.repo, 0o555);
    const meta = await Bun.file(join(dirname(f.worktree), "meta.json")).text();
    const result = await f.run("--apply"); expect(result.code).toBe(1);
    expect(result.text).toContain("move failed"); expect(result.out).toContain("Keep this repo registered");
    expect(await Bun.file(join(dirname(f.worktree), "meta.json")).text()).toBe(meta);
    expect(await Bun.file(join(f.transcript, "session.jsonl")).exists()).toBe(true);
    expect(await Bun.file(join(f.newTranscript, "session.jsonl")).exists()).toBe(false);
  });

  for (const blocker of ["old-tmux", "new-tmux", "coordinator", "tmux-error", "ib-process", "old-cwd", "new-cwd", "lsof-error"]) {
    test(`preflight ${blocker} writes nothing`, async () => {
      const f = await fixture();
      if (blocker === "old-tmux") await f.stub("tmux", "ittybitty-1234abcd-a\n", 0);
      if (blocker === "new-tmux") await f.stub("tmux", "itsybitsy-1234abcd-a\n", 0);
      if (blocker === "coordinator") await f.stub("tmux", "ib-coordinator\n", 0);
      if (blocker === "tmux-error") await f.stub("tmux", "", 1, "unexpected socket error");
      if (blocker === "ib-process") await f.stub("ps", "123 /usr/local/bin/ib watch\n", 0);
      if (blocker.endsWith("cwd")) await f.stub("lsof", `p123\nn${blocker === "old-cwd" ? f.worktree : f.moved(f.worktree)}\n`, 0);
      if (blocker === "lsof-error") await f.stub("lsof", "", 1, "denied");
      const before = await f.snapshot(); const result = await f.run("--apply");
      expect(result.code, result.text).toBe(2); expect(await f.snapshot()).toEqual(before);
      expect(await Bun.file(join(f.home, ".itsybitsy", "migrations")).exists()).toBe(false);
    });
  }

  test("no tmux server passes; tracked OLD file warns; missing info directory is created", async () => {
    const f = await fixture();
    await f.stub("tmux", "", 1, "no server running");
    await f.git(f.repo, "add", "-f", ".ittybitty/repo-id");
    await f.git(f.repo, "commit", "-m", "tracked runtime id");
    await rm(join(f.repo, ".git", "info"), { recursive: true });
    const result = await f.run("--apply"); expect(result.code, result.text).toBe(0);
    expect(result.out).toContain("rm -r --cached .ittybitty");
    expect(await Bun.file(join(f.repo, ".git", "info", "exclude")).text()).toContain(".itsybitsy/\n");
  });

  test("explicit unregistered path migrates fully and prints the given spelling", async () => {
    const f = await fixture(); await write(join(f.home, ".itsybitsy", "repos.json"), '{"repos":[]}');
    const given = f.repo + "/.";
    const result = await f.run("--apply", given); expect(result.code, result.text).toBe(0);
    expect(result.out).toContain(`'${given}'`);
    expect(await f.git(f.moved(f.worktree), "rev-parse", "--show-toplevel")).toBe(await realpath(f.moved(f.worktree)));
    await f.assertAdminLinks();
    expect(await Bun.file(join(f.newTranscript, "session.jsonl")).exists()).toBe(true);
    expect((await Bun.file(join(f.moved(dirname(f.worktree)), "meta.json")).json()).tmux_session).toBe(`itsybitsy-1234abcd-${f.id}`);
  });

  for (const scenario of ["empty-new", "populated-new", "tracked-old"]) {
    test(`subdirectory registration recovery commands use the git root: ${scenario}`, async () => {
      const f = await fixture();
      const given = join(f.repo, "subdirectory");
      await mkdir(given);
      await write(join(f.home, ".itsybitsy", "repos.json"), JSON.stringify({ repos: [{ path: given }] }));
      const root = await realpath(f.repo);
      if (scenario === "tracked-old") {
        await f.git(f.repo, "add", "-f", ".ittybitty/repo-id");
        const result = await f.run("--apply");
        expect(result.code, result.text).toBe(0);
        expect(result.out).toContain(`git -C '${root}' rm -r --cached .ittybitty`);
        expect(result.out).not.toContain(`git -C '${given}' rm -r --cached`);
        expect(result.out).toContain(`'${given}'`);
        await f.assertAdminLinks();
      } else {
        await write(join(f.repo, ".itsybitsy", "repo-id"), "other-id");
        if (scenario === "populated-new") await write(join(f.repo, ".itsybitsy", "agents", "new", "meta.json"), "{}");
        const result = await f.run("--apply");
        expect(result.code).toBe(1);
        expect(result.out).toContain(`rm -rf '${root}/.itsybitsy'`);
        expect(result.out).not.toContain(`rm -rf '${given}/.itsybitsy'`);
        expect(result.out).toContain(`/bin/bash scripts/update-repos.sh --apply '${given}'`);
      }
    });
  }

  test("new code reads migrated agents and rehires the unchanged legacy ref", async () => {
    const f = await fixture();
    const result = await f.run("--apply"); expect(result.code, result.text).toBe(0);
    const originalRunner = tmuxCtx.runner;
    setUserHome(f.home);
    tmuxCtx.set(() => makeSpawnResult(1));
    resetListTmuxSessionsCache();
    const runner: SpawnFn = (cmd) => {
      if (cmd[0] === "git") return Bun.spawn(["/usr/bin/git", ...cmd.slice(1)], { env: f.env, stdout: "pipe", stderr: "pipe" }) as SpawnResult;
      return makeSpawnResult(cmd[0] === "tmux" && cmd.includes("has-session") ? 1 : 0);
    };
    setRehireSpawnRunner(runner); setNukeResumeSpawnRunner(runner);
    try {
      const read = await readAllAgents([{ path: f.repo, name: "project" }], true);
      expect(read.errors).toEqual([]);
      expect(read.agents.map(a => a.id).sort()).toEqual([f.id, "no-worktree", "retired"].sort());
      const rehired = await rehireAgent("retired", { repoPath: f.repo });
      expect(rehired.stdout, rehired.stderr).toContain("Reconstructed stopped agent");
      expect(rehired.stderr).toContain("codex_session_id");
      expect(await f.git(join(f.repo, ".itsybitsy", "agents", "retired", "repo"), "rev-parse", "HEAD")).toBe(f.head);
      expect(await f.git(f.repo, "rev-parse", `refs/ittybitty/retired/${f.key}/head`)).toBe(f.head);
    } finally {
      resetUserHome(); tmuxCtx.set(originalRunner); resetListTmuxSessionsCache();
      resetRehireSpawnRunner(); resetNukeResumeSpawnRunner();
    }
  });
});
