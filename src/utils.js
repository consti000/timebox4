const STORAGE_PREFIX = 'timebox4_';

export function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function formatDateDisplay(iso) {
  const [y, m, d] = iso.split('-');
  return `${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;
}

export function parseDateInput(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (/^\d{8}$/.test(trimmed)) {
    const y = trimmed.slice(0, 4);
    const m = trimmed.slice(4, 6);
    const d = trimmed.slice(6, 8);
    return validateDate(`${y}-${m}-${d}`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return validateDate(trimmed);
  }

  return null;
}

function validateDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  ) {
    return null;
  }
  return iso;
}

export function todayISO() {
  return formatDateISO(new Date());
}

export function addDaysISO(iso, delta) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + delta);
  return formatDateISO(date);
}

export function dateWindowAround(centerISO, radius = 4) {
  const out = [];
  for (let i = -radius; i <= radius; i++) {
    out.push(addDaysISO(centerISO, i));
  }
  return out;
}

export function generateTimeSlots(startHour = 6, endHour = 23) {
  const slots = [];
  for (let h = startHour; h <= endHour; h++) {
    slots.push(`${String(h).padStart(2, '0')}:00`);
    if (h < endHour || endHour === 23) {
      slots.push(`${String(h).padStart(2, '0')}:30`);
    }
  }
  return slots;
}

/** 저장되지 않은 빈 날의 기준 시각. now를 쓰면 LWW에서 클라우드를 덮어쓴다. */
export const EMPTY_UPDATED_AT = new Date(0).toISOString();

export function createEmptyDayData() {
  return {
    priorities: [{ text: '' }, { text: '' }, { text: '' }],
    brainDump: [],
    skippedRecurringIds: [],
    timeline: {},
    memo: '',
    updatedAt: EMPTY_UPDATED_AT,
  };
}

/** 실제 입력 없는 날인지 (빈 로컬이 클라우드를 push로 지우지 않게 판별) */
export function isDayDataBlank(data) {
  const d = normalizeDayData(data);
  const noPriorities = d.priorities.every((p) => !String(p.text || '').trim());
  const noBrain = d.brainDump.length === 0;
  const noTimeline = Object.values(d.timeline).every(
    (v) => !String(v || '').trim()
  );
  const noMemo = !String(d.memo || '').trim();
  const noSkipped = d.skippedRecurringIds.length === 0;
  return noPriorities && noBrain && noTimeline && noMemo && noSkipped;
}

function pickNonEmptyText(a, b, preferA) {
  const ta = typeof a === 'string' ? a.trim() : '';
  const tb = typeof b === 'string' ? b.trim() : '';
  if (ta && tb) return preferA ? a : b;
  if (ta) return a;
  if (tb) return b;
  return '';
}

/**
 * 기기 간 날짜 데이터 병합.
 * 타임라인은 슬롯 단위로 합치고, 양쪽 모두 값이 있으면 더 최신 쪽을 택합니다.
 * (날짜 전체 LWW는 한쪽 슬롯 입력이 다른 기기 내용을 통째로 지우는 문제가 있음)
 */
export function mergeDayData(localRaw, remoteRaw) {
  const local = normalizeDayData(localRaw);
  const remote = normalizeDayData(remoteRaw);
  const cmp = (Date.parse(local.updatedAt) || 0) - (Date.parse(remote.updatedAt) || 0);
  const preferLocal = cmp >= 0;

  const priorities = [0, 1, 2].map((i) => ({
    text: pickNonEmptyText(
      local.priorities[i]?.text,
      remote.priorities[i]?.text,
      preferLocal
    ),
  }));

  const brainByKey = new Map();
  const rememberBrain = (item, fromLocal) => {
    const key =
      item.recurringId != null && item.recurringId !== ''
        ? `r:${item.recurringId}`
        : `t:${String(item.text).trim().toLowerCase()}`;
    const prev = brainByKey.get(key);
    if (!prev) {
      brainByKey.set(key, { ...item, done: Boolean(item.done) });
      return;
    }
    const takeIncoming = preferLocal ? fromLocal : !fromLocal;
    brainByKey.set(key, {
      ...prev,
      ...item,
      done: takeIncoming
        ? Boolean(item.done) || Boolean(prev.done)
        : Boolean(prev.done) || Boolean(item.done),
      text: takeIncoming ? item.text : prev.text,
    });
  };
  remote.brainDump.forEach((item) => rememberBrain(item, false));
  local.brainDump.forEach((item) => rememberBrain(item, true));

  const timeline = {};
  const slotKeys = new Set([
    ...Object.keys(local.timeline),
    ...Object.keys(remote.timeline),
  ]);
  for (const key of slotKeys) {
    const value = pickNonEmptyText(
      local.timeline[key],
      remote.timeline[key],
      preferLocal
    );
    if (value) timeline[key] = value;
  }

  const skipped = [
    ...new Set([
      ...local.skippedRecurringIds,
      ...remote.skippedRecurringIds,
    ]),
  ];

  const memo = pickNonEmptyText(local.memo, remote.memo, preferLocal);

  const localMs = Date.parse(local.updatedAt) || 0;
  const remoteMs = Date.parse(remote.updatedAt) || 0;
  const mergedAt =
    localMs >= remoteMs ? local.updatedAt : remote.updatedAt;

  return normalizeDayData({
    priorities,
    brainDump: [...brainByKey.values()],
    skippedRecurringIds: skipped,
    timeline,
    memo,
    updatedAt: mergedAt,
  });
}

/** updatedAt 제외한 본문 동일 여부 */
export function dayDataContentEqual(aRaw, bRaw) {
  const canon = (raw) => {
    const d = normalizeDayData(raw);
    const timeline = {};
    for (const key of Object.keys(d.timeline).sort()) {
      timeline[key] = d.timeline[key];
    }
    const brainDump = [...d.brainDump]
      .map((item) => ({
        text: item.text,
        done: Boolean(item.done),
        recurringId: item.recurringId ?? null,
      }))
      .sort((x, y) => {
        const kx = `${x.recurringId ?? ''}|${x.text}`;
        const ky = `${y.recurringId ?? ''}|${y.text}`;
        return kx.localeCompare(ky);
      });
    return {
      priorities: d.priorities.map((p) => ({ text: p.text })),
      brainDump,
      skippedRecurringIds: [...d.skippedRecurringIds].map(String).sort(),
      timeline,
      memo: d.memo,
    };
  };
  return JSON.stringify(canon(aRaw)) === JSON.stringify(canon(bRaw));
}

export function normalizeDayData(raw) {
  const empty = createEmptyDayData();
  if (!raw || typeof raw !== 'object') return empty;

  const priorities = [];
  const rawPriorities = Array.isArray(raw.priorities) ? raw.priorities : [];
  for (let i = 0; i < 3; i++) {
    const item = rawPriorities[i];
    priorities.push({
      text: typeof item?.text === 'string' ? item.text : '',
    });
  }

  const brainDump = Array.isArray(raw.brainDump)
    ? raw.brainDump
        .filter((item) => item && typeof item.text === 'string' && item.text.trim())
        .map((item) => {
          const next = {
            text: item.text,
            done: Boolean(item.done),
            id: typeof item.id === 'number' ? item.id : Date.now() + Math.random(),
          };
          if (item.recurringId != null && item.recurringId !== '') {
            next.recurringId = item.recurringId;
          }
          return next;
        })
    : [];

  const skippedRecurringIds = Array.isArray(raw.skippedRecurringIds)
    ? raw.skippedRecurringIds.filter((id) => id != null && id !== '')
    : [];

  const timeline = {};
  if (raw.timeline && typeof raw.timeline === 'object' && !Array.isArray(raw.timeline)) {
    Object.entries(raw.timeline).forEach(([key, value]) => {
      if (typeof key === 'string' && typeof value === 'string') {
        timeline[key] = value;
      }
    });
  }

  return {
    priorities,
    brainDump,
    skippedRecurringIds,
    timeline,
    memo: typeof raw.memo === 'string' ? raw.memo : '',
    // 누락 시 epoch — now로 채우면 빈/구 데이터가 클라우드를 덮어씀
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt
        ? raw.updatedAt
        : EMPTY_UPDATED_AT,
  };
}

const RECURRING_TODOS_KEY = `${STORAGE_PREFIX}recurring_todos`;
const RECURRING_UPDATED_AT_KEY = `${STORAGE_PREFIX}recurring_updated_at`;
const DEVICE_ID_KEY = `${STORAGE_PREFIX}device_id`;
const PENDING_PUSH_KEY = `${STORAGE_PREFIX}pending_push`;
export const RECURRING_PENDING_KEY = '__recurring__';

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (id) return id;
    id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? `tb4_${crypto.randomUUID()}`
        : `tb4_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return 'tb4_unknown';
  }
}

