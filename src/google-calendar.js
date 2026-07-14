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
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '2500',
  });

  if (ownedOnly) {
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

/**
 * Fill empty timeline slots from external (non-timebox4) calendar events.
 * Existing local text is preserved.
 */
export async function pullDayToTimeline(dateISO, timeline) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const events = await listDayEvents(dateISO, { ownedOnly: false });
  const next = { ...timeline };
  let filled = 0;

  for (const event of events) {
    if (isTimeboxOwned(event)) continue;
    if (!event.start?.dateTime || !event.end?.dateTime) continue;

    const summary = (event.summary || '(제목 없음)').trim();
    if (!summary) continue;

    const start = new Date(event.start.dateTime);
    const end = new Date(event.end.dateTime);
    const slots = slotsCoveredByRange(dateISO, start, end);

    for (const slot of slots) {
      if (next[slot]?.trim()) continue;
      next[slot] = summary;
      filled += 1;
    }
  }

  return { timeline: next, filled, eventCount: events.length };
}

/**
 * Upsert timebox4-owned calendar events from timeline blocks.
 */
export async function pushTimelineToCalendar(dateISO, timeline) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const blocks = mergeTimelineToBlocks(dateISO, timeline);
  const existing = await listDayEvents(dateISO, { ownedOnly: true });
  const unused = new Set(existing.map((event) => event.id));

  const byRange = new Map();
  for (const event of existing) {
    if (!event.start?.dateTime || !event.end?.dateTime) continue;
    const key = eventRangeKey(
      normalizeEventDateTime(event.start.dateTime),
      normalizeEventDateTime(event.end.dateTime)
    );
    byRange.set(key, event);
  }

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let unchanged = 0;

  for (const block of blocks) {
    const key = eventRangeKey(
      normalizeEventDateTime(block.startRfc),
      normalizeEventDateTime(block.endRfc)
    );
    const match = byRange.get(key);
    const body = buildEventBody(dateISO, block);

    if (match) {
      unused.delete(match.id);
      if ((match.summary || '') === block.summary) {
        unchanged += 1;
      } else {
        await apiFetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(match.id)}`,
          { method: 'PATCH', body: JSON.stringify(body) }
        );
        updated += 1;
      }
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
    total: blocks.length,
    calendarUrl: `https://calendar.google.com/calendar/r/day/${dateISO.replaceAll('-', '/')}`,
  };
}
