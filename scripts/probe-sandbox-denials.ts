/** Host-side capability probe; intentionally separate from agent lifecycle.
 * Prepare without executing restricted commands:
 *   bun scripts/probe-sandbox-denials.ts
 * Run on an authorized macOS host:
 *   bun scripts/probe-sandbox-denials.ts --run
 * Raw reports are evidence to inspect, never automatically attributed or a pass.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentTypeFile } from "../src/agent-types";
import {
  canonicalizeSandboxPath, generateProfile, sandboxProfileParameterValues,
  type PathsConfig, type SandboxConfig, type SandboxProfileParams,
} from "../src/sandbox";
import { sandboxDefinitionArgs } from "../src/sandbox-launch";

const root = canonicalizeSandboxPath(await mkdtemp(join(tmpdir(), "ib-denial-probe-")));
const denied = join(root, "forbidden");
await mkdir(denied);
await writeFile(join(denied, "read.txt"), "probe fixture\n");
const baseline = parseAgentTypeFile(await Bun.file(
  join(import.meta.dir, "../docs/agent-types/_all.md"),
).text()).frontmatter;
const floor = baseline.paths as PathsConfig;
const paths: PathsConfig = {
  allowRead: [...floor.allowRead], allowWrite: [...floor.allowWrite],
  deny: [...floor.deny, denied],
};
const params: SandboxProfileParams = {
  AGENTDIR: root, WORKTREE: root, GITDIR: join(root, "git"),
  REPOAGENTS: root, PARENTCLAUDE: join(root, "claude"),
  TMUXSOCK: join(root, "tmux"), canSpawnChildren: false, HOME: root,
};
const profile = join(root, "sandbox.sb");
await writeFile(profile, generateProfile(baseline.sandbox as SandboxConfig, paths, params));
const prefix = ["/usr/bin/sandbox-exec", "-f", profile,
  ...sandboxDefinitionArgs(sandboxProfileParameterValues(paths, params))];
const predicate = '(subsystem == "com.apple.sandbox.reporting" AND category == "violation") OR (eventMessage CONTAINS "Sandbox:")';
const streamArgv = ["/usr/bin/log", "stream", "--style", "ndjson", "--level", "debug", "--predicate", predicate];
const cases = [
  { name: "sandbox-capability", argv: ["/usr/bin/sandbox-exec", "-p", "(version 1) (allow default)", "/usr/bin/true"] },
  { name: "generated-profile-boot", argv: [...prefix, "/usr/bin/true"] },
  { name: "startup-read", argv: [...prefix, "/bin/cat", join(denied, "read.txt")] },
  { name: "short-lived-children", argv: [...prefix, "/bin/sh", "-c",
    'printf "parent=%s\\n" "$$"; /bin/cat "$1/read.txt" & r=$!; printf "read-child=%s\\n" "$r"; wait "$r"; /bin/sh -c \'printf x > "$1/write.txt"\' sh "$1" & w=$!; printf "write-child=%s\\n" "$w"; wait "$w"',
    "sh", denied] },
];
await writeFile(join(root, "plan.json"), JSON.stringify({
  root, denied, streamArgv, cases,
  note: "PIDs and timing here are probe observations, not production attribution identities.",
}, null, 2));
console.log(`Probe artifacts: ${root}`);
if (!process.argv.includes("--run")) {
  console.log("Prepared only. No sandbox or log command executed. Use --run on an authorized macOS host.");
  process.exit(0);
}
if (process.platform !== "darwin") throw new Error("Live probe requires macOS; no live pass.");

// Keep capture bounded while still draining pipes; report truncation explicitly.
async function capture(stream: ReadableStream<Uint8Array>, file: string) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let saved = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    const part = chunk.subarray(0, Math.max(0, 8 * 1024 * 1024 - saved));
    if (part.length) chunks.push(part);
    saved += part.length;
  }
  await writeFile(file, Buffer.concat(chunks));
  return { totalBytes: total, savedBytes: saved, truncated: total > saved };
}
const log = Bun.spawn(streamArgv, { stdout: "pipe", stderr: "pipe" });
const stdout = capture(log.stdout, join(root, "events.ndjson"));
const stderr = capture(log.stderr, join(root, "log.stderr"));
const observations: unknown[] = [];
try {
  // This delay is a probe variable, not a verified stream readiness handshake.
  await Bun.sleep(2000);
  if (log.exitCode !== null) throw new Error(`log stream exited ${log.exitCode}; inspect log.stderr; no live pass.`);
  for (const item of cases) {
    const started = new Date().toISOString();
    const child = Bun.spawn(item.argv, { stdout: "pipe", stderr: "pipe" });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 5000);
    const out = capture(child.stdout, join(root, `${item.name}.stdout`));
    const err = capture(child.stderr, join(root, `${item.name}.stderr`));
    try {
      const exitCode = await child.exited;
      observations.push({ name: item.name, pid: child.pid, started,
        ended: new Date().toISOString(), exitCode, signal: child.signalCode,
        timedOut, stdout: await out, stderr: await err });
    } finally { clearTimeout(timer); }
  }
  // Include delayed delivery after short-lived children have exited.
  await Bun.sleep(10000);
} finally {
  log.kill();
  await log.exited;
  await writeFile(join(root, "observations.json"), JSON.stringify({
    observations, streamExitCode: log.exitCode, stdout: await stdout, stderr: await stderr,
    writeCreated: await Bun.file(join(denied, "write.txt")).exists(),
    status: "UNVERIFIED: inspect raw events and command errors; nonzero exits alone do not prove enforcement or reporting.",
  }, null, 2));
}
console.log("Capture complete, NOT an acceptance pass. Inspect events.ndjson, log.stderr and observations.json.");
