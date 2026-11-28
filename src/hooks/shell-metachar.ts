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
   * or an unterminated quote inside the word. `findShellMetachar` denies it as
   * `< redirect`; `heredocBodyRanges` stops collecting there. */
  | { kind: "redirect" }
  /** A delimiter this parser does not model. The shell reads `<<$'EOF'` and
   * `<<$"EOF"` as delimiter `EOF`, not `$EOF`, so the body would end on a line
   * the parser reads as body; zsh runs a backtick command in a delimiter.
   * `findShellMetachar` denies it with `reason`; `heredocBodyRanges` stops
   * collecting there. */
  | { kind: "unsafe"; reason: string };

/**
 * Parse a heredoc delimiter WORD starting at `start`. The shell quote-removes
 * the WHOLE word — `<<E'O'F`, `<<'E'OF`, and `<<E\OF` all mean delimiter `EOF`
 * — so we read every adjacent part (bare chars, `'…'`, `"…"`, and `\<char>`
 * escapes) until an UNQUOTED terminator (space, tab, newline, `;`, `|`, `&`,
 * `<`, `>`, or end of input) and concatenate them. Expansion is off if any part
 * was quoted or backslash-escaped. A word with `$`, a backtick, `\r`, `(` or
 * `)` anywhere, or a backslash inside `"…"`, is returned as "unsafe" rather
 * than modelled. A previous version read only
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
    // Unquoted terminators end the word. `\r` is not one: the shell reads it
    // as a word character, and it is refused below.
    if (
      ch === " " || ch === "\t" || ch === "\n" ||
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
        // The shell keeps a backslash here unless it precedes $ ` " \ or a
        // newline, so `<<"E\OF"` ends at `E\OF`. Refused, not modelled.
        if (command[m] === "\\") return UNSAFE_DELIMITER;
        buf += command[m];
        m++;
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
  // Any `$`, backtick or `\r` in the word, quoted or not, is refused rather
  // than modelled: the shell drops the `$` of `$'…'` / `$"…"`, zsh runs a
  // backtick command in a delimiter, and no real delimiter needs any of them.
  // zsh reads `<<(cmd)` as `<` plus process substitution, so parens are
  // refused too.
  if (/[$`\r()]/.test(command.substring(start, k))) return UNSAFE_DELIMITER;
  return { kind: "delim", delimiter: delim, expand, end: k };
}

const UNSAFE_DELIMITER: HeredocDelimiterParse = {
  kind: "unsafe",
  reason: "unsupported heredoc delimiter; use a plain word such as 'EOF'",
};

/**
 * Walk `command` and return a description of the first shell-active
 * metacharacter found, or null if it is safe to allow as a single command
 * (SPEC §12.2.4). "Shell-active" depends on context: a `|` inside `'…'` is
 * literal data, but the same `|` unquoted chains commands.
 */
export function findShellMetachar(command: string): string | null {
  const hit = scanShellMetachar(command);
  if (hit) return hit;
  // A continuation can join parts of an opener inside double quotes. Scan
  // both spellings so joining cannot hide syntax visible in the original.
  const joined = command.replace(/\\\r?\n/g, "");
  return joined === command ? null : scanShellMetachar(joined);
}

/**
 * True when an unquoted `#` at `i` starts a word, which makes it a comment in
 * bash and zsh (`a#b` and `$#` are not comments): at the start of input, or
 * after a blank or an operator character. The operators matter for
 * `heredocBodyRanges`, which has no metachar deny: `true;#<<EOF` must not mask
 * the next line.
 */
function startsWord(command: string, i: number): boolean {
  if (i === 0) return true;
  return " \t\n\r;&|()<>".includes(command[i - 1]!);
}

const COMMENT_HIT = "unquoted # starts a shell comment; put it in quotes";

/**
 * For a `${` at `i` inside double quotes or an unquoted-delimiter heredoc
 * body, return the index of its `}` when the expansion is plain, or -1 when
 * any of `'`, `"`, `\`, `{`, `$`, `(` or a backtick comes before the first `}`.
 * Quotes nest inside a double-quoted `${…}`, so a `"` there does not end the
 * string, and zsh flags such as `${(e)…}` evaluate their result as code.
 * Rather than model either, only plain forms such as `"${HOME}/x"` and
 * `"${X:-default}"` are accepted.
 */
function plainDqBraceEnd(command: string, i: number): number {
  for (let k = i + 2; k < command.length; k++) {
    const ch = command[k]!;
    if (ch === "}") return k;
    if ("'\"\\{$`(".includes(ch)) return -1;
  }
  return -1;
}

const DQ_BRACE_HIT = 'quote or nested expansion inside "${…}"';

