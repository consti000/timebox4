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
  isScopeError,
  isQuotaError,
  formatGoogleApiError,
  initGoogleAuth,
  signIn,
  signOut,
  resignInWithCalendarConsent,
} from './google-auth.js';

const FOLDER_NAME = 'TimeBox4 Planner';
const MASTER_DOC_NAME = 'Timebox Planner Journal(v3)';
const MASTER_DOC_ID_KEY = 'timebox4_master_doc_id_v3';
const SECTION_START_PREFIX = '[[TIMEBOX_START:';
const SECTION_END_PREFIX = '[[TIMEBOX_END:';
const TIME_SLOTS = generateTimeSlots(5, 24);
const TABLE_HEADER_BG = '#edeef5';
/**
 * 2열 표 첫 열 너비.
 * Docs HTML 변환은 colgroup/%를 무시해 균등(~50%)이 되므로,
 * 업로드 후 Docs API로 FIXED_WIDTH를 적용합니다. (기존 균등폭의 약 25%)
 * 둘째 열은 (본문 가용 폭 − 첫 열)로 확대해 표가 페이지 폭을 다시 채우게 합니다.
 */
const NARROW_FIRST_COL_PT = 58;
const NARROW_FIRST_COL_PCT = 12;
const WIDE_SECOND_COL_PCT = 88;
/** documentStyle을 못 읽을 때 쓰는 기본 본문 폭 (US Letter 여백≈1") */
const DEFAULT_TWO_COL_TABLE_WIDTH_PT = 468;

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

/** 캡처처럼 2글자 헤더는 글자 사이 공백을 넣습니다. (내용→내 용, 시간→시 간) */
function formatSpreadHeaderLabel(label) {
  const text = String(label || '').trim();
  if (text.length === 2 && !text.includes(' ')) {
    return `${text[0]} ${text[1]}`;
  }
  return text;
}

