import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { homedir } from "os";
import {
  buildCodexLaunchArgs,
  isCodexSafeBinaryPath,
  renderCodexHookFlagPayload,
  CODEX_REGISTERED_EVENTS,
  DEFAULT_CODEX_HOOK_TIMEOUT_SECS,
  FUGU_CODEX_CONFIG_OVERRIDES,
} from "./codex-config";
import { setCoordinatorHome, resetCoordinatorHome } from "./coordinator";

// Pin the coordinator-home to a stable, safe absolute path so assertions about
// the always-prepended `--add-dir <coordinatorHome>` pair are deterministic
// regardless of the real ~/.itsybitsy/ on the host. Real installs always
// resolve to a path under $HOME with no apostrophes/quotes/backslashes, so
// pinning to a hand-crafted safe path is fine for the well-formedness tests.
const FAKE_COORDINATOR_HOME = "/tmp/codex-config-test-home";

// The Library/Caches grant is derived from $HOME at call time, so pin $HOME
// to a stable, shell-safe path for the same reason.
//
// NB: pinning $HOME via process.env.HOME works ONLY because production reads
// `process.env.HOME || homedir()` — env first, then homedir() fallback. Node's
// os.homedir() does NOT re-read $HOME at runtime (it's cached from the initial
// userInfo lookup). If anyone flips the operand order in production to
// `homedir() || process.env.HOME`, these tests will keep passing while the
// real binary reads the actual host home — a silent breakage. Don't flip it.
const FAKE_HOME = "/tmp/codex-config-test-home-dir";
const FAKE_LIBRARY_CACHES = `${FAKE_HOME}/Library/Caches`;
const ORIGINAL_HOME = process.env.HOME;

// Pin process.platform to "darwin" for the positional-argv tests. The
// Library/Caches grant only fires on macOS, so on Linux/Windows CI the args
// array would lack that pair and every `--add-dir`-position assertion would
// shift back. The non-darwin behavior gets its own dedicated test below.
const originalPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

beforeEach(() => {
  setCoordinatorHome(FAKE_COORDINATOR_HOME);
  process.env.HOME = FAKE_HOME;
  setPlatform("darwin");
});
afterEach(() => {
  resetCoordinatorHome();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  setPlatform(originalPlatform);
});

describe("FUGU_CODEX_CONFIG_OVERRIDES — Sakana tool-type guard", () => {
  test("keeps the Sakana provider block", () => {
    expect(FUGU_CODEX_CONFIG_OVERRIDES).toContain('model_provider="sakana"');
    expect(FUGU_CODEX_CONFIG_OVERRIDES).toContain(
      'model_providers.sakana.base_url="https://api.sakana.ai/v1"',
    );
    expect(FUGU_CODEX_CONFIG_OVERRIDES).toContain('model_providers.sakana.wire_api="responses"');
  });

  test("disables Codex's API-typed built-in tools (image_generation + web_search)", () => {
    // Sakana's Responses API only accepts tool types `function` and `custom`;
    // Codex's default `image_generation` and `web_search` tools use other API
    // types and abort the whole request. These exact `-c` payloads (verified
    // against codex-cli 0.141.0) turn both off. See the comment in codex-config.ts.
    expect(FUGU_CODEX_CONFIG_OVERRIDES).toContain("features.image_generation=false");
    expect(FUGU_CODEX_CONFIG_OVERRIDES).toContain('web_search="disabled"');
  });
});

describe("isCodexSafeBinaryPath", () => {
  test("accepts a normal absolute install path", () => {
    expect(isCodexSafeBinaryPath("/usr/local/bin/ib")).toBe(true);
    expect(isCodexSafeBinaryPath("/Users/alice/Developer/itsybitsy/ib")).toBe(true);
  });

  test("rejects apostrophes (would close the shell single-quoted arg)", () => {
    expect(isCodexSafeBinaryPath("/Users/o'malley/bin/ib")).toBe(false);
  });

  test("rejects double quotes (would corrupt the TOML string literal)", () => {
    expect(isCodexSafeBinaryPath('/some/"weird"/path/ib')).toBe(false);
  });

  test("rejects backslashes (would escape inside the TOML string)", () => {
    expect(isCodexSafeBinaryPath("/some/back\\slash/ib")).toBe(false);
  });

  test("rejects control characters", () => {
    expect(isCodexSafeBinaryPath("/path/with\nnewline/ib")).toBe(false);
    expect(isCodexSafeBinaryPath("/path/with\ttab/ib")).toBe(false);
    expect(isCodexSafeBinaryPath("/path/with\x00null/ib")).toBe(false);
    expect(isCodexSafeBinaryPath("/path/with\x7fdel/ib")).toBe(false);
  });

  test("rejects empty / non-string inputs", () => {
    expect(isCodexSafeBinaryPath("")).toBe(false);
    // @ts-expect-error — test runtime guard against non-strings
    expect(isCodexSafeBinaryPath(undefined)).toBe(false);
    // @ts-expect-error — test runtime guard against non-strings
    expect(isCodexSafeBinaryPath(null)).toBe(false);
  });
});

