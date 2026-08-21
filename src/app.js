import {
  todayISO,
  formatDateDisplay,
  dateWindowAround,
  generateTimeSlots,
  createEmptyDayData,
  loadDayData,
  saveDayData,
  debounce,
  addRecurringTodo,
  removeRecurringTodo,
  mergeTodosForDate,
  formatRepeatRange,
} from './utils.js';
import {
  isGoogleConfigured,
  getGoogleSetupHint,
  getGoogleSetupSteps,
  isAuthenticated,
  isAuthExpiredError,
  isScopeError,
  isQuotaError,
  formatGoogleApiError,
  initGoogleAuth,
  signIn,
  signOut,
  resignInWithCalendarConsent,
  saveToGoogleDocs,
} from './google-drive.js';
import {
  pullDayToTimeline,
  pushTimelineToCalendar,
} from './google-calendar.js';

const TIME_SLOTS = generateTimeSlots(5, 24);
const DATE_STRIP_RADIUS = 4;
const WEEKDAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

let currentDate = todayISO();
let dayData = createEmptyDayData();
let isSaving = false;
let calendarAction = null; // 'pull' | 'push' | null

const els = {};

function $(id) {
  return document.getElementById(id);
}

function showToast(message, type = '') {
  const toast = els.toast;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.hidden = true;
  }, type === 'error' ? 6000 : 3000);
}

function showSyncError(err) {
  const formatted = formatGoogleApiError(err);
  setSaveIndicator('', '실패');
  els.syncStatus.hidden = false;
  els.syncStatus.className = 'sync-status error';
  els.syncStatus.replaceChildren();
  els.syncStatus.append(`❌ ${formatted.message}`);
  if (formatted.helpUrl) {
    els.syncStatus.append(' ');
    const link = document.createElement('a');
    link.href = formatted.helpUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'API 사용 설정 열기';
    els.syncStatus.appendChild(link);
  }
  return formatted;
}

function setSaveIndicator(state, text) {
  els.saveIndicator.className = `save-indicator ${state}`;
  els.saveIndicator.textContent = text;
}

function persistLocal() {
  saveDayData(currentDate, dayData);
  setSaveIndicator('', '로컬 저장됨');
}

const debouncedPersist = debounce(persistLocal, 400);

function updateDayData(mutator) {
  mutator(dayData);
  debouncedPersist();
}

function handleAuthExpired() {
  updateGoogleButton();
  setSaveIndicator('', '다시 로그인 필요');
  els.syncStatus.hidden = false;
  els.syncStatus.className = 'sync-status error';
  els.syncStatus.textContent = '세션이 만료되었습니다. Google 다시 로그인해 주세요.';
  showToast('세션이 만료되었습니다. Google 다시 로그인해 주세요.', 'error');
}

function requireGoogleReady(actionLabel) {
  if (!isGoogleConfigured()) {
    renderGoogleSetupNotice();
    showToast(getGoogleSetupHint(), 'error');
    return false;
  }
  if (!isAuthenticated()) {
    showToast(`먼저 Google 로그인 후 ${actionLabel}하세요.`, 'error');
    return false;
  }
  if (isSaving || calendarAction) {
    showToast('다른 작업이 진행 중입니다. 완료될 때까지 기다려 주세요.');
    return false;
  }
  return true;
}

