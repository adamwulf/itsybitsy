// Check C: startup CPU of a no-op path. Spawns the command N times (after 3
// warm-up runs) and reads the child's rusage (user + system CPU, max RSS) from
// Bun's Subprocess.resourceUsage(), which comes from wait4(2).
// Usage: bun spikes/iroh/measure.ts <runs> <command> [args...]
const [runsArg, ...cmd] = process.argv.slice(2);
const runs = Number(runsArg);
if (!Number.isInteger(runs) || runs < 1 || cmd.length === 0) {
  console.error("usage: measure.ts <runs> <command> [args...]");
  process.exit(2);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

type Sample = { cpuMs: number; userMs: number; sysMs: number; wallMs: number; rssMB: number };

async function once(): Promise<Sample> {
  const t0 = performance.now();
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "inherit" });
  const code = await proc.exited;
  const wallMs = performance.now() - t0;
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
  const ru = proc.resourceUsage();
  if (!ru) throw new Error("no resourceUsage");
  const userMs = Number(ru.cpuTime.user) / 1000;
  const sysMs = Number(ru.cpuTime.system) / 1000;
  // maxRSS is bytes on macOS.
  return { cpuMs: userMs + sysMs, userMs, sysMs, wallMs, rssMB: Number(ru.maxRSS) / 1024 / 1024 };
}

for (let i = 0; i < 3; i++) await once();
const samples: Sample[] = [];
for (let i = 0; i < runs; i++) samples.push(await once());
const col = (k: keyof Sample) => samples.map((s) => s[k]);
const fmt = (xs: number[]) =>
  `median ${median(xs).toFixed(1)}  min ${Math.min(...xs).toFixed(1)}  max ${Math.max(...xs).toFixed(1)}`;
console.log(`${cmd.join(" ")}  (${runs} runs after 3 warm-ups)`);
console.log(`  cpu (user+sys) ms: ${fmt(col("cpuMs"))}`);
console.log(`  user ms:           ${fmt(col("userMs"))}`);
console.log(`  sys ms:            ${fmt(col("sysMs"))}`);
console.log(`  wall ms:           ${fmt(col("wallMs"))}`);
console.log(`  max RSS MB:        ${fmt(col("rssMB"))}`);
