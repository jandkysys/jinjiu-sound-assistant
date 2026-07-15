export type NameMatchDecision = "same-file" | "different-file" | "unknown-cloud-file";

export type ConflictResolution =
  | { action: "keep-cloud" }
  | { action: "save-as"; name: string };

export interface SyncConflict {
  key: string;
  localSoundId: string;
  localName: string;
  localHash: string;
  localFileSize: number;
  cloudSoundId: number;
  cloudName: string;
  cloudHash: string | null;
  cloudFileSize: number | null;
  reason: "different-file" | "unknown-cloud-file";
}

const AUDIO_EXTENSION = /\.(?:mp3|wav|wave|m4a|m4b|aac|ogg|oga|opus|flac|webm|weba|wma|aif|aiff|aifc|amr|mp4)$/i;

export function normalizeCloudHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const normalized = hash.trim().replace(/^sha-?256\s*:/i, "").toLowerCase();
  return normalized || null;
}

export function classifyNameMatch(localHash: string, cloudHash: string | null | undefined): NameMatchDecision {
  const normalizedCloud = normalizeCloudHash(cloudHash);
  if (!normalizedCloud) return "unknown-cloud-file";
  return normalizeCloudHash(localHash) === normalizedCloud ? "same-file" : "different-file";
}

export function normalizeSoundName(name: string): string {
  return name
    .trim()
    .replace(AUDIO_EXTENSION, "")
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase();
}

export function validateSaveAsName(name: string, existingNames: ReadonlySet<string>): string | null {
  const normalized = normalizeSoundName(name);
  if (!normalized) return "请输入新的音效名称";

  for (const existing of existingNames) {
    if (normalizeSoundName(existing) === normalized) return "该名称已经存在，请换一个唯一名称";
  }
  return null;
}
