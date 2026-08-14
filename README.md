# TimeBox4

Timebox3를 기반으로 한 일일 플래너입니다. 로컬 저장·Google Docs 저장에 더해 **Google Calendar 양방향 연동**을 지원합니다.

Timebox3와는 **별도 저장소·별도 localStorage·별도 Docs 문서**를 사용합니다.

## 주요 기능

- **Top 3 우선순위** — 하루의 핵심 3가지 목표
- **할 일 목록** — 추가 / 완료 / 삭제
- **타임박스** — 05:00~24:00, 30분 단위
- **Brain Dump** — 자유 메모
- **로컬 저장** — `timebox4_` prefix localStorage
- **Google Docs** — `TimeBox4 Planner Journal` 단일 문서에 날짜 섹션 저장
- **Google Calendar**
  - **불러오기**: timed 일정은 빈 슬롯에만 채움, **종일 일정은 할 일 목록에 추가** (기존 입력 유지, timebox4 소유 이벤트 제외)
  - **보내기**: 연속·동일 제목 슬롯을 하나의 일정으로 병합 후 upsert (`timeboxOrigin=timebox4`만 관리)

## 시작하기

### 1. 의존성 설치 및 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 으로 접속합니다.

### 2. Google Cloud 설정

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 선택 (Timebox3와 동일 프로젝트 재사용 가능)
2. **API 및 서비스 → 라이브러리**에서 다음 API 활성화:
   - [Google Drive API](https://console.developers.google.com/apis/api/drive.googleapis.com/overview)
   - [Google Docs API](https://console.developers.google.com/apis/api/docs.googleapis.com/overview)
   - [Google Calendar API](https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview)
3. **OAuth 클라이언트 ID** (웹 애플리케이션)
   - 승인된 JavaScript 원본: `http://localhost:5173`
   - 배포 시: `https://consti000.github.io`
4. 프로젝트 루트 `.env`:

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
```

5. OAuth 동의 화면이 **테스트**이면 테스트 사용자에 본인 Gmail 추가
6. Calendar 스코프가 추가되었으므로, 이전에 Timebox3만 썼다면 **로그아웃 후 다시 로그인**해 권한에 동의하세요.

`.env`가 없으면 Google 로그인·Docs·Calendar 버튼은 비활성(또는 안내) 상태입니다.

### 3. Google Docs 저장

- Drive에 `TimeBox4 Planner` 폴더와 `Timebox Planner Journal(v3)` 문서가 생성됩니다.
- 이전 `Journal(v2)`는 사용하지 않습니다(손상된 문서와 분리).
- **구글 닥스에 저장** 버튼을 누르면 화면에 표시된 날짜 스트립(선택한 날짜 ±4일) 자료를 갱신합니다.
- **스트립 밖(이미 Docs에 있는 오래된 날짜) 섹션은 유지**하고, 스트립 날짜만 최신 내용으로 덮어쓴 뒤 전체 날짜순으로 다시 정렬합니다.
- 저장은 Drive HTML 변환 업로드로 빠르게 처리합니다.
- 날짜마다 **새 페이지**에서 시작하며, 제목은 `2026년 7월 27일` 형식입니다.
- 웹 화면과 같이 **표**로 Top 3·할 일·타임박스·Brain Dump를 기록합니다.

### 4. Google Calendar 동기화 규칙

| 동작 | 동작 방식 |
|------|-----------|
| 불러오기 | timed 이벤트 → 빈 타임박스 슬롯만 채움. **종일 일정 → 할 일 목록에 추가**(동일 제목 중복 제외). Timebox4가 만든 일정은 무시 |
| 보내기 | 타임라인 블록을 제목+시작(또는 시간 겹침)으로 기존 일정과 매칭. Timebox4면 수정, 외부면 생성 생략. Timebox4 중복분은 삭제 |
| 자동 동기화 | 없음 (버튼 수동) |
- 캘린더 동기화는 1일 단위로 현재 웹화면의 내용만 반영됨
- 구글 캘린더의 시간대가 30분을 초과할 경우 timebox에는 2개 이상이 기록됨
- 캘린더 불러오기, 내보내기는 '제목'과 '시작시간'만을 대조하여 중복을 제거함


## 배포

### GitHub Pages

1. 저장소 **Settings → Pages → Build and deployment**에서 Source를 **GitHub Actions**로 설정
2. **Settings → Secrets and variables → Actions**에 `VITE_GOOGLE_CLIENT_ID` 추가
3. Google Cloud **승인된 JavaScript 원본**에 `https://consti000.github.io` 추가 (이미 있으면 생략)
4. `master` push 시 `.github/workflows/deploy.yml`이 배포합니다.

배포 URL: `https://consti000.github.io/timebox4/`

```bash
npm run build
npm run preview
```

## Timebox3와의 차이

| 항목 | Timebox3 | Timebox4 |
|------|----------|----------|
| 경로 | `/timebox3/` | `/timebox4/` |
| localStorage | `timebox_` | `timebox4_` |
| Docs | TimeBox Planner Journal | TimeBox4 Planner Journal |
| Calendar | 없음 | 양방향 (수동 Pull/Push) |

## 기술 스택

- Vite + Vanilla JavaScript
- Google Identity Services (OAuth 2.0)
- Google Drive / Docs / Calendar API
