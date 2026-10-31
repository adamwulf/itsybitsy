import { describe, expect, test } from "bun:test";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { balanceLinkRows, keepAllowedLinks, linkifyMessageUrls, OSC8_CLOSE, OSC8_OPEN } from "./hyperlinks";
import { stripAnsi } from "./parse-state";
import { wordWrapLines, wrapSingleLine } from "./tui/wrap";

const URL = "message://%3C19ee2307fb8.495f7bae1095803.8846200895854284810@rice.edu%3E";
const link = (target: string, text = target) => `${OSC8_OPEN}${target}\x07${text}${OSC8_CLOSE}`;

describe("keepAllowedLinks", () => {
  // tmux -e writes links with an ST terminator and, when set, an id= param.
  const paneLink = (target: string, text: string, params = "") =>
    `\x1b]8;${params};${target}\x1b\\${text}\x1b]8;;\x1b\\`;

  test("keeps a Markdown link's target and normalizes it to BEL form", () => {
    expect(keepAllowedLinks(`  ${paneLink(URL, "Open email")} done`)).toBe(`  ${link(URL, "Open email")} done`);
  });

  test("keeps https and http targets, and drops the id= param", () => {
    expect(keepAllowedLinks(paneLink("https://a.example/x?y=1", "site", "id=abc")))
      .toBe(link("https://a.example/x?y=1", "site"));
    expect(keepAllowedLinks(paneLink("http://a.example", "site"))).toBe(link("http://a.example", "site"));
  });

  test("keeps the label but not the link for any other target", () => {
    for (const target of ["file:///Applications/Calculator.app", "x-apple.systempreferences:", "ssh://host", "javascript:alert(1)", "/tmp/a"]) {
      expect(keepAllowedLinks(paneLink(target, "friendly label"))).toBe("friendly label");
    }
  });

  test("rejects a target with whitespace or non-ASCII characters", () => {
    expect(keepAllowedLinks(paneLink("https://a.example/a b", "label"))).toBe("label");
    expect(keepAllowedLinks(paneLink("https://exämple.com", "label"))).toBe("label");
  });

  test("removes styling, including colon forms and the SO/SI shifts", () => {
    const styled = "\x1b[38;5;153mblue\x1b[39m \x1b[4:3mcurly\x1b[0m \x1b[38:2::1:2:3mrgb\x1b[m \x0eq\x0f \x1b(Bend";
    expect(keepAllowedLinks(styled)).toBe("blue curly rgb q end");
  });

  test("removes other OSC strings", () => {
    expect(keepAllowedLinks("\x1b]0;title\x07text\x1b]133;A\x1b\\")).toBe("text");
  });

  test("a styled capture gives the same text as a plain one", () => {
    const plain = "⏺ Here's the email:\n\n  Open email\n\n  trailing   ";
    const styled = `\x1b[38;5;231m⏺\x1b[39m Here's the email:\n\n  \x1b[1m${paneLink(URL, "Open email")}\x1b[0m\n\n  trailing   `;
    expect(stripAnsi(keepAllowedLinks(styled))).toBe(plain);
  });

  test("balances a link left open at a line end", () => {
    expect(keepAllowedLinks(`\x1b]8;;${URL}\x1b\\one\ntwo\x1b]8;;\x1b\\ three`))
      .toBe(`${link(URL, "one")}\n${link(URL, "two")} three`);
  });

  test("a blank line inside an open link stays blank", () => {
    expect(keepAllowedLinks(`\x1b]8;;${URL}\x1b\\one\n\ntwo\x1b]8;;\x1b\\`))
      .toBe(`${link(URL, "one")}\n\n${link(URL, "two")}`);
  });

  test("a link directly followed by another replaces it", () => {
    expect(keepAllowedLinks(`\x1b]8;;https://a.example\x1b\\a\x1b]8;;https://b.example\x1b\\b\x1b]8;;\x1b\\`))
      .toBe(`${OSC8_OPEN}https://a.example\x07a${OSC8_OPEN}https://b.example\x07b${OSC8_CLOSE}`);
  });

  test("a capture with no escapes is returned as is", () => {
    const plain = "plain text\nno escapes";
    expect(keepAllowedLinks(plain)).toBe(plain);
  });

  test("a kept link is not linked again by linkifyMessageUrls", () => {
    const kept = keepAllowedLinks(paneLink(URL, URL));
    expect(linkifyMessageUrls(kept)).toBe(kept);
  });

  test("a label wider than the pane stays linked on every row", () => {
    const label = "Open the long email thread about the marketing intro";
    const rows = wordWrapLines(keepAllowedLinks(paneLink(URL, label)), 20);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith(`${OSC8_OPEN}${URL}\x07`)).toBe(true);
      expect(row.endsWith(OSC8_CLOSE)).toBe(true);
      expect(visibleWidth(row)).toBeLessThanOrEqual(20);
    }
    expect(rows.map((row) => stripAnsi(row)).join(" ")).toBe(label);
  });
});

