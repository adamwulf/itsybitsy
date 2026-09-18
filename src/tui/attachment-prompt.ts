import { copyFile, mkdtemp, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join, resolve } from "node:path";
import { userHome } from "../home";
import type { DialogState } from "./dialog-handler";
import { references, spellPath, type PathReference } from "../message-attachments";

export interface CandidateAttachment {
  start: number;
  end: number;
  path: string;
  source: string;
  quote?: string;
}

export function resolveCandidatePath(path: string, baseDir?: string): string {
  if (path.startsWith("~/")) {
    return resolve(userHome(), path.slice(2));
  }
  if (path.startsWith("/")) {
    return resolve(path);
  }
  return resolve(baseDir ?? process.cwd(), path);
}

export function isTmpPath(path: string, resolvedPath?: string): boolean {
  const p = path.toLowerCase();
  if (
    p.startsWith("/tmp/") ||
    p === "/tmp" ||
    p.startsWith("/private/tmp/") ||
    p === "/private/tmp" ||
    p.startsWith("tmp/") ||
    p === "tmp" ||
    p.startsWith("./tmp/") ||
    p === "./tmp" ||
    p.startsWith("../tmp/") ||
    p === "../tmp"
  ) {
    return true;
  }
  if (resolvedPath) {
    const r = resolvedPath.toLowerCase();
    if (
      r.startsWith("/tmp/") ||
      r === "/tmp" ||
      r.startsWith("/private/tmp/") ||
      r === "/private/tmp"
    ) {
      return true;
    }
  }
  return false;
}

export async function checkCandidateFile(
  ref: PathReference,
  baseDir?: string,
): Promise<{ path: string; source: string; end: number } | null> {
  let path = ref.path;
  let end = ref.end;

  if (isTmpPath(path)) return null;

  for (;;) {
    const resolved = resolveCandidatePath(path, baseDir);
    if (isTmpPath(path, resolved)) return null;

    try {
      const info = await stat(resolved);
      if (!info.isFile()) return null;
      const realSource = await realpath(resolved);
      if (isTmpPath(realSource)) return null;
      return { path, source: realSource, end };
    } catch {
      if (!ref.quote && /[.,;:!\)\]}]$/.test(path)) {
        path = path.slice(0, -1);
        end--;
        continue;
      }
      return null;
    }
  }
}

export async function findCandidateAttachments(
  text: string,
  baseDir?: string,
): Promise<CandidateAttachment[]> {
  let refs: PathReference[];
  try {
    refs = references(text);
  } catch {
    return [];
  }

  const candidates: CandidateAttachment[] = [];
  for (const ref of refs) {
    const fileInfo = await checkCandidateFile(ref, baseDir);
    if (fileInfo) {
      candidates.push({
        start: ref.start,
        end: fileInfo.end,
        path: fileInfo.path,
        source: fileInfo.source,
        quote: ref.quote,
      });
    }
  }
  return candidates;
}

export async function stageSelectedAttachments(
  message: string,
  selectedPaths: Set<string>,
  candidates: CandidateAttachment[],
): Promise<string> {
  if (selectedPaths.size === 0) return message;

  const toStage = candidates.filter((c) => selectedPaths.has(c.path));
  if (toStage.length === 0) return message;

  const directory = await mkdtemp("/tmp/itsybitsy-attachments-");
  const destinations = new Map<string, string>();

  const sorted = [...candidates].sort((a, b) => a.start - b.start);

  let result = "";
  let cursor = 0;
  for (const file of sorted) {
    if (selectedPaths.has(file.path)) {
      let destination = destinations.get(file.source);
      if (!destination) {
        const fileDir = join(directory, String(destinations.size));
        await mkdir(fileDir);
        destination = join(fileDir, basename(file.path));
        await copyFile(file.source, destination, constants.COPYFILE_EXCL);
        destinations.set(file.source, destination);
      }
      result += message.slice(cursor, file.start) + spellPath(destination, file.quote);
      cursor = file.end;
    } else {
      result += message.slice(cursor, file.end);
      cursor = file.end;
    }
  }
  result += message.slice(cursor);
  return result;
}

export interface AttachmentPromptOptions {
  text: string;
  baseDir?: string;
  prompt?: string;
  showDialog: (dialog: NonNullable<DialogState>) => void;
  closeDialog: () => void;
  setNotice?: (text: string, kind: "info" | "error") => void;
  onConfirm: (processedText: string) => void | boolean | Promise<void | boolean>;
  onCancel?: () => void;
}

export function hasPossibleCandidates(text: string): boolean {
  try {
    const refs = references(text);
    return refs.some((r) => !isTmpPath(r.path));
  } catch {
    return false;
  }
}

export async function promptAndStageAttachmentsIfNeeded(
  opts: AttachmentPromptOptions,
): Promise<boolean> {
  const { text, baseDir, prompt, showDialog, closeDialog, setNotice, onConfirm, onCancel } = opts;

  if (!hasPossibleCandidates(text)) {
    const res = onConfirm(text);
    if (res instanceof Promise) {
      return (await res) ?? true;
    }
    return res ?? true;
  }

  let candidates: CandidateAttachment[];
  try {
    candidates = await findCandidateAttachments(text, baseDir);
  } catch {
    candidates = [];
  }

  if (candidates.length === 0) {
    const res = await onConfirm(text);
    return res ?? true;
  }

  const uniquePaths: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!seen.has(c.path)) {
      seen.add(c.path);
      uniquePaths.push(c.path);
    }
  }

  return new Promise<boolean>((resolvePromise) => {
    showDialog({
      type: "multi-select",
      prompt: prompt ?? "Copy paths to /tmp:",
      items: uniquePaths,
      checked: uniquePaths.map(() => false),
      selectedIndex: 0,
      onCancel: () => {
        closeDialog();
        onCancel?.();
        resolvePromise(false);
      },
      onSubmit: async (checkedIndices: number[]) => {
        closeDialog();
        const selectedPaths = new Set<string>();
        for (const idx of checkedIndices) {
          if (uniquePaths[idx] !== undefined) {
            selectedPaths.add(uniquePaths[idx]!);
          }
        }
        try {
          const processedText = await stageSelectedAttachments(text, selectedPaths, candidates);
          const res = await onConfirm(processedText);
          resolvePromise(res ?? true);
        } catch (err) {
          setNotice?.(
            `Failed to copy attachments: ${err instanceof Error ? err.message : String(err)}`,
            "error",
          );
          resolvePromise(false);
        }
      },
    });
  });
}
