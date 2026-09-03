import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parseAgentTypeFile } from "./agent-types";
import {
  canonicalizePathsConfig,
  canonicalizeSandboxPath,
  compileSandboxPath,
  generateProfile,
  globToSandboxRegex,
  isBalancedSandboxExpression,
  normalizePathsConfig,
  resolvePathAccess,
  resolvePathsConfig,
  resolveSandboxConfig,
  sandboxPathAccessTable,
  sandboxProfileParameterValues,
  validatePathsFrontmatter,
  validateSandboxFrontmatter,
  type PathsConfig,
  type PathAccessTable,
  type PathOperation,
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
  return {
    allowRead: [...(overrides.allowRead ?? EMPTY_PATHS.allowRead)],
    allowWrite: [...(overrides.allowWrite ?? EMPTY_PATHS.allowWrite)],
    deny: [...(overrides.deny ?? EMPTY_PATHS.deny)],
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
    const profile = generateProfile(EMPTY_CONFIG, EMPTY_PATHS, PARAMS);
    expect(profile.split("\n").slice(0, 2)).toEqual(["(version 1)", "(deny default)"]);
    expect(profile.indexOf("(deny default)")).toBeLessThan(profile.indexOf("(allow "));
  });

  test("emits read and write decisions for all four sorted runtime roots", () => {
    const lines = generateProfile(EMPTY_CONFIG, EMPTY_PATHS, PARAMS).trimEnd().split("\n");
    expect(lines).toEqual([
      "(version 1)",
      "(deny default)",
      '(allow file-read* (subpath (param "AGENTDIR")))',
      '(allow file-write* (subpath (param "AGENTDIR")))',
      '(allow file-read* (subpath (param "REPOAGENTS")))',
      '(deny file-write* (subpath (param "REPOAGENTS")))',
      '(allow file-read* (subpath (param "GITDIR")))',
      '(allow file-write* (subpath (param "GITDIR")))',
      '(allow file-read* (subpath (param "WORKTREE")))',
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
    expect(profile).toContain('(param "ALLOW_0")');
    expect(sandboxProfileParameterValues(pathsConfig, PARAMS).ALLOW_0).toContain(
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

type AccessDecision = "allow" | "deny";

function unescapeSbpl(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char !== "\\" || index + 1 >= value.length) {
      result += char;
      continue;
    }
    const escaped = value[++index]!;
    if (escaped === "n") result += "\n";
    else if (escaped === "r") result += "\r";
    else if (escaped === "t") result += "\t";
    else if (escaped === '"' || escaped === "\\") result += escaped;
    else result += `\\${escaped}`;
  }
  return result;
}

function evaluatorMatcher(
  line: string,
  definitions: Record<string, string>,
): { decision: AccessDecision; op: PathOperation; matches: (path: string) => boolean } | null {
  const header = line.match(/^\((allow|deny) file-(read|write)\* /);
  if (!header) return null;
  const decision = header[1] as AccessDecision;
  const op = header[2] as PathOperation;

  const param = line.match(/\(subpath \(param "([A-Z0-9_]+)"\)\)\)$/);
  if (param) {
    const root = definitions[param[1]!];
    if (root === undefined) throw new Error(`Missing profile definition ${param[1]}`);
    return {
      decision,
      op,
      matches: (path) => root === "/" || path === root || path.startsWith(`${root}/`),
    };
  }

  const pathMatcher = line.match(/\((subpath|literal) "((?:\\.|[^"])*)"\)\)$/);
  if (pathMatcher) {
    const kind = pathMatcher[1]!;
    const root = unescapeSbpl(pathMatcher[2]!);
    return {
      decision,
      op,
      matches: kind === "literal"
        ? (path) => path === root
        : (path) => root === "/" || path === root || path.startsWith(`${root}/`),
    };
  }

  const regexMatcher = line.match(/\(regex #"((?:\\.|[^"])*)"\)\)$/);
  if (regexMatcher) {
    const regex = new RegExp(unescapeSbpl(regexMatcher[1]!));
    return { decision, op, matches: (path) => regex.test(path) };
  }
  return null;
}

/** Minimal SBPL path evaluator: default deny plus last matching file rule wins. */
function evaluateProfileAccess(
  profile: string,
  definitions: Record<string, string>,
  absolutePath: string,
  op: PathOperation,
): AccessDecision {
  let result: AccessDecision = "deny";
  for (const line of profile.split("\n")) {
    if (line === "(deny default)") {
      result = "deny";
      continue;
    }
    const matcher = evaluatorMatcher(line, definitions);
    if (matcher?.op === op && matcher.matches(absolutePath)) result = matcher.decision;
  }
  return result;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

const PATH_LIST_KEYS = ["allowRead", "allowWrite", "deny"] as const;

function mergeFixtureLayers(
  layers: PathsConfig[],
  listOrder: readonly (keyof PathsConfig)[] = PATH_LIST_KEYS,
): PathsConfig {
  const result = paths();
  for (const layer of layers) {
    for (const key of listOrder) {
      for (const entry of layer[key]) {
        if (!result[key].includes(entry)) result[key].push(entry);
      }
    }
  }
  return result;
}

interface AccessFixture {
  name: string;
  layers: PathsConfig[];
  params: SandboxProfileParams;
  checks: Array<{ path: string; read: AccessDecision; write: AccessDecision }>;
}

function assertFixtureOracle(
  fixture: AccessFixture,
  mergedPaths: PathsConfig,
  expectedProfile?: string,
): string {
  const profile = generateProfile(EMPTY_CONFIG, mergedPaths, fixture.params);
  if (expectedProfile !== undefined) expect(profile).toBe(expectedProfile);
  const definitions = sandboxProfileParameterValues(mergedPaths, fixture.params);
  const table = sandboxPathAccessTable(mergedPaths, fixture.params);
  for (const check of fixture.checks) {
    const target = canonicalizeSandboxPath(check.path);
    for (const op of ["read", "write"] as const) {
      const resolved = resolvePathAccess(target, op, table);
      expect(resolved, `${fixture.name}: resolver ${op} ${target}`).toBe(check[op]);
      expect(
        evaluateProfileAccess(profile, definitions, target, op),
        `${fixture.name}: profile ${op} ${target}`,
      ).toBe(resolved);
    }
  }
  return profile;
}

describe("most-specific filesystem access oracle", () => {
  test("resolver and emitted last-match profile agree across required shuffled fixtures", async () => {
    const home = "/Users/sandbox-test-user";
    const ordinaryParams: SandboxProfileParams = {
      AGENTDIR: "/runtime/repo/.ittybitty/agents/oracle",
      WORKTREE: "/runtime/repo/.ittybitty/agents/oracle/repo",
      GITDIR: "/runtime/repo/.git/worktrees/oracle",
      REPOAGENTS: "/runtime/repo/.ittybitty/agents",
      HOME: home,
    };
    const developerParams: SandboxProfileParams = {
      AGENTDIR: `${home}/Developer/app/.ittybitty/agents/oracle`,
      WORKTREE: `${home}/Developer/app/.ittybitty/agents/oracle/repo`,
      GITDIR: `${home}/Developer/app/.git/worktrees/oracle`,
      REPOAGENTS: `${home}/Developer/app/.ittybitty/agents`,
      HOME: home,
    };
    const allFrontmatter = parseAgentTypeFile(
      await Bun.file(join(import.meta.dir, "../docs/agent-types/_all.md")).text(),
    ).frontmatter;
    const allPaths = allFrontmatter.paths as PathsConfig;
    const canonicalAllPaths = canonicalizePathsConfig(allPaths, home);

    const fixtures: AccessFixture[] = [
      {
        name: "write Documents with nested read-only Important",
        layers: [
          paths({ allowWrite: ["~/Documents"] }),
          paths({ allowRead: ["~/Documents/Important"] }),
        ],
        params: ordinaryParams,
        checks: [
          { path: `${home}/Documents/Important/x`, read: "allow", write: "deny" },
          { path: `${home}/Documents/other/x`, read: "allow", write: "allow" },
          { path: "/outside-every-root/x", read: "deny", write: "deny" },
        ],
      },
      {
        name: "read home with nested writable Documents",
        layers: [
          paths({ allowRead: ["~"] }),
          paths({ allowWrite: ["~/Documents"] }),
        ],
        params: ordinaryParams,
        checks: [
          { path: `${home}/Documents/x`, read: "allow", write: "allow" },
          { path: `${home}/Desktop/x`, read: "allow", write: "deny" },
        ],
      },
      {
        name: "Developer read trap preserves nested runtime writes",
        layers: [paths({ allowRead: ["~/Developer"] }), paths()],
        params: developerParams,
        checks: [
          { path: `${developerParams.AGENTDIR}/meta.json`, read: "allow", write: "allow" },
          { path: `${developerParams.WORKTREE}/src/x.ts`, read: "allow", write: "allow" },
          { path: `${developerParams.GITDIR}/index`, read: "allow", write: "allow" },
          { path: `${home}/Developer/sibling/file`, read: "allow", write: "deny" },
        ],
      },
      {
        name: "verbatim _all floor preserves every declared and runtime write root",
        layers: [paths(), allPaths],
        params: developerParams,
        checks: [
          ...canonicalAllPaths.allowWrite.map((path) => ({ path, read: "allow" as const, write: "allow" as const })),
          ...[developerParams.AGENTDIR, developerParams.WORKTREE, developerParams.GITDIR]
            .map((path) => ({ path, read: "allow" as const, write: "allow" as const })),
          { path: developerParams.REPOAGENTS, read: "allow", write: "deny" },
        ],
      },
      {
        name: "type read subtree narrows writable worktree",
        layers: [paths({ allowRead: [`${ordinaryParams.WORKTREE}/vendor`] }), paths()],
        params: ordinaryParams,
        checks: [
          { path: `${ordinaryParams.WORKTREE}/vendor/pkg/file`, read: "allow", write: "deny" },
          { path: `${ordinaryParams.WORKTREE}/src/file`, read: "allow", write: "allow" },
        ],
      },
      {
        name: "canonical cross-list tie writes",
        layers: [
          paths({ allowRead: ["/tmp/oracle-tie"] }),
          paths({ allowWrite: ["/private/tmp/oracle-tie"] }),
        ],
        params: ordinaryParams,
        checks: [{ path: "/private/tmp/oracle-tie/x", read: "allow", write: "allow" }],
      },
      {
        name: "deny wins inside write and around nested write",
        layers: [
          paths({ allowWrite: ["/deny-test", "/blocked/inside"] }),
          paths({ deny: ["/deny-test/secret", "/blocked"] }),
        ],
        params: ordinaryParams,
        checks: [
          { path: "/deny-test/public/x", read: "allow", write: "allow" },
          { path: "/deny-test/secret/x", read: "deny", write: "deny" },
          { path: "/blocked/inside/x", read: "deny", write: "deny" },
        ],
      },
      {
        name: "read runtime root can contain a deeper authored write root",
        layers: [paths({ allowWrite: [`${ordinaryParams.REPOAGENTS}/shared/write`] }), paths()],
        params: ordinaryParams,
        checks: [
          { path: `${ordinaryParams.REPOAGENTS}/other/x`, read: "allow", write: "deny" },
          { path: `${ordinaryParams.REPOAGENTS}/shared/write/x`, read: "allow", write: "allow" },
        ],
      },
      {
        name: "glob literal-prefix depth v1 limitation",
        layers: [
          paths({ allowRead: ["/a/**/*.pem"] }),
          paths({ allowWrite: ["/a/b/c"] }),
        ],
        params: ordinaryParams,
        checks: [
          { path: "/a/b/c/x.pem", read: "allow", write: "allow" },
          { path: "/a/z.pem", read: "allow", write: "deny" },
        ],
      },
      {
        name: "plain sorts before glob at equal literal-prefix depth",
        layers: [
          paths({ allowWrite: ["/kind"] }),
          paths({ allowRead: ["/kind/**"] }),
        ],
        params: ordinaryParams,
        checks: [{ path: "/kind/x", read: "allow", write: "deny" }],
      },
      {
        name: "read sorts before write for a config-runtime exact tie",
        layers: [paths({ allowRead: ["/runtime-tie"] }), paths()],
        params: { ...ordinaryParams, AGENTDIR: "/runtime-tie" },
        checks: [{ path: "/runtime-tie/x", read: "allow", write: "allow" }],
      },
    ];

    for (const [fixtureIndex, fixture] of fixtures.entries()) {
      const original = mergeFixtureLayers(fixture.layers);
      const originalProfile = assertFixtureOracle(fixture, original);
      for (let permutation = 0; permutation < 20; permutation++) {
        const random = seededRandom(0x5a17 + fixtureIndex * 101 + permutation);
        const permutedLayers = shuffled(fixture.layers, random).map((layer) => ({
          allowRead: shuffled(layer.allowRead, random),
          allowWrite: shuffled(layer.allowWrite, random),
          deny: shuffled(layer.deny, random),
        }));
        const merged = mergeFixtureLayers(permutedLayers, shuffled(PATH_LIST_KEYS, random));
        assertFixtureOracle(fixture, merged, originalProfile);
      }
    }
  });

  test("sorted-position parameter names make unsafe entries order-independent", () => {
    const first = paths({
      allowRead: ['/tmp/z")(allow default)(x', "/tmp/a"],
      allowWrite: ['/tmp/w")(allow default)(x', "/tmp/c"],
      deny: ['/tmp/y")(allow default)(x', "/tmp/b"],
    });
    const second = paths({
      allowRead: [...first.allowRead].reverse(),
      allowWrite: [...first.allowWrite].reverse(),
      deny: [...first.deny].reverse(),
    });
    expect(generateProfile(EMPTY_CONFIG, first, PARAMS)).toBe(generateProfile(EMPTY_CONFIG, second, PARAMS));
    expect(sandboxProfileParameterValues(first, PARAMS)).toEqual(
      sandboxProfileParameterValues(second, PARAMS),
    );
  });

  test("LIVE macOS sandbox-exec proves nested last-match-wins", async () => {
    const sandboxExec = Bun.which("sandbox-exec");
    if (process.platform !== "darwin" || !sandboxExec) {
      console.log("LIVE sandbox probe: SKIPPED (sandbox-exec is absent; macOS only)");
      return;
    }
    const capability = Bun.spawnSync({
      cmd: [sandboxExec, "-p", "(version 1)(allow default)", "/usr/bin/true"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const capabilityError = capability.stderr.toString().trim();
    if (capability.exitCode !== 0 && capabilityError.includes("sandbox_apply: Operation not permitted")) {
      // Codex/CI may itself be inside Seatbelt, which forbids applying a nested
      // profile even though the executable exists. An ordinary macOS process
      // proceeds to the real compile and probes below.
      console.log(
        `LIVE sandbox probe: SKIPPED (sandbox-exec cannot apply a nested profile: exit=${capability.exitCode}, stderr=${capabilityError})`,
      );
      return;
    }
    if (capability.exitCode !== 0) {
      throw new Error(
        `LIVE sandbox capability check failed (${capability.exitCode}): ${capabilityError}`,
      );
    }

    const createdRoot = await mkdtemp(join(tmpdir(), "itsybitsy-sandbox-live-"));
    const root = canonicalizeSandboxPath(createdRoot);
    // A sibling temp tree that is NOT under HOME(=root). It lives under
    // /private/var/folders, a WRITE ancestor in the full floor, so it exercises
    // that write root and the "a read-only fixture dir deeper than the writable
    // temp ancestor still wins" rule (R2) without the "~" entry shadowing the
    // comparison the way it does everywhere under root.
    const createdOutsideHome = await mkdtemp(join(tmpdir(), "itsybitsy-sandbox-live-outside-"));
    const outsideHome = canonicalizeSandboxPath(createdOutsideHome);
    // A unique probe target directly under the absolute /private/tmp write root.
    const tmpWriteProbe = join("/private/tmp", `itsybitsy-sandbox-live-${crypto.randomUUID()}`);
    try {
      const baseline = parseAgentTypeFile(
        await Bun.file(join(import.meta.dir, "../docs/agent-types/_all.md")).text(),
      ).frontmatter;
      const baselinePaths = baseline.paths as PathsConfig;
      const baselineSandbox = baseline.sandbox as SandboxConfig;
      // The ENTIRE _all.md paths floor is the harness floor: allowRead +
      // allowWrite + deny, plus sandbox.rawAllow (below). It is unioned with the
      // fixture layer exactly the way a real spawn merges inheritance layers, so
      // /dev, /private/tmp, and /private/var/folders keep their allowWrite
      // writability. The read probe redirects to /dev/null and MUST be able to
      // open it; the earlier allowRead-only floor emitted (deny file-write*
      // (subpath "/dev")) and broke that redirect.
      const floorPaths: PathsConfig = {
        allowRead: [...baselinePaths.allowRead],
        allowWrite: [...baselinePaths.allowWrite],
        deny: [...baselinePaths.deny],
      };

      const exampleOneRoot = join(root, "examples/one/Documents");
      const exampleOneImportant = join(exampleOneRoot, "Important/file.txt");
      const exampleOneOther = join(exampleOneRoot, "Other/file.txt");
      const exampleTwoRoot = join(root, "examples/two");
      const exampleTwoDocuments = join(exampleTwoRoot, "Documents/file.txt");
      const exampleTwoDesktop = join(exampleTwoRoot, "Desktop/file.txt");
      const tieFile = join(root, "examples/tie/file.txt");
      const params: SandboxProfileParams = {
        AGENTDIR: join(root, "Developer/app/.ittybitty/agents/live"),
        WORKTREE: join(root, "Developer/app/.ittybitty/agents/live/repo"),
        GITDIR: join(root, "Developer/app/.git/worktrees/live"),
        REPOAGENTS: join(root, "Developer/app/.ittybitty/agents"),
        HOME: root,
      };
      const trapAgentFile = join(params.AGENTDIR, "meta.json");
      const trapWorktreeFile = join(params.WORKTREE, "src/file.txt");
      const trapGitFile = join(params.GITDIR, "index");
      const trapSiblingFile = join(root, "Developer/sibling/file.txt");
      // Row (c): verbatim-floor writable roots stay writable and the "~"/floor
      // read ancestors stay read-only. The runtime roots (params, temp dirs)
      // above already stand in for AGENTDIR/WORKTREE/GITDIR; REPOAGENTS is a
      // read root, so a file directly under it (not under AGENTDIR) is read-only.
      const repoAgentsFile = join(params.REPOAGENTS, "registry.json");
      const homeReadOnlyFile = join(root, "loose-home.txt"); // under "~" read ancestor
      const homeClaudeWrite = join(root, ".claude/probe.txt"); // ~/.claude allowWrite
      const homeItsybitsyWrite = join(root, ".itsybitsy/agents/probe.txt"); // ~/.itsybitsy/agents allowWrite
      const homeItsybitsyRead = join(root, ".itsybitsy/state.json"); // ~/.itsybitsy read, write denied
      const devNull = "/dev/null"; // /dev allowWrite root, already present
      const outsideWriteFile = join(outsideHome, "plain.txt"); // /private/var/folders allowWrite
      const outsideReadOnlyDir = join(outsideHome, "readonly");
      const outsideReadOnlyFile = join(outsideReadOnlyDir, "file.txt"); // read-only under write ancestor (R2)
      const files = [
        exampleOneImportant,
        exampleOneOther,
        exampleTwoDocuments,
        exampleTwoDesktop,
        tieFile,
        trapAgentFile,
        trapWorktreeFile,
        trapGitFile,
        trapSiblingFile,
        repoAgentsFile,
        homeReadOnlyFile,
        homeClaudeWrite,
        homeItsybitsyWrite,
        homeItsybitsyRead,
        outsideWriteFile,
        outsideReadOnlyFile,
        tmpWriteProbe,
      ];
      for (const file of files) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, "probe\n");
      }

      const fixturePaths = paths({
        allowRead: [
          join(exampleOneRoot, "Important"),
          exampleTwoRoot,
          join(root, "Developer"),
          dirname(tieFile),
          outsideReadOnlyDir,
        ],
        allowWrite: [exampleOneRoot, join(exampleTwoRoot, "Documents"), dirname(tieFile)],
      });
      // Union the _all.md floor with the fixture layer exactly as a real spawn
      // merges inheritance layers, then hand the merged config to the same
      // canonicalize/normalize path production uses (sandboxPathAccessTable,
      // generateProfile, sandboxProfileParameterValues, resolvePathAccess).
      const livePaths = mergeFixtureLayers([floorPaths, fixturePaths]);
      const liveConfig = config({ rawAllow: baselineSandbox.rawAllow });
      const profile = generateProfile(liveConfig, livePaths, params);
      const profilePath = join(root, "live.sb");
      await Bun.write(profilePath, profile);
      const definitions = sandboxProfileParameterValues(livePaths, params);
      const definitionArgs = Object.entries(definitions)
        .flatMap(([key, value]) => ["-D", `${key}=${value}`]);
      // Every failure reprints enough to reproduce the exact sandbox-exec run by
      // hand: the profile, its -D substitutions, and the temp roots.
      const reproduce = (headline: string): string =>
        `${headline}\n` +
        `profile file: ${profilePath}\n` +
        `-D args: ${definitionArgs.join(" ")}\n` +
        `temp HOME root: ${root}\n` +
        `outside-home root: ${outsideHome}\n` +
        `/private/tmp probe: ${tmpWriteProbe}\n` +
        `--- profile ---\n${profile}`;

      const compileResult = Bun.spawnSync({
        cmd: [sandboxExec, "-f", profilePath, ...definitionArgs, "/usr/bin/true"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (compileResult.exitCode !== 0) {
        throw new Error(reproduce(
          `LIVE sandbox profile compile failed (${compileResult.exitCode}): ${compileResult.stderr.toString().trim()}`,
        ));
      }

      const checks = [
        { label: "write-root/nested-read", path: exampleOneImportant },
        { label: "write-root/sibling", path: exampleOneOther },
        { label: "read-root/nested-write", path: exampleTwoDocuments },
        { label: "read-root/sibling", path: exampleTwoDesktop },
        { label: "trap/agentdir", path: trapAgentFile },
        { label: "trap/worktree", path: trapWorktreeFile },
        { label: "trap/gitdir", path: trapGitFile },
        { label: "trap/sibling", path: trapSiblingFile },
        { label: "tie", path: tieFile },
        // Row (c): the verbatim _all.md floor keeps every allowWrite root and
        // runtime root writable while "/" and "~" stay read-only ancestors.
        { label: "floor/repoagents-read-only", path: repoAgentsFile },
        { label: "floor/home-ancestor-read-only", path: homeReadOnlyFile },
        { label: "floor/home-claude-write", path: homeClaudeWrite },
        { label: "floor/home-itsybitsy-agents-write", path: homeItsybitsyWrite },
        { label: "floor/home-itsybitsy-read-only", path: homeItsybitsyRead },
        { label: "floor/dev-null-write", path: devNull },
        { label: "floor/var-folders-write", path: outsideWriteFile },
        { label: "floor/read-only-under-write-ancestor", path: outsideReadOnlyFile },
        { label: "floor/private-tmp-write", path: tmpWriteProbe },
      ];
      const table: PathAccessTable = sandboxPathAccessTable(livePaths, params);
      // "/" is a read-only ancestor in the floor: a path under no deeper entry is
      // readable but not writable. A live kernel probe of that arm would have to
      // touch a real, unpredictable system path outside every temp tree, so it is
      // asserted against the resolver here; the SBPL-evaluator oracle exercises
      // "/" end to end, and the "~" read-only ancestor is kernel-probed below.
      expect(resolvePathAccess("/Applications/itsybitsy-nonexistent-probe", "read", table)).toBe("allow");
      expect(resolvePathAccess("/Applications/itsybitsy-nonexistent-probe", "write", table)).toBe("deny");
      const results: string[] = [];
      for (const check of checks) {
        for (const op of ["read", "write"] as const) {
          const command = op === "read" ? 'cat "$1" >/dev/null' : 'echo x > "$1"';
          const result = Bun.spawnSync({
            cmd: [
              sandboxExec,
              "-f", profilePath,
              ...definitionArgs,
              "/bin/sh", "-c", command, "probe", check.path,
            ],
            stdout: "pipe",
            stderr: "pipe",
          });
          const expected = resolvePathAccess(check.path, op, table);
          const actual = result.exitCode === 0 ? "allow" : "deny";
          results.push(`${check.label}:${op}=${result.exitCode}`);
          if (actual !== expected) {
            throw new Error(reproduce(
              `LIVE sandbox disagreement for ${check.label} ${op}: resolver=${expected}, ` +
              `exit=${result.exitCode}, stderr=${result.stderr.toString().trim()}\n` +
              `probe: /bin/sh -c '${command}' probe ${check.path}`,
            ));
          }
        }
      }
      console.log(`LIVE sandbox probe: compile=${compileResult.exitCode}; ${results.join(", ")}`);
    } finally {
      await rm(createdRoot, { recursive: true, force: true });
      await rm(createdOutsideHome, { recursive: true, force: true });
      await rm(tmpWriteProbe, { force: true });
    }
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
