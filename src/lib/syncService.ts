/**
 * syncService.ts — 一键同步：将本地主播音效/背景音乐同步到云端
 *
 * 流程：
 *  1. 读取云端 categories + sounds
 *  2. 计算差异（新增 / 分类移动 / 元数据更新 / 跳过）
 *  3. 创建缺失分类
 *  4. 上传新音效文件（upload-file）
 *  5. 更新元数据（PATCH）
 *  6. 发布新版本
 */

import { getApiBase } from "@/lib/apiConfig";
import { adminAuthHeader } from "@/lib/auth";
import { getAudioBlob } from "./audioStore";
import { prepareCloudUpload, sha256Hex } from "./audioUploadPolicy";
import {
  classifyNameMatch,
  normalizeSoundName,
  validateSaveAsName,
  type ConflictResolution,
  type SyncConflict,
} from "./syncConflicts";
import type { SoundItem } from "./soundPack";

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface SyncProgressUpdate {
  phase: "running" | "done" | "error";
  step: string;
  detail?: string;
  progress?: { current: number; total: number };
}

export interface SyncStats {
  added: number;
  updated: number;
  categoryMoved: number;
  skipped: number;
  failed: number;
  errors: Array<{ name: string; error: string }>;
}

export interface CloudCat {
  id: number;
  name: string;
  appScope: string;
  level: number;
  parentId: number | null;
  isSystem: boolean;
  isEnabled: boolean;
  sortOrder: number;
}

export interface CloudSound {
  id: number;
  name: string;
  categoryId: number | null;
  appScope: string;
  platform: string;
  fileUrl: string;
  hash: string | null;
  fileSize: number | null;
  defaultVolume: number;
  loop: boolean;
  shortcut: string | null;
  sortOrder: number;
  isEnabled: boolean;
  deletedAt: string | null;
}

export interface PreparedLocalSound {
  sound: SoundItem;
  effectiveName: string;
  blob: Blob | null;
  hash: string | null;
  detectedFileSize: number | null;
  cloudMatchId: number | null;
  matchKind: "new" | "same-file" | "conflict";
  conflictKey?: string;
}

export interface PreparedSync {
  local: PreparedLocalSound[];
  mainCats: string[];
  bgCats: string[];
  cloudCats: CloudCat[];
  cloudSounds: CloudSound[];
  conflicts: SyncConflict[];
  preflightErrors: Array<{ name: string; error: string }>;
}

// ── Fetch 工具（兼容 Electron + Web）───────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _eAPI = (): any =>
  typeof window !== "undefined" ? (window as any).electronAPI : undefined;

async function cloudFetch(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = adminAuthHeader();
  if (!headers) throw new Error("无管理员 token，请重新登录");

  const eAPI = _eAPI();

  if (opts.body instanceof FormData && eAPI?.apiUploadFile) {
    const fd = opts.body;
    const fileField = fd.get("file") as File | null;
    if (!fileField) throw new Error("无文件字段");

    const base64Data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("文件读取失败"));
      reader.readAsDataURL(fileField);
    });

    const extraFields: Record<string, string> = {};
    for (const [k, v] of fd.entries()) {
      if (k !== "file" && typeof v === "string") extraFields[k] = v;
    }

    const result = await eAPI.apiUploadFile(path, {
      fieldName: "file",
      base64Data,
      filename: fileField.name,
      contentType: fileField.type || "audio/mpeg",
      extraFields,
      headers,
    });
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.data as unknown,
      text: async () => (typeof result.data === "string" ? result.data : JSON.stringify(result.data)),
    } as unknown as Response;
  }

  if (!(opts.body instanceof FormData) && eAPI?.apiFetch) {
    const combinedHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
      ...((opts.headers as Record<string, string> | undefined) ?? {}),
    };
    const result = await eAPI.apiFetch(path, {
      method: (opts.method ?? "GET") as string,
      headers: combinedHeaders,
      body: (opts.body as string | null) ?? null,
    });
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.data as unknown,
      text: async () => (typeof result.data === "string" ? result.data : JSON.stringify(result.data)),
    } as unknown as Response;
  }

  const base = getApiBase();
  const fetchHeaders =
    opts.body instanceof FormData
      ? { ...headers }
      : { ...headers, ...((opts.headers as Record<string, string> | undefined) ?? {}) };
  return fetch(`${base}${path}`, { ...opts, headers: fetchHeaders });
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await cloudFetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