function renderTableHtml(headers, rows, columnWidths) {
  const widths =
    columnWidths?.length === headers.length
      ? columnWidths
      : headers.map(() => Math.floor(100 / Math.max(headers.length, 1)));

  const twoCol = headers.length === 2;
  const displayHeaders = headers.map(formatSpreadHeaderLabel);

  const colgroup = `<colgroup>${widths
    .map((w, i) => {
      const pt =
        twoCol && i === 0 ? `${NARROW_FIRST_COL_PT}pt` : `${w}%`;
      return `<col width="${pt}" style="width:${pt}">`;
    })
    .join('')}</colgroup>`;

  const horizontalAlign = (index, isHeader) => {
    if (twoCol) {
      return isHeader || index === 0 ? 'center' : 'left';
    }
    return isHeader ? 'center' : 'left';
  };

  const cellStyle = (index, isHeader) => {
    const w = widths[index] ?? '';
    const widthCss =
      twoCol && index === 0
        ? `width:${NARROW_FIRST_COL_PT}pt`
        : `width:${w}%`;
    const align = horizontalAlign(index, isHeader);
    return `border:1px solid #ccc;padding:6px;${widthCss};text-align:${align};vertical-align:middle`;
  };

  const cellWidthAttr = (index) => {
    if (twoCol && index === 0) return `${NARROW_FIRST_COL_PT}pt`;
    return `${widths[index]}%`;
  };

  const head = `<tr style="background:${TABLE_HEADER_BG}">${displayHeaders
    .map(
      (h, i) =>
        `<th width="${cellWidthAttr(i)}" style="${cellStyle(i, true)}">${escapeHtml(h)}</th>`
    )
    .join('')}</tr>`;

  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map(
            (cell, i) =>
              `<td width="${cellWidthAttr(i)}" style="${cellStyle(i, false)}">${escapeHtml(cell)}</td>`
          )
          .join('')}</tr>`
    )
    .join('');

  return `<table style="border-collapse:collapse;table-layout:fixed;width:100%;margin:8px 0 16px">${colgroup}${head}${body}</table>`;
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
  const narrowTwoCol = [NARROW_FIRST_COL_PCT, WIDE_SECOND_COL_PCT];

  return [
    `<p>${escapeHtml(sectionStartMarker(dateISO))}</p>`,
    `<h1>${escapeHtml(title)}</h1>`,
    `<h3>Top 3 우선순위</h3>`,
    renderTableHtml(['우선순위', '내용'], priorityRows, narrowTwoCol),
    `<h3>할 일 목록</h3>`,
    renderTableHtml(['상태', '할 일'], todoRows, narrowTwoCol),
    `<h3>타임박스 (05:00 - 24:00)</h3>`,
    renderTableHtml(['시간', '계획'], timelineRows, narrowTwoCol),
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

async function batchUpdateChunked(docId, requests, chunkSize = 400) {
  for (let i = 0; i < requests.length; i += chunkSize) {
    await batchUpdate(docId, requests.slice(i, i + chunkSize));
  }
}

function getCellParagraphRange(cell) {
  for (const block of cell?.content || []) {
    if (
      block.paragraph &&
      typeof block.startIndex === 'number' &&
      typeof block.endIndex === 'number' &&
      block.endIndex > block.startIndex
    ) {
      return { startIndex: block.startIndex, endIndex: block.endIndex };
    }
  }
  return null;
}

function paragraphAlignmentRequest(range, alignment) {
  return {
    updateParagraphStyle: {
      range,
      paragraphStyle: { alignment },
      fields: 'alignment',
    },
  };
}

function cellVerticalAlignRequest(tableStartIndex, rowIndex, columnIndex) {
  return {
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: {
          tableStartLocation: { index: tableStartIndex },
          rowIndex,
          columnIndex,
        },
        rowSpan: 1,
        columnSpan: 1,
      },
      tableCellStyle: { contentAlignment: 'MIDDLE' },
      fields: 'contentAlignment',
    },
  };
}

/**
 * HTML 변환 후에도 표 셀 정렬이 풀리는 경우가 있어 Docs API로 재적용합니다.
 * - 2열: 헤더·첫 열 가운데, 둘째 열 본문 왼쪽
 * - 1열(Brain Dump): 헤더 가운데, 본문 왼쪽
 */
function buildTableFormattingRequests(doc) {
  const requests = [];

  for (const el of doc.body?.content || []) {
    if (!el.table || el.startIndex == null) continue;
    const rows = el.table.tableRows || [];
    const colCount =
      el.table.columns ?? rows[0]?.tableCells?.length ?? 0;
    if (colCount !== 1 && colCount !== 2) continue;

    rows.forEach((row, rowIndex) => {
      row.tableCells?.forEach((cell, colIndex) => {
        const range = getCellParagraphRange(cell);
        if (!range) return;

        let alignment = 'START';
        if (colCount === 1) {
          alignment = rowIndex === 0 ? 'CENTER' : 'START';
        } else if (rowIndex === 0 || colIndex === 0) {
          alignment = 'CENTER';
        }

        requests.push(paragraphAlignmentRequest(range, alignment));
        requests.push(
          cellVerticalAlignRequest(el.startIndex, rowIndex, colIndex)
        );
      });
    });
  }

  return requests;
}

async function applyTableFormatting(docId) {
  const doc = await getDocument(docId);
  const requests = buildTableFormattingRequests(doc);
  if (requests.length) {
    await batchUpdateChunked(docId, requests);
  }
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
 * 문서 본문 가용 폭(페이지 폭 − 좌우 여백). 표가 width:100%일 때의 목표 총폭.
 */
function getDocumentContentWidthPt(doc) {
  const style = doc?.documentStyle || {};
  const pageW = style.pageSize?.width?.magnitude;
  const marginL =
    typeof style.marginLeft?.magnitude === 'number'
      ? style.marginLeft.magnitude
      : 72;
  const marginR =
    typeof style.marginRight?.magnitude === 'number'
      ? style.marginRight.magnitude
      : 72;

  if (
    typeof pageW === 'number' &&
    pageW - marginL - marginR >= NARROW_FIRST_COL_PT + 40
  ) {
    return pageW - marginL - marginR;
  }
  return DEFAULT_TWO_COL_TABLE_WIDTH_PT;
}

function fixedColumnWidthRequest(tableStartIndex, columnIndex, widthPt) {
  return {
    updateTableColumnProperties: {
      tableStartLocation: { index: tableStartIndex },
      columnIndices: [columnIndex],
      tableColumnProperties: {
        widthType: 'FIXED_WIDTH',
        width: { magnitude: widthPt, unit: 'PT' },
      },
      fields: 'widthType,width',
    },
  };
}

/**
 * 2열 표(우선순위/상태/시간)의 첫 열을 좁히고,
 * 줄인 만큼 둘째 열을 넓혀 표 전체 너비는 본문 폭으로 복원합니다.
 *
 * 주의: 현재 열 합을 쓰면 안 됩니다. 첫 열만 줄인 뒤 Docs는 둘째 열을
 * 늘리지 않고 표 총폭을 줄이므로, 줄어든 합으로 재계산하면 둘째 열이 그대로입니다.
 */
async function narrowTwoColumnTableFirstCols(docId) {
  const doc = await getDocument(docId);
  const contentWidth = getDocumentContentWidthPt(doc);
  const requests = [];

  for (const el of doc.body?.content || []) {
    if (!el.table || el.startIndex == null) continue;
    const colCount =
      el.table.columns ??
      el.table.tableRows?.[0]?.tableCells?.length ??
      0;
    if (colCount !== 2) continue;

    const total = contentWidth;
    const first = Math.min(NARROW_FIRST_COL_PT, total - 40);
    const second = Math.max(total - first, 40);

    // 둘째 열을 먼저 본문 폭 기준으로 넓힌 뒤, 첫 열을 좁힙니다.
    requests.push(
      fixedColumnWidthRequest(el.startIndex, 1, second),
      fixedColumnWidthRequest(el.startIndex, 0, first)
    );
  }

  if (requests.length) {
    await batchUpdate(docId, requests);
  }
}

/**
 * Docs에 이미 있는 날짜 섹션을 HTML에서 추출합니다.
 * @returns {Map<string, string>} dateISO → 섹션 HTML 조각
 */
function extractExistingSectionsFromHtml(html) {
  const map = new Map();
  if (!html || typeof html !== 'string') return map;

  const startRe = /\[\[TIMEBOX_START:(\d{4}-\d{2}-\d{2})\]\]/g;
  const matches = [...html.matchAll(startRe)];

  for (const match of matches) {
    const dateISO = match[1];
    const startMarkerPos = match.index ?? -1;
    if (startMarkerPos < 0) continue;

    const endMarker = sectionEndMarker(dateISO);
    const endMarkerPos = html.indexOf(endMarker, startMarkerPos);
    if (endMarkerPos === -1) continue;

    let from = startMarkerPos;
    for (let i = startMarkerPos; i >= 0 && startMarkerPos - i < 800; i -= 1) {
      if (
        html.startsWith('<p', i) ||
        html.startsWith('<h1', i) ||
        html.startsWith('<div', i)
      ) {
        from = i;
        break;
      }
    }

    let to = endMarkerPos + endMarker.length;
    const closeP = html.indexOf('</p>', to);
    if (closeP !== -1 && closeP - to < 40) {
      to = closeP + 4;
    }

    let fragment = html.slice(from, to).trim();
    fragment = fragment.replace(/^(?:<hr\b[^>]*>\s*)+/i, '');
    if (fragment) {
      map.set(dateISO, fragment);
    }
  }

  return map;
}

async function exportDocumentHtml(docId) {
  try {
    return await apiFetch(
      `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=${encodeURIComponent('text/html')}`,
      { responseType: 'text' }
    );
  } catch {
    return '';
  }
}

/**
 * 화면 날짜는 새 내용으로 덮어쓰고, Docs에만 있는 이전 날짜 섹션은 그대로 유지합니다.
 */
function buildMergedJournalHtml(entries, existingSections) {
  const sectionMap = new Map(existingSections);

  for (const { dateISO, data } of entries) {
    sectionMap.set(dateISO, buildDateSectionHtml(dateISO, data));
  }

  const dates = [...sectionMap.keys()].sort((a, b) => a.localeCompare(b));
  const parts = dates.map((dateISO, index) => {
    const pageBreakHint =
      index > 0
        ? '<hr style="page-break-before:always;border:none;margin:0;height:0">\n'
        : '';
    return pageBreakHint + sectionMap.get(dateISO);
  });

  return {
    html: `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Timebox Planner Journal</title></head>
