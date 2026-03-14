#!/usr/bin/env bun
/**
 * ib — Cross-repo agent management dashboard
 * CLI entrypoint
 */

import { join } from "path";
import { addRepo, removeRepo, listRepos, repoDisplayName, type RepoEntry } from "./registry";
import type { Agent, FlatEntry } from "./agents";
import { isValidAgentId } from "./validation";

const args = process.argv.slice(2);
const command = args[0];

/**
 * Collect non-archived agents for display, optionally filtered by manager.
 * Recursively walks children, pushing { agent, depth } into the result array.
 */
export function collectAgents(
  agent: Agent,
  depth: number,
  managerFilter: string | null,
  result: { agent: Agent; depth: number }[],
): void {
  if (agent.archived) return;
  if (managerFilter) {
    if (agent.meta.manager !== managerFilter && agent.id !== managerFilter) return;
  }
  result.push({ agent, depth });
  for (const child of agent.children) {
    collectAgents(child, depth + 1, managerFilter, result);
  }
}

/**
 * Recursively search for a manager by ID in the agent tree.
 * When found, collects that manager's children using collectAgents.
 */
export function findManagerInTree(
  agent: Agent,
  managerId: string,
  result: { agent: Agent; depth: number }[],
): void {
  if (agent.id === managerId) {
    for (const child of agent.children) {
      collectAgents(child, 1, null, result);
    }
  } else {
    for (const child of agent.children) {
      findManagerInTree(child, managerId, result);
    }
  }
}

/**
 * Match an agent by ID from a pre-loaded list. Exact match first, then prefix.
 * Returns { match, ambiguous } — ambiguous is set when multiple prefix matches exist.
 */
export function matchAgentById(id: string, agents: Agent[]): { match: Agent | null; ambiguous: string[] } {
  const exact = agents.find((a) => a.id === id);
  if (exact) return { match: exact, ambiguous: [] };
  const matches = agents.filter((a) => a.id.startsWith(id));
  if (matches.length === 1) return { match: matches[0]!, ambiguous: [] };
  if (matches.length > 1) return { match: null, ambiguous: matches.map((a) => a.id) };
  return { match: null, ambiguous: [] };
}

/** Find an agent by ID (prefix match) across all registered repos. */
export async function findAgentById(id: string, repos: RepoEntry[]): Promise<Agent | null> {
  const { readAllAgents } = await import("./agents");
  const { agents } = await readAllAgents(repos);
  const { match, ambiguous } = matchAgentById(id, agents);
  if (ambiguous.length > 0) {
    console.error(`Ambiguous ID "${id}" matches: ${ambiguous.join(", ")}`);
    process.exit(1);
  }
  return match;
}

/** Print an IbCommandResult and exit. */
export async function printAndExit(result: { ok: boolean; exitCode: number; stdout: string; stderr: string }): Promise<never> {
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.exitCode);
}

