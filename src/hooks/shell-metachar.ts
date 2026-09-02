/**
 * Quote- and heredoc-aware shell-metacharacter scanner.
 *
 * Moved verbatim from intercept-task.ts (its coordinator Bash gate) so the agy
 * PreToolUse handler can reuse the exact same single-command rule. Behaviour is
 * unchanged — the full enumeration of what is blocked and what is allowed (and
 * why each) lives in SPEC §12.2.4.
 */

/**
 * Walk `command` and return a description of the first shell-active
 * metacharacter found, or null if it is safe to allow as a single command
 * (SPEC §12.2.4). "Shell-active" depends on context: a `|` inside `'…'` is
 * literal data, but the same `|` unquoted chains commands.
 */
export function findShellMetachar(command: string): string | null {
  let i = 0;
  const n = command.length;

  // `dash` records whether the opener was `<<-`, which strips leading TABS
  // (not arbitrary whitespace) from body lines and the terminator.
  let heredoc: { delimiter: string; expand: boolean; dash: boolean } | null = null;

  while (i < n) {
    const c = command[i]!;

    // ---- Inside an active heredoc body ----
    //
    // Whole-line iteration is load-bearing: a char-by-char loop that
    // recomputed `line = substring(i, lineEnd)` each step would shrink
    // the candidate by one char per iteration, so a body line `xxEOF`
    // would spuriously match `EOF` after two steps.
    if (heredoc) {
      let lineEnd = command.indexOf("\n", i);
      const hasNewline = lineEnd !== -1;
      if (!hasNewline) lineEnd = n;
      const line = command.substring(i, lineEnd);

      // Exact match against the delimiter (bash semantics — even trailing
      // whitespace fails to terminate). The exact match is also load-
      // bearing for the post-terminator command-separator check below:
      // terminating eagerly on `EOF<space>` would expose the real `EOF`
      // line that follows as a spurious "second command" and reject a
      // valid heredoc.
      const leadingStripped = heredoc.dash
        ? line.replace(/^\t+/, "")
        : line;
      if (leadingStripped === heredoc.delimiter) {
        // The `\n` ending the terminator line is itself a command separator
        // in bash — reject any non-whitespace content after it. This closes
        // the bypass where a heredoc body would be followed by a second
        // command containing no scanned metachars.
        if (hasNewline) {
          const after = command.substring(lineEnd + 1);
          if (/\S/.test(after)) {
            return "newline command separator after heredoc terminator";
          }
        }
        i = n;
        heredoc = null;
        continue;
      }

      if (heredoc.expand) {
        for (let k = i; k < lineEnd; k++) {
          const d = command[k]!;
          if (d === "`") return "backtick command substitution";
          if (d === "$") {
            const next = command[k + 1];
            if (next === "(") return "$( command substitution";
            if (next === "'") return "$' ANSI-C quoting";
            // ${…} alone doesn't run code; any nested $( or ` would be
            // caught on its own character.
          }
        }
      }
      i = hasNewline ? lineEnd + 1 : n;
      continue;
    }

    // ---- Single-quoted: literally everything until the next ' ----
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      // Unterminated single quote — bash would error at parse, so the
      // tail can't execute. Treat as safely literal.
      if (close === -1) return null;
      i = close + 1;
      continue;
    }

    // ---- Double-quoted: backtick, $(, $' still dangerous; rest literal ----
    if (c === '"') {
      i++;
      while (i < n) {
        const d = command[i]!;
        if (d === "\\") {
          // Bash's rule for backslash inside "…" is narrower than this,
          // but unconditionally skipping the next char can't cause us to
          // miss a shell-active metachar — only over-block at worst.
          i += 2;
          continue;
        }
        if (d === "`") return "backtick command substitution";
        if (d === "$") {
          const next = command[i + 1];
          if (next === "(") return "$( command substitution";
          if (next === "'") return "$' ANSI-C quoting";
        }
        if (d === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // ---- Unquoted backslash escapes the next character ----
    // Also handles line-continuation `\\\n` — bash treats it as whitespace.
    if (c === "\\") {
      i += 2;
      continue;
    }

    // ---- $ forms outside quotes ----
    if (c === "$") {
      const next = command[i + 1];
      if (next === "(") return "$( command substitution";
      if (next === "'") return "$' ANSI-C quoting";
      // Bare $VAR / ${VAR} are intentionally allowed — plain parameter
      // expansion cannot run code, and prompts often contain it. Any
      // nested $( or ` is caught on its own character.
      i++;
      continue;
    }

    // ---- Backtick command substitution (unquoted) ----
    if (c === "`") return "backtick command substitution";

    // ---- Command separators / chaining ----
    if (c === ";") return "; command separator";
    if (c === "\n" || c === "\r") return "newline command separator";
    if (c === "|") return "| pipe or || chain";
    if (c === "&") return "& background or && chain";

    // ---- Subshells ----
    if (c === "(") return "( subshell";
    if (c === ")") return ") subshell";

    // ---- Redirection ----
    if (c === ">") return "> redirect";
    if (c === "<") {
      if (command[i + 1] === "<") {
        let j = i + 2;
        let dash = false;
        if (command[j] === "-") {
          dash = true;
          j++;
        }
        while (j < n && (command[j] === " " || command[j] === "\t")) j++;

        // Bash heredoc delimiter forms: 'EOF', "EOF", \EOF, or bare EOF.
        // The first three suppress $/` expansion in the body; bare does not.
        let quoted = false;
        let delim = "";
        const dc = command[j];
        if (dc === "'") {
          quoted = true;
          const end = command.indexOf("'", j + 1);
          if (end === -1) return "< redirect";
          delim = command.substring(j + 1, end);
          j = end + 1;
        } else if (dc === '"') {
          quoted = true;
          let k = j + 1;
          let buf = "";
          while (k < n && command[k] !== '"') {
            if (command[k] === "\\" && k + 1 < n) {
              buf += command[k + 1];
              k += 2;
            } else {
              buf += command[k];
              k++;
            }
          }
          if (k >= n) return "< redirect";
          delim = buf;
          j = k + 1;
        } else if (dc === "\\") {
          quoted = true;
          let k = j + 1;
          let buf = "";
          while (k < n && /[A-Za-z0-9_]/.test(command[k]!)) {
            buf += command[k];
            k++;
          }
          delim = buf;
          j = k;
        } else {
          let k = j;
          let buf = "";
          while (k < n && /[A-Za-z0-9_]/.test(command[k]!)) {
            buf += command[k];
            k++;
          }
          // Empty bare delim catches `<<<word` here-string and `<<` at
          // end-of-input; both are redirects, not heredocs.
          if (buf === "") return "< redirect";
          delim = buf;
          j = k;
        }

        // Defense-in-depth: scan the opener tail (anything between the
        // delimiter and the next newline) for hazards like ` | tee log`
        // or `&& cmd2`. Done before the body opens so we catch the
        // no-newline malformed-opener case too, rather than trusting
        // bash's own parser to refuse it.
        const nl = command.indexOf("\n", j);
        const tailEnd = nl === -1 ? n : nl;
        const tail = command.substring(j, tailEnd);
        const tailHit = findShellMetachar(tail);
        if (tailHit) return tailHit;

        // No newline → no body → opener is malformed (bash would error)
        // but inert.
        if (nl === -1) return null;

        heredoc = { delimiter: delim, expand: !quoted, dash };
        i = nl + 1;
        continue;
      }
      return "< redirect";
    }

    i++;
  }

  return null;
}
