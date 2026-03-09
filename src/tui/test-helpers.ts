import type { DialogState } from "./dialog-handler";

/** Assert that a dialog is active and has the expected type, returning the narrowed type. */
export function assertDialog<K extends NonNullable<DialogState>['type']>(
  dialog: DialogState,
  type: K
): Extract<NonNullable<DialogState>, { type: K }> {
  if (!dialog) throw new Error('Expected dialog, got null');
  if (dialog.type !== type) throw new Error(`Expected dialog type '${type}', got '${dialog.type}'`);
  return dialog as Extract<NonNullable<DialogState>, { type: K }>;
}