function displayNameWithoutAudioExtension(name: string): string {
  return name.trim().replace(/\.(?:mp3|wav|wave|m4a|m4b|aac|ogg|oga|opus|flac|webm|weba|wma|aif|aiff|aifc|amr|mp4)$/i, "").trim();
}

// ── 两阶段同步 ─────────────────────────────────────────────────────────────────

export async function prepareFullSync(
  sounds: SoundItem[],
  mainCats: string[],
  bgCats: string[],
  onProgress: (p: SyncProgressUpdate) => void,
): Promise<PreparedSync> {
  onProgress({ phase: "running", step: "正在读取云端数据…" });
  const [cloudCats, cloudSoundsRaw] = await Promise.all([
    apiFetch<CloudCat[]>("/api/cloud/admin/categories"),
    apiFetch<CloudSound[]>("/api/cloud/admin/sounds?appScope=sound_assistant"),
  ]);
  const cloudSounds = cloudSoundsRaw.filter(sound => !sound.deletedAt);
  const cloudSoundByNormName = new Map<string, CloudSound[]>();
  for (const cloud of cloudSounds) {
    const key = normalizeSoundName(cloud.name);
    cloudSoundByNormName.set(key, [...(cloudSoundByNormName.get(key) ?? []), cloud]);
  }

  const localSounds = sounds.filter(sound => !sound.mine);
  const local: PreparedLocalSound[] = [];
  const conflicts: SyncConflict[] = [];
  const preflightErrors: Array<{ name: string; error: string }> = [];

  for (let index = 0; index < localSounds.length; index++) {
    const sound = localSounds[index]!;
    onProgress({
      phase: "running",
      step: "正在检查本地音效…",
      detail: sound.name,
      progress: { current: index + 1, total: localSounds.length },
    });
    let blob: Blob | null = null;
    let hash: string | null = null;
    let cloudMatchId: number | null = null;
    let matchKind: PreparedLocalSound["matchKind"] = "new";
    let conflictKey: string | undefined;

    try {
      blob = await getAudioBlob(sound.id);
      if (!blob) throw new Error("本地音频文件不存在（可能是示例音效）");
      await prepareCloudUpload(blob, sound.name, sound.name);
      hash = await sha256Hex(blob);
      const candidates = cloudSoundByNormName.get(normalizeSoundName(sound.name)) ?? [];
      const sameFile = candidates.find(candidate => classifyNameMatch(hash!, candidate.hash) === "same-file");

      if (sameFile) {
        cloudMatchId = sameFile.id;
        matchKind = "same-file";
      } else if (candidates[0]) {
        const cloud = candidates[0];
        const decision = classifyNameMatch(hash, cloud.hash);
        conflictKey = `${sound.id}:${cloud.id}`;
        cloudMatchId = cloud.id;
        matchKind = "conflict";
        conflicts.push({
          key: conflictKey,
          localSoundId: sound.id,
          localName: sound.name,
          localHash: hash,
          localFileSize: blob.size,
          cloudSoundId: cloud.id,
          cloudName: cloud.name,
          cloudHash: cloud.hash,
          cloudFileSize: cloud.fileSize,
          reason: decision === "different-file" ? "different-file" : "unknown-cloud-file",
        });
      }
    } catch (error) {
      preflightErrors.push({ name: sound.name, error: error instanceof Error ? error.message : String(error) });
    }

    local.push({
      sound,
      effectiveName: sound.name,
      blob,
      hash,
      detectedFileSize: blob?.size ?? null,
      cloudMatchId,
      matchKind,
      conflictKey,
    });
  }

  return { local, mainCats, bgCats, cloudCats, cloudSounds, conflicts, preflightErrors };
}

