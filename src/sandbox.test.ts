import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { parseAgentTypeFile } from "./agent-types";
import {
  anchorRelativePaths,
  findRelativeEscapes,
  canonicalizePathsConfig,
  canonicalizeSandboxPath,
  compileSandboxPath,
  generateProfile,
  globToSandboxRegex,
  isBalancedSandboxExpression,
  normalizePathsConfig,
  prepareAccessTable,
  resolvePathAccess,
  resolvePreparedAccess,
  resolvePathsConfig,
  resolveSandboxConfig,
  sandboxPathAccessTable,
  sandboxProfileParameterValues,
  SEAL_HELPER_RESULT_PREFIX,
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
  PARENTCLAUDE: "/tmp/itsybitsy-repo/.claude",
  TMUXSOCK: "/tmp/tmux-501",
  canSpawnChildren: false,
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

describe("a missing paths block is identical to an empty one (deny-by-default)", () => {
  // Adam's invariant: a type .md with NO `paths:` block MUST behave EXACTLY like
  // one that declares `paths:` with empty lists — deny-by-default. A missing
  // block must never mean "allowed". resolvePathsConfig maps an absent block to
  // empty lists, so the two are indistinguishable downstream; mergeSandboxLayerConfigs
  // (ib-commands.ts) likewise drops undefined layer.paths, so "no layer declares
  // paths" also yields empty lists. These tests pin the property at the profile
  // and resolver level so no future change can reintroduce the absent-means-
  // permissive fallback that A1 removed.
  const missing = resolvePathsConfig(undefined);
  const empty = resolvePathsConfig(EMPTY_PATHS);

  test("resolvePathsConfig(undefined) equals an explicit empty block", () => {
    expect(missing).toEqual({ allowRead: [], allowWrite: [], deny: [] });
    expect(missing).toEqual(empty);
  });

  test("both generate a byte-identical Seatbelt profile", () => {
    expect(generateProfile(EMPTY_CONFIG, missing, PARAMS)).toBe(
      generateProfile(EMPTY_CONFIG, empty, PARAMS),
    );
  });

  test("both deny every path outside the runtime roots, for read and write", () => {
    const table = sandboxPathAccessTable(missing, PARAMS);
    for (const outside of [
      "/etc/passwd",
      "/usr/bin/env",
      "/Users/sandbox-test-user/.ssh/id_rsa",
      "/Users/sandbox-test-user/secrets",
    ]) {
      const target = canonicalizeSandboxPath(outside);
      expect(resolvePathAccess(target, "read", table), `read ${target}`).toBe("deny");
      expect(resolvePathAccess(target, "write", table), `write ${target}`).toBe("deny");
    }
  });

  test("the runtime roots stay reachable, so the deny is not vacuous", () => {
    // With absent/empty paths the ONLY thing an enabled agent can touch is its
    // own runtime roots — proving the profile denies BY DEFAULT rather than
    // allowing by default (a missing block granting access) or denying
    // everything (which would fail to boot).
    const table = sandboxPathAccessTable(missing, PARAMS);
    const worktreeFile = canonicalizeSandboxPath(join(PARAMS.WORKTREE, "src/index.ts"));
    expect(resolvePathAccess(worktreeFile, "read", table)).toBe("allow");
    expect(resolvePathAccess(worktreeFile, "write", table)).toBe("allow");
  });
});

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

  test("emits the sorted runtime roots and the non-spawner tmux deny (canSpawnChildren false)", () => {
    const lines = generateProfile(EMPTY_CONFIG, EMPTY_PATHS, PARAMS).trimEnd().split("\n");
    expect(lines).toEqual([
      "(version 1)",
      "(deny default)",
      '(allow file-read* (subpath (param "AGENTDIR")))',
      '(allow file-write* (subpath (param "AGENTDIR")))',
      // REPOAGENTS is a READ root for a non-spawner, so its write is denied.
      '(allow file-read* (subpath (param "REPOAGENTS")))',
      '(deny file-write* (subpath (param "REPOAGENTS")))',
      '(allow file-read* (subpath (param "GITDIR")))',
      '(allow file-write* (subpath (param "GITDIR")))',
      '(allow file-read* (subpath (param "WORKTREE")))',
      '(allow file-write* (subpath (param "WORKTREE")))',
      // No PARENTCLAUDE root. The tmux socket is carved out last for a
      // non-spawner: a file deny (both ops) AND a network-outbound unix-socket
      // deny (the connect the file deny does not stop), after rawAllow so it
      // last-match-wins over _all.md's blanket unix-socket allow.
      '(deny file-read* (subpath (param "TMUXSOCK")))',
      '(deny file-write* (subpath (param "TMUXSOCK")))',
      '(deny network-outbound (remote unix-socket (subpath (param "TMUXSOCK"))))',
      '(deny file-write* (regex #"^/private/tmp/\\.ib-seal-helper-[0-9a-f-]+(/.*)?$"))',
    ]);
  });

  test("emits REPOAGENTS write, a PARENTCLAUDE write root, and no tmux deny (canSpawnChildren true)", () => {
    const spawner: SandboxProfileParams = { ...PARAMS, canSpawnChildren: true };
    const lines = generateProfile(EMPTY_CONFIG, EMPTY_PATHS, spawner).trimEnd().split("\n");
    expect(lines).toEqual([
      "(version 1)",
      "(deny default)",
      '(allow file-read* (subpath (param "AGENTDIR")))',
      '(allow file-write* (subpath (param "AGENTDIR")))',
      // REPOAGENTS is now a WRITE root (no write deny).
      '(allow file-read* (subpath (param "REPOAGENTS")))',
      '(allow file-write* (subpath (param "REPOAGENTS")))',
      '(allow file-read* (subpath (param "GITDIR")))',
      '(allow file-write* (subpath (param "GITDIR")))',
      '(allow file-read* (subpath (param "WORKTREE")))',
      '(allow file-write* (subpath (param "WORKTREE")))',
      // PARENTCLAUDE (/private/tmp/itsybitsy-repo/.claude, 4 segments) sorts in
      // the 4-segment group after WORKTREE; it is write, and there is no tmux
      // deny for a spawner.
      '(allow file-read* (subpath (param "PARENTCLAUDE")))',
      '(allow file-write* (subpath (param "PARENTCLAUDE")))',
      '(deny file-write* (regex #"^/private/tmp/\\.ib-seal-helper-[0-9a-f-]+(/.*)?$"))',
    ]);
  });

  test("reserved seal-helper results stay readable but never writable after broad raw allows", () => {
    const broadTmp = paths({ allowRead: ["/private/tmp"], allowWrite: ["/private/tmp"] });
    const profile = generateProfile(
      config({ rawAllow: ["(allow file-read*)", "(allow file-write*)"] }),
      broadTmp,
      PARAMS,
    );
    const definitions = sandboxProfileParameterValues(broadTmp, PARAMS);
    const resultDir = `/private/tmp/${SEAL_HELPER_RESULT_PREFIX}01234567-89ab-cdef-0123-456789abcdef`;
    expect(evaluateProfileAccess(profile, definitions, resultDir, "read")).toBe("allow");
    expect(evaluateProfileAccess(profile, definitions, join(resultDir, "output"), "read")).toBe("allow");
    expect(evaluateProfileAccess(profile, definitions, resultDir, "write")).toBe("deny");
    expect(evaluateProfileAccess(profile, definitions, join(resultDir, "output"), "write")).toBe("deny");
    expect(evaluateProfileAccess(profile, definitions, "/private/tmp/ordinary-sibling", "write")).toBe("allow");
  });

  test("flipping canSpawnChildren changes exactly REPOAGENTS op, the PARENTCLAUDE root, and the tmux deny", () => {
    // Resume re-derives canSpawnChildren from meta, so a meta.canSpawnChildren
    // toggle between spawn and resume must change ONLY these three things and
    // leave every other line — AGENTDIR/WORKTREE/GITDIR, the floor, the read
    // line for REPOAGENTS — byte-identical. A floor and config denies are
    // included so the assertion covers a realistic profile, not just the roots.
    const floor = paths({
      allowRead: ["/usr", "~/.claude"],
      allowWrite: ["/private/tmp", "~/.itsybitsy/agents"],
      deny: ["**/.env"],
    });
    const rawConfig = config({ rawAllow: ["(allow process*)", "(deny network*)"] });
    const nonSpawner = generateProfile(rawConfig, floor, { ...PARAMS, canSpawnChildren: false })
      .trimEnd().split("\n");
    const spawner = generateProfile(rawConfig, floor, { ...PARAMS, canSpawnChildren: true })
      .trimEnd().split("\n");

    const onlyInNonSpawner = nonSpawner.filter((line) => !spawner.includes(line));
    const onlyInSpawner = spawner.filter((line) => !nonSpawner.includes(line));

    expect(onlyInNonSpawner.sort()).toEqual([
      '(deny file-read* (subpath (param "TMUXSOCK")))',
      '(deny file-write* (subpath (param "REPOAGENTS")))',
      '(deny file-write* (subpath (param "TMUXSOCK")))',
      '(deny network-outbound (remote unix-socket (subpath (param "TMUXSOCK"))))',
    ]);
    expect(onlyInSpawner.sort()).toEqual([
      '(allow file-read* (subpath (param "PARENTCLAUDE")))',
      '(allow file-write* (subpath (param "PARENTCLAUDE")))',
      '(allow file-write* (subpath (param "REPOAGENTS")))',
    ]);
    // The shared read line for REPOAGENTS is untouched by the flip.
    for (const profile of [nonSpawner, spawner]) {
      expect(profile).toContain('(allow file-read* (subpath (param "REPOAGENTS")))');
    }

    // The -D parameter set gains PARENTCLAUDE / drops TMUXSOCK accordingly.
    const nonSpawnerParams = sandboxProfileParameterValues(floor, { ...PARAMS, canSpawnChildren: false });
    const spawnerParams = sandboxProfileParameterValues(floor, { ...PARAMS, canSpawnChildren: true });
    expect("TMUXSOCK" in nonSpawnerParams).toBe(true);
    expect("PARENTCLAUDE" in nonSpawnerParams).toBe(false);
    expect("TMUXSOCK" in spawnerParams).toBe(false);
    expect("PARENTCLAUDE" in spawnerParams).toBe(true);
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
    // Use a spawner (canSpawnChildren: true) so there is NO tmux-socket
    // network-outbound deny in the profile: with empty rawAllow the profile then
    // has zero network lines, so any "network" or domain string would be a leak
    // from the domains list (which must go to the proxy allowlist, not SBPL).
    const profile = generateProfile(
      config({ domains: ["example.com"] }),
      EMPTY_PATHS,
      { ...PARAMS, canSpawnChildren: true },
    );
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

test("LIVE macOS profile protects trusted seal-helper results while ordinary tmp stays writable", async () => {
  const sandboxExec = Bun.which("sandbox-exec");
  if (process.platform !== "darwin" || !sandboxExec) {
    console.log("LIVE seal-helper result probe: SKIPPED (sandbox-exec is absent; macOS only)");
    return;
  }
  const capability = Bun.spawnSync({
    cmd: [sandboxExec, "-p", "(version 1)(allow default)", "/usr/bin/true"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const capabilityError = capability.stderr.toString().trim();
  if (capability.exitCode !== 0 && capabilityError.includes("sandbox_apply: Operation not permitted")) {
    console.log("LIVE seal-helper result probe: SKIPPED (nested sandbox-exec is unavailable)");
    return;
  }
  if (capability.exitCode !== 0) {
    throw new Error(`LIVE seal-helper capability check failed: ${capabilityError}`);
  }

  const uuid = crypto.randomUUID();
  const resultDir = `/private/tmp/${SEAL_HELPER_RESULT_PREFIX}${uuid}`;
  const newResultDir = `/private/tmp/${SEAL_HELPER_RESULT_PREFIX}${crypto.randomUUID()}`;
  const movedResultDir = `${resultDir}-moved`;
  const sibling = `/private/tmp/ib-seal-helper-ordinary-${crypto.randomUUID()}`;
  await mkdir(resultDir, { mode: 0o700 });
  await writeFile(join(resultDir, "output"), "trusted");
  await writeFile(join(resultDir, "result"), "0\n");
  try {
    const params = { ...PARAMS, canSpawnChildren: true };
    const profile = generateProfile(config({ rawAllow: ["(allow default)"] }), EMPTY_PATHS, params);
    const definitions = sandboxProfileParameterValues(EMPTY_PATHS, params);
    const args = Object.entries(definitions).flatMap(([key, value]) => ["-D", `${key}=${value}`]);
    const script = [
      `value=$(cat '${join(resultDir, "output")}')`,
      `printf 'read=%s\\n' "$value"`,
      `mkdir '${newResultDir}' 2>/dev/null; printf 'mkdir=%s\\n' "$?"`,
      `printf forged > '${join(resultDir, "output")}' 2>/dev/null; printf 'overwrite_output=%s\\n' "$?"`,
      `printf 0 > '${join(resultDir, "result")}' 2>/dev/null; printf 'overwrite_result=%s\\n' "$?"`,
      `touch '${join(resultDir, "created")}' 2>/dev/null; printf 'create=%s\\n' "$?"`,
      `rm -f '${join(resultDir, "output")}' 2>/dev/null; printf 'unlink_output=%s\\n' "$?"`,
      `rm -f '${join(resultDir, "result")}' 2>/dev/null; printf 'unlink_result=%s\\n' "$?"`,
      `mv '${resultDir}' '${movedResultDir}' 2>/dev/null; printf 'rename=%s\\n' "$?"`,
      `printf ordinary > '${sibling}' 2>/dev/null; printf 'sibling=%s\\n' "$?"`,
    ].join("; ");
    const probe = Bun.spawnSync({
      cmd: [sandboxExec, "-p", profile, ...args, "/bin/sh", "-c", script],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(probe.exitCode).toBe(0);
    const fields = Object.fromEntries(
      probe.stdout.toString().trim().split("\n").map((line) => line.split("=", 2)),
    );
    expect(fields.read).toBe("trusted");
    for (const operation of [
      "mkdir", "overwrite_output", "overwrite_result", "create",
      "unlink_output", "unlink_result", "rename",
    ]) {
      expect(fields[operation]).not.toBe("0");
    }
    expect(fields.sibling).toBe("0");
    expect(await readFile(join(resultDir, "output"), "utf8")).toBe("trusted");
  } finally {
    await rm(resultDir, { recursive: true, force: true });
    await rm(newResultDir, { recursive: true, force: true });
    await rm(movedResultDir, { recursive: true, force: true });
    await rm(sibling, { force: true });
  }
});

describe("agy state runtime root (AGYSTATEDIR, ~/.gemini)", () => {
  // A concrete home-relative dir; the resolver/profile canonicalize it the same
  // way (longest existing prefix), so /tmp maps to /private/tmp under the hood.
  const agyDir = "/private/tmp/itsybitsy-agy-state/.gemini";
  const withAgy: SandboxProfileParams = { ...PARAMS, AGYSTATEDIR: agyDir };

  test("an absent AGYSTATEDIR leaves the profile byte-identical (non-agy unchanged)", () => {
    const withUndefined: SandboxProfileParams = { ...PARAMS, AGYSTATEDIR: undefined };
    expect(generateProfile(EMPTY_CONFIG, EMPTY_PATHS, withUndefined)).toBe(
      generateProfile(EMPTY_CONFIG, EMPTY_PATHS, PARAMS),
    );
  });

  test("a present AGYSTATEDIR emits read+write roots as a -D param", () => {
    const profile = generateProfile(EMPTY_CONFIG, EMPTY_PATHS, withAgy);
    expect(profile).not.toBe(generateProfile(EMPTY_CONFIG, EMPTY_PATHS, PARAMS));
    expect(profile).toContain('(allow file-read* (subpath (param "AGYSTATEDIR")))');
    expect(profile).toContain('(allow file-write* (subpath (param "AGYSTATEDIR")))');
    expect(sandboxProfileParameterValues(EMPTY_PATHS, withAgy).AGYSTATEDIR).toBe(
      canonicalizeSandboxPath(agyDir),
    );
  });

  test("write is allowed anywhere inside the agy state root", () => {
    const table = sandboxPathAccessTable(EMPTY_PATHS, withAgy);
    // Both antigravity-cli/ and its SIBLING config/ live under ~/.gemini.
    expect(resolvePathAccess(`${agyDir}/antigravity-cli/settings.json`, "write", table)).toBe("allow");
    expect(resolvePathAccess(`${agyDir}/config/config.json`, "write", table)).toBe("allow");
  });

  test("a paths.deny entry still carves a hole inside the agy state root (deny wins)", () => {
    const table = sandboxPathAccessTable(paths({ deny: [`${agyDir}/config`] }), withAgy);
    expect(resolvePathAccess(`${agyDir}/antigravity-cli/settings.json`, "write", table)).toBe("allow");
    expect(resolvePathAccess(`${agyDir}/config/config.json`, "write", table)).toBe("deny");
    expect(resolvePathAccess(`${agyDir}/config/config.json`, "read", table)).toBe("deny");
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
  async function buildAccessFixtures(): Promise<AccessFixture[]> {
    const home = "/Users/sandbox-test-user";
    const ordinaryParams: SandboxProfileParams = {
      AGENTDIR: "/runtime/repo/.ittybitty/agents/oracle",
      WORKTREE: "/runtime/repo/.ittybitty/agents/oracle/repo",
      GITDIR: "/runtime/repo/.git/worktrees/oracle",
      REPOAGENTS: "/runtime/repo/.ittybitty/agents",
      PARENTCLAUDE: "/runtime/repo/.claude",
      TMUXSOCK: "/private/tmp/tmux-501",
      canSpawnChildren: false,
      HOME: home,
    };
    const developerParams: SandboxProfileParams = {
      AGENTDIR: `${home}/Developer/app/.ittybitty/agents/oracle`,
      WORKTREE: `${home}/Developer/app/.ittybitty/agents/oracle/repo`,
      GITDIR: `${home}/Developer/app/.git/worktrees/oracle`,
      REPOAGENTS: `${home}/Developer/app/.ittybitty/agents`,
      PARENTCLAUDE: `${home}/Developer/app/.claude`,
      TMUXSOCK: "/private/tmp/tmux-501",
      canSpawnChildren: false,
      HOME: home,
    };
    const allFrontmatter = parseAgentTypeFile(
      await Bun.file(join(import.meta.dir, "../docs/agent-types/_all.md")).text(),
    ).frontmatter;
    const allPaths = allFrontmatter.paths as PathsConfig;
    const canonicalAllPaths = canonicalizePathsConfig(allPaths, home);

    return [
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
  }

  test("resolver and emitted last-match profile agree across required shuffled fixtures", async () => {
    const fixtures = await buildAccessFixtures();
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

  test("normalizePathsConfig and the sorted access table agree on every fixture", async () => {
    // The write-wins exact-tie dedupe now lives in one shared helper. Prove the
    // exported normalizePathsConfig (Phase B) and the production access table
    // (sortedAllowEntries, reached through generateProfile/resolvePathAccess)
    // stay in lockstep: pre-normalizing the authored lists must change neither
    // the emitted profile nor any resolver decision, because the table already
    // collapses the same cross-list ties.
    const fixtures = await buildAccessFixtures();
    for (const fixture of fixtures) {
      const home = fixture.params.HOME!;
      const merged = mergeFixtureLayers(fixture.layers);
      const normalized = normalizePathsConfig(merged, home);
      expect(
        generateProfile(EMPTY_CONFIG, normalized, fixture.params),
        `${fixture.name}: profile identical after normalize`,
      ).toBe(generateProfile(EMPTY_CONFIG, merged, fixture.params));

      const rawTable = sandboxPathAccessTable(merged, fixture.params);
      const normTable = sandboxPathAccessTable(normalized, fixture.params);
      for (const check of fixture.checks) {
        const target = canonicalizeSandboxPath(check.path);
        for (const op of ["read", "write"] as const) {
          expect(
            resolvePathAccess(target, op, normTable),
            `${fixture.name}: normalized ${op} ${target}`,
          ).toBe(resolvePathAccess(target, op, rawTable));
        }
      }
    }
  });

  test("prepareAccessTable + resolvePreparedAccess match the wrapper and never mutate", async () => {
    // The two-step form (prepare once, resolve many) must be answer-identical to
    // the resolvePathAccess wrapper on every fixture, and resolving must leave
    // the prepared table untouched so one prepared table serves any number of
    // lookups. The JSON snapshot captures the full sorted/compiled shape.
    const fixtures = await buildAccessFixtures();
    for (const fixture of fixtures) {
      const table = sandboxPathAccessTable(mergeFixtureLayers(fixture.layers), fixture.params);
      const prepared = prepareAccessTable(table);
      const snapshot = JSON.stringify(prepared);
      for (const check of fixture.checks) {
        const target = canonicalizeSandboxPath(check.path);
        for (const op of ["read", "write"] as const) {
          expect(
            resolvePreparedAccess(prepared, target, op),
            `${fixture.name}: two-step ${op} ${target}`,
          ).toBe(resolvePathAccess(target, op, table));
        }
      }
      expect(
        JSON.stringify(prepared),
        `${fixture.name}: prepared table mutated by resolving`,
      ).toBe(snapshot);
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
    // A tmux-socket stand-in under the /private/tmp write floor. For a
    // non-spawner the profile carves this out with a deny; a sibling directly
    // under /private/tmp stays writable. Parameterizing TMUXSOCK to this path
    // lets the live kernel probe exercise the deny without a real tmux server.
    const tmuxSockStandin = join("/private/tmp", `itsybitsy-sandbox-tmux-${crypto.randomUUID()}`);
    // A sibling directly under /private/tmp but NOT under the tmux stand-in, so
    // it stays writable for both a spawner and a non-spawner (R3 iii).
    const tmuxSiblingFile = join("/private/tmp", `itsybitsy-sandbox-tmux-sib-${crypto.randomUUID()}`);
    // R3(i) the "~/Documents denied" relation: a home path in NO floor list.
    // The temp HOME (root) lives under the /private/var/folders write floor, so
    // nothing under it is uncovered; a temp dir under the REAL home is outside
    // every floor entry (the floor's home entries expand to the temp HOME, not
    // the real home), reproducing exactly the relation ~/Documents has.
    const createdDeniedHome = await mkdtemp(join(homedir(), "itsybitsy-sandbox-denied-"));
    const deniedHome = canonicalizeSandboxPath(createdDeniedHome);
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
        PARENTCLAUDE: join(root, "Developer/app/.claude"),
        TMUXSOCK: tmuxSockStandin,
        canSpawnChildren: false,
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
      // The temp HOME (root) lives under /private/var/folders, an allowWrite
      // floor. With "~" dropped from allowRead (A3), a loose file at the home
      // root is no longer shadowed read-only by "~"; it is now governed by the
      // /private/var/folders write floor, so it is read+write.
      const homeVarFoldersWritable = join(root, "loose-home.txt");
      const homeClaudeWrite = join(root, ".claude/probe.txt"); // ~/.claude allowWrite
      const homeItsybitsyWrite = join(root, ".itsybitsy/agents/probe.txt"); // ~/.itsybitsy/agents allowWrite
      const homeItsybitsyRead = join(root, ".itsybitsy/state.json"); // ~/.itsybitsy read, write denied
      // R3(i): ~/.itsybitsy/agent-types is under ~/.itsybitsy (read) but NOT
      // under ~/.itsybitsy/agents (write), so it is read-only — the floor grants
      // agents write without opening agent-types.
      const homeItsybitsyAgentTypes = join(root, ".itsybitsy/agent-types/config.json");
      // A4 G3: the sealed-record dir is denied for BOTH read and write to every
      // sandboxed agent. It sits under ~/.itsybitsy (a read floor) but the
      // _all.md deny carves it out (deny wins), and it is in no allowWrite list —
      // so a sandboxed non-spawner can neither read its own seal nor forge one.
      const homeItsybitsySealed = join(root, ".itsybitsy/sealed/live-agent.json");
      // R3(i): a file under the real-home stand-in — outside every floor entry,
      // so both operations are denied (the ~/Documents relation).
      const deniedHomeFile = join(deniedHome, "Documents", "secret.txt");
      // R3(iii): a file inside the tmux-socket stand-in dir (the TMUXSOCK deny
      // covers the whole subtree for a non-spawner).
      const tmuxSockFile = join(tmuxSockStandin, "default");
      const devNull = "/dev/null"; // /dev allowWrite root, already present
      const outsideWriteFile = join(outsideHome, "plain.txt"); // /private/var/folders allowWrite
      const outsideReadOnlyDir = join(outsideHome, "readonly");
      const outsideReadOnlyFile = join(outsideReadOnlyDir, "file.txt"); // read-only under write ancestor (R2)
      // N3 glob arms: one writable tree proves the JS→Seatbelt regex translation
      // against the real kernel regex engine. A deny glob (**/.env under the
      // tree) and an allowRead glob (globs/*.md, a read-only hole punched into a
      // plain write root) both compile to (regex #"…"); every file below asserts
      // agreement with resolvePathAccess.
      const globTree = join(root, "examples/glob-tree");     // plain allowWrite root
      const globDenyEnv = join(globTree, "**/.env");         // deny glob (globstar)
      const globReadMd = join(globTree, "globs/*.md");       // allowRead glob (single *)
      const globTreeEnv = join(globTree, ".env");            // denied: **/.env, zero dirs
      const globTreeSubEnv = join(globTree, "sub/.env");     // denied: **/.env, one dir
      const globTreeSubNotes = join(globTree, "sub/notes.txt"); // writable: no glob matches
      const globMdReadOnly = join(globTree, "globs/a.md");   // read-only via globs/*.md
      const globTxtWritable = join(globTree, "globs/a.txt"); // writable: *.md misses .txt
      const globDeepMd = join(globTree, "globs/deep/b.md");  // writable: * never crosses /
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
        homeVarFoldersWritable,
        homeClaudeWrite,
        homeItsybitsyWrite,
        homeItsybitsyRead,
        homeItsybitsyAgentTypes,
        homeItsybitsySealed,
        deniedHomeFile,
        outsideWriteFile,
        outsideReadOnlyFile,
        tmpWriteProbe,
        tmuxSockFile,
        tmuxSiblingFile,
        globTreeEnv,
        globTreeSubEnv,
        globTreeSubNotes,
        globMdReadOnly,
        globTxtWritable,
        globDeepMd,
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
          globReadMd,
        ],
        allowWrite: [exampleOneRoot, join(exampleTwoRoot, "Documents"), dirname(tieFile), globTree],
        deny: [globDenyEnv],
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
        // runtime root writable. With "~" dropped from allowRead (A3), a loose
        // file at the temp HOME root is governed by the /private/var/folders
        // write floor it lives under, not by "~".
        { label: "floor/repoagents-read-only", path: repoAgentsFile },
        { label: "floor/home-under-var-folders-writable", path: homeVarFoldersWritable },
        { label: "floor/home-claude-write", path: homeClaudeWrite },
        { label: "floor/home-itsybitsy-agents-write", path: homeItsybitsyWrite },
        { label: "floor/home-itsybitsy-read-only", path: homeItsybitsyRead },
        // R3(i): ~/.itsybitsy/agents writable, ~/.itsybitsy/agent-types read-only,
        // and a real-home path (the ~/Documents relation) denied for both ops.
        { label: "floor/home-itsybitsy-agent-types-read-only", path: homeItsybitsyAgentTypes },
        // A4 G3: the sealed-record dir is denied for BOTH ops (deny wins over the
        // ~/.itsybitsy read floor) — a sandboxed process can neither read nor
        // write under it.
        { label: "floor/home-itsybitsy-sealed-denied", path: homeItsybitsySealed },
        { label: "floor/home-documents-relation-denied", path: deniedHomeFile },
        { label: "floor/dev-null-write", path: devNull },
        { label: "floor/var-folders-write", path: outsideWriteFile },
        { label: "floor/read-only-under-write-ancestor", path: outsideReadOnlyFile },
        { label: "floor/private-tmp-write", path: tmpWriteProbe },
        // N3 (a): deny glob **/.env matches the tree root and a nested dir, but
        // never a sibling non-.env file, which stays writable under the tree.
        { label: "glob-deny/env-zero-dir", path: globTreeEnv },
        { label: "glob-deny/env-nested", path: globTreeSubEnv },
        { label: "glob-deny/sibling-writable", path: globTreeSubNotes },
        // N3 (b): allowRead glob globs/*.md is a read-only hole in the write
        // root; a non-matching .txt stays writable, and single * never crosses
        // a segment so a deeper .md stays writable.
        { label: "glob-read/md-read-only", path: globMdReadOnly },
        { label: "glob-read/txt-writable", path: globTxtWritable },
        { label: "glob-read/deep-md-writable", path: globDeepMd },
      ];
      const table: PathAccessTable = sandboxPathAccessTable(livePaths, params);
      // The floor no longer lists "/" or "~" for reading (A3, Adam 2026-09-02):
      // a read of "/" itself resolves to deny, and the kernel lists the root
      // node only through the rawAllow line (allow file-read-data (literal
      // "/")). That is the one sanctioned resolver/kernel divergence
      // (SPEC-SANDBOX.md 4A.8), which resolvePathAccess does not model on
      // purpose. A path under "/" with no deeper floor entry is now denied for
      // both operations.
      expect(resolvePathAccess("/", "read", table)).toBe("deny");
      expect(resolvePathAccess("/Applications/itsybitsy-nonexistent-probe", "read", table)).toBe("deny");
      expect(resolvePathAccess("/Applications/itsybitsy-nonexistent-probe", "write", table)).toBe("deny");
      const results: string[] = [];
      // Batch every (path, op) probe into ONE sandbox-exec run: a /bin/sh script
      // cats/echoes each path and prints "label:op:exit". Every sh subprocess
      // inherits the same Seatbelt profile, so the kernel decisions are identical
      // to separate runs, but the probe pays ONE sandbox_apply instead of ~50 —
      // which keeps it fast even under load (G3).
      const sq = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
      const batchScript = checks.flatMap((check) => [
        `cat ${sq(check.path)} >/dev/null 2>&1; echo "${check.label}:read:$?"`,
        `echo x > ${sq(check.path)} 2>/dev/null; echo "${check.label}:write:$?"`,
      ]).join("\n");
      const batch = Bun.spawnSync({
        cmd: [sandboxExec, "-f", profilePath, ...definitionArgs, "/bin/sh", "-c", batchScript],
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20000,
      });
      const exitByKey = new Map<string, number>();
      for (const line of batch.stdout.toString().split("\n")) {
        const m = line.match(/^(.+):(read|write):(\d+)$/);
        if (m) exitByKey.set(`${m[1]}:${m[2]}`, Number(m[3]));
      }
      for (const check of checks) {
        for (const op of ["read", "write"] as const) {
          const exit = exitByKey.get(`${check.label}:${op}`);
          if (exit === undefined) {
            throw new Error(reproduce(
              `LIVE batch probe missing a result for ${check.label}:${op}\n` +
              `--- batch stdout ---\n${batch.stdout.toString()}\n` +
              `--- batch stderr ---\n${batch.stderr.toString()}`,
            ));
          }
          const expected = resolvePathAccess(check.path, op, table);
          const actual = exit === 0 ? "allow" : "deny";
          results.push(`${check.label}:${op}=${exit}`);
          if (actual !== expected) {
            throw new Error(reproduce(
              `LIVE sandbox disagreement for ${check.label} ${op}: resolver=${expected}, ` +
              `exit=${exit}\nprobe path: ${check.path}`,
            ));
          }
        }
      }
      // R3(i) resolver relations, asserted directly so a floor regression that
      // accidentally opens one of these fails loudly rather than passing on mere
      // kernel/resolver agreement.
      expect(resolvePathAccess(homeItsybitsyWrite, "write", table)).toBe("allow");
      expect(resolvePathAccess(homeItsybitsyAgentTypes, "read", table)).toBe("allow");
      expect(resolvePathAccess(homeItsybitsyAgentTypes, "write", table)).toBe("deny");
      expect(resolvePathAccess(deniedHomeFile, "read", table)).toBe("deny");
      expect(resolvePathAccess(deniedHomeFile, "write", table)).toBe("deny");

      // R3(ii): the sanctioned root-listing divergence, live. `ls /` succeeds
      // through the rawAllow (allow file-read-data (literal "/")) even though the
      // resolver reports deny for a read of "/"; `ls /Applications` (outside the
      // floor) is denied by BOTH the kernel and the resolver.
      const lsRoot = Bun.spawnSync({
        cmd: [sandboxExec, "-f", profilePath, ...definitionArgs, "/bin/ls", "/"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (lsRoot.exitCode !== 0) {
        throw new Error(reproduce(
          `LIVE root-listing broken: 'ls /' exit=${lsRoot.exitCode}, stderr=${lsRoot.stderr.toString().trim()}`,
        ));
      }
      const lsApplications = Bun.spawnSync({
        cmd: [sandboxExec, "-f", profilePath, ...definitionArgs, "/bin/ls", "/Applications"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (lsApplications.exitCode === 0) {
        throw new Error(reproduce(
          `LIVE floor breach: 'ls /Applications' unexpectedly succeeded (it is outside the floor)`,
        ));
      }
      results.push(`ls-root=${lsRoot.exitCode}`, `ls-applications=${lsApplications.exitCode}`);

      // R3(iii): the tmux-socket escape. A non-spawner denies writing the tmux
      // stand-in while a /private/tmp sibling stays writable; a spawner allows
      // both (the escape is kept). Build the spawner profile with the same live
      // floor and probe both arms against their own resolver table.
      const spawnerParams: SandboxProfileParams = { ...params, canSpawnChildren: true };
      const spawnerProfile = generateProfile(liveConfig, livePaths, spawnerParams);
      const spawnerProfilePath = join(root, "live-spawner.sb");
      await Bun.write(spawnerProfilePath, spawnerProfile);
      const spawnerArgs = Object.entries(sandboxProfileParameterValues(livePaths, spawnerParams))
        .flatMap(([key, value]) => ["-D", `${key}=${value}`]);
      const spawnerTable: PathAccessTable = sandboxPathAccessTable(livePaths, spawnerParams);
      const spawnerCompile = Bun.spawnSync({
        cmd: [sandboxExec, "-f", spawnerProfilePath, ...spawnerArgs, "/usr/bin/true"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (spawnerCompile.exitCode !== 0) {
        throw new Error(
          `LIVE spawner profile compile failed (${spawnerCompile.exitCode}): ` +
          `${spawnerCompile.stderr.toString().trim()}\n--- profile ---\n${spawnerProfile}`,
        );
      }
      // Assert the intended relations directly, so a broken keying fails loudly.
      expect(resolvePathAccess(tmuxSockFile, "write", table)).toBe("deny");
      expect(resolvePathAccess(tmuxSiblingFile, "write", table)).toBe("allow");
      expect(resolvePathAccess(tmuxSockFile, "write", spawnerTable)).toBe("allow");
      expect(resolvePathAccess(tmuxSiblingFile, "write", spawnerTable)).toBe("allow");
      const tmuxArms = [
        { label: "non-spawner", sb: profilePath, args: definitionArgs, tbl: table },
        { label: "spawner", sb: spawnerProfilePath, args: spawnerArgs, tbl: spawnerTable },
      ];
      for (const arm of tmuxArms) {
        for (const probe of [
          { label: "tmux-socket", path: tmuxSockFile },
          { label: "tmux-sibling", path: tmuxSiblingFile },
        ]) {
          const write = Bun.spawnSync({
            cmd: [sandboxExec, "-f", arm.sb, ...arm.args, "/bin/sh", "-c", 'echo x > "$1"', "probe", probe.path],
            stdout: "pipe",
            stderr: "pipe",
          });
          const expected = resolvePathAccess(probe.path, "write", arm.tbl);
          const actual = write.exitCode === 0 ? "allow" : "deny";
          results.push(`${arm.label}/${probe.label}:write=${write.exitCode}`);
          if (actual !== expected) {
            throw new Error(
              `LIVE tmux disagreement (${arm.label}) for ${probe.label}: resolver=${expected}, ` +
              `exit=${write.exitCode}, stderr=${write.stderr.toString().trim()}\n` +
              `profile: ${arm.sb}\n-D args: ${arm.args.join(" ")}\nprobe path: ${probe.path}`,
            );
          }
        }
      }

      // F1: the real tmux escape is a unix-socket connect(), which Seatbelt
      // gates under network-outbound — the file deny above does NOT stop it. Bind
      // real unsandboxed unix listeners at a socket INSIDE the tmux stand-in dir
      // (denied for a non-spawner via the network-outbound deny) and at a sibling
      // OUTSIDE it (always allowed, so the floor's blanket unix-socket allow
      // stays intact), then attempt a sandboxed `nc -U` connect. Intended policy,
      // asserted directly (the resolver models only file access, not network):
      // non-spawner CANNOT connect the inside socket but CAN the outside one;
      // spawner CAN connect both. nc's `-w 1` gives a successful connect a 1s
      // idle floor, so run all four connects CONCURRENTLY (Bun.spawn) — their
      // waits overlap to ~1s wall-clock instead of ~3s serial (G3).
      const nc = Bun.which("nc");
      if (nc) {
        const insideSock = join(tmuxSockStandin, "s");                   // under TMUXSOCK
        const outsideSock = join("/private/tmp", `ib-sock-${crypto.randomUUID()}`); // sibling
        const listeners = [
          Bun.listen({ unix: insideSock, socket: { open(s) { s.end(); }, data() {}, close() {} } }),
          Bun.listen({ unix: outsideSock, socket: { open(s) { s.end(); }, data() {}, close() {} } }),
        ];
        // Never let a listener keep a reused bun test worker alive; stop(true)
        // closes them the moment the rows are done.
        for (const listener of listeners) listener.unref();
        try {
          const socketArms = [
            { label: "non-spawner", sb: profilePath, args: definitionArgs, insideConnects: false },
            { label: "spawner", sb: spawnerProfilePath, args: spawnerArgs, insideConnects: true },
          ];
          const jobs = socketArms.flatMap((arm) => (
            [
              { arm, kind: "inside" as const, sock: insideSock },
              { arm, kind: "outside" as const, sock: outsideSock },
            ].map((job) => ({
              ...job,
              proc: Bun.spawn({
                cmd: [sandboxExec, "-f", job.arm.sb, ...job.arm.args, nc, "-U", "-w", "1", job.sock],
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            }))
          ));
          // All four were launched above (Bun.spawn is non-blocking); awaiting
          // now collects them concurrently.
          const settled = await Promise.all(jobs.map(async (job) => ({
            ...job,
            exit: await job.proc.exited,
            stderr: (await new Response(job.proc.stderr).text()).trim(),
          })));
          for (const arm of socketArms) {
            const inside = settled.find((s) => s.arm === arm && s.kind === "inside")!;
            const outside = settled.find((s) => s.arm === arm && s.kind === "outside")!;
            results.push(
              `${arm.label}/tmux-connect-inside=${inside.exit}`,
              `${arm.label}/tmux-connect-outside=${outside.exit}`,
            );
            if ((inside.exit === 0) !== arm.insideConnects) {
              throw new Error(
                `LIVE tmux CONNECT policy violation (${arm.label}): inside-socket connect exit=${inside.exit} ` +
                `(want ${arm.insideConnects ? "connect" : "DENIED"}), stderr=${inside.stderr}\n` +
                `profile: ${arm.sb}\n-D args: ${arm.args.join(" ")}\nsocket: ${insideSock}`,
              );
            }
            if (outside.exit !== 0) {
              throw new Error(
                `LIVE tmux CONNECT policy violation (${arm.label}): outside-socket connect exit=${outside.exit} ` +
                `(want connect — the floor's unix-socket allow must stay intact), stderr=${outside.stderr}\n` +
                `profile: ${arm.sb}\n-D args: ${arm.args.join(" ")}\nsocket: ${outsideSock}`,
              );
            }
          }
        } finally {
          for (const listener of listeners) listener.stop(true);
          await rm(outsideSock, { force: true });
        }
      } else {
        results.push("tmux-connect=SKIPPED(no nc)");
      }

      console.log(`LIVE sandbox probe: compile=${compileResult.exitCode}; ${results.join(", ")}`);
    } finally {
      await rm(createdRoot, { recursive: true, force: true });
      await rm(createdOutsideHome, { recursive: true, force: true });
      await rm(createdDeniedHome, { recursive: true, force: true });
      await rm(tmpWriteProbe, { force: true });
      await rm(tmuxSockStandin, { recursive: true, force: true });
      await rm(tmuxSiblingFile, { force: true });
    }
  }, 120000);
});

describe("LIVE claude boot under the floor", () => {
  test("the new _all.md floor boots claude to a network/API error, not a SIGABRT or silent death", async () => {
    // Opt-in: this gate runs a real claude that hangs on the kernel-denied
    // network for the full run timeout, so it is off by default to keep an
    // ordinary `bun test` fast. Run it with:
    //   IB_LIVE_BOOT=1 bun test src/sandbox.test.ts --test-name-pattern "LIVE claude boot"
    if (process.env.IB_LIVE_BOOT !== "1") {
      console.log("LIVE claude boot: SKIPPED (set IB_LIVE_BOOT=1 to run the live claude boot gate)");
      return;
    }
    const sandboxExec = Bun.which("sandbox-exec");
    if (process.platform !== "darwin" || !sandboxExec) {
      console.log("LIVE claude boot: SKIPPED (sandbox-exec is absent; macOS only)");
      return;
    }
    const claudePath = Bun.which("claude");
    if (!claudePath) {
      console.log("LIVE claude boot: SKIPPED (claude is not on PATH)");
      return;
    }
    // Same nested-Seatbelt guard as the LIVE probe: a harness that is itself
    // sandboxed cannot apply a nested profile, so the gate is not applicable.
    const capability = Bun.spawnSync({
      cmd: [sandboxExec, "-p", "(version 1)(allow default)", "/usr/bin/true"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const capabilityError = capability.stderr.toString().trim();
    if (capability.exitCode !== 0 && capabilityError.includes("sandbox_apply: Operation not permitted")) {
      console.log(
        `LIVE claude boot: SKIPPED (sandbox-exec cannot apply a nested profile: exit=${capability.exitCode}, stderr=${capabilityError})`,
      );
      return;
    }
    if (capability.exitCode !== 0) {
      throw new Error(`LIVE claude boot capability check failed (${capability.exitCode}): ${capabilityError}`);
    }

    const createdRoot = await mkdtemp(join(tmpdir(), "itsybitsy-claude-boot-"));
    const root = canonicalizeSandboxPath(createdRoot);
    try {
      const baseline = parseAgentTypeFile(
        await Bun.file(join(import.meta.dir, "../docs/agent-types/_all.md")).text(),
      ).frontmatter;
      const floorPaths = baseline.paths as PathsConfig;
      const baselineSandbox = baseline.sandbox as SandboxConfig;

      // A production-shaped agent layout: the agent dir holds the worktree at
      // /repo, REPOAGENTS is the parent-repo registry, PARENTCLAUDE the parent
      // repo's .claude, all under the temp root. HOME is the REAL home so the
      // floor's ~/.claude, ~/.claude.json, and ~/Library/Keychains grant the
      // real config claude reads at boot (the floor was bisected against it).
      const repoRoot = join(root, "repo-root");
      const repoAgents = join(repoRoot, ".ittybitty", "agents");
      const agentDir = join(repoAgents, "boot");
      const worktree = join(agentDir, "repo");
      const parentClaude = join(repoRoot, ".claude");
      for (const dir of [repoAgents, agentDir, worktree, parentClaude]) {
        await mkdir(dir, { recursive: true });
      }
      const gitInit = Bun.spawnSync({ cmd: ["git", "init", "-q"], cwd: worktree, stdout: "pipe", stderr: "pipe" });
      if (gitInit.exitCode !== 0) {
        throw new Error(`LIVE claude boot: git init failed (${gitInit.exitCode}): ${gitInit.stderr.toString().trim()}`);
      }
      const uid = process.getuid?.() ?? 0;
      const params: SandboxProfileParams = {
        AGENTDIR: agentDir,
        WORKTREE: worktree,
        GITDIR: join(worktree, ".git"),
        REPOAGENTS: repoAgents,
        PARENTCLAUDE: parentClaude,
        TMUXSOCK: join("/private/tmp", `tmux-${uid}`),
        canSpawnChildren: false,
        HOME: homedir(),
      };
      const bootConfig: SandboxConfig = {
        enabled: true,
        rawAllow: [...baselineSandbox.rawAllow],
        domains: [],
      };
      const profile = generateProfile(bootConfig, floorPaths, params);
      const profilePath = join(root, "boot.sb");
      await Bun.write(profilePath, profile);
      const defArgs = Object.entries(sandboxProfileParameterValues(floorPaths, params))
        .flatMap(([key, value]) => ["-D", `${key}=${value}`]);

      const compile = Bun.spawnSync({
        cmd: [sandboxExec, "-f", profilePath, ...defArgs, "/usr/bin/true"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (compile.exitCode !== 0) {
        throw new Error(
          `LIVE claude boot: floor profile failed to compile (${compile.exitCode}): ` +
          `${compile.stderr.toString().trim()}\n--- profile ---\n${profile}`,
        );
      }

      // Network is kernel-denied and no proxy is set, so claude must BOOT and
      // then report an API/network error. Unset the proxy vars so it attempts a
      // direct (kernel-denied) connection rather than reaching localhost.
      const childEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) childEnv[key] = value;
      }
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
        delete childEnv[key];
      }

      const runTimeoutMs = 30000;
      const start = Date.now();
      const run = Bun.spawnSync({
        cmd: [sandboxExec, "-f", profilePath, ...defArgs, claudePath, "-p", "reply with the single word OK"],
        cwd: worktree,
        env: childEnv,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: runTimeoutMs,
      });
      const elapsed = Date.now() - start;
      const stdout = run.stdout.toString();
      const stderr = run.stderr.toString();
      const combined = `${stdout}${stderr}`.trim();
      const sigabrt = run.exitCode === 134 || run.signalCode === "SIGABRT";
      const outcome =
        `elapsed=${elapsed}ms exit=${run.exitCode} signal=${run.signalCode ?? "none"} ` +
        `stdout.len=${stdout.length} stderr.len=${stderr.length}`;

      // A BROKEN floor makes Bun/Node SIGABRT at init (a missing root-dir read,
      // docs/SANDBOX-BASELINE-MINIMAL.md §(a)) — a near-instant zero-output
      // crash. A BOOTED claude instead reaches the network layer; with the
      // kernel denying egress and no proxy, this claude version hangs silently
      // retrying and is killed at the timeout (exit 143 — the baseline's
      // documented "fully offline" fail-closed proof, and identical to its
      // UNSANDBOXED offline behavior). The two are distinguished by SIGABRT and
      // by whether claude ran long enough to have booted and reached the
      // network. bootReachedMs is far above a crash (~1s) and comfortably below
      // the booted-then-hung run (it hangs to the 30s run timeout).
      const bootReachedMs = 15000;
      const booted = combined.length > 0 || elapsed >= bootReachedMs;
      if (sigabrt || !booted) {
        throw new Error(
          `LIVE claude boot FAILED under the floor ` +
          `(${sigabrt ? "SIGABRT — a read path is missing" : "fast silent death — claude did not reach boot"}): ${outcome}\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n` +
          `profile: ${profilePath}\n-D args: ${defArgs.join(" ")}\n--- profile ---\n${profile}`,
        );
      }

      expect(sigabrt).toBe(false);
      expect(booted).toBe(true);
      console.log(
        `LIVE claude boot: BOOTED under the floor (no SIGABRT; ran ${elapsed}ms then blocked on the ` +
        `kernel-denied network — the baseline exit-143 fail-closed proof). ${outcome}\n` +
        `stdout(first 300): ${stdout.slice(0, 300).replace(/\s+/g, " ").trim() || "(empty)"}\n` +
        `stderr(first 300): ${stderr.slice(0, 300).replace(/\s+/g, " ").trim() || "(empty)"}`,
      );
    } finally {
      await rm(createdRoot, { recursive: true, force: true });
    }
  }, 60000);
});

describe("resolver input contract", () => {
  test("each entry point rejects relative input with an error naming itself", () => {
    const table = sandboxPathAccessTable(EMPTY_PATHS, PARAMS);
    expect(() => resolvePathAccess("relative/path", "read", table))
      .toThrow("resolvePathAccess requires an absolute path");
    const prepared = prepareAccessTable(table);
    expect(() => resolvePreparedAccess(prepared, "relative/path", "read"))
      .toThrow("resolvePreparedAccess requires an absolute path");
  });

  test("the target is canonicalized so /tmp and /private/tmp resolve identically", () => {
    // The write root is canonical (/private/tmp/…). A Phase B caller passing the
    // /tmp spelling must resolve the same, not silently deny — the resolver
    // canonicalizes the input the same way the table entries were canonicalized.
    const table = sandboxPathAccessTable(paths({ allowWrite: ["/private/tmp/canon-agree"] }), PARAMS);
    for (const op of ["read", "write"] as const) {
      const viaTmp = resolvePathAccess("/tmp/canon-agree/file", op, table);
      const viaPrivate = resolvePathAccess("/private/tmp/canon-agree/file", op, table);
      expect(viaTmp).toBe("allow");
      expect(viaTmp).toBe(viaPrivate);
    }
  });
});

describe("sandbox config resolution (default enabled)", () => {
  test("an omitted sandbox block still resolves to an ENABLED sandbox", () => {
    expect(resolveSandboxConfig({})).toEqual({
      enabled: true,
      rawAllow: [],
      domains: [],
    });
  });

  test("explicit false disables sandboxing without changing lists or source", () => {
    const source: SandboxConfig = { enabled: false, rawAllow: ["(allow process*)"], domains: ["example.com"] };
    const resolved = resolveSandboxConfig({ sandbox: source });
    expect(resolved).toEqual(source);
    expect(resolved).not.toBe(source);
    expect(source.enabled).toBe(false);
  });

  test("an omitted enabled value defaults true while preserving lists", () => {
    expect(resolveSandboxConfig({ sandbox: { rawAllow: [], domains: ["example.com"] } }))
      .toEqual({ enabled: true, rawAllow: [], domains: ["example.com"] });
  });

  test("an explicit enabled:true resolves enabled with its lists carried through", () => {
    const explicit = config({ domains: ["example.com"] });
    expect(resolveSandboxConfig({ sandbox: explicit })).toEqual({
      enabled: true,
      rawAllow: [],
      domains: ["example.com"],
    });
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
  test("accepts the complete flat schema (rawAllow + domains, no enabled)", () => {
    expect(validateSandboxFrontmatter({ rawAllow: [], domains: [] })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  test.each([null, "str", 42, ["list"]])(
    "invalid sandbox shapes are rejected (%p)",
    (value) => {
      expect(validateSandboxFrontmatter(value).errors).toEqual([
        "sandbox must be a boolean or an object with enabled, rawAllow and domains fields",
      ]);
    },
  );

  test.each([true, false])("accepts boolean shorthand and enabled field %s", (enabled) => {
    expect(validateSandboxFrontmatter(enabled).errors).toEqual([]);
    expect(validateSandboxFrontmatter({ enabled }).errors).toEqual([]);
  });

  test.each(["false", "true  # note", 0, null])("rejects non-boolean enabled %p", (enabled) => {
    expect(validateSandboxFrontmatter({ enabled }).errors).toEqual(["sandbox.enabled must be a boolean"]);
  });

  test("reports invalid enablement alongside list errors", () => {
    const result = validateSandboxFrontmatter({ enabled: "false", domains: "not-a-list" });
    expect(result.errors).toContain("sandbox.enabled must be a boolean");
    expect(result.errors).toContain("sandbox.domains must be a list");
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
    const result = validateSandboxFrontmatter({ filesystem: {} });
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

  test("rejects relative entries without the allowRelative option", () => {
    for (const entry of ["./x", "../fumble", "../../fumble/**/*.md"]) {
      expect(validatePathsFrontmatter({ allowRead: [entry] }).errors.length)
        .toBeGreaterThan(0);
    }
  });

  test("accepts relative entries only with allowRelative", () => {
    for (const entry of ["./x", "../fumble", "../../fumble/**/*.md"]) {
      expect(
        validatePathsFrontmatter({ allowRead: [entry] }, "/Users/tester", {
          allowRelative: true,
        }).errors,
      ).toEqual([]);
    }
  });

  test("still rejects bare names even with allowRelative", () => {
    expect(
      validatePathsFrontmatter({ allowRead: ["bare-name"] }, "/Users/tester", {
        allowRelative: true,
      }).errors.length,
    ).toBeGreaterThan(0);
  });

  test("rejects cross-list RELATIVE globs sharing a literal prefix under allowRelative", () => {
    const result = validatePathsFrontmatter(
      { allowRead: ["../shared/**/*.pdf"], allowWrite: ["../shared/**/*.txt"] },
      "/Users/tester",
      { allowRelative: true },
    );
    expect(result.errors.some((e) => e.includes("same literal prefix"))).toBe(true);
  });

  test("accepts cross-list RELATIVE globs with different prefixes under allowRelative", () => {
    const result = validatePathsFrontmatter(
      { allowRead: ["../read-only/**/*.pdf"], allowWrite: ["../writable/**/*.txt"] },
      "/Users/tester",
      { allowRelative: true },
    );
    expect(result.errors).toEqual([]);
  });
});

describe("findRelativeEscapes", () => {
  const HOME = "/Users/tester";
  const ANCHOR = "/Users/tester/a/b/c"; // three segments below HOME
  const UP_TO_ROOT = "../".repeat(50); // over-climbs; path.resolve clamps at "/"

  test("flags a plain ../ climb to the filesystem root", () => {
    const result = findRelativeEscapes(paths({ allowRead: [UP_TO_ROOT] }), ANCHOR, HOME);
    expect(result.map((e) => e.entry)).toEqual([UP_TO_ROOT]);
    expect(result[0]!.resolved).toBe("/");
  });

  test("flags a glob ../ climb to the filesystem root", () => {
    const entry = `${UP_TO_ROOT}**`;
    const result = findRelativeEscapes(paths({ allowWrite: [entry] }), ANCHOR, HOME);
    expect(result.map((e) => e.entry)).toEqual([entry]);
    expect(result[0]!.resolved).toBe("/");
  });

  test("flags a plain ../ climb to the home directory", () => {
    const result = findRelativeEscapes(paths({ allowRead: ["../../.."] }), ANCHOR, HOME);
    expect(result.map((e) => e.entry)).toEqual(["../../.."]);
    expect(result[0]!.resolved).toBe(canonicalizeSandboxPath(HOME));
  });

  test("flags a glob ../ climb to the home directory (deny list is inspected too)", () => {
    const result = findRelativeEscapes(paths({ deny: ["../../../**"] }), ANCHOR, HOME);
    expect(result.map((e) => e.entry)).toEqual(["../../../**"]);
    expect(result[0]!.resolved).toBe(canonicalizeSandboxPath(HOME));
  });

  test("does not flag explicit / or ~, nor a bounded relative entry", () => {
    expect(findRelativeEscapes(paths({ allowRead: ["/", "~", "~/x"] }), ANCHOR, HOME)).toEqual([]);
    expect(
      findRelativeEscapes(paths({ allowRead: ["../sibling"], allowWrite: ["./vendor"] }), ANCHOR, HOME),
    ).toEqual([]);
  });
});

describe("anchorRelativePaths", () => {
  const ANCHOR = "/Users/tester/Developer/repo";

  test("anchors ../ at the sibling of the repo root", () => {
    expect(anchorRelativePaths(paths({ allowRead: ["../fumble"] }), ANCHOR)).toEqual(
      paths({ allowRead: ["/Users/tester/Developer/fumble"] }),
    );
  });

  test("anchors ./ inside the repo root", () => {
    expect(anchorRelativePaths(paths({ allowWrite: ["./build"] }), ANCHOR)).toEqual(
      paths({ allowWrite: ["/Users/tester/Developer/repo/build"] }),
    );
  });

  test("anchors the literal prefix of a relative glob and re-appends the suffix", () => {
    expect(
      anchorRelativePaths(paths({ deny: ["../../fumble/**/*.md"] }), ANCHOR),
    ).toEqual(paths({ deny: ["/Users/tester/fumble/**/*.md"] }));
  });

  test("anchors a glob fused onto a relative name without inventing a separator", () => {
    expect(anchorRelativePaths(paths({ allowRead: ["../fumble*.md"] }), ANCHOR)).toEqual(
      paths({ allowRead: ["/Users/tester/Developer/fumble*.md"] }),
    );
  });

  test("leaves absolute, home, and non-relative glob entries untouched", () => {
    const input = paths({
      allowRead: ["/usr", "~/.claude", "**/.env"],
      allowWrite: ["/private/tmp"],
      deny: ["~/secrets/*"],
    });
    expect(anchorRelativePaths(input, ANCHOR)).toEqual(input);
  });
});
