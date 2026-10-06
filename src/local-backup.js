import {
  loadDayData,
  saveDayData,
  loadRecurringTodos,
  isDayDataBlank,
  mergeDayData,
  dayDataContentEqual,
  mergeRecurringTodos,
} from './utils.js';

const STORAGE_PREFIX = 'timebox4_';
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
export const BACKUP_SCHEMA_VERSION = 1;

function listSavedPlannerDates() {
  const dates = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    const dateISO = key.slice(STORAGE_PREFIX.length);
    if (DATE_KEY.test(dateISO)) dates.push(dateISO);
  }
  return dates.sort();
}

/** 브라우저 로컬의 플래너 기록만 백업 객체로 만듭니다. */
export function buildLocalBackup() {
  const days = {};
  for (const dateISO of listSavedPlannerDates()) {
    const data = loadDayData(dateISO);
    if (!isDayDataBlank(data)) days[dateISO] = data;
  }
  return {
    app: 'timebox4',
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    days,
    recurring: loadRecurringTodos(),
  };
}

export function backupFilename(payload) {
  const day = String(payload?.exportedAt || '').slice(0, 10);
  const stamp = DATE_KEY.test(day) ? day : 'backup';
  return `timebox4-backup-${stamp}.json`;
}

export function parseLocalBackup(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('JSON 파일이 아닙니다.');
  }
  if (!payload || payload.app !== 'timebox4' || payload.schemaVersion !== 1) {
    throw new Error('TimeBox4 백업 파일이 아닙니다.');
  }
  if (!payload.days || typeof payload.days !== 'object' || Array.isArray(payload.days)) {
    throw new Error('백업 파일에 날짜 기록이 없습니다.');
  }
  if (payload.recurring != null && !Array.isArray(payload.recurring)) {
    throw new Error('반복 할 일 형식이 올바르지 않습니다.');
  }
  return payload;
}

/**
 * 백업을 현재 로컬과 합칩니다. 기존 글을 파일 내용으로 지우지 않습니다.
 * @returns {{ daysMerged: number, daysSkipped: number, recurringAdded: number, changedDates: string[] }}
 */
export function mergeLocalBackup(payload) {
  const parsed = parseLocalBackup(JSON.stringify(payload));
  const changedDates = [];
  let daysSkipped = 0;

  for (const [dateISO, raw] of Object.entries(parsed.days)) {
    if (!DATE_KEY.test(dateISO)) {
      daysSkipped += 1;
      continue;
    }
    const incoming = raw;
    if (isDayDataBlank(incoming)) {
      daysSkipped += 1;
      continue;
    }
    const local = loadDayData(dateISO);
    const merged = mergeDayData(local, incoming);
    if (dayDataContentEqual(merged, local)) {
      daysSkipped += 1;
      continue;
    }
    saveDayData(dateISO, merged, { touch: false });
    changedDates.push(dateISO);
  }

  const recurring = mergeRecurringTodos(parsed.recurring || []);
  return {
    daysMerged: changedDates.length,
    daysSkipped,
    recurringAdded: recurring.added,
    changedDates,
  };
}
