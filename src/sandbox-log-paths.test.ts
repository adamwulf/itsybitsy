import { expect, test } from "bun:test";
import { join } from "node:path";
import { sandboxLogParent, sandboxProfilePath } from "./sandbox-log-paths";
import { parseAgentTypeFile } from "./agent-types";
import { generateProfile, newSandboxTag, sandboxPathAccessTable, resolvePathAccess } from "./sandbox";
import type { PathsConfig } from "./sandbox";

test("launch namespaces are stable per agent, distinct across agents, and below the sealed root", () => {
  const a = sandboxLogParent("/private/tmp/agent-a", "/private/tmp/test-home");
  expect(a).toMatch(/^\/private\/tmp\/test-home\/\.itsybitsy\/sealed\/sandbox-logs\/[a-f0-9]{64}$/);
  expect(sandboxLogParent("/private/tmp/agent-a/.", "/private/tmp/test-home")).toBe(a);
  expect(sandboxLogParent("/private/tmp/agent-b", "/private/tmp/test-home")).not.toBe(a);
  expect(sandboxProfilePath("/private/tmp/agent-a", "/private/tmp/test-home")).toBe(join(a, "sandbox.sb"));
});

test("shipped floor denies the tagged profile and collector control files even with broad agent access", async () => {
  const floor = parseAgentTypeFile(await Bun.file(join(import.meta.dir, "../docs/agent-types/_all.md")).text()).frontmatter;
  const home = "/private/tmp/sandbox-control-home";
  for (const canSpawnChildren of [false, true]) {
    const params = { HOME: home, AGENTDIR: `${home}/agent`, WORKTREE: home,
      GITDIR: `${home}/git`, REPOAGENTS: `${home}/agents`, PARENTCLAUDE: `${home}/parent-claude`,
      TMUXSOCK: `${home}/tmux`, canSpawnChildren };
    const paths = { allowRead: [home], allowWrite: [home], deny: (floor.paths as PathsConfig).deny ?? [] };
    const table = sandboxPathAccessTable(paths, params);
    expect(resolvePathAccess(`${home}/ordinary-file`, "write", table)).toBe("allow");
    // The profile holds the launch's secret tag nonce: no agent can read it,
    // not even one that can read and write every other path of this home.
    // Neither can the agent whose profile it is, nor another agent of the repo.
    for (const agentDir of [params.AGENTDIR, `${params.REPOAGENTS}/other`]) {
      expect(resolvePathAccess(sandboxProfilePath(agentDir, home), "read", table)).toBe("deny");
      expect(resolvePathAccess(sandboxProfilePath(agentDir, home), "write", table)).toBe("deny");
    }
    for (const name of ["stop", "registration.json", "ready", "failed", "done"]) {
      const target = join(sandboxLogParent(params.AGENTDIR, home), "sandbox-log.ABC12345", name);
      expect(resolvePathAccess(target, "read", table)).toBe("deny");
      expect(resolvePathAccess(target, "write", table)).toBe("deny");
    }
    const tag = newSandboxTag();
    const profile = generateProfile({ enabled: true, rawAllow: [], domains: [] }, paths, params, tag);
    expect(profile).toContain(`(deny file-read* (subpath "${home}/.itsybitsy/sealed") (with message "${tag}"))`);
    expect(profile).toContain(`(deny file-write* (subpath "${home}/.itsybitsy/sealed") (with message "${tag}"))`);
  }
});
