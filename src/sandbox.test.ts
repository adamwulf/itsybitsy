import { describe, expect, test } from "bun:test";
import {
  canonicalizeSandboxPath,
  compileSandboxPath,
  generateProfile,
  globToSandboxRegex,
  isBalancedSandboxExpression,
  resolveSandboxConfig,
  sandboxProfileParameterValues,
  validateSandboxFrontmatter,
  type SandboxConfig,
  type SandboxProfileParams,
} from "./sandbox";

const EMPTY_CONFIG: SandboxConfig = {
  enabled: true,
  allowRead: [],
  allowWrite: [],
  deny: [],
  rawAllow: [],
  domains: [],
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
    const profile = generateProfile(EMPTY_CONFIG, PARAMS);
    expect(profile.split("\n").slice(0, 2)).toEqual(["(version 1)", "(deny default)"]);
    expect(profile.indexOf("(deny default)")).toBeLessThan(profile.indexOf("(allow "));
  });

  test("emits exactly the six runtime-derived root rules for empty lists", () => {
    const lines = generateProfile(EMPTY_CONFIG, PARAMS).trimEnd().split("\n");
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
    const profile = generateProfile(config({ allowRead: ["/"] }), PARAMS);
    expect(profile).toContain('(allow file-read* (subpath "/"))');
  });

  test("glob allows use regex under the requested read and write operations", () => {
    const profile = generateProfile(
      config({ allowRead: ["**/*.md"], allowWrite: ["~/output/*.txt"] }),
      PARAMS,
    );
    expect(profile).toMatch(/\(allow file-read\* \(regex #"\^/);
    expect(profile).toMatch(/\(allow file-write\* \(regex #"\^/);
  });

  test("all configured file denies are emitted after every allow", () => {
    const profile = generateProfile(
      config({
        allowRead: ["/tmp/read"],
        allowWrite: ["/tmp/shared"],
        deny: ["/tmp/shared", "**/.env"],
        rawAllow: ["(allow process*)"],
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
      config({ rawAllow: [networkDeny, localhost], deny: ["**/.env"] }),
      PARAMS,
    );
    expect(profile).toContain(`${networkDeny}\n${localhost}\n`);
    expect(profile.indexOf(localhost)).toBeLessThan(profile.indexOf("(deny file-read*"));
  });

  test("domains do not create a baked-in profile permission", () => {
    const profile = generateProfile(config({ domains: ["example.com"] }), PARAMS);
    expect(profile).not.toContain("example.com");
    expect(profile).not.toContain("network");
  });

  test("a quote-based path injection cannot emit an allow-default rule", () => {
    const malicious = '/tmp/evil")(allow default)(marker';
    const sandboxConfig = config({ allowRead: [malicious] });
    const profile = generateProfile(sandboxConfig, PARAMS);
    expect(profile).not.toContain("(allow default)");
    expect(profile).not.toContain(malicious);
    expect(profile).toContain('(param "ALLOW_R_0")');
    expect(sandboxProfileParameterValues(sandboxConfig, PARAMS).ALLOW_R_0).toContain(
      '")(allow default)(',
    );
  });

  test("unbalanced rawAllow fails closed during generation", () => {
    expect(() => generateProfile(config({ rawAllow: ["(allow process*"] }), PARAMS))
      .toThrow("balanced parenthesized s-expression");
  });
});

describe("sandbox config resolution", () => {
  test("derives both read and write lists from allowedPaths when sandbox is omitted", () => {
    expect(resolveSandboxConfig({ allowedPaths: ["/one", "/two"] })).toEqual({
      enabled: false,
      allowRead: ["/one", "/two"],
      allowWrite: ["/one", "/two"],
      deny: [],
      rawAllow: [],
      domains: [],
    });
  });

  test("an explicit sandbox block is authoritative over allowedPaths", () => {
    const explicit = config({
      allowRead: ["/sandbox/read"],
      allowWrite: ["/sandbox/write"],
    });
    expect(resolveSandboxConfig({
      sandbox: explicit,
      allowedPaths: ["/legacy"],
    })).toEqual(explicit);
  });

  test("returns fresh lists rather than aliasing resolved inputs", () => {
    const explicit = config({ allowRead: ["/original"] });
    const resolved = resolveSandboxConfig({ sandbox: explicit });
    resolved.allowRead.push("/new");
    expect(explicit.allowRead).toEqual(["/original"]);
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

  test.each(["allowRead", "allowWrite", "deny", "rawAllow", "domains"] as const)(
    "rejects non-array %s",
    (key) => {
      const result = validateSandboxFrontmatter({ [key]: "not-a-list" });
      expect(result.errors).toContain(`sandbox.${key} must be a list`);
    },
  );

  test("rejects non-string list entries", () => {
    const result = validateSandboxFrontmatter({ allowRead: ["/tmp", 42] });
    expect(result.errors).toContain("sandbox.allowRead[1] must be a string, got number");
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
