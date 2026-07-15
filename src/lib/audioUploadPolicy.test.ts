import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UnsafeCloudAudioError,
  detectAudioFormat,
  prepareCloudUpload,
  sha256Hex,
} from "./audioUploadPolicy.ts";

const bytes = (values: number[], type = "") => new Blob([Uint8Array.from(values)], { type });
const ascii = (value: string, type = "") => new Blob([new TextEncoder().encode(value)], { type });

test("detects formats from bytes before misleading MIME", async () => {
  const wav = bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], "audio/mpeg");
  assert.equal((await detectAudioFormat(wav, "wrong.mp3")).format, "wav");
});

test("detects legacy files that were falsely stored as mp3", async () => {
  const wma = bytes([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c], "audio/mpeg");
  assert.equal((await detectAudioFormat(wma, "legacy.mp3")).format, "wma");
  await assert.rejects(() => prepareCloudUpload(wma, "掌声", "legacy.mp3"), UnsafeCloudAudioError);
});

test("unknown bytes never become mp3", async () => {
  assert.equal((await detectAudioFormat(ascii("not audio"), "mystery.bin")).format, "unknown");
});

test("creates a canonical safe upload descriptor", async () => {
  const flac = ascii("fLaCpayload", "application/octet-stream");
  const result = await prepareCloudUpload(flac, "欢迎掌声", "bad-name.mp3");
  assert.deepEqual({ format: result.format, filename: result.filename, mime: result.mime }, {
    format: "flac",
    filename: "欢迎掌声.flac",
    mime: "audio/flac",
  });
});

test("sha256 is lowercase hexadecimal", async () => {
  assert.equal(await sha256Hex(ascii("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
