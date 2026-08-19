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

export function createEmptyDayData() {
  return {
    priorities: [{ text: '' }, { text: '' }, { text: '' }],
    brainDump: [],
    skippedRecurringIds: [],
    timeline: {},
    memo: '',
    updatedAt: new Date().toISOString(),
  };
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
    updatedAt:
      typeof raw.updatedAt === 'string' ? raw.updatedAt : empty.updatedAt,
  };
}

const RECURRING_TODOS_KEY = `${STORAGE_PREFIX}recurring_todos`;

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
  saveRecurringTodos(items);
  return next;
}

export function removeRecurringTodo(id) {
  const items = loadRecurringTodos().filter((item) => item.id !== id);
  saveRecurringTodos(items);
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

export function saveDayData(dateISO, data) {
  const normalized = normalizeDayData(data);
  normalized.updatedAt = new Date().toISOString();
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