function scanShellMetachar(command: string): string | null {
  let i = 0;
  const n = command.length;

  // `dash` records whether the opener was `<<-`, which strips leading TABS
  // (not arbitrary whitespace) from body lines and the terminator.
  let heredoc: { delimiter: string; expand: boolean; dash: boolean } | null = null;
  // Nesting inside an unquoted `${…}`. Bash reads a `<<` there as word text,
  // not a heredoc opener. A bare `{` inside it is counted as nesting too.
  // A shell that does not count it closes the `${` sooner, so the count can
  // only make us deny more, never less.
  let braceDepth = 0;

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
            // A plain ${…} doesn't run code. zsh's `${(e):-${:-\$}(cmd)}`
            // builds and runs `$(cmd)` without `$(` in the text.
            if (next === "{" && plainDqBraceEnd(command, k) === -1) {
              return "nested expansion inside ${…} in a heredoc body";
            }
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
          // Quotes nest inside `$[…]` and `${…}` here, so a `"` inside them
          // does not end the string for the shell.
          if (next === "[") return "$[ arithmetic";
          if (next === "{") {
            const close = plainDqBraceEnd(command, i);
            if (close === -1) return DQ_BRACE_HIT;
            i = close + 1;
            continue;
          }
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
      // Old-style arithmetic: a `<<` inside `$[…]` is a shift, not a heredoc.
      if (next === "[") return "$[ arithmetic";
      // Bare $VAR / ${VAR} are intentionally allowed — plain parameter
      // expansion cannot run code, and prompts often contain it. Any
      // nested $( or ` is caught on its own character.
      if (next === "{") {
        braceDepth++;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (braceDepth > 0 && c === "{") { braceDepth++; i++; continue; }
    if (braceDepth > 0 && c === "}") { braceDepth--; i++; continue; }

    // ---- Comment: the shell skips the rest of the line ----
    // Denied rather than skipped: a `<<` in it would open no heredoc, so the
    // next line is a second command, and a shell with comments turned off
    // would run the text we skipped.
    if (c === "#" && startsWord(command, i)) return COMMENT_HIT;

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
        if (braceDepth > 0) return "<< inside ${…}";
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
        if (parsed.kind === "unsafe") return parsed.reason;
        j = parsed.end;

        // Defense-in-depth: scan the opener tail (anything between the
        // delimiter and the next newline) for hazards like ` | tee log`
        // or `&& cmd2`. Done before the body opens so we catch the
        // no-newline malformed-opener case too, rather than trusting
        // bash's own parser to refuse it.
        const nl = command.indexOf("\n", j);
        const tailEnd = nl === -1 ? n : nl;
        const tail = command.substring(j, tailEnd);
        // A quote left open here runs onto the next lines, and a trailing `\`
        // continues the opener, so the shell's body starts later than ours.
        // The tail scan alone treats an unterminated quote as inert.
        if (/['"\\]/.test(tail)) return "quote or backslash after a heredoc opener";
        const tailHit = scanShellMetachar(tail);
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
 * Return the char-offset range of the command's heredoc BODY — the region from
 * just after the opener line's newline up to (but not including) the
 * terminator line — or no range. Only ONE heredoc is masked: the first, and
 * only when its opener is on the first line with code (blank and plain comment
 * lines may come before it). Bash expands an alias defined on an earlier line
 * (`alias c='#'` then `c <<EOF`), which no lexer can follow. Openers inside
 * single/double quotes are ignored. An UNTERMINATED heredoc yields no range
 * (the body was never confirmed), so callers scan it rather than skip it — the
 * safe direction. So does an unquoted-delimiter body that holds `$` or a
 * backtick: the shell runs the substitutions in it, so it is not data.
 *
 * At a construct this walk does not model, it stops and returns no range.
 * Unquoted: a `(` (subshells, `$(…)`, arithmetic, process substitution), a
 * backtick, `$'`, `$[`, a `[` glued to a word (bash reads `x[…]` at a command
 * position as one subscript word, across lines), a `#` comment inside `${…}`
 * or holding any of < ' " \ ` $ ( { (a plain comment line is skipped), a `<<`
 * inside `${…}`, and a line continuation glued to a character. Inside double
 * quotes: `$(`, a backtick, `$[` or a non-plain `${…}`. At an opener: a
 * here-string, an unterminated quote or a refused delimiter (any result of
 * `parseHeredocDelimiterWord` other than "delim"), or a quote, backslash,
 * backtick, `$`, `(`, `[`, `#` or second `<<` on the rest of the opener line.
 * In an unquoted-delimiter body: a line ending in `\`. Masking less is always
 * safe. Skipping the construct is not: if the shell does open a heredoc there,
 * the walk would read its body as commands, and a `<<` in that body would open
 * a false heredoc that masks the lines the shell runs after the real
 * terminator. A Bash command that is not an `ib` command reaches the path
 * scanners without `findShellMetachar`, so this walk must be safe on its own.
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
  let heredoc: { delimiter: string; expand: boolean; dash: boolean; bodyStart: number } | null = null;
  // Nesting inside an unquoted `${…}`, counted as in `findShellMetachar`. A
  // `<<` while it is open stops the walk, so overcounting can only mask less.
  let braceDepth = 0;
  // Whether the current line has anything but blanks and a plain comment. A
  // newline after such a line stops the walk (see the doc comment: aliases).
  let lineHasCode = false;

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
        // An unquoted-delimiter body with `$` or a backtick runs code.
        if (heredoc.expand && /[$`]/.test(command.substring(heredoc.bodyStart, i))) return ranges;
        // Only the first heredoc is masked.
        ranges.push({ start: heredoc.bodyStart, end: i });
        return ranges;
      }
      // In an unquoted-delimiter body the shell joins a line ending in `\`
      // to the next, so `x\` + `EOF` is `xEOF` and does not terminate.
      if (heredoc.expand && line.endsWith("\\")) return ranges;
      i = hasNewline ? lineEnd + 1 : n;
      continue;
    }

    // ---- A newline ends the first line with code: stop there ----
    if (c === "\n") {
      if (lineHasCode) return ranges;
      i++;
      continue;
    }
    if (c !== " " && c !== "\t" && c !== "#") lineHasCode = true;

    // ---- Single-quoted: skip to the next ' ----
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return ranges;
      i = close + 1;
      continue;
    }

    // ---- Double-quoted: skip to the next unescaped " ----
    // Quotes nest inside `$(…)`, backticks, `$[…]` and `${…}` here, so stop at
    // any of them unless the `${…}` is plain.
    if (c === '"') {
      i++;
      while (i < n) {
        const d = command[i]!;
        if (d === "\\") { i += 2; continue; }
        if (d === "`") return ranges;
        if (d === "$") {
          const next = command[i + 1];
          if (next === "(" || next === "[") return ranges;
          if (next === "{") {
            const close = plainDqBraceEnd(command, i);
            if (close === -1) return ranges;
            i = close + 1;
            continue;
          }
        }
        if (d === '"') { i++; break; }
        i++;
      }
      continue;
    }

    // ---- Unquoted backslash escapes the next character ----
    // A line continuation glued to a character can join it to the next line's
    // (`$` to `[`, `<` to `<`), and this walk has no joined pass, so it stops
    // there. One after a blank joins nothing and is skipped like a blank:
    // long commands are often written `gh api … \` + `--input - <<'EOF'`.
    if (c === "\\") {
      const next = command[i + 1];
      const glued = i === 0 || (command[i - 1] !== " " && command[i - 1] !== "\t");
      if (next === "\r" || (next === "\n" && glued)) return ranges;
      i += 2;
      continue;
    }

    // ---- Constructs whose extent this walk does not track: stop ----
    // `(` covers `$(…)`, `$((…))`, `((…))`, `<(…)` and subshells: a `<<` in
    // arithmetic is a shift, and bash 3.2 ends `$(` at its first `)` even in a
    // heredoc body. Inside backticks the shell re-reads `\` and quotes.
    // `$'…'` treats `\'` as a quote, which the single-quote skip does not.
    // `$[…]` is old-style arithmetic. Bash reads `x[…]` at a command position
    // as one subscript word, even across lines, so a `<<` in it opens nothing.
    if (c === "(" || c === "`") return ranges;
    if (c === "$" && (command[i + 1] === "'" || command[i + 1] === "[")) return ranges;
    if (c === "[" && i > 0 && /[A-Za-z0-9_]/.test(command[i - 1]!)) return ranges;

    // ---- Parameter expansion: a `<<` inside `${…}` is word text ----
    if (c === "$" && command[i + 1] === "{") { braceDepth++; i += 2; continue; }
    if (braceDepth > 0 && c === "{") { braceDepth++; i++; continue; }
    if (braceDepth > 0 && c === "}") { braceDepth--; i++; continue; }

    // ---- Comment ----
    // Skipping the line could drop a quote the shell still sees (a `#` inside
    // `${…}` is no comment, and a shell with comments off reads the words), so
    // skip only a plain comment outside `${…}`: text with none of < ' " \ ` $
    // ( { can open no quote, expansion or heredoc either way. Otherwise stop.
    if (c === "#" && startsWord(command, i)) {
      const nl = command.indexOf("\n", i);
      const end = nl === -1 ? n : nl;
      if (braceDepth > 0 || /[<'"\\`$({]/.test(command.substring(i, end))) return ranges;
      i = end;
      continue;
    }

    // ---- Heredoc opener ----
    if (c === "<" && command[i + 1] === "<") {
      if (braceDepth > 0) return ranges;
      let j = i + 2;
      let dash = false;
      if (command[j] === "-") { dash = true; j++; }
      while (j < n && (command[j] === " " || command[j] === "\t")) j++;

      // Parse the FULL delimiter word (shared with findShellMetachar). A
      // here-string, an unterminated quote or a refused delimiter stops the
      // walk: the shell may still open a heredoc there.
      const parsed = parseHeredocDelimiterWord(command, j);
      if (parsed.kind !== "delim") return ranges;
      j = parsed.end;

      const nl = command.indexOf("\n", j);
      if (nl === -1) { i = i + 1; continue; } // no body
      // The rest of the opener line is not walked. A second `<<`, a quote
      // that runs onto later lines, or a construct from the list above there
      // would move where the shell's body starts, so stop on any of them.
      if (/<<|['"\\`$(\[#]/.test(command.substring(j, nl))) return ranges;
      heredoc = { delimiter: parsed.delimiter, expand: parsed.expand, dash, bodyStart: nl + 1 };
      i = nl + 1;
      continue;
    }

    i++;
  }

  return ranges;
}
