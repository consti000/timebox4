import { generateTimeSlots, mergeTodosForDate } from './utils.js';
import {
  apiFetch,
  createAuthExpiredError,
  isAuthenticated,
  onSignOut,
} from './google-auth.js';

const TIMEBOX_ORIGIN = 'timebox4';
const TIME_SLOTS = generateTimeSlots(5, 24);
const SLOT_MINUTES = 30;
/** owner/writer 캘린더만 — 휴일 등 읽기 전용(다른 캘린더)은 제외 */
const WRITABLE_ROLES = new Set(['owner', 'writer']);

let cachedCalendars = null;

onSignOut(() => {
  cachedCalendars = null;
});

function getTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function parseDateParts(dateISO) {
  const [y, m, d] = dateISO.split('-').map(Number);
  return { y, m, d };
}

function slotToDate(dateISO, time) {
  const { y, m, d } = parseDateParts(dateISO);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function toRfc3339Local(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return `${y}-${m}-${d}T${h}:${min}:${s}${sign}${oh}:${om}`;
}

function dayRange(dateISO) {
  const { y, m, d } = parseDateParts(dateISO);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return {
    timeMin: toRfc3339Local(start),
    timeMax: toRfc3339Local(end),
  };
}

function isTimeboxOwned(event) {
  return event?.extendedProperties?.private?.timeboxOrigin === TIMEBOX_ORIGIN;
}

function slotsCoveredByRange(dateISO, start, end) {
  const slots = [];
  for (const slot of TIME_SLOTS) {
    const slotStart = slotToDate(dateISO, slot);
    const slotEnd = addMinutes(slotStart, SLOT_MINUTES);
    if (slotStart < end && slotEnd > start) {
      slots.push(slot);
    }
  }
  return slots;
}

function calendarDayUrl(dateISO) {
  const { y, m, d } = parseDateParts(dateISO);
  return `https://calendar.google.com/calendar/r/day/${y}/${m}/${d}`;
}

function eventClaimKey(event) {
  return `${event._calendarId || 'primary'}:${event.id}`;
}

function eventsUrl(calendarId, eventId) {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

/**
 * 내 캘린더(쓰기 가능) 목록 — Money, Privacy, 가족 등.
 * 대한민국 휴일처럼 읽기 전용인 '다른 캘린더'는 제외합니다.
 */
export async function listSyncCalendars({ forceRefresh = false } = {}) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }
  if (!forceRefresh && Array.isArray(cachedCalendars)) {
    return cachedCalendars;
  }

  const data = await apiFetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&showHidden=true'
  );
  const items = Array.isArray(data?.items) ? data.items : [];
  const calendars = items
    .filter((item) => item?.id && WRITABLE_ROLES.has(item.accessRole))
    .map((item) => ({
      id: item.id,
      summary: String(item.summary || item.id).trim() || item.id,
      primary: Boolean(item.primary),
      accessRole: item.accessRole,
    }))
    .sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      return a.summary.localeCompare(b.summary, 'ko');
    });

  if (calendars.length === 0) {
    calendars.push({
      id: 'primary',
      summary: 'primary',
      primary: true,
      accessRole: 'owner',
    });
  }

  cachedCalendars = calendars;
  return calendars;
}

function resolvePrimaryCalendarId(calendars) {
  return calendars.find((cal) => cal.primary)?.id || calendars[0]?.id || 'primary';
}

export function mergeTimelineToBlocks(dateISO, timeline) {
  const blocks = [];
  let i = 0;

  while (i < TIME_SLOTS.length) {
    const slot = TIME_SLOTS[i];
    const text = timeline[slot]?.trim();
    if (!text) {
      i += 1;
      continue;
    }

    let j = i + 1;
    while (j < TIME_SLOTS.length && timeline[TIME_SLOTS[j]]?.trim() === text) {
      j += 1;
    }

    const start = slotToDate(dateISO, TIME_SLOTS[i]);
    const end = addMinutes(slotToDate(dateISO, TIME_SLOTS[j - 1]), SLOT_MINUTES);
    blocks.push({
      summary: text,
      start,
      end,
      startRfc: toRfc3339Local(start),
      endRfc: toRfc3339Local(end),
    });
    i = j;
  }

  return blocks;
}