describe("linkifyMessageUrls", () => {
  test("links a bare URL to itself, keeping the percent-encoding and @", () => {
    expect(linkifyMessageUrls(`  ${URL}`)).toBe(`  ${link(URL)}`);
  });

  test("leaves text without a message URL untouched", () => {
    const text = "see https://example.com and /tmp/file.txt";
    expect(linkifyMessageUrls(text)).toBe(text);
  });

  test("stops at the wrappers the URL really appears in", () => {
    expect(linkifyMessageUrls(`Apple Mail: <${URL}>`)).toBe(`Apple Mail: <${link(URL)}>`);
    expect(linkifyMessageUrls(`! open '${URL}'`)).toBe(`! open '${link(URL)}'`);
    expect(linkifyMessageUrls(`\`${URL}\``)).toBe(`\`${link(URL)}\``);
    expect(linkifyMessageUrls(`│ ${URL} │`)).toBe(`│ ${link(URL)} │`);
  });

  test("keeps trailing punctuation out of the link", () => {
    expect(linkifyMessageUrls(`open ${URL}.`)).toBe(`open ${link(URL)}.`);
    expect(linkifyMessageUrls(`[Open email](${URL})`)).toBe(`[Open email](${link(URL)})`);
    expect(linkifyMessageUrls(`**${URL}**`)).toBe(`**${link(URL)}**`);
  });

  test("links every URL on every line", () => {
    const other = "message://%3Cother@rice.edu%3E";
    expect(linkifyMessageUrls(`${URL} and ${other}\n${URL}`))
      .toBe(`${link(URL)} and ${link(other)}\n${link(URL)}`);
  });

  test("keeps an existing link instead of nesting one inside it", () => {
    const existing = link(URL, `Open ${URL}`);
    expect(linkifyMessageUrls(existing)).toBe(existing);
  });

  test("ignores a scheme with no target and a longer scheme name", () => {
    expect(linkifyMessageUrls("message://")).toBe("message://");
    expect(linkifyMessageUrls("the message:// scheme")).toBe("the message:// scheme");
    expect(linkifyMessageUrls("x-message://abc")).toBe("x-message://abc");
  });

  test("display text is unchanged once the hyperlink is stripped", () => {
    const text = `before ${URL} after`;
    expect(stripAnsi(linkifyMessageUrls(text))).toBe(text);
  });
});

describe("balanceLinkRows", () => {
  test("closes and reopens a link that spans rows", () => {
    expect(balanceLinkRows([`${OSC8_OPEN}u\x07aa`, "bb", `cc${OSC8_CLOSE} dd`, "ee"])).toEqual([
      `${OSC8_OPEN}u\x07aa${OSC8_CLOSE}`,
      `${OSC8_OPEN}u\x07bb${OSC8_CLOSE}`,
      `${OSC8_OPEN}u\x07cc${OSC8_CLOSE} dd`,
      "ee",
    ]);
  });

  test("leaves rows that are already balanced alone", () => {
    const rows = [`a ${link("u", "b")} c`, "plain"];
    expect(balanceLinkRows(rows)).toEqual(rows);
  });
});