export function getPendingPushKeys() {
  try {
    const raw = localStorage.getItem(PENDING_PUSH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function writePendingPushKeys(keys) {
  try {
    localStorage.setItem(PENDING_PUSH_KEY, JSON.stringify([...new Set(keys)]));
  } catch {
    // ignore
  }
}

export function addPendingPush(key) {
  if (!key) return;
  const keys = getPendingPushKeys();
  if (!keys.includes(key)) {
    keys.push(key);
    writePendingPushKeys(keys);
  }
}

export function removePendingPush(key) {
  writePendingPushKeys(getPendingPushKeys().filter((k) => k !== key));
}

export function getRecurringUpdatedAt() {
  try {
    return localStorage.getItem(RECURRING_UPDATED_AT_KEY) || new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

export function setRecurringUpdatedAt(iso) {
  try {
    localStorage.setItem(
      RECURRING_UPDATED_AT_KEY,
      typeof iso === 'string' && iso ? iso : new Date().toISOString()
    );
  } catch {
    // ignore
  }
}

function normalizeRecurringTodo(item) {
  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  const startDate = validateDate(String(item?.startDate || ''));
  const endDate = validateDate(String(item?.endDate || ''));
  if (!text || !startDate || !endDate) return null;
  const [from, to] = startDate <= endDate ? [startDate, endDate] : [endDate, startDate];
  return {
    id: item.id != null && item.id !== '' ? item.id : Date.now() + Math.random(),
    text,
    startDate: from,
    endDate: to,
  };
}

export function loadRecurringTodos() {
  try {
    const raw = localStorage.getItem(RECURRING_TODOS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRecurringTodo).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveRecurringTodos(items) {
  const normalized = (Array.isArray(items) ? items : [])
    .map(normalizeRecurringTodo)
    .filter(Boolean);
  localStorage.setItem(RECURRING_TODOS_KEY, JSON.stringify(normalized));
  return normalized;
}

/** 로컬에서 반복 할 일을 바꿀 때 updatedAt을 갱신합니다. */
export function saveRecurringTodosLocal(items) {
  const normalized = saveRecurringTodos(items);
  setRecurringUpdatedAt(new Date().toISOString());
  return normalized;
}

export function addRecurringTodo({ text, startDate, endDate }) {
  const next = normalizeRecurringTodo({
    id: Date.now() + Math.random(),
    text,
    startDate,
    endDate,
  });
  if (!next) return null;
  const items = loadRecurringTodos();
  items.push(next);
  saveRecurringTodosLocal(items);
  return next;
}

export function removeRecurringTodo(id) {
  const items = loadRecurringTodos().filter((item) => item.id !== id);
  saveRecurringTodosLocal(items);
}

export function recurringCoversDate(item, dateISO) {
  return Boolean(item?.startDate && item?.endDate && dateISO >= item.startDate && dateISO <= item.endDate);
}

export function formatRepeatRange(startISO, endISO) {
  const fmt = (iso) => {
    const [, m, d] = String(iso).split('-');
    return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
  };
  if (!startISO || !endISO) return '';
  if (startISO === endISO) return fmt(startISO);
  return `${fmt(startISO)}–${fmt(endISO)}`;
}

/** 해당 날짜에 표시할 할 일(하루 항목 + 기간 반복) */
export function mergeTodosForDate(dateISO, data) {
  const day = normalizeDayData(data);
  const skipped = new Set(day.skippedRecurringIds);
  const local = [];
  const completions = new Map();

  for (const item of day.brainDump) {
    if (item.recurringId != null) {
      completions.set(item.recurringId, item);
    } else {
      local.push(item);
    }
  }

  const recurring = loadRecurringTodos()
    .filter((item) => recurringCoversDate(item, dateISO) && !skipped.has(item.id))
    .map((item) => {
      const saved = completions.get(item.id);
      return {
        text: item.text,
        done: Boolean(saved?.done),
        id: saved?.id ?? item.id,
        recurringId: item.id,
        startDate: item.startDate,
        endDate: item.endDate,
      };
    });

  return [...local, ...recurring];
}

export function loadDayData(dateISO) {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${dateISO}`);
    if (!raw) return createEmptyDayData();
    return normalizeDayData(JSON.parse(raw));
  } catch {
    return createEmptyDayData();
  }
}

export function saveDayData(dateISO, data, { touch = true } = {}) {
  const normalized = normalizeDayData(data);
  if (touch) {
    normalized.updatedAt = new Date().toISOString();
  } else if (typeof data?.updatedAt === 'string' && data.updatedAt) {
    normalized.updatedAt = data.updatedAt;
  }
  Object.assign(data, normalized);
  localStorage.setItem(`${STORAGE_PREFIX}${dateISO}`, JSON.stringify(normalized));
}

export function getAllSavedDates() {
  const dates = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_PREFIX)) {
      dates.push(key.slice(STORAGE_PREFIX.length));
    }
  }
  return dates.sort().reverse();
}

export function debounce(fn, delay) {
  let timer;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
  };
  return debounced;
}
