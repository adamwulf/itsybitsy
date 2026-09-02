import { test, expect, describe } from "bun:test";
import {
  translateAgyTool,
  buildAgyAllowOutput,
  buildAgyDenyOutput,
  buildAgyStopContinue,
  AGY_EMPTY_OUTPUT,
  AGY_SUBAGENT_DENY_REASON,
  type AgyTranslation,
} from "./agy-tools";

function expectCheck(t: AgyTranslation): Extract<AgyTranslation, { action: "check" }> {
  expect(t.action).toBe("check");
  return t as Extract<AgyTranslation, { action: "check" }>;
}

describe("translateAgyTool — the SPEC §4.3 translation table", () => {
  test("run_command → Bash with command=CommandLine, cwd=Cwd", () => {
    const t = expectCheck(
      translateAgyTool("run_command", { CommandLine: "git status", Cwd: "/wt" }, []),
    );
    expect(t.toolName).toBe("Bash");
    expect(t.toolInput).toEqual({ command: "git status" });
    expect(t.cwd).toBe("/wt");
  });

  test("run_command without Cwd leaves cwd undefined", () => {
    const t = expectCheck(translateAgyTool("run_command", { CommandLine: "ls" }, []));
    expect(t.cwd).toBeUndefined();
  });

  test("run_command missing CommandLine is denied (no fail-open)", () => {
    const t = translateAgyTool("run_command", { Cwd: "/wt" }, []);
    expect(t.action).toBe("deny");
    if (t.action === "deny") expect(t.reason).toContain("CommandLine");
  });

  test("view_file → Read with file_path=AbsolutePath", () => {
    const t = expectCheck(translateAgyTool("view_file", { AbsolutePath: "/wt/a.ts" }, []));
    expect(t.toolName).toBe("Read");
    expect(t.toolInput).toEqual({ file_path: "/wt/a.ts" });
  });

  test("list_dir → LS with file_path=DirectoryPath", () => {
    const t = expectCheck(translateAgyTool("list_dir", { DirectoryPath: "/wt/src" }, []));
    expect(t.toolName).toBe("LS");
    expect(t.toolInput).toEqual({ file_path: "/wt/src" });
  });

  test("write_to_file → Write with file_path=TargetFile", () => {
    const t = expectCheck(translateAgyTool("write_to_file", { TargetFile: "/wt/new.ts", CodeContent: "x" }, []));
    expect(t.toolName).toBe("Write");
    expect(t.toolInput).toEqual({ file_path: "/wt/new.ts" });
  });

  test("replace_file_content → Edit with file_path=TargetFile", () => {
    const t = expectCheck(translateAgyTool("replace_file_content", { TargetFile: "/wt/x.ts" }, []));
    expect(t.toolName).toBe("Edit");
    expect(t.toolInput).toEqual({ file_path: "/wt/x.ts" });
  });

  test("multi_replace_file_content → MultiEdit with file_path=TargetFile", () => {
    const t = expectCheck(translateAgyTool("multi_replace_file_content", { TargetFile: "/wt/x.ts" }, []));
    expect(t.toolName).toBe("MultiEdit");
    expect(t.toolInput).toEqual({ file_path: "/wt/x.ts" });
  });

  test("find_by_name → Glob, prefers SearchDirectory over DirectoryPath", () => {
    const t = expectCheck(
      translateAgyTool("find_by_name", { SearchDirectory: "/wt/src", DirectoryPath: "/wt" }, []),
    );
    expect(t.toolName).toBe("Glob");
    expect(t.toolInput).toEqual({ file_path: "/wt/src" });
  });

  test("find_by_name falls back to DirectoryPath when SearchDirectory absent", () => {
    const t = expectCheck(translateAgyTool("find_by_name", { DirectoryPath: "/wt" }, []));
    expect(t.toolInput).toEqual({ file_path: "/wt" });
  });

  test("find_by_name with no path → Glob check with no file_path (optional path)", () => {
    const t = expectCheck(translateAgyTool("find_by_name", {}, []));
    expect(t.toolName).toBe("Glob");
    expect(t.toolInput).toEqual({});
  });

  test("grep_search → Grep with SearchPath when present", () => {
    const t = expectCheck(translateAgyTool("grep_search", { SearchPath: "/wt/src" }, []));
    expect(t.toolName).toBe("Grep");
    expect(t.toolInput).toEqual({ file_path: "/wt/src" });
  });

  test("grep_search with no SearchPath → Grep check with no file_path", () => {
    const t = expectCheck(translateAgyTool("grep_search", { Query: "foo" }, []));
    expect(t.toolName).toBe("Grep");
    expect(t.toolInput).toEqual({});
  });

  test("read_url_content → WebFetch (no path)", () => {
    const t = expectCheck(translateAgyTool("read_url_content", { Url: "https://x" }, []));
    expect(t.toolName).toBe("WebFetch");
    expect(t.toolInput).toEqual({});
  });

  test("search_web → WebSearch (no path)", () => {
    const t = expectCheck(translateAgyTool("search_web", { Query: "foo" }, []));
    expect(t.toolName).toBe("WebSearch");
  });

  test("manage_task → TodoWrite (no path)", () => {
    const t = expectCheck(translateAgyTool("manage_task", {}, []));
    expect(t.toolName).toBe("TodoWrite");
  });
});

