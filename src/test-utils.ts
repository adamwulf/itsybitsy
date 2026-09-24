/**
 * Shared test utilities for itsybitsy tests.
 */

import type { Agent, AgentMeta, FlatEntry } from "./agents";
import type { AgentState } from "./parse-state";
import type { SpawnResult, FetchLike } from "./types";

/** Create a test Agent with sensible defaults. All fields can be overridden. */
export function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    repoPath: "/tmp/test",
    repoName: "test",
    state: "unknown",
    age: "1m",
    archived: false,
    children: [],
    meta: {
      id: overrides.id,
      session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      tmux_session: `tmux-${overrides.id}`,
      prompt: "test prompt",
      manager: null,
      created: "2026-03-05T00:00:00Z",
      created_epoch: Math.floor(Date.now() / 1000) - 60,
      worktree: true,
      worker: false,
      model: "claude:sonnet",
      claude_pid: "12345",
      ...(overrides.meta ?? {}),
    } as AgentMeta,
    ...overrides,
  };
}

/** Create a FlatEntry of kind "agent" for tests */
export function makeFlatAgent(agent: Agent, overrides?: { depth?: number; connector?: string }): Extract<FlatEntry, { kind: "agent" }> {
  return {
    kind: "agent",
    agent,
    depth: overrides?.depth ?? 0,
    connector: overrides?.connector ?? "",
  };
}

/** Create a FlatEntry of kind "repo-header" for tests */
export function makeFlatRepoHeader(repoName: string, repoPath: string = "", hasAgents: boolean = false, hasRunningAgents: boolean = false, hasNonStoppedAgents: boolean = false): Extract<FlatEntry, { kind: "repo-header" }> {
  return { kind: "repo-header", repoName, repoPath, hasAgents, hasRunningAgents, hasNonStoppedAgents };
}

/** Create a FlatEntry of kind "system-coordinator" for tests */
export function makeFlatSystemCoordinator(state = "running", age = "5m"): Extract<FlatEntry, { kind: "system-coordinator" }> {
  return { kind: "system-coordinator", state, age };
}

/**
 * Set an agent's state field. Centralizes the type assertion needed because
 * AgentState is a string-literal union but tests often assign arbitrary state strings.
 */
export function setAgentState(agent: Agent, state: string): void {
  agent.state = state as AgentState;
}

/**
 * Create a SpawnResult that resolves with the given exit code and optional stdout/stderr content.
 * Eliminates repetitive `{ stdout: new Response("").body!, stderr: ... } as SpawnResult` in tests.
 */
export function makeSpawnResult(exitCode = 0, stdout = "", stderr = ""): SpawnResult {
  return {
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
    exited: Promise.resolve(exitCode),
  };
}

/**
 * Create a mock FetchLike function that returns the given response data.
 * Eliminates `(async () => ({ ok, json: async () => data })) as any` casts.
 */
export function mockFetch(data: unknown, ok = true, status = 200): FetchLike {
  return (async () => ({
    ok,
    status,
    json: async () => data,
  })) as unknown as FetchLike;
}

/**
 * Poll `condition` until it returns true, then resolve. Throws if it never
 * becomes true within `timeoutMs`.
 *
 * Use this instead of a fixed `Bun.sleep(n)` whenever a test needs to observe
 * the result of fire-and-forget async work (a debounced write, a detached
 * promise, a spawned subprocess). A fixed sleep encodes a guess about how long
 * that work takes on an idle machine; when the machine is busy the work takes
 * longer, the sleep expires early, and the test fails for reasons that have
 * nothing to do with the behaviour under test.
 *
 * Waiting on the real condition is both more robust AND faster: it returns as
 * soon as the condition holds rather than always burning the full sleep. The
 * timeout only bounds the failure case, so it can be generous without slowing
 * down the passing path — but it sits just under bun's 5s default per-test
 * timeout so that a stuck wait reports *what* it was waiting for rather than
 * losing the race to a generic "test timed out".
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 4000, intervalMs = 5, message = "condition" }: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for: ${message}`);
    }
    await Bun.sleep(intervalMs);
  }
}

/**
 * Poll `produce` until it returns a non-null/non-undefined value, then return
 * it. Throws on timeout. The value-returning companion to {@link waitFor} —
 * for "wait until this file parses / this record appears" style waits.
 */
export async function waitForValue<T>(
  produce: () => T | null | undefined | Promise<T | null | undefined>,
  { timeoutMs = 4000, intervalMs = 5, message = "value" }: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitForValue timed out after ${timeoutMs}ms waiting for: ${message}`);
    }
    await Bun.sleep(intervalMs);
  }
}

// ── TOML / codex `-c` decoding oracles ──────────────────────────────────────
//
// The codex launch passes free text (the agent's role instructions) as
// `-c developer_instructions="…"`. These helpers decode that value the way
// codex's spec-compliant Rust `toml` parser would. They are written from the
// TOML 1.0 grammar, NOT from the encoder, so a round trip checks the encoder
// against the spec. Bun.TOML.parse is NOT used: Bun 1.3.10 drops `\t`, rejects
// valid `\uXXXX` escapes, and treats U+2028 as a line end.

/**
 * Strictly decode one TOML 1.0 basic string literal (`"…"`), per the grammar:
 *   basic-unescaped = wschar / %x21 / %x23-5B / %x5D-7E / non-ascii
 *   escape-seq-char = " \ b f n r t / uXXXX / UXXXXXXXX (Unicode scalar values)
 * Throws on anything the grammar rejects (a raw control character, a raw `"`,
 * an unknown escape, a surrogate escape, a missing closing quote).
 */
