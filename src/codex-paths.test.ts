import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexPathGrants } from "./codex-paths";
import { prepareAccessTable, orderedEntryMatches, resolvePreparedAccess, type PathsConfig } from "./sandbox";

let root: string;
const paths = (allowRead: string[] = [], allowWrite: string[] = [], deny: string[] = []): PathsConfig => ({ allowRead, allowWrite, deny });
const p = (suffix: string) => join(root, suffix);
async function file(suffix: string): Promise<string> {
  const path = p(suffix);
  await Bun.write(path, "test");
  return path;
}

beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "ib-codex-paths-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// Codex's exact entries apply to subtrees and use depth, then deny/write/read.
// Glob denies are kept separate from that specificity ordering.
function nativeAccess(grants: Record<string, "read" | "write" | "deny">, target: string): string {
  const denies = prepareAccessTable({ ...paths([], [], Object.keys(grants).filter((key) => grants[key] === "deny")), runtimeRoots: [], runtimeDenyRoots: [] }).deny;
  if (denies.some((entry) => orderedEntryMatches(entry, target))) return "deny";
  return Object.entries(grants)
    .filter(([key]) => target === key || target.startsWith(`${key === "/" ? "" : key}/`))
    .sort(([a], [b]) => a.length - b.length).at(-1)?.[1] ?? "deny";
}

