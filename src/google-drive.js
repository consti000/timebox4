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
/** 손상된 v2와 분리된 새 통합 문서 */
const MASTER_DOC_NAME = 'Timebox Planner Journal(v3)';
const MASTER_DOC_ID_KEY = 'timebox4_master_doc_id_v3';
const SECTION_START_PREFIX = '[[TIMEBOX_START:';
const SECTION_END_PREFIX = '[[TIMEBOX_END:';
const TIME_SLOTS = generateTimeSlots(5, 24);
const TITLE_BRAND_PREFIX = 'Timebox4';
const TITLE_BRAND_FONT = 'Times New Roman';

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

/**
 * 마커 탐색에 의존하지 않고 본문 전체를 비웁니다.
 * (표 안에 마커가 숨어도 삭제되도록 index 1부터 지움)
 */
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

function buildSectionPlainText(dateISO, data) {
  const [y, m, d] = dateISO.split('-');
  const title = `Timebox4 — ${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;
  const startMarker = sectionStartMarker(dateISO);
  const endMarker = sectionEndMarker(dateISO);
  const footer = `마지막 저장: ${new Date().toLocaleString('ko-KR')}`;

  const priorities = Array.isArray(data.priorities) ? data.priorities : [];
  const priorityLines = [1, 2, 3]
    .map((n) => `${n}. ${priorities[n - 1]?.text?.trim() || '(없음)'}`)
    .join('\n');

  let todoLines;
  if (!Array.isArray(data.brainDump) || data.brainDump.length === 0) {
    todoLines = '- 아직 할 일이 없습니다.';
  } else {
    todoLines = data.brainDump
      .map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text || ''}`)
      .join('\n');
  }

  const timelineLines = TIME_SLOTS.map((time) => {
    const plan = data.timeline?.[time]?.trim() || '';
    return plan ? `${time}  ${plan}` : `${time}`;
  }).join('\n');

  const memoText = data.memo?.trim() || '(메모 없음)';

  const body = [
    startMarker,
    title,
    '',
    '■ Top 3 우선순위',
    priorityLines,
    '',
    '■ 할 일 목록',
    todoLines,
    '',
    '■ 타임박스 (05:00 - 24:00)',
    timelineLines,
    '',
    '■ Brain Dump',
    memoText,
    '',
    footer,
    endMarker,
    '',
    '',
  ].join('\n');

  return { text: body, title, startMarker };
}

/** 문서 끝에 날짜 섹션 한 개를 텍스트로 append합니다. */
async function appendDateSection(docId, dateISO, data) {
  const { text, title, startMarker } = buildSectionPlainText(dateISO, data);
  const doc = await getDocument(docId);
  const insertIndex = getInsertIndex(doc);
  const titleStart = insertIndex + startMarker.length + 1;

  await batchUpdate(docId, [
    {
      insertText: {
        location: { index: insertIndex },
        text,
      },
    },
    {
      updateParagraphStyle: {
        range: {
          startIndex: titleStart,
          endIndex: titleStart + title.length,
        },
        paragraphStyle: { namedStyleType: 'HEADING_2' },
        fields: 'namedStyleType',
      },
    },
    buildTitleBrandStyleRequest(titleStart),
  ]);
}

/**
 * 화면(또는 전달된) 날짜들의 최종 스냅샷만 Docs에 기록합니다.
 * 본문을 통째로 비운 뒤, 날짜 오름차순으로 문서 끝에만 다시 씁니다.
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

  for (const { dateISO, data } of sorted) {
    await appendDateSection(docId, dateISO, data);
  }

  const finalDoc = await getDocument(docId);
  for (const { dateISO } of sorted) {
    const raw = JSON.stringify(finalDoc.body || {});
    if (
      !raw.includes(sectionStartMarker(dateISO)) ||
      !raw.includes(sectionEndMarker(dateISO))
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
