import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("runtime names are centralized and no legacy spelling leaks into shipped files", async () => {
  const root = resolve(import.meta.dir, "..");
  const proc = Bun.spawn(["git", "ls-files", "*.ts", "docs/agent-types/*.md", ".gitignore"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const files = (await new Response(proc.stdout).text()).trim().split("\n");
  expect(await proc.exited).toBe(0);
  const violations: string[] = [];
  for (const file of files.filter(f => !f.endsWith(".test.ts"))) {
    const lines = (await Bun.file(resolve(root, file)).text()).split("\n");
    lines.forEach((line, index) => {
      if (/ittybitty/i.test(line) && !(file === "src/runtime-names.ts" && line === 'export const LEGACY_RETIRED_REF_ROOT = "refs/ittybitty/retired";')) {
        violations.push(`${file}:${index + 1}: legacy name`);
      }
      if (!file.endsWith(".ts") || file === "src/runtime-names.ts" || /^(\/\/|\/\*|\*)/.test(line.trim())) return;
      if (!line.includes(".itsybitsy") || line.includes("~/.itsybitsy")) return;
      if (/join\([^,\n]*(?:home|Home)[^,\n]*,\s*["']\.itsybitsy["']/.test(line)) return;
      violations.push(`${file}:${index + 1}: runtime path bypasses runtime-names`);
    });
  }
  expect(violations).toEqual([]);
});
