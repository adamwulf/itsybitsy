import { test, expect, describe } from "bun:test";
import {
  TeamsTreeComponent,
  flattenTeamsTree,
  formatTeamMemberRow,
  formatTeamHeaderRow,
  type TeamFlatEntry,
} from "./teams-tree";
import { MAX_TREE_HEIGHT } from "./agent-tree";
import type { Agent } from "../agents";
import type { Team } from "../teams";

function makeAgent(
  id: string,
  repoName: string,
  model: string = "sonnet",
  state: string = "running",
): Agent {
  return {
    id,
    repoPath: `/repos/${repoName}/${id}`,
    repoName,
    meta: {
      id,
      session_id: `sess-${id}`,
      tmux_session: `ittybitty-${repoName}-${id}`,
      prompt: `Task for ${id}`,
      manager: null,
      created: "2025-01-01T00:00:00Z",
      created_epoch: 1735689600,
      worktree: true,
      worker: false,
      yolo: false,
      model,
      claude_pid: "12345",
    },
    state: state as Agent["state"],
    age: "5m",
    archived: false,
    children: [],
  };
}

function makeTeam(name: string, members: string[], overrides: Partial<Team> = {}): { name: string } & Team {
  return {
    name,
    created_epoch: 1735689600,
    created_by: "@system",
    members,
    ...overrides,
  };
}

function byId(agents: Agent[]): Map<string, Agent> {
  return new Map(agents.map((a) => [a.id, a]));
}

// Two teams: "backend" has members across 2 repos; "frontend" is empty.
function fixture(): { tree: TeamsTreeComponent; flat: TeamFlatEntry[]; agents: Agent[] } {
  const agents = [
    makeAgent("a1", "api", "opus"),
    makeAgent("a2", "web", "sonnet"),
  ];
  const teams = [
    makeTeam("backend", ["a1", "a2"]),
    makeTeam("frontend", []),
  ];
  const flat = flattenTeamsTree(teams, byId(agents));
  const tree = new TeamsTreeComponent();
  tree.setFlatList(flat);
  return { tree, flat, agents };
}

describe("flattenTeamsTree", () => {
  test("emits a header followed by one member row per resolvable member", () => {
    const { flat } = fixture();
    // backend header + a1 + a2, then frontend header (empty), sorted by name.
    expect(flat.map((r) => r.kind)).toEqual([
      "team-header",
      "team-member",
      "team-member",
      "team-header",
    ]);
    const header0 = flat[0]!;
    expect(header0.kind).toBe("team-header");
    if (header0.kind === "team-header") {
      expect(header0.teamName).toBe("backend");
      expect(header0.memberCount).toBe(2);
    }
  });

  test("sorts teams by name for stable order", () => {
    const agents = [makeAgent("z1", "api")];
    const teams = [
      makeTeam("zeta", ["z1"]),
      makeTeam("alpha", ["z1"]),
    ];
    const flat = flattenTeamsTree(teams, byId(agents));
    const headers = flat.filter((r) => r.kind === "team-header") as Extract<TeamFlatEntry, { kind: "team-header" }>[];
    expect(headers.map((h) => h.teamName)).toEqual(["alpha", "zeta"]);
  });

  test("a member id with no matching live agent is omitted", () => {
    const agents = [makeAgent("a1", "api")];
    const teams = [makeTeam("backend", ["a1", "ghost"])];
    const flat = flattenTeamsTree(teams, byId(agents));
    const members = flat.filter((r) => r.kind === "team-member") as Extract<TeamFlatEntry, { kind: "team-member" }>[];
    expect(members.map((m) => m.agent.id)).toEqual(["a1"]);
    const header = flat[0]!;
    if (header.kind === "team-header") {
      // memberCount reflects the LIVE (resolvable) count, not the stored list.
      expect(header.memberCount).toBe(1);
    }
  });

  test("an empty team still emits its header with no child rows", () => {
    const flat = flattenTeamsTree([makeTeam("frontend", [])], new Map());
    expect(flat.length).toBe(1);
    expect(flat[0]!.kind).toBe("team-header");
    if (flat[0]!.kind === "team-header") expect(flat[0]!.memberCount).toBe(0);
  });
});

