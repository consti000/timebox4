import {
  normalizeDayData,
  loadDayData,
  saveDayData,
  loadRecurringTodos,
  saveRecurringTodos,
  getRecurringUpdatedAt,
  setRecurringUpdatedAt,
  getDeviceId,
  addPendingPush,
  removePendingPush,
  getPendingPushKeys,
  RECURRING_PENDING_KEY,
} from './utils.js';
import {
  apiFetch,
  createAuthExpiredError,
  isAuthenticated,
  onSignOut,
} from './google-auth.js';

const FOLDER_NAME = 'TimeBox4 Planner';
const SYNC_FOLDER_NAME = 'sync';
const DAYS_FOLDER_NAME = 'days';
const MANIFEST_NAME = 'manifest.json';
const RECURRING_NAME = 'recurring.json';
const SCHEMA_VERSION = 1;
const FILE_IDS_KEY = 'timebox4_sync_file_ids';
const FOLDER_IDS_KEY = 'timebox4_sync_folder_ids';

let rootFolderId = null;
let syncFolderId = null;
let daysFolderId = null;
let cachedFileIds = loadFileIdCache();
loadFolderIdCache();

onSignOut(() => {
  rootFolderId = null;
  syncFolderId = null;
  daysFolderId = null;
});

function loadFileIdCache() {
  try {
    const raw = localStorage.getItem(FILE_IDS_KEY);
    if (!raw) return { manifest: null, recurring: null, days: {} };
    const parsed = JSON.parse(raw);
    return {
      manifest: parsed?.manifest || null,
      recurring: parsed?.recurring || null,
      days:
        parsed?.days && typeof parsed.days === 'object' ? { ...parsed.days } : {},
    };
  } catch {
    return { manifest: null, recurring: null, days: {} };
  }
}

function persistFileIdCache() {
  try {
    localStorage.setItem(FILE_IDS_KEY, JSON.stringify(cachedFileIds));
  } catch {
    // ignore
  }
}

function loadFolderIdCache() {
  try {
    const raw = localStorage.getItem(FOLDER_IDS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed?.root) rootFolderId = parsed.root;
    if (parsed?.sync) syncFolderId = parsed.sync;
    if (parsed?.days) daysFolderId = parsed.days;
  } catch {
    // ignore
  }
}

function persistFolderIdCache() {
  try {
    localStorage.setItem(
      FOLDER_IDS_KEY,
      JSON.stringify({
        root: rootFolderId,
        sync: syncFolderId,
        days: daysFolderId,
      })
    );
  } catch {
    // ignore
  }
}

function emptyManifest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: 'timebox4',
    updatedAt: new Date(0).toISOString(),
    recurringUpdatedAt: new Date(0).toISOString(),
    days: {},
  };
}

function compareUpdatedAt(a, b) {
  const ta = Date.parse(a || '') || 0;
  const tb = Date.parse(b || '') || 0;
  return ta - tb;
}

function isNotFoundError(err) {
  return /not found|404|File not found/i.test(err?.message || '');
}

async function findChildByName(parentId, name, mimeType = null) {
  let q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
  if (mimeType) {
    q += ` and mimeType='${mimeType}'`;
  }
  const list = await apiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&pageSize=5`
  );
  return list.files?.[0] || null;
}

async function ensureFolderNamed(parentId, name) {
  const existing = await findChildByName(
    parentId,
    name,
    'application/vnd.google-apps.folder'
  );
  if (existing?.id) return existing.id;

  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) body.parents = [parentId];

  const created = await apiFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return created.id;
}

async function ensureRootFolder() {
  if (rootFolderId) return rootFolderId;

  const query = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const list = await apiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`
  );
  if (list.files?.length > 0) {
    rootFolderId = list.files[0].id;
    persistFolderIdCache();
    return rootFolderId;
  }
  const created = await apiFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  rootFolderId = created.id;
  persistFolderIdCache();
  return rootFolderId;
}

/**
 * 폴더 ID는 세션·localStorage 캐시를 신뢰하고, 없을 때만 검색합니다.
 * (매 동기화마다 존재 확인 GET을 하지 않음 — 개선 5)
 */
