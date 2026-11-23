const MIB = 1024 ** 2;
export const MAX_HEADER_BYTES = 256 * 1024;
export const CHUNK_BYTES = 64 * 1024;
export const IDLE_TIMEOUT_MS = 60_000;
export const DISK_MARGIN_BYTES = 1024 * MIB;

export const DEFAULT_ATTACHMENT_SETTINGS = { maxFileMB: 1024, maxMessageMB: 2048, maxFiles: 20 } as const;
export const TRANSFER_SETTING_BOUNDS = {
  maxFileMB: [0, 65536], maxMessageMB: [0, 131072], maxFiles: [0, 100],
} as const;

type Setting = keyof typeof DEFAULT_ATTACHMENT_SETTINGS;

export function attachmentSettingKey(key: string): Setting | undefined {
  const prefix = "peering.attachments.";
  const name = key.slice(prefix.length);
  return key.startsWith(prefix) && Object.hasOwn(DEFAULT_ATTACHMENT_SETTINGS, name) ? name as Setting : undefined;
}

function validSetting(key: Setting, value: unknown): value is number {
  const [min, max] = TRANSFER_SETTING_BOUNDS[key];
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** The other field's independently valid budget for this edit. A valid raw
 * budget may become usable again when the edit repairs a cross-field conflict. */
export function attachmentCompanion(key: Setting, raw: Partial<Record<Setting, unknown>>) {
  if (key === "maxFiles") return undefined;
  const other = key === "maxFileMB" ? "maxMessageMB" : "maxFileMB";
  const stored = raw[other];
  const value = validSetting(other, stored) ? stored : DEFAULT_ATTACHMENT_SETTINGS[other];
  const hint = stored === undefined ? `${other} = ${value} (default)`
    : stored === value ? `${other} = ${value}` : `${other} = ${JSON.stringify(stored)} (using ${value})`;
  return { value, hint };
}

export function validateAttachmentSetting(key: Setting, value: unknown, raw: Partial<Record<Setting, unknown>>) {
  const [min, max] = TRANSFER_SETTING_BOUNDS[key];
  if (typeof value !== "number" || !Number.isInteger(value)) return `${key} must be an integer`;
  if (value < min || value > max) return `${key} must be between ${min} and ${max}`;
  const companion = attachmentCompanion(key, raw);
  if (value > 0 && companion && companion.value > 0) {
    if (key === "maxFileMB" && value > companion.value) return `maxFileMB must be ≤ maxMessageMB (${companion.value})`;
    if (key === "maxMessageMB" && value < companion.value) return `maxMessageMB must be ≥ maxFileMB (${companion.value})`;
  }
}

export interface TransferLimits {
  readonly maxFileBytes: number;
  readonly maxMessageBytes: number;
  readonly maxFiles: number;
}

export const DEFAULT_TRANSFER_LIMITS: TransferLimits = {
  maxFileBytes: DEFAULT_ATTACHMENT_SETTINGS.maxFileMB * MIB,
  maxMessageBytes: DEFAULT_ATTACHMENT_SETTINGS.maxMessageMB * MIB,
  maxFiles: DEFAULT_ATTACHMENT_SETTINGS.maxFiles,
};

export function resolveTransferLimits(raw: Partial<Record<Setting, unknown>>) {
  const warnings: string[] = [];
  function fallback(key: Setting, reason: string) {
    const value = DEFAULT_ATTACHMENT_SETTINGS[key];
    warnings.push(`peering.attachments.${key} ${reason}. Using ${value}.`);
    return value;
  }
  function setting(key: Setting) {
    const value = raw[key];
    if (value === undefined) return DEFAULT_ATTACHMENT_SETTINGS[key];
    const [min, max] = TRANSFER_SETTING_BOUNDS[key];
    return validSetting(key, value) ? value : fallback(key, `must be an integer from ${min} to ${max}`);
  }
  let file = setting("maxFileMB");
  let message = setting("maxMessageMB");
  const count = setting("maxFiles");
  // Zero is a switch. A disabled message budget must survive a positive file budget.
  if (message !== 0 && message < file) {
    if (message !== DEFAULT_ATTACHMENT_SETTINGS.maxMessageMB) {
      message = fallback("maxMessageMB", "must be at least maxFileMB");
    }
    if (file > message) file = fallback("maxFileMB", "exceeds the message budget");
  }
  return { limits: { maxFileBytes: file * MIB, maxMessageBytes: message * MIB, maxFiles: count }, warnings };
}

type LimitResult = { ok: true } | { ok: false; error: string };

export function attachmentSettings(limits: TransferLimits) {
  return {
    maxFileMB: limits.maxFileBytes / MIB, maxMessageMB: limits.maxMessageBytes / MIB, maxFiles: limits.maxFiles,
  };
}

export function checkAttachmentsEnabled(limits: TransferLimits, machine: string): LimitResult {
  for (const [key, value] of Object.entries(attachmentSettings(limits))) {
    if (value === 0) return { ok: false, error: `attachments are disabled on ${machine} (peering.attachments.${key} = 0)` };
  }
  return { ok: true };
}

export function checkManifestLimits(
  files: readonly { name: string; size: number }[], limits: TransferLimits, { machine }: { machine: string },
): LimitResult {
  if (!files.length) return { ok: true };
  const enabled = checkAttachmentsEnabled(limits, machine);
  if (!enabled.ok) return enabled;
  function exceeded(key: Setting, detail: string): LimitResult {
    return { ok: false, error: `${detail} exceeds the limit on ${machine} (peering.attachments.${key} = ${attachmentSettings(limits)[key]})` };
  }
  if (files.length > limits.maxFiles) return exceeded("maxFiles", `${files.length} files`);
  let total = 0;
  for (const { name, size } of files) {
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, error: `Invalid size for file ${JSON.stringify(name)}` };
    if (size > limits.maxFileBytes) return exceeded("maxFileMB", `File ${JSON.stringify(name)} at ${size} bytes`);
    total += size;
  }
  if (total > limits.maxMessageBytes) return exceeded("maxMessageMB", `Message at ${total} bytes`);
  return { ok: true };
}

export const checkIncomingFiles = checkManifestLimits;
