#!/usr/bin/env bun
/**
 * itsybitsy — Cross-repo agent management dashboard
 * CLI entrypoint
 */

import { addRepo, removeRepo, listRepos, repoDisplayName, type RepoEntry } from "./registry";
import { agentWorktreePath } from "./agents";
import type { Agent, FlatEntry } from "./agents";

const args = process.argv.slice(2);
const command = args[0];

/** Find an agent by ID (prefix match) across all registered repos. */
async function findAgentById(id: string, repos: RepoEntry[]): Promise<Agent | null> {
  const { readAllAgents } = await import("./agents");
  const { agents } = await readAllAgents(repos);
  // Exact match first
  const exact = agents.find((a) => a.id === id);
  if (exact) return exact;
  // Prefix match
  const matches = agents.filter((a) => a.id.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    console.error(`Ambiguous ID "${id}" matches: ${matches.map((a) => a.id).join(", ")}`);
    process.exit(1);
  }
  return null;
}

/** Print an IbCommandResult and exit. */
async function printAndExit(result: { ok: boolean; exitCode: number; stdout: string; stderr: string }): Promise<never> {
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.ok ? 0 : 1);
}

/** Require an agent ID argument, find it, or exit with error. */
async function requireAgent(idArg: string | undefined, repos: RepoEntry[]): Promise<Agent> {
  if (!idArg) {
    console.error("Usage: itsybitsy <command> <agent-id>");
    process.exit(1);
  }
  const agent = await findAgentById(idArg, repos);
  if (!agent) {
    console.error(`Agent not found: ${idArg}`);
    process.exit(1);
  }
  return agent;
}