export async function executePreparedSync(
  prepared: PreparedSync,
  resolutions: Record<string, ConflictResolution>,
  onProgress: (p: SyncProgressUpdate) => void,
): Promise<SyncStats> {
  const effectiveNames = new Map<string, string>();
  const keepCloud = new Set<string>();
  const conflictIds = new Set(prepared.conflicts.map(conflict => conflict.localSoundId));
  const reservedNames = new Set<string>(prepared.cloudSounds.map(sound => sound.name));
  for (const item of prepared.local) {
    if (!conflictIds.has(item.sound.id)) reservedNames.add(item.sound.name);
  }

  for (const conflict of prepared.conflicts) {
    const resolution = resolutions[conflict.key];
    if (!resolution) throw new Error(`音效「${conflict.localName}」尚未选择冲突处理方式`);
    if (resolution.action === "keep-cloud") {
      keepCloud.add(conflict.localSoundId);
      continue;
    }
    if (resolution.action !== "save-as") throw new Error("不支持的冲突处理方式");
    const error = validateSaveAsName(resolution.name, reservedNames);
    if (error) throw new Error(`音效「${conflict.localName}」另存名称无效：${error}`);
    const displayName = displayNameWithoutAudioExtension(resolution.name);
    effectiveNames.set(conflict.localSoundId, displayName);
    reservedNames.add(displayName);
  }

  const stats: SyncStats = {
    added: 0,
    updated: 0,
    categoryMoved: 0,
    skipped: 0,
    failed: prepared.preflightErrors.length,
    errors: [...prepared.preflightErrors],
  };

  onProgress({ phase: "running", step: "正在同步分类…" });
  const catIdByName = new Map<string, number>();
  const subCatIdByKey = new Map<string, number>();
  for (const category of prepared.cloudCats) {
    if (category.level === 1) catIdByName.set(category.name.trim(), category.id);
  }
  for (const category of prepared.cloudCats) {
    if (category.level === 2 && category.parentId != null) {
      subCatIdByKey.set(`${category.parentId}:${category.name.trim()}`, category.id);
    }
  }

  const allL1Names = new Set([...prepared.mainCats, ...prepared.bgCats].map(name => name.trim()).filter(Boolean));
  const subCatsByL1 = new Map<string, Set<string>>();
  for (const item of prepared.local) {
    if (keepCloud.has(item.sound.id)) continue;
    const l1 = item.sound.category?.trim();
    if (!l1) continue;
    allL1Names.add(l1);
    const l2 = item.sound.subCategory?.trim();
    if (l2) subCatsByL1.set(l1, new Set([...(subCatsByL1.get(l1) ?? []), l2]));
  }

  for (const l1 of allL1Names) {
    if (catIdByName.has(l1)) continue;
    try {
      const created = await apiFetch<CloudCat>("/api/cloud/admin/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: l1, appScope: "sound_assistant", level: 1, platform: "both" }),
      });
      catIdByName.set(l1, created.id);
    } catch (error) {
      stats.errors.push({ name: `分类: ${l1}`, error: error instanceof Error ? error.message : String(error) });
      stats.failed++;
    }
  }

  for (const [l1, l2Names] of subCatsByL1) {
    const l1Id = catIdByName.get(l1);
    if (!l1Id) continue;
    for (const l2 of l2Names) {
      const key = `${l1Id}:${l2}`;
      if (subCatIdByKey.has(key)) continue;
      try {
        const created = await apiFetch<CloudCat>("/api/cloud/admin/categories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: l2, appScope: "sound_assistant", level: 2, parentId: l1Id, platform: "both" }),
        });
        subCatIdByKey.set(key, created.id);
      } catch (error) {
        stats.errors.push({ name: `子分类: ${l1}/${l2}`, error: error instanceof Error ? error.message : String(error) });
        stats.failed++;
      }
    }
  }

  const cloudById = new Map(prepared.cloudSounds.map(sound => [sound.id, sound]));
  const resolveCategoryId = (sound: SoundItem): number | null => {
    const l1 = sound.category?.trim();
    if (!l1) return null;
    const l1Id = catIdByName.get(l1);
    if (!l1Id) return null;
    const l2 = sound.subCategory?.trim();
    return l2 ? subCatIdByKey.get(`${l1Id}:${l2}`) ?? l1Id : l1Id;
  };

  const validItems = prepared.local.filter(item => item.blob && item.hash);
  for (let index = 0; index < validItems.length; index++) {
    const item = validItems[index]!;
    const sound = item.sound;
    if (keepCloud.has(sound.id)) {
      stats.skipped++;
      continue;
    }
    const effectiveName = effectiveNames.get(sound.id) ?? item.effectiveName;
    const categoryId = resolveCategoryId(sound);
    onProgress({
      phase: "running",
      step: item.matchKind === "same-file" ? "正在更新音效信息…" : "正在上传新音效…",
      detail: effectiveName,
      progress: { current: index + 1, total: validItems.length },
    });

    try {
      if (item.matchKind === "same-file" && item.cloudMatchId != null) {
        const cloud = cloudById.get(item.cloudMatchId);
        if (!cloud) throw new Error("云端音效记录已不存在，请重新预检");
        const changes: Record<string, unknown> = {};
        if (cloud.categoryId !== categoryId) changes.categoryId = categoryId;
        if ((cloud.shortcut ?? null) !== (sound.shortcut ?? null)) changes.shortcut = sound.shortcut ?? null;
        if (cloud.loop !== sound.loop) changes.loop = sound.loop;
        const sortOrder = (sound as SoundItem & { sortOrder?: number }).sortOrder ?? 0;
        if (cloud.sortOrder !== sortOrder) changes.sortOrder = sortOrder;
        if (Object.keys(changes).length === 0) {
          stats.skipped++;
          continue;
        }
        await apiFetch(`/api/cloud/admin/sounds/${cloud.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(changes),
        });
        if (Object.hasOwn(changes, "categoryId")) stats.categoryMoved++;
        else stats.updated++;
        continue;
      }

      const upload = await prepareCloudUpload(item.blob!, effectiveName, sound.name);
      const form = new FormData();
      form.append("file", upload.blob, upload.filename);
      form.append("name", effectiveName);
      form.append("appScope", "sound_assistant");
      form.append("loop", String(sound.loop));
      if (categoryId != null) form.append("categoryId", String(categoryId));
      const response = await cloudFetch("/api/cloud/admin/sounds/upload-file", { method: "POST", body: form });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const created = await response.json() as CloudSound;
      const extras: Record<string, unknown> = {};
      if (sound.shortcut) extras.shortcut = sound.shortcut;
      const sortOrder = (sound as SoundItem & { sortOrder?: number }).sortOrder;
      if (sortOrder != null && sortOrder !== 0) extras.sortOrder = sortOrder;
      if (Object.keys(extras).length > 0) {
        await apiFetch(`/api/cloud/admin/sounds/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(extras),
        });
      }
      stats.added++;
    } catch (error) {
      stats.errors.push({ name: effectiveName, error: error instanceof Error ? error.message : String(error) });
      stats.failed++;
    }
  }

  onProgress({ phase: "running", step: "正在发布新版本…" });
  try {
    await apiFetch("/api/cloud/admin/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appScope: "sound_assistant",
        changelog: `一键同步：新增 ${stats.added} 个，移动分类 ${stats.categoryMoved} 个，更新 ${stats.updated} 个，跳过 ${stats.skipped} 个`,
      }),
    });
  } catch {
    // 发布失败不改变已经完成的文件与元数据同步结果。
  }
  return stats;
}

export async function runFullSync(
  sounds: SoundItem[],
  mainCats: string[],
  bgCats: string[],
  onProgress: (p: SyncProgressUpdate) => void,
): Promise<SyncStats> {
  const prepared = await prepareFullSync(sounds, mainCats, bgCats, onProgress);
  if (prepared.conflicts.length > 0) {
    throw new Error(`发现 ${prepared.conflicts.length} 个同名但文件不同的音效，请先处理冲突`);
  }
  return executePreparedSync(prepared, {}, onProgress);
}