async function ensureSyncFolders() {
  if (syncFolderId && daysFolderId) {
    return { syncFolderId, daysFolderId };
  }

  const root = await ensureRootFolder();
  if (!syncFolderId) {
    syncFolderId = await ensureFolderNamed(root, SYNC_FOLDER_NAME);
  }
  if (!daysFolderId) {
    daysFolderId = await ensureFolderNamed(syncFolderId, DAYS_FOLDER_NAME);
  }
  persistFolderIdCache();
  return { syncFolderId, daysFolderId };
}

async function downloadJson(fileId) {
  const text = await apiFetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { responseType: 'text' }
  );
  return JSON.parse(text);
}

async function uploadJsonFile({ fileId, name, parents, data }) {
  const boundary = `tb4sync_${Date.now().toString(36)}`;
  const metadata = fileId
    ? { mimeType: 'application/json' }
    : {
        name,
        mimeType: 'application/json',
        parents,
      };
  // pretty-print 제거로 업로드 바디 축소
  const json = JSON.stringify(data);
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${json}\r\n` +
    `--${boundary}--`;

  if (fileId) {
    return apiFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
  }

  return apiFetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
}

/** 캐시 fileId를 그대로 쓰고, 없을 때만 검색 (평소 verify GET 없음) */
async function resolveNamedJson(parentId, name, cacheKey) {
  const cached = cachedFileIds[cacheKey];
  if (cached) return cached;

  const found = await findChildByName(parentId, name);
  if (found?.id) {
    cachedFileIds[cacheKey] = found.id;
    persistFileIdCache();
    return found.id;
  }
  return null;
}

function clearNamedCache(cacheKey) {
  cachedFileIds[cacheKey] = null;
  persistFileIdCache();
}

function clearDayCache(dateISO) {
  delete cachedFileIds.days[dateISO];
  persistFileIdCache();
}

async function readOrCreateManifest(syncId) {
  let fileId = await resolveNamedJson(syncId, MANIFEST_NAME, 'manifest');
  if (!fileId) {
    const created = await uploadJsonFile({
      name: MANIFEST_NAME,
      parents: [syncId],
      data: emptyManifest(),
    });
    fileId = created.id;
    cachedFileIds.manifest = fileId;
    persistFileIdCache();
    return { fileId, manifest: emptyManifest() };
  }

  try {
    const manifest = await downloadJson(fileId);
    return {
      fileId,
      manifest: {
        ...emptyManifest(),
        ...manifest,
        days:
          manifest?.days && typeof manifest.days === 'object'
            ? { ...manifest.days }
            : {},
      },
    };
  } catch (err) {
    if (isNotFoundError(err)) {
      clearNamedCache('manifest');
      const created = await uploadJsonFile({
        name: MANIFEST_NAME,
        parents: [syncId],
        data: emptyManifest(),
      });
      cachedFileIds.manifest = created.id;
      persistFileIdCache();
      return { fileId: created.id, manifest: emptyManifest() };
    }
    const fresh = emptyManifest();
    await uploadJsonFile({ fileId, data: fresh });
    return { fileId, manifest: fresh };
  }
}

async function writeManifest(fileId, manifest) {
  const next = {
    ...manifest,
    schemaVersion: SCHEMA_VERSION,
    app: 'timebox4',
    updatedAt: new Date().toISOString(),
  };
  try {
    await uploadJsonFile({ fileId, data: next });
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    clearNamedCache('manifest');
    const { syncFolderId: syncId } = await ensureSyncFolders();
    const created = await uploadJsonFile({
      name: MANIFEST_NAME,
      parents: [syncId],
      data: next,
    });
    cachedFileIds.manifest = created.id;
    persistFileIdCache();
    return { fileId: created.id, manifest: next };
  }
  return { fileId, manifest: next };
}

function dayPayload(dateISO, data) {
  const normalized = normalizeDayData(data);
  return {
    schemaVersion: SCHEMA_VERSION,
    date: dateISO,
    updatedAt: normalized.updatedAt,
    deviceId: getDeviceId(),
    priorities: normalized.priorities,
    brainDump: normalized.brainDump,
    skippedRecurringIds: normalized.skippedRecurringIds,
    timeline: normalized.timeline,
    memo: normalized.memo,
  };
}

function resolveDayFileIdFromCache(dateISO, manifestEntry) {
  if (manifestEntry?.fileId) {
    cachedFileIds.days[dateISO] = manifestEntry.fileId;
    return manifestEntry.fileId;
  }
  return cachedFileIds.days[dateISO] || null;
}

/**
 * @param {{
 *   dateISO: string,
 *   localData: object,
 *   manifest: object,
 *   daysFolderId: string,
 *   mode: 'full' | 'push-prefer',
 * }} ctx
 */
async function syncDayWithContext(ctx) {
  const { dateISO, localData, manifest, daysFolderId: daysId, mode } = ctx;
  const local = normalizeDayData(localData);
  const entry = manifest.days[dateISO] || null;
  const remoteMetaAt = entry?.updatedAt || '';
  const cmpMeta = compareUpdatedAt(local.updatedAt, remoteMetaAt);

  // 개선 2: manifest 시각이 같으면 날짜 파일 다운로드 생략
  if (remoteMetaAt && cmpMeta === 0) {
    removePendingPush(dateISO);
    return { action: 'noop', conflict: false, manifestDirty: false };
  }

  // 개선 3: 로컬이 더 최신이거나 원격 메타 없음 → 다운로드 없이 push
  if (cmpMeta > 0 || !remoteMetaAt) {
    const payload = dayPayload(dateISO, local);
    let fileId = resolveDayFileIdFromCache(dateISO, entry);
    try {
      if (fileId) {
        await uploadJsonFile({ fileId, data: payload });
      } else {
        const created = await uploadJsonFile({
          name: `${dateISO}.json`,
          parents: [daysId],
          data: payload,
        });
        fileId = created.id;
        cachedFileIds.days[dateISO] = fileId;
        persistFileIdCache();
      }
    } catch (err) {
      if (!isNotFoundError(err) || !fileId) throw err;
      clearDayCache(dateISO);
      const created = await uploadJsonFile({
        name: `${dateISO}.json`,
        parents: [daysId],
        data: payload,
      });
      fileId = created.id;
      cachedFileIds.days[dateISO] = fileId;
      persistFileIdCache();
    }
    manifest.days[dateISO] = {
      updatedAt: local.updatedAt,
      fileId,
    };
    removePendingPush(dateISO);
    return {
      action: 'push',
      conflict: Boolean(remoteMetaAt && remoteMetaAt !== local.updatedAt),
      manifestDirty: true,
    };
  }

  // cmpMeta < 0: 클라우드가 더 최신 → pull (mode 무관)
  void mode;
  let fileId = resolveDayFileIdFromCache(dateISO, entry);
  if (!fileId) {
    const found = await findChildByName(daysId, `${dateISO}.json`);
    fileId = found?.id || null;
    if (fileId) {
      cachedFileIds.days[dateISO] = fileId;
      persistFileIdCache();
    }
  }

  if (!fileId) {
    // 메타만 있고 파일 없음 → 로컬 push로 복구
    const payload = dayPayload(dateISO, local);
    const created = await uploadJsonFile({
      name: `${dateISO}.json`,
      parents: [daysId],
      data: payload,
    });
    cachedFileIds.days[dateISO] = created.id;
    persistFileIdCache();
    manifest.days[dateISO] = {
      updatedAt: local.updatedAt,
      fileId: created.id,
    };
    removePendingPush(dateISO);
    return { action: 'push', conflict: false, manifestDirty: true };
  }

  let remote;
  try {
    remote = await downloadJson(fileId);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    clearDayCache(dateISO);
    const payload = dayPayload(dateISO, local);
    const created = await uploadJsonFile({
      name: `${dateISO}.json`,
      parents: [daysId],
      data: payload,
    });
    cachedFileIds.days[dateISO] = created.id;
    persistFileIdCache();
    manifest.days[dateISO] = {
      updatedAt: local.updatedAt,
      fileId: created.id,
    };
    removePendingPush(dateISO);
    return { action: 'push', conflict: false, manifestDirty: true };
  }

  const remoteAt = remote?.updatedAt || remoteMetaAt;
  const cmp = compareUpdatedAt(local.updatedAt, remoteAt);

  if (cmp > 0) {
    const payload = dayPayload(dateISO, local);
    await uploadJsonFile({ fileId, data: payload });
    manifest.days[dateISO] = {
      updatedAt: local.updatedAt,
      fileId,
    };
    removePendingPush(dateISO);
    return { action: 'push', conflict: true, manifestDirty: true };
  }

  if (cmp < 0) {
    const pulled = normalizeDayData(remote);
    pulled.updatedAt = remoteAt;
    saveDayData(dateISO, pulled, { touch: false });
    manifest.days[dateISO] = {
      updatedAt: remoteAt,
      fileId,
    };
    removePendingPush(dateISO);
    return {
      action: 'pull',
      conflict: Boolean(local.updatedAt && local.updatedAt !== remoteAt),
      manifestDirty: true,
      data: pulled,
    };
  }

  removePendingPush(dateISO);
  return { action: 'noop', conflict: false, manifestDirty: false };
}

async function syncRecurringWithContext({
  syncId,
  manifest,
  mode,
  forceCheck,
}) {
  const localItems = loadRecurringTodos();
  const localAt = getRecurringUpdatedAt();
  const remoteMetaAt =
    manifest.recurringUpdatedAt || new Date(0).toISOString();
  const cmpMeta = compareUpdatedAt(localAt, remoteMetaAt);
  const pending = getPendingPushKeys().includes(RECURRING_PENDING_KEY);

  // 자동(push-prefer): pending도 없고 시각도 같으면 recurring 파일 건드리지 않음
  if (
    mode === 'push-prefer' &&
    !forceCheck &&
    !pending &&
    cmpMeta === 0
  ) {
    return { action: 'noop', conflict: false, manifestDirty: false };
  }

  if (cmpMeta === 0 && remoteMetaAt && !pending) {
    removePendingPush(RECURRING_PENDING_KEY);
    return { action: 'noop', conflict: false, manifestDirty: false };
  }

  if (cmpMeta > 0 || (!remoteMetaAt && pending) || (mode === 'push-prefer' && pending && cmpMeta >= 0)) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: localAt || new Date().toISOString(),
      items: localItems,
    };
    if (!localAt) setRecurringUpdatedAt(payload.updatedAt);

    let fileId = await resolveNamedJson(syncId, RECURRING_NAME, 'recurring');
    try {
      if (fileId) {
        await uploadJsonFile({ fileId, data: payload });
      } else {
        const created = await uploadJsonFile({
          name: RECURRING_NAME,
          parents: [syncId],
          data: payload,
        });
        fileId = created.id;
        cachedFileIds.recurring = fileId;
        persistFileIdCache();
      }
    } catch (err) {
      if (!isNotFoundError(err)) throw err;
      clearNamedCache('recurring');
      const created = await uploadJsonFile({
        name: RECURRING_NAME,
        parents: [syncId],
        data: payload,
      });
      fileId = created.id;
      cachedFileIds.recurring = fileId;
      persistFileIdCache();
    }

    manifest.recurringUpdatedAt = payload.updatedAt;
    removePendingPush(RECURRING_PENDING_KEY);
    return { action: 'push', conflict: Boolean(cmpMeta > 0 && remoteMetaAt), manifestDirty: true };
  }

  // pull
  let fileId = await resolveNamedJson(syncId, RECURRING_NAME, 'recurring');
  if (!fileId) {
    removePendingPush(RECURRING_PENDING_KEY);
    return { action: 'noop', conflict: false, manifestDirty: false };
  }

  let remote;
  try {
    remote = await downloadJson(fileId);
  } catch (err) {
    if (!isNotFoundError(err)) throw err;
    clearNamedCache('recurring');
    removePendingPush(RECURRING_PENDING_KEY);
    return { action: 'noop', conflict: false, manifestDirty: false };
  }

  const remoteAt = remote?.updatedAt || remoteMetaAt;
  const cmp = compareUpdatedAt(localAt, remoteAt);
  if (cmp < 0) {
    const items = Array.isArray(remote.items) ? remote.items : [];
    saveRecurringTodos(items);
    setRecurringUpdatedAt(remoteAt);
    manifest.recurringUpdatedAt = remoteAt;
    removePendingPush(RECURRING_PENDING_KEY);
    return {
      action: 'pull',
      conflict: Boolean(localAt && localAt !== remoteAt),
      manifestDirty: true,
      items,
    };
  }

  if (cmp > 0) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: localAt,
      items: localItems,
    };
    await uploadJsonFile({ fileId, data: payload });
    manifest.recurringUpdatedAt = localAt;
    removePendingPush(RECURRING_PENDING_KEY);
    return { action: 'push', conflict: true, manifestDirty: true };
  }

  removePendingPush(RECURRING_PENDING_KEY);
  return { action: 'noop', conflict: false, manifestDirty: false };
}

/**
 * @param {{
 *   dates?: string[],
 *   localByDate?: Record<string, object>,
 *   includePending?: boolean,
 *   mode?: 'full' | 'push-prefer',
 * }} options
 * mode full = 수동(스트립 전체, pull 포함)
 * mode push-prefer = 자동(방금 수정분 push 위주, 불필요 다운로드 생략)
 */
export async function runCloudSync({
  dates = [],
  localByDate = {},
  includePending = true,
  mode = 'full',
} = {}) {
  if (!isAuthenticated()) throw createAuthExpiredError();

  const dateSet = new Set(dates.filter(Boolean));
  if (includePending) {
    for (const key of getPendingPushKeys()) {
      if (key !== RECURRING_PENDING_KEY) dateSet.add(key);
    }
  }

  const summary = {
    pushed: 0,
    pulled: 0,
    unchanged: 0,
    conflicts: 0,
    dates: [...dateSet],
    recurringAction: 'noop',
  };

  // 개선 1: 폴더·manifest는 동기화 1회에 한 번만
  const { syncFolderId: syncId, daysFolderId: daysId } =
    await ensureSyncFolders();
  const { fileId: manifestFileId, manifest } = await readOrCreateManifest(syncId);

  let manifestDirty = false;

  const recurringResult = await syncRecurringWithContext({
    syncId,
    manifest,
    mode,
    forceCheck: mode === 'full',
  });
  summary.recurringAction = recurringResult.action;
  if (recurringResult.action === 'push') summary.pushed += 1;
  else if (recurringResult.action === 'pull') summary.pulled += 1;
  else summary.unchanged += 1;
  if (recurringResult.conflict) summary.conflicts += 1;
  if (recurringResult.manifestDirty) manifestDirty = true;

  const sortedDates = [...dateSet].sort();

  // 개선 4: 날짜별 처리 병렬화 (manifest는 메모리에서만 갱신)
  const dayResults = await Promise.all(
    sortedDates.map((dateISO) =>
      syncDayWithContext({
        dateISO,
        localData: localByDate[dateISO] || loadDayData(dateISO),
        manifest,
        daysFolderId: daysId,
        mode,
      })
    )
  );

  for (const result of dayResults) {
    if (result.action === 'push') summary.pushed += 1;
    else if (result.action === 'pull') summary.pulled += 1;
    else summary.unchanged += 1;
    if (result.conflict) summary.conflicts += 1;
    if (result.manifestDirty) manifestDirty = true;
  }

  // 개선 1: manifest 쓰기는 마지막에 1회
  if (manifestDirty) {
    await writeManifest(manifestFileId, manifest);
  }

  return summary;
}

export function queueDayForSync(dateISO) {
  if (dateISO) addPendingPush(dateISO);
}

export function queueRecurringForSync() {
  addPendingPush(RECURRING_PENDING_KEY);
}