describe("resolveCodexPathGrants", () => {
  test("empty frozen policy adds no grants", async () => {
    expect(await resolveCodexPathGrants(paths())).toEqual({});
  });

  test("nonexistent Graham log directory remains writable", async () => {
    const logs = p("Library/Logs/graham");
    expect(await resolveCodexPathGrants(paths([], [logs]))).toEqual({ [logs]: "write" });
    expect(await resolveCodexPathGrants(paths([], [`${logs}/**`]))).toEqual({ [logs]: "write" });
  });

  test("exact paths preserve read/write, duplicates and write-wins ties without mutation", async () => {
    const config = paths([p("read"), p("both"), p("read")], [p("write"), p("both"), p("both")]);
    Object.freeze(config.allowRead);
    Object.freeze(config.allowWrite);
    Object.freeze(config.deny);
    Object.freeze(config);
    expect(await resolveCodexPathGrants(config)).toEqual({ [p("read")]: "read", [p("write")]: "write", [p("both")]: "write" });
  });

  test("nested exact restrictions retain shared resolver specificity", async () => {
    const config = paths([p("data/private")], [p("data"), p("data/private/output")]);
    const grants = await resolveCodexPathGrants(config);
    const prepared = prepareAccessTable({ ...config, runtimeRoots: [], runtimeDenyRoots: [] });
    for (const target of [p("data/new"), p("data/private/new"), p("data/private/output/new")]) {
      expect(nativeAccess(grants, target)).toBe(resolvePreparedAccess(prepared, target, "write") === "allow" ? "write" : "read");
    }
  });

  test("trailing /** uses glob specificity over plain path, independent of order", async () => {
    expect(await resolveCodexPathGrants(paths([`${root}/**`], [root]))).toEqual({ [root]: "read" });
    expect(await resolveCodexPathGrants(paths([root], [`${root}/**`]))).toEqual({ [root]: "write" });
    expect(await resolveCodexPathGrants(paths([`${root}/**`], [`${root}/**`]))).toEqual({ [root]: "write" });
  });

  test("config filename glob snapshots files including dotfiles, and refreshes", async () => {
    const original = await file(".claude.json");
    const backup = await file(".claude.json.backup");
    await file("unrelated");
    const config = paths([], [p(".claude.json*")]);
    const first = await resolveCodexPathGrants(config);
    expect(first).toEqual({ [original]: "write", [backup]: "write" });
    const future = await file(".claude.json.new");
    expect(nativeAccess(first, future)).toBe("deny");
    await rm(backup);
    expect(await resolveCodexPathGrants(config)).toEqual({ [original]: "write", [future]: "write" });
    expect(first).toEqual({ [original]: "write", [backup]: "write" });
  });

  test("matched directories never become grants for unauthorized descendants", async () => {
    await mkdir(p(".claude.json.directory"));
    await file(".claude.json.directory/secret");
    const allowed = await file(".claude.json");
    expect(await resolveCodexPathGrants(paths([], [p(".claude.json*")]))).toEqual({ [allowed]: "write" });
  });

  test("memory glob grants only existing whole memory subtrees, not projects or future project names", async () => {
    await file(".claude/projects/one/memory/notes");
    await mkdir(p(".claude/projects/two/memory"), { recursive: true });
    await file(".claude/projects/one/transcript");
    const config = paths([], [p(".claude/projects/*/memory/**")]);
    const grants = await resolveCodexPathGrants(config);
    expect(grants).toEqual({ [p(".claude/projects/one/memory")]: "write", [p(".claude/projects/two/memory")]: "write" });
    expect(nativeAccess(grants, p(".claude/projects/one/memory/new"))).toBe("write");
    expect(nativeAccess(grants, p(".claude/projects/new/memory/new"))).toBe("deny");
    expect(nativeAccess(grants, p(".claude/projects/one/transcript"))).toBe("deny");
  });

  test("current claude rules retain read floor and specific memory/file writes", async () => {
    await file(".claude/projects/one/memory/notes");
    const json = await file(".claude.json.backup");
    const config = paths([p(".claude/**")], [p(".claude"), p(".claude/projects/*/memory/**"), p(".claude.json*")]);
    expect(await resolveCodexPathGrants(config)).toEqual({
      [p(".claude")]: "read", [p(".claude/projects/one/memory")]: "write", [json]: "write",
    });
  });

  test("files matching both globs use original specificity, not materialization order", async () => {
    const name = await file("files/report.txt");
    const config = paths([p("files/**")], [p("files/report.*")]);
    expect(await resolveCodexPathGrants(config)).toEqual({ [p("files")]: "read", [name]: "write" });
    expect(await resolveCodexPathGrants(paths([p("files/report.*")], [p("files/report.*")]))).toEqual({ [name]: "write" });
  });

  test("overlapping file snapshots support narrower reads without any live write root", async () => {
    const report = await file("files/report.txt");
    const other = await file("files/other.txt");
    const grants = await resolveCodexPathGrants(paths([p("files/report.*")], [p("files/*")]));
    expect(grants).toEqual({ [report]: "read", [other]: "write" });
    expect(nativeAccess(grants, p("files/report.new"))).toBe("deny");
  });

  test("materialized wildcard writes do not override a more specific read subtree", async () => {
    const name = await file("projects/one/memory/note");
    const config = paths([p("projects/one")], [p("projects/*/memory/**")]);
    const grants = await resolveCodexPathGrants(config);
    expect(nativeAccess(grants, name)).toBe("read");
    expect(grants[p("projects/one/memory")]).not.toBe("write");
  });

  test("single-star write names never upgrade an existing read subtree", async () => {
    const name = await file("files/one");
    await file("files/dir/secret");
    const grants = await resolveCodexPathGrants(paths([p("files")], [p("files/*")]));
    expect(grants).toEqual({ [p("files")]: "read", [name]: "write" });
    expect(nativeAccess(grants, p("files/dir/secret"))).toBe("read");
  });

  test("question-mark, zero-directory globstar and recursive matches use existing grammar", async () => {
    const a = await file("files/a.txt");
    const b = await file("files/deep/b.txt");
    await file("files/deep/long.txt");
    expect(await resolveCodexPathGrants(paths([p("files/**/?.txt")]))).toEqual({ [a]: "read", [b]: "read" });
  });

  test("embedded globstar allow grammar is evaluated without Bun glob extensions", async () => {
    const a = await file("files/prefix/deep.txt");
    const b = await file("files/prefix.txt");
    expect(await resolveCodexPathGrants(paths([p("files/pre**.txt")]))).toEqual({ [a]: "read", [b]: "read" });
  });

  test("braces in allow patterns stay literal rather than expanding alternatives", async () => {
    const literal = await file("files/{one,two}.txt");
    await file("files/one.txt");
    expect(await resolveCodexPathGrants(paths([p("files/{one,two}.*")]))).toEqual({ [literal]: "read" });
  });

  test("unrepresentable exact bracket filenames fail instead of becoming native globs", async () => {
    await file("files/[ab].txt");
    await expect(resolveCodexPathGrants(paths([p("files/[ab].*")]))).rejects.toThrow("literal filename");
  });

  test("nonexistent snapshot roots and unmatched globs add nothing", async () => {
    expect(await resolveCodexPathGrants(paths([p("missing/*.txt"), p("nothing*")]))).toEqual({});
  });

  test("snapshot read globs cannot leave future matching names writable", async () => {
    await expect(resolveCodexPathGrants(paths([p("files/*.json")], [p("files")]))).rejects.toThrow("future matching names would remain writable");
    await expect(resolveCodexPathGrants(paths([p("projects/*/memory/**")], [p("projects")]))).rejects.toThrow("future matching names");
  });

  test("read globs shadowed by later subtree writes are redundant", async () => {
    expect(await resolveCodexPathGrants(paths([p("files/*")], [p("files/**")]))).toEqual({ [p("files")]: "write" });
  });

  test("an intervening read subtree neutralizes broader writes for read snapshots", async () => {
    await file("files/a.json");
    expect(await resolveCodexPathGrants(paths([p("files/**"), p("files/*.json")], [p("files")]))).toEqual({ [p("files")]: "read" });
  });

  test("basename-anywhere allows reject unbounded scans unless redundant", async () => {
    await expect(resolveCodexPathGrants(paths([], ["**/memory"]))).rejects.toThrow("unbounded filesystem scan");
    expect(await resolveCodexPathGrants(paths([], ["**/memory", "/"]))).toEqual({ "/": "write" });
    await expect(resolveCodexPathGrants(paths(["**/memory"], ["/"]))).rejects.toThrow("unbounded filesystem scan");
    expect(await resolveCodexPathGrants(paths(["**/memory"], [], ["/"]))).toEqual({ "/": "deny" });
  });

  test("exact denies suppress deeper exact and snapshot grants", async () => {
    await file("files/private/a.txt");
    const publicFile = await file("files/public.txt");
    const config = paths([], [p("files/**/*.txt"), p("files/private/deep")], [p("files/private")]);
    expect(await resolveCodexPathGrants(config)).toEqual({ [p("files/private")]: "deny", [publicFile]: "write" });
  });

  test("deny globs survive and materialized grants do not override them", async () => {
    await file("files/secret.json");
    const publicFile = await file("files/public.json");
    const config = paths([], [p("files/*.json")], [p("files/secret*")]);
    const grants = await resolveCodexPathGrants(config);
    expect(grants).toEqual({ [p("files/secret*")]: "deny", [publicFile]: "write" });
    expect(nativeAccess(grants, p("files/secret-future.json"))).toBe("deny");
  });

  test("basename-anywhere denies are absolute and preserve future denied names", async () => {
    const config = paths([], [root, p("project/.env")], ["**/.env"]);
    const grants = await resolveCodexPathGrants(config);
    expect(grants).toEqual({ "/**/.env": "deny", [root]: "write" });
    expect(nativeAccess(grants, p("future/.env"))).toBe("deny");
  });

  test("trailing deny subtree is retained and never reopened", async () => {
    const config = paths([], [root, p("private/output")], [p("private/**")]);
    expect(await resolveCodexPathGrants(config)).toEqual({ [root]: "write", [p("private/**")]: "deny" });
  });

  test("deny syntax that Codex would interpret differently fails closed", async () => {
    for (const deny of [p("file[ab]*"), p("{one,two}*"), p("file\\*"), p("prefix**")]) {
      await expect(resolveCodexPathGrants(paths([], [root], [deny]))).rejects.toThrow("deny glob syntax differs");
    }
  });

  test("snapshot walker skips file links, directory links and recursive symlink loops", async () => {
    await file("outside/secret.txt");
    const allowed = await file("files/allowed.txt");
    await symlink(p("outside"), p("files/escape"));
    await symlink(p("outside/secret.txt"), p("files/linked.txt"));
    await symlink(p("files"), p("files/loop"));
    expect(await resolveCodexPathGrants(paths([], [p("files/**/*.txt")]))).toEqual({ [allowed]: "write" });
    expect(await resolveCodexPathGrants(paths([], [p("files/*/**")]))).toEqual({});
  });

  test("a frozen scan prefix replaced by a symlink fails closed", async () => {
    await file("outside/secret");
    await symlink(p("outside"), p("files"));
    await expect(resolveCodexPathGrants(paths([], [p("files/*")]))).rejects.toThrow("snapshot root is now a symlink");
  });

  test("an intermediate symlink in the scan prefix also fails closed", async () => {
    await file("outside/nested/secret");
    await symlink(p("outside"), p("files"));
    await expect(resolveCodexPathGrants(paths([], [p("files/nested/*")]))).rejects.toThrow("changed canonical location");
  });

  test("noncanonical inputs fail instead of anchoring or expanding syntax", async () => {
    for (const path of ["relative", "~/logs", `${root}/files/*/../secret`, `${root}/bad\0name`]) {
      await expect(resolveCodexPathGrants(paths([], [path]))).rejects.toThrow();
    }
  });

  test("unreadable snapshot directories fail rather than returning partial grants", async () => {
    await file("files/nested/note");
    await chmod(p("files/nested"), 0o000);
    try {
      await expect(resolveCodexPathGrants(paths([], [p("files/**/note")]))).rejects.toThrow("snapshot failed");
    } finally {
      await chmod(p("files/nested"), 0o700);
    }
  });

  test("combinations of exact, subtree and snapshot rules never exceed the shared policy", async () => {
    await file("files/a.json");
    await file("files/dir/b.json");
    await file("files/dir/deep/c.txt");
    const rules = [p("files"), p("files/**"), p("files/*.json"), p("files/dir"), p("files/*/**")];
    const targets = ["a.json", "future.json", "dir/b.json", "dir/future.json", "dir/deep/c.txt", "dir/new/future.json", "future-dir/note"].map((name) => p(`files/${name}`));
    let translated = 0;
    for (let combination = 0; combination < 3 ** rules.length; combination++) {
      const config = paths();
      for (let index = 0; index < rules.length; index++) {
        const mode = Math.floor(combination / 3 ** index) % 3;
        if (mode === 1) config.allowRead.push(rules[index]!);
        if (mode === 2) config.allowWrite.push(rules[index]!);
      }
      let grants;
      try {
        grants = await resolveCodexPathGrants(config);
      } catch (error) {
        expect(String(error)).toContain("future matching names would remain writable");
        continue;
      }
      translated++;
      const prepared = prepareAccessTable({ ...config, runtimeRoots: [], runtimeDenyRoots: [] });
      for (const target of targets) {
        const mode = nativeAccess(grants, target);
        if (mode !== "deny") expect(resolvePreparedAccess(prepared, target, "read")).toBe("allow");
        if (mode === "write") expect(resolvePreparedAccess(prepared, target, "write")).toBe("allow");
      }
    }
    expect(translated).toBeGreaterThan(150);
  });
});
