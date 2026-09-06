---
name: _all
description: Permissions and prompt prefix applied to every agent
spawnable: false
permissions:
  allow: []
  deny: []
paths:
  # Verified static bootstrap floor — the minimum that boots Claude under
  # deny-by-default, provenance docs/SANDBOX-BASELINE-MINIMAL.md §(a)–(e) plus
  # the §6.11/§6.14 ~/.itsybitsy write floor. Runtime
  # AGENTDIR/WORKTREE/GITDIR/REPOAGENTS roots are injected separately for every
  # agent (sandboxing is mandatory); the tmux socket is denied for non-spawners.
  # NOTE: "/" and "~" were dropped from allowRead (A3, Adam 2026-09-02): the
  # root DIRECTORY listing comes from sandbox.rawAllow
  # (allow file-read-data (literal "/")) below, not a whole-tree read, and home
  # is no longer a read ancestor. Known cost: `bunx tsc` in a worktree WITHOUT
  # node_modules scans several home locations and needs broad home read, so a
  # type that runs the dev gate on an uninstalled worktree adds "~" itself.
  allowRead:
    - "/usr"
    - "/System"
    - "/Library"
    - "/bin"
    - "/sbin"
    - "/opt/homebrew"
    - "/private/etc"
    - "/private/var"
    - "/dev"
    - "~/.claude"
    - "~/.claude.json"
    - "~/.local"
    - "~/.bun"
    - "~/.codex"
    - "~/.itsybitsy"
    - "~/.gitconfig"
    - "~/Library/Keychains"
  allowWrite:
    - "~/.claude"
    - "~/.claude.json"
    - "~/.bun"
    - "~/.codex"
    - "~/.itsybitsy/agents"
    - "~/.itsybitsy/teams"
    - "~/.itsybitsy/teams.json"
    - "~/.itsybitsy/teams.json.tmp"
    - "~/.itsybitsy/.teams.lock"
    - "/private/tmp"
    - "/private/var/folders"
    - "/dev"
  deny:
    - "~/.ssh"
    - "~/.aws"
    - "**/.env"
    # Sealed records (A4 G3, SPEC-SANDBOX 4C.3). The seal freezes each agent's
    # profile inputs (agentType, canSpawnChildren, paths, sandbox) so a later
    # meta edit is detected on resume. AGENTDIR is a kernel write root, but the
    # seal dir is NOT — deny both read and write here so a sandboxed non-spawner
    # can neither read its own seal nor forge one. Deny wins over the
    # ~/.itsybitsy read floor above and cannot be re-opened by any layer. The
    # seal is written by unsandboxed lifecycle ops (newAgent/refresh/rehire) or,
    # for a sandboxed spawner, through the unsandboxed tmux server.
    - "~/.itsybitsy/sealed"
sandbox:
  # No `enabled` key: sandboxing is mandatory and always on (Adam, 2026-09-05).
  # The switch was retired — an authored `enabled:` (true OR false) is rejected
  # at `ib watch` startup. Only rawAllow (raw SBPL) and domains are configurable.
  rawAllow:
    - (allow process*)
    - (allow sysctl-read)
    - (allow file-read-metadata)
    # Mandatory root-directory listing (docs/SANDBOX-BASELINE-MINIMAL.md §(a)):
    # bisection proved Bun/Node readdir the "/" node at init; without this line
    # the process SIGABRTs before logger init. file-read-data on the literal
    # root node grants the listing only, NOT a whole-tree read — it replaces the
    # dropped allowRead "/" entry. resolvePathAccess models only the paths
    # table, so a read of "/" resolves to deny while the kernel lists root: the
    # one sanctioned divergence (SPEC-SANDBOX.md 4A.8).
    - (allow file-read-data (literal "/"))
    - (allow file-ioctl)
    - (allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.securityd") (global-name "com.apple.security.agent") (global-name "com.apple.SecurityServer") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.logger") (global-name "com.apple.diagnosticd") (global-name "com.apple.logd") (global-name "com.apple.logd.events") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.system.DirectoryService.libinfo_v1") (global-name "com.apple.dnssd.service") (global-name "com.apple.mDNSResponder"))
    - (deny network*)
    - (allow network-outbound (remote ip "localhost:*"))
    - (allow network-outbound (literal "/private/var/run/mDNSResponder"))
    - (allow network-outbound (remote unix-socket))
  domains:
    - "api.anthropic.com"
    - "*.anthropic.com"
    - "platform.claude.com"
    - "chatgpt.com"
    - "api.openai.com"
---
