import { randomBytes } from "node:crypto";
import { hasLiveWatchdog, type ResolvedCallerContext } from "../ib-commands";
import { userHome } from "../home";
import { brokerFail, SPAWN_CLIENT_TIMEOUT_MS, submitWatchdogRequest } from "../spawn-broker";
import { protectedAttachmentIdentities } from "./attachment-manifest";
import { TRANSFER_SETTING_BOUNDS } from "./transfer-limits";

const OP = "check-attachment-identities";
const ALLOWED = "allowed";

/** Only the CLI holding the validated file handles reads attachment bytes. */
export async function checkAttachmentIdentitiesViaWatchdog(caller: ResolvedCallerContext, identities: string[], signal?: AbortSignal) {
  if (typeof caller.meta.id !== "string" || !await hasLiveWatchdog(caller.agentDir)) {
    throw new Error("Sandboxed attachments need a running sender watchdog to check protected files");
  }
  const request = { v: 1, id: randomBytes(16).toString("hex"), op: OP, identities };
  const result = await submitWatchdogRequest(caller.agentDir, caller.meta.id, request, {
    request: "attachment identity check", action: "check protected attachment identities",
    alreadyStarted: "The attachment check did not finish. No message was sent.",
  }, SPAWN_CLIENT_TIMEOUT_MS, { signal });
  if (!result.ok || result.exitCode !== 0 || result.stdout !== ALLOWED) {
    throw new Error(result.stderr || "The watchdog did not allow these attachment identities");
  }
}

/** The watchdog accepts only device/inode pairs. Both roots are fixed locally. */
export async function checkProtectedAttachmentRequest(text: string, id: string) {
  const req = JSON.parse(text);
  if (!req || req.v !== 1 || req.id !== id || req.op !== OP ||
      Object.keys(req).some(key => !["v", "id", "op", "identities"].includes(key)) ||
      !Array.isArray(req.identities) || !req.identities.length || req.identities.length > TRANSFER_SETTING_BOUNDS.maxFiles[1] ||
      !req.identities.every((item: unknown) => typeof item === "string" && /^\d{1,20}:\d{1,20}$/.test(item))) {
    return brokerFail("Invalid attachment identity check");
  }
  try {
    const protectedIds = await protectedAttachmentIdentities(userHome());
    if (req.identities.some((item: string) => protectedIds.has(item))) return brokerFail("Refused protected attachment identity");
    return { ok: true, exitCode: 0, stdout: ALLOWED, stderr: "" };
  } catch {
    return brokerFail("Cannot verify the complete protected attachment trees");
  }
}
