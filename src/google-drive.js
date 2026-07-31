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
const TABLE_HEADER_BG = { red: 0.93, green: 0.94, blue: 0.96 };
const TABLE_CONTENT_WIDTH_PT = 450;
const TWO_COLUMN_WIDTH_RATIO = [2, 8];

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

function getDocEndIndex(doc) {
  return doc.body?.content?.at(-1)?.endIndex ?? 1;
}

function getInsertIndex(doc) {
  return Math.max(1, getDocEndIndex(doc) - 1);
}

async function getDocument(docId) {
  return apiFetch(`https://docs.googleapis.com/v1/documents/${docId}`);
}

async function batchUpdate(docId, requests) {
  if (!requests.length) return;
  await apiFetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

function documentHasTimeboxMarkers(doc) {
  const raw = JSON.stringify(doc.body || {});
  return (
    raw.includes(SECTION_START_PREFIX) || raw.includes(SECTION_END_PREFIX)
  );
}

async function clearDocumentBody(docId) {
  const doc = await getDocument(docId);
  const endIndex = getDocEndIndex(doc);
  if (endIndex <= 2) return;

  await batchUpdate(docId, [
    {
      deleteContentRange: {
        range: {
          startIndex: 1,
          endIndex: endIndex - 1,
        },
      },
    },
  ]);

  const after = await getDocument(docId);
  const afterEnd = getDocEndIndex(after);
  if (afterEnd > 2) {
    await batchUpdate(docId, [
      {
        deleteContentRange: {
          range: { startIndex: 1, endIndex: afterEnd - 1 },
        },
      },
    ]);
  }

  const verified = await getDocument(docId);
  if (documentHasTimeboxMarkers(verified)) {
    throw new Error(
      '문서 초기화에 실패했습니다. Drive에서 Journal(v3) 문서를 삭제한 뒤 다시 저장해 주세요.'
    );
  }
}

function findLastTable(doc) {
  const tables = (doc.body?.content || []).filter((block) => block.table);
  return tables.at(-1) ?? null;
}

function getTableCellStartIndices(tableBlock) {
  const indices = [];
  const rows = tableBlock.table?.tableRows || [];

  for (const row of rows) {
    for (const cell of row.tableCells || []) {
      const block = cell.content?.[0];
      if (block?.startIndex != null) {
        indices.push(block.startIndex);
      }
    }
  }

  return indices;
}

function buildSectionPlan(dateISO, data) {
  const title = formatDateTitle(dateISO);

  const priorities = Array.isArray(data.priorities) ? data.priorities : [];
  const priorityRows = [
    ['우선순위', '내용'],
    ['1', priorities[0]?.text || ''],
    ['2', priorities[1]?.text || ''],
    ['3', priorities[2]?.text || ''],
  ];

  const todoRows = [['상태', '할 일']];
  if (!Array.isArray(data.brainDump) || data.brainDump.length === 0) {
    todoRows.push(['—', '아직 할 일이 없습니다.']);
  } else {
    data.brainDump.forEach((item) => {
      todoRows.push([item.done ? '완료' : '미완료', item.text || '']);
    });
  }

  const timelineRows = [['시간', '계획']];
  TIME_SLOTS.forEach((time) => {
    timelineRows.push([time, data.timeline?.[time]?.trim() || '']);
  });

  const memoText = data.memo?.trim() || '(메모 없음)';

  return {
    startMarker: sectionStartMarker(dateISO),
    endMarker: sectionEndMarker(dateISO),
    title,
    footer: `마지막 저장: ${new Date().toLocaleString('ko-KR')}`,
    sections: [
      {
        type: 'table',
        title: 'Top 3 우선순위',
        rows: priorityRows,
        columnWidthRatio: TWO_COLUMN_WIDTH_RATIO,
      },
      {
        type: 'table',
        title: '할 일 목록',
        rows: todoRows,
        columnWidthRatio: TWO_COLUMN_WIDTH_RATIO,
      },
      {
        type: 'table',
        title: '타임박스 (05:00 - 24:00)',
        rows: timelineRows,
        columnWidthRatio: TWO_COLUMN_WIDTH_RATIO,
      },
      { type: 'table', title: 'Brain Dump', rows: [[memoText]] },
    ],
  };
}

function buildTablePopulateRequests(rows, cellIndices) {
  const inserts = [];
  let flatIndex = 0;

  for (const row of rows) {
    for (const cell of row) {
      const text = String(cell ?? '');
      const cellIndex = cellIndices[flatIndex];
      if (text && cellIndex != null) {
        inserts.push({ cellIndex, text });
      }
      flatIndex += 1;
    }
  }

  inserts.sort((a, b) => b.cellIndex - a.cellIndex);
  return inserts.map(({ cellIndex, text }) => ({
    insertText: {
      location: { index: cellIndex },
      text,
    },
  }));
}

function buildTableHeaderStyleRequests(tableStartIndex, rows, cellIndices, columnCount) {
  if (rows.length <= 1) return [];

  const requests = [];

  for (let col = 0; col < columnCount; col += 1) {
    requests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: { index: tableStartIndex },
            rowIndex: 0,
            columnIndex: col,
          },
          rowSpan: 1,
          columnSpan: 1,
        },
        tableCellStyle: {
          backgroundColor: { color: { rgbColor: TABLE_HEADER_BG } },
        },
        fields: 'backgroundColor',
      },
    });
  }

  for (let col = 0; col < columnCount; col += 1) {
    const cellIndex = cellIndices[col];
    const text = String(rows[0][col] ?? '');
    if (!text || cellIndex == null) continue;

    requests.push({
      updateTextStyle: {
        range: {
          startIndex: cellIndex,
          endIndex: cellIndex + text.length,
        },
        textStyle: { bold: true },
        fields: 'bold',
      },
    });
  }

  return requests;
}