<body>
${parts.join('\n')}
</body>
</html>`,
    dates,
    preservedDates: dates.filter(
      (dateISO) => !entries.some((entry) => entry.dateISO === dateISO)
    ),
  };
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
 * 화면 날짜 스트립 자료를 Docs에 반영합니다.
 * 문서에 이미 있는 스트립 밖(오래된) 날짜 섹션은 유지하고, 스트립 날짜만 최신으로 덮어씁니다.
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

  const sortedEntries = [...list].sort((a, b) =>
    a.dateISO.localeCompare(b.dateISO)
  );
  const docId = await resolveMasterDoc();

  const existingHtml = await exportDocumentHtml(docId);
  const existingSections = extractExistingSectionsFromHtml(existingHtml);
  const { html, dates, preservedDates } = buildMergedJournalHtml(
    sortedEntries,
    existingSections
  );

  await replaceDocumentWithHtml(docId, html);
  await insertPageBreaksBetweenDates(docId, dates);
  await narrowTwoColumnTableFirstCols(docId);
  await applyTableFormatting(docId);

  const finalDoc = await getDocument(docId);
  const raw = JSON.stringify(finalDoc.body || {});
  for (const { dateISO } of sortedEntries) {
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
    savedDates: sortedEntries.map((entry) => entry.dateISO),
    preservedDates,
    totalDates: dates,
  };
}
