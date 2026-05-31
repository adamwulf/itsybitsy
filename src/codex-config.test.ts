import { test, expect, describe } from "bun:test";
import {
  buildCodexLaunchArgs,
  isCodexSafeBinaryPath,
  renderCodexHookFlagPayload,
  CODEX_REGISTERED_EVENTS,
  DEFAULT_CODEX_HOOK_TIMEOUT_SECS,
} from "./codex-config";

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
    // args alternates: -c, payload, -c, payload, ... The trailing pairs
    // beyond the hook events are the 5 always-on flags:
    //   features.multi_agent, commit_attribution, log_dir, tui.show_tooltips,
    //   tui.status_line.
    expect(args.length).toBe(CODEX_REGISTERED_EVENTS.length * 2 + 10);
    for (let i = 0; i < args.length; i += 2) {
      expect(args[i]).toBe("-c");
    }
    expect(args[1]).toContain("hooks.PreToolUse=");
    expect(args[3]).toContain("hooks.SessionStart=");
    expect(args[5]).toContain("hooks.Stop=");
  });

  test("each hook payload contains <abs ib> and <agentId>", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
    });
    // Only the hook-flag payloads carry the dispatcher command — the trailing
    // multi_agent / commit_attribution flags are intentionally agent-agnostic.
    for (let i = 1; i < CODEX_REGISTERED_EVENTS.length * 2; i += 2) {
      const payload = args[i]!;
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
    expect(args[1]).toContain(`timeout=${DEFAULT_CODEX_HOOK_TIMEOUT_SECS}`);
  });

  test("honors a caller-supplied timeout", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
      timeoutSecs: 12,
    });
    // Only the hook-flag payloads carry a timeout — the trailing
    // multi_agent / commit_attribution / log_dir / tui flags have nothing
    // to do with hooks.
    for (let i = 1; i < CODEX_REGISTERED_EVENTS.length * 2; i += 2) {
      expect(args[i]).toContain("timeout=12");
    }
  });

  test("prepends --add-dir pairs for extra writable roots", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/bin/ib",
      agentId: "agent-abc",
      agentDir: "/var/agents/agent-abc",
      extraWritableRoots: ["/repo/.git"],
    });
    expect(args[0]).toBe("--add-dir");
    expect(args[1]).toBe("/repo/.git");
    expect(args[2]).toBe("-c");
    expect(args[3]).toContain("hooks.PreToolUse=");
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

  test("all five flags appear regardless of timeout override", () => {
    const { args } = buildCodexLaunchArgs({
      ibBinaryPath: "/usr/local/bin/ib",
      agentId: "agent-abc123",
      agentDir: "/var/agents/agent-abc123",
      timeoutSecs: 7,
    });
    expect(args).toContain("features.multi_agent=false");
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
