import { generateTimeSlots } from './utils.js';
import {
  apiFetch,
  createAuthExpiredError,
  isAuthenticated,
} from './google-auth.js';

const CALENDAR_ID = 'primary';
const TIMEBOX_ORIGIN = 'timebox4';
const TIME_SLOTS = generateTimeSlots(5, 24);
const SLOT_MINUTES = 30;

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

function eventRangeKey(startIso, endIso) {
  return `${startIso}|${endIso}`;
}

function normalizeEventDateTime(value) {
  if (!value) return null;
  return new Date(value).toISOString();
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

async function listDayEvents(dateISO, { ownedOnly = false } = {}) {
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  });

  if (ownedOnly) {
    // timeboxDate로 조회해 24:00 슬롯(다음날 00:00) 이벤트도 빠지지 않게 함
    params.append('privateExtendedProperty', `timeboxOrigin=${TIMEBOX_ORIGIN}`);
    params.append('privateExtendedProperty', `timeboxDate=${dateISO}`);
  } else {
    const { timeMin, timeMax } = dayRange(dateISO);
    params.set('timeMin', timeMin);
    params.set('timeMax', timeMax);
  }

  const data = await apiFetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${params}`
  );
  return data?.items || [];
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
 * 외부(non-timebox4) 캘린더 일정을 반영합니다.
 * - 시간이 있는 일정 → 빈 타임박스 슬롯만 채움
 * - 종일 일정 → 할 일 목록에 추가(동일 제목 중복 방지)
 */
export async function pullDayToTimeline(dateISO, timeline, brainDump = []) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const events = await listDayEvents(dateISO, { ownedOnly: false });
  const next = { ...timeline };
  const nextTodos = Array.isArray(brainDump) ? [...brainDump] : [];
  const existingTodoKeys = new Set(
    nextTodos
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
  return (value || '').trim().toLowerCase();
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

function rangeKeyFromDates(start, end) {
  return eventRangeKey(
    normalizeEventDateTime(start.toISOString()),
    normalizeEventDateTime(end.toISOString())
  );
}

/** private 속성 조회 + 당일 전체 조회를 합쳐 Timebox4 소유 일정을 빠짐없이 모읍니다. */
async function listOwnedDayEvents(dateISO) {
  const [byProp, allDay] = await Promise.all([
    listDayEvents(dateISO, { ownedOnly: true }),
    listDayEvents(dateISO, { ownedOnly: false }),
  ]);

  const map = new Map();
  for (const event of byProp) {
    if (event?.id) map.set(event.id, event);
  }
  for (const event of allDay) {
    if (event?.id && isTimeboxOwned(event)) {
      map.set(event.id, event);
    }
  }
  return { owned: [...map.values()], allDay };
}

function findOwnedMatch(block, ownedEvents, claimedIds) {
  const blockRangeKey = rangeKeyFromDates(block.start, block.end);
  const blockSummary = normalizeSummary(block.summary);

  for (const event of ownedEvents) {
    if (!event?.id || claimedIds.has(event.id)) continue;
    const range = eventStartEnd(event);
    if (!range) continue;

    if (rangeKeyFromDates(range.start, range.end) === blockRangeKey) {
      return event;
    }

    // 제목+시작 시각이 같으면 같은 일정으로 간주 (끝 시각이 조금 달라도 매칭)
    if (
      normalizeSummary(event.summary) === blockSummary &&
      sameInstant(range.start, block.start)
    ) {
      return event;
    }
  }
  return null;
}

/**
 * 캘린더에 이미 있는 외부(비-Timebox4) 일정과 제목·시간이 같으면 중복 생성하지 않습니다.
 */
function findExternalDuplicate(block, allEvents, claimedIds) {
  const blockSummary = normalizeSummary(block.summary);
  if (!blockSummary) return null;

  for (const event of allEvents) {
    if (!event?.id || claimedIds.has(event.id)) continue;
    if (isTimeboxOwned(event) || isAllDayEvent(event)) continue;
    if (normalizeSummary(event.summary) !== blockSummary) continue;

    const range = eventStartEnd(event);
    if (!range) continue;

    if (
      sameInstant(range.start, block.start) &&
      sameInstant(range.end, block.end)
    ) {
      return event;
    }
  }
  return null;
}

/**
 * 타임라인 블록을 캘린더에 upsert합니다.
 * - Timebox4 소유 일정: 시간/제목으로 매칭해 수정·유지
 * - 이미 있는 외부 일정과 제목·시간이 같으면 생성 생략(중복 방지)
 */
export async function pushTimelineToCalendar(dateISO, timeline) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const blocks = mergeTimelineToBlocks(dateISO, timeline);
  const { owned, allDay } = await listOwnedDayEvents(dateISO);
  const unused = new Set(owned.map((event) => event.id).filter(Boolean));
  const claimedIds = new Set();

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const block of blocks) {
    const body = buildEventBody(dateISO, block);
    const ownedMatch = findOwnedMatch(block, owned, claimedIds);

    if (ownedMatch) {
      unused.delete(ownedMatch.id);
      claimedIds.add(ownedMatch.id);
      if ((ownedMatch.summary || '').trim() === block.summary) {
        unchanged += 1;
      } else {
        await apiFetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(ownedMatch.id)}`,
          { method: 'PATCH', body: JSON.stringify(body) }
        );
        updated += 1;
      }
      continue;
    }

    const external = findExternalDuplicate(block, allDay, claimedIds);
    if (external) {
      claimedIds.add(external.id);
      skipped += 1;
      continue;
    }

    await apiFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    created += 1;
  }

  for (const id of unused) {
    await apiFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    );
    deleted += 1;
  }

  return {
    created,
    updated,
    deleted,
    unchanged,
    skipped,
    total: blocks.length,
    calendarUrl: calendarDayUrl(dateISO),
  };
}
