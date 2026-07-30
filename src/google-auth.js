const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const AUTH_EXPIRED = 'AUTH_EXPIRED';
const QUOTA_RETRY_DELAY_MS = 45000;
const QUOTA_MAX_RETRIES = 2;
const PLACEHOLDER_CLIENT_ID = 'your-client-id.apps.googleusercontent.com';

let accessToken = null;
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

export function getGoogleSetupHint() {
  if (isGoogleConfigured()) return '';

  const clientId = getGoogleClientId();
  if (!clientId) {
    return '프로젝트 루트에 .env 파일을 만들고 VITE_GOOGLE_CLIENT_ID를 설정하세요. (.env.example 참고)';
  }
  if (clientId.includes('your-client-id')) {
    return '.env의 VITE_GOOGLE_CLIENT_ID에 실제 OAuth Client ID를 넣고 npm run dev를 재시작하세요.';
  }
  return 'VITE_GOOGLE_CLIENT_ID 형식을 확인하세요. (xxxx.apps.googleusercontent.com)';
}

export function isAuthenticated() {
  return Boolean(accessToken);
}

export function isAuthExpiredError(err) {
  return Boolean(err && err.code === AUTH_EXPIRED);
}

export function isQuotaError(err) {
  return Boolean(err && /quota exceeded/i.test(err.message || ''));
}

export function createAuthExpiredError() {
  const err = new Error('세션이 만료되었습니다. Google 다시 로그인해 주세요.');
  err.code = AUTH_EXPIRED;
  return err;
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
        onSuccess?.();
      },
    });
  };

  tryInit();
}

export function signIn() {
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
      resolve();
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    window.google.accounts.oauth2.revoke(accessToken);
  }
  accessToken = null;
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

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...options.headers,
  };
  if (options.body != null && headers['Content-Type'] == null) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  if (!res.ok) {
    if (res.status === 401) {
      accessToken = null;
      throw createAuthExpiredError();
    }
    const err = await res.json().catch(() => ({}));
    const message = err.error?.message || `API 오류 (${res.status})`;

    if (/quota exceeded/i.test(message) && retryCount < QUOTA_MAX_RETRIES) {
      await sleep(QUOTA_RETRY_DELAY_MS);
      return apiFetch(url, options, retryCount + 1);
    }

    throw new Error(message);
  }

  if (res.status === 204) return null;
  return res.json();
}
