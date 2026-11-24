import { cleanRemoteText } from "../peers/peer-link";
import { RED, RESET } from "./colors";

/** A remote agent, and the dashboard's key for it (its draft and selection key). */
export type RemotePromptTarget = { key: string; peerId: string; repo: string; id: string };

/** How often an open INITIAL PROMPT reads the shown remote agent's prompt again. */
export const REMOTE_PROMPT_REFRESH_MS = 5_000;

/**
 * Remote agents' prompts for the INITIAL PROMPT pane (SPEC §20.5). A prompt
 * is read only while that pane shows its agent, and again every
 * {@link REMOTE_PROMPT_REFRESH_MS} while it stays shown. Each read is cached
 * per agent, so returning to an agent shows its last prompt at once, and a
 * failed read keeps it. `show` receives the lines for `key`; the dashboard
 * drops them when that agent is no longer selected.
 */
export class RemotePrompt {
  private readonly cache = new Map<string, string[]>();
  private readonly inFlight = new Set<string>();
  private selectedKey: string | null = null;
  private cancel: (() => void) | null = null;

  constructor(
    private fetch: (peerId: string, repo: string, id: string) => Promise<string>,
    private show: (key: string, lines: string[]) => void,
    private every = (ms: number, tick: () => void) => {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    },
  ) {}

  /** The agent whose prompt the pane shows now, or null when it shows none. */
  select(target: RemotePromptTarget | null): void {
    const key = target?.key ?? null;
    if (key === this.selectedKey) return;
    this.cancel?.();
    this.cancel = null;
    this.selectedKey = key;
    if (target === null) return;
    const cached = this.cache.get(target.key);
    if (cached) this.show(target.key, cached);
    const tick = () => void this.read(target);
    this.cancel = this.every(REMOTE_PROMPT_REFRESH_MS, tick);
    tick();
  }

  private async read(target: RemotePromptTarget): Promise<void> {
    const { key } = target;
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    let lines: string[];
    try {
      const prompt = await this.fetch(target.peerId, target.repo, target.id);
      const cached = this.cache.get(key);
      if (cached?.join("\n") === prompt) return;
      lines = prompt.split("\n");
      this.cache.set(key, lines);
    } catch (err) {
      if (this.cache.has(key)) return;
      lines = [`${RED}${cleanRemoteText(err instanceof Error ? err.message : String(err)) || "Prompt read failed"}${RESET}`];
    } finally {
      this.inFlight.delete(key);
    }
    this.show(key, lines);
  }
}