describe("renderCodexHookFlagPayload", () => {
  test("emits a single hooks.<Event>=[...] payload with the right event name", () => {
    const out = renderCodexHookFlagPayload("PreToolUse", "/usr/local/bin/ib", "agent-abc123", 30);
    expect(out.startsWith("hooks.PreToolUse=[")).toBe(true);
  });

  test("interpolates the dispatcher command for each event", () => {
    const pre = renderCodexHookFlagPayload("PreToolUse", "/bin/ib", "agent-abc123", 30);
    expect(pre).toContain('command="/bin/ib hooks codex-pre-tool-use agent-abc123"');

    const ss = renderCodexHookFlagPayload("SessionStart", "/bin/ib", "agent-abc123", 30);
    expect(ss).toContain('command="/bin/ib hooks codex-session-start agent-abc123"');

    const stop = renderCodexHookFlagPayload("Stop", "/bin/ib", "agent-abc123", 30);
    expect(stop).toContain('command="/bin/ib hooks codex-stop agent-abc123"');
  });

  test("includes the matcher and timeout fields", () => {
    const out = renderCodexHookFlagPayload("PreToolUse", "/bin/ib", "agent-abc123", 42);
    expect(out).toContain('matcher=".*"');
    expect(out).toContain("timeout=42");
    expect(out).toContain('type="command"');
  });
});

