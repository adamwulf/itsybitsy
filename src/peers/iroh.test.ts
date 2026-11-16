import { afterEach, describe, expect, test } from "bun:test";
import { relative, resolve } from "node:path";
import { IrohError, irohAddonLoaderCtx, loadIroh, shortIrohMessage } from "./iroh";

const HEX64 = /^[0-9a-f]{64}$/;

afterEach(() => {
  irohAddonLoaderCtx.reset();
});

describe("loadIroh wrapper (real addon)", () => {
  test("a generated key's bytes are a 32-byte Uint8Array that round-trips to the same id", async () => {
    const iroh = await loadIroh();
    const key = iroh.SecretKey.generate();
    const bytes = key.toBytes();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(32);
    const id = key.public().toString();
    expect(id).toMatch(HEX64);
    expect(iroh.SecretKey.fromBytes(bytes).public().toString()).toBe(id);
  });

  test("fmtShort is the first 10 hex characters of the id", async () => {
    const iroh = await loadIroh();
    const id = iroh.SecretKey.generate().public();
    expect(id.fmtShort()).toBe(id.toString().slice(0, 10));
  });

  test("EndpointId.fromString parses a full id back to itself", async () => {
    const iroh = await loadIroh();
    const id = iroh.SecretKey.generate().public().toString();
    expect(iroh.EndpointId.fromString(id).toString()).toBe(id);
  });

  test("addon errors come back as short IrohErrors naming the call", async () => {
    const iroh = await loadIroh();
    const id = iroh.SecretKey.generate().public().toString();
    let caught: unknown;
    try {
      iroh.EndpointId.fromString(id.toUpperCase());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IrohError);
    expect((caught as IrohError).op).toBe("EndpointId.fromString");
    expect((caught as IrohError).message).toBe("EndpointId.fromString: failed to decode hex string");

    expect(() => iroh.SecretKey.fromBytes(new Uint8Array(31))).toThrow(
      new IrohError("SecretKey.fromBytes", "SecretKey requires exactly 32 bytes"),
    );
  });
});

describe("shortIrohMessage", () => {
  test("keeps only the first non-empty line, whitespace collapsed", () => {
    const err = new Error("\n  No addressing information available\nCaused by:\n    All address lookup services failed");
    expect(shortIrohMessage(err)).toBe("No addressing information available");
    expect(shortIrohMessage(new Error("a   b\tc"))).toBe("a b c");
  });

  test("cuts a long message to 160 characters", () => {
    const short = shortIrohMessage(new Error("x".repeat(500)));
    expect(short.length).toBe(160);
    expect(short.endsWith("…")).toBe(true);
  });

  test("handles non-Error throws and empty messages", () => {
    expect(shortIrohMessage("plain string")).toBe("plain string");
    expect(shortIrohMessage(new Error(""))).toBe("unknown error");
  });
});

describe("loader seam", () => {
  test("a failed load is rethrown as an IrohError with op load", async () => {
    irohAddonLoaderCtx.set(async () => {
      throw new Error("dlopen failed\nmore detail");
    });
    await expect(loadIroh()).rejects.toThrow(new IrohError("load", "dlopen failed"));
  });
});

test("only src/peers/iroh.ts references @number0/iroh, and only through a dynamic import", async () => {
  const srcDir = resolve(import.meta.dir, "..");
  const self = relative(srcDir, import.meta.path);
  const pkg = ["@number0", "iroh"].join("/");
  // Any import form: `from "pkg"`, `import "pkg"`, `import("pkg")`, `require("pkg")`,
  // including subpaths such as the platform package.
  const anyImport = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["']${pkg}`);
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: srcDir })) {
    if (file === self || file === "peers/iroh.ts") continue;
    if (anyImport.test(await Bun.file(resolve(srcDir, file)).text())) offenders.push(file);
  }
  expect(offenders).toEqual([]);

  const wrapper = await Bun.file(resolve(srcDir, "peers/iroh.ts")).text();
  const mentions = wrapper.split("\n").filter((line) => line.includes(pkg));
  // Code mentions: the type-only `typeof import(...)` and the loader's `import(...)`.
  const code = mentions.filter((line) => !/^\s*(\*|\/\/)/.test(line));
  expect(code.length).toBe(2);
  for (const line of code) {
    expect(line).toContain(`import("${pkg}")`);
    expect(line).not.toMatch(/\bfrom\s+["']/);
    expect(line).not.toContain("require(");
  }
});
