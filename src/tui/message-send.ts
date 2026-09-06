/**
 * Human-submission message send with send-time attachment staging.
 *
 * The ib watch UI stages local file references (terminal drag/drop paths) into
 * /tmp only when a HUMAN actually submits a message, so a running repository
 * agent can read a screenshot without a sandbox refresh or restart
 * (docs/SANDBOX-ROLLOUT.md "stage message attachments at send time"). Staging is
 * opt-in from the UI only: there is no CLI flag, and agent-originated sends or
 * the global @system coordinator never stage. `sendStagedMessage` is the single
 * choke point the human send paths call: it turns on `stageAttachments` and
 * forwards `attachmentBaseDir` (the selected repo, against which ./ and ../
 * resolve) to the message-delivery layer, which performs the copy and rewrite.
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
import type { IbCommandResult, TeamSendResult } from "../ib-commands";
import type { Agent } from "../agents";

// Re-export the delivery layer's TeamSendResult so the UI (agent-actions,
// dashboard) has a single import site for it.
export type { TeamSendResult };

/** Options for {@link sendStagedMessage}. Mirrors `sendMessage`'s opts plus the
 *  attachment base dir. `stageAttachments` is applied internally by this wrapper
 *  — callers never pass it, and it never reaches a CLI flag. */
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

/** Options the ib-watch team send forwards to `teamSend`. `skipRecipientIds`
 *  lets an identical-draft retry after a partial failure resend ONLY the members
 *  that have not yet accepted. */
export interface StagedTeamSendOptions {
  fromAgent?: string;
  stageAttachments?: boolean;
  skipRecipientIds?: string[];
  attachmentBaseDir?: string;
}

const forwardToSendMessage: StagedSender = (agent, message, opts) => {
  // Turn on staging and forward the caller's base dir to the delivery layer.
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