async function main() {
  switch (command) {
    case "add": {
      const target = args[1] ?? process.cwd();
      const result = await addRepo(target);
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case "remove": {
      const target = args[1];
      if (!target) {
        console.error("Usage: itsybitsy remove <path|name>");
        process.exit(1);
      }
      const result = await removeRepo(target);
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case "list":
    case "ls": {
      const repos = await listRepos();
      if (repos.length === 0) {
        console.log("No repos registered. Use 'itsybitsy add <path>' to add one.");
      } else {
        for (const r of repos) {
          console.log(`  ${r.name}  →  ${r.path}`);
        }
      }
      break;
    }
    case "watchdog": {
      const { acquireWatchdogLock, releaseWatchdogLock, readLockPid, createDiskAgentProvider, stopWatchdog } = await import("./watchdog");
      const { startWatchdog } = await import("./watchdog");

      if (!acquireWatchdogLock()) {
        const pid = readLockPid();
        console.log(`watchdog already running (pid: ${pid})`);
        process.exit(0);
      }

      const repos = await listRepos();
      startWatchdog(createDiskAgentProvider(repos));

      // Clean shutdown on signals
      const cleanup = () => {
        stopWatchdog();
        releaseWatchdogLock();
        process.exit(0);
      };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      process.on("exit", () => releaseWatchdogLock());

      // Keep process alive — setInterval in startWatchdog holds the event loop
      break;
    }
    case "watch": {
      if (!Bun.which("ib")) {
        console.error("Error: 'ib' not found on PATH. Install ittybitty first: https://github.com/anthropics/ittybitty");
        process.exit(1);
      }
      if (!Bun.which("tmux")) {
        console.error("Error: 'tmux' not found on PATH. Install tmux: brew install tmux");
        process.exit(1);
      }
      const { launchDashboard } = await import("./tui/dashboard");
      await launchDashboard();
      break;
    }
    case "agents":
    case "tree": {
      const { readAllAgents, buildAgentTree, flattenAgentTree, detectAgentStates } = await import("./agents");
      const repos = await listRepos();
      if (repos.length === 0) {
        console.log("No repos registered. Use 'itsybitsy add <path>' to add one.");
        break;
      }
      const { agents, errors } = await readAllAgents(repos);
      for (const err of errors) {
        console.error(`Warning: ${err.error}`);
      }
      await detectAgentStates(agents);
      const roots = buildAgentTree(agents);
      const flat = flattenAgentTree(roots, repos.map((r) => ({ name: repoDisplayName(r), path: r.path })));
      if (flat.length === 0) {
        console.log("No agents found across registered repos.");
      } else {
        const { visibleWidth } = await import("@mariozechner/pi-tui");
        const { displayState, computeStateColWidth } = await import("./tui/agent-tree");
        const { getStateColors } = await import("./tui/color-scheme");
        const { BOLD, DIM, RESET } = await import("./tui/colors");

        // Collect real agent rows for column width computation
        type AgentEntry = Extract<FlatEntry, { kind: "agent" }>;
        const rowByEntry = new Map<AgentEntry, { prefix: string; state: string; age: string; model: string }>();
        for (const entry of flat) {
          if (entry.kind !== "agent") continue;
          const orphanedPrefix = entry.agent.orphaned ? "⚠ " : "";
          const icon = entry.agent.meta.worker ? "⚙" : "◆";
          const prefix = `${entry.connector}${orphanedPrefix}${icon} ${entry.agent.id}`;
          rowByEntry.set(entry, {
            prefix,
            state: displayState(entry.agent.state),
            age: entry.agent.age,
            model: entry.agent.meta.model,
          });
        }

        // Compute max visible widths for alignment
        const maxState = computeStateColWidth(flat);
        let maxPrefix = 0, maxAge = 0, maxModel = 0;
        for (const row of rowByEntry.values()) {
          const pw = visibleWidth(row.prefix);
          if (pw > maxPrefix) maxPrefix = pw;
          if (row.age.length > maxAge) maxAge = row.age.length;
          if (row.model.length > maxModel) maxModel = row.model.length;
        }

        // Compute available width for prompt (terminal width minus fixed columns and gaps)
        const termWidth = process.stdout.columns || 120;
        // prefix + 2 + state + 2 + age + 2 + model + 2 = fixed portion
        const fixedWidth = maxPrefix + 2 + maxState + 2 + maxAge + 2 + maxModel + 2;
        const promptWidth = Math.max(20, termWidth - fixedWidth);

        const stateColors = getStateColors();
        let isFirst = true;
        for (const entry of flat) {
          if (entry.kind === "repo-header") {
            if (!isFirst) console.log(""); // blank line between repos
            isFirst = false;
            console.log(`${BOLD}${entry.repoName}${RESET}  ${DIM}→  ${entry.repoPath}${RESET}`);
            if (!entry.hasAgents) {
              console.log(`  ${DIM}(no agents)${RESET}`);
            }
            continue;
          }

          const row = rowByEntry.get(entry)!;
          // Pad prefix using visibleWidth to account for box-drawing/icon chars
          const prefixPad = maxPrefix - visibleWidth(row.prefix);
          const paddedPrefix = row.prefix + " ".repeat(Math.max(0, prefixPad));
          const colorCode = stateColors[row.state] ?? DIM;
          const prompt = entry.agent.meta.prompt.slice(0, promptWidth).replace(/\n/g, " ");
          const archived = entry.agent.archived ? ` ${DIM}[archived]${RESET}` : "";
          const line = [
            paddedPrefix,
            `${colorCode}${row.state.padEnd(maxState)}${RESET}`,
            row.age.padEnd(maxAge),
            row.model.padEnd(maxModel),
            prompt + archived,
          ].join("  ");
          console.log(line);
        }
      }
      break;
    }
    case "look": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const hasAll = args.includes("--all");
      const linesIdx = args.indexOf("--lines");
      const lines = hasAll ? 10000 : linesIdx !== -1 ? parseInt(args[linesIdx + 1]!, 10) || 100 : 100;

      const { captureTmuxOutput } = await import("./tmux-poller");
      const tmuxSession = agent.meta.tmux_session;

      if (tmuxSession) {
        const output = await captureTmuxOutput(tmuxSession, lines);
        if (output !== null) {
          process.stdout.write(output);
          break;
        }
      }

      // No tmux session or session not found — fall back to agent.log
      const { readAgentLog } = await import("./agents");
      const logLines = await readAgentLog(agent);
      console.log(logLines.join("\n"));
      break;
    }
    case "info": {
      const { detectAgentStates } = await import("./agents");
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      await detectAgentStates([agent]);
      const m = agent.meta;
      console.log(`Agent:        ${agent.id}`);
      console.log(`Repo:         ${agent.repoName} (${agent.repoPath})`);
      console.log(`State:        ${agent.state}`);
      console.log(`Model:        ${m.model}`);
      console.log(`Worker:       ${m.worker}`);
      console.log(`Manager:      ${m.manager ?? "none"}`);
      console.log(`Created:      ${m.created}`);
      console.log(`Age:          ${agent.age}`);
      console.log(`Tmux session: ${m.tmux_session || "none"}`);
      console.log(`Worktree:     ${m.worktree}`);
      console.log(`Archived:     ${agent.archived}`);
      console.log(`Prompt:       ${m.prompt.slice(0, 200).replace(/\n/g, " ")}`);
      break;
    }
    case "questions":
    case "q": {
      const { readPendingQuestions } = await import("./agents");
      const repos = await listRepos();
      if (repos.length === 0) {
        console.log("No repos registered.");
        break;
      }
      let found = false;
      for (const repo of repos) {
        const questions = await readPendingQuestions(repo.path);
        for (const q of questions) {
          found = true;
          console.log(`[${repo.name}] ${q.agent}`);
          console.log(`  ${q.question}`);
          console.log(`  ${q.timestamp}`);
          console.log("");
        }
      }
      if (!found) {
        console.log("No pending questions");
      }
      break;
    }
    case "diff": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const cwd = agentWorktreePath(agent);

      // Get merge-base
      const mergeBaseProc = Bun.spawn(["git", "merge-base", "HEAD", "main"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const mergeBase = (await new Response(mergeBaseProc.stdout).text()).trim();
      const mbExit = await mergeBaseProc.exited;
      if (mbExit !== 0) {
        console.error("Failed to find merge-base with main");
        process.exit(1);
      }

      const diffProc = Bun.spawn(["git", "diff", mergeBase], {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await diffProc.exited);
      break;
    }
    case "status": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const cwd = agentWorktreePath(agent);

      const logProc = Bun.spawn(["git", "log", "--oneline", "main..HEAD"], {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await logProc.exited;

      const statusProc = Bun.spawn(["git", "status", "--short"], {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      process.exit(await statusProc.exited);
      break;
    }
    case "send": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const message = args.slice(2).join(" ");
      if (!message) {
        console.error("Usage: itsybitsy send <agent-id> <message...>");
        process.exit(1);
      }
      const { sendMessage } = await import("./ib-commands");
      await printAndExit(await sendMessage(agent, message));
      break;
    }
    case "kill": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const { killAgent } = await import("./ib-commands");
      await printAndExit(await killAgent(agent));
      break;
    }
    case "merge": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const { mergeAgent } = await import("./ib-commands");
      await printAndExit(await mergeAgent(agent));
      break;
    }
    case "resume": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const { resumeAgent } = await import("./ib-commands");
      await printAndExit(await resumeAgent(agent));
      break;
    }
    case "new-agent":
    case "new": {
      const repos = await listRepos();

      // Determine target repo: --repo flag > cwd match > single registered repo > error
      let repoPath: string | null = null;
      const repoFlagIdx = args.indexOf("--repo");
      const ibArgs = args.slice(1); // strip "new-agent"/"new"

      if (repoFlagIdx !== -1 && args[repoFlagIdx + 1]) {
        const repoArg = args[repoFlagIdx + 1]!;
        const match = repos.find((r) => r.name === repoArg || r.path === repoArg);
        if (!match) {
          console.error(`Repo not found: ${repoArg}`);
          process.exit(1);
        }
        repoPath = match.path;
        // Strip --repo and its value from ibArgs
        const flagIdxInIb = ibArgs.indexOf("--repo");
        if (flagIdxInIb !== -1) ibArgs.splice(flagIdxInIb, 2);
      } else {
        const cwd = process.cwd();
        const cwdMatch = repos.find((r) => cwd === r.path || cwd.startsWith(r.path + "/"));
        if (cwdMatch) {
          repoPath = cwdMatch.path;
        } else if (repos.length === 1) {
          repoPath = repos[0]!.path;
        } else {
          console.error("Cannot determine target repo. Use --repo <name|path> or run from within a registered repo.");
          process.exit(1);
        }
      }

      const { newAgent } = await import("./ib-commands");

      // Parse flags from ibArgs
      const promptParts: string[] = [];
      const opts: import("./ib-commands").NewAgentOptions = {};
      for (let i = 0; i < ibArgs.length; i++) {
        const arg = ibArgs[i]!;
        if (arg === "--worker") { opts.worker = true; }
        else if (arg === "--model" && ibArgs[i + 1]) { opts.model = ibArgs[++i]; }
        else if (arg === "--name" && ibArgs[i + 1]) { opts.name = ibArgs[++i]; }
        else if (arg === "--no-worktree") { opts.noWorktree = true; }
        else if (arg === "--yolo") { opts.yolo = true; }
        else if (arg === "--allow" && ibArgs[i + 1]) { opts.allowTools = ibArgs[++i]; }
        else if (arg === "--deny" && ibArgs[i + 1]) { opts.denyTools = ibArgs[++i]; }
        else { promptParts.push(arg); }
      }
      const prompt = promptParts.join(" ");
      if (!prompt) {
        console.error("Usage: itsybitsy new-agent [flags] <prompt...>");
        process.exit(1);
      }
      await printAndExit(await newAgent(repoPath, prompt, opts));
      break;
    }
    case "acknowledge":
    case "ack": {
      const questionId = args[1];
      if (!questionId) {
        console.error("Usage: itsybitsy ack <question-id>");
        process.exit(1);
      }
      // Find which repo has this question
      const { readPendingQuestions } = await import("./agents");
      const repos = await listRepos();
      let repoPath: string | null = null;
      for (const repo of repos) {
        const questions = await readPendingQuestions(repo.path);
        if (questions.some((q) => q.id === questionId)) {
          repoPath = repo.path;
          break;
        }
      }
      if (!repoPath) {
        if (repos.length === 0) {
          console.error("No repos registered.");
          process.exit(1);
        }
        repoPath = repos[0]!.path;
      }
      const { acknowledgeQuestion } = await import("./ib-commands");
      await printAndExit(await acknowledgeQuestion(repoPath, questionId));
      break;
    }
    default: {
      console.log("itsybitsy — Cross-repo agent dashboard");
      console.log("");
      console.log("Registry:");
      console.log("  add [path]          Register a repo (default: cwd)");
      console.log("  remove <path>       Unregister a repo");
      console.log("  list, ls            List registered repos");
      console.log("");
      console.log("Monitoring:");
      console.log("  watch               Launch TUI dashboard");
      console.log("  watchdog            Run watchdog as background process");
      console.log("  agents, tree        List all agents with states");
      console.log("  look <id>           Show agent's live tmux output (--lines N, --all)");
      console.log("  status <id>         Show agent's git log and status");
      console.log("  diff <id>           Show agent's git diff from main");
      console.log("  info <id>           Show agent's metadata");
      console.log("");
      console.log("Communication:");
      console.log("  send <id> <msg>     Send a message to an agent");
      console.log("  questions, q        Show pending agent questions");
      console.log("  ack <question-id>   Acknowledge a pending question");
      console.log("");
      console.log("Agent Lifecycle:");
      console.log("  new-agent, new      Spawn a new agent");
      console.log("  kill <id>           Stop an agent without merging");
      console.log("  merge <id>          Merge agent's work and close it");
      console.log("  resume <id>         Resume a stopped agent");
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
