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
        .map((item) => ({
          text: item.text,
          done: Boolean(item.done),
          id: typeof item.id === 'number' ? item.id : Date.now() + Math.random(),
        }))
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
    timeline,
    memo: typeof raw.memo === 'string' ? raw.memo : '',
    updatedAt:
      typeof raw.updatedAt === 'string' ? raw.updatedAt : empty.updatedAt,
  };
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
