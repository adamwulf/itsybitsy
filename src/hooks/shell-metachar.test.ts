import { test, expect, describe } from "bun:test";
import { heredocBodyRanges, findShellMetachar, parseHeredocDelimiterWord } from "./shell-metachar";

/** Substring helper: the body text covered by the returned ranges. */
function bodies(command: string): string[] {
  return heredocBodyRanges(command).map((r) => command.slice(r.start, r.end));
}

describe("heredocBodyRanges", () => {
  test("returns the body between opener newline and terminator", () => {
    const cmd = "git commit -F - <<'EOF'\nsee ../docs, it's fine\nEOF";
    expect(bodies(cmd)).toEqual(["see ../docs, it's fine\n"]);
  });

  test("no heredoc → no ranges", () => {
    expect(heredocBodyRanges("cat ../../x")).toEqual([]);
  });

  test("bare (unquoted) delimiter heredoc body is captured", () => {
    const cmd = "cat <<EOF\nbody line\nEOF\n";
    expect(bodies(cmd)).toEqual(["body line\n"]);
  });

  test("a `<<` inside single quotes is NOT treated as an opener", () => {
    expect(heredocBodyRanges("echo '<<EOF not a heredoc'")).toEqual([]);
  });

  test("unterminated heredoc yields no range (safe: caller scans it)", () => {
    expect(heredocBodyRanges("cat <<'EOF'\nbody with ../.. and no terminator")).toEqual([]);
  });

  test("multiple heredocs each get a range", () => {
    const cmd = "cat <<'A'\naaa\nA\ncat <<'B'\nbbb\nB";
    expect(bodies(cmd)).toEqual(["aaa\n", "bbb\n"]);
  });

  test("<<- strips leading tabs when matching the terminator", () => {
    const cmd = "cat <<-'EOF'\n\tbody\n\tEOF";
    expect(bodies(cmd)).toEqual(["\tbody\n"]);
  });

  test("<<-EOF (bare) strips leading tabs when matching the terminator", () => {
    const cmd = "cat <<-EOF\n\tbody\n\tEOF";
    expect(bodies(cmd)).toEqual(["\tbody\n"]);
  });

  // ── multi-part delimiter words (boundary review round 5 fix 1) ────────────

  test("<<E'O'F body terminates at EOF (full delimiter word)", () => {
    expect(bodies("cat <<E'O'F\nx\nEOF")).toEqual(["x\n"]);
  });

  test("<<'E'OF body terminates at EOF", () => {
    expect(bodies("cat <<'E'OF\nx\nEOF")).toEqual(["x\n"]);
  });

  test("<<E\\OF (backslash) body terminates at EOF", () => {
    expect(bodies("cat <<E\\OF\nx\nEOF")).toEqual(["x\n"]);
  });

  test("a body line that is the delimiter plus trailing text does not terminate", () => {
    // Line `EOFX` is not an exact match for `EOF`, so the body continues to the
    // real `EOF` line.
    expect(bodies("cat <<'EOF'\nEOFX\nEOF")).toEqual(["EOFX\n"]);
  });

  // ── arithmetic `<<` is a shift, not a heredoc (boundary review round 6) ────

  test("`<<` inside ((…)) does not open a false heredoc", () => {
    // The following command lines must NOT be masked as body.
    expect(heredocBodyRanges("((1<< y ))\ncat ../../agent-YYY/repo/.env\ny")).toEqual([]);
  });

  test("echo $((1<<2)) opens no heredoc", () => {
    expect(heredocBodyRanges("echo $((1<<2))")).toEqual([]);
  });

  test("arithmetic stops the walk, so a later heredoc body is scanned, not masked", () => {
    // The walk does not track where `((…))` ends: `(1+(2))` closes it early
    // for a paren counter, and `((cat) <<EOF` is a nested subshell. Masking
    // less is the safe direction.
    expect(bodies("echo $((1<<2))\ncat <<'EOF'\nbody\nEOF")).toEqual([]);
  });
});