describe("translateAgyTool — missing path args deny (fail-closed)", () => {
  for (const [name, key] of [
    ["view_file", "AbsolutePath"],
    ["list_dir", "DirectoryPath"],
    ["write_to_file", "TargetFile"],
    ["replace_file_content", "TargetFile"],
    ["multi_replace_file_content", "TargetFile"],
  ] as const) {
    test(`${name} without ${key} is denied with "path argument missing"`, () => {
      const t = translateAgyTool(name, {}, []);
      expect(t.action).toBe("deny");
      if (t.action === "deny") expect(t.reason).toContain("path argument missing");
    });
  }
});

describe("translateAgyTool — sub-agent tools always deny (D8)", () => {
  for (const name of ["invoke_subagent", "define_subagent", "manage_subagents"]) {
    test(`${name} is denied even if listed in the allow list`, () => {
      const t = translateAgyTool(name, {}, [name]);
      expect(t.action).toBe("deny");
      if (t.action === "deny") expect(t.reason).toBe(AGY_SUBAGENT_DENY_REASON);
    });
  }
});

describe("translateAgyTool — unknown tools", () => {
  test("unknown tool NOT in the allow list is denied", () => {
    const t = translateAgyTool("some_new_tool", { x: 1 }, ["Read", "Write"]);
    expect(t.action).toBe("deny");
    if (t.action === "deny") expect(t.reason).toContain("not in allow list");
  });

  test("unknown tool present verbatim in the allow list is routed through under its raw name", () => {
    const t = expectCheck(translateAgyTool("some_new_tool", { x: 1 }, ["some_new_tool"]));
    expect(t.toolName).toBe("some_new_tool");
    expect(t.toolInput).toEqual({});
  });

  test("non-object args are treated as empty (no crash)", () => {
    const t = translateAgyTool("view_file", "not-an-object", []);
    expect(t.action).toBe("deny"); // no AbsolutePath → path argument missing
  });
});

describe("agy output builders (SPEC §4.4 contract)", () => {
  test("allow output is {decision:allow, reason}", () => {
    expect(JSON.parse(buildAgyAllowOutput("ok"))).toEqual({ decision: "allow", reason: "ok" });
  });
  test("deny output is {decision:deny, reason}", () => {
    expect(JSON.parse(buildAgyDenyOutput("nope"))).toEqual({ decision: "deny", reason: "nope" });
  });
  test("stop continue output is {decision:continue, reason}", () => {
    expect(JSON.parse(buildAgyStopContinue("commit first"))).toEqual({
      decision: "continue",
      reason: "commit first",
    });
  });
  test("the empty output is a bare {}", () => {
    expect(JSON.parse(AGY_EMPTY_OUTPUT)).toEqual({});
  });
});
