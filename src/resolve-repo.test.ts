import { test, expect, describe } from "bun:test";
import { resolveRepo, repoResolutionError, type RepoEntry } from "./registry";

// One registered set reused across cases. The "passwhats" repo mirrors the
// reported bug: registry id (nickname) "passwhats", directory basename "Pandora".
const repos: RepoEntry[] = [
  { path: "/Users/adamwulf/Developer/swift/Pandora", name: "Pandora", nickname: "passwhats" },
  { path: "/Users/adamwulf/Developer/bun/itsybitsy", name: "itsybitsy" },
  { path: "/Users/adamwulf/Developer/js/webapp", name: "webapp", nickname: "site" },
];

describe("resolveRepo", () => {
  test("resolves by registry id (nickname)", () => {
    const res = resolveRepo("passwhats", repos);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repo.path).toBe("/Users/adamwulf/Developer/swift/Pandora");
  });

  test("resolves by directory basename even when a nickname is set", () => {
    const res = resolveRepo("Pandora", repos);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repo.path).toBe("/Users/adamwulf/Developer/swift/Pandora");
  });

  test("resolves basename case-insensitively (the pre-fix working key)", () => {
    const res = resolveRepo("pandora", repos);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repo.name).toBe("Pandora");
  });

  test("resolves registry id (nickname) case-insensitively", () => {
    const res = resolveRepo("PASSWHATS", repos);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repo.nickname).toBe("passwhats");
  });

  test("resolves a repo with no nickname by its basename", () => {
    const res = resolveRepo("ItsyBitsy", repos);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repo.path).toBe("/Users/adamwulf/Developer/bun/itsybitsy");
  });

  test("resolves by absolute path (exact)", () => {
    const res = resolveRepo("/Users/adamwulf/Developer/swift/Pandora", repos);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repo.name).toBe("Pandora");
  });

  test("resolves by relative path against cwd, independent of the name", () => {
    // name ("customname") deliberately differs from the basename ("realdir")
    // so a match here can only come from the path branch, not the name branch.
    const local: RepoEntry[] = [{ path: "/tmp/root/realdir", name: "customname" }];
    const res = resolveRepo("./realdir", local, "/tmp/root");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repo.path).toBe("/tmp/root/realdir");
  });

  test("returns not-found for an unknown key", () => {
    const res = resolveRepo("nope", repos);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("not-found");
  });

  test("returns not-found for an empty / whitespace key", () => {
    expect(resolveRepo("   ", repos).ok).toBe(false);
  });

  test("fails ambiguously when one key matches two repos (basename vs nickname)", () => {
    const ambiguous: RepoEntry[] = [
      { path: "/a/foo", name: "foo" },
      { path: "/b/bar", name: "bar", nickname: "foo" },
    ];
    const res = resolveRepo("foo", ambiguous);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ambiguous");
      if (res.reason === "ambiguous") {
        expect(res.candidates.map((c) => c.path).sort()).toEqual(["/a/foo", "/b/bar"]);
      }
    }
  });

  test("ambiguous match is case-insensitive too", () => {
    const ambiguous: RepoEntry[] = [
      { path: "/a/Foo", name: "Foo" },
      { path: "/b/bar", name: "bar", nickname: "foo" },
    ];
    const res = resolveRepo("FOO", ambiguous);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("ambiguous");
  });

  test("a name-shaped key never matches a repo purely by resolve()-ing under cwd", () => {
    // key "webapp" is a bare name; resolve("/Users/.../js", "webapp") would be
    // "/Users/.../js/webapp" (== a real repo path) — but a name-shaped key must
    // only ever match the name/nickname namespace, never the path namespace.
    const res = resolveRepo("webapp", repos, "/Users/adamwulf/Developer/js");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.repo.path).toBe("/Users/adamwulf/Developer/js/webapp");
    // And it is a single, unambiguous match — not flagged ambiguous by a
    // coincidental cwd/name path collision.
  });
});

describe("repoResolutionError", () => {
  test("not-found message keeps the historical wording", () => {
    const res = resolveRepo("nope", repos);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(repoResolutionError("nope", res)).toBe("Repo not found: nope");
  });

  test("ambiguous message lists every candidate with its path", () => {
    const ambiguous: RepoEntry[] = [
      { path: "/a/foo", name: "foo" },
      { path: "/b/bar", name: "bar", nickname: "foo" },
    ];
    const res = resolveRepo("foo", ambiguous);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const msg = repoResolutionError("foo", res);
      expect(msg).toContain("Ambiguous");
      expect(msg).toContain("/a/foo");
      expect(msg).toContain("/b/bar");
    }
  });
});