describe("wrapping linked text", () => {
  /** The URL each row links to, or null when the row has no complete link. */
  const rowTarget = (row: string) => {
    const match = row.match(/^(.*?)\x1b\]8;;([^\x07]+)\x07.*\x1b\]8;;\x07/);
    return match ? match[2] : null;
  };

  test("wrapSingleLine gives an OSC sequence no width and never splits it", () => {
    const rows = wrapSingleLine(`${link(URL)}`, 20);
    expect(rows.map((row) => stripAnsi(row)).join("")).toBe(URL);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(20);
    expect(rows[0]!.startsWith(`${OSC8_OPEN}${URL}\x07`)).toBe(true);
  });

  test("wrapSingleLine accepts the ST terminator too", () => {
    const rows = wrapSingleLine(`\x1b]8;;${URL}\x1b\\${URL}\x1b]8;;\x1b\\`, 20);
    expect(rows.map((row) => stripAnsi(row)).join("")).toBe(URL);
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(20);
  });

  test("a URL wider than the pane links to the whole URL on every row", () => {
    const rows = wordWrapLines(linkifyMessageUrls(`See ${URL} now`), 30);
    expect(rows.length).toBeGreaterThan(2);
    expect(stripAnsi(rows.join("")).replace(/ /g, "")).toBe(`See${URL}now`);
    const linked = rows.filter((row) => row.includes(OSC8_OPEN));
    expect(linked.length).toBeGreaterThan(1);
    for (const row of linked) {
      expect(rowTarget(row)).toBe(URL);
      expect(row.endsWith(OSC8_CLOSE) || row.endsWith(`${OSC8_CLOSE} now`)).toBe(true);
    }
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
  });

  test("a URL that fits stays one link on one row", () => {
    expect(wordWrapLines(linkifyMessageUrls(URL), 200)).toEqual([link(URL)]);
  });

  test("a link cut by the box clip is closed and does not reach later rows", () => {
    const rows = wordWrapLines(`│ ${link(URL)} │\nnext row of prose\n\nanother row`, 40);
    expect(rows[0]!.startsWith(`│ ${OSC8_OPEN}${URL}\x07`)).toBe(true);
    // The link ends before the border, so the border isn't clickable.
    expect(rows[0]!.endsWith(`${OSC8_CLOSE}│`)).toBe(true);
    expect(visibleWidth(rows[0]!)).toBe(40);
    expect(rows.slice(1)).toEqual(["next row of prose", "", "another row"]);
  });

  test("a box row with no link clips the same as before", () => {
    const row = `│ ${"x".repeat(100)} │`;
    expect(wordWrapLines(row, 40)).toEqual([truncateToWidth(row, 40, "│")]);
  });

  test("a link cut by the separator clip is closed and does not reach later rows", () => {
    const rows = wordWrapLines(`──── ${link(URL)} ${"─".repeat(100)}\nnext`, 30);
    expect(rows[0]!.endsWith(OSC8_CLOSE)).toBe(true);
    expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(30);
    expect(rows[1]).toBe("next");
  });

  test("a link left open on a wrapped line closes on each row and stops at that line", () => {
    const rows = wordWrapLines(`${OSC8_OPEN}${URL}\x07${"x".repeat(70)}\nnext row of prose`, 30);
    const last = rows.pop();
    expect(last).toBe("next row of prose");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.startsWith(`${OSC8_OPEN}${URL}\x07`)).toBe(true);
      expect(row.endsWith(OSC8_CLOSE)).toBe(true);
    }
  });

  test("a link in a table that fits is kept", () => {
    const table = [
      "┌────┐",
      `│ ${link("message://a", "ab")} │`,
      "└────┘",
    ].join("\n");
    expect(wordWrapLines(table, 40)).toEqual(table.split("\n"));
  });

  test("text without links wraps exactly as before", () => {
    expect(wordWrapLines("alpha beta gamma", 6)).toEqual(["alpha", "beta", "gamma"]);
  });
});
