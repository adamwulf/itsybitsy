import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdtemp, rm, readdir, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import {
  inboxWrite,
  inboxList,
  inboxRead,
  inboxAck,
  inboxCount,
  detectAgentIdFromCwd,
  setInboxDir,
} from "./inbox";

let tempDir: string;
let inboxDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "inbox-test-"));
  inboxDir = join(tempDir, "coordinator-inbox");
  setInboxDir(inboxDir);
});

afterEach(async () => {
  setInboxDir(undefined);
  await rm(tempDir, { recursive: true, force: true });
});

describe("detectAgentIdFromCwd", () => {
  test("detects agent ID from worktree path", () => {
    expect(
      detectAgentIdFromCwd("/repo/.ittybitty/agents/agent-abc123/repo"),
    ).toBe("agent-abc123");
  });

  test("detects agent ID from subdirectory of worktree", () => {
    expect(
      detectAgentIdFromCwd("/repo/.ittybitty/agents/agent-abc123/repo/src"),
    ).toBe("agent-abc123");
  });

  test("returns undefined for non-agent path", () => {
    expect(detectAgentIdFromCwd("/home/user/project")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(detectAgentIdFromCwd("")).toBeUndefined();
  });
});

describe("inboxWrite", () => {
  test("creates inbox directory and message file", async () => {
    const result = await inboxWrite("hello world", { source: "manual" });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+-[0-9a-f]{4}-manual\.msg$/);

    const content = await Bun.file(join(inboxDir, result.stdout)).text();
    expect(content).toBe("hello world");
  });

  test("uses explicit source over auto-detection", async () => {
    const result = await inboxWrite("test", {
      source: "watchdog",
      cwd: "/repo/.ittybitty/agents/agent-abc123/repo",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("-watchdog.msg");
  });

  test("auto-detects agent ID from CWD", async () => {
    const result = await inboxWrite("test", {
      cwd: "/repo/.ittybitty/agents/agent-xyz789/repo",
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("-agent-xyz789.msg");
  });

  test("defaults to manual source", async () => {
    const result = await inboxWrite("test", { cwd: "/home/user" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("-manual.msg");
  });

  test("rejects invalid source with path traversal", async () => {
    const result = await inboxWrite("test", { source: "../evil" });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid source");
  });

  test("rejects source with slash", async () => {
    const result = await inboxWrite("test", { source: "foo/bar" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid source");
  });

  test("rejects empty source", async () => {
    const result = await inboxWrite("test", { source: "" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid source");
  });

  test("rejects source with spaces", async () => {
    const result = await inboxWrite("test", { source: "bad source" });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid source");
  });

  test("accepts valid hyphenated source", async () => {
    const result = await inboxWrite("test", { source: "agent-abc123" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("-agent-abc123.msg");
  });

  test("accepts valid underscored source", async () => {
    const result = await inboxWrite("test", { source: "my_source" });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("-my_source.msg");
  });

  test("prints filename to stdout", async () => {
    const result = await inboxWrite("test message", { source: "manual" });
    expect(result.stdout).toMatch(/^\d+-[0-9a-f]{4}-manual\.msg$/);
  });

  test("enforces retention limit of 100 messages", async () => {
    await mkdir(inboxDir, { recursive: true });
    for (let i = 0; i < 100; i++) {
      const ts = 1000000 + i;
      await writeFile(join(inboxDir, `${ts}-0000-test.msg`), `msg ${i}`);
    }

    // Write one more — should trigger cleanup of oldest
    const result = await inboxWrite("overflow message", { source: "test" });
    expect(result.ok).toBe(true);

    const files = await readdir(inboxDir);
    const msgFiles = files.filter((f: string) => f.endsWith(".msg"));
    expect(msgFiles.length).toBe(100);

    // The oldest message should be deleted
    expect(await Bun.file(join(inboxDir, "1000000-0000-test.msg")).exists()).toBe(false);

    // The new message should exist
    expect(await Bun.file(join(inboxDir, result.stdout)).exists()).toBe(true);
  });
});

describe("inboxList", () => {
  test("returns messages newest first", async () => {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "1000001-aaaa-src1.msg"), "first message");
    await writeFile(join(inboxDir, "1000003-bbbb-src2.msg"), "third message");
    await writeFile(join(inboxDir, "1000002-cccc-src1.msg"), "second message");

    const result = await inboxList();
    expect(result.ok).toBe(true);
    const lines = result.stdout.split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("1000003-bbbb-src2.msg");
    expect(lines[1]).toContain("1000002-cccc-src1.msg");
    expect(lines[2]).toContain("1000001-aaaa-src1.msg");
  });

  test("output is tab-separated with source and preview", async () => {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "1000001-aaaa-watchdog.msg"), "Hello coordinator");

    const result = await inboxList();
    const parts = result.stdout.split("\t");
    expect(parts[0]).toBe("1000001-aaaa-watchdog.msg");
    expect(parts[1]).toBe("watchdog");
    expect(parts[2]).toBe("Hello coordinator");
  });

  test("truncates preview to 80 chars", async () => {
    await mkdir(inboxDir, { recursive: true });
    const longMsg = "A".repeat(120);
    await writeFile(join(inboxDir, "1000001-aaaa-test.msg"), longMsg);

    const result = await inboxList();
    const parts = result.stdout.split("\t");
    expect(parts[2]!.length).toBe(80);
  });

  test("replaces newlines in preview", async () => {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "1000001-aaaa-test.msg"), "line1\nline2\nline3");

    const result = await inboxList();
    const parts = result.stdout.split("\t");
    expect(parts[2]).toBe("line1 line2 line3");
  });

  test("returns empty output for empty inbox", async () => {
    const result = await inboxList();
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("returns empty output for nonexistent inbox dir", async () => {
    setInboxDir(join(tempDir, "nonexistent"));
    const result = await inboxList();
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("");
  });

  test("ignores non-.msg files", async () => {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "not-a-message.txt"), "ignored");
    await writeFile(join(inboxDir, "1000001-aaaa-test.msg"), "real message");

    const result = await inboxList();
    const lines = result.stdout.split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("1000001-aaaa-test.msg");
  });
});

describe("inboxRead", () => {
  test("returns full message content", async () => {
    await mkdir(inboxDir, { recursive: true });
    const msg = "This is the full message\nwith multiple lines\nand content.";
    await writeFile(join(inboxDir, "1000001-aaaa-test.msg"), msg);

    const result = await inboxRead("1000001-aaaa-test.msg");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe(msg);
  });

  test("rejects invalid filename with path traversal", async () => {
    const result = await inboxRead("../../../etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid filename");
  });

  test("rejects filename with dots in path component", async () => {
    const result = await inboxRead("1000001-aaaa-../../etc/passwd.msg");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid filename");
  });

  test("rejects filename without .msg extension", async () => {
    const result = await inboxRead("1000001-aaaa-test.txt");
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("Invalid filename");
  });

  test("returns error for missing file", async () => {
    await mkdir(inboxDir, { recursive: true });
    const result = await inboxRead("1000001-aaaa-test.msg");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Message not found");
  });
});

describe("inboxAck", () => {
  test("deletes message file", async () => {
    await mkdir(inboxDir, { recursive: true });
    const filepath = join(inboxDir, "1000001-aaaa-test.msg");
    await writeFile(filepath, "message to ack");

    const result = await inboxAck("1000001-aaaa-test.msg");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Acknowledged: 1000001-aaaa-test.msg");
    expect(await Bun.file(filepath).exists()).toBe(false);
  });

  test("is idempotent for missing file", async () => {
    await mkdir(inboxDir, { recursive: true });
    const result = await inboxAck("1000001-aaaa-test.msg");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Acknowledged: 1000001-aaaa-test.msg");
  });

  test("rejects invalid filename", async () => {
    const result = await inboxAck("../secret.msg");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid filename");
  });
});

describe("inboxCount", () => {
  test("returns 0 for empty inbox", async () => {
    const result = await inboxCount();
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("0");
  });

  test("returns correct count", async () => {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "1000001-aaaa-test.msg"), "msg1");
    await writeFile(join(inboxDir, "1000002-bbbb-test.msg"), "msg2");
    await writeFile(join(inboxDir, "1000003-cccc-test.msg"), "msg3");

    const result = await inboxCount();
    expect(result.stdout).toBe("3");
  });

  test("ignores non-.msg files", async () => {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "1000001-aaaa-test.msg"), "msg1");
    await writeFile(join(inboxDir, "readme.txt"), "not a message");

    const result = await inboxCount();
    expect(result.stdout).toBe("1");
  });

  test("always exits 0", async () => {
    const result = await inboxCount();
    expect(result.exitCode).toBe(0);
  });
});

describe("full lifecycle", () => {
  test("write, list, read, ack, count", async () => {
    // Write
    const writeResult = await inboxWrite("lifecycle test message", { source: "test" });
    expect(writeResult.ok).toBe(true);
    const filename = writeResult.stdout;

    // Count should be 1
    let countResult = await inboxCount();
    expect(countResult.stdout).toBe("1");

    // List should show it
    const listResult = await inboxList();
    expect(listResult.stdout).toContain(filename);
    expect(listResult.stdout).toContain("lifecycle test message");

    // Read should return full content
    const readResult = await inboxRead(filename);
    expect(readResult.stdout).toBe("lifecycle test message");

    // Ack should delete it
    const ackResult = await inboxAck(filename);
    expect(ackResult.ok).toBe(true);

    // Count should be 0
    countResult = await inboxCount();
    expect(countResult.stdout).toBe("0");

    // Read should fail
    const readAgain = await inboxRead(filename);
    expect(readAgain.ok).toBe(false);
  });
});