describe("findShellMetachar — multi-part heredoc delimiter (round 5 fix 1)", () => {
  test("the <<E'O'F bypass payload is a metachar hit", () => {
    // Reading only the first delimiter part swallowed the executed commands as
    // body and returned null (allowed). With the full-word parse, the `EOF`
    // line terminates and the `; echo TWO | tr` after it trips the guard.
    const cmd = "cat <<E'O'F\nx\nEOF\necho ONE ; echo TWO | tr a-z A-Z";
    expect(findShellMetachar(cmd)).not.toBeNull();
  });

  test("<<'E'OF sets expansion off but still terminates at EOF (a clean body is allowed)", () => {
    expect(findShellMetachar("cat <<'E'OF\nplain body\nEOF")).toBeNull();
  });

  test("a plain quoted heredoc is still allowed", () => {
    expect(findShellMetachar("git commit -F - <<'EOF'\nmessage with ; | &\nEOF")).toBeNull();
  });

  test("findShellMetachar still reports `( subshell` for the arithmetic payload (unchanged)", () => {
    // findShellMetachar denies `(` as a subshell before it ever reaches the
    // inner `<<`, so only heredocBodyRanges needed the arithmetic fix.
    expect(findShellMetachar("((1<< y ))\ncat ../../agent-YYY/repo/.env\ny")).toBe("( subshell");
  });
});

