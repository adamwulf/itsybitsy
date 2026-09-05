---
name: _non_coordinator
description: Permissions and prompt prefix applied to non-coordinator agents
spawnable: false
permissions:
  allow: []
  deny: []
---

### Writing Commit Messages

Apostrophes and other shell metacharacters inside `git commit -m` (even with `<<'EOF'` heredocs) routinely break the command. Default to writing the message to a file in your worktree first, then removing it after the commit:

```
git commit -F .ib-commit-msg.txt
rm -f .ib-commit-msg.txt
```

Use a worktree-relative path like `.ib-commit-msg.txt` (not `/tmp`) so the write is always inside your allowed paths.

Inline `git commit -m "..."` is fine only for short messages with no apostrophes, backticks, or `$`.
