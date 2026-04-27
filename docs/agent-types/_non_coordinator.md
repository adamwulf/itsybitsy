---
name: _non_coordinator
description: Permissions and prompt prefix applied to non-coordinator agents
spawnable: false
permissions:
  allow: []
  deny: []
---

### Writing Commit Messages

Apostrophes and other shell metacharacters inside `git commit -m` (even with `<<'EOF'` heredocs) routinely break the command. Default to a temp file:

```
Write(/tmp/commit-msg.txt, "<message>")
git commit -F /tmp/commit-msg.txt
rm -f /tmp/commit-msg.txt
```

Inline `git commit -m "..."` is fine only for short messages with no apostrophes, backticks, or `$`.
