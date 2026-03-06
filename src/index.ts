#!/usr/bin/env bun
/**
 * itsybitsy — Cross-repo agent management dashboard
 * CLI entrypoint: add/remove/list/watch subcommands
 */

import { addRepo, removeRepo, listRepos } from "./registry";

const args = process.argv.slice(2);
const command = args[0];

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
    case "list": {
      const repos = await listRepos();
      if (repos.length === 0) {
        console.log("No repos registered. Use 'itsybitsy add <path>' to add one.");
      } else {
        for (const r of repos) {
          console.log(`  ${r.name}\t${r.path}`);
        }
      }
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
    case "agents": {
      // Debug command: print all agents across all repos with states
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
      const flat = flattenAgentTree(roots);
      if (flat.length === 0) {
        console.log("No agents found across registered repos.");
      } else {
        for (const { agent, depth } of flat) {
          const indent = "  ".repeat(depth);
          const icon = agent.meta.worker ? "⚙" : "◆";
          const archived = agent.archived ? " [archived]" : "";
          const prompt = agent.meta.prompt.slice(0, 60).replace(/\n/g, " ");
          console.log(
            `${indent}${icon} ${agent.repoName}/${agent.id}  ${agent.state}  ${agent.age}  ${agent.meta.model}  ${prompt}${archived}`
          );
        }
      }
      break;
    }
    default: {
      console.log("itsybitsy — Cross-repo agent dashboard");
      console.log("");
      console.log("Commands:");
      console.log("  add [path]     Register a repo (default: cwd)");
      console.log("  remove <path>  Unregister a repo");
      console.log("  list           List registered repos");
      console.log("  watch          Launch TUI dashboard");
      console.log("  agents         Debug: list all agents");
      break;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