describe("TeamsTreeComponent selection", () => {
  test("starts in no-selection (§17.1)", () => {
    const { tree } = fixture();
    expect(tree.selection).toBeNull();
    expect(tree.selectedTeamName).toBeNull();
    expect(tree.selectedMemberAgent).toBeNull();
  });

  test("navigate(1) from no-selection selects the first row (§17.1)", () => {
    const { tree } = fixture();
    tree.navigate(1);
    // First row is the backend team header.
    expect(tree.selection).toEqual({ kind: "team", teamName: "backend" });
  });

  test("navigate(-1) from no-selection selects the last row (§17.1)", () => {
    const { tree } = fixture();
    tree.navigate(-1);
    // Last row is the frontend (empty) team header.
    expect(tree.selection).toEqual({ kind: "team", teamName: "frontend" });
  });

  test("navigate moves one row at a time over headers and members", () => {
    const { tree } = fixture();
    tree.navigate(1); // backend header
    tree.navigate(1); // a1 member
    expect(tree.selection?.kind).toBe("agent");
    const sel = tree.selection;
    if (sel?.kind === "agent") expect(sel.agent.id).toBe("a1");
    tree.navigate(1); // a2 member
    const sel2 = tree.selection;
    if (sel2?.kind === "agent") expect(sel2.agent.id).toBe("a2");
    tree.navigate(1); // frontend header
    expect(tree.selection).toEqual({ kind: "team", teamName: "frontend" });
  });

  test("selecting a team-member row yields a {kind:'agent'} selection", () => {
    const { tree } = fixture();
    tree.navigate(1); // header
    tree.navigate(1); // first member
    const sel = tree.selection;
    expect(sel?.kind).toBe("agent");
    if (sel?.kind === "agent") {
      expect(sel.agent.id).toBe("a1");
      expect(tree.selectedMemberAgent?.id).toBe("a1");
    }
  });

  test("navigateAnchor moves between team headers and selects the header (§17.2)", () => {
    const { tree } = fixture();
    tree.navigateAnchor(1); // from no-selection -> first team anchor (backend)
    expect(tree.selection).toEqual({ kind: "team", teamName: "backend" });
    tree.navigateAnchor(1); // -> next team anchor (frontend)
    expect(tree.selection).toEqual({ kind: "team", teamName: "frontend" });
    tree.navigateAnchor(-1); // -> previous team anchor (backend)
    expect(tree.selection).toEqual({ kind: "team", teamName: "backend" });
  });

  test("navigateAnchor(-1) from no-selection lands on the last team anchor (§17.1)", () => {
    const { tree } = fixture();
    tree.navigateAnchor(-1);
    expect(tree.selection).toEqual({ kind: "team", teamName: "frontend" });
  });

  test("navigateAnchor from a member row jumps to the next team header", () => {
    const { tree } = fixture();
    tree.navigate(1); // backend header
    tree.navigate(1); // a1 member (under backend)
    tree.navigateAnchor(1); // jump to next team header (frontend)
    expect(tree.selection).toEqual({ kind: "team", teamName: "frontend" });
  });

  test("repopulating while in no-selection stays in no-selection (§17.1)", () => {
    const { tree, flat } = fixture();
    expect(tree.selection).toBeNull();
    tree.setFlatList(flat);
    expect(tree.selection).toBeNull();
  });
});

describe("TeamsTreeComponent render", () => {
  test("empty registry renders the placeholder line", () => {
    const tree = new TeamsTreeComponent();
    tree.setFlatList([]);
    const lines = tree.render(60);
    expect(lines[0]).toContain("No teams");
  });

  test("empty team renders (0 members) and no child rows", () => {
    const tree = new TeamsTreeComponent();
    tree.setFlatList(flattenTeamsTree([makeTeam("frontend", [])], new Map()));
    const lines = tree.render(80);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("@frontend");
    expect(lines[0]).toContain("(0 members)");
  });

  test("member row shows the repo/model token (§17.2)", () => {
    const { tree } = fixture();
    const joined = tree.render(80).join("\n");
    // a1 lives in repo "api" on model "opus".
    expect(joined).toContain("api/opus");
    // a2 lives in repo "web" on model "sonnet".
    expect(joined).toContain("web/sonnet");
  });

  test("header shows the live member count badge", () => {
    const { tree } = fixture();
    const joined = tree.render(80).join("\n");
    expect(joined).toContain("@backend");
    expect(joined).toContain("(2)");
  });

  test("no reverse-video row in no-selection, but a selected row highlights (§17.1)", () => {
    const { tree } = fixture();
    const reverse = "\x1b[7m";
    expect(tree.render(80).join("\n")).not.toContain(reverse);
    tree.navigate(1);
    expect(tree.render(80).join("\n")).toContain(reverse);
  });

  test("scroll indicators appear when rows exceed MAX_TREE_HEIGHT", () => {
    // Build enough teams to overflow the visible window.
    const agents: Agent[] = [];
    const teams: Array<{ name: string } & Team> = [];
    for (let i = 0; i < MAX_TREE_HEIGHT + 5; i++) {
      const id = `m${i}`;
      agents.push(makeAgent(id, "api"));
      teams.push(makeTeam(`team${i}`, [id]));
    }
    const tree = new TeamsTreeComponent();
    tree.setFlatList(flattenTeamsTree(teams, byId(agents)));
    // Navigate down past the window so a top "▲ N more" indicator appears.
    tree.navigate(1);
    for (let i = 0; i < MAX_TREE_HEIGHT + 4; i++) tree.navigate(1);
    const joined = tree.render(80).join("\n");
    expect(joined).toContain("more");
  });
});

describe("teams-tree row formatters", () => {
  test("formatTeamHeaderRow uses (N) badge for populated teams", () => {
    const row = formatTeamHeaderRow("backend", 3, false, 80);
    expect(row).toContain("@backend");
    expect(row).toContain("(3)");
  });

  test("formatTeamHeaderRow uses (0 members) for empty teams", () => {
    const row = formatTeamHeaderRow("backend", 0, false, 80);
    expect(row).toContain("(0 members)");
  });

  test("formatTeamMemberRow includes id, state, and repo/model", () => {
    const agent = makeAgent("a1", "api", "opus", "waiting");
    const row = formatTeamMemberRow(agent, "  ", false, 80, 20);
    expect(row).toContain("a1");
    expect(row).toContain("api/opus");
    expect(row).toContain("waiting");
  });
});