async function listDayEvents(calendarId, dateISO, { ownedOnly = false } = {}) {
  const { timeMin, timeMax } = dayRange(dateISO);
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
    timeMin,
    timeMax,
  });

  if (ownedOnly) {
    params.append('privateExtendedProperty', `timeboxOrigin=${TIMEBOX_ORIGIN}`);
  }

  const data = await apiFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`
  );
  return (data?.items || []).map((event) => ({
    ...event,
    _calendarId: calendarId,
  }));
}

async function listDayEventsAcrossCalendars(dateISO, { ownedOnly = false } = {}) {
  const calendars = await listSyncCalendars();
  const batches = await Promise.all(
    calendars.map((cal) => listDayEvents(cal.id, dateISO, { ownedOnly }))
  );
  return batches.flat();
}

function buildEventBody(dateISO, block) {
  const timeZone = getTimeZone();
  return {
    summary: block.summary,
    start: { dateTime: block.startRfc, timeZone },
    end: { dateTime: block.endRfc, timeZone },
    extendedProperties: {
      private: {
        timeboxOrigin: TIMEBOX_ORIGIN,
        timeboxDate: dateISO,
      },
    },
  };
}

function isAllDayEvent(event) {
  return Boolean(event?.start?.date && !event?.start?.dateTime);
}

/** Google 종일 일정의 end.date는 exclusive 이므로 dateISO가 [start, end)에 포함되는지 확인 */
function allDayCoversDate(event, dateISO) {
  const start = event?.start?.date;
  const end = event?.end?.date;
  if (!start || !end) return false;
  return start <= dateISO && dateISO < end;
}

/**
 * 쓰기 가능한 모든 내 캘린더(primary + Money/Privacy 등)의 당일 일정을 반영합니다.
 * - 시간이 있는 일정 → 빈 타임박스 슬롯만 채움
 * - 종일 일정 → 할 일 목록에 추가(동일 제목 중복 방지)
 */
export async function pullDayToTimeline(dateISO, timeline, brainDump = []) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const events = await listDayEventsAcrossCalendars(dateISO, { ownedOnly: false });
  const next = { ...timeline };
  const nextTodos = Array.isArray(brainDump) ? [...brainDump] : [];
  const existingTodoKeys = new Set(
    mergeTodosForDate(dateISO, { brainDump: nextTodos })
      .map((item) => item?.text?.trim().toLowerCase())
      .filter(Boolean)
  );
  let filled = 0;
  let todosAdded = 0;

  for (const event of events) {
    if (isTimeboxOwned(event)) continue;

    const summary = (event.summary || '(제목 없음)').trim();
    if (!summary) continue;

    if (isAllDayEvent(event)) {
      if (!allDayCoversDate(event, dateISO)) continue;
      const key = summary.toLowerCase();
      if (existingTodoKeys.has(key)) continue;
      existingTodoKeys.add(key);
      nextTodos.push({
        text: summary,
        done: false,
        id: Date.now() + Math.random(),
      });
      todosAdded += 1;
      continue;
    }

    if (!event.start?.dateTime || !event.end?.dateTime) continue;

    const start = new Date(event.start.dateTime);
    const end = new Date(event.end.dateTime);
    const slots = slotsCoveredByRange(dateISO, start, end);

    for (const slot of slots) {
      if (next[slot]?.trim()) continue;
      next[slot] = summary;
      filled += 1;
    }
  }

  return {
    timeline: next,
    brainDump: nextTodos,
    filled,
    todosAdded,
    eventCount: events.length,
  };
}

function normalizeSummary(value) {
  return (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function eventStartEnd(event) {
  if (!event?.start?.dateTime || !event?.end?.dateTime) return null;
  return {
    start: new Date(event.start.dateTime),
    end: new Date(event.end.dateTime),
  };
}

function sameInstant(a, b, toleranceMs = 60_000) {
  return Math.abs(a.getTime() - b.getTime()) <= toleranceMs;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/** 모든 동기화 대상 캘린더의 당일 일정을 수집합니다. */
async function listPushContext(dateISO) {
  const [byProp, allDay] = await Promise.all([
    listDayEventsAcrossCalendars(dateISO, { ownedOnly: true }),
    listDayEventsAcrossCalendars(dateISO, { ownedOnly: false }),
  ]);

  const allMap = new Map();
  for (const event of allDay) {
    if (event?.id) allMap.set(eventClaimKey(event), event);
  }
  for (const event of byProp) {
    if (event?.id) allMap.set(eventClaimKey(event), event);
  }

  const allEvents = [...allMap.values()];
  const owned = allEvents.filter((event) => isTimeboxOwned(event));
  return { owned, allEvents };
}

/**
 * 이미 캘린더에 있는 동일 일정(제목+시작 또는 제목+시간 겹침)을 찾습니다.
 * Timebox4/외부 구분 없이 먼저 찾고, 호출측에서 소유 여부에 따라 update/skip 결정.
 */
function findExistingMatch(block, events, claimedIds) {
  const blockSummary = normalizeSummary(block.summary);
  if (!blockSummary) return null;

  let overlapMatch = null;

  for (const event of events) {
    if (!event?.id) continue;
    const claim = eventClaimKey(event);
    if (claimedIds.has(claim)) continue;
    if (isAllDayEvent(event)) continue;
    if (normalizeSummary(event.summary) !== blockSummary) continue;

    const range = eventStartEnd(event);
    if (!range) continue;

    if (sameInstant(range.start, block.start)) {
      return event;
    }

    if (
      !overlapMatch &&
      rangesOverlap(range.start, range.end, block.start, block.end)
    ) {
      overlapMatch = event;
    }
  }

  return overlapMatch;
}

/**
 * 타임라인 블록을 캘린더에 upsert합니다.
 * - 모든 내 캘린더에서 매칭 검색
 * - Timebox4 일정이면 해당 캘린더에서 수정, 외부면 생성 생략
 * - 신규 일정은 어디에 있든 삭제하지 않음
 * - 새 일정은 primary 캘린더에 생성
 */
export async function pushTimelineToCalendar(dateISO, timeline) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const calendars = await listSyncCalendars({ forceRefresh: true });
  const primaryId = resolvePrimaryCalendarId(calendars);
  const blocks = mergeTimelineToBlocks(dateISO, timeline);
  const { allEvents } = await listPushContext(dateISO);
  const claimedIds = new Set();

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const block of blocks) {
    const body = buildEventBody(dateISO, block);
    const match = findExistingMatch(block, allEvents, claimedIds);

    if (match) {
      claimedIds.add(eventClaimKey(match));

      if (isTimeboxOwned(match)) {
        const calendarId = match._calendarId || primaryId;
        const sameSummary = (match.summary || '').trim() === block.summary;
        const range = eventStartEnd(match);
        const sameRange =
          range &&
          sameInstant(range.start, block.start) &&
          sameInstant(range.end, block.end);

        if (sameSummary && sameRange) {
          unchanged += 1;
        } else {
          await apiFetch(eventsUrl(calendarId, match.id), {
            method: 'PATCH',
            body: JSON.stringify(body),
          });
          updated += 1;
        }
      } else {
        skipped += 1;
      }
      continue;
    }

    await apiFetch(eventsUrl(primaryId), {
      method: 'POST',
      body: JSON.stringify(body),
    });
    created += 1;
  }

  return {
    created,
    updated,
    deleted: 0,
    unchanged,
    skipped,
    total: blocks.length,
    calendarCount: calendars.length,
    calendarUrl: calendarDayUrl(dateISO),
  };
}
