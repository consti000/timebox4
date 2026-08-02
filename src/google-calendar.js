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
  const { timeMin, timeMax } = dayRange(dateISO);
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
    timeMin,
    timeMax,
  });

  if (ownedOnly) {
    // timeboxDate AND 조건은 누락 이벤트를 만들 수 있어 origin만 필터하고 날짜는 timeMin/Max로 제한
    params.append('privateExtendedProperty', `timeboxOrigin=${TIMEBOX_ORIGIN}`);
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

function fingerprint(summary, start) {
  // 분 단위로 묶어 제목+시작시각 중복을 판별
  const minute = Math.floor(start.getTime() / 60_000);
  return `${normalizeSummary(summary)}|${minute}`;
}

/** 당일 전체 일정 + Timebox4 소유 일정을 한 번에 수집합니다. */
async function listPushContext(dateISO) {
  const [byProp, allDay] = await Promise.all([
    listDayEvents(dateISO, { ownedOnly: true }),
    listDayEvents(dateISO, { ownedOnly: false }),
  ]);

  const allMap = new Map();
  for (const event of allDay) {
    if (event?.id) allMap.set(event.id, event);
  }
  // ownedOnly 결과에만 있고 timeMin/Max 경계로 빠진 항목 보완
  for (const event of byProp) {
    if (event?.id) allMap.set(event.id, event);
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
    if (!event?.id || claimedIds.has(event.id)) continue;
    if (isAllDayEvent(event)) continue;
    if (normalizeSummary(event.summary) !== blockSummary) continue;

    const range = eventStartEnd(event);
    if (!range) continue;

    // 1순위: 시작 시각이 같으면 동일 일정
    if (sameInstant(range.start, block.start)) {
      return event;
    }

    // 2순위: 시간이 겹치면 후보 (더 긴/짧은 동일 제목 일정)
    if (
      !overlapMatch &&
      rangesOverlap(range.start, range.end, block.start, block.end)
    ) {
      overlapMatch = event;
    }
  }

  return overlapMatch;
}

/** Timebox4가 만든 중복(같은 제목+시작)을 남겨둘 1개만 남기고 삭제 대상으로 모읍니다. */
function collectOwnedDuplicateIds(owned, keepIds) {
  const bestByFingerprint = new Map();
  const extras = [];

  for (const event of owned) {
    if (!event?.id) continue;
    const range = eventStartEnd(event);
    if (!range) continue;
    const key = fingerprint(event.summary, range.start);
    const current = bestByFingerprint.get(key);

    if (!current) {
      bestByFingerprint.set(key, event);
      continue;
    }

    // keepIds에 있는 쪽을 우선 보존
    if (keepIds.has(event.id) && !keepIds.has(current.id)) {
      extras.push(current.id);
      bestByFingerprint.set(key, event);
    } else {
      extras.push(event.id);
    }
  }

  return extras;
}

/**
 * 타임라인 블록을 캘린더에 upsert합니다.
 * - 제목+시작(또는 겹침)으로 기존 일정을 찾아 Timebox4면 수정, 외부면 생성 생략
 * - 남은 Timebox4 고아/중복 일정은 삭제
 */
export async function pushTimelineToCalendar(dateISO, timeline) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const blocks = mergeTimelineToBlocks(dateISO, timeline);
  const { owned, allEvents } = await listPushContext(dateISO);
  const unusedOwned = new Set(owned.map((event) => event.id).filter(Boolean));
  const claimedIds = new Set();

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const block of blocks) {
    const body = buildEventBody(dateISO, block);
    const match = findExistingMatch(block, allEvents, claimedIds);

    if (match) {
      claimedIds.add(match.id);

      if (isTimeboxOwned(match)) {
        unusedOwned.delete(match.id);
        const sameSummary = (match.summary || '').trim() === block.summary;
        const range = eventStartEnd(match);
        const sameRange =
          range &&
          sameInstant(range.start, block.start) &&
          sameInstant(range.end, block.end);

        if (sameSummary && sameRange) {
          unchanged += 1;
        } else {
          await apiFetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(match.id)}`,
            { method: 'PATCH', body: JSON.stringify(body) }
          );
          updated += 1;
        }
      } else {
        // 이미 구글 캘린더에 있는 일정 → 중복 생성하지 않음
        skipped += 1;
      }
      continue;
    }

    await apiFetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    created += 1;
  }

  // 매칭되지 않은 Timebox4 일정 + 같은 제목·시작의 Timebox4 중복분 삭제
  const duplicateIds = collectOwnedDuplicateIds(owned, claimedIds);
  const toDelete = new Set();
  for (const id of unusedOwned) {
    if (!claimedIds.has(id)) toDelete.add(id);
  }
  for (const id of duplicateIds) {
    if (!claimedIds.has(id)) toDelete.add(id);
  }

  for (const id of toDelete) {
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
