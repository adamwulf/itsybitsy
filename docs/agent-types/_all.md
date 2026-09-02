---
name: _all
description: Permissions and prompt prefix applied to every agent
spawnable: false
permissions:
  allow: []
  deny: []
paths:
  # Verified static bootstrap floor. Runtime AGENTDIR/WORKTREE/GITDIR/REPOAGENTS
  # roots are injected separately when an agent opts in to sandboxing.
  allowRead:
    - "/"
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
    - "~"
  allowWrite:
    - "~/.claude"
    - "~/.claude.json"
    - "~/.bun"
    - "~/.codex"
    - "~/.itsybitsy/agents"
    - "/private/tmp"
    - "/private/var/folders"
    - "/dev"
  deny:
    - "~/.ssh"
    - "~/.aws"
    - "**/.env"
sandbox:
  enabled: false
  rawAllow:
    - (allow process*)
    - (allow sysctl-read)
    - (allow file-read-metadata)
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
