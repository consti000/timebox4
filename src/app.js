import {
  todayISO,
  generateTimeSlots,
  createEmptyDayData,
  loadDayData,
  saveDayData,
  debounce,
} from './utils.js';
import {
  isGoogleConfigured,
  isAuthenticated,
  isAuthExpiredError,
  isQuotaError,
  initGoogleAuth,
  signIn,
  signOut,
  saveToGoogleDocs,
} from './google-drive.js';
import {
  pullDayToTimeline,
  pushTimelineToCalendar,
} from './google-calendar.js';

const TIME_SLOTS = generateTimeSlots(5, 24);

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
  }, 3000);
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
    showToast('.env 파일에 VITE_GOOGLE_CLIENT_ID를 설정하세요.', 'error');
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
    const result = await saveToGoogleDocs(currentDate, dayData);
    setSaveIndicator('synced', 'Google Docs 저장됨');
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status success';
    els.syncStatus.textContent = '';
    const link = document.createElement('a');
    link.href = result.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = '통합 문서 열기';
    els.syncStatus.append('✅ 일자 섹션 저장됨 — ', link);
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

async function pullFromCalendar() {
  if (!requireGoogleReady('불러오기')) {
    return { ok: false, reason: 'blocked' };
  }

  calendarAction = 'pull';
  updateGoogleButton();
  setSaveIndicator('saving', '캘린더 불러오는 중...');

  try {
    const snapshot = { ...dayData.timeline };
    const result = await pullDayToTimeline(currentDate, snapshot);
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
    persistLocal();
    renderTimeline();
    setSaveIndicator('synced', '캘린더 불러옴');
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status success';
    els.syncStatus.textContent = `✅ 빈 슬롯 ${filled}개에 캘린더 일정을 반영했습니다.`;
    return { ok: true, timeline: merged, filled, eventCount: result.eventCount };
  } catch (err) {
    if (isAuthExpiredError(err)) {
      handleAuthExpired();
      return { ok: false, reason: 'auth_expired' };
    }
    setSaveIndicator('', '불러오기 실패');
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status error';
    els.syncStatus.textContent = `❌ ${err.message}`;
    return { ok: false, reason: 'error', message: err.message };
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
    els.syncStatus.append(
      `✅ 생성 ${result.created} · 수정 ${result.updated} · 삭제 ${result.deleted} · 유지 ${result.unchanged} — `,
      link
    );
    return { ok: true, ...result };
  } catch (err) {
    if (isAuthExpiredError(err)) {
      handleAuthExpired();
      return { ok: false, reason: 'auth_expired' };
    }
    setSaveIndicator('', '보내기 실패');
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status error';
    els.syncStatus.textContent = `❌ ${err.message}`;
    return { ok: false, reason: 'error', message: err.message };
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
  els.brainDumpList.replaceChildren();
  els.emptyTodo.hidden = dayData.brainDump.length > 0;

  dayData.brainDump.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = `check-list-item${item.done ? ' done' : ''}`;

    const checkboxId = `todo-check-${item.id ?? index}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = checkboxId;
    checkbox.checked = item.done;
    checkbox.addEventListener('change', () => {
      updateDayData((d) => {
        d.brainDump[index].done = checkbox.checked;
      });
      li.classList.toggle('done', checkbox.checked);
    });

    const label = document.createElement('label');
    label.htmlFor = checkboxId;
    label.textContent = item.text;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.title = '삭제';
    deleteBtn.setAttribute('aria-label', `${item.text} 삭제`);
    deleteBtn.addEventListener('click', () => {
      updateDayData((d) => {
        d.brainDump.splice(index, 1);
      });
      renderBrainDump();
    });

    li.append(checkbox, label, deleteBtn);
    els.brainDumpList.appendChild(li);
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

function renderAll() {
  renderPriorities();
  renderBrainDump();
  renderTimeline();
  renderMemo();
}

function updateGoogleButton() {
  els.manualSaveBtn.hidden = false;

  const busy = isSaving || Boolean(calendarAction);

  if (!isGoogleConfigured()) {
    els.googleAuthBtn.textContent = 'Google 로그인';
    els.googleAuthBtn.disabled = true;
    els.manualSaveBtn.disabled = true;
    els.manualSaveBtn.textContent = '구글 닥스에 저장';
    els.calendarPullBtn.disabled = true;
    els.calendarPushBtn.disabled = true;
    return;
  }

  els.googleAuthBtn.disabled = busy;
  els.manualSaveBtn.disabled = busy;
  els.manualSaveBtn.textContent = isSaving ? '저장 중...' : '구글 닥스에 저장';
  els.calendarPullBtn.disabled = busy;
  els.calendarPushBtn.disabled = busy;
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

function exportToExcelFriendlyCsv() {
  const rows = [];
  rows.push(['날짜', currentDate]);
  rows.push([]);
  rows.push(['Top 3 우선순위']);
  dayData.priorities.forEach((item, index) => {
    rows.push([`${index + 1}`, item.text || '']);
  });
  rows.push([]);
  rows.push(['할 일 목록']);
  if (dayData.brainDump.length === 0) {
    rows.push(['(항목 없음)']);
  } else {
    dayData.brainDump.forEach((item) => {
      rows.push([item.done ? '완료' : '미완료', item.text || '']);
    });
  }
  rows.push([]);
  rows.push(['타임박스']);
  TIME_SLOTS.forEach((slot) => {
    rows.push([slot, dayData.timeline[slot] || '']);
  });
  rows.push([]);
  rows.push(['Brain Dump 메모', dayData.memo || '']);

  const csv = rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`)
        .join(',')
    )
    .join('\n');

  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `timebox4-${currentDate}.csv`;
  link.click();
  URL.revokeObjectURL(url);
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
      showToast('.env 파일에 VITE_GOOGLE_CLIENT_ID를 설정하세요.', 'error');
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
      await signIn();
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
      showToast('Google Docs 통합 문서에 저장되었습니다.', 'success');
    } else if (result.reason === 'busy') {
      showToast('저장 중입니다. 잠시 후 최신 내용이 반영됩니다.');
    } else if (result.reason === 'error') {
      showToast(result.message || 'Google Docs 저장에 실패했습니다.', 'error');
    }
  });

  els.calendarPullBtn.addEventListener('click', async () => {
    const result = await pullFromCalendar();
    if (result.ok) {
      showToast(
        result.filled > 0
          ? `캘린더에서 ${result.filled}개 슬롯을 채웠습니다.`
          : '채울 빈 슬롯이 없거나 가져올 일정이 없습니다.',
        'success'
      );
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
    } else if (result.reason === 'error') {
      showToast(result.message || '캘린더 보내기에 실패했습니다.', 'error');
    }
  });

  els.excelExportBtn.addEventListener('click', () => {
    exportToExcelFriendlyCsv();
    showToast('엑셀용 CSV를 다운로드했습니다.', 'success');
  });
}