function getColumnWidthsPt(ratio) {
  const total = ratio.reduce((sum, part) => sum + part, 0);
  return ratio.map((part) => ({
    magnitude: (TABLE_CONTENT_WIDTH_PT * part) / total,
    unit: 'PT',
  }));
}

function buildTableColumnWidthRequests(tableStartIndex, widthsPt) {
  return widthsPt.map((width, columnIndex) => ({
    updateTableColumnProperties: {
      tableStartLocation: { index: tableStartIndex },
      columnIndices: [columnIndex],
      tableColumnProperties: {
        widthType: 'FIXED_WIDTH',
        width,
      },
      fields: 'width,widthType',
    },
  }));
}

async function insertTableSection(docId, insertIndex, rows, columnWidthRatio) {
  const rowCount = rows.length;
  const columnCount = rows[0]?.length ?? 1;

  await batchUpdate(docId, [
    {
      insertTable: {
        rows: rowCount,
        columns: columnCount,
        location: { index: insertIndex },
      },
    },
  ]);

  const doc = await getDocument(docId);
  const tableBlock = findLastTable(doc);
  if (!tableBlock) {
    throw new Error('표 생성 후 문서에서 표를 찾지 못했습니다.');
  }

  const cellIndices = getTableCellStartIndices(tableBlock);
  const expectedCells = rowCount * columnCount;
  if (cellIndices.length < expectedCells) {
    throw new Error(
      `표 셀을 읽지 못했습니다. (${cellIndices.length}/${expectedCells})`
    );
  }

  const tableStartIndex = tableBlock.startIndex;
  const populateRequests = buildTablePopulateRequests(rows, cellIndices);

  if (populateRequests.length) {
    await batchUpdate(docId, populateRequests);
  }

  if (rows.length > 1) {
    const styleRequests = buildTableHeaderStyleRequests(
      tableStartIndex,
      rows,
      cellIndices,
      columnCount
    );
    await batchUpdate(docId, styleRequests);
  }

  if (columnWidthRatio?.length === columnCount && columnCount > 1) {
    const widthRequests = buildTableColumnWidthRequests(
      tableStartIndex,
      getColumnWidthsPt(columnWidthRatio)
    );
    await batchUpdate(docId, widthRequests);
  }
}

async function insertPageBreakAtEnd(docId) {
  const doc = await getDocument(docId);
  const insertIndex = getInsertIndex(doc);
  if (insertIndex <= 1) return;

  await batchUpdate(docId, [
    {
      insertPageBreak: {
        location: { index: insertIndex },
      },
    },
  ]);
}

/**
 * 문서 끝에 날짜 섹션을 표 형식으로 append합니다.
 * @param {boolean} startOnNewPage 이전 날짜가 있으면 페이지 나눔 후 기록
 */
async function appendDateSection(docId, dateISO, data, startOnNewPage) {
  if (startOnNewPage) {
    await insertPageBreakAtEnd(docId);
  }

  const plan = buildSectionPlan(dateISO, data);
  let doc = await getDocument(docId);
  let insertIndex = getInsertIndex(doc);

  const titleStart = insertIndex + plan.startMarker.length + 1;
  await batchUpdate(docId, [
    {
      insertText: {
        location: { index: insertIndex },
        text: `${plan.startMarker}\n${plan.title}\n\n`,
      },
    },
    {
      updateParagraphStyle: {
        range: {
          startIndex: titleStart,
          endIndex: titleStart + plan.title.length,
        },
        paragraphStyle: { namedStyleType: 'HEADING_1' },
        fields: 'namedStyleType',
      },
    },
  ]);

  for (const section of plan.sections) {
    doc = await getDocument(docId);
    insertIndex = getInsertIndex(doc);
    const headingStart = insertIndex;

    await batchUpdate(docId, [
      {
        insertText: {
          location: { index: insertIndex },
          text: `${section.title}\n`,
        },
      },
      {
        updateParagraphStyle: {
          range: {
            startIndex: headingStart,
            endIndex: headingStart + section.title.length,
          },
          paragraphStyle: { namedStyleType: 'HEADING_3' },
          fields: 'namedStyleType',
        },
      },
    ]);

    if (section.type === 'table') {
      doc = await getDocument(docId);
      insertIndex = getInsertIndex(doc);
      await insertTableSection(
        docId,
        insertIndex,
        section.rows,
        section.columnWidthRatio
      );

      doc = await getDocument(docId);
      insertIndex = getInsertIndex(doc);
      await batchUpdate(docId, [
        {
          insertText: {
            location: { index: insertIndex },
            text: '\n',
          },
        },
      ]);
    }
  }

  doc = await getDocument(docId);
  insertIndex = getInsertIndex(doc);
  await batchUpdate(docId, [
    {
      insertText: {
        location: { index: insertIndex },
        text: `\n${plan.footer}\n${plan.endMarker}\n`,
      },
    },
  ]);
}

/**
 * 화면(또는 전달된) 날짜들의 최종 스냅샷만 Docs에 기록합니다.
 * 본문을 통째로 비운 뒤, 날짜 오름차순·날짜별 새 페이지·표 형식으로 다시 씁니다.
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

  await clearDocumentBody(docId);

  for (let i = 0; i < sorted.length; i += 1) {
    const { dateISO, data } = sorted[i];
    await appendDateSection(docId, dateISO, data, i > 0);
  }

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
