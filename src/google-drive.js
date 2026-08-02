import { generateTimeSlots } from './utils.js';
import {
  apiFetch,
  createAuthExpiredError,
  isAuthenticated,
  onSignOut,
} from './google-auth.js';

export {
  isGoogleConfigured,
  getGoogleSetupHint,
  getGoogleSetupSteps,
  isAuthenticated,
  isAuthExpiredError,
  isQuotaError,
  formatGoogleApiError,
  initGoogleAuth,
  signIn,
  signOut,
} from './google-auth.js';

const FOLDER_NAME = 'TimeBox4 Planner';
const MASTER_DOC_NAME = 'Timebox Planner Journal(v3)';
const MASTER_DOC_ID_KEY = 'timebox4_master_doc_id_v3';
const SECTION_START_PREFIX = '[[TIMEBOX_START:';
const SECTION_END_PREFIX = '[[TIMEBOX_END:';
const TIME_SLOTS = generateTimeSlots(5, 24);
const TABLE_HEADER_BG = '#edeef5';

let folderId = null;
let masterDocId = null;

onSignOut(() => {
  folderId = null;
  masterDocId = null;
});

async function ensureFolder() {
  if (folderId) return folderId;

  const query = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const list = await apiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`
  );

  if (list.files?.length > 0) {
    folderId = list.files[0].id;
    return folderId;
  }

  const created = await apiFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  folderId = created.id;
  return folderId;
}

async function listMasterDocs(parentId) {
  const query = encodeURIComponent(
    `name='${MASTER_DOC_NAME}' and '${parentId}' in parents and trashed=false`
  );
  return apiFetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=createdTime desc&fields=files(id,name,createdTime)`
  );
}

function getStoredMasterDocId() {
  try {
    return localStorage.getItem(MASTER_DOC_ID_KEY);
  } catch {
    return null;
  }
}

function setStoredMasterDocId(docId) {
  try {
    localStorage.setItem(MASTER_DOC_ID_KEY, docId);
  } catch {
    // localStorage unavailable
  }
}

function clearStoredMasterDocId() {
  try {
    localStorage.removeItem(MASTER_DOC_ID_KEY);
  } catch {
    // localStorage unavailable
  }
}

async function verifyMasterDocExists(docId) {
  try {
    const file = await apiFetch(
      `https://www.googleapis.com/drive/v3/files/${docId}?fields=id,trashed`
    );
    return Boolean(file?.id && !file.trashed);
  } catch {
    return false;
  }
}

async function trashDuplicateJournals(keepId, files) {
  const duplicates = files.filter((file) => file.id !== keepId);
  for (const file of duplicates) {
    await apiFetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ trashed: true }),
    });
  }
}

async function resolveMasterDoc() {
  const parent = await ensureFolder();
  const list = await listMasterDocs(parent);
  const files = list.files || [];

  if (files.length > 0) {
    const canonical = files[0];
    masterDocId = canonical.id;
    setStoredMasterDocId(canonical.id);
    if (files.length > 1) {
      await trashDuplicateJournals(canonical.id, files);
    }
    return masterDocId;
  }

  if (masterDocId && (await verifyMasterDocExists(masterDocId))) {
    setStoredMasterDocId(masterDocId);
    return masterDocId;
  }

  const storedId = getStoredMasterDocId();
  if (storedId && (await verifyMasterDocExists(storedId))) {
    masterDocId = storedId;
    return masterDocId;
  }
  if (storedId) {
    clearStoredMasterDocId();
  }

  const created = await apiFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    body: JSON.stringify({
      name: MASTER_DOC_NAME,
      mimeType: 'application/vnd.google-apps.document',
      parents: [parent],
    }),
  });

  masterDocId = created.id;
  setStoredMasterDocId(created.id);
  return masterDocId;
}

function sectionStartMarker(dateISO) {
  return `${SECTION_START_PREFIX}${dateISO}]]`;
}

function sectionEndMarker(dateISO) {
  return `${SECTION_END_PREFIX}${dateISO}]]`;
}

function formatDateTitle(dateISO) {
  const [y, m, d] = dateISO.split('-');
  return `${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderTableHtml(headers, rows, columnWidths) {
  const colgroup = columnWidths?.length
    ? `<colgroup>${columnWidths
        .map((w) => `<col style="width:${w}%">`)
        .join('')}</colgroup>`
    : '';

  const head = `<tr style="background:${TABLE_HEADER_BG}">${headers
    .map((h) => `<th style="border:1px solid #ccc;padding:6px;text-align:left">${escapeHtml(h)}</th>`)
    .join('')}</tr>`;

  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell) =>
              `<td style="border:1px solid #ccc;padding:6px;vertical-align:top">${escapeHtml(cell)}</td>`
          )
          .join('')}</tr>`
    )
    .join('');

  return `<table style="border-collapse:collapse;width:100%;margin:8px 0 16px">${colgroup}${head}${body}</table>`;
}

