/**
 * The text of a push that failed after `ib merge` (merge.pushAfterMerge,
 * SPEC.md §3.4 step 4), shared by the merge that writes it and the dashboards
 * that show it.
 */

/**
 * One remote's entry in a push failure: `<remote>: <git error>`, with the
 * error's later lines indented two spaces, as in the push's `✗` status line.
 * Entries for several remotes are joined by newlines, so an entry starts at
 * every line that is not indented.
 */
export function pushFailureEntry(remote: string, err: string): string {
  return `${remote}: ${err.replace(/\n/g, "\n  ")}`;
}

/**
 * The sentence that ends a failed push's report. `machine` names the machine
 * that ran the merge, for a report another machine reads: `ib push` there
 * would push its own clone.
 */
export function pushRetryHint(repoName: string, machine?: string): string {
  return `Run \`ib push ${repoName}\`${machine ? ` on ${machine}` : ""} to push it.`;
}

/**
 * The push failure as the one-row `ib watch` header notice shows it: one entry
 * per remote, without git's `To <url>` and `hint:` lines, so the
 * `! [rejected] …` line is what shows. An entry with nothing else keeps its
 * full text. stdout, the lifecycle reply and the logs keep the full text.
 */
export function pushFailureNotice(pushFailure: string): string {
  const entries: string[][] = [];
  for (const line of pushFailure.split("\n")) {
    if (line.startsWith("  ") && entries.length > 0) entries.at(-1)!.push(line.trim());
    else entries.push([line]);
  }
  return entries.map(([first, ...rest]) => {
    const colon = first!.indexOf(": ");
    const remote = colon < 0 ? null : first!.slice(0, colon);
    const lines = [remote === null ? first! : first!.slice(colon + 2), ...rest];
    const kept = lines.filter(line => !line.startsWith("To ") && !line.startsWith("hint:"));
    const text = (kept.length > 0 ? kept : lines).join("\n");
    return remote === null ? text : `${remote}: ${text}`;
  }).join("\n");
}
