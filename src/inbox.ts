/**
 * ib inbox — File-based message queue for the system coordinator.
 * Messages are stored at ~/.itsybitsy/coordinator-inbox/ as .msg files.
 * See SPEC.md §12.3.4 for full specification.
 */

import { join } from "path";
import { homedir } from "os";
import { readdir, unlink, mkdir } from "fs/promises";

const DEFAULT_INBOX_DIR = join(homedir(), ".itsybitsy", "coordinator-inbox");
const MAX_MESSAGES = 100;
const FILENAME_PATTERN = /^\d+-[0-9a-f]{4}-[\w-]+\.msg$/;
const SOURCE_PATTERN = /^[\w-]+$/;

let _inboxDirOverride: string | undefined;

/** Get the inbox directory path. Allows test override via setInboxDir(). */
function getInboxDir(): string {
  return _inboxDirOverride ?? DEFAULT_INBOX_DIR;
}

/** Override the inbox directory (for testing). Pass undefined to reset. */
export function setInboxDir(dir: string | undefined): void {
  _inboxDirOverride = dir;
}

export type InboxResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Ensure the inbox directory exists. */
async function ensureInboxDir(): Promise<void> {
  await mkdir(getInboxDir(), { recursive: true });
}

/** Get sorted list of message filenames (oldest first by filename, which starts with epoch). */
async function listMessageFiles(): Promise<string[]> {
  try {
    const files = await readdir(getInboxDir());
    return files.filter((f) => FILENAME_PATTERN.test(f)).sort();
  } catch {
    return [];
  }
}

/**
 * Detect the calling agent's ID from the current working directory.
 * Returns the agent ID if CWD matches the agent worktree path pattern, otherwise undefined.
 */
export function detectAgentIdFromCwd(cwd: string): string | undefined {
  const match = cwd.match(/\/.ittybitty\/agents\/([^/]+)\/repo/);
  return match ? match[1] : undefined;
}

/**
 * Write a message to the inbox.
 * Source priority: (1) explicit source, (2) auto-detected agent ID from CWD, (3) "manual".
 */
export async function inboxWrite(
  message: string,
  options?: { source?: string; cwd?: string },
): Promise<InboxResult> {
  // Determine source
  let source = options?.source;
  if (source === undefined) {
    const detected = detectAgentIdFromCwd(options?.cwd ?? process.cwd());
    source = detected ?? "manual";
  }

  // Validate source
  if (!SOURCE_PATTERN.test(source)) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Invalid source: ${source}`,
    };
  }

  await ensureInboxDir();

  // Generate filename: <epoch_ms>-<random4hex>-<source>.msg
  const inboxDir = getInboxDir();
  const epoch = Date.now();
  const rand = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  const filename = `${epoch}-${rand}-${source}.msg`;
  const filepath = join(inboxDir, filename);

  try {
    await Bun.write(filepath, message);
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Failed to write message: ${err}`,
    };
  }

  // Enforce retention limit
  const files = await listMessageFiles();
  if (files.length > MAX_MESSAGES) {
    const toDelete = files.slice(0, files.length - MAX_MESSAGES);
    await Promise.all(toDelete.map((f) => unlink(join(inboxDir, f)).catch(() => {})));
  }

  return { ok: true, exitCode: 0, stdout: filename, stderr: "" };
}

/** List pending messages, newest first. Tab-separated: <filename>\t<source>\t<first-80-chars>. */
export async function inboxList(): Promise<InboxResult> {
  try {
    const inboxDir = getInboxDir();
    const files = await listMessageFiles();
    // Newest first = reverse of sorted (oldest first)
    const reversed = files.slice().reverse();

    const lines: string[] = [];
    for (const filename of reversed) {
      // Extract source from filename: <epoch>-<hex>-<source>.msg
      const match = filename.match(/^\d+-[0-9a-f]{4}-([\w-]+)\.msg$/);
      const source = match ? match[1] : "unknown";
      const content = await Bun.file(join(inboxDir, filename)).text();
      const preview = content.slice(0, 80).replace(/\n/g, " ");
      lines.push(`${filename}\t${source}\t${preview}`);
    }

    return { ok: true, exitCode: 0, stdout: lines.join("\n"), stderr: "" };
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Failed to list inbox: ${err}`,
    };
  }
}

/** Read the full content of a message by filename. */
export async function inboxRead(filename: string): Promise<InboxResult> {
  if (!FILENAME_PATTERN.test(filename)) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Invalid filename: ${filename}`,
    };
  }

  const filepath = join(getInboxDir(), filename);
  const file = Bun.file(filepath);
  if (!(await file.exists())) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Message not found: ${filename}`,
    };
  }

  try {
    const content = await file.text();
    return { ok: true, exitCode: 0, stdout: content, stderr: "" };
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Failed to read message: ${err}`,
    };
  }
}

/** Acknowledge (delete) a processed message. Idempotent: missing file returns success. */
export async function inboxAck(filename: string): Promise<InboxResult> {
  if (!FILENAME_PATTERN.test(filename)) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: `Invalid filename: ${filename}`,
    };
  }

  try {
    await unlink(join(getInboxDir(), filename));
  } catch (err: unknown) {
    // ENOENT is fine — idempotent
    if (err && typeof err === "object" && "code" in err && err.code !== "ENOENT") {
      return {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: `Failed to acknowledge message: ${err}`,
      };
    }
  }

  return {
    ok: true,
    exitCode: 0,
    stdout: `Acknowledged: ${filename}`,
    stderr: "",
  };
}

/** Count pending messages. */
export async function inboxCount(): Promise<InboxResult> {
  const files = await listMessageFiles();
  return {
    ok: true,
    exitCode: 0,
    stdout: String(files.length),
    stderr: "",
  };
}