describe("buildCodexLaunchArgs — well-formedness", () => {
  test("emits exactly one '-c' flag per registered event in stable order", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
    });
    // Every codex spawn ALWAYS prepends `--add-dir <coordinatorHome>` so the
    // agent can write to centralized state under ~/.itsybitsy/ (per-agent
    // outboxes, team channels, teams.json) under `-s workspace-write`.
    // Immediately after comes `--add-dir <home>/Library/Caches` so macOS
    // toolchains (SwiftPM, xcodebuild, etc.) can write their per-user caches.
    // Skip both leading pairs, then verify the -c flags alternate as before.
    expect(args[0]).toBe("--add-dir");
    expect(args[1]).toBe(FAKE_COORDINATOR_HOME);
    expect(args[2]).toBe("--add-dir");
    expect(args[3]).toBe(FAKE_LIBRARY_CACHES);
    const flags = args.slice(4);
    // flags alternates: -c, payload, -c, payload, ... The trailing pairs
    // beyond the hook events are the 6 always-on flags:
    //   features.multi_agent, sandbox_workspace_write.network_access,
    //   commit_attribution, log_dir, tui.show_tooltips, tui.status_line.
    expect(flags.length).toBe(CODEX_REGISTERED_EVENTS.length * 2 + 12);
    for (let i = 0; i < flags.length; i += 2) {
      expect(flags[i]).toBe("-c");
    }
    expect(flags[1]).toContain("hooks.PreToolUse=");
    expect(flags[3]).toContain("hooks.SessionStart=");
    expect(flags[5]).toContain("hooks.Stop=");
  });

  test("each hook payload contains <abs ib> and <agentId>", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
    });
    // Skip the leading `--add-dir <coordinatorHome>` AND `--add-dir
    // <Library/Caches>` pairs, then inspect the hook flag payloads. Only the
    // hook-flag payloads carry the dispatcher command — the trailing
    // multi_agent / commit_attribution flags are intentionally agent-agnostic.
    const flags = args.slice(4);
    for (let i = 1; i < CODEX_REGISTERED_EVENTS.length * 2; i += 2) {
      const payload = flags[i]!;
      expect(payload).toContain("/usr/local/bin/ib hooks codex-");
      expect(payload).toContain("agent-abc123");
    }
  });

  test("uses the default timeout when none is supplied", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
    });
    // First hook payload is at args[5] (after the two leading --add-dir pairs:
    // coordinator-home and Library/Caches).
    expect(args[5]).toContain(`timeout=${DEFAULT_CODEX_HOOK_TIMEOUT_SECS}`);
  });

  test("honors a caller-supplied timeout", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
      timeoutSecs: 12,
    });
    // Skip the two leading --add-dir pairs (coordinator-home + Library/Caches),
    // then check the hook payloads. Only the hook-flag payloads carry a timeout
    // — the trailing multi_agent / commit_attribution / log_dir / tui flags
    // have nothing to do with hooks.
    const flags = args.slice(4);
    for (let i = 1; i < CODEX_REGISTERED_EVENTS.length * 2; i += 2) {
      expect(flags[i]).toContain("timeout=12");
    }
  });

  test("prepends --add-dir pairs for extra writable roots", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
      extraWritableRoots: ["/repo/.git"],
    });
    // Stable order: always-on `--add-dir <coordinatorHome>` first (centralized
    // state), then `--add-dir <Library/Caches>` (macOS toolchain caches), then
    // any user-supplied extra roots, then the hook -c flags.
    expect(args[0]).toBe("--add-dir");
    expect(args[1]).toBe(FAKE_COORDINATOR_HOME);
    expect(args[2]).toBe("--add-dir");
    expect(args[3]).toBe(FAKE_LIBRARY_CACHES);
    expect(args[4]).toBe("--add-dir");
    expect(args[5]).toBe("/repo/.git");
    expect(args[6]).toBe("-c");
    expect(args[7]).toContain("hooks.PreToolUse=");
  });

  test("always prepends --add-dir <coordinatorHome> so codex can write to centralized state", () => {
    // The whole coordinator home is writable so codex agents can use `ib send`
    // (writes to per-agent outboxes under `agents/`), `ib send @<team>` (team
    // channels under `teams/`), and team membership commands (teams.json).
    // One root covers all three plus any future centralized state.
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
    });
    // Find the --add-dir pair pointing at the coordinator home — must be there
    // regardless of whether the caller supplied extraWritableRoots.
    let foundAt = -1;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--add-dir" && args[i + 1] === FAKE_COORDINATOR_HOME) {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThanOrEqual(0);
    // And it MUST appear even when no extraWritableRoots are supplied — the
    // central-state grant is unconditional.
    expect(foundAt).toBe(0);
  });

  test("always prepends --add-dir <home>/Library/Caches so macOS toolchains can write their caches", () => {
    // SwiftPM, xcodebuild's manifest loader, Homebrew helpers, and Xcode all
    // write to ~/Library/Caches BEFORE any -derivedDataPath redirection
    // applies — without this grant, even `xcodebuild build` aborts during
    // package resolution with EPERM on ~/Library/Caches/org.swift.swiftpm.
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
    });
    let foundAt = -1;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--add-dir" && args[i + 1] === FAKE_LIBRARY_CACHES) {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThanOrEqual(0);
    // Must appear immediately after the coordinator-home pair (positions 2-3),
    // regardless of extraWritableRoots — the macOS-cache grant is unconditional.
    expect(foundAt).toBe(2);
  });

  test("rejects when $HOME resolves to a path with shell-unsafe chars (Library/Caches grant)", () => {
    // Library/Caches is derived from $HOME; the same shell/TOML safety check
    // that gates coordinator-home and the ib binary path must gate this too.
    process.env.HOME = "/Users/o'malley";
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc",
        agentDir: "/var/agents/agent-abc",
      }),
    ).toThrow(/Unsafe Library\/Caches path/);
  });

  test("empty-string $HOME falls back to homedir() (not a relative path)", () => {
    // An empty-string $HOME (env -i, systemd unit overrides, some sandboxes)
    // must NOT produce `Library/Caches` as a relative path — that would
    // either be rejected by codex or, worse, be resolved against the
    // worktree cwd and silently widen the worktree allowlist. Using `||`
    // instead of `??` makes empty-string trigger the homedir() fallback.
    // (A whitespace-only $HOME like "   " is intentionally NOT covered:
    // `"   "` is truthy under `||`, so it would produce "   /Library/Caches".
    // No real shell sets $HOME like that; if it ever happens, the existing
    // isCodexSafeBinaryPath check still permits it (space is not a control
    // char) and codex would silently fail to register the directory.)
    const realHomedir = homedir();
    process.env.HOME = "";
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
    });
    // The Library/Caches --add-dir pair MUST be an absolute path. The
    // exact value depends on the host home (we can't pin it without
    // monkey-patching os.homedir), but it must start with `/` and end
    // with `/Library/Caches`.
    let found: string | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--add-dir" && args[i + 1]!.endsWith("/Library/Caches")) {
        found = args[i + 1];
        break;
      }
    }
    expect(found).toBeDefined();
    expect(found!.startsWith("/")).toBe(true);
    expect(found).toBe(`${realHomedir}/Library/Caches`);
    // Explicitly assert the regression: must NOT be the relative form.
    expect(found).not.toBe("Library/Caches");
  });

  test("skips the Library/Caches --add-dir on non-darwin platforms", () => {
    // ~/Library/Caches is a macOS-only convention. On Linux/Windows, pushing
    // it would be either noise (path never exists) or actively wrong (some
    // unrelated tool auto-creating it would silently grant write access).
    setPlatform("linux");
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
    });
    // Coordinator home is unconditional — verify it's still first.
    expect(args[0]).toBe("--add-dir");
    expect(args[1]).toBe(FAKE_COORDINATOR_HOME);
    // Library/Caches MUST NOT appear anywhere in the args on linux.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--add-dir") {
        expect(args[i + 1]!.endsWith("/Library/Caches")).toBe(false);
      }
    }
    // And the next non-add-dir argv element should be a -c flag, not a
    // second --add-dir for Library/Caches.
    expect(args[2]).toBe("-c");
  });

  test("rejects when getCoordinatorHome resolves to a path with shell-unsafe chars", () => {
    // The defensive path-safety check on getCoordinatorHome() guards a path
    // like /Users/o'malley/.itsybitsy/ that would corrupt the shell quoting
    // around the inline `-c` payload. setCoordinatorHome lets us simulate.
    setCoordinatorHome("/Users/o'malley/.itsybitsy");
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc",
        agentDir: "/var/agents/agent-abc",
      }),
    ).toThrow(/Unsafe coordinator home/);
  });

  test("rejects unsafe extra writable roots", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc",
        agentDir: "/var/agents/agent-abc",
        extraWritableRoots: ["/Users/o'malley/repo/.git"],
      }),
    ).toThrow(/Unsafe extra writable root/);
  });

  test("rejects invalid timeouts (zero, negative, non-integer)", () => {
    const base = {
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
    };
    expect(() => buildCodexLaunchArgs({ ...base, timeoutSecs: 0 })).toThrow();
    expect(() => buildCodexLaunchArgs({ ...base, timeoutSecs: -5 })).toThrow();
    expect(() => buildCodexLaunchArgs({ ...base, timeoutSecs: 3.5 })).toThrow();
  });

  test("payload body parses to a structure with the expected fields", () => {
    // We can't fully parse TOML inline, but the body shape is small enough
    // to verify the load-bearing fragments without a TOML parser. The Phase 2
    // spike captured this exact wire format and codex consumed it cleanly.
    const out = renderCodexHookFlagPayload("PreToolUse", "/bin/ib", "agent-abc", 30);
    expect(out).toMatch(/^hooks\.PreToolUse=\[\{matcher=".*?",hooks=\[\{type="command",command=".+?",timeout=\d+\}\]\}\]$/);
  });
});

