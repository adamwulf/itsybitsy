/**
 * Quote- and heredoc-aware shell-metacharacter scanner.
 *
 * Moved verbatim from intercept-task.ts (its coordinator Bash gate) so the agy
 * PreToolUse handler can reuse the exact same single-command rule. Behaviour is
 * unchanged — the full enumeration of what is blocked and what is allowed (and
 * why each) lives in SPEC §12.2.4.
 */

/**
 * Result of parsing a heredoc delimiter WORD (everything from the first
 * non-space char after `<<`/`<<-` up to the next unquoted terminator).
 */
export type HeredocDelimiterParse =
  | {
      /** A real heredoc delimiter. */
      kind: "delim";
      /** The quote-removed delimiter (e.g. `E'O'F` → `EOF`). */
      delimiter: string;
      /** false when ANY part of the word was quoted or backslash-escaped. */
      expand: boolean;
      /** Index just past the delimiter word. */
      end: number;
    }
  /** Not a heredoc: `<<<` here-string, `<<` at a terminator/EOF (empty word),
   * or an unterminated quote inside the word. Callers treat this as `< redirect`. */
  | { kind: "redirect" };

/**
 * Parse a heredoc delimiter WORD starting at `start`. The shell quote-removes
 * the WHOLE word — `<<E'O'F`, `<<'E'OF`, and `<<E\OF` all mean delimiter `EOF`
 * — so we read every adjacent part (bare chars, `'…'`, `"…"` with backslash
 * handling, and `\<char>` escapes) until an UNQUOTED terminator (whitespace,
 * `;`, `|`, `&`, `<`, `>`, or end of input) and concatenate them. Expansion is
 * off if any part was quoted or backslash-escaped. A previous version read only
 * the first part, so the body ran past the shell's real terminator and the
 * commands the shell actually executes were swallowed as body — bypassing the
 * single-command rule, path isolation, and the ib-relationship check at once.
 */
export function parseHeredocDelimiterWord(command: string, start: number): HeredocDelimiterParse {
  const n = command.length;
  let k = start;
  let delim = "";
  let expand = true;
  while (k < n) {
    const ch = command[k]!;
    // Unquoted terminators end the word.
    if (
      ch === " " || ch === "\t" || ch === "\n" || ch === "\r" ||
      ch === ";" || ch === "|" || ch === "&" || ch === "<" || ch === ">"
    ) {
      break;
    }
    if (ch === "'") {
      const end = command.indexOf("'", k + 1);
      if (end === -1) return { kind: "redirect" }; // unterminated quote
      delim += command.substring(k + 1, end);
      expand = false;
      k = end + 1;
      continue;
    }
    if (ch === '"') {
      let m = k + 1;
      let buf = "";
      while (m < n && command[m] !== '"') {
        if (command[m] === "\\" && m + 1 < n) { buf += command[m + 1]; m += 2; }
        else { buf += command[m]; m++; }
      }
      if (m >= n) return { kind: "redirect" }; // unterminated quote
      delim += buf;
      expand = false;
      k = m + 1;
      continue;
    }
    if (ch === "\\") {
      if (k + 1 < n) { delim += command[k + 1]; expand = false; k += 2; continue; }
      break; // trailing backslash — end of word
    }
    delim += ch;
    k++;
  }
  // Empty word: `<<<word` here-string, `<<` at EOF/terminator — not a heredoc.
  if (delim === "") return { kind: "redirect" };
  return { kind: "delim", delimiter: delim, expand, end: k };
}

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

        // Parse the FULL delimiter word (shell quote-removes the whole word).
        const parsed = parseHeredocDelimiterWord(command, j);
        if (parsed.kind === "redirect") return "< redirect";
        j = parsed.end;

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

        heredoc = { delimiter: parsed.delimiter, expand: parsed.expand, dash };
        i = nl + 1;
        continue;
      }
      return "< redirect";
    }

    i++;
  }

  return null;
}

/**
 * Return the char-offset ranges of every heredoc BODY in `command` — the region
 * from just after the opener line's newline up to (but not including) the
 * terminator line. Openers inside single/double quotes are ignored, matching
 * the quoting rules `findShellMetachar` uses. An UNTERMINATED heredoc yields no
 * range (the body was never confirmed), so callers scan it rather than skip it
 * — the safe direction.
 *
 * Used by the path-traversal scanner to EXCLUDE heredoc bodies from
 * tokenization: those lines are data (commit messages, `ib send` bodies) that
 * legitimately contain `..` and apostrophes. The opener line and any lines
 * after the terminator are NOT part of any range and stay scanned.
 *
 * Shares the delimiter parser (`parseHeredocDelimiterWord`) with
 * `findShellMetachar` so both agree on where a heredoc body ends; the walk
 * itself is separate because the two functions collect different things.
 */
export function heredocBodyRanges(command: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  const n = command.length;
  let heredoc: { delimiter: string; dash: boolean; bodyStart: number } | null = null;

  while (i < n) {
    const c = command[i]!;

    // ---- Inside an active heredoc body ----
    if (heredoc) {
      let lineEnd = command.indexOf("\n", i);
      const hasNewline = lineEnd !== -1;
      if (!hasNewline) lineEnd = n;
      const line = command.substring(i, lineEnd);
      const leadingStripped = heredoc.dash ? line.replace(/^\t+/, "") : line;
      if (leadingStripped === heredoc.delimiter) {
        // Body spans [bodyStart, i) — up to the start of this terminator line.
        ranges.push({ start: heredoc.bodyStart, end: i });
        heredoc = null;
        i = hasNewline ? lineEnd + 1 : n;
        continue;
      }
      i = hasNewline ? lineEnd + 1 : n;
      continue;
    }

    // ---- Single-quoted: skip to the next ' ----
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return ranges;
      i = close + 1;
      continue;
    }

    // ---- Double-quoted: skip to the next unescaped " ----
    if (c === '"') {
      i++;
      while (i < n) {
        if (command[i] === "\\") { i += 2; continue; }
        if (command[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }

    // ---- Unquoted backslash escapes the next character ----
    if (c === "\\") { i += 2; continue; }

    // ---- Heredoc opener ----
    if (c === "<" && command[i + 1] === "<") {
      let j = i + 2;
      let dash = false;
      if (command[j] === "-") { dash = true; j++; }
      while (j < n && (command[j] === " " || command[j] === "\t")) j++;

      // Parse the FULL delimiter word (shared with findShellMetachar).
      const parsed = parseHeredocDelimiterWord(command, j);
      if (parsed.kind === "redirect") { i = i + 1; continue; } // not a heredoc
      j = parsed.end;

      const nl = command.indexOf("\n", j);
      if (nl === -1) { i = i + 1; continue; } // no body
      heredoc = { delimiter: parsed.delimiter, dash, bodyStart: nl + 1 };
      i = nl + 1;
      continue;
    }

    i++;
  }

  return ranges;
}
