import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync, lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { SandboxAttribution, SandboxLogFramer, SandboxOutputBudget, formatSandboxRecord,
  parseSandboxReport, processIdentity, type ProcessObservation, type SandboxReport } from "./sandbox-denials";

export interface SandboxLogOptions { dir: string; owner: number; agentLog: string }

// Bun keeps exitCode null after signal termination; checking only that field
// silently leaves a collector running without its log subscription.
export function sandboxStreamExited(stream: Pick<Bun.Subprocess, "exitCode" | "signalCode">): boolean {
  return stream.exitCode !== null || stream.signalCode !== null;
}

/** The launch script is the supervisor. No watchdog or dashboard participates. */
export async function watchSandboxLog(opts: SandboxLogOptions): Promise<number> {
  const launch = basename(opts.dir);
  const status = (level: string, message: string) => appendFileSync(opts.agentLog,
    `[${new Date().toISOString()}] [SandboxCollector] ${level}: launch=${launch} ${message.replace(/[\r\n\x00-\x1f\x7f]/g, " ")}\n`);
  let reader: ReturnType<typeof import("./sandbox-processes").openSandboxProcessReader> | undefined;
  let stream: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let pumping: Promise<void> | undefined;
  let errors: Promise<void> | undefined;
  let stderr = "";
  let failed: unknown;
  let ownsDirectory = false;
  let stopping = false;
  const stop = () => { stopping = true; };
  const hup = () => {};
  process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", hup);
  try {
    if (dirname(opts.dir) !== dirname(opts.agentLog) || !/^sandbox-log\.[a-zA-Z0-9]+$/.test(launch) ||
        !lstatSync(opts.dir).isDirectory()) throw new Error("invalid launch artifact directory");
    writeFileSync(join(opts.dir, "collector-lock"), String(process.pid), { flag: "wx", mode: 0o600 });
    ownsDirectory = true;
    reader = (await import("./sandbox-processes")).openSandboxProcessReader();
    const owner = reader.read(opts.owner);
    if (!owner) throw new Error("launch owner identity unavailable");
    // Prove the supplied owner is an ancestor of this collector at startup.
    let ancestor = reader.read(process.pid);
    for (let depth = 0; ancestor && depth < 64 && ancestor.pid !== owner.pid; depth++) ancestor = reader.read(ancestor.ppid);
    if (!ancestor || processIdentity(ancestor) !== processIdentity(owner)) throw new Error("launch owner is not the collector ancestor");
    writeFileSync(join(opts.dir, "identity.json"), JSON.stringify({ launch, owner: processIdentity(owner), collector: process.pid, boot: reader.boot }));
    const marker = `IBSandboxReady-${launch}`;
    let warm = false;
    const predicate = `(subsystem == "com.apple.sandbox.reporting" AND category == "violation") OR (eventMessage CONTAINS "Sandbox:") OR (eventMessage CONTAINS "${marker}")`;
    stream = Bun.spawn(["/usr/bin/log", "stream", "--style", "ndjson", "--level", "debug", "--predicate", predicate],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const framer = new SandboxLogFramer();
    const pending: { report: SandboxReport; received: number }[] = [];
    let overflow = 0;
    pumping = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream!.stdout) {
        for (const line of framer.push(decoder.decode(chunk, { stream: true }))) {
          if (!warm) {
            try {
              const event = JSON.parse(line);
              if (typeof event.eventMessage === "string" && event.eventMessage.includes(marker) &&
                  event.processImagePath === "/usr/bin/logger") warm = true;
            } catch { /* log stream's non-JSON banner is not an event */ }
          }
          const report = parseSandboxReport(line, reader!.boot, { liveStream: true });
          if (report) {
            if (pending.length < 512) pending.push({ report, received: performance.now() });
            else overflow++;
          }
        }
      }
    })().catch(error => { failed = error; });
    errors = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of stream!.stderr) {
        if (stderr.length < 4096) stderr += decoder.decode(chunk).slice(0, 4096 - stderr.length);
      }
    })().catch(error => { failed = error; });
    const startup = performance.now();
    while (!warm && performance.now() - startup < 3000 && !stopping) {
      if (sandboxStreamExited(stream) || failed) throw new Error(`log stream startup failed (exit=${stream.exitCode}, signal=${stream.signalCode}): ${stderr || String(failed ?? "no output")}`);
      const markerProcess = Bun.spawn(["/usr/bin/logger", "-t", "itsybitsy-sandbox", marker],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const timeout = setTimeout(() => markerProcess.kill(), 500);
      await markerProcess.exited;
      clearTimeout(timeout);
      await Bun.sleep(50);
    }
    if (!warm) throw new Error("log stream readiness marker was not observed within 3 seconds");
    writeFileSync(join(opts.dir, "ready"), launch);
    status("INFO", "stream ready; coverage limited to verified observed process lifetimes; unknown and OS-coalesced reports omitted");
    let attribution: SandboxAttribution | undefined;
    let active: ProcessObservation[] = [];
    const budget = new SandboxOutputBudget();
    let lastSummary = performance.now();
    let stopAt: number | undefined;
    while (true) {
      const now = performance.now();
      const currentOwner = reader.read(owner.pid);
      if (stopping || existsSync(join(opts.dir, "stop")) || !currentOwner || processIdentity(currentOwner) !== processIdentity(owner)) stopAt ??= now + 1000;
      const currentRoot = attribution && reader.read(attribution.root.pid);
      if (attribution && (!currentRoot || processIdentity(currentRoot) !== processIdentity(attribution.root))) stopAt ??= now + 1000;
      if (stopAt !== undefined && now >= stopAt) break;
      if (sandboxStreamExited(stream) || failed) {
        throw new Error(`log stream stopped unexpectedly (exit=${stream.exitCode}, signal=${stream.signalCode}): ${stderr || String(failed ?? "no output")}`);
      }
      if (!attribution && stopAt === undefined && existsSync(join(opts.dir, "root-request"))) {
        const pidText = readFileSync(join(opts.dir, "root-request"), "utf8").trim();
        const root = /^[1-9]\d{0,9}$/.test(pidText) ? reader.read(Number(pidText)) : null;
        // The gate is a direct child of start.sh/resume.sh (setsid execs it).
        if (!root || root.ppid !== owner.pid) throw new Error("CLI root registration could not verify launch ancestry");
        attribution = new SandboxAttribution(root);
        attribution.observe([root], now);
        active = [root];
        writeFileSync(join(opts.dir, "root-ready"), launch);
      }
      if (attribution) {
        const samples: ProcessObservation[] = [];
        const queue = [...active];
        const queued = new Set(queue.map(p => p.pid));
        const visited = new Set<number>();
        for (let index = 0; index < queue.length && visited.size < 4096; index++) {
          const expected = queue[index]!;
          if (visited.has(expected.pid)) continue;
          visited.add(expected.pid);
          const sample = reader.read(expected.pid);
          if (!sample || sample.birth !== expected.birth) continue;
          samples.push(sample);
          for (const pid of reader.children(sample.pid)) {
            if (queued.has(pid)) continue;
            const child = reader.read(pid);
            if (child?.ppid === sample.pid) {
              if (queue.length >= 4096) throw new Error("process tracking capacity exceeded; coverage unavailable");
              queued.add(pid);
              queue.push(child);
            }
          }
        }
        attribution.observe(samples, now);
        active = samples;
        for (let index = 0; index < pending.length;) {
          const item = pending[index]!;
          const identity = attribution.attribute(item.report);
          if (identity) {
            if (budget.accept(item.report, identity, now)) appendFileSync(opts.agentLog, `${formatSandboxRecord(item.report, identity, launch)}\n`);
            pending.splice(index, 1);
          } else if (now - item.received > 500) pending.splice(index, 1);
          else index++;
        }
      } else {
        // Before root registration all kernel reports are unrelated/unknown.
        pending.length = 0;
      }
      if (now - lastSummary >= 60000) {
        if (budget.suppressed || overflow) status("WARNING", `output suppressed=${budget.suppressed}; system stream queue overflow=${overflow}; coverage reduced`);
        budget.suppressed = 0; overflow = 0; lastSummary = now;
      }
      await Bun.sleep(20);
    }
    if (budget.suppressed || overflow) status("WARNING", `output suppressed=${budget.suppressed}; system stream queue overflow=${overflow}; coverage reduced`);
    status("INFO", "collector stopped");
    return 0;
  } catch (error) {
    status("ERROR", `${String(error)}; kernel enforcement remains required`);
    return 1;
  } finally {
    stream?.kill();
    if (stream) await stream.exited;
    await pumping; await errors;
    reader?.close();
    process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", hup);
    // Only our atomically allocated launch directory. Never shared filenames or
    // PID-based kills: a late exit cannot affect a newer launch's collector.
    if (ownsDirectory) rmSync(opts.dir, { recursive: true, force: true });
  }
}
