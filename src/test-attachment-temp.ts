import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

/** Run the drag-and-drop stager unchanged, redirecting its allocation into this test's directory. */
export function useAttachmentTemp(root: string) {
  const api: { mkdtemp(prefix: string): Promise<string> } = fs;
  const allocate = api.mkdtemp;
  const spy = spyOn(api, "mkdtemp").mockImplementation(prefix => allocate(
    prefix === "/tmp/itsybitsy-attachments-" ? join(root, "itsybitsy-attachments-") : prefix,
  ));
  return () => spy.mockRestore();
}