async function syncToGoogle() {
  if (!isAuthenticated()) {
    return { ok: false, reason: 'unauthenticated' };
  }

  if (isSaving || calendarAction) {
    return { ok: false, reason: 'busy' };
  }

  isSaving = true;
  updateGoogleButton();
  setSaveIndicator('saving', 'Google Docs 저장 중...');

  try {
    debouncedPersist.cancel?.();
    persistLocal();

    const stripDates = dateWindowAround(currentDate, DATE_STRIP_RADIUS);
    const entries = stripDates.map((dateISO) => {
      const data = dateISO === currentDate ? dayData : loadDayData(dateISO);
      return {
        dateISO,
        data: {
          ...data,
          brainDump: mergeTodosForDate(dateISO, data),
        },
      };
    });

    const result = await saveToGoogleDocs(entries);
    setSaveIndicator('synced', 'Google Docs 저장됨');
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status success';
    els.syncStatus.textContent = '';
    const link = document.createElement('a');
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '통합 문서 열기';
    const count = result.savedDates?.length ?? entries.length;
    const preserved = result.preservedDates?.length ?? 0;
    const preservedMsg =
      preserved > 0 ? ` · 이전 ${preserved}일 유지` : '';
    els.syncStatus.append(
      `✅ 화면 ${count}일 갱신${preservedMsg} · 날짜순 저장 — `,
      link
    );
    return { ok: true, url: result.url };
  } catch (err) {
    if (isAuthExpiredError(err)) {
      handleAuthExpired();
      return { ok: false, reason: 'auth_expired' };
    }
    setSaveIndicator('', '저장 실패');
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status error';
    els.syncStatus.textContent = `❌ ${err.message}`;
    return {
      ok: false,
      reason: 'error',
      message: isQuotaError(err)
        ? 'Google Docs 저장 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'
        : err.message,
    };
  } finally {
    isSaving = false;
    updateGoogleButton();
  }
}

/**
 * 클릭 직후(사용자 제스처 안)에서만 토큰을 조용히 갱신합니다.
 * 노트북은 API 실패 뒤 늦게 consent 팝업을 띄우면 차단되는 경우가 많습니다.
 */
async function refreshTokenInUserGesture() {
  await signIn({ forceConsent: false });
  updateGoogleButton();
}

