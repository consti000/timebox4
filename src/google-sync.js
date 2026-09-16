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

let rootFolderId = null;
let syncFolderId = null;
let daysFolderId = null;
let cachedFileIds = loadFileIdCache();

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

function emptyManifest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: 'timebox4',
    updatedAt: new Date(0).toISOString(),
    recurringUpdatedAt: new Date(0).toISOString(),
    days: {},
  };
}

function compareUpdatedAt(a, b, deviceA = '', deviceB = '') {
  const ta = Date.parse(a || '') || 0;
  const tb = Date.parse(b || '') || 0;
  if (ta !== tb) return ta - tb;
  return String(deviceA).localeCompare(String(deviceB));
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
  return rootFolderId;
}

async function ensureSyncFolders() {
  const root = await ensureRootFolder();
  if (!syncFolderId) {
    syncFolderId = await ensureFolderNamed(root, SYNC_FOLDER_NAME);
  }
  if (!daysFolderId) {
    daysFolderId = await ensureFolderNamed(syncFolderId, DAYS_FOLDER_NAME);
  }
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
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(data, null, 2)}\r\n` +
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

async function resolveNamedJson(parentId, name, cacheKey) {
  const cached = cachedFileIds[cacheKey];
  if (cached) {
    try {
      await apiFetch(
        `https://www.googleapis.com/drive/v3/files/${cached}?fields=id,trashed`
      );
      return cached;
    } catch {
      cachedFileIds[cacheKey] = null;
      persistFileIdCache();
    }
  }

  const found = await findChildByName(parentId, name);
  if (found?.id) {
    cachedFileIds[cacheKey] = found.id;
    persistFileIdCache();
    return found.id;
  }
  return null;
}

