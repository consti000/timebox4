const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const AUTH_EXPIRED = 'AUTH_EXPIRED';
const SCOPE_INSUFFICIENT = 'SCOPE_INSUFFICIENT';
const QUOTA_RETRY_DELAY_MS = 45000;
const QUOTA_MAX_RETRIES = 2;
const PLACEHOLDER_CLIENT_ID = 'your-client-id.apps.googleusercontent.com';

let accessToken = null;
let grantedScope = '';
let tokenClient = null;
const signOutListeners = new Set();

export function getGoogleClientId() {
  const raw = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

export function isGoogleConfigured() {
  const clientId = getGoogleClientId();
  if (!clientId) return false;
  if (
    clientId === PLACEHOLDER_CLIENT_ID ||
    clientId.includes('your-client-id')
  ) {
    return false;
  }
  return clientId.endsWith('.apps.googleusercontent.com');
}

export function isProductionDeploy() {
  return Boolean(import.meta.env.PROD);
}

export function getGoogleSetupHint() {
  if (isGoogleConfigured()) return '';

  const clientId = getGoogleClientId();
  if (isProductionDeploy()) {
    if (!clientId || clientId.includes('your-client-id')) {
      return 'GitHub 저장소 Secrets에 VITE_GOOGLE_CLIENT_ID를 추가한 뒤 다시 배포하세요.';
    }
    return 'VITE_GOOGLE_CLIENT_ID 형식을 확인하세요. (xxxx.apps.googleusercontent.com)';
  }

  if (!clientId) {
    return '프로젝트 루트에 .env 파일을 만들고 VITE_GOOGLE_CLIENT_ID를 설정하세요. (.env.example 참고)';
  }
  if (clientId.includes('your-client-id')) {
    return '.env의 VITE_GOOGLE_CLIENT_ID에 실제 OAuth Client ID를 넣고 npm run dev를 재시작하세요.';
  }
  return 'VITE_GOOGLE_CLIENT_ID 형식을 확인하세요. (xxxx.apps.googleusercontent.com)';
}

export function getGoogleSetupSteps() {
  if (isProductionDeploy()) {
    return [
      'GitHub 저장소 Settings → Secrets and variables → Actions에서 VITE_GOOGLE_CLIENT_ID를 추가합니다.',
      'Google Cloud Console에서 Drive·Docs·Calendar API를 사용 설정합니다.',
      'OAuth 웹 클라이언트 ID를 발급하고 승인된 JavaScript 원본에 https://consti000.github.io 를 추가합니다.',
      'Secrets 저장 후 Actions에서 Deploy to GitHub Pages를 다시 실행합니다.',
    ];
  }

  return [
    '.env.example을 복사해 프로젝트 루트에 .env를 만듭니다.',
    'Google Cloud Console에서 Drive·Docs·Calendar API를 사용 설정합니다.',
    'OAuth 웹 클라이언트 ID를 발급하고 승인된 JavaScript 원본에 http://localhost:5173 을 추가합니다. (127.0.0.1 사용 금지)',
    'VITE_GOOGLE_CLIENT_ID에 Client ID를 넣고 npm run dev를 재시작합니다.',
    '캘린더가 안 되면 Google 로그아웃 후 다시 로그인하며 캘린더 권한에 동의하세요.',
  ];
}

export function isAuthenticated() {
  return Boolean(accessToken);
}

export function isAuthExpiredError(err) {
  return Boolean(err && err.code === AUTH_EXPIRED);
}

export function isScopeError(err) {
  if (err?.code === SCOPE_INSUFFICIENT) return true;
  const raw = err?.message || '';
  return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|PERMISSION_DENIED|Request had insufficient authentication scopes/i.test(
    raw
  );
}

export function isQuotaError(err) {
  return Boolean(err && /quota exceeded/i.test(err.message || ''));
}

export function createAuthExpiredError() {
  const err = new Error('세션이 만료되었습니다. Google 다시 로그인해 주세요.');
  err.code = AUTH_EXPIRED;
  return err;
}

export function createScopeError(message) {
  const err = new Error(
    message ||
      '캘린더 권한이 없습니다. Google 로그아웃 후 다시 로그인하면서 캘린더 접근을 허용해 주세요.'
  );
  err.code = SCOPE_INSUFFICIENT;
  return err;
}

function hasCalendarScope(scopeStr) {
  const scopes = String(scopeStr || '').split(/[\s,]+/).filter(Boolean);
  return scopes.some(
    (scope) =>
      scope === 'https://www.googleapis.com/auth/calendar.events' ||
      scope === 'https://www.googleapis.com/auth/calendar'
  );
}

/**
 * Google API 원문 오류를 사용자용 한국어 안내로 바꿉니다.
 * @returns {{ message: string, helpUrl: string | null, code?: string }}
 */
export function formatGoogleApiError(err) {
  const raw = err?.message || String(err || '알 수 없는 오류');

  if (isScopeError(err) || /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(raw)) {
    return {
      message:
        '이 브라우저/계정에는 캘린더 권한이 없습니다. Google 로그아웃 후 다시 로그인할 때 캘린더 권한에 동의해 주세요. (모바일에서만 되는 경우, 노트북에서 예전에 Docs만 허용한 로그인일 때가 많습니다.)',
      helpUrl: null,
      code: SCOPE_INSUFFICIENT,
    };
  }

  if (/origin_mismatch|The given origin is not allowed/i.test(raw)) {
    return {
      message:
        '접속 주소가 Google OAuth 허용 목록과 다릅니다. localhost는 http://localhost:5173 으로 열어 주세요. (127.0.0.1 은 실패할 수 있습니다.)',
      helpUrl: 'https://console.cloud.google.com/apis/credentials',
      code: 'ORIGIN_MISMATCH',
    };
  }

  const apiDisabled =
    /has not been used in project|is disabled|accessNotConfigured/i.test(raw);

  const projectMatch =
    raw.match(/[?&]project=(\d+)/i) ||
    raw.match(/project[/ ](\d+)/i) ||
    raw.match(/project (\d+)/i);
  const projectId = projectMatch?.[1] || '';

  if (
    apiDisabled &&
    /calendar-json\.googleapis\.com|Google Calendar API/i.test(raw)
  ) {
    const helpUrl = projectId
      ? `https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=${projectId}`
      : 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';
    return {
      message:
        'Google Calendar API가 Cloud 프로젝트에서 켜져 있지 않습니다. 아래 링크에서 API를 사용 설정한 뒤 1~2분 기다렸다가 다시 시도해 주세요.',
      helpUrl,
      code: 'API_NOT_ENABLED',
    };
  }

  if (apiDisabled && /docs\.googleapis\.com|Google Docs API/i.test(raw)) {
    const helpUrl = projectId
      ? `https://console.developers.google.com/apis/api/docs.googleapis.com/overview?project=${projectId}`
      : 'https://console.cloud.google.com/apis/library/docs.googleapis.com';
    return {
      message:
        'Google Docs API가 Cloud 프로젝트에서 켜져 있지 않습니다. 아래 링크에서 API를 사용 설정한 뒤 다시 시도해 주세요.',
      helpUrl,
      code: 'API_NOT_ENABLED',
    };
  }

  if (apiDisabled && /drive\.googleapis\.com|Google Drive API/i.test(raw)) {
    const helpUrl = projectId
      ? `https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=${projectId}`
      : 'https://console.cloud.google.com/apis/library/drive.googleapis.com';
    return {
      message:
        'Google Drive API가 Cloud 프로젝트에서 켜져 있지 않습니다. 아래 링크에서 API를 사용 설정한 뒤 다시 시도해 주세요.',
      helpUrl,
      code: 'API_NOT_ENABLED',
    };
  }

  if (/Failed to fetch|NetworkError|Load failed|network/i.test(raw)) {
    return {
      message:
        '네트워크 오류로 Google에 연결하지 못했습니다. 광고 차단/추적 방지 확장 프로그램을 끄거나, 시크릿 창에서 다시 시도해 주세요.',
      helpUrl: null,
      code: 'NETWORK',
    };
  }

  return { message: raw, helpUrl: null };
}

export function onSignOut(listener) {
  signOutListeners.add(listener);
  return () => signOutListeners.delete(listener);
}

export function initGoogleAuth(onSuccess, onError) {
  const clientId = getGoogleClientId();
  if (!isGoogleConfigured()) {
    onError?.(getGoogleSetupHint());
    return;
  }

  let attempts = 0;
  const tryInit = () => {
    if (!window.google?.accounts?.oauth2) {
      attempts += 1;
      if (attempts > 50) {
        onError?.('Google Identity Services를 불러오지 못했습니다.');
        return;
      }
      setTimeout(tryInit, 100);
      return;
    }

    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: (response) => {
        if (response.error) {
          onError?.(response.error_description || response.error);
          return;
        }
        accessToken = response.access_token;
        grantedScope = response.scope || SCOPES;
        onSuccess?.();
      },
    });
  };

  tryInit();
}