describe("buildCodexLaunchArgs — disables codex's native multi-agent feature", () => {
  test("appends `-c features.multi_agent=false` to the args array", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
    });
    // The flag pair must appear as two adjacent entries: the `-c` token,
    // then the literal TOML `features.multi_agent=false` payload.
    let foundAt = -1;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-c" && args[i + 1] === "features.multi_agent=false") {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThanOrEqual(0);
  });

  test("appends `-c commit_attribution=\"\"` to disable the codex commit trailer", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
    });
    // The TOML empty-string literal is `""` (two adjacent double quotes).
    let foundAt = -1;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-c" && args[i + 1] === 'commit_attribution=""') {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThanOrEqual(0);
  });

  test("appends `-c sandbox_workspace_write.network_access=true` so codex agents can reach the network", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
    });
    let foundAt = -1;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-c" && args[i + 1] === "sandbox_workspace_write.network_access=true") {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThanOrEqual(0);
  });

  test("all six always-on flags appear regardless of timeout override", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
      timeoutSecs: 7,
    });
    expect(args).toContain("features.multi_agent=false");
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args).toContain('commit_attribution=""');
    expect(args).toContain('log_dir="/var/agents/agent-abc123/codex"');
    expect(args).toContain("tui.show_tooltips=false");
    expect(args).toContain('tui.status_line=["model-with-reasoning","context-remaining","five-hour-limit","weekly-limit"]');
  });
});