// ── a `<<` the shell does not read as a heredoc ────────────────────────────
//
// Each form made both walkers open a heredoc the shell does not, so the next
// line was skipped as body while the shell ran it as a second command.
describe("false heredoc openers hide no second command", () => {
  const HIDDEN = ["touch pwned", "ib nuke --force", "ib notes set app x"];
  const COMMENT = "unquoted # starts a shell comment; put it in quotes";
  const DELIM = "unsupported heredoc delimiter; use a plain word such as 'EOF'";
  const DQ_BRACE = 'quote or nested expansion inside "${…}"';
  const FORMS: Array<{ name: string; reason: string; build: (hidden: string) => string }> = [
    { name: "#<<EOF comment", reason: COMMENT, build: (h) => `ib list #<<EOF\n${h}\nEOF` },
    { name: "# <<EOF comment", reason: COMMENT, build: (h) => `ib list # <<EOF\n${h}\nEOF` },
    { name: "tab before #<<EOF", reason: COMMENT, build: (h) => `ib list\t#<<EOF\n${h}\nEOF` },
    { name: "$[1<<EOF] arithmetic", reason: "$[ arithmetic", build: (h) => `ib list $[1<<EOF]\n${h}\nEOF]` },
    { name: "${X:-<<EOF}", reason: "<< inside ${…}", build: (h) => `ib list \${X:-<<EOF}\n${h}\nEOF}` },
    { name: "${X:-a <<EOF } with a space", reason: "<< inside ${…}", build: (h) => `ib list \${X:-a <<EOF }\n${h}\nEOF` },
    { name: "$'EOF' delimiter", reason: DELIM, build: (h) => `ib list <<$'EOF'\nEOF\n${h}\n$EOF` },
    { name: '$"EOF" delimiter', reason: DELIM, build: (h) => `ib list <<$"EOF"\nEOF\n${h}\n$EOF` },
    // zsh runs the backtick command in the delimiter once the heredoc ends.
    { name: "backtick delimiter", reason: DELIM, build: (h) => `ib list <<\`${h}\`\n\`${h}\`` },
    // Inside "…", quotes nest in $[…] and ${…}: the inner " does not end the
    // string for the shell, so the << after it is quoted text.
    { name: '"$["1<<EOF"]"', reason: "$[ arithmetic", build: (h) => `ib list "$["1<<EOF"]"\n${h}\nEOF]` },
    { name: '"${X:-"<<EOF"}"', reason: DQ_BRACE, build: (h) => `ib list "\${X:-"<<EOF"}"\n${h}\nEOF}` },
    { name: `"\${X:-'}'"<<EOF"}"`, reason: DQ_BRACE, build: (h) => `ib list "\${X:-'}'"<<EOF"}"\n${h}\nEOF}` },
    { name: '${X:-"${Y:-"}<<EOF"}"}', reason: DQ_BRACE, build: (h) => `ib list \${X:-"\${Y:-"}<<EOF"}"}\n${h}\nEOF}` },
  ];

  for (const form of FORMS) {
    test(`${form.name}: findShellMetachar denies it`, () => {
      for (const hidden of HIDDEN) {
        expect(findShellMetachar(form.build(hidden))).toBe(form.reason);
      }
    });

    test(`${form.name}: heredocBodyRanges masks no line`, () => {
      for (const hidden of HIDDEN) {
        expect(heredocBodyRanges(form.build(hidden))).toEqual([]);
      }
    });
  }

  test("heredocBodyRanges reads a # after an operator as a comment too", () => {
    // findShellMetachar denies the operator first; heredocBodyRanges has no
    // such deny, and a non-ib command reaches the path scanners without it.
    for (const op of [";", "&&", "||", "|", "(", ")", "<", ">"]) {
      expect(heredocBodyRanges(`true${op}#<<EOF\ncat ../../x\nEOF`)).toEqual([]);
    }
  });

  test("heredocBodyRanges stops at a line continuation glued to a character (it has no joined pass)", () => {
    // The shell joins `$` to `[1<<EOF]` / `{X:-<<EOF}`; findShellMetachar
    // catches these in its joined pass.
    for (const cmd of [
      "echo $\\\n[1<<EOF]\ncat ../../x\nEOF]",
      "echo $\\\n{X:-<<EOF}\ncat ../../x\nEOF}",
    ]) {
      expect(heredocBodyRanges(cmd)).toEqual([]);
      expect(findShellMetachar(cmd)).not.toBeNull();
    }
  });

  test("a continuation after a blank still lets a later heredoc be masked", () => {
    for (const cmd of [
      "ib send mgr \\\n<<'EOF'\nit's in ../x\nEOF",
      "gh api repos/o/r/issues \\\n  --method POST \\\n  --input - <<'EOF'\n{\"see\": \"../../x\"}\nEOF",
    ]) {
      expect(heredocBodyRanges(cmd)).toHaveLength(1);
    }
  });

  test("a continuation or open quote on the rest of the opener line is caught", () => {
    // The shell's body starts a line later, so the masked line is a command.
    const continued = "cat <<'EOF' \\\ncat ../../x\nEOF";
    expect(heredocBodyRanges(continued)).toEqual([]);
    expect(findShellMetachar(continued)).toBe("quote or backslash after a heredoc opener");
    // A quote left open there runs onto the next line, which then runs.
    const openQuote = "ib list <<'EOF' '\nx' ; touch pwned\nEOF";
    expect(heredocBodyRanges(openQuote)).toEqual([]);
    expect(findShellMetachar(openQuote)).toBe("quote or backslash after a heredoc opener");
  });

  test("heredocBodyRanges stops where it would skip a heredoc the shell may open", () => {
    // Each skipped construct is followed by what the shell reads as a real
    // heredoc whose body holds a `<<Y` decoy. Skipping the construct read that
    // body as commands, and `<<Y` then masked the line the shell runs after
    // the real terminator.
    for (const cmd of [
      "cat <<$'EOF'\n<<Y\nEOF\ncat ../../x\nY",
      "cat $${X:-<<EOF}\n<<Y\nEOF}\ncat ../../x\nY",
      "cat ${X:-{}<<EOF}\n<<Y\nEOF}\ncat ../../x\nY",
      "echo ${X:-a #'}\n} <<EOF\n'}\ncat ../../x\nEOF\n# '",
      "echo ` #` '\n<<EOF\n'\ncat ../../x\nEOF\n# '",
      "echo \"$(cat \"<<EOF\")\"\ncat ../../x\nEOF)",
      // $'\'' is one quote to the shell, not a quote then an opening one.
      "echo $'\\'' <<EOF\n'\n<<Y\nEOF\ncat ../../x\nY",
      // Arithmetic whose end a paren counter gets wrong, and a nested subshell.
      "echo $(( (1+(2)) <<3 ))\ncat ../../x\n3",
      "(( (1+(2)) <<3 ))\ncat ../../x\n3",
      "((cat) <<EOF\n))<<Y\nEOF\n)\ncat ../../x\nY",
      // Backticks and $(…) re-read quotes, `\` and `)` differently.
      "echo `echo \\\\'` <<EOF\n'\n<<Y\nEOF\ncat ../../x\nY",
      "echo `echo '` <<EOF\n'\n<<Y\nEOF\ncat ../../x\nY",
      "echo ${X:-`echo }`<<EOF}\ncat ../../x\nEOF}",
      "echo $(cat <<EOF\n)\ncat ../../x\nEOF\n)",
      "echo $(cat <<EOF\nx\nEOF)\ncat ../../x\nEOF",
      // The rest of the opener line moves where the shell's body starts.
      "cat <<A <<B\nA\n<<Y\nB\ncat ../../x\nY",
      "cat <<EOF '\nEOF\n'\n'\n<<Y\nEOF\ncat ../../x\nY\n: '",
      // A body line ending in `\` joins the next, so `x\` + `EOF` is no end.
      "cat <<EOF\nx\\\nEOF\n<<Y\nEOF\ncat ../../x\nY",
      // The shell keeps the `\` of `"E\OF"`, and reads `\r` as a word char.
      "cat <<\"E\\OF\"\nEOF\n<<Y\nE\\OF\ncat ../../x\nY",
      "cat <<EOF\r\nEOF\n<<Y\nEOF\r\ncat ../../x\nY",
    ]) {
      expect(heredocBodyRanges(cmd)).toEqual([]);
    }
  });

  test("a plain comment line is skipped; one that could open something stops the walk", () => {
    expect(bodies("# write the config\ncat > config.json <<'EOF'\nit's fine\nEOF")).toEqual(["it's fine\n"]);
    for (const comment of ["# it's", '# "x"', "# $HOME", "# a (b)", "# <<EOF", "# `x`", "# a\\", "# {x"]) {
      expect(heredocBodyRanges(`${comment}\ncat > x <<'EOF'\nbody\nEOF`)).toEqual([]);
    }
  });

  test("a body line ending in \\ under a quoted delimiter is data, still masked", () => {
    expect(bodies("cat <<'EOF'\nx\\\nEOF")).toEqual(["x\\\n"]);
  });

  test("plain double-quoted ${…} is still allowed and a later heredoc is masked", () => {
    for (const cmd of [
      'ib send x "${HOME}/notes" <<\'EOF\'\nsee ../docs\nEOF',
      'ib send x "${X:-default}" <<\'EOF\'\nsee ../docs\nEOF',
    ]) {
      expect(findShellMetachar(cmd)).toBeNull();
      expect(bodies(cmd)).toEqual(["see ../docs\n"]);
    }
  });

  test("a real heredoc after ${VAR} is still allowed and masked", () => {
    const cmd = "ib send ${ID} <<'EOF'\nmessage with ; and #\nEOF";
    expect(findShellMetachar(cmd)).toBeNull();
    expect(bodies(cmd)).toEqual(["message with ; and #\n"]);
  });

  test("a # that does not start a word is not a comment", () => {
    for (const cmd of ["ib send x a#b", "ib send x $#", "ib send x ${#X}", "ib send x '# quoted'", 'ib send x "# quoted"']) {
      expect(findShellMetachar(cmd)).toBeNull();
    }
    expect(bodies("cat a#b <<'EOF'\nbody\nEOF")).toEqual(["body\n"]);
  });

  test("a $ inside a quoted delimiter is refused too", () => {
    expect(parseHeredocDelimiterWord("'$EOF'\n", 0)).toEqual({ kind: "unsafe", reason: DELIM });
  });
});

describe("parseHeredocDelimiterWord", () => {
  test("concatenates bare + quoted parts and turns expansion off", () => {
    const r = parseHeredocDelimiterWord("E'O'F\n", 0);
    expect(r).toMatchObject({ kind: "delim", delimiter: "EOF", expand: false });
  });
  test("a bare word keeps expansion on", () => {
    const r = parseHeredocDelimiterWord("EOF\n", 0);
    expect(r).toMatchObject({ kind: "delim", delimiter: "EOF", expand: true });
  });
  test("backslash escape turns expansion off", () => {
    const r = parseHeredocDelimiterWord("E\\OF\n", 0);
    expect(r).toMatchObject({ kind: "delim", delimiter: "EOF", expand: false });
  });
  test("an unterminated quote is reported as a redirect (not a heredoc)", () => {
    expect(parseHeredocDelimiterWord("E'OF\n", 0)).toEqual({ kind: "redirect" });
  });
  test("an empty word (here-string / terminator) is a redirect", () => {
    expect(parseHeredocDelimiterWord("<word", 0)).toEqual({ kind: "redirect" });
  });
});
