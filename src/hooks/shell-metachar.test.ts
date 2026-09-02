import { test, expect, describe } from "bun:test";
import { heredocBodyRanges } from "./shell-metachar";

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
});
