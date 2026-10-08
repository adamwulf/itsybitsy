/**
 * Format a date as `YYYY-MM-DD HH:MM:SS` in local time: the timestamp in the
 * `[<timestamp>] <message>` lines of agent.log, whatever process writes them
 * (`logAgent`, the sandbox proxy, the denial collector). A leaf module, so the
 * small sandbox daemons can use it without loading `agent-lifecycle.ts`.
 */
export function formatLogTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}