export function decodeTomlBasicString(literal: string): string {
  const cps = Array.from(literal);
  const last = cps.length - 1;
  if (cps.length < 2 || cps[0] !== '"' || cps[last] !== '"') {
    throw new Error("not a TOML basic string: it must start and end with a double quote");
  }
  let out = "";
  for (let i = 1; i < last; i++) {
    const ch = cps[i]!;
    if (ch === '"') throw new Error(`unescaped double quote at code point ${i}`);
    if (ch === "\\") {
      i++;
      if (i >= last) throw new Error("escape at end of string: the closing quote is escaped");
      const esc = cps[i]!;
      switch (esc) {
        case '"': out += '"'; break;
        case "\\": out += "\\"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "u":
        case "U": {
          const len = esc === "u" ? 4 : 8;
          if (i + len > last - 1) throw new Error(`truncated \\${esc} escape`);
          const hex = cps.slice(i + 1, i + 1 + len).join("");
          if (!/^[0-9A-Fa-f]+$/.test(hex)) throw new Error(`bad hex in \\${esc}${hex}`);
          const value = parseInt(hex, 16);
          if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
            throw new Error(`\\${esc}${hex} is not a Unicode scalar value`);
          }
          out += String.fromCodePoint(value);
          i += len;
          break;
        }
        default:
          throw new Error(`invalid escape \\${esc}`);
      }
      continue;
    }
    const code = ch.codePointAt(0)!;
    const allowed =
      code === 0x20 || code === 0x09 || code === 0x21 ||
      (code >= 0x23 && code <= 0x5b) || (code >= 0x5d && code <= 0x7e) ||
      (code >= 0x80 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0x10ffff);
    if (!allowed) {
      throw new Error(`U+${code.toString(16).toUpperCase().padStart(4, "0")} must be escaped in a basic string`);
    }
    out += ch;
  }
  return out;
}

/**
 * Decode a codex `-c key=<value>` payload whose value is a TOML basic string,
 * mirroring codex: split at the FIRST `=`, trim both halves, then parse the
 * value. Throws when the value is not a valid basic string (codex would then
 * silently fall back to the raw text, which is exactly the corruption the
 * tests must catch).
 */
export function decodeCodexStringOverride(payload: string): { key: string; value: string } {
  const eq = payload.indexOf("=");
  if (eq === -1) throw new Error(`codex override has no '=': ${payload.slice(0, 40)}`);
  return {
    key: payload.slice(0, eq).trim(),
    value: decodeTomlBasicString(payload.slice(eq + 1).trim()),
  };
}

let pythonTomllibAvailable: boolean | undefined;

/**
 * True when `python3` with the standard `tomllib` (a spec-compliant TOML 1.0
 * parser, Python 3.11+) can run. Tests use it as a second, fully independent
 * oracle and skip that check where it is missing.
 */
export function hasPythonTomllib(): boolean {
  if (pythonTomllibAvailable === undefined) {
    try {
      const probe = Bun.spawnSync(["python3", "-c", "import tomllib"], { stdout: "ignore", stderr: "ignore" });
      pythonTomllibAvailable = probe.exitCode === 0;
    } catch {
      pythonTomllibAvailable = false;
    }
  }
  return pythonTomllibAvailable;
}

/**
 * Decode a TOML basic string literal with Python's `tomllib`. The value comes
 * back as ASCII-only JSON, so no byte is lost between the two runtimes. Throws
 * when tomllib rejects the literal.
 */
export function pythonTomlDecodeBasicString(literal: string): string {
  const script =
    "import json, sys, tomllib\n" +
    "doc = tomllib.loads(sys.stdin.buffer.read().decode('utf-8'))\n" +
    "sys.stdout.write(json.dumps(doc['_x_']))\n";
  const result = Bun.spawnSync(["python3", "-c", script], {
    stdin: Buffer.from(`_x_ = ${literal}\n`, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`python tomllib rejected the literal: ${result.stderr.toString()}`);
  }
  return JSON.parse(result.stdout.toString()) as string;
}

/**
 * Read one shell word, built by `shellQuote` (single-quoted segments joined by
 * `\'`), starting at `start`. Stops at the first unquoted whitespace. Throws on
 * any other unquoted character, since `shellQuote` never emits one.
 */
function readShellQuotedWord(script: string, start: number): { word: string; end: number } {
  let i = start;
  let word = "";
  while (i < script.length && !/\s/.test(script[i]!)) {
    const c = script[i]!;
    if (c === "'") {
      const close = script.indexOf("'", i + 1);
      if (close === -1) throw new Error("unterminated single quote in shell word");
      word += script.slice(i + 1, close);
      i = close + 1;
    } else if (c === "\\" && i + 1 < script.length) {
      word += script[i + 1];
      i += 2;
    } else {
      throw new Error(`unexpected unquoted character ${JSON.stringify(c)} in shell word`);
    }
  }
  return { word, end: i };
}

/**
 * Return the role instructions a generated codex start.sh / resume.sh passes
 * as `-c developer_instructions="…"`: shell-unquote the argument, then decode
 * it the way codex does. The scripts carry the launch line twice (setsid and
 * plain arms); throws unless every copy is identical, or if there is none.
 */
export function codexDeveloperInstructionsFromScript(script: string): string {
  const marker = "'developer_instructions=";
  const words: string[] = [];
  for (let from = 0; ;) {
    const start = script.indexOf(marker, from);
    if (start === -1) break;
    const { word, end } = readShellQuotedWord(script, start);
    words.push(word);
    from = end;
  }
  if (words.length === 0) throw new Error("script has no developer_instructions argument");
  if (new Set(words).size !== 1) throw new Error("developer_instructions differs between launch arms");
  const { key, value } = decodeCodexStringOverride(words[0]!);
  if (key !== "developer_instructions") throw new Error(`unexpected override key ${key}`);
  return value;
}