function showCalendarScopeRecovery(action) {
  const formatted = formatGoogleApiError(
    Object.assign(new Error('캘린더 권한 부족'), { code: 'SCOPE_INSUFFICIENT' })
  );
  setSaveIndicator('', '캘린더 권한 필요');
  els.syncStatus.hidden = false;
  els.syncStatus.className = 'sync-status error';
  els.syncStatus.replaceChildren();
  els.syncStatus.append(`❌ ${formatted.message} `);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary sync-reauth-btn';
  btn.textContent = '권한 허용 후 다시 시도';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      showToast('동의 화면에서 Google Calendar를 허용해 주세요.');
      await resignInWithCalendarConsent();
      updateGoogleButton();
      const result =
        action === 'push' ? await pushToCalendar() : await pullFromCalendar();
      if (result.ok) {
        if (action === 'pull') {
          const parts = [];
          if (result.filled > 0) parts.push(`슬롯 ${result.filled}개`);
          if (result.todosAdded > 0) parts.push(`할 일 ${result.todosAdded}건`);
          showToast(
            parts.length > 0
              ? `캘린더에서 ${parts.join(', ')}을(를) 반영했습니다.`
              : '반영할 새 일정이 없습니다.',
            'success'
          );
        } else {
          showToast(
            `캘린더에 반영했습니다. (생성 ${result.created}, 수정 ${result.updated}, 삭제 ${result.deleted})`,
            'success'
          );
        }
      } else if (result.reason === 'error' || result.reason === 'scope') {
        showToast(result.message || '캘린더 동기화에 실패했습니다.', 'error');
      }
    } catch (authErr) {
      const f = showSyncError(authErr);
      showToast(f.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
  els.syncStatus.appendChild(btn);
  return formatted;
}

async function pullFromCalendar() {
  if (!requireGoogleReady('불러오기')) {
    return { ok: false, reason: 'blocked' };
  }

  calendarAction = 'pull';
  updateGoogleButton();
  setSaveIndicator('saving', '캘린더 불러오는 중...');

  try {
    await refreshTokenInUserGesture();

    const snapshot = { ...dayData.timeline };
    const result = await pullDayToTimeline(
      currentDate,
      snapshot,
      dayData.brainDump
    );
    // 요청 중 로컬에서 입력한 내용은 유지하고, 빈 슬롯만 캘린더 값으로 채움
    const merged = { ...result.timeline };
    for (const [slot, text] of Object.entries(dayData.timeline)) {
      if (text?.trim()) {
        merged[slot] = text;
      }
    }
    const filled = Object.keys(merged).filter(
      (slot) => merged[slot]?.trim() && !snapshot[slot]?.trim()
    ).length;
    dayData.timeline = merged;
    dayData.brainDump = result.brainDump;
    persistLocal();
    renderTimeline();
    renderBrainDump();
    setSaveIndicator('synced', '캘린더 불러옴');
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status success';
    const todoMsg =
      result.todosAdded > 0
        ? ` 종일 일정 ${result.todosAdded}건을 할 일 목록에 추가했습니다.`
        : '';
    els.syncStatus.textContent = `✅ 빈 슬롯 ${filled}개에 캘린더 일정을 반영했습니다.${todoMsg}`;
    return {
      ok: true,
      timeline: merged,
      filled,
      todosAdded: result.todosAdded,
      eventCount: result.eventCount,
    };
  } catch (err) {
    if (isScopeError(err)) {
      const formatted = showCalendarScopeRecovery('pull');
      return { ok: false, reason: 'scope', message: formatted.message };
    }
    if (isAuthExpiredError(err)) {
      handleAuthExpired();
      return { ok: false, reason: 'auth_expired' };
    }
    const formatted = showSyncError(err);
    return { ok: false, reason: 'error', message: formatted.message };
  } finally {
    calendarAction = null;
    updateGoogleButton();
  }
}

async function pushToCalendar() {
  if (!requireGoogleReady('보내기')) {
    return { ok: false, reason: 'blocked' };
  }

  calendarAction = 'push';
  updateGoogleButton();
  setSaveIndicator('saving', '캘린더로 보내는 중...');

  try {
    await refreshTokenInUserGesture();

    debouncedPersist.cancel?.();
    persistLocal();
    const result = await pushTimelineToCalendar(currentDate, dayData.timeline);
    setSaveIndicator('synced', '캘린더 반영됨');
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status success';
    els.syncStatus.textContent = '';
    const link = document.createElement('a');
    link.href = result.calendarUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '캘린더 열기';
    const skippedPart =
      result.skipped > 0 ? ` · 중복생략 ${result.skipped}` : '';
    els.syncStatus.append(
      `✅ 생성 ${result.created} · 수정 ${result.updated} · 삭제 ${result.deleted} · 유지 ${result.unchanged}${skippedPart} — `,
      link
    );
    return { ok: true, ...result };
  } catch (err) {
    if (isScopeError(err)) {
      const formatted = showCalendarScopeRecovery('push');
      return { ok: false, reason: 'scope', message: formatted.message };
    }
    if (isAuthExpiredError(err)) {
      handleAuthExpired();
      return { ok: false, reason: 'auth_expired' };
    }
    const formatted = showSyncError(err);
    return { ok: false, reason: 'error', message: formatted.message };
  } finally {
    calendarAction = null;
    updateGoogleButton();
  }
}

function switchDate(newDateISO) {
  if (!newDateISO) return false;

  debouncedPersist.cancel?.();
  saveDayData(currentDate, dayData);
  currentDate = newDateISO;
  dayData = loadDayData(currentDate);

  els.dateInput.value = currentDate;
  renderAll();
  setSaveIndicator('', '로컬 저장됨');
  els.syncStatus.hidden = true;

  return true;
}

function renderPriorities() {
  els.prioritiesList.replaceChildren();

  dayData.priorities.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'priority-item';

    const rank = document.createElement('span');
    rank.className = 'rank-badge';
    rank.textContent = String(index + 1);

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = `우선순위 ${index + 1}`;
    input.value = item.text;
    input.setAttribute('aria-label', `우선순위 ${index + 1}`);
    input.addEventListener('input', () => {
      updateDayData((d) => {
        d.priorities[index].text = input.value;
      });
    });

    li.append(rank, input);
    els.prioritiesList.appendChild(li);
  });
}