describe("buildCodexLaunchArgs — log_dir and tui.show_tooltips flags", () => {
  test("appends `-c log_dir=\"<agentDir>/codex\"` so codex logs land in the agent dir", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/Users/me/work/.ittybitty/agents/agent-abc123",
    });
    let foundAt = -1;
    for (let i = 0; i < args.length - 1; i++) {
      if (
        args[i] === "-c" &&
        args[i + 1] === 'log_dir="/Users/me/work/.ittybitty/agents/agent-abc123/codex"'
      ) {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThanOrEqual(0);
  });

  test("the log_dir value ends with `/codex` (the substring the manager asked for)", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
    });
    const logDirFlag = args.find((a) => a.startsWith("log_dir="));
    expect(logDirFlag).toBeDefined();
    expect(logDirFlag).toContain("codex");
    expect(logDirFlag!.endsWith('/codex"')).toBe(true);
  });

  test("appends `-c tui.show_tooltips=false` so the welcome onboarding tips stay off", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
    });
    let foundAt = -1;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-c" && args[i + 1] === "tui.show_tooltips=false") {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThanOrEqual(0);
  });

  test("appends `-c tui.status_line=[...]` with Codex context and limit usage items", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
    });
    let foundAt = -1;
    for (let i = 0; i < args.length - 1; i++) {
      if (
        args[i] === "-c" &&
        args[i + 1] === 'tui.status_line=["model-with-reasoning","context-remaining","five-hour-limit","weekly-limit"]'
      ) {
        foundAt = i;
        break;
      }
    }
    expect(foundAt).toBeGreaterThanOrEqual(0);
  });

  test("rejects agentDir containing an apostrophe (would close the shell quoting)", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc",
        agentDir: "/Users/o'malley/agents/agent-abc",
      }),
    ).toThrow(/Unsafe agent directory path/);
  });

  test("rejects agentDir containing a double quote (would corrupt the TOML string)", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc",
        agentDir: '/Users/who"ah/agents/agent-abc',
      }),
    ).toThrow(/Unsafe agent directory path/);
  });

  test("rejects agentDir containing a backslash", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc",
        agentDir: "/Users/back\\slash/agents/agent-abc",
      }),
    ).toThrow(/Unsafe agent directory path/);
  });

  test("rejects agentDir containing a control character (newline)", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc",
        agentDir: "/Users/new\nline/agents/agent-abc",
      }),
    ).toThrow(/Unsafe agent directory path/);
  });

  test("rejects an empty agentDir", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc",
        agentDir: "",
      }),
    ).toThrow(/Unsafe agent directory path/);
  });
});

describe("buildCodexLaunchArgs — path-safety rejection (gate (b))", () => {
  const okAgentDir = "/var/agents/agent-abc";

  test("rejects ibBinaryPath containing an apostrophe", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/Users/o'malley/bin/ib",
        agentId: "agent-abc",
        agentDir: okAgentDir,
      }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("rejects ibBinaryPath containing a double quote", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: '/Users/who"ah/ib',
        agentId: "agent-abc",
        agentDir: okAgentDir,
      }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("rejects ibBinaryPath containing a backslash", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/Users/back\\slash/ib",
        agentId: "agent-abc",
        agentDir: okAgentDir,
      }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("rejects ibBinaryPath containing a newline", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/Users/new\nline/ib",
        agentId: "agent-abc",
        agentDir: okAgentDir,
      }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("rejects ibBinaryPath containing a tab", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/Users/with\ttab/ib",
        agentId: "agent-abc",
        agentDir: okAgentDir,
      }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("rejects an empty ibBinaryPath", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "",
        agentId: "agent-abc",
        agentDir: okAgentDir,
      }),
    ).toThrow(/Unsafe ib binary path/);
  });

  test("rejects an invalid agent id (special chars)", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "bad id with spaces",
        agentDir: okAgentDir,
      }),
    ).toThrow(/Invalid agent id/);
  });

  test("rejects an agent id containing a shell metacharacter", () => {
    expect(() =>
      buildCodexLaunchArgs({
        ibBinaryPath: "/bin/ib",
        agentId: "agent-abc;rm-rf",
        agentDir: okAgentDir,
      }),
    ).toThrow(/Invalid agent id/);
  });
});
