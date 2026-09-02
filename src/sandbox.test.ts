import { describe, expect, test } from "bun:test";
import {
  canonicalizeSandboxPath,
  compileSandboxPath,
  generateProfile,
  globToSandboxRegex,
  isBalancedSandboxExpression,
  normalizePathsConfig,
  resolvePathsConfig,
  resolveSandboxConfig,
  sandboxProfileParameterValues,
  validatePathsFrontmatter,
  validateSandboxFrontmatter,
  type PathsConfig,
  type SandboxConfig,
  type SandboxProfileParams,
} from "./sandbox";

const EMPTY_CONFIG: SandboxConfig = {
  enabled: true,
  rawAllow: [],
  domains: [],
};

const EMPTY_PATHS: PathsConfig = {
  allowRead: [],
  allowWrite: [],
  deny: [],
};

const PARAMS: SandboxProfileParams = {
  AGENTDIR: "/tmp/itsybitsy-agent",
  WORKTREE: "/tmp/itsybitsy-agent/repo",
  GITDIR: "/tmp/itsybitsy-git",
  REPOAGENTS: "/tmp/itsybitsy-agents",
  HOME: "/Users/sandbox-test-user",
};

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    ...EMPTY_CONFIG,
    ...overrides,
  };
}

function paths(overrides: Partial<PathsConfig> = {}): PathsConfig {
  return { ...EMPTY_PATHS, ...overrides };
}

describe("sandbox glob to regex", () => {
  test("star never crosses a path separator", () => {
    const regex = new RegExp(globToSandboxRegex("/a/*/b"));
    expect(regex.test("/a/one/b")).toBe(true);
    expect(regex.test("/a/one/two/b")).toBe(false);
  });

  test("question mark matches exactly one non-separator character", () => {
    const regex = new RegExp(globToSandboxRegex("/a/file?.txt"));
    expect(regex.test("/a/file1.txt")).toBe(true);
    expect(regex.test("/a/file.txt")).toBe(false);
    expect(regex.test("/a/file12.txt")).toBe(false);
    expect(regex.test("/a/file/.txt")).toBe(false);
  });

  test("globstar crosses directories including zero directory segments", () => {
    const regex = new RegExp(globToSandboxRegex("/a/**/file.txt"));
    expect(regex.test("/a/file.txt")).toBe(true);
    expect(regex.test("/a/x/y/file.txt")).toBe(true);
  });

  test("globstar basename pattern matches root and nested dotfiles only", () => {
    const regex = new RegExp(globToSandboxRegex("**/.env"));
    expect(regex.test("/.env")).toBe(true);
    expect(regex.test("/x/.env")).toBe(true);
    expect(regex.test("/x/y/.env")).toBe(true);
    expect(regex.test("/x/yenv")).toBe(false);
    expect(regex.test("/x/aenv")).toBe(false);
  });

  test("literal regex metacharacters and dots stay literal", () => {
    const regex = new RegExp(globToSandboxRegex("**/a.+()[]{}|^$.txt"));
    expect(regex.test("/x/a.+()[]{}|^$.txt")).toBe(true);
    expect(regex.test("/x/ab+()[]{}|^$.txt")).toBe(false);
  });

  test("regex is anchored at both ends", () => {
    const source = globToSandboxRegex("~/secrets/*", "/Users/tester");
    expect(source.startsWith("^")).toBe(true);
    expect(source.endsWith("$")).toBe(true);
    const regex = new RegExp(source);
    expect(regex.test("/Users/tester/secrets/token")).toBe(true);
    expect(regex.test("/prefix/Users/tester/secrets/token")).toBe(false);
    expect(regex.test("/Users/tester/secrets/token/suffix")).toBe(false);
  });

  test("home expands in glob and non-glob forms", () => {
    expect(globToSandboxRegex("~/*.pem", "/Users/tester")).toContain("/Users/tester/");
    expect(compileSandboxPath("~/.ssh", "/Users/tester")).toBe(
      '(subpath "/Users/tester/.ssh")',
    );
  });

  test("bare tilde is legal and means the home subtree", () => {
    expect(compileSandboxPath("~", "/Users/tester")).toBe(
      '(subpath "/Users/tester")',
    );
  });

  test("absolute paths containing glob metacharacters compile as regex", () => {
    expect(compileSandboxPath("/tmp/**/*.pem")).toStartWith('(regex #"^/private/tmp/');
  });

  test("rejects ambiguous relative globs while preserving supported anchors", () => {
    expect(() => compileSandboxPath("foo*")).toThrow("relative globs are not allowed");
    expect(() => compileSandboxPath("a/b*")).toThrow("relative globs are not allowed");
    expect(compileSandboxPath("/foo*")).toStartWith('(regex #"^/foo');
    expect(compileSandboxPath("**/.env")).toStartWith('(regex #"^');
    expect(compileSandboxPath("~/x*", "/Users/tester")).toStartWith(
      '(regex #"^/Users/tester/x',
    );
  });

  test("rejects NUL-bearing globs before profile emission", () => {
    expect(() => compileSandboxPath("/tmp/*\0evil")).toThrow("NUL bytes are not allowed");
    expect(() => globToSandboxRegex("/tmp/*\0evil")).toThrow("NUL bytes are not allowed");
  });

  test("bare names are rejected with actionable guidance", () => {
    expect(() => compileSandboxPath(".env")).toThrow("bare names are not allowed");
    expect(() => compileSandboxPath(".env")).toThrow("**/.env");
  });
});

