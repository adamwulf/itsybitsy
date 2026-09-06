/**
 * Human-submission message send with send-time attachment staging.
 *
 * The ib watch UI stages local file references (terminal drag/drop paths) into
 * /tmp only when a HUMAN actually submits a message, so a running repository
 * agent can read a screenshot without a sandbox refresh or restart
 * (docs/SANDBOX-ROLLOUT.md "stage message attachments at send time"). Staging is
 * opt-in from the UI only: there is no CLI flag, and agent-originated sends or
 * the global @system coordinator never stage. `sendStagedMessage` is the single
 * choke point the human send paths call.
 *
 * The staging itself lives inside `sendMessage` (owned by the delivery-integration
 * change): this wrapper only flips the `stageAttachments` opt on and forwards the
 * caller's `attachmentBaseDir` (the selected repo, against which ./ and ../
 * resolve). The `sendMessage` opts type gains those two fields in that change; we
 * forward them as forward-compatible options — a named options object is
 * structurally accepted by the current signature and read by `sendMessage` the
 * moment that change lands, so there is no cast and nothing to unwind on rebase.
 *
 * Contract honored by callers:
 *  - staging happens ONLY on invocation (cancel before Send copies nothing);
 *  - ok:false  → nothing was accepted; the caller MUST keep the editable draft
 *    so the user can correct a bad path and resubmit;
 *  - ok:true   → the message was accepted for delivery (even if later delivery
 *    has trouble); the caller may clear/close. An accepted message is never
 *    resent, so retries cannot duplicate an accepted send.
 */

import { sendMessage } from "../ib-commands";
import type { IbCommandResult } from "../ib-commands";
import type { Agent } from "../agents";

/** Options accepted by {@link sendStagedMessage}. Mirrors `sendMessage`'s opts
 *  plus the send-time attachment base dir. `stageAttachments` is applied
 *  internally by this wrapper — callers never pass it, and it never reaches a
 *  CLI flag. */
export interface StagedSendOptions {
  fromAgent?: string;
  cwd?: string;
  raw?: boolean;
  outboxDir?: string;
  team?: string;
  /** Base dir for resolving ./ and ../ attachment references; the selected repo. */
  attachmentBaseDir?: string;
}

export type StagedSender = (
  agent: Agent,
  message: string,
  opts?: StagedSendOptions,
) => Promise<IbCommandResult>;

/**
 * Extra options the ib-watch team send forwards to `teamSend`. The staging and
 * skip/accept bookkeeping are owned by the delivery-integration change
 * (agent-c7af53ef); these fields are declared here so the UI compiles today and
 * passes them as forward-compatible options — read by `teamSend` the moment its
 * signature lands. `skipRecipientIds` lets an identical-draft retry after a
 * partial failure resend ONLY the members that have not yet accepted.
 */
export interface StagedTeamSendOptions {
  fromAgent?: string;
  stageAttachments?: boolean;
  skipRecipientIds?: string[];
  attachmentBaseDir?: string;
}

/**
 * Result of a team send. `acceptedRecipientIds` (populated by the
 * delivery-integration change) names the members that accepted THIS call; the UI
 * accumulates them across retries and feeds them back as `skipRecipientIds` so an
 * accepted member is never resent. Optional so the current `teamSend` result
 * (which omits it) remains assignable until that change lands.
 */
export type TeamSendResult = IbCommandResult & { acceptedRecipientIds?: string[] };

const forwardToSendMessage: StagedSender = (agent, message, opts) => {
  // `sendMessage` gains `stageAttachments`/`attachmentBaseDir` in the
  // delivery-integration change (agent-c7af53ef). Build them as a named
  // options object: it is structurally accepted by the current signature and
  // read by `sendMessage` the moment that change lands — no cast, nothing to
  // unwind on rebase. Until then the flag is simply inert.
  const forwardOpts: StagedSendOptions & { stageAttachments: boolean } = {
    ...opts,
    stageAttachments: true,
  };
  return sendMessage(agent, message, forwardOpts);
};

let activeSender: StagedSender = forwardToSendMessage;

/** Test seam: replace the underlying staged sender (see message-send.test.ts). */
export function setStagedSenderForTests(sender: StagedSender): void {
  activeSender = sender;
}

/** Restore the production staged sender. */
export function resetStagedSenderForTests(): void {
  activeSender = forwardToSendMessage;
}

/**
 * Send a HUMAN-composed message with send-time attachment staging enabled.
 * Returns the delivery result; callers gate draft clearing on `result.ok`.
 */
export function sendStagedMessage(
  agent: Agent,
  message: string,
  opts?: StagedSendOptions,
): Promise<IbCommandResult> {
  return activeSender(agent, message, opts);
}