export function initApp() {
  els.dateInput = $('date-input');
  els.prioritiesList = $('priorities-list');
  els.brainDumpForm = $('brain-dump-form');
  els.brainDumpInput = $('brain-dump-input');
  els.brainDumpList = $('brain-dump-list');
  els.emptyTodo = $('empty-todo');
  els.timelineGrid = $('timeline-grid');
  els.timelineResetBtn = $('timeline-reset-btn');
  els.memoInput = $('memo-input');
  els.googleAuthBtn = $('google-auth-btn');
  els.syncStatus = $('sync-status');
  els.saveIndicator = $('save-indicator');
  els.manualSaveBtn = $('manual-save-btn');
  els.calendarPullBtn = $('calendar-pull-btn');
  els.calendarPushBtn = $('calendar-push-btn');
  els.excelExportBtn = $('excel-export-btn');
  els.toast = $('toast');

  dayData = loadDayData(currentDate);
  els.dateInput.value = currentDate;

  renderAll();
  bindEvents();
  updateGoogleButton();

  if (!isGoogleConfigured()) {
    els.syncStatus.hidden = false;
    els.syncStatus.className = 'sync-status';
    els.syncStatus.textContent =
      'VITE_GOOGLE_CLIENT_ID를 .env에 설정하면 Google Docs·Calendar 연동을 사용할 수 있습니다.';
    showToast(
      'VITE_GOOGLE_CLIENT_ID를 .env에 설정하면 Google Docs·Calendar 연동을 사용할 수 있습니다.'
    );
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
