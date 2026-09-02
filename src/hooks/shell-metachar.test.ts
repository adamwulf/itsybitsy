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