/** Require an agent ID argument, find it, or exit with error. */
export async function requireAgent(idArg: string | undefined, repos: RepoEntry[]): Promise<Agent> {
  if (!idArg) {
    console.error("Usage: ib <command> <agent-id>");
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
        console.error("Usage: ib remove <path|name>");
        process.exit(1);
      }
      const result = await removeRepo(target);
      console.log(result.message);
      process.exit(result.ok ? 0 : 1);
      break;
    }
    case "list":
    case "ls": {
      const { readAllAgents, buildAgentTree, detectAgentStates } = await import("./agents");
      const repos = await listRepos();
      if (repos.length === 0) {
        console.log("No repos registered. Use 'ib add <path>' to add one.");
        break;
      }

      // Filter by --manager flag if provided
      const managerIdx = args.indexOf("--manager");
      const managerFilter = managerIdx !== -1 ? args[managerIdx + 1] : null;
      const jsonOutput = args.includes("--json");

      const { agents, errors } = await readAllAgents(repos);
      for (const err of errors) {
        console.error(`Warning: ${err.error}`);
      }
      await detectAgentStates(agents);
      const roots = buildAgentTree(agents);

      if (jsonOutput) {
        // Collect agents matching the manager filter (reuse extracted helpers)
        const agentsToShow: { agent: Agent; depth: number }[] = [];
        for (const root of roots) {
          if (managerFilter) {
            if (root.id === managerFilter) {
              for (const child of root.children) {
                collectAgents(child, 1, null, agentsToShow);
              }
            } else {
              findManagerInTree(root, managerFilter, agentsToShow);
            }
          } else {
            collectAgents(root, 0, null, agentsToShow);
          }
        }
        const jsonData = agentsToShow.map(({ agent: a }) => ({
          id: a.id,
          state: a.state,
          age: a.age,
          model: a.meta.model,
          worker: a.meta.worker,
          manager: a.meta.manager ?? null,
          repo: a.repoName,
          repoPath: a.repoPath,
          prompt: a.meta.prompt,
          summary: a.meta.summary ?? null,
          orphaned: a.orphaned ?? false,
        }));
        console.log(JSON.stringify(jsonData, null, 2));
        break;
      }

      const { BOLD, DIM, RESET } = await import("./tui/colors");
      const { displayState } = await import("./tui/agent-tree");
      const { getStateColors } = await import("./tui/color-scheme");
      const stateColors = getStateColors();

      let isFirst = true;
      for (const repo of repos) {
        const name = repoDisplayName(repo);
        // Find root agents for this repo
        const repoRoots = roots.filter((a) => a.repoName === name && !a.archived);

        if (!isFirst) console.log("");
        isFirst = false;
        console.log(`${BOLD}${name}${RESET}  ${DIM}→  ${repo.path}${RESET}`);

        // Collect agents to display (flat list with indentation for children)
        const agentsToShow: { agent: Agent; depth: number }[] = [];
        for (const root of repoRoots) {
          if (managerFilter) {
            // When filtering by manager, show direct children of the manager
            if (root.id === managerFilter) {
              for (const child of root.children) {
                collectAgents(child, 1, null, agentsToShow);
              }
            } else {
              findManagerInTree(root, managerFilter, agentsToShow);
            }
          } else {
            collectAgents(root, 0, null, agentsToShow);
          }
        }

        if (agentsToShow.length === 0) {
          console.log(`  ${DIM}(no agents)${RESET}`);
        } else {
          for (const { agent, depth } of agentsToShow) {
            const indent = "  ".repeat(depth);
            const icon = agent.meta.worker ? "⚙" : "◆";
            const state = displayState(agent.state);
            const colorCode = stateColors[state] ?? DIM;
            const orphanMark = agent.orphaned ? "⚠ " : "";
            console.log(`${indent}${orphanMark}${icon} ${agent.id}  ${colorCode}${state}${RESET}  ${agent.age}  ${DIM}${agent.meta.model}${RESET}`);
          }
        }
      }
      break;
    }
    case "watchdog": {
      const watchdogAgentId = args[1];

      if (watchdogAgentId) {
        // Per-agent watchdog: `ib watchdog <id>`
        if (!isValidAgentId(watchdogAgentId)) {
          console.error(`Invalid agent ID: ${watchdogAgentId}`);
          process.exit(1);
        }
        const { runPerAgentWatchdog } = await import("./watchdog");
        const repos = await listRepos();
        if (repos.length === 0) {
          console.error("No repos registered.");
          process.exit(1);
        }
        // Find the repo containing this agent
        const { existsSync } = await import("fs");
        const agentRepo = repos.find((r) =>
          existsSync(join(r.path, ".ittybitty", "agents", watchdogAgentId, "meta.json"))
        );
        if (!agentRepo) {
          console.error(`Agent ${watchdogAgentId} not found in any registered repo.`);
          process.exit(1);
        }
        await runPerAgentWatchdog(watchdogAgentId, agentRepo.path);
      } else {
        // Global watchdog: `ib watchdog` (no agent ID)
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
      }

      // Per-agent: runPerAgentWatchdog blocks until exit conditions are met
      // Global: setInterval in startWatchdog holds the event loop
      break;
    }
    case "generate-summary": {
      const agentDir = args[1];
      if (!agentDir) {
        console.error("Usage: ib generate-summary <agentDir>");
        process.exit(1);
      }
      const { generateSummary } = await import("./generate-summary");
      try {
        await generateSummary(agentDir);
      } catch { /* ignore — fire-and-forget subprocess */ }
      break;
    }
    case "watch": {
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
        console.log("No repos registered. Use 'ib add <path>' to add one.");
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
          const prompt = (entry.agent.meta.summary ?? entry.agent.meta.prompt).slice(0, promptWidth).replace(/\n/g, " ");
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
      const hasFollow = args.includes("--follow");
      const linesIdx = args.indexOf("--lines");
      const lines = hasAll ? 10000 : linesIdx !== -1 ? parseInt(args[linesIdx + 1]!, 10) || 100 : 100;

      const tmuxSession = agent.meta.tmux_session;

      if (hasFollow) {
        if (!tmuxSession) {
          console.error("Agent has no tmux session");
          process.exit(1);
        }
        console.error(`Attaching to ${agent.id} (Ctrl+b d to detach)...`);
        const attachProc = Bun.spawn(["tmux", "attach", "-t", tmuxSession, "-r"], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        process.exit(await attachProc.exited);
        break;
      }

      const { captureTmuxOutput } = await import("./tmux-poller");

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
      const { readPendingQuestions, readAllQuestions } = await import("./agents");
      const repos = await listRepos();
      const showAll = args.includes("--all") || args.includes("-a");
      if (repos.length === 0) {
        console.log("No repos registered.");
        break;
      }
      let found = false;
      for (const repo of repos) {
        const questions = showAll
          ? await readAllQuestions(repo.path)
          : await readPendingQuestions(repo.path);
        for (const q of questions) {
          found = true;
          const statusTag = showAll && q.status === "acknowledged" ? " [acknowledged]" : "";
          console.log(`[${repo.name}] ${q.agent}${statusTag}`);
          console.log(`  ${q.question}`);
          console.log(`  ${q.timestamp}`);
          console.log("");
        }
      }
      if (!found) {
        console.log(showAll ? "No questions yet." : "No pending questions");
      }
      break;
    }
    case "diff": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const statOnly = args.includes("--stat");
      const { diffAgent } = await import("./ib-commands");
      await printAndExit(await diffAgent(agent, { stat: statOnly }));
      break;
    }
    case "status": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const { statusAgent } = await import("./ib-commands");
      await printAndExit(await statusAgent(agent));
      break;
    }
    case "send": {
      const repos = await listRepos();
      // Parse --from flag before determining agent and message
      const sendArgs = args.slice(1);
      let fromAgent: string | undefined;
      const filteredSendArgs: string[] = [];
      for (let i = 0; i < sendArgs.length; i++) {
        if (sendArgs[i] === "--from") {
          if (!sendArgs[i + 1]) { console.error("Error: --from requires a value"); process.exit(1); }
          fromAgent = sendArgs[++i];
        } else {
          filteredSendArgs.push(sendArgs[i]!);
        }
      }
      const agent = await requireAgent(filteredSendArgs[0], repos);
      let message = filteredSendArgs.slice(1).join(" ");
      if (!message) {
        // If stdin is piped (not TTY), read message from stdin
        if (!process.stdin.isTTY) {
          const chunks: string[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
          }
          message = chunks.join("").trim();
        }
        if (!message) {
          console.error("Usage: ib send [--from <id>] <agent-id> <message...>");
          process.exit(1);
        }
      }
      const { sendMessage } = await import("./ib-commands");
      await printAndExit(await sendMessage(agent, message, fromAgent ? { fromAgent } : undefined));
      break;
    }
    case "kill": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const extraArgs = args.slice(2).filter((a) => a !== "--force");
      if (extraArgs.length > 0) {
        console.error(`Warning: unknown arguments ignored: ${extraArgs.join(" ")}`);
      }
      const { killAgent } = await import("./ib-commands");
      await printAndExit(await killAgent(agent));
      break;
    }
    case "nuke": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const { nukeAgent } = await import("./ib-commands");
      await printAndExit(await nukeAgent(agent));
      break;
    }
    case "merge-check": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const { mergeCheckAgent } = await import("./ib-commands");
      await printAndExit(await mergeCheckAgent(agent));
      break;
    }
    case "merge": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const extraArgs = args.slice(2).filter((a) => a !== "--force");
      if (extraArgs.length > 0) {
        console.error(`Warning: unknown arguments ignored: ${extraArgs.join(" ")}`);
      }
      const { mergeAgent } = await import("./ib-commands");
      await printAndExit(await mergeAgent(agent));
      break;
    }
    case "resume": {
      const repos = await listRepos();
      const agent = await requireAgent(args[1], repos);
      const extraArgs = args.slice(2).filter((a) => a !== "--force");
      if (extraArgs.length > 0) {
        console.error(`Warning: unknown arguments ignored: ${extraArgs.join(" ")}`);
      }
      const { detectAgentStates } = await import("./agents");
      await detectAgentStates([agent]);
      const { resumeAgent } = await import("./ib-commands");
      await printAndExit(await resumeAgent(agent));
      break;
    }
    case "new-agent":
    case "new": {
      const ibArgs = args.slice(1); // strip "new-agent"/"new"

      // Parse flags first (validates syntax before repo lookup)
      const promptParts: string[] = [];
      const opts: import("./ib-commands").NewAgentOptions = {};
      let repoArg: string | undefined;
      for (let i = 0; i < ibArgs.length; i++) {
        const arg = ibArgs[i]!;
        if (arg === "--worker") { opts.worker = true; }
        else if (arg === "--model") {
          if (!ibArgs[i + 1]) { console.error("Error: --model requires a value"); process.exit(1); }
          opts.model = ibArgs[++i];
        }
        else if (arg === "--manager") {
          if (!ibArgs[i + 1]) { console.error("Error: --manager requires an agent ID"); process.exit(1); }
          opts.manager = ibArgs[++i];
        }
        else if (arg === "--name") {
          if (!ibArgs[i + 1]) { console.error("Error: --name requires a value"); process.exit(1); }
          opts.name = ibArgs[++i];
        }
        else if (arg === "--repo") {
          if (!ibArgs[i + 1]) { console.error("Error: --repo requires a value"); process.exit(1); }
          repoArg = ibArgs[++i];
        }
        else if (arg === "--prompt-file") {
          if (!ibArgs[i + 1]) { console.error("Error: --prompt-file requires a value"); process.exit(1); }
          const promptFilePath = ibArgs[++i]!;
          const promptFile = Bun.file(promptFilePath);
          if (!(await promptFile.exists())) { console.error(`Error: prompt file not found: ${promptFilePath}`); process.exit(1); }
          promptParts.push(await promptFile.text());
        }
        else if (arg === "--no-worktree") { opts.noWorktree = true; }
        else if (arg === "--yolo") { opts.yolo = true; }
        else if (arg === "--allow") {
          if (!ibArgs[i + 1]) { console.error("Error: --allow requires a value"); process.exit(1); }
          opts.allowTools = ibArgs[++i];
        }
        else if (arg === "--deny") {
          if (!ibArgs[i + 1]) { console.error("Error: --deny requires a value"); process.exit(1); }
          opts.denyTools = ibArgs[++i];
        }
        else if (arg.startsWith("--")) {
          console.error(`Error: unknown flag '${arg}'`);
          process.exit(1);
        }
        else { promptParts.push(arg); }
      }
      const prompt = promptParts.join(" ");
      if (!prompt) {
        console.error("Usage: ib new-agent [flags] <prompt...>");
        process.exit(1);
      }

      // Determine target repo: --repo flag > cwd match > single registered repo > error
      const repos = await listRepos();
      let repoPath: string | null = null;

      if (repoArg) {
        const match = repos.find((r) => r.name === repoArg || r.path === repoArg);
        if (!match) {
          console.error(`Repo not found: ${repoArg}`);
          process.exit(1);
        }
        repoPath = match.path;
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
      await printAndExit(await newAgent(repoPath, prompt, opts));
      break;
    }
    case "acknowledge":
    case "ack": {
      const questionId = args[1];
      if (!questionId) {
        console.error("Usage: ib ack <question-id>");
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
    case "ask": {
      const repos = await listRepos();
      // Parse --id flag or auto-detect from CWD
      const askArgs = args.slice(1);
      let askAgentId: string | undefined;
      const askQuestionParts: string[] = [];
      for (let i = 0; i < askArgs.length; i++) {
        const arg = askArgs[i]!;
        if (arg === "--id") {
          askAgentId = askArgs[++i];
        } else {
          askQuestionParts.push(arg);
        }
      }
      const askQuestionText = askQuestionParts.join(" ");

      // Auto-detect agent ID from CWD
      if (!askAgentId) {
        const cwd = process.cwd();
        const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/([^/]+)\/repo/);
        if (worktreeMatch) {
          askAgentId = worktreeMatch[1];
        }
      }

      if (!askAgentId) {
        console.error("Error: Could not detect agent ID. Run from an agent worktree or use --id <agent-id>.");
        process.exit(1);
      }
      if (!askQuestionText) {
        console.error('Usage: ib ask [--id <agent-id>] "question"');
        process.exit(1);
      }

      // Determine repo path from agent
      const askAgent = await findAgentById(askAgentId, repos);
      if (!askAgent) {
        console.error(`Agent not found: ${askAgentId}`);
        process.exit(1);
      }

      const { askQuestion } = await import("./ib-commands");
      await printAndExit(await askQuestion(askAgent.repoPath, askAgentId, askQuestionText));
      break;
    }
    case "log": {
      const repos = await listRepos();
      // Parse --id and --quiet flags
      const logArgs = args.slice(1);
      let logAgentId: string | undefined;
      let logQuiet = false;
      const logMessageParts: string[] = [];
      for (let i = 0; i < logArgs.length; i++) {
        const arg = logArgs[i]!;
        if (arg === "--id") {
          logAgentId = logArgs[++i];
        } else if (arg === "--quiet" || arg === "-q") {
          logQuiet = true;
        } else {
          logMessageParts.push(arg);
        }
      }
      const logMessage = logMessageParts.join(" ");

      // Auto-detect agent ID from cwd if not specified
      if (!logAgentId) {
        const cwd = process.cwd();
        const worktreeMatch = cwd.match(/\/.ittybitty\/agents\/([^/]+)\/repo/);
        if (worktreeMatch) {
          logAgentId = worktreeMatch[1];
        }
      }

      if (!logAgentId) {
        console.error("Error: Could not detect agent ID. Run from an agent worktree or use --id.");
        process.exit(1);
      }
      if (!logMessage) {
        console.error('Usage: ib log [--id <agent-id>] [--quiet] "message"');
        process.exit(1);
      }

      const agent = await findAgentById(logAgentId, repos);
      if (!agent) {
        console.error(`Agent not found: ${logAgentId}`);
        process.exit(1);
      }

      const { join } = await import("path");
      const { logAgent } = await import("./agent-lifecycle");
      const agentDir = join(agent.repoPath, ".ittybitty", agent.archived ? "archive" : "agents", agent.id);
      await logAgent(agentDir, logMessage);

      if (!logQuiet) {
        console.log(logMessage);
      }
      break;
    }
    case "parse-state": {
      const { parseState } = await import("./parse-state");
      const psArgs = args.slice(1);
      let verbose = false;
      let inputFile: string | undefined;
      for (const arg of psArgs) {
        if (arg === "-v" || arg === "--verbose") verbose = true;
        else if (!arg.startsWith("-")) inputFile = arg;
      }

      let input: string;
      if (inputFile) {
        const file = Bun.file(inputFile);
        if (!(await file.exists())) {
          console.error(`Error: file not found: ${inputFile}`);
          process.exit(1);
        }
        input = await file.text();
      } else if (process.stdin.isTTY) {
        console.error("Error: no input provided. Use a file argument or pipe input.");
        console.error("Usage: ib parse-state [file] or echo 'text' | ib parse-state");
        process.exit(1);
      } else {
        // Read from stdin
        const chunks: string[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        }
        input = chunks.join("");
      }

      const result = parseState(input);
      if (verbose) {
        console.log(`${result.state} (matched: ${result.reason})`);
      } else {
        console.log(result.state);
      }
      break;
    }
    // ── Hook subcommands (called by Claude Code's hook system) ──
    case "hook-check-path": {
      const id = args[1];
      if (!id) { console.error("Usage: ib hook-check-path <agent-id>"); process.exit(1); }
      if (!isValidAgentId(id)) { console.error("Invalid agent ID"); process.exit(1); }
      const { hookCheckPath } = await import("./hooks/agent-path");
      await hookCheckPath(id);
      break;
    }
    case "hook-status": {
      const id = args[1];
      if (!id) { console.error("Usage: ib hook-status <agent-id>"); process.exit(1); }
      if (!isValidAgentId(id)) { console.error("Invalid agent ID"); process.exit(1); }
      const { hookStatus } = await import("./hooks/agent-status");
      await hookStatus(id);
      break;
    }
    case "hook-permission-denied": {
      const id = args[1];
      if (!id) { console.error("Usage: ib hook-permission-denied <agent-id>"); process.exit(1); }
      if (!isValidAgentId(id)) { console.error("Invalid agent ID"); process.exit(1); }
      const { hookPermissionDenied } = await import("./hooks/permission-denied");
      await hookPermissionDenied(id);
      break;
    }
    case "hooks": {
      // Nested subcommands under "hooks"
      const subcommand = args[1];
      switch (subcommand) {
        case "intercept-task": {
          const { hookInterceptTask } = await import("./hooks/intercept-task");
          await hookInterceptTask();
          break;
        }
        case "session-start": {
          const { hookSessionStart } = await import("./hooks/session-start");
          await hookSessionStart();
          break;
        }
        case "main-path": {
          const { hookMainPath } = await import("./hooks/main-path");
          await hookMainPath();
          break;
        }
        case "inject-status": {
          const { hookInjectStatus } = await import("./hooks/inject-status");
          const statusFlags = args.slice(2);
          let mode: "full" | "if-changed" | "brief" = "full";
          let visible = false;
          for (const flag of statusFlags) {
            if (flag === "--full") mode = "full";
            else if (flag === "--if-changed") mode = "if-changed";
            else if (flag === "--brief") mode = "brief";
            else if (flag === "--visible") visible = true;
          }
          await hookInjectStatus({ mode, visible });
          break;
        }
        case "install": {
          const { installSafetyHooks } = await import("./ib-commands");
          await printAndExit(await installSafetyHooks(process.cwd()));
          break;
        }
        case "uninstall": {
          const { uninstallSafetyHooks } = await import("./ib-commands");
          await printAndExit(await uninstallSafetyHooks(process.cwd()));
          break;
        }
        case "status": {
          const { hooksStatus } = await import("./ib-commands");
          await printAndExit(await hooksStatus(process.cwd()));
          break;
        }
        case "intercept-install": {
          const { installInterceptHook } = await import("./ib-commands");
          await printAndExit(await installInterceptHook(process.cwd()));
          break;
        }
        case "intercept-uninstall": {
          const { uninstallInterceptHook } = await import("./ib-commands");
          await printAndExit(await uninstallInterceptHook(process.cwd()));
          break;
        }
        case "intercept-status": {
          const { interceptHooksStatus } = await import("./ib-commands");
          await printAndExit(await interceptHooksStatus(process.cwd()));
          break;
        }
        default:
          console.error(`Unknown hooks subcommand: ${subcommand}`);
          console.error("Available: intercept-task, session-start, main-path, inject-status, install, uninstall, status, intercept-install, intercept-uninstall, intercept-status");
          process.exit(1);
      }
      break;
    }
    default: {
      console.log("ib — Cross-repo agent dashboard");
      console.log("");
      console.log("Registry:");
      console.log("  add [path]          Register a repo (default: cwd)");
      console.log("  remove <path>       Unregister a repo");
      console.log("  list, ls            List repos and their agents (--manager <id>, --json)");
      console.log("");
      console.log("Monitoring:");
      console.log("  watch               Launch TUI dashboard");
      console.log("  watchdog [id]       Run watchdog (per-agent with id, or global without)");
      console.log("  agents, tree        List all agents with states");
      console.log("  look <id>           Show agent's live tmux output (--lines N, --all, --follow)");
      console.log("  status <id>         Show agent's git log and status");
      console.log("  diff <id>           Show agent's git diff from parent (--stat)");
      console.log("  log <msg>           Write to agent log (--id <id>, --quiet)");
      console.log("  parse-state [file]  Parse agent state from text (-v for verbose)");
      console.log("  info <id>           Show agent's metadata");
      console.log("");
      console.log("Communication:");
      console.log("  send <id> <msg>     Send a message to an agent (--from <id>, stdin)");
      console.log("  ask <question>      Ask user a question (--id <agent-id>)");
      console.log("  questions, q        Show pending agent questions (--all)");
      console.log("  acknowledge <qid>   Acknowledge a pending question (alias: ack)");
      console.log("");
      console.log("Agent Lifecycle:");
      console.log("  new-agent, new      Spawn a new agent");
      console.log("  kill <id>           Stop an agent without merging");
      console.log("  nuke <id>           Kill and archive an agent");
      console.log("  merge <id>          Merge agent's work and close it");
      console.log("  merge-check <id>    Check if agent is ready to merge");
      console.log("  resume <id>         Resume a stopped agent");
      console.log("");
      console.log("Hooks:");
      console.log("  hooks install       Install safety hooks");
      console.log("  hooks uninstall     Uninstall safety hooks");
      console.log("  hooks status        Show hook installation status");
      console.log("  hooks intercept-install    Install intercept hook");
      console.log("  hooks intercept-uninstall  Uninstall intercept hook");
      console.log("  hooks intercept-status     Show intercept hook status");
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