async function readOrCreateManifest() {
  const { syncFolderId: syncId } = await ensureSyncFolders();
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
            ? manifest.days
            : {},
      },
    };
  } catch {
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
  await uploadJsonFile({ fileId, data: next });
  return next;
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

async function resolveDayFileId(dateISO, manifestEntry) {
  if (manifestEntry?.fileId) {
    cachedFileIds.days[dateISO] = manifestEntry.fileId;
    persistFileIdCache();
    return manifestEntry.fileId;
  }
  if (cachedFileIds.days[dateISO]) return cachedFileIds.days[dateISO];

  const { daysFolderId: daysId } = await ensureSyncFolders();
  const found = await findChildByName(daysId, `${dateISO}.json`);
  if (found?.id) {
    cachedFileIds.days[dateISO] = found.id;
    persistFileIdCache();
    return found.id;
  }
  return null;
}

/**
 * 하루 데이터 LWW 동기화.
 * @returns {{ action: 'push'|'pull'|'noop', conflict: boolean }}
 */
export async function syncDay(dateISO, localData) {
  if (!isAuthenticated()) throw createAuthExpiredError();

  const local = normalizeDayData(localData);
  const { fileId: manifestFileId, manifest } = await readOrCreateManifest();
  const entry = manifest.days[dateISO] || null;
  const remoteMetaAt = entry?.updatedAt || '';
  const dayFileId = await resolveDayFileId(dateISO, entry);

  let remote = null;
  if (dayFileId) {
    try {
      remote = await downloadJson(dayFileId);
    } catch {
      remote = null;
    }
  }

  const remoteAt = remote?.updatedAt || remoteMetaAt;
  const remoteDevice = remote?.deviceId || '';
  const cmp = compareUpdatedAt(
    local.updatedAt,
    remoteAt,
    getDeviceId(),
    remoteDevice
  );

  if (!remote && !entry) {
    const { daysFolderId: daysId } = await ensureSyncFolders();
    const created = await uploadJsonFile({
      name: `${dateISO}.json`,
      parents: [daysId],
      data: dayPayload(dateISO, local),
    });
    cachedFileIds.days[dateISO] = created.id;
    persistFileIdCache();
    manifest.days[dateISO] = {
      updatedAt: local.updatedAt,
      fileId: created.id,
    };
    await writeManifest(manifestFileId, manifest);
    removePendingPush(dateISO);
    return { action: 'push', conflict: false };
  }

  if (cmp > 0) {
    const payload = dayPayload(dateISO, local);
    let fileId = dayFileId;
    if (fileId) {
      await uploadJsonFile({ fileId, data: payload });
    } else {
      const { daysFolderId: daysId } = await ensureSyncFolders();
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
    await writeManifest(manifestFileId, manifest);
    removePendingPush(dateISO);
    return {
      action: 'push',
      conflict: Boolean(remote && remoteAt && remoteAt !== local.updatedAt),
    };
  }

  if (cmp < 0 && remote) {
    const pulled = normalizeDayData(remote);
    pulled.updatedAt = remote.updatedAt || remoteAt;
    saveDayData(dateISO, pulled, { touch: false });
    if (entry?.fileId && entry.fileId !== dayFileId) {
      cachedFileIds.days[dateISO] = entry.fileId;
      persistFileIdCache();
    }
    removePendingPush(dateISO);
    return {
      action: 'pull',
      conflict: Boolean(local.updatedAt && local.updatedAt !== pulled.updatedAt),
      data: pulled,
    };
  }

  removePendingPush(dateISO);
  return { action: 'noop', conflict: false };
}

/**
 * 기간 반복 할 일 LWW 동기화.
 */
export async function syncRecurring() {
  if (!isAuthenticated()) throw createAuthExpiredError();

  const localItems = loadRecurringTodos();
  const localAt = getRecurringUpdatedAt();
  const { syncFolderId: syncId } = await ensureSyncFolders();
  const { fileId: manifestFileId, manifest } = await readOrCreateManifest();

  let fileId = await resolveNamedJson(syncId, RECURRING_NAME, 'recurring');
  let remote = null;
  if (fileId) {
    try {
      remote = await downloadJson(fileId);
    } catch {
      remote = null;
    }
  }

  const remoteAt =
    remote?.updatedAt || manifest.recurringUpdatedAt || new Date(0).toISOString();
  const cmp = compareUpdatedAt(localAt, remoteAt);

  if (!remote && !fileId) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: localAt || new Date().toISOString(),
      items: localItems,
    };
    if (!localAt) setRecurringUpdatedAt(payload.updatedAt);
    const created = await uploadJsonFile({
      name: RECURRING_NAME,
      parents: [syncId],
      data: payload,
    });
    cachedFileIds.recurring = created.id;
    persistFileIdCache();
    manifest.recurringUpdatedAt = payload.updatedAt;
    await writeManifest(manifestFileId, manifest);
    removePendingPush(RECURRING_PENDING_KEY);
    return { action: 'push', conflict: false };
  }

  if (cmp > 0) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: localAt || new Date().toISOString(),
      items: localItems,
    };
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
    manifest.recurringUpdatedAt = payload.updatedAt;
    await writeManifest(manifestFileId, manifest);
    removePendingPush(RECURRING_PENDING_KEY);
    return { action: 'push', conflict: Boolean(remote) };
  }

  if (cmp < 0 && remote) {
    const items = Array.isArray(remote.items) ? remote.items : [];
    saveRecurringTodos(items);
    setRecurringUpdatedAt(remote.updatedAt || remoteAt);
    removePendingPush(RECURRING_PENDING_KEY);
    return {
      action: 'pull',
      conflict: Boolean(localAt && localAt !== (remote.updatedAt || remoteAt)),
      items,
    };
  }

  removePendingPush(RECURRING_PENDING_KEY);
  return { action: 'noop', conflict: false };
}

/**
 * 지정 날짜들 + recurring + pending 큐를 LWW로 맞춥니다.
 */
export async function runCloudSync({
  dates = [],
  localByDate = {},
  includePending = true,
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

  const recurringResult = await syncRecurring();
  summary.recurringAction = recurringResult.action;
  if (recurringResult.action === 'push') summary.pushed += 1;
  else if (recurringResult.action === 'pull') summary.pulled += 1;
  else summary.unchanged += 1;
  if (recurringResult.conflict) summary.conflicts += 1;

  for (const dateISO of [...dateSet].sort()) {
    const local = localByDate[dateISO] || loadDayData(dateISO);
    const result = await syncDay(dateISO, local);
    if (result.action === 'push') summary.pushed += 1;
    else if (result.action === 'pull') summary.pulled += 1;
    else summary.unchanged += 1;
    if (result.conflict) summary.conflicts += 1;
  }

  return summary;
}

export function queueDayForSync(dateISO) {
  if (dateISO) addPendingPush(dateISO);
}

export function queueRecurringForSync() {
  addPendingPush(RECURRING_PENDING_KEY);
}