function buildDateSectionHtml(dateISO, data) {
  const title = formatDateTitle(dateISO);
  const priorities = Array.isArray(data.priorities) ? data.priorities : [];
  const priorityRows = [
    ['1', priorities[0]?.text || ''],
    ['2', priorities[1]?.text || ''],
    ['3', priorities[2]?.text || ''],
  ];

  let todoRows;
  if (!Array.isArray(data.brainDump) || data.brainDump.length === 0) {
    todoRows = [['—', '아직 할 일이 없습니다.']];
  } else {
    todoRows = data.brainDump.map((item) => [
      item.done ? '완료' : '미완료',
      item.text || '',
    ]);
  }

  const timelineRows = TIME_SLOTS.map((time) => [
    time,
    data.timeline?.[time]?.trim() || '',
  ]);

  const memoText = data.memo?.trim() || '(메모 없음)';
  const footer = `마지막 저장: ${new Date().toLocaleString('ko-KR')}`;

  return [
    `<p>${escapeHtml(sectionStartMarker(dateISO))}</p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<h3>Top 3 우선순위</h3>`,
    renderTableHtml(['우선순위', '내용'], priorityRows, [20, 80]),
    `<h3>할 일 목록</h3>`,
    renderTableHtml(['상태', '할 일'], todoRows, [20, 80]),
    `<h3>타임박스 (05:00 - 24:00)</h3>`,
    renderTableHtml(['시간', '계획'], timelineRows, [20, 80]),
    `<h3>Brain Dump</h3>`,
    renderTableHtml(['내용'], [[memoText]]),
    `<p>${escapeHtml(footer)}</p>`,
    `<p>${escapeHtml(sectionEndMarker(dateISO))}</p>`,
  ].join('\n');
}

function getParagraphText(block) {
  if (!block?.paragraph?.elements) return '';
  return block.paragraph.elements
    .map((el) => el.textRun?.content || '')
    .join('');
}

function findParagraphStartIndex(doc, exactText) {
  const target = exactText.trim();
  for (const block of doc.body?.content || []) {
    if (!block.paragraph || block.startIndex == null) continue;
    if (getParagraphText(block).trim() === target) {
      return block.startIndex;
    }
  }
  return null;
}

async function batchUpdate(docId, requests) {
  if (!requests.length) return;
  await apiFetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

/**
 * HTML 변환은 CSS page-break를 무시하는 경우가 많아,
 * 업로드 후 Docs API로 두 번째 날짜부터 START 마커 앞에 페이지 나누기를 넣습니다.
 * (호출 1~2회라 저장 시간은 거의 늘지 않음)
 */
async function insertPageBreaksBetweenDates(docId, dateISOs) {
  if (dateISOs.length < 2) return;

  const doc = await getDocument(docId);
  const indices = [];

  for (let i = 1; i < dateISOs.length; i += 1) {
    const marker = sectionStartMarker(dateISOs[i]);
    const index =
      findParagraphStartIndex(doc, marker) ??
      findParagraphStartIndex(doc, formatDateTitle(dateISOs[i]));
    if (index != null) {
      indices.push(index);
    }
  }

  if (!indices.length) return;

  // 뒤에서부터 삽입해야 앞쪽 인덱스가 밀리지 않음
  indices.sort((a, b) => b - a);
  await batchUpdate(
    docId,
    indices.map((index) => ({
      insertPageBreak: { location: { index } },
    }))
  );
}

/**
 * 9일 자료를 하나의 HTML로 만들고 Drive multipart 업로드로
 * Google Doc 본문을 한 번에 교체합니다 (Docs API 표 삽입 반복 대비 대폭 빠름).
 */
function buildJournalHtml(entries) {
  const sections = entries.map((entry, index) => {
    // Drive HTML 변환용 힌트(실제 분리는 insertPageBreaksBetweenDates가 담당)
    const pageBreakHint =
      index > 0
        ? '<hr style="page-break-before:always;border:none;margin:0;height:0">\n'
        : '';
    return pageBreakHint + buildDateSectionHtml(entry.dateISO, entry.data);
  });

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Timebox Planner Journal</title></head>
<body>
${sections.join('\n')}
</body>
</html>`;
}

async function replaceDocumentWithHtml(docId, html) {
  const boundary = `timebox4_${Date.now().toString(36)}`;
  const metadata = JSON.stringify({
    mimeType: 'application/vnd.google-apps.document',
  });

  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
    `${html}\r\n` +
    `--${boundary}--`;

  await apiFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${docId}?uploadType=multipart`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
}

async function getDocument(docId) {
  return apiFetch(`https://docs.googleapis.com/v1/documents/${docId}`);
}

/**
 * 화면(또는 전달된) 날짜들의 최종 스냅샷만 Docs에 기록합니다.
 * HTML 변환 업로드로 전체 문서를 한 번에 교체한 뒤, 날짜별 페이지 나누기를 적용합니다.
 * @param {Array<{ dateISO: string, data: object }>} entries
 */
export async function saveToGoogleDocs(entries) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    throw new Error('저장할 날짜 자료가 없습니다.');
  }

  const sorted = [...list].sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  const docId = await resolveMasterDoc();
  const html = buildJournalHtml(sorted);

  await replaceDocumentWithHtml(docId, html);
  await insertPageBreaksBetweenDates(
    docId,
    sorted.map((entry) => entry.dateISO)
  );

  const finalDoc = await getDocument(docId);
  const raw = JSON.stringify(finalDoc.body || {});
  for (const { dateISO } of sorted) {
    if (
      !raw.includes(sectionStartMarker(dateISO)) ||
      !raw.includes(sectionEndMarker(dateISO)) ||
      !raw.includes(formatDateTitle(dateISO))
    ) {
      throw new Error(
        `${dateISO} 섹션 저장 검증에 실패했습니다. 다시 저장해 주세요.`
      );
    }
  }

  return {
    docId,
    url: `https://docs.google.com/document/d/${docId}/edit`,
    savedDates: sorted.map((entry) => entry.dateISO),
  };
}
