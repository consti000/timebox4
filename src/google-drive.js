import { generateTimeSlots } from './utils.js';
import {
  apiFetch,
  createAuthExpiredError,
  isAuthenticated,
  onSignOut,
} from './google-auth.js';

export {
  isGoogleConfigured,
  isAuthenticated,
  isAuthExpiredError,
  isQuotaError,
  initGoogleAuth,
  signIn,
  signOut,
} from './google-auth.js';

const FOLDER_NAME = 'TimeBox4 Planner';
const MASTER_DOC_NAME = 'TimeBox4 Planner Journal';
const MASTER_DOC_ID_KEY = 'timebox4_master_doc_id';
const SECTION_START_PREFIX = '[[TIMEBOX_START:';
const SECTION_END_PREFIX = '[[TIMEBOX_END:';
const TIME_SLOTS = generateTimeSlots(5, 24);
const TABLE_HEADER_BG = { red: 0.93, green: 0.94, blue: 0.96 };
const TITLE_BRAND_PREFIX = 'Timebox4';
const TITLE_BRAND_FONT = 'Times New Roman';
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

function getParagraphText(block) {
  if (!block?.paragraph?.elements) return '';
  return block.paragraph.elements
    .map((el) => el.textRun?.content || '')
    .join('');
}

function getDocEndIndex(doc) {
  return doc.body?.content?.at(-1)?.endIndex ?? 1;
}

function getInsertIndex(doc) {
  return Math.max(1, getDocEndIndex(doc) - 1);
}

function isSectionStartParagraph(text) {
  const trimmed = text.trim();
  return trimmed.startsWith(SECTION_START_PREFIX) && trimmed.endsWith(']]');
}

function findAllDateSectionRanges(doc, dateISO) {
  const targetStart = sectionStartMarker(dateISO);
  const targetEnd = sectionEndMarker(dateISO);
  const content = doc.body?.content || [];
  const paragraphs = [];

  for (const block of content) {
    if (!block.paragraph) continue;
    paragraphs.push({
      startIndex: block.startIndex,
      endIndex: block.endIndex,
      text: getParagraphText(block).trim(),
    });
  }

  const ranges = [];

  for (let i = 0; i < paragraphs.length; i += 1) {
    if (paragraphs[i].text !== targetStart) continue;

    const startIndex = paragraphs[i].startIndex;
    let endIndex = null;

    for (let j = i + 1; j < paragraphs.length; j += 1) {
      const text = paragraphs[j].text;
      if (text === targetEnd) {
        endIndex = paragraphs[j].endIndex;
        break;
      }
      if (isSectionStartParagraph(text)) {
        endIndex = paragraphs[j].startIndex;
        break;
      }
    }

    if (endIndex == null) {
      endIndex = getDocEndIndex(doc) - 1;
    }

    if (endIndex > startIndex) {
      ranges.push({ startIndex, endIndex });
    }
  }

  return ranges;
}

async function deleteAllDateSections(docId, ranges) {
  if (!ranges.length) return;

  const sorted = [...ranges].sort((a, b) => b.startIndex - a.startIndex);
  const requests = sorted.map((range) => ({
    deleteContentRange: { range },
  }));

  await batchUpdate(docId, requests);
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
  const [y, m, d] = dateISO.split('-');
  const title = `Timebox4 — ${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;

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

function buildTitleBrandStyleRequest(titleStart) {
  const brandEnd = titleStart + TITLE_BRAND_PREFIX.length;
  return {
    updateTextStyle: {
      range: {
        startIndex: titleStart,
        endIndex: brandEnd,
      },
      textStyle: {
        bold: true,
        weightedFontFamily: { fontFamily: TITLE_BRAND_FONT },
      },
      fields: 'bold,weightedFontFamily',
    },
  };
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

async function upsertDateSection(docId, dateISO, data) {
  const plan = buildSectionPlan(dateISO, data);
  let doc = await getDocument(docId);
  const existingRanges = findAllDateSectionRanges(doc, dateISO);
  let insertIndex;

  if (existingRanges.length > 0) {
    insertIndex = Math.min(...existingRanges.map((range) => range.startIndex));
    await deleteAllDateSections(docId, existingRanges);
  } else {
    insertIndex = getInsertIndex(doc);
    if (insertIndex > 1) {
      await batchUpdate(docId, [
        {
          insertText: {
            location: { index: insertIndex },
            text: '\n',
          },
        },
      ]);
      doc = await getDocument(docId);
      insertIndex = getInsertIndex(doc);
    }
  }

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
        paragraphStyle: { namedStyleType: 'HEADING_2' },
        fields: 'namedStyleType',
      },
    },
    buildTitleBrandStyleRequest(titleStart),
  ]);

  doc = await getDocument(docId);
  insertIndex = getInsertIndex(doc);

  for (const section of plan.sections) {
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

    doc = await getDocument(docId);
    insertIndex = getInsertIndex(doc);

    if (section.type === 'table') {
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
      doc = await getDocument(docId);
      insertIndex = getInsertIndex(doc);
    }
  }

  await batchUpdate(docId, [
    {
      insertText: {
        location: { index: insertIndex },
        text: `\n${plan.footer}\n${plan.endMarker}\n\n`,
      },
    },
  ]);
}

export async function saveToGoogleDocs(dateISO, data) {
  if (!isAuthenticated()) {
    throw createAuthExpiredError();
  }

  const docId = await resolveMasterDoc();
  await upsertDateSection(docId, dateISO, data);

  return {
    docId,
    url: `https://docs.google.com/document/d/${docId}/edit`,
  };
}