/**
 * @param {{ forceConsent?: boolean }} [options]
 */
export function signIn(options = {}) {
  const forceConsent = Boolean(options.forceConsent);
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      reject(new Error('Google 인증이 초기화되지 않았습니다.'));
      return;
    }
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new Error(response.error_description || response.error));
        return;
      }
      accessToken = response.access_token;
      grantedScope = response.scope || SCOPES;
      if (!hasCalendarScope(grantedScope)) {
        accessToken = null;
        grantedScope = '';
        reject(createScopeError());
        return;
      }
      resolve();
    };
    // 노트북에 남은 예전 권한(Docs만)을 갱신하려면 consent가 필요
    tokenClient.requestAccessToken({
      prompt: forceConsent || !accessToken ? 'consent' : '',
    });
  });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken);
  }
  accessToken = null;
  grantedScope = '';
  for (const listener of signOutListeners) {
    try {
      listener();
    } catch {
      // ignore listener errors
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiFetch(url, options = {}, retryCount = 0) {
  if (!accessToken) {
    throw createAuthExpiredError();
  }

  const { responseType, ...fetchOptions } = options;

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...fetchOptions.headers,
  };
  if (fetchOptions.body != null && headers['Content-Type'] == null) {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(url, {
      ...fetchOptions,
      headers,
    });
  } catch (networkErr) {
    throw new Error(networkErr?.message || 'Failed to fetch');
  }

  if (!res.ok) {
    if (res.status === 401) {
      accessToken = null;
      grantedScope = '';
      throw createAuthExpiredError();
    }
    const err = await res.json().catch(() => ({}));
    const message = err.error?.message || `API 오류 (${res.status})`;
    const status = err.error?.status || '';
    const combined = `${message} ${status}`;

    if (/quota exceeded/i.test(message) && retryCount < QUOTA_MAX_RETRIES) {
      await sleep(QUOTA_RETRY_DELAY_MS);
      return apiFetch(url, options, retryCount + 1);
    }

    if (
      res.status === 403 &&
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT|PERMISSION_DENIED|insufficient authentication scopes/i.test(
        combined
      )
    ) {
      throw createScopeError(message);
    }

    throw new Error(message);
  }

  if (res.status === 204) return null;
  if (responseType === 'text') {
    return res.text();
  }
  return res.json();
}
