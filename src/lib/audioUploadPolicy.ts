export type AudioFormat =
  | "mp3"
  | "wav"
  | "m4a"
  | "aac"
  | "ogg"
  | "flac"
  | "opus"
  | "webm"
  | "wma"
  | "aiff"
  | "amr"
  | "mp4"
  | "unknown";

export interface DetectedAudio {
  format: AudioFormat;
  ext: string;
  mime: string;
  cloudSafe: boolean;
  source: "magic" | "extension" | "mime" | "unknown";
}

export interface CloudUploadDescriptor extends DetectedAudio {
  blob: Blob;
  filename: string;
}

type FormatInfo = Pick<DetectedAudio, "format" | "ext" | "mime" | "cloudSafe">;

const FORMAT_INFO: Record<AudioFormat, FormatInfo> = {
  mp3: { format: "mp3", ext: "mp3", mime: "audio/mpeg", cloudSafe: true },
  wav: { format: "wav", ext: "wav", mime: "audio/wav", cloudSafe: true },
  m4a: { format: "m4a", ext: "m4a", mime: "audio/mp4", cloudSafe: true },
  aac: { format: "aac", ext: "aac", mime: "audio/aac", cloudSafe: true },
  ogg: { format: "ogg", ext: "ogg", mime: "audio/ogg", cloudSafe: true },
  flac: { format: "flac", ext: "flac", mime: "audio/flac", cloudSafe: true },
  opus: { format: "opus", ext: "opus", mime: "audio/opus", cloudSafe: true },
  webm: { format: "webm", ext: "webm", mime: "audio/webm", cloudSafe: true },
  wma: { format: "wma", ext: "wma", mime: "audio/x-ms-wma", cloudSafe: false },
  aiff: { format: "aiff", ext: "aiff", mime: "audio/aiff", cloudSafe: false },
  amr: { format: "amr", ext: "amr", mime: "audio/amr", cloudSafe: false },
  mp4: { format: "mp4", ext: "mp4", mime: "video/mp4", cloudSafe: false },
  unknown: { format: "unknown", ext: "bin", mime: "application/octet-stream", cloudSafe: false },
};

const EXTENSION_FORMATS: Record<string, AudioFormat> = {
  mp3: "mp3",
  wav: "wav",
  wave: "wav",
  m4a: "m4a",
  m4b: "m4a",
  aac: "aac",
  ogg: "ogg",
  oga: "ogg",
  opus: "opus",
  flac: "flac",
  webm: "webm",
  weba: "webm",
  wma: "wma",
  aif: "aiff",
  aiff: "aiff",
  aifc: "aiff",
  amr: "amr",
  mp4: "mp4",
};

const MIME_FORMATS: Record<string, AudioFormat> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "webm",
  "audio/x-ms-wma": "wma",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff",
  "audio/amr": "amr",
  "video/mp4": "mp4",
};

const ASF_HEADER = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];

export class UnsafeCloudAudioError extends Error {
  readonly detected: DetectedAudio;

  constructor(detected: DetectedAudio) {
    super(`检测到 ${detected.format.toUpperCase()} 格式，当前不能安全上云，请先转换为 MP3 或 WAV`);
    this.name = "UnsafeCloudAudioError";
    this.detected = detected;
  }
}

function detected(format: AudioFormat, source: DetectedAudio["source"], ext?: string): DetectedAudio {
  const info = FORMAT_INFO[format];
  return { ...info, ext: ext ?? info.ext, source };
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function originalExtension(originalName: string): string {
  const safeName = originalName.replaceAll("\\", "/").split("/").pop() ?? "";
  const match = safeName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

function detectMagic(bytes: Uint8Array, blobType: string, ext: string): AudioFormat | null {
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (ascii(bytes, 0, 4) === "fLaC") return "flac";
  if (startsWith(bytes, ASF_HEADER)) return "wma";
  if (ascii(bytes, 0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(bytes, 8, 4))) return "aiff";
  if (ascii(bytes, 0, 5) === "#!AMR") return "amr";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "webm";

  if (ascii(bytes, 0, 4) === "OggS") {
    return ascii(bytes, 0, bytes.length).includes("OpusHead") ? "opus" : "ogg";
  }

  if (ascii(bytes, 4, 4) === "ftyp") {
    const brands = ascii(bytes, 8, Math.max(0, bytes.length - 8));
    const explicitAudioBrand = brands.includes("M4A ") || brands.includes("M4B ");
    const audioHint = ["m4a", "m4b"].includes(ext) || blobType === "audio/mp4" || blobType === "audio/x-m4a";
    if (explicitAudioBrand || (brands.includes("mp42") && audioHint)) return "m4a";
    return "mp4";
  }

  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "aac";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return "mp3";
  return null;
}

export async function detectAudioFormat(blob: Blob, originalName = ""): Promise<DetectedAudio> {
  const header = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const ext = originalExtension(originalName);
  const mime = blob.type.toLowerCase().split(";", 1)[0].trim();
  const magic = detectMagic(header, mime, ext);
  if (magic) return detected(magic, "magic", magic === "webm" && ext === "weba" ? "weba" : undefined);

  const extensionFormat = EXTENSION_FORMATS[ext];
  if (extensionFormat) {
    const canonicalExt = ext === "weba" || ext === "aif" ? ext : undefined;
    return detected(extensionFormat, "extension", canonicalExt);
  }

  const mimeFormat = MIME_FORMATS[mime];
  if (mimeFormat) return detected(mimeFormat, "mime");
  return detected("unknown", "unknown");
}

function canonicalBaseName(displayName: string): string {
  const leaf = displayName.replaceAll("\\", "/").split("/").pop()?.trim() ?? "";
  const withoutExtension = leaf.replace(/\.[a-z0-9]{1,8}$/i, "").trim();
  return withoutExtension || "audio";
}

export async function prepareCloudUpload(
  blob: Blob,
  displayName: string,
  originalName = "",
): Promise<CloudUploadDescriptor> {
  const result = await detectAudioFormat(blob, originalName);
  if (!result.cloudSafe) throw new UnsafeCloudAudioError(result);

  return {
    ...result,
    blob: blob.slice(0, blob.size, result.mime),
    filename: `${canonicalBaseName(displayName)}.${result.ext}`,
  };
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}