describe("sandbox profile emission", () => {
  test("starts with version and deny-default before every permission", () => {
    const profile = generateProfile(EMPTY_CONFIG, EMPTY_PATHS, PARAMS);
    expect(profile.split("\n").slice(0, 2)).toEqual(["(version 1)", "(deny default)"]);
    expect(profile.indexOf("(deny default)")).toBeLessThan(profile.indexOf("(allow "));
  });

  test("emits exactly the six runtime-derived root rules for empty lists", () => {
    const lines = generateProfile(EMPTY_CONFIG, EMPTY_PATHS, PARAMS).trimEnd().split("\n");
    expect(lines).toEqual([
      "(version 1)",
      "(deny default)",
      '(allow file-read* (subpath (param "AGENTDIR")))',
      '(allow file-write* (subpath (param "AGENTDIR")))',
      '(allow file-read* (subpath (param "GITDIR")))',
      '(allow file-write* (subpath (param "GITDIR")))',
      '(allow file-read* (subpath (param "REPOAGENTS")))',
      '(allow file-write* (subpath (param "WORKTREE")))',
    ]);
  });

  test("allowRead root uses the explicit whole-tree subpath form", () => {
    const profile = generateProfile(EMPTY_CONFIG, paths({ allowRead: ["/"] }), PARAMS);
    expect(profile).toContain('(allow file-read* (subpath "/"))');
  });

  test("glob allows use regex under the requested read and write operations", () => {
    const profile = generateProfile(
      EMPTY_CONFIG,
      paths({ allowRead: ["**/*.md"], allowWrite: ["~/output/*.txt"] }),
      PARAMS,
    );
    expect(profile).toMatch(/\(allow file-read\* \(regex #"\^/);
    expect(profile).toMatch(/\(allow file-write\* \(regex #"\^/);
  });

  test("all configured file denies are emitted after every allow", () => {
    const profile = generateProfile(
      config({ rawAllow: ["(allow process*)"] }),
      paths({
        allowRead: ["/tmp/read"],
        allowWrite: ["/tmp/shared"],
        deny: ["/tmp/shared", "**/.env"],
      }),
      PARAMS,
    );
    const firstFileDeny = profile.indexOf("(deny file-read*");
    const lastAllow = profile.lastIndexOf("(allow ");
    expect(firstFileDeny).toBeGreaterThan(lastAllow);
    expect(profile.lastIndexOf("(deny file-write*")).toBeGreaterThan(lastAllow);
  });

  test("rawAllow is verbatim and ordered before config denies", () => {
    const networkDeny = "(deny network*)";
    const localhost = '(allow network-outbound (remote ip "localhost:*"))';
    const profile = generateProfile(
      config({ rawAllow: [networkDeny, localhost] }),
      paths({ deny: ["**/.env"] }),
      PARAMS,
    );
    expect(profile).toContain(`${networkDeny}\n${localhost}\n`);
    expect(profile.indexOf(localhost)).toBeLessThan(profile.indexOf("(deny file-read*"));
  });

  test("domains do not create a baked-in profile permission", () => {
    const profile = generateProfile(config({ domains: ["example.com"] }), EMPTY_PATHS, PARAMS);
    expect(profile).not.toContain("example.com");
    expect(profile).not.toContain("network");
  });

  test("a quote-based path injection cannot emit an allow-default rule", () => {
    const malicious = '/tmp/evil")(allow default)(marker';
    const pathsConfig = paths({ allowRead: [malicious] });
    const profile = generateProfile(EMPTY_CONFIG, pathsConfig, PARAMS);
    expect(profile).not.toContain("(allow default)");
    expect(profile).not.toContain(malicious);
    expect(profile).toContain('(param "ALLOW_R_0")');
    expect(sandboxProfileParameterValues(pathsConfig, PARAMS).ALLOW_R_0).toContain(
      '")(allow default)(',
    );
  });

  test("unbalanced rawAllow fails closed during generation", () => {
    expect(() => generateProfile(config({ rawAllow: ["(allow process*"] }), EMPTY_PATHS, PARAMS))
      .toThrow("balanced parenthesized s-expression");
  });

  test("allowWrite emits both read and write permissions", () => {
    const profile = generateProfile(
      EMPTY_CONFIG,
      paths({ allowWrite: ["/tmp/write-only-authored"] }),
      PARAMS,
    );
    expect(profile).toContain('(allow file-read* (subpath "/private/tmp/write-only-authored"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/write-only-authored"))');
  });

  test("generateProfile normalizes a canonical read/write tie to the write entry", () => {
    const profile = generateProfile(
      EMPTY_CONFIG,
      paths({
        allowRead: ["/tmp/shared"],
        allowWrite: ["/private/tmp/shared"],
      }),
      PARAMS,
    );
    expect(profile).not.toContain('ALLOW_R_0');
    expect(profile).toContain('(allow file-read* (subpath "/private/tmp/shared"))');
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp/shared"))');
  });
});

describe("sandbox config resolution", () => {
  test("an omitted sandbox block resolves to disabled kernel settings", () => {
    expect(resolveSandboxConfig({})).toEqual({
      enabled: false,
      rawAllow: [],
      domains: [],
    });
  });

  test("an explicit sandbox block is copied", () => {
    const explicit = config({ domains: ["example.com"] });
    expect(resolveSandboxConfig({ sandbox: explicit })).toEqual(explicit);
  });

  test("returns fresh lists rather than aliasing resolved inputs", () => {
    const explicit = config({ domains: ["original.example"] });
    const resolved = resolveSandboxConfig({ sandbox: explicit });
    resolved.domains.push("new.example");
    expect(explicit.domains).toEqual(["original.example"]);
  });

  test("paths resolve independently and return fresh lists", () => {
    const explicit = paths({ allowRead: ["/original"] });
    const resolved = resolvePathsConfig(explicit);
    resolved.allowRead.push("/new");
    expect(explicit.allowRead).toEqual(["/original"]);
  });
});

describe("paths normalization", () => {
  test("canonical exact duplicates in allowRead and allowWrite collapse to allowWrite", () => {
    const original = paths({
      allowRead: ["/tmp/shared", "/tmp/read-only"],
      allowWrite: ["/private/tmp/shared"],
    });
    expect(normalizePathsConfig(original, "/Users/tester")).toEqual({
      allowRead: ["/tmp/read-only"],
      allowWrite: ["/private/tmp/shared"],
      deny: [],
    });
    expect(original.allowRead).toEqual(["/tmp/shared", "/tmp/read-only"]);
  });

  test("the same glob in both lists is a write-wins exact tie", () => {
    expect(normalizePathsConfig(paths({
      allowRead: ["~/shared/*.txt"],
      allowWrite: ["~/shared/*.txt"],
    }), "/Users/tester").allowRead).toEqual([]);
  });

  test.each([
    ["/tmp/shared/*.md", "/private/tmp/shared/*.md"],
    ["~/shared/*.md", "/Users/tester/shared/*.md"],
  ])("canonical glob spellings collapse from allowRead into allowWrite", (readEntry, writeEntry) => {
    expect(normalizePathsConfig(paths({
      allowRead: [readEntry],
      allowWrite: [writeEntry],
    }), "/Users/tester")).toEqual({
      allowRead: [],
      allowWrite: [writeEntry],
      deny: [],
    });
  });
});

describe("sandbox path canonicalization", () => {
  test("canonicalizes /tmp to /private/tmp", () => {
    expect(canonicalizeSandboxPath("/tmp/itsybitsy-x")).toBe("/private/tmp/itsybitsy-x");
    expect(compileSandboxPath("/tmp/itsybitsy-x")).toBe(
      '(subpath "/private/tmp/itsybitsy-x")',
    );
  });

  test("canonicalizes through the longest existing prefix for a missing directory", () => {
    const missing = `/tmp/itsybitsy-never-created-${crypto.randomUUID()}/child`;
    expect(canonicalizeSandboxPath(missing)).toBe(missing.replace("/tmp/", "/private/tmp/"));
  });
});

describe("sandbox frontmatter validation", () => {
  test("accepts the complete flat schema", () => {
    expect(validateSandboxFrontmatter(EMPTY_CONFIG)).toEqual({ errors: [], warnings: [] });
  });

  test("rejects non-boolean enabled including the trailing-comment footgun", () => {
    const result = validateSandboxFrontmatter({ enabled: "true  # note" });
    expect(result.errors).toEqual([
      'sandbox.enabled must be true or false, got "true  # note"',
    ]);
  });

  test.each(["rawAllow", "domains"] as const)(
    "rejects non-array %s",
    (key) => {
      const result = validateSandboxFrontmatter({ [key]: "not-a-list" });
      expect(result.errors).toContain(`sandbox.${key} must be a list`);
    },
  );

  test.each(["allowRead", "allowWrite", "deny"])(
    "rejects legacy sandbox.%s with paths migration guidance",
    (key) => {
      const result = validateSandboxFrontmatter({ [key]: ["/tmp"] });
      expect(result.errors).toContain(`sandbox.${key} has moved; move it to paths.${key}`);
    },
  );

  test("rejects non-string list entries", () => {
    const result = validateSandboxFrontmatter({ domains: ["example.com", 42] });
    expect(result.errors).toContain("sandbox.domains[1] must be a string, got number");
  });

  test("rejects unknown keys", () => {
    const result = validateSandboxFrontmatter({ enabled: true, filesystem: {} });
    expect(result.errors).toContain('sandbox contains unknown key "filesystem"');
  });

  test("rejects malformed and multiple raw s-expressions", () => {
    expect(validateSandboxFrontmatter({ rawAllow: ["allow process*"] }).errors[0])
      .toContain("balanced parenthesized s-expression");
    expect(validateSandboxFrontmatter({ rawAllow: ["(allow process*) (allow default)"] }).errors[0])
      .toContain("balanced parenthesized s-expression");
  });

  test("balanced-expression parser ignores parentheses and escaped quotes in strings", () => {
    expect(isBalancedSandboxExpression('(allow network-outbound (remote ip "localhost:(*)"))')).toBe(true);
    expect(isBalancedSandboxExpression('(allow network-outbound (remote ip "x\\\"(y)"))')).toBe(true);
  });

  test.each(["(allow default)", "(allow file-read*)", "(allow file-write*)"])(
    "warns rather than rejects catch-all rawAllow %s",
    (entry) => {
      const result = validateSandboxFrontmatter({ rawAllow: [entry] });
      expect(result.errors).toEqual([]);
      expect(result.warnings[0]).toContain("catch-all rule");
      expect(result.warnings[0]).toContain(entry);
    },
  );
});

describe("paths frontmatter validation", () => {
  test("accepts all three lists and an empty object", () => {
    expect(validatePathsFrontmatter(EMPTY_PATHS).errors).toEqual([]);
    expect(validatePathsFrontmatter({}).errors).toEqual([]);
  });

  test.each(["allowRead", "allowWrite", "deny"] as const)(
    "rejects non-list and non-string paths.%s values",
    (key) => {
      expect(validatePathsFrontmatter({ [key]: "bad" }).errors)
        .toContain(`paths.${key} must be a list`);
      expect(validatePathsFrontmatter({ [key]: [42] }).errors)
        .toContain(`paths.${key}[0] must be a string, got number`);
    },
  );

  test("rejects unknown keys and every invalid path grammar form", () => {
    expect(validatePathsFrontmatter({ extra: [] }).errors)
      .toContain('paths contains unknown key "extra"');
    for (const entry of ["bare", "relative/*", "/tmp/nul\0path"]) {
      expect(validatePathsFrontmatter({ allowRead: [entry] }).errors.length).toBeGreaterThan(0);
    }
  });

  test("rejects different cross-list globs with the same literal prefix", () => {
    const result = validatePathsFrontmatter({
      allowRead: ["~/Documents/**/*.pdf"],
      allowWrite: ["~/Documents/**/*.txt"],
    }, "/Users/tester");
    expect(result.errors).toContain(
      'paths.allowRead entry "~/Documents/**/*.pdf" and paths.allowWrite entry "~/Documents/**/*.txt" are different globs with the same literal prefix "/Users/tester/Documents/"',
    );
  });

  test("rejects home and absolute globs that share a canonical prefix", () => {
    const result = validatePathsFrontmatter({
      allowRead: ["~/Documents/*.md"],
      allowWrite: ["/Users/tester/Documents/*.txt"],
    }, "/Users/tester");
    expect(result.errors).toContain(
      'paths.allowRead entry "~/Documents/*.md" and paths.allowWrite entry "/Users/tester/Documents/*.txt" are different globs with the same literal prefix "/Users/tester/Documents/"',
    );
  });

  test("rejects /tmp and /private/tmp globs that share a canonical prefix", () => {
    const result = validatePathsFrontmatter({
      allowRead: ["/tmp/itsybitsy/*.md"],
      allowWrite: ["/private/tmp/itsybitsy/*.txt"],
    });
    expect(result.errors).toContain(
      'paths.allowRead entry "/tmp/itsybitsy/*.md" and paths.allowWrite entry "/private/tmp/itsybitsy/*.txt" are different globs with the same literal prefix "/private/tmp/itsybitsy/"',
    );
  });

  test("allows the same glob in both lists", () => {
    expect(validatePathsFrontmatter({
      allowRead: ["~/Documents/**/*.pdf"],
      allowWrite: ["~/Documents/**/*.pdf"],
    }).errors).toEqual([]);
  });

  test("allows /tmp and /private/tmp spellings of the same canonical glob tie", () => {
    expect(validatePathsFrontmatter({
      allowRead: ["/tmp/itsybitsy/*.md"],
      allowWrite: ["/private/tmp/itsybitsy/*.md"],
    }).errors).toEqual([]);
  });

  test("allows home and absolute spellings of the same canonical glob tie", () => {
    expect(validatePathsFrontmatter({
      allowRead: ["~/Documents/*.md"],
      allowWrite: ["/Users/tester/Documents/*.md"],
    }, "/Users/tester").errors).toEqual([]);
  });
});