function renderBrainDump() {
  const todos = mergeTodosForDate(currentDate, dayData);
  els.brainDumpList.replaceChildren();
  els.emptyTodo.hidden = todos.length > 0;

  todos.forEach((item) => {
    const li = document.createElement('li');
    li.className = `check-list-item${item.done ? ' done' : ''}`;

    const checkboxId = `todo-check-${item.id ?? item.recurringId}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = checkboxId;
    checkbox.checked = item.done;
    checkbox.addEventListener('change', () => {
      setTodoDone(item, checkbox.checked);
      li.classList.toggle('done', checkbox.checked);
    });

    const label = document.createElement('label');
    label.htmlFor = checkboxId;
    label.textContent = item.text;

    if (item.recurringId != null) {
      const badge = document.createElement('span');
      badge.className = 'todo-repeat-badge';
      badge.textContent = formatRepeatRange(item.startDate, item.endDate);
      badge.title = '기간 반복 할 일';
      li.append(checkbox, label, badge);
    } else {
      li.append(checkbox, label);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = item.recurringId != null ? '반복 할 일 전체 삭제' : '삭제';
    deleteBtn.setAttribute(
      'aria-label',
      item.recurringId != null ? `${item.text} 반복 삭제` : `${item.text} 삭제`
    );
    deleteBtn.addEventListener('click', () => {
      deleteTodo(item);
      renderBrainDump();
    });

    li.appendChild(deleteBtn);
    els.brainDumpList.appendChild(li);
  });
}

function setTodoDone(item, done) {
  updateDayData((d) => {
    if (item.recurringId != null) {
      const idx = d.brainDump.findIndex((todo) => todo.recurringId === item.recurringId);
      if (idx >= 0) {
        d.brainDump[idx].done = done;
      } else {
        d.brainDump.push({
          text: item.text,
          done,
          id: Date.now() + Math.random(),
          recurringId: item.recurringId,
        });
      }
      return;
    }
    const idx = d.brainDump.findIndex((todo) => todo.id === item.id);
    if (idx >= 0) d.brainDump[idx].done = done;
  });
}

function deleteTodo(item) {
  if (item.recurringId != null) {
    removeRecurringTodo(item.recurringId);
    updateDayData((d) => {
      d.brainDump = d.brainDump.filter((todo) => todo.recurringId !== item.recurringId);
    });
    showToast('반복 할 일을 기간에서 삭제했습니다.');
    return;
  }
  updateDayData((d) => {
    d.brainDump = d.brainDump.filter((todo) => todo.id !== item.id);
  });
}

function renderTimeline() {
  els.timelineGrid.replaceChildren();

  TIME_SLOTS.forEach((time) => {
    const slot = document.createElement('div');
    slot.className = 'timeline-slot';

    const timeLabel = document.createElement('span');
    timeLabel.className = 'timeline-time';
    timeLabel.textContent = time;

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = '—';
    input.value = dayData.timeline[time] || '';
    input.addEventListener('input', () => {
      updateDayData((d) => {
        if (input.value.trim()) {
          d.timeline[time] = input.value;
        } else {
          delete d.timeline[time];
        }
      });
    });

    slot.append(timeLabel, input);
    els.timelineGrid.appendChild(slot);
  });
}

function renderMemo() {
  els.memoInput.value = dayData.memo;
}

function parseLocalDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function renderDateStrip() {
  const today = todayISO();
  const dates = dateWindowAround(currentDate, DATE_STRIP_RADIUS);

  els.dateStrip.replaceChildren();

  dates.forEach((iso) => {
    const date = parseLocalDate(iso);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'date-chip';
    if (iso === today) btn.classList.add('is-today');
    if (iso === currentDate) btn.classList.add('is-selected');
    btn.setAttribute('aria-label', formatDateDisplay(iso));
    if (iso === currentDate) btn.setAttribute('aria-current', 'date');

    const weekday = document.createElement('span');
    weekday.className = 'date-chip-weekday';
    weekday.textContent = WEEKDAY_SHORT[date.getDay()];

    const day = document.createElement('span');
    day.className = 'date-chip-day';
    day.textContent = String(date.getDate());

    btn.append(weekday, day);
    btn.addEventListener('click', () => {
      if (iso !== currentDate) switchDate(iso);
    });

    els.dateStrip.appendChild(btn);
  });
}

function renderAll() {
  renderDateStrip();
  renderPriorities();
  renderBrainDump();
  renderTimeline();
  renderMemo();
}

function renderGoogleSetupNotice() {
  if (!els.googleSetupNotice) return;

  if (!isGoogleConfigured()) {
    els.googleSetupNotice.hidden = false;
    els.googleSetupHint.textContent = getGoogleSetupHint();
    if (els.googleSetupSteps) {
      els.googleSetupSteps.replaceChildren();
      getGoogleSetupSteps().forEach((step) => {
        const li = document.createElement('li');
        li.textContent = step;
        els.googleSetupSteps.appendChild(li);
      });
    }
  } else {
    els.googleSetupNotice.hidden = true;
  }
}

function updateGoogleButton() {
  els.manualSaveBtn.hidden = false;
  renderGoogleSetupNotice();

  const busy = isSaving || Boolean(calendarAction);
  const ready = isGoogleConfigured() && isAuthenticated();

  if (!isGoogleConfigured()) {
    els.googleAuthBtn.textContent = 'Google 로그인';
    els.googleAuthBtn.disabled = busy;
    els.googleAuthBtn.classList.remove('connected');
    els.manualSaveBtn.disabled = true;
    els.manualSaveBtn.textContent = '구글 닥스에 저장';
    els.calendarPullBtn.disabled = true;
    els.calendarPushBtn.disabled = true;
    return;
  }

  els.googleAuthBtn.disabled = busy;
  els.manualSaveBtn.disabled = busy || !ready;
  els.manualSaveBtn.textContent = isSaving ? '저장 중...' : '구글 닥스에 저장';
  els.calendarPullBtn.disabled = busy || !ready;
  els.calendarPushBtn.disabled = busy || !ready;
  els.calendarPullBtn.textContent =
    calendarAction === 'pull' ? '불러오는 중...' : '캘린더 불러오기';
  els.calendarPushBtn.textContent =
    calendarAction === 'push' ? '보내는 중...' : '캘린더 보내기';

  if (isAuthenticated()) {
    els.googleAuthBtn.textContent = 'Google 로그아웃';
    els.googleAuthBtn.classList.add('connected');
  } else {
    els.googleAuthBtn.textContent = 'Google 로그인';
    els.googleAuthBtn.classList.remove('connected');
  }
}

function bindEvents() {
  els.dateInput.addEventListener('change', () => {
    const next = els.dateInput.value;
    if (!next) {
      els.dateInput.value = currentDate;
      return;
    }
    switchDate(next);
  });

  els.brainDumpForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.brainDumpInput.value.trim();
    if (!text) return;

    const startDate = els.todoRepeatStart?.value;
    const endDate = els.todoRepeatEnd?.value;
    if (startDate || endDate) {
      const added = addRecurringTodo({
        text,
        startDate: startDate || currentDate,
        endDate: endDate || currentDate,
      });
      if (!added) {
        showToast('반복 기간이 올바르지 않습니다.', 'error');
        return;
      }
      els.brainDumpInput.value = '';
      renderBrainDump();
      showToast(
        `${formatRepeatRange(added.startDate, added.endDate)} 동안 반복 표시합니다.`,
        'success'
      );
      return;
    }

    updateDayData((d) => {
      d.brainDump.push({ text, done: false, id: Date.now() });
    });
    els.brainDumpInput.value = '';
    renderBrainDump();
  });

  els.memoInput.addEventListener('input', () => {
    updateDayData((d) => {
      d.memo = els.memoInput.value;
    });
  });

  els.timelineResetBtn.addEventListener('click', () => {
    updateDayData((d) => {
      d.timeline = {};
    });
    renderTimeline();
    showToast('타임박스를 초기화했습니다.');
  });

  els.googleAuthBtn.addEventListener('click', async () => {
    if (!isGoogleConfigured()) {
      renderGoogleSetupNotice();
      els.googleSetupNotice?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      showToast(getGoogleSetupHint(), 'error');
      return;
    }

    if (isAuthenticated()) {
      signOut();
      updateGoogleButton();
      els.syncStatus.hidden = true;
      showToast('Google 연결이 해제되었습니다.');
      return;
    }

    try {
      await signIn({ forceConsent: true });
      updateGoogleButton();
      showToast(
        'Google 계정에 연결되었습니다. Docs 저장 또는 캘린더 동기화를 사용할 수 있습니다.',
        'success'
      );
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  els.manualSaveBtn.addEventListener('click', async () => {
    if (!requireGoogleReady('저장')) return;

    const result = await syncToGoogle();
    if (result.ok) {
      showToast('화면 날짜는 갱신하고, Docs의 이전 날짜 기록은 유지한 채 저장했습니다.', 'success');
    } else if (result.reason === 'busy') {
      showToast('저장 중입니다. 잠시 후 최신 내용이 반영됩니다.');
    } else if (result.reason === 'error') {
      showToast(result.message || 'Google Docs 저장에 실패했습니다.', 'error');
    }
  });

  els.todoRepeatClearBtn?.addEventListener('click', () => {
    if (els.todoRepeatStart) els.todoRepeatStart.value = '';
    if (els.todoRepeatEnd) els.todoRepeatEnd.value = '';
    showToast('기간 반복 날짜를 초기화했습니다.');
  });

  els.calendarPullBtn.addEventListener('click', async () => {
    const result = await pullFromCalendar();
    if (result.ok) {
      const parts = [];
      if (result.filled > 0) parts.push(`슬롯 ${result.filled}개`);
      if (result.todosAdded > 0) parts.push(`할 일 ${result.todosAdded}건`);
      showToast(
        parts.length > 0
          ? `캘린더에서 ${parts.join(', ')}을(를) 반영했습니다.`
          : '반영할 새 일정이 없습니다.',
        'success'
      );
    } else if (result.reason === 'scope') {
      showToast('캘린더 권한이 필요합니다. 아래 버튼을 눌러 허용해 주세요.', 'error');
    } else if (result.reason === 'error') {
      showToast(result.message || '캘린더 불러오기에 실패했습니다.', 'error');
    }
  });

  els.calendarPushBtn.addEventListener('click', async () => {
    const result = await pushToCalendar();
    if (result.ok) {
      showToast(
        `캘린더에 반영했습니다. (생성 ${result.created}, 수정 ${result.updated}, 삭제 ${result.deleted})`,
        'success'
      );
    } else if (result.reason === 'scope') {
      showToast('캘린더 권한이 필요합니다. 아래 버튼을 눌러 허용해 주세요.', 'error');
    } else if (result.reason === 'error') {
      showToast(result.message || '캘린더 보내기에 실패했습니다.', 'error');
    }
  });
}

export function initApp() {
  els.dateInput = $('date-input');
  els.dateStrip = $('date-strip');
  els.prioritiesList = $('priorities-list');
  els.brainDumpForm = $('brain-dump-form');
  els.brainDumpInput = $('brain-dump-input');
  els.brainDumpList = $('brain-dump-list');
  els.emptyTodo = $('empty-todo');
  els.todoRepeatStart = $('todo-repeat-start');
  els.todoRepeatEnd = $('todo-repeat-end');
  els.todoRepeatClearBtn = $('todo-repeat-clear-btn');
  els.timelineGrid = $('timeline-grid');
  els.timelineResetBtn = $('timeline-reset-btn');
  els.memoInput = $('memo-input');
  els.googleAuthBtn = $('google-auth-btn');
  els.googleSetupNotice = $('google-setup-notice');
  els.googleSetupHint = $('google-setup-hint');
  els.googleSetupSteps = $('google-setup-steps');
  els.syncStatus = $('sync-status');
  els.saveIndicator = $('save-indicator');
  els.manualSaveBtn = $('manual-save-btn');
  els.calendarPullBtn = $('calendar-pull-btn');
  els.calendarPushBtn = $('calendar-push-btn');
  els.toast = $('toast');

  dayData = loadDayData(currentDate);
  els.dateInput.value = currentDate;

  renderAll();
  bindEvents();
  updateGoogleButton();

  if (!isGoogleConfigured()) {
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status';
    els.syncStatus.textContent = getGoogleSetupHint();
    showToast(getGoogleSetupHint());
  } else {
    initGoogleAuth(
      () => {
        updateGoogleButton();
      },
      (err) => {
        console.warn('Google auth init:', err);
        els.syncStatus.hidden = false;
        els.syncStatus.className = 'sync-status error';
        els.syncStatus.textContent =
          typeof err === 'string'
            ? err
            : 'Google 인증 초기화에 실패했습니다. 페이지를 새로고침해 주세요.';
        showToast(
          typeof err === 'string'
            ? err
            : 'Google 인증 초기화에 실패했습니다.',
          'error'
        );
      }
    );
  }
}
