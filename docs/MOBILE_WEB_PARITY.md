# 웹 ↔ Expo 화면 동등성 계획

> **상태: v2 — 2026-11-10, `yunseong` `c6374ab`. 독립 검토 R1~R3 반영.**
> 웹 관광객 화면(기준)과 Expo 앱을 폰 폭에서 같은 모습·같은 동작으로 맞추기 위한 결정 목록 · 공통 기반 · 파일이 겹치지 않는 구현 묶음 · 확인 방법이다. 세부(웹 값·Expo 현재·고치는 법·확인 방법)는 아래 문서에 있고 여기서는 ID 로만 가리킨다.
> - 검토: [R1 G1·G2](./parity/review-R1.md) · [R2 G3·G4a·G4b](./parity/review-R2.md) · [R3 G5a·G5b](./parity/review-R3.md)
> - 발견: [G1 첫 실행·인증](./parity/findings-G1.md) · [G2 홈 지도·상단·도구 + 전역 모양](./parity/findings-G2.md) · [G3 추천 카드·여정·토스트](./parity/findings-G3.md) · [G4a 저장·대안](./parity/findings-G4a.md) · [G4b 코스](./parity/findings-G4b.md) · [G5a 대기](./parity/findings-G5a.md) · [G5b 마이](./parity/findings-G5b.md)

## 0. 읽는 순서와 우선 규칙

1. **읽는 순서: 이 문서 → 검토(R1~R3) → 발견.**
2. **우선 규칙**
   - 검토의 정정이 원래 발견을 이긴다(경로·원인·값·처방 모두).
   - 검토끼리, 또는 v1 과 다르면 이 문서 §4.3 의 결정이 이긴다.
   - 이 문서가 정한 파일 경로·컴포넌트 이름·상수가 발견·검토와 다르면 이 문서를 따른다.
3. 검토가 더한 새 항목 17건(G2-R01~R03, G3-R01·R02, G4a-R01~R05, G4b-R01~R05, G5b-R01·R02)은 각 검토 1절에 있고, §5 묶음과 §6 색인에 넣었다.
4. 진행: §3 결정을 한 번에 답한다(§3.5, 답이 없으면 추천대로 — [`MOBILE_APP_PLAN.md`](./MOBILE_APP_PLAN.md) §10 과 같은 규칙) → §5 묶음 순서대로 → 묶음마다 §8 대로 다시 찍고 마지막에 Z Fold7 체크리스트.

## 1. 목적·기준·방법

### 1.1 목적과 기준

- **사용자 결정(2026-11-10b, [`HANDOVER.md`](./HANDOVER.md))**: Play 주력 = Expo 앱(`apps/mobile`). 웹 관광객 화면과 같은 모습·같은 동작이어야 한다. 기준 = `yunseong` 의 `apps/web`, 폰 폭 390px. **예외는 지도 바탕 타일뿐**(웹 카카오 · 안드로이드 구글).
- 앱 쪽에서 일부러 다르게 만든 설계(예: 11-09 '추천 시트 이어 보이기')도 웹과 다르면 웹에 맞춘다.
- **기본은 웹이다(R2 결정 기준).** 앱만 다르게 두는 것은 스토어·법·코드 규칙 근거가 있는 것만이다(§3.1).
- App Store 는 11-08 에 접었다(Play 만). App Store 4.8·5.1.2(i) 근거는 다시 본다(§3 D4·D5).

### 1.2 비교 방법

| 항목 | 값 |
|---|---|
| 날짜·코드 | 2026-11-10(화) 13:59~14:44 KST 촬영 + 검토 추가 촬영(R1 2회·R3 1쌍), `yunseong` `c6374ab` 작업 트리. 저장소 파일은 고치지 않았다 |
| 기준(웹) | `apps/web` 정적 export(Render API 주소로 빌드)를 `http://localhost:3000` 에서 |
| 비교(Expo) | `apps/mobile` **웹 빌드**(react-native-web, `web.output: single`). 처음엔 EAS Hosting `https://nextspot.expo.app` 이었으나, **촬영 중 EAS 무료 등급이 그 주소에 429(요청 과다)를 냈다(14:11 KST).** 그 뒤로 하네스는 HEAD 를 로컬 export 한 `scratch/parity/expo-dist` 를 같은 origin 으로 서빙한다(카카오 키 도메인·Render CORS 그대로). 배포판(`a6484bb`)과 HEAD 의 `apps/mobile` 차이는 없다 |
| 도구 | 공용 Playwright 하네스 `scratch/parity/harness.mjs`(playwright 1.61 · Chromium 149). `openPair` 로 두 앱을 같은 조건에서 연다 |
| 기기 | 390×844 @2x, isMobile·hasTouch, ko-KR, Asia/Seoul, 황리단길 GPS(35.838, 129.21, 허용), 라이트, 서비스워커 차단. 웹 카카오 마커는 `page.touchscreen.tap` 으로만 눌린다 |
| 계정 | 공유 게스트 1명(두 앱 같은 Supabase 세션), 첫 실행을 마친 상태(`FIXED_SETUP`: 분류 없음·도보 20분·1시간), Expo 는 위치 약관·AI 동의 허용 상태. 첫 실행 화면은 첫 실행 표시만 지운 `state:'first-run'` |
| 데이터 | 화면을 그리는 POST(by-type 4종·대안·코스 계획)는 11-10 13:15~13:35 KST 에 한 번씩 녹화한 fixture 로만 답한다. 빈·오류·로딩·변형은 그룹별 overlay 와 `mockGet`/`mockRoute` |
| 산출 | 상태마다 `*.pair.png`(왼쪽 웹·오른쪽 Expo) + 계산된 스타일 측정 JSON + 코드 대조. 7개 에이전트가 비교, 3개 검토가 코드·쌍을 다시 대조했다 |

### 1.3 운영 데이터 안전

- 하네스 정책: 읽기만 통과. 쓰기는 가짜 응답, 가입·로그인 차단, LLM 차단. 비교·검토 중 운영 쓰기 0건, 새 게스트 0명(`logs/blocked-writes.jsonl`).
- 운영 흔적(fixture 녹화 때뿐): 익명 게스트 1명, 추천 노출 행 약 27(최대 37), 선호 벡터 1.
- 다시 찍을 때도 같다: 하네스 밖에서 운영을 부르지 않는다. `bootstrap.mjs`·`record-fixtures.mjs` 는 메인 세션만, `fixtures/*.json` 은 읽기 전용(바꿀 땐 overlay), 새 게스트 금지, 3000·8081 서버는 메인 세션만.

### 1.4 Expo 웹 빌드 ≠ 네이티브

- 비교 대상은 Expo **웹 빌드**다. react-native-web 과 안드로이드는 다르게 그리는 것이 있다: 한국어 줄바꿈(웹 빌드에 keep-all 없음, 안드로이드는 U+2060) · `accessibilityState` → aria · 흐림(expo-blur) · 지도(웹 빌드 카카오 JS, 안드로이드 구글) · `Alert`(웹 빌드는 `window.confirm` — 스크린샷에 없음) · 햅틱.
- **반대로 웹 빌드에서 본 버그가 네이티브에도 있는 경우가 있다.** 모달 시트가 안 열리는 원인은 JS 효과 순서다(R1, 메인 세션 코드 확인) — 안드로이드에서도 7곳이 안 열릴 가능성이 높아 첫 묶음(A1)으로 올렸다.
- `네이티브 확인 필요` 34건은 §8.2 체크리스트로 Z Fold7 에서 본다. 웹 빌드 전용 수정(`Platform.OS === 'web'`, `*.web.tsx`)은 네이티브 동작을 바꾸지 않게 만든다.

### 1.5 자료 위치

- **`scratch/parity/`(i7 노트북, git 제외 — 저장소에 없다)**
  - `harness.mjs`·`README.md`(하네스·안전 정책), `inventory.md`(화면·상태 인벤토리, §6 알려진 차이 D1~D30·Expo 전용 E1~E11)
  - `fixtures/`, `overlays/<그룹>/`, `work/<그룹>/*.mjs`(재현 스크립트), 검토 스크립트 `overlays/R1/*.mjs`·`work/R3/*.mjs`
  - `shots/<그룹>/*.pair.png`(+`*.measure.json`), `shots/R1`·`shots/R3`, `logs/`, `expo-dist/`(Expo 웹 빌드 로컬 export)
- **저장소**: 이 문서, `docs/parity/findings-*.md`(발견), `docs/parity/review-R1.md`~`review-R3.md`(검토).
- 발견 표기: `W:` = `apps/web/`, `M:` = `apps/mobile/`, 줄 번호 `c6374ab`. B6 이 경로를 옮긴 뒤 `app/mypage/*` → `app/(tabs)/mypage/*`, `app/explore/recommend.tsx` → `app/(tabs)/explore/recommend.tsx`.

## 2. 숫자 요약

| 그룹 | 범위 | 발견 | 검토 새 항목 | 합계 | P0 | P1 | P2 | 결정 필요 | 네이티브 확인 | 촬영 못 함 |
|---|---|---|---|---|---|---|---|---|---|---|
| G1 | 첫 실행·인증 | 34 | 0 | 34 | 7 | 17 | 10 | 15 | 4 | 3 |
| G2 | 홈 지도·상단·도구 + 전역 모양 | 43 | 3(R01~R03) | 46 | 19 | 21 | 6 | 11 | 7 | 5 |
| G3 | 추천 카드·여정·토스트 | 35 | 2(R01·R02) | 37 | 9 | 27 | 1 | 9 | 2 | 3 |
| G4a | 저장·대안 | 31 | 5(R01~R05) | 36 | 8 | 18 | 10 | 7 | 6 | 0 |
| G4b | 코스 | 29 | 5(R01~R05) | 34 | 6 | 16 | 12 | 9 | 5 | 1 |
| G5a | 대기 보드 | 25 | 0 | 25 | 4 | 8 | 13 | 6 | 3 | 0 |
| G5b | 마이 | 38 | 2(R01·R02) | 40 | 8 | 22 | 10 | 12 | 7 | 3 |
| **합계** | | **235** | **17** | **252** | **61** | **129** | **62** | **69** | **34** | **15** |

- 중요도: **P0** 구성·요소 누락/추가·흐름·값 오류 · **P1** 눈에 띄는 크기·간격·색·아이콘·문구·동작 · **P2** 자세히 봐야 보이는 차이.
- 새 항목 중요도: G3-R01 P0 · G2-R01·R02, G3-R02, G4a-R01, G4b-R01 P1 · 나머지 11건 P2. 결정 필요는 G3-R01(5번), 네이티브 확인은 G2-R02 가 더해졌다. 검토가 결정을 둘 더 냈다(G1-31 금→주칠 버튼, G5b-01 활성 탭 다시 누름) — §3 에 넣었다.
- 검토 정정: R1 45건(G1·G2 — 결론이 바뀐 것 G2-G07·G01·G02·G06·14·16, G1-01·02·15·20), R2 45건 + 보완 3(그대로 따르면 깨지는 것 G3-01·21·31, G4a-01·12·13·15·17, G4b-01·08·20), R3 20건(G5a-05·09, G5b-01·03·05·07·09·14·30 등).
- 결정 필요 69건은 §3 에서 19개 주제 + 한 줄 결정으로 줄였다. 촬영 못 함(표시): G1-19·25·32, G2-17·18·27·31·32, G3-21·22·27, G4b-28, G5b-18·22·33(각 문서 끝 '촬영 못 한 상태' 절에 더 있다).
- 큰 차이 한눈에: 모달 시트 7곳이 안 열림(앱 버그) · 색 카드가 흰 카드(앱 버그) · SPOT '1점'과 직접 고른 곳 '도보 1분'(값 오류) · 하단 탭 막대(101px vs 49px, 하위 화면엔 없음) · 추천 카드 모델(뜬 카드 vs 3단 시트) · 첫 실행(랜딩+소개 모달 vs 긴 소개) · 홈 상단 묶음·예측 띠·✨·주차장 · 마이 머리 · 로딩 화면.

## 3. 먼저 정할 것(사용자 결정)

### 3.1 원칙

- **기본은 웹에 맞춘다.** 앱만 다르게 두는 예외는 근거가 있는 것만: 스토어 정책(G3-35 사진 신고), 법(G1-14 위치 약관, G3-30·G5b-29 외부 AI 고지), 코드 규칙(G3-26·G3-R01 5번 — `apps/web/AGENTS.md` 'SPOT 은 백엔드 단일 소스').
- **웹이 틀려 보이면 웹을 먼저 고치고(웹 게이트·main 규칙), 앱은 고친 모습으로 만든다.** 웹 수정이 정해지기 전에는 지금 웹을 따른다(§7).
- '덜 귀찮다'·'앱 관례' 같은 이유만으로는 앱을 다르게 두지 않는다 — 그렇게 하려면 사용자가 결정한다(G3-32, G5b-01 다시 누름).

### 3.2 결정 표

검토로 추천이 바뀐 것: D3(약관 C → A), D10(알림 전부 → 골든타임만), D16(간격 유지 → 웹처럼 매번), D18(정본 = 법무 검토 초안), 새로 D19·D13(d).

| # | 정할 것 | 선택지 | 추천과 이유 | 관련 ID | 바뀌는 묶음 |
|---|---|---|---|---|---|
| D1 | 원칙 | ① §3.1 대로(기본 웹, 근거 있는 예외만, 웹 버그는 웹 먼저) ② 앱 관례 우선 ③ 항목마다 | **①** — 기준이 하나로 남고 묶음 작업이 기계적이 된다 | §7 전체 | W1 범위 |
| D2 | 금색 단색 버튼과 금→주칠 그라데이션 위 흰 글자 | (a) 흰 글자/#c19a3e = **2.64:1**(세 검토 같은 계산, 기준 4.5:1): ① 웹 그대로 ② 웹·앱 함께 금 진 #705819(6.78:1) ③ 앱만. (b) 금→주칠 그라데이션 + 흰 글자(웹 `contrast.test.ts` 가 금지한 조합 — 404 CTA 등 검사 밖에 남은 곳): ① 웹 그대로 ② 두 앱 모두 `cta` | **(a) ② · (b) ②** — `DESIGN_PRINCIPLES` '주 버튼 ≥4.5:1'. 앱은 `Button variant="gold"` 가 토큰 `button-gold` 하나만 읽게 해 답이 바뀌어도 값 한 줄 | G1-20·26·29·31, G2-06, G4a-10·28, G4b-10·21, G5b-05·20·21·27·28·37·38, G3-31 | A3(토큰), B2, W1 |
| D3 | 위치: 첫 실행 게이트·약관 동의·홈 위치 UI | (a) 게이트: A 유지 + 소개 단계를 웹 랜딩 모양 · B 재방문마다 랜딩 · C 제거. (b)+(c) 약관과 홈 UI 는 짝으로: **A+①** 첫 실행 약관 화면 유지(모양만 맞춤) + 홈은 웹처럼 버튼·배너 없이 실패 알약, 다시 켜기는 마이>설정 · **C+②** 약관을 첫 실행에서 빼고 홈 Expo 전용 배너·버튼에서 동의. (d) 거부·밖의 '내 위치' 점: ① 웹처럼 가짜 위치에 그림 ② 안 그림 ③ 웹도 안 그리게 | **a-A · A+① · d-③** — R1: C 는 홈 배너·버튼이 입구인데 ①이 둘을 지워 함께 성립하지 않는다. A+① 은 수집 전 동의를 지키고 홈은 웹과 같다. 가짜 위치 점은 사실과 달라 웹을 고친다 | G1-01·14·15·19, G2-04·32, G5b-33 | D1, H3b, W1 |
| D4 | 외부 AI 전송 동의(앱 전용) | ① 유지 ② 지움 ③ 웹에도 | **①** — 앱 처리방침·설정 철회 줄과 묶임. App Store 근거는 사라졌지만 개인정보 처리 위탁·Play 사용자 데이터 고지 문제라 법무 때 함께 본다 | G3-30, G5b-29·33, G2-22, G4a-30 | 없음(③이면 W1) |
| D5 | 소셜 로그인 | ① 안드로이드 구글을 웹 모양으로 지금, 카카오는 비즈 앱 전환(사람 작업) 뒤 · Expo 웹 미리보기 0개 유지 ② 둘 다 지금 ③ 그대로 | **①** — 그리고 노출 규칙을 하나로: 마이 `accountCore.visibleProviders` 가 `socialPolicy.socialProvidersFor` 를 부르게(R3 — 지금은 카카오를 켜도 마이 카드에 안 나온다) | G1-23, G5b-09 | D1, D6, 사람 작업 |
| D6 | 서비스 소개 범위 | ① 웹처럼 모달(첫 방문 자동)·히어로·바로가기·문제→해결·이런 분께·FAQ·데이터·생태계 + `/guide` ② 지금처럼 인라인 | **①** — 바로가기는 앱에 있는 기능만(예측 지도·음성은 이식 전까지 숨김, 콘솔은 D7), 계획 절은 D8, FAQ1 은 앱 문구 유지(웹 문구 '웹에서 바로 쓸 수 있고'는 앱에서 사실이 아님) | G1-03·06·08~13 | D1 |
| D7 | 콘솔 입구(사장님·관제) | ① 웹과 같은 자리·모양, 누르면 `openExternalUrl()` 로 웹 콘솔·데모 ② '서비스 소개'만 ③ 탭 막대 안내 줄 없음(65px) | **①** — 탭 막대 높이·배치가 웹과 같고 앱 범위는 링크뿐. 문제가 생기면 `lib/core/consoleEntries.ts` 플래그 하나로 ②. 개발자 카드는 넣지 않는다 | G1-07·09(5번)·12(생태계 알약), G2-G01, G5b-08·11·19 | B6, D1, D6 |
| D8 | 공모전 잔재(심사 계정 안내·소개 '계획' 절·코스 데모 방문자·랜딩 PWA 배너) | ① 웹에서 지운다 ② 앱에도 옮긴다 ③ 둔다 | **①** — 공모전은 끝났다. 앱 작업 0 | G1-12(계획)·22·33, G4b-28 | W1 |
| D9 | 음성 비서 | ① 지금 이식 ② v1.1 별도 과제 ③ 자리만 | **②** — 네이티브 모듈 2개·마이크 권한·외부 AI 동의·Play 데이터 보안 답이 걸린 L 3건. 남는 차이: 홈 마이크·'AI 음성 비서' 알약, 대안 🎙 와 카드 폭(302↔358). 마스코트(G2-11)는 지금 | G2-12, G3-04, G4a-17 | ①이면 새 묶음(재빌드) |
| D10 | 알림 | ① 골든타임 '알림 받기'만 지금(로컬 예약 — 서버 없음), '한산해지면 알림' 토글은 v1.1(R3 분할) ② 둘 다 지금(토글은 앱이 켜져 있는 동안만 확인) ③ 둘 다 v1.1 | **①** — 골든타임은 로컬 예약으로 웹보다 오히려 확실하다. 토글은 웹도 탭이 열려 있을 때만 도는데 폰에서 앱을 보고 있는 동안만 울리는 알림은 거의 쓸모가 없어 '되지 않는 버튼'이 된다(G5b-10). 푸시 토큰은 쓰지 않아 처리방침 '푸시 없음' 유지. 남는 차이: 저장 목록 위 알림 행, 마이 알림 카드·설정 절 | G3-18, G4a-06·09, G5a-19, G5b-10 | B4a, F1(재빌드) |
| D11 | 가정 시간 프리셋 | ① 대기·코스(+홈 예측 띠 '다른 시간') 공용 모듈로 이식 ② 웹에서도 뺀다(웹 작업) ③ 앱만 계속 뺌 + 빈 상태 문구 정리 | **①** — 대기·코스 첫 화면 44px 컨트롤 줄이 같아지고 빈 상태 문구가 웹 키로 돌아간다. 순수 모듈 + `SelectField` 라 재빌드 없음 | G4b-08·23, G5a-05·21, G2-24 | B4b, D4, D5, H2b, F4 |
| D12 | 홈 첫 화면 기능 | 🔮 예측 띠 · ✨ 경주 테마 · 주차장 탭 · 🔥 히트맵 · TourAPI 적재 요청, 각각 지금/v1.1 | **띠·✨·주차장·적재 지금, 히트맵 v1.1** — 띠·주차장·✨ 은 첫 화면 구성과 카드·카메라 자리를 바꾸고 서버·문구가 있다. 히트맵은 네이티브에서 블렌드가 안 돼 모양이 어차피 다르다(시트 첫 칸만 빠짐) | G2-09·14·21·24·25·27 | H2b, H3b, F2 |
| D13 | 탐색 구조 | (a) 마이 하위 7개·대안 화면을 탭 안으로(하단 탭 보임) (b) 대기·코스·대안에 원형 '지도 보기' 버튼 (c) 하드웨어 뒤로 (d) 활성 탭 다시 누름(마이 하위에서 '마이' 등) | **(a) 예 · (b) 예 · (c) 이전 화면(`backBehavior="history"`) · (d) 웹처럼 아무 일 없음** — (d)는 R1(웹 `BottomNav.tsx:69`)을 따른다. R3 는 앱 관례(맨 위로)를 권했으나 근거가 관례뿐이라 §3.1 에 따라 웹. 카드 펼침 중 뒤로 = 미리보기로 접기, 저장 상세 = 닫기 | G2-G01·G02, G5b-01·02, G5a-01, G4b-02, G4a-15, G3-01, G4a-13, G1-15 | B6, D3, D4, D5 |
| D14 | 안드로이드 유리 흐림 | ① SDK 31+ 흐림 + 35% ② 92% 불투명(지금) ③ 70% | **①을 폰에서 먼저 시험, 안 되면 ③** — expo-blur 57 안드로이드는 흐릴 내용을 `BlurTargetView` 로 감싸야 하고 구글 지도(SurfaceView)는 안 잡힐 수 있다(R1). 탭 막대에는 유리를 쓰지 않는다 | G2-G03 | B1, H3b |
| D15 | 사진 | (a) 사진 없는 표지(경주 문양) 이식 (b) 대기 보드에 Wikimedia·경주시·사장님 사진 + 출처 줄 (c) 사장님 사진 ⋯ 신고·숨기기(앱 전용) | **(a) 예 · (b) 예 · (c) 유지** — 출처 판정 모듈 둘(`features/explore/port/photoCredit.ts`·`features/recommendation-card/photoCredit.ts`)은 port 판 하나로(R3). (c)는 Play 사용자 콘텐츠 정책 | G3-08·35, G4a-19, G4b-12, G5a-15·16 | B4a, H1, D3, D4, D5 |
| D16 | 탭 재진입·다시 불러오기 | (a) 화면 상태(펼침·선택·짜기 패널·스크롤)를 떠날 때 초기화 (b) 데이터: 웹처럼 방문마다 조용히 다시 받기 / 지금 간격(대기 5분·코스 10분) 유지 (c) 재진입 스켈레톤 (d) 대기 '다시 시도'에 덧붙은 자동 재시도 | **(a) 웹처럼 · (b) 웹처럼 매번 · (c) 안 따름 · (d) 웹처럼 지움** — v1 의 '간격 유지'를 거둔다: 서버에 사용자별 180초 캐시가 있어 탭을 오가도 노출 행이 곧바로 쌓이지 않고, 웹 사용자는 이미 그렇게 쓴다(R2). 코스 `resetInputs` 는 비었으면 아무것도 안 해야 탭 전환마다 POST 가 안 나간다 | G4b-27, G5a-23·24, G4a-11 | D2, D4, D5 |
| D17 | 확인창·토스트 | (a) 되돌릴 수 없는 동작 확인을 화면 안 토스트 버튼으로 (b) sonner 글꼴(웹은 시스템 글꼴) (c) sonner 자리(웹은 탭 막대를 덮음) | **(a) 예 · (b) 웹 고침(`font-sans`), 앱 Freesentation · (c) 웹 고쳐 막대 위로, 앱은 탭 화면 = 막대 위·탭 없는 화면 = 16 + 아래 안전 영역** | G4a-12, G5b-35, G3-34, G4b-26 | B3, W1 |
| D18 | 개인정보·표기 | (a) 개인정보 문안 (b) 앱 정보 버전 0.1.0↔1.0.0 (c) 날짜 표기 로케일 | **(a) 정본은 법무 검토를 거친 [`MOBILE_PRIVACY_DRAFT.md`](./MOBILE_PRIVACY_DRAFT.md)**(웹 7절도 앱 13절 화면도 아님 — R3). 검토 뒤 웹 `/mypage/privacy`(스토어 처리방침 URL)와 앱 화면을 그 문서·하나의 시행일로 맞춘다. 그 전까지 앱 문안은 바꾸지 않고, 더 짧은 웹을 '전체'라 가리키는 '웹에서 전체 안내 보기' 버튼은 숨긴다 · (b) 앱 실제 버전 유지 · (c) 웹을 앱 언어로 고침 | G5b-22·30·31·36 | D6(버튼), L1, W1 |
| D19 | 직접 고른 곳(추천 목록 밖)의 SPOT 표시 | ① 앱도 화면 안 미러 SPOT 계산 ② 표시하지 않음(지금) | **②** — 'SPOT 산정은 백엔드 단일 소스'(코드 규칙). 도보 분·도착 시각 값 오류는 A2 에서 고친다 | G3-R01(5번), G3-26 | 없음 |

### 3.3 한 줄 결정(추천대로면 답하지 않아도 된다)

| ID | 정할 것 | 추천 |
|---|---|---|
| G1-01(b) | 소개 → 로그인 이동 | R1 안: `push('/login')`, 로그인 성공·게스트 진행에서 `dismissAll()` 뒤 `replace`(뒤로 = 소개 랜딩). 부담이면 (c) 지금 replace 유지 + '첫 실행 중 로그인에서 뒤로 = 앱 종료'를 차이로 기록 |
| G1-25 | '게스트로 둘러보기' 목적지 | 앱 유지(재방문자에게 설정을 다시 묻는 웹 동작은 웹 개선 후보) |
| G1-27 | 재설정 화면 앱 전용 안내문 | 완료 상자에만(A) |
| G1-30 | OAuth 콜백 분기 | 유지(딥링크 구조) |
| G1-32 | 렌더 오류 문구 | 새 키 `app.error.retryHint`(B) |
| G2-01 | 첫 추천 핀 세로 위치 | 웹을 고쳐 미리보기 높이로 띠를 잰다(②, W1) — 앱도 그 규칙 |
| G3-23 · G4b-25 | '바로 갈래요'·길안내 뒤 흐름 | 웹 한 건(`navigation.ts` noopener)으로 고친다(W1), 앱 유지 |
| G3-26 | 추천 실패·후보 소진 | 클라이언트 SPOT 미러 없이 같은 카드 틀 오류판(코드 규칙 예외) |
| G3-32 | 여정 카드 다시 보이기 | 웹과 같게(나) — 근거가 '덜 귀찮다'뿐(R2). 앱 규칙을 원하면 사용자가 고른다 |
| G4a-13(5번) | 저장 상세 '바로 갈래요' | 웹처럼 카카오맵만(a). 여정 기록을 원하면 웹을 먼저 고친다 |
| G4a-26 | '순서 자세히' 비교 | 웹과 같은 가로 밀기 표(a, 열 너비 이름표 ≈84 + 장소 3×≈145) |
| G4a-30 | 대안 온보딩 모달·자연어 입력 | 옮기지 않는다 — 앱은 첫 설정이 같은 역할(PORTING 에 적음) |
| G4b-01 | 코스 지도·시트 겹침 | 웹 렌더 결과대로(A — 실제 지도가 있을 때만 지도가 시트 위, 구글 로고 보임) |
| G4b-19 | 코스 '앞으로/뒤로 옮기기' 줄 | 보이는 줄은 지운다(A), 스크린리더 동작 유지 |
| G4b-23 | 코스 빈 상태 문구 키 | D11 을 따른다(① 이면 `model.test.ts:84` 단언도 고침) |
| G4b-28 | 세션이 없을 때 | 2.5초 유예만 맞춘다(데모 방문자 요청은 D8 로 웹에서 지움) |

### 3.4 인벤토리 §6 알려진 차이(D1~D30)·Expo 전용(E1~E11)의 처리

- **그대로 둔다**(보이지 않거나 정책·구조): D6 다크 토글(웹도 숨김) · D9 데모 패널 · D11 CAPTCHA · D13 재설정 화면 · D17 지도 시설 폴백 · D18 카카오 장소 상세 · D19 지도 공급자(타일 예외) · D25 내부 지역 · D26 공유 origin · D27 길안내 링크 · D28 기록·헤더 · D29 데스크톱 · D30 문의 이메일 칸 · E1 위치 약관(D3) · E5 게스트 데이터 삭제 · E6 설정 위치 동의 줄 · E11 햅틱.
- **이번에 웹에 맞춘다**: D20 `/explore/map`(G4a-31) · D21/E7 앞뒤 옮기기(G4b-19) · D22 저장 상세(G4a-13·G3-R02) · D23 레이더·언어 선택(G5b-14·32) · E2 홈 위치 배너·버튼(D3 ①) · E8 홈 검색 결과 목록·음식 칩 줄·'지금 한산'(G2-19·26·13) · E9 다시 불러오기(D16) · E10 렌더 오류 화면(G1-32).
- **결정에 따른다**: D1 음성(D9) · D2·D3 온보딩 모달·자연어(G4a-30) · D4·D5 알림(D10) · D7 가정 시각(D11) · D8 히트맵·예측 띠(D12) · D10 소셜(D5) · D12·D15 심사 안내·PWA(D8) · D14 콘솔(D7) · D16 SPOT 폴백(G3-26) · D24 첫 실행(D3) · E3 AI 동의(D4) · E4 사진 신고(D15).

### 3.5 답 양식

```
D1 ① · D2 a② b② · D3 a-A, A+①, d-③ · D4 ① · D5 ① · D6 ① · D7 ① · D8 ① · D9 ② · D10 ①
D11 ① · D12 띠·✨·주차장·적재 지금, 히트맵 v1.1 · D13 예·예·history·무시 · D14 ① 시험 후 ③
D15 예·예·유지 · D16 웹·매번·안 따름·지움 · D17 예·웹 고침·웹 고침 · D18 초안 정본·유지·웹 고침 · D19 ②
§3.3 추천대로
```

위가 추천 그대로다. 바꿀 것만 적으면 된다.

**확정(2026-11-11): 사용자 답 "추천대로"** — 위 양식과 §3.3 이 그대로 결정이다.

## 4. 공통 기반 작업

### 4.1 무엇을 먼저 하나

1. **앱 버그 둘(A1)** — 동등성과 상관없이 먼저 고친다.
   - **모달 시트(G2-G07, R1 정정 — 메인 세션 코드 확인)**: `components/ui/Sheet.tsx:310-313` 효과가 닫힌 채 처음 마운트될 때 `ref.current?.dismiss()` 를 부른다. @gorhom/bottom-sheet 5.2.14 `handleDismiss` 는 INITIAL 이면 DISMISSING 으로만 바꾸고, 뒤의 `present()` 를 `handlePortalRender` 가 DISMISSING 이라 건너뛴다. JS 경로라 플랫폼과 무관하다 — **필터·편의, 날씨, 축제, 화장실, 지금 한산, 묶음 핀, 혼잡 제보 7곳이 안드로이드에서도 안 열릴 가능성이 높다.** 고침: `presentedRef` 가드(열린 적 있을 때만 dismiss, `onDismiss` 에서 false) + `app/_layout.tsx` Provider 순서를 `GestureHandlerRootView > SafeAreaProvider > I18nProvider > ProvidersWithLabels > ThemeProvider > BottomSheetModalProvider > Stack·FirstRunGate·TrackedShellBridge` 로(시트 안 `useI18n()` 이 던지지 않게). `ModalSheet.web.tsx`·snapPoints 처방은 하지 않는다. **Z Fold7 확인 대상.**
   - **Card 덮어쓰기(G5b-03, R3 정정)**: NativeWind 는 같은 속성 클래스를 CSS 순서(알파벳)로 고르고 네이티브도 같다 — 기본 `bg-white border-line` 이 화면 클래스를 이겨 색 카드가 흰 카드가 된다(안드로이드도 같음). 고침: 기본값은 화면이 안 줬을 때만(`withDefault`), border 색 판정 정규식은 R3 판(`border-dashed`·`solid`·두께를 색으로 보지 않음), 다른 여백은 `padded={false}` 와 함께. 지금 영향은 G5b 파일뿐이지만 새 화면이 Card 에 색을 주는 순간 다시 나므로 먼저 한다.
2. **값 오류(A2)** — SPOT '1점'(G3-03), 직접 고른 곳 '도보 1분'(G3-R01), 킵 북마크 점수 모양·정렬(G4a-R01).
3. **토큰·문구·탭 막대 치수(A3)** — 뒤 묶음이 공유 파일을 만지지 않게.
4. 그다음 웨이브 B 기반(글자·부품·시트·토스트·공용 컴포넌트·지도 래퍼·내비 셸).

### 4.2 기반 표(하나로 정한 고치는 법)

| # | 무엇 | 하나로 정한 고치는 법 | 묶음 | 관련 ID |
|---|---|---|---|---|
| F1 | 탭 막대 치수(보통 흐름) | 막대는 탭 내비게이터 기본 자리(겹치지 않음). 높이 = `NAV_BAR_HEIGHT`(101) + 아래 안전 영역. 웹 `--tourist-nav-clearance`(116) 를 쓰던 자리는 탭 화면 안에서 `NAV_GAP` = 116 − 101 = **15** 로 바꾼다: 웹 `clearance + X` → `NAV_GAP + X`. 홈 알약 토스트처럼 화면 아래에서 잰 값은 `fromScreenBottom(px)` = px − 막대 높이. **화면 코드에 15·24·101·116 을 직접 쓰지 않는다** — `lib/theme/tokens.ts` 의 `NAV_BAR_HEIGHT`·`NAV_CLEARANCE` 와 `components/navigation/navMetrics.ts` 의 `NAV_GAP`·`isTabRoute()`·`useNavInsets()` 만 쓴다. 발견·검토에 적힌 아래 여백 숫자는 이 규칙으로 다시 계산한다 | A3 | G2-G01, G3-01·22·25·27·31·33·34, G4a-01·13·15·17, G4b-01·20, G5a-03, G5b-01 |
| F2 | 글자 | `Text` 기본 줄 높이 1.5×는 className 에 `leading-` 도 이름 크기(`text-xs`~`2xl`, NativeWind 가 줄 높이를 이미 줌)도 없고 `style.lineHeight` 도 없을 때만 style 로 준다(크기는 flatten 한 style 의 fontSize 먼저) — 명시한 `leading-[…]` 를 덮지 않는다. 한국어 keep-all·ja·zh `line-break` 는 **CSS 한 곳**(`lib/webSetup.web.ts`, `+html.tsx` 는 `web.output: single` 이라 쓰이지 않음) + `document.documentElement.lang`(시작·변경 때). 웹 빌드 글꼴은 대체 목록을 붙이고(G2-R03), ja·zh 는 웹 목록(웹 빌드)·시스템 글꼴 + 숫자 굵기(네이티브) — 헬퍼 `fontStyleFor` | B1 | G2-G04·G05·G06·G08, G2-R03, G5a-13(G2-G06 로 닫힘) |
| F3 | 유리·아이콘 | `Glass` 웹 판(0.35 + 광택 + 가장자리 + 안쪽 그림자)과 유리 안 글자색 컨텍스트, 흐림은 D14. `Icon` `fill` prop(color 와 같은 토큰 해석) | B1 | G2-G03, G4a-02, G5b-12 |
| F4 | `Button` 하나의 API(R1 표) | `variant` primary·gold(토큰 `button-gold`)·secondary·hanji·dangerSoft·dangerOutline·ghost / `size` = minHeight 30·36·44(기본)·46·48·52·56 / `labelSize` 12·13·14·15·16·17(줄 높이 짝) / `labelWeight` / `paddingX` / `shape` lg·xl·2xl(기본)·full / `shadow` auto·none·cta·ctaLg·ctaHero(auto 가 아니면 비활성이어도 그림) / `iconSize` / `showSpinner` / `disabledOpacity`. 높이·좌우 여백은 클래스가 아니라 style. 화면별 값은 R1 3절 표 | B2 | G1-20, G4b-22, G5b-05·12·34(+ 쓰는 곳) |
| F5 | `Chip` variant 묶음(R2) | `variant` layer(기본·홈) · savedFilter(금 선택 + muk medium + `count`) · courseType(금 선택 + gold-deep bold + 그림자) · labReason(30px, 선택 바탕 `button-gold`·흰 글자). variant 마다 웹 클래스 묶음을 통째로 바꿔 끼운다 | B2 | G4a-05, G4b-18, G5b-27 |
| F6 | 접근성 상태·누름 | `Pressable` 한 곳에서 웹 빌드만: role=tab 의 selected → `aria-selected`, 그 밖 selected → `aria-pressed`, checked → `aria-checked`, expanded → `aria-expanded`, busy → `aria-busy`(RN 타입에 없는 것은 Platform 분기 + 캐스트). 네이티브는 그대로. 화면별 aria 코드는 만들지 않는다. 누름은 scale .96 유지 + 어둡게(웹 빌드 `brightness(.94)`) | B2 | G1-34, G2-25(4번), G4b-29, G5a-25, G5b-06 |
| F7 | 상태 블록 | 공용 `ErrorState` = 웹 `components/ErrorState.tsx` 모양(아이콘 없음, 알약 `px 16·py 8` 12px bold, hitSlop, 색 `button-gold`; 그림자는 Card 기본에 이미 있음) + 알림 낭독 훅 `useAnnounce` export. **대기 오류는 웹도 화면 전용이라 `BoardError` 를 따로 둔다(variant 를 만들지 않음).** `EmptyState`·`Skeleton` 은 고치지 않는다 — 화면 전용 빈 상태는 `Button variant="primary" shape="full"` 로 CTA 를 그리고, 스켈레톤 색은 `style={{ backgroundColor }}`(Skeleton 이 style 을 마지막에 붙인다) | B2 | G4a-10·11·27·28·29, G4b-21, G5a-21·22, G2-06·07, G5b-21·24·25, G1-32 |
| F8 | 모달 시트 | A1 원인 수정 + 선택 prop(기본값은 지금 모양): `background`(default·hanji) · `showHandle` · `closeButton` · `backdrop`(색·투명도) · `maxWidth` · `contentPadding` · `stackBehavior`. 금 장식선 같은 장식은 내용 쪽. RN `Modal` 안에서 연 ModalSheet 는 내용 루트를 `GestureHandlerRootView` + `BottomSheetModalProvider` 로 감싼다 | A1·B3 | G2-G07, G3-21, G2-13·17·18·27, G1-04·08 |
| F9 | 토스트·확인 | `AppToaster` 하나가 자리를 정한다: 탭 화면 = 막대 위 8, 그 밖 = 16 + 아래 안전 영역(`useNavInsets()`). 모양: 모서리 8·안쪽 16·그림자·제목 13 Freesentation·쌓임 접기·기본 `toast()` 아이콘 없음·행동 버튼 같은 줄 검정 24px. 같은 컴포넌트 안에 이름 붙은 채널 `report`(화면 아래 96 + 안전 영역, 한 개, unstyled — 혼잡 제보 색 토스트)를 둔다. `id` prop 으로 RN Modal 안에 별도 Toaster(`profileEdit`). 확인은 `components/ui/confirmToast.ts` 의 `confirmDestructive()`: Promise<boolean>, action 에서 `toast.dismiss(id)`(sonner-native 0.27 은 action 이 닫지 않음), 버튼 `row-reverse`, 닫힘·시간 초과 = false | B3 | G3-22·34, G2-G01·G09, G4a-12, G4b-26, G5b-17·35 |
| F10 | 홈 알약 토스트 | `features/home/HomeToast.tsx` 하나(명세 G3-33, 호출 G2-G09): 화면 아래 350px(= `fromScreenBottom(350)`), 가운데 최대 384, 먹 0.9 알약·12px 한지, 한 칸, 3초, `pointerEvents="none"` | H2a·H3a | G2-G09, G3-33 |
| F11 | 내비 셸 | 보통 흐름 `TouristTabBar`(`expo-router/js-tabs` — SDK 57 문서 확인, `backBehavior="history"`): 흰 90%(유리·흐림 없음), 안내 줄 32 + 탭 48, 활성 알약 56×48 스프링, 아이콘 22, 글자는 앱 `Text` 11/16.5·대기 10/15/−0.25·한 줄·배율 상한 1.2(G2-R02), `tabPress` emit 후 이동, **활성 탭 누름 무시**, 숨은 경로는 그리지 않고 활성은 경로로(explore → 홈, mypage → 마이). 마이 하위·대안·`/explore/map` 을 `(tabs)` 안으로(URL 그대로), 마이 하위 머리 `SubPageHeader`(문의·고객지원은 스크롤과 함께 사라지는 머리 — G5b-R02), 공지·점검은 `ProvidersWithLabels` 로 넘김, 안내 줄 '서비스 소개' → `openGuide()` | B6 | G2-G01·G02·G04·33·34, G2-R02, G5b-01·02, G5b-R02, G4a-15·31 |
| F12 | 지도 래퍼 | `onUnavailable` + 시간 초과 prop(홈 8000 · 코스 3000), **`mapPadding`**(구글 로고가 카드·시트 밑에 숨지 않게 — 약관), 마지막 요청 레벨로 비교하는 `targetLevelRef`(코스 확대 경합 근본), 내 위치 점(halo 100, 네이티브는 정적), `plain` 점, 기본 핀 `kind:'default'`(웹 마커 이미지 실측 먼저), 이름표 `variant:'search'`, `popover`(네이티브 `pointForCoordinate`) | B5 | G2-04·08·19·31, G4a-25, G4b-04·05, G4b-R01 |
| F13 | 공용 컴포넌트 자리 | **규칙: 웹 `components/` 에 같은 이름이 있는 도메인 그림(장소·브랜드·기능 배지)은 Expo 도 `components/<이름>.tsx`, 화면과 무관한 범용 부품은 `components/ui/`.** → `components/`: `NextSpotMascot`·`PlacePhotoFallback`·`GoldenHourBadge`·`ShareButton`·`LanguageSwitcher`·`AppNoticeBanner`·`AppMaintenanceScreen`·`navigation/TouristTabBar` / `components/ui/`: `Glow`·`RingSpinner`·`SelectField`(+`.web`)·`NowChip`·`LoadingReveal`·`BackCircleButton`·`CreditLine`·`RankBadge`·`confirmToast` / 그 밖: `lib/core/spotPoints.ts`·`lib/core/assumedTime.ts`·`lib/platform/notify.ts`·`lib/placeEmblem.ts` | B4a·B4b 외 | §4.3 |
| F14 | 토큰·문구 | 새 토큰과 새 문구 키는 A3 에서 한 번에. 뒤 묶음은 토큰·문구 파일을 만지지 않는다(§5.5) | A3 | — |

### 4.3 갈린 제안 — 이렇게 정했다

| 주제 | 제안 | 정한 것과 이유 |
|---|---|---|
| 탭 막대 모델 | R1 보통 흐름(막대 101 + 안전 영역, 화면은 그 위에서 끝남, 간격 15) / R2 겹침 + `useNavClearance()` = 116 + 안전 영역 | **보통 흐름.** 웹 막대는 흰 90%라 아래 지도가 거의 안 비쳐 모양 차이가 작고, 안드로이드 구글 로고가 막대 뒤로 숨지 않으며, 막대가 스크롤 내용을 덮지 않으니 화면마다 116 여백을 둘 필요가 없다. 대신 상수·훅 하나(F1)를 모두 쓴다. 홈 카드가 덮는 로고는 `mapPadding` 으로 |
| 대안 화면 자리 | R1·R2 숨은 탭 경로 + `backBehavior="history"` / R3 홈 탭 쪽 스택 | **숨은 탭 경로** — 홈을 스택으로 다시 짜지 않고 URL 이 그대로, 활성 탭은 경로로 '홈' |
| 활성 탭 다시 누름 | R1 웹처럼 무시 / R3 앱 관례(맨 위로) | **무시**(§3.1). D13(d) 로 사용자가 바꿀 수 있다 |
| 모달 시트 | 발견 '동적 크기 0'·`ModalSheet.web.tsx` / R2 '안 열리면 파일 분리' / R1 `presentedRef` | **R1** — 원인을 코드로 확인했다. `.web.tsx`·snapPoints 처방은 버린다 |
| Button | R1 숫자 size 표 / R2 'G1-20 + size sm' / R3 xs~xl | **R1** — 모든 호출 자리 값이 이미 표에 있고, lg=52·48 이름 충돌이 없고, 높이를 style 로 넣어 클래스 충돌이 없다 |
| Chip | R2 variant 묶음 / R3 `selectedTone="gold"` | **R2** — 웹의 선택 모양이 화면마다 셋이라 prop 하나로 표현이 안 되고, variant 가 클래스 묶음을 통째로 바꿔 끼운다 |
| ErrorState | R3 `variant:'board'` / R2 대기 전용 `BoardError` | **R2** — 웹 구조(공용 + 대기 화면 안)를 그대로 따라 이식 원본 추적이 쉽고 공용 8곳이 안 바뀐다. 낭독은 `useAnnounce` 로 공유 |
| EmptyState | R3 variant + `ctaPill` / 발견 화면 전용 | **화면 전용 + `Button` primary·full** — 공용 EmptyState 는 그대로 |
| 확인 토스트 자리 | R2 `lib/platform/confirm.ts` / R3 `components/ui/confirmToast.ts` | **`components/ui/confirmToast.ts`, 함수 이름 `confirmDestructive`** — 스타일을 Toast 와 같이 쓰고, `lib/platform` 은 OS 어댑터 자리 |
| 선택 상자 | R3 `SelectField`(control·pill·field) + ModalSheet / R2 G4b-08 가운데 RN Modal / R1 `LanguageSwitcher.web` 투명 select | **`components/ui/SelectField.tsx` 하나**: 웹 빌드는 투명 `<select>` 겹침, 네이티브는 **가운데 RN Modal 라디오 목록**(48pt 행) — Chrome 안드로이드의 select 모양과 같고, RN Modal(소개 모달) 안에서도 따로 Provider 가 필요 없다. `LanguageSwitcher` 는 그 위 얇은 감싸개(pill·glass) |
| 언어 접근 이름 | `app.intro.languageLabel`·`settings.langTitle`("언어") / `app.mypage.languageSelect` / R1 `app.common.languageSelect` | **새 키 `common.languageSelect`**(언어 선택 · Select language · 言語を選択 · 选择语言) — 웹 하드코딩도 W1 에서 같은 키로 바꾸니 `app.` 아님. 안 쓰게 되는 `app.intro.languageLabel` 은 F4 에서 지움 |
| 알림 | v1 전부 지금 / R2 전부 이식 / R3 골든만 지금 | **R3 분할**(D10) — 모듈 `lib/platform/notify.ts`, 배지 `components/GoldenHourBadge.tsx` 하나를 카드·저장·대기가 쓴다 |
| 다시 불러오기 | v1 간격 유지 / R2 웹처럼 매번 | **매번**(D16) — 180초 캐시, 웹과 같은 부하 |
| 위치 약관 짝 | v1 C + ①(홈 첫 진입) / R1 A+① 또는 C+② | **A+①**(D3) — v1 의 '홈 첫 진입에서 묻기'는 어느 발견에도 없는 새 흐름이었다 |
| 표지 경로 | R2 `components/` / R3 `components/ui/` | **`components/PlacePhotoFallback.tsx`**(F13 규칙, 웹과 같은 자리). 선은 `vectorEffect="non-scaling-stroke"` + 1.4 + round cap·join, 그라데이션은 viewBox 없는 별도 Svg, 문양 함수는 `lib/placeEmblem.ts` 로 복사 + PORTING |
| NowChip | 발견 `features/waiting/` / G4b-06·R2·R3 `components/ui/` | **`components/ui/NowChip.tsx`**(ping 1.5초 + 0.5초 쉼). 옮기는 동안 `features/waiting/NowChip.tsx` 는 재수출로 두고 화면 묶음이 가져오기를 바꾼 뒤 F4 에서 지운다(병렬 묶음이 화면 파일을 나눠 갖게). 코스의 지역 사본은 D4 가 지운다 |
| LoadingReveal | G5a-09 `features/waiting/` / G4b-20·R2·R3 `components/ui/` | **`components/ui/LoadingReveal.tsx`**(variant waiting·course·shared, 스켈레톤은 children). 링은 R3 진행값 식, 내레이션은 `entering` 대신 shared value(웹 빌드에서 entering 실패 — R2) |
| 골든타임 배지 | R2 `components/GoldenHourBadge.tsx` / R3 한 담당의 `GoldenHourLabel` | **`components/GoldenHourBadge.tsx`**(웹 이름) — 대기 `GoldenHourLabel` 과 카드 `GoldenHourLine` 을 대신한다. 크기는 B4a, '알림 받기'는 F1 |
| 광원 | 여러 벌(LandingBackdrop·AuthBackdrop·BoardGlow·쿠폰·개인정보·설정) | **`components/ui/Glow.tsx`** 하나 — R3 API(`color·opacity·size·position·scroll`), R1 CSS blur 환산(캔버스 w+4σ, 중심 α(1−e^(−r²/2σ²)) …), R2 프리셋(저장 300/100 · 대안 600/120 · 대기 520/120) |
| 돌림표 | 40/3·40/2·12·14 | **`components/ui/RingSpinner.tsx`**(크기·테·색 prop) |
| 뒤로 원 | G4a-15·G4b-02·G5a-01(조금씩 다름) | **`components/ui/BackCircleButton.tsx`**(44 원 `bg-white/90 border-line`, 그림자 0.1, 코스만 지도 위 floating·0.15), 목적지 `router.navigate('/')`, 라벨 키는 화면별 |
| 공유 버튼 | G4a-23·G4b-03 | **`components/ShareButton.tsx`**(웹 이름) — `onShare` 가 결과를 돌려주고 복사면 ✓ 2초, 실패 토스트 10초 |
| 마스코트·로고 자산 | `components/` vs `components/ui/`, `mascot-guide.webp` vs `mascot/`, 로고 @2x·@3x | **`components/NextSpotMascot.tsx`** + `assets/images/mascot/nextspot-guide.webp`(512 원본), 로고는 `assets/images/nextspot-logo.png` 한 장(505×109, @2x·@3x 안 만듦) |
| spotPoints | 카드 안 / R2 `lib/core/spotPoints.ts` | **`lib/core/spotPoints.ts`** — 카드·킵·대안·비교·코스 행·저장 정렬이 같이 쓴다 |
| 출처 판정 모듈 | 둘(port·card) | **port 판 하나**(R3), 출처 줄 UI 는 `components/ui/CreditLine.tsx` |
| 주변 수요 색 토큰 | G3-17 v3 hex `area-*` / G4a-24 `*-web` | **`*-web` = 웹 Tailwind v4 sRGB**(sky-500 `#00a6f4` · 700 `#0069a8` · 800 `#00598a` · 900 `#024a70` · indigo-500 `#615fff` · 700 `#432dd7` · 900 `#312c85`) |
| 노을 끝색 | v1 `#f6dac7`·`#f5ddcc` | **R1: `landing-sunset-end #f6dac8`, `auth-sunset-end #f6dfcf`**(tokens.test 반올림 기준) |
| 금색 대비 수치 | 발견·Expo 주석 3.7:1 | **2.64:1**(세 검토), 금 진 6.78:1, cta 양끝 5.05·5.86 |
| keep-all 자리 | G2-G06 `+html.tsx` / G5a-13 `Text` 웹 분기 | **`lib/webSetup.web.ts` CSS 한 곳**(R1·R3) — Text 는 고치지 않는다 |
| G2-14 ✨ 연결 | 발견: `catalog.ts`·`explore/logic.ts` 수정 | **둘 다 안 고친다**(R1 — 사이드 사전은 이미 읽고, `getRecommendations` 가 `discoveryTheme` 을 받는다). 새 `DiscoveryPanel` 만 |
| 저장 상세 | G4a-13 `presentation`·`rankMode` / G3-01 | **G3-01 카드 + G3-R02 저장 변형**: `sheetSlot.tsx` 가 베일(화면 루트)·도크(`bottom: NAV_GAP`, 최대 폭 400)·`compactPeek={false} showCompare={false} showListRank={false} rejectIsRemoval` 로 부른다. `presentation`·`rankMode` 는 만들지 않는다 |
| 카드 제스처 | 발견: Pan + ScrollView 동시 | **R2**: 손잡이·미리보기·바닥 버튼 줄 세 곳에 Pan(각자 `makePan()`), ScrollView 는 감싸지 않음(스크롤 영역 끌기 = 스크롤만) |
| 카드 바깥 틀 | 한 겹 | **R2 두 겹**(바깥 그림자·안쪽 overflow hidden — 안드로이드 그림자 잘림) |
| G3-01 지울 범위 | 발견: `Sheet` 계열 통째로 | **R2**: 비모달 `Sheet` 계열과 `sheetPeek`·`sheetCoverHeight`·`mapBottomInset` 만 지우고, `ModalSheet`·`Handle`·`SheetBackground`·`SHEET_ANIMATION`·`CONTAINER_A11Y`·`SheetScrollView`/`SheetView`·`SheetState` 는 남긴다 |
| 하위 화면 이동 | G2-G02 와 G5b-01 이 각각 | **B6 한 번**(G5b-01 1~4번 + G2-G02 대안, G5b-01 5번은 버림) |
| 홈 알약 토스트 파일 | G2-G09·G3-33 각각 | **하나**(F10) |
| 혼잡 제보 토스트 자리 | `toast.custom` / 버튼 안 절대 배치 | **이름 붙은 채널 `report`**(R2) — 둘 다 웹 자리를 못 만든다 |
| 프로필 수정 실패 토스트 | 모달 밖 / 오버레이로 바꾸기 | **RN Modal 유지 + 안에 `AppToaster id="profileEdit"`**(R3 — 오버레이는 탭 막대를 못 덮는다). 안드로이드 흐림 없음 |
| G4b-08 가정 시간 UI | `Sheet` / `@expo/ui` | **`SelectField` control**(`components/AssumedTimeSelect.tsx` 가 프리셋·배지까지 감싸 대기·코스가 같이 쓴다). `@expo/ui` 는 안 쓴다(재빌드 필요) |
| G5b-14 레이더 눈금 | 5겹·`v/max` | **R3** `radarNiceMax`(recharts 와 1~100 일치) + 4겹 유지 |
| G5b-23 2열 | `48%`·`48.5%` | **두 개씩 줄 + `flex-1`**(R3 — 반올림으로 넘침) |

## 5. 구현 순서와 묶음

### 5.1 공통 규칙

- **소유 파일만 고친다.** 목록 밖을 고쳐야 하면 멈추고 메인 세션에 보고한다.
- **메인 세션만 고치는 파일**: `lib/theme/tokens.ts`·`tokens.test.ts`(A3 뒤에는 요청 목록으로), `apps/web/lib/i18n/messages/*.json`, `apps/mobile/PORTING.md`, `components/ui/index.ts`, `docs/**`. 새 공용 컴포넌트는 파일 경로로 import 한다 — index export 는 병합 때 메인이 더한다.
- **문구는 있는 키만** 쓴다(새 키는 A3). 병렬 에이전트에 문구를 나눠 맡기지 않는다([`apps/mobile/AGENTS.md`](../apps/mobile/AGENTS.md)).
- **클래스는 덧붙이지 말고 바꿔 끼운다.** `cn` 은 병합하지 않고(`cn.ts:1-2`), NativeWind 는 같은 속성 클래스 둘이 있으면 CSS 순서(알파벳 — 네이티브도 같음)로 고른다. "prop 을 더하고 클래스를 덧붙인다"는 처방은 모두 "조건으로 한 클래스만 고른다" 또는 style 로 바꿔 읽는다(Button·Chip·Tag·Pill·ErrorState·CongestionReportButton 등). Card 는 A1 뒤에만 색 클래스를 준다(그 전에는 style).
- **웹 Tailwind v4 ↔ NativeWind(Tailwind 3.4) 이름 차이**: `rounded-sm`(4↔2px), `shadow-sm`(v4 = v3 `shadow`), `blur-sm`, `tracking-*`(em) 등. 웹 클래스 이름을 글자 그대로 옮기지 말고 값(px·문자열)으로 옮긴다.
- **바닥 자리는 F1 상수·훅만** 쓴다(15·24·101·116 을 직접 쓰지 않는다).
- **공개 이름 유지**: 다른 묶음이 import 하는 이름(`features/recommendation-card/index.ts` 의 `recordActiveTrip`·`markTasteFeedback`·`SheetCandidate`·`CardFacility`, `HomeOverlays` export, `CongestionReportButton` 의 `facility`·`isFirst`·`onReported`)은 정해진 묶음(H3a·H3b·F4)만 지운다.
- 줄 높이: B1(G2-G05) 뒤에 화면 묶음이 Expo 높이를 다시 재고, 1.5배가 아닌 값(snug·tight·relaxed·none)만 각 화면에 적는다.
- WebView 금지, `android/`·`ios/` 손대지 않음(CNG), 새 의존성은 `npx expo install`(F1 만).
- **게이트**(`apps/mobile`): `npx tsc --noEmit` · `npm test` · `npm run check:shared` · `npx expo-doctor`(exp.host·RN Directory 접속 실패 2개는 네트워크 — CI 에서 본다) · `npm run export:android` · `npx expo export --platform web`(하네스용). 웹을 만진 묶음(A3·F4·W1·L1)은 `apps/web` 에서 `npm run lint && npm run typecheck && npm run test && npm run build`, 문서는 `node scripts/check-docs.mjs`.
- **커밋만**(푸시·병합은 메인). 메시지 `fix(mobile): …`/`feat(mobile): …`(한국어, 본문에 왜와 ID), `Co-Authored-By` 트레일러. 메인은 묶음마다 병합 → 게이트 → `yunseong` 푸시 → HANDOVER 기록. main 반영은 사용자 지시 때만.
- **검토**: 웨이브마다 렌즈가 다른 검토(웹 동작 일치 · 플랫폼·법규 · 문구·접근성·디자인 원칙, Opus)로 높음·중간 0 까지. 지은 쪽이 자기 코드를 검토하지 않는다.
- **동시 실행은 3~4 묶음** 권장.

### 5.2 흐름과 상태

```
A  먼저(서로 파일 안 겹침):  A1 앱 버그(모달 시트·Card) ∥ A2 값 오류 ∥ A3 토큰·문구·탭 막대 치수(메인)
B  기반:  B1 글자·유리 ∥ B2 Button·Chip·Pressable·ErrorState ∥ B3 시트 prop·토스트·확인 ∥ B4a 새 그림 ∥ B4b 새 조작 ∥ B5 지도 래퍼 ∥ B6 내비 셸
D  화면:  D1 첫 실행·인증 ∥ D2 저장 ∥ D3 대안 ∥ D4 코스 ∥ D5 대기 ∥ D6 마이 ∥ H1 추천 카드 ∥ H2a 홈 부품 ∥ H2b 예측 띠·주차장
H  홈 연결(차례대로):  H3a 카드 연결·저장 상세(H1·H2a 뒤) → H3b 지도 층·카메라(H3a·H2b 뒤)
F  마무리:  F1 골든타임 알림(재빌드) ∥ F2 ✨ ∥ F3 작은 후속 둘  →  F4 정리·전체 재촬영
따로:  W1 웹 수정(웹 게이트) · L1 개인정보(법무 뒤)
```

임계 경로: A1·A3 → B3·B5·B6 → H1 → H3a → H3b → F4. 웨이브 D 의 각 묶음은 '선행'의 기반이 병합된 뒤 시작한다.

| 묶음 | 내용 | 크기 | 모델 | 선행 | 재빌드 | 상태 |
|---|---|---|---|---|---|---|
| A1 | 모달 시트 원인·Provider 순서·Card 기본값 | S | Opus | §3 답 | 아니오 | 끝(e89305a) |
| A2 | SPOT ×100 · 직접 고른 곳 도보 분 · 킵 북마크 모양 | S–M | Sonnet | §3 답 | 아니오 | 끝(d897e37) |
| A3 | 토큰·새 문구 키·`navMetrics` | M | 메인 | §3 답 | 아니오 | 끝(60f0042, 일부 토큰은 요청 때) |
| B1 | 글자 기본값·글꼴·keep-all·유리·Icon | L | Opus | A3 | 아니오 | 끝(0d828f3) |
| B2 | Button·Chip·Pressable·ErrorState | M | Sonnet | A1·A3 | 아니오 | 끝(f2d7a27) |
| B3 | ModalSheet 선택 prop·AppToaster·confirmToast | M | Opus | A1·A3 | 아니오 | 끝(1519938) |
| B4a | Glow·RingSpinner·마스코트·표지·CreditLine·RankBadge·GoldenHourBadge·자산 | M | Sonnet | A3 | 아니오 | 끝(8f21d81) |
| B4b | SelectField·LanguageSwitcher·NowChip·LoadingReveal·BackCircleButton·ShareButton·가정 시간 | M | Sonnet | A3 | 아니오 | 끝(528ba50) |
| B5 | 지도 래퍼 | L | Opus | A3 | 아니오 | 끝(613ac09) |
| B6 | 탭 막대·탭 안 이동·하위 머리·공지·점검 | L | Opus | A1·A3 | 아니오 | 끝(c5cee3b) |
| D1 | 게이트·인증·랜딩·서비스 소개·404·오류 화면 | L–XL | Opus | B1·B2·B3·B4a·B4b·B6 | 아니오 | 진행 |
| D2 | 저장 목록 | M | Sonnet | A2·B2·B3·B4a·B4b | 아니오 | 진행 |
| D3 | 대안 화면 | M | Sonnet | A2·B2·B4a·B4b·B5·B6 | 아니오 | 진행 |
| D4 | 코스 | L | Sonnet(01·08·20 은 Opus 검토) | A2·B2·B4a·B4b·B5 | 아니오 | 끝(17290c1) |
| D5 | 대기 보드 | L | Sonnet | B2·B4a·B4b | 아니오 | 끝(7f4be0f) |
| D6 | 마이 + 하위 7 | L | Sonnet | A1·B2·B3·B4a·B4b·B6 | 아니오 | 대기 |
| H1 | 추천 카드·여정·방문 확인·제보 | XL | Opus | A2·B2·B3·B4a | 아니오 | 진행 |
| H2a | 홈 상단·도구·검색 결과·HomeToast·축제 추출 | M | Sonnet | A1·B1·B3·B4b | 아니오 | 끝(17616d3) |
| H2b | 예측 띠·주차장 패널 | L | Opus | B4b·B5 | 아니오 | 대기 |
| H3a | 홈에 카드 연결·저장 상세 | L | Opus | H1·H2a | 아니오 | 대기 |
| H3b | 홈 지도 층 연결·카메라·위치 흐름 | L | Opus | H3a·H2b·B5 | 아니오 | 대기 |
| F1 | 골든타임 '알림 받기'(D10 ①) | M | Opus | B4a·D5·H1 | **예** | 대기 |
| F2 | ✨ 경주 테마(D12) | L | Opus | H3b | 아니오 | 대기 |
| F3 | 랜딩 축제 배너 · 대안 혼잡 제보 | S | Sonnet | D1·H2a / D3·H1 | 아니오 | 대기 |
| F4 | 문구 삭제·죽은 파일·PORTING·전체 재촬영 | M | 메인 + 문구 1 | 전부 | 아니오 | 대기 |
| W1 | 웹 수정(§7) | M | Sonnet(웹) | D1·§7 답 | — | 대기 |
| L1 | 개인정보 문안(법무 뒤) | M | 메인 + 문구 1 | 법무 검토 | 아니오 | 대기 |

### 5.3 여러 묶음이 만지는 파일(소유 차례)

병렬 묶음은 같은 파일을 갖지 않는다. 아래 파일은 차례대로만 고친다. 나머지 파일은 §5.4 각 묶음 '소유'에 한 묶음씩 적었다.

| 파일 | 소유 차례 |
|---|---|
| `app/_layout.tsx` | A1(Provider 순서) → B6(Stack 항목 정리·공지·점검·navTheme useMemo) → D1(GuideProvider) |
| `lib/theme/tokens.ts`·`tokens.test.ts` | A3 → 이후 요청분은 메인 |
| `components/ui/index.ts`, `PORTING.md` | 메인만 |
| `components/ui/Sheet.tsx` | A1(원인) → B3(선택 prop) → H3a(비모달 `Sheet` 계열 삭제) |
| `components/ui/Card.tsx` | A1 |
| `features/home/HomeScreen.tsx` | A2(호출 한 줄) → H3a → H3b → F2 |
| `features/home/sheetModel.ts`(+test) | A2 → H3a(지우기) → H3b |
| `features/home/homeModel.ts`(+test) | H3a → H3b |
| `features/home/HomeOverlays.tsx` | H2a(더하기만) → H3b(옛 export 삭제) |
| `features/recommendation-card/**` | A2(`cardModel`·`actionsCore`) → H1 → H3a(`RecommendationSheet` 삭제) → F2(contextBadge) |
| `features/saved/savedList.ts`(+test) | A2 → H3a |
| `features/saved/sheetSlot.tsx` | H3a |
| `app/(tabs)/saved.tsx`, `features/saved/SavedCard.tsx` | D2 |
| `features/explore/{AlternativeCard,ComparisonSection}.tsx` | A2(spotPoints) → D3 → F3(혼잡 제보) |
| `features/explore/{RecommendScreen.tsx,useAlternatives.ts}` | B6(머리 블록 삭제 — RecommendScreen) → D3 → F3 |
| `features/course/components/StopRows.tsx` | A2(spotPoints) → D4 |
| `app/(tabs)/course.tsx`, `features/course/**` | D4 |
| `features/waiting/{NowChip,GoldenHourLabel}.tsx` | B4b·B4a(재수출로 바꿈) → D5(가져오기 바꿈) → F4(삭제) |
| `components/GoldenHourBadge.tsx` | B4a → F1('알림 받기') |
| `app/mypage/*` → `app/(tabs)/mypage/*` | B6(이동·`_layout`) → D6(화면) |
| `features/mypage/components/SubPageHeader.tsx` | B6 |
| `features/onboarding/guideEntry.ts` | B6(만듦) → D1 |
| `features/onboarding/LandingHero.tsx` | D1 → F3(축제 배너) |
| `lib/core/apiClient.ts` | H2b |
| `package.json`·`package-lock.json`·`app.json` | F1 만 |

### 5.4 묶음별

'확인'은 §8.1 하네스로 다시 찍을 스크립트(`D:\NextSpot` 에서 `node scratch/parity/work/<그룹>/<스크립트>`)와 폰에서 볼 것이다.

**A1 앱 버그 둘** — Opus, S, 가장 먼저
- ID: G2-G07(R1 정정), G5b-03(R3 정정 — Card 규칙만, 색 카드 적용은 D6).
- 소유: `components/ui/Sheet.tsx`, `components/ui/Card.tsx`, `app/_layout.tsx`.
- 확인: `node scratch/parity/overlays/R1/r1-checks.mjs`(시트 제목 Expo 1), G2 `02-top.mjs`·`04b-panels.mjs`, G3 `06-report.mjs`(radiogroup 3), G5b `02-main-states.mjs`(임팩트 카드 테두리 금 0.35). **Z Fold7**: 7개 시트가 열리고·닫히고·다시 열리는지, 뒤로 키로 닫히는지, 시트 안 문구가 번역되는지.

**A2 값 오류** — Sonnet, S–M
- ID: G3-03(`lib/core/spotPoints.ts`, 쓰는 곳 cardModel·actionsCore·AlternativeCard·ComparisonSection·StopRows), G3-R01 1~4번(`cardModel.ts:195` 를 `travelTime ?? estimateWalkingMinutes(distanceM)`, `buildSelectedCandidate` 에 기준점 → 거리, `HomeScreen.tsx:560` 호출부·deps), G4a-R01(킵 저장 `spotPoints` + `timeToService`, `savedList.ts` `normScore`·정렬 보정).
- 소유: `lib/core/spotPoints.ts`(+test), `features/recommendation-card/{cardModel,actionsCore}.ts`(+test), `features/home/{sheetModel.ts,sheetModel.test.ts,HomeScreen.tsx}`(호출 한 줄), `features/saved/savedList.ts`(+test), `features/explore/{AlternativeCard,ComparisonSection}.tsx`, `features/course/components/StopRows.tsx`.
- 확인: 테스트(0.548→55·54.8→55·null→0, 850m→16분, 섞인 목록 순서) · G3 `01-probe.mjs`('SPOT 55점') · `07-variants.mjs error`(도보 2분·14:27→14:29).

**A3 토큰·문구·탭 막대 치수** — 메인 세션, M
- 토큰(값은 발견·검토 그대로, 계산식은 `tokens.test.ts`):
  - 색: `button-gold`(D2 값) · `landing-sunset-end #f6dac8` · `auth-sunset-end #f6dfcf` · `kakao-yellow`·`kakao-ink` · `benefit-relaxed`·`benefit-quiet`(웹 globals.css 값, 대조에 넣음) · `emerald-500-web` · `sky-*-web`·`indigo-*-web`(§4.3).
  - 그림자: `ctaLg`·`ctaHero` · `goldSoft`(0 2 10 금 .16) · `goldBadge` · `goldToggle` · `pill`·`pillStrong` · `langPill` · `glass` · `tabBar` · `homeToast` · `toast` · `modal` · `floatCard` · `sheetTop`.
  - 그라데이션: `valueBox` · `goldRank` · `goldLine` · `impactCard`·`savedBanner`·`labCard`·`merchantCard` · `landing`·`auth` 바탕 3단.
  - 글꼴: ja·zh 목록, 웹 빌드 대체 목록. 배치: `NAV_BAR_HEIGHT = 101`, `NAV_CLEARANCE = 116`(`LAYOUT_ONLY` 에서 `--tourist-nav-clearance` 를 빼고 116 대조).
- 새 파일 `components/navigation/navMetrics.ts`: `NAV_GAP`, `isTabRoute(pathname)`, `useNavInsets()`(→ `gap`·`onTab`·`barHeight`·`toastBottom`·`fromScreenBottom(px)`).
- 문구: §5.5 새 키.
- 소유: 토큰 두 파일, i18n JSON ×4, `navMetrics.ts`. 게이트: 모바일 + 웹.
- **한 것(2026-11-11)**: 색 `button-gold`(#705819)·노을 끝 둘(계산식 대조)·카카오 둘·`benefit-relaxed`/`-ink`·`benefit-quiet`/`-ink`(globals.css 대조)·`emerald-500-web`·`sky-*-web`·`indigo-*-web` / 그림자 `ctaLg`·`ctaHero`·`goldSoft`·`goldBadge` / 그라데이션 `landing`·`auth`·`goldRank`·`impactCard`·`savedBanner`·`labCard`·`merchantCard` / `NAV_BAR_HEIGHT`·`NAV_CLEARANCE`(웹 모바일 폭 116 대조) / `components/navigation/navMetrics.ts`(훅) + `navMetricsCore.ts`(순수 계산·테스트) / 새 키 4개.
- **미룬 것**: 발견·검토에 값이 적혀 있지 않은 그림자·그라데이션(`goldToggle`·`pill`·`pillStrong`·`langPill`·`tabBar`·`homeToast`·`toast`·`modal`·`floatCard`·`sheetTop`·`valueBox`·`goldLine`)과 ja·zh·웹 빌드 글꼴 목록. 쓰는 묶음이 웹 실측값을 요청 목록에 적으면 메인이 넣는다(§5.1 '요청 목록으로').

**B1 글자·유리** — Opus, L
- ID: G2-G03(Glass·글자색 컨텍스트), G2-G04, G2-G05, G2-G06(R1 — CSS), G2-G08(입력 테두리 CSS), G2-R03, G5a-13(닫힘), G4a-02·G5b-12(Icon `fill`).
- 소유: `components/ui/{Text,Glass,Icon}.tsx`, `lib/webSetup.web.ts`, `lib/i18n/I18nProvider.tsx`.
- 확인: 병합 직후 `scratch/parity/examples/tour.mjs` 전체(새 기준선), G2 `10-locale.mjs`(ja·zh), `06-mapstates.mjs`·`08-notices.mjs`(keep-all), 글꼴 TTF 를 abort 한 쌍(고딕인지), G5a `02-scenarios.mjs graded`(줄 높이). 폰: §8.2 글자·유리.

**B2 기본 부품** — Sonnet, M
- ID: G1-20·G4b-22·G5b-05·12·34(Button — R1 표), G4a-05·G4b-18·G5b-27(Chip variant), G1-34·G2-25(4번)·G4b-29·G5a-25·G5b-06(Pressable aria), G4a-28·G4b-21(ErrorState + `useAnnounce` export), 누름 피드백.
- 소유: `components/ui/{Button,Chip,Pressable,ErrorState}.tsx`.
- 확인: G4b `cap-states.mjs err`(다시 시도 모양), G5b `05-inquiries-lab.mjs`(칩 `pressed`), G1 `cns_set.mjs s`(선택 a11y), G1 `auth.mjs l`(버튼 높이 52·46). 폰: TalkBack 상태 읽기.

**B3 시트 prop·토스트·확인** — Opus, M
- **주의(A 검토 L3)**: `isTabRoute` 는 `/explore/*`·`/mypage/*` 도 막대 있는 경로로 본다(B6 뒤의 모양). B6 가 이 화면들을 `(tabs)` 안으로 옮기기 전에 `AppToaster` 가 `useNavInsets()` 를 쓰면 그 화면 토스트가 없는 막대 위로 뜬다 — B3 는 B6 병합 뒤에 자리 연결을 켜거나, B6 와 같은 웨이브 끝에 함께 확인한다. `fromScreenBottom` 은 안전 영역을 빼지 않는다(웹 실측이 안전 영역 없는 390×844 기준).
- ID: G3-21(혼잡 제보 모달 모양 prop), G2-13(`stackBehavior`)·17·18·27(시트 prop), G3-34·G2-G09(AppToaster·아이콘), G2-G01(토스트 자리), G3-22(`report` 채널), G5b-17(⑥ `id`), G4a-12·G5b-35(`confirmDestructive`), G4b-26.
- 소유: `components/ui/{Sheet,Toast}.tsx`, `components/ui/confirmToast.ts`(새).
- 확인: G2 `04b-panels.mjs`·`04c-panels.mjs`, G3 `12-toasts.mjs`. 폰: 시트 모양 회귀 없음, 확인 토스트 버튼 TalkBack.

**B4a 새 그림** — Sonnet, M
- ID: G3-08·G4a-19·G4b-12·G5a-15(`components/PlacePhotoFallback.tsx` + `lib/placeEmblem.ts`), G5a-16(`components/ui/CreditLine.tsx`), G4a-07·18·G5a-14(`components/ui/RankBadge.tsx`), G1-02·31·G2-05(`components/NextSpotMascot.tsx` + 자산), G1-29·G2-05·20(`components/ui/RingSpinner.tsx`), G4a-14·G5a-02·G5b-20·31·G5b-R01·G1-21(`components/ui/Glow.tsx`), G4a-01·G5b-07(로고 자산), G4a-09·G5a-12(배지 부분)·G3-18(모양)(`components/GoldenHourBadge.tsx`, `features/waiting/GoldenHourLabel.tsx` 는 재수출로).
- 소유: 위 새 파일들 + `assets/images/mascot/nextspot-guide.webp`·`assets/images/nextspot-logo.png` + `features/waiting/GoldenHourLabel.tsx`(재수출로만).
- 확인: `placeEmblem` 순수 테스트(웹 함수와 같은 경로). 화면 확인은 쓰는 묶음에서. PORTING 요청: 표지 원본 `apps/web/components/PlacePhotoFallback.tsx:24-90`.

**B4b 새 조작** — Sonnet, M
- ID: G5b-32·G5a-05·G4b-08(`components/ui/SelectField.tsx` + `.web.tsx`), G1-04·G2-10·G5b-07(`components/LanguageSwitcher.tsx`), G4b-08·G5a-05(`lib/core/assumedTime.ts` + `components/AssumedTimeSelect.tsx`, D11 ①), G4a-03·G4b-06·G5a-04(`components/ui/NowChip.tsx`), G4b-20·G5a-09(`components/ui/LoadingReveal.tsx`), G4a-15·G4b-02·G5a-01(`components/ui/BackCircleButton.tsx`), G4a-23·G4b-03(`components/ShareButton.tsx`).
- 소유: 위 새 파일들 + `features/waiting/NowChip.tsx`(재수출로만).
- 확인: `assumedTime` 테스트(웹 `assumedAtIsoForPreset` 과 같은 ISO), 웹 빌드에서 `<select>` 와 네이티브 목록이 같은 값을 쓰는지.

**B5 지도 래퍼** — Opus, L
- ID: G2-04, G2-08(+ 시간 초과 prop), G2-19, G2-31, G4a-25(웹 마커 이미지 실측 먼저), G4b-04, G4b-05, G4b-R01(근본: `targetLevelRef`), `mapPadding`(G3-01·G4b-01 의 로고 약관).
- 소유: `features/map/*`.
- 확인: G2 `03-map.mjs`·`06-mapstates.mjs`·`12-synthetic.mjs`, G4b `cap-extra.mjs nomap`·`cap-metrics.mjs`(userDot 14×14). 폰: 구글 지도 위 popover·기본 핀·로고.

**B6 내비 셸** — Opus, L
- ID: G2-G01(보통 흐름), G2-G02, G2-R02, G5b-01(1~4번), G5b-02, G5b-R02(1번 — 문의·고객지원 Stack 머리 끔), G4a-15(1번 — `RecommendScreen.tsx:115-133` 블록·`stackOptions`·쓰지 않는 import 삭제), G4a-31(숨은 경로 + Redirect), G2-33, G2-34(`ProvidersWithLabels` 로 넘김), G2-G04(navTheme useMemo).
- 순서: 경로 이동 → `TouristTabBar`(`expo-router/js-tabs`, `backBehavior="history"`) → `(tabs)/mypage/_layout.tsx`(`unstable_settings.initialRouteName='index'`, index 머리 숨김, 하위 `SubPageHeader` — 라벨 `settings.backAria` 포함 R3) → 공지·점검 → `guideEntry.ts`(`openGuide()`/`registerGuideOpener()`, D1 병합 전 임시로 `/intro`) → `lib/core/consoleEntries.ts`(D7).
- 소유: `app/(tabs)/_layout.tsx`, `components/navigation/TouristTabBar.tsx`(새), 경로 이동한 파일들, `app/(tabs)/mypage/_layout.tsx`, `features/mypage/components/SubPageHeader.tsx`(새), `components/{AppNoticeBanner,AppMaintenanceScreen}.tsx`(새), `features/onboarding/guideEntry.ts`(새), `lib/core/consoleEntries.ts`(새), `features/explore/RecommendScreen.tsx`(머리 블록만), `app/_layout.tsx`(A1 뒤).
- 확인: G2 `09-nav.mjs`·`01-default.mjs`(막대 0,743,390×101 · 칸 68×48 · 알약 56×48 · 하위 화면에도 막대), `node scratch/parity/overlays/R1/r1-locale-nav.mjs`(en·zh 글자 높이 ≥15), G5b `04-coupons-impact.mjs`·`08-behaviour.mjs`(딥링크 뒤로 = `/mypage`), G4a `probe-back.mjs`·`exm.mjs`, G2 `08-notices.mjs`. 폰: 알약·햅틱, 뒤로 = history, 활성 탭 누름 무시, en·ja 탭 글자.

**D1 첫 실행·인증·소개** — Opus, L–XL(안에서 차례대로: 가 → 나)
- (가) 게이트·인증: G1-01(R1 — `push` + `dismissAll`), G1-14(D3 A — 모양만), G1-15(R1 — 게이트 예외 `view=landing`, `BackHandler`), G1-16~19, G1-20·24·26(Button 표 적용), G1-21(AuthBackdrop, 붙이는 법 R1), G1-23(+`socialPolicy.test.ts`), G1-25, G1-27·28, G1-29(`FadeInUp` 1s), G1-34(적용).
- (나) 랜딩·소개: G1-02(바탕은 `Screen` 밖 R1 구조), G1-03, G1-04(LanguageSwitcher 적용), G1-06·07(`openExternalUrl`), G1-08(R1 — 머리 `gap`, CTA 는 `markIntroSeen()`, 모달 안 Provider), G1-09(`featureShortcuts.ts` 복사 — `check:shared`), G1-10·11·12·13, G1-31(D2(b)), G1-32.
- 소유: `app/{intro,guide,+not-found,setup,login,forgot-password}.tsx`, `app/auth/callback.tsx`, `components/AppErrorBoundary.tsx`, `features/onboarding/**`, `features/auth/{AuthTextField,AuthBackdrop,socialPolicy}`(+test), `app/_layout.tsx`(B6 뒤, GuideProvider).
- 확인: G1 `lnd.mjs a|b|c|d|e`, `cns_set.mjs c|s|g`, `auth.mjs l|f|c|r`(Expo 쪽 조작은 G1-08 '확인 방법'대로). 폰: 소개→로그인→뒤로=소개 / 소개→로그인→게스트→동의→설정→홈→뒤로=종료, 구글 버튼·복귀.

**D2 저장** — Sonnet, M
- ID: G4a-01(R2 — ScrollView `flexGrow:1`·여백 24·아래 `NAV_GAP`, 머리 접근성), 02, 03(가져오기 바꿈), 04, 05(`Chip variant="savedFilter"`), 07(`pr-[48px]` 유지), 08(앵커 폭 120), 10, 11(style 색), 12(`confirmDestructive`, `Alert` import 삭제), 14, 18(배지 적용), G4a-R02.
- 소유: `app/(tabs)/saved.tsx`, `features/saved/{SavedCard,SavedEmpty}.tsx`.
- 확인: G4a `saved1.mjs`·`saved2.mjs`(로고 중심 x=195, 칩 44 금 선택, 빈 카드 320, `dialog` 0회). 폰: 확인 토스트(G4a-12).

**D3 대안** — Sonnet, M
- ID: G4a-14, 15(`BackCircleButton`, 아래 `NAV_GAP + 16`), 16(형제 Text 크기·색), 18, 19(PhotoCover → 표지·CreditLine), 20, 21(`text-center`·버튼 역할), 23(`ShareButton`, `handleShare` 결과 반환, `Alert` 삭제), 24, 25(미니맵 기본 핀), 26(표 열 너비), 27(style 색), 28(`reloadKey` 를 effect 위로 — TDZ), 29, G4a-R03(Tag `weight`·`surface`), R04, R05.
- 소유: `app/(tabs)/explore/recommend.tsx`, `features/explore/{RecommendScreen,AlternativeCard,ComparisonSection,MiniMapPreview,PhotoCover,Tag}.tsx`, `useAlternatives.ts`(B6·A2 뒤).
- 확인: G4a `recommend1.mjs`·`recommend2.mjs`·`probe-back.mjs`. 폰: 배지 z(G4a-18), 하드웨어 뒤로.

**D4 코스** — Sonnet(G4b-01·08·20 은 Opus 검토), L
- ID: G4b-01(R2 구조 — `mapLive` 일 때만 지도 zIndex, 시트 `flexGrow:1`, 아래 `NAV_GAP`), 02(BackCircleButton floating), 03(ShareButton), 05, 06(NowChip, 지역 사본 삭제), 07(🕒 13px), 08(AssumedTimeSelect, 캐시 preset `model.ts`+test, `useCoursePlan` silentRefresh·deps), 09~17, 18(`Chip variant="courseType"`), 19(import·주석 정리), 20(LoadingReveal children, 첫 로딩 자리 zIndex 없음), 22, 23(+`model.test.ts:84`), 24, 26, 27(`resetInputs` 빈 값이면 그대로, ref cleanup), 28, 29, G4b-R01(`duration:0`), R02(자간 px), R03(`rounded-[4px]`), R04, R05(흐림 200ms).
- 소유: `app/(tabs)/course.tsx`, `features/course/**`, `lib/platform/shareUrls.ts`.
- 확인: G4b `build-overlays.mjs` → `cap-default.mjs plan1 plan3`(1곳 코스 100m 축척), `cap-interact.mjs`, `cap-states.mjs`, `cap-shared.mjs`, `cap-metrics.mjs`, `cap-extra.mjs`. 폰: 지도 끌기 = 지도만, 구글 로고 보임.

**D5 대기** — Sonnet, L
- ID: G5a-01~25(13 은 B1 로 닫힘). R3 정정: 05(`AssumedTimeSelect`), 09(LoadingReveal — 링 진행값, 장식 원 RadialGradient, 고스트 opacity 0.75, 빠진 줄), 11(보이지 않는 측정 사본), 19(배지 크기 — 버튼은 F1), 22(`BoardError` + `useAnnounce`), 24(D16 매번), 25(`aria-level` 웹 분기 캐스트). G4a-09(배지 적용).
- 소유: `app/(tabs)/waiting.tsx`, `features/waiting/**`(재수출 두 파일 제외), `components/ui/TrailingNoteText.tsx`(새, 선택 — G5a-07).
- 확인: G5a `01-baseline.mjs`, `02-scenarios.mjs graded mixed empty error loading partial nophoto photos assumed`, `03-extra.mjs`(카드 [316,316,316]), `04-retry.mjs`. 폰: 캐러셀 스냅, 점 줄 adjustable.

**D6 마이** — Sonnet, L(안에서 `parts.tsx` 먼저)
- ID: G5b-03(그라데이션 카드 적용), 04(`padded={false}`), 05(Button gold), 06(레이더 펼침 — Pressable 로 해결되면 생략), 07(머리 고정 + 로고 한 장 + LanguageSwitcher), 08·11(D7), 09(`visibleProviders` → `socialProvidersFor`), 12, 13, 14(`radarNiceMax` + 4겹), 15, 16, 17(RN Modal 유지 + `AppToaster id="profileEdit"`, 안드로이드 흐림 없음), 18(`router.navigate('/')`), 20, 21, 23(두 개씩 줄), 24, 25, 26, 27(`Chip variant="labReason"`), 28, 30(D18 — 버튼 숨김만), 31, 32(SelectField 적용), 33(판정 출처), 34, 35(`confirmDestructive`, `features/mypage/confirm.ts` 삭제), 37, 38, G5b-R01(설정 광원), G5b-R02(2·3번 — 문의·고객지원 머리를 내용 안에).
- 소유: `app/(tabs)/mypage/{index,coupons,impact,inquiries,lab,privacy,settings,support}.tsx`, `features/mypage/**`(SubPageHeader 제외).
- 확인: G5b `01-main-guest.mjs`~`08-behaviour.mjs`, `07b-support-done.mjs`, `09-verify-local.mjs`, `node scratch/parity/work/R3/01-inquiries-scroll.mjs`(머리 y 음수). 폰: 모달 위 토스트, 멀티라인 높이, 게스트 소셜 카드.

**H1 추천 카드** — Opus, XL
- ID: G3-01(R2 바로잡은 설계 — 두 겹 틀, 세 곳 Pan, ScrollView `flexGrow:0 flexShrink:1`, 최대 높이 = 홈 높이 − `NAV_GAP` − 위 안전 영역 − 160, 가장자리 흐림은 더 볼 내용이 있을 때만, `BackHandler`, 지울 범위는 §4.3), 02(짧은 화면 1줄), 05, 06(그리기), 07(저장이면 둘째 줄 왼쪽 빈 칸), 08(CardPhoto 112·표지·CreditLine, 출처 모듈 port 로 합침), 09, 10, 11, 12, 14(그리기), 15, 16, 17(v4 토큰), 18(`GoldenHourBadge` 사용), 19, 20(+`className` prop — 바꿔 끼우기), 21(B3 prop 으로 제보 모달 모양, 금 줄은 내용 안), 22(`report` 채널), 24(휴무 건너뛰기는 거절에만), 25(스켈레톤), 28(`top: insets.top + 96`), 29, 31(`bottom: NAV_GAP + 8`, 버튼 색 D2(b)), 33(`actions.ts` 토스트 주입), G3-R02(저장 변형 — `showCompare=false` 규칙·출발→도착 글자·사진 띠 조건·손잡이·MiniRow).
- 소유: `features/recommendation-card/**`(공개 export 유지).
- 확인: 부품 단위로 보고 본 확인은 H3a 뒤. 폰: 스크롤 영역 끌기 = 스크롤, 손잡이·버튼 줄 끌기 = 한 칸, TalkBack '버튼, 펼쳐짐'.

**H2a 홈 부품** — Sonnet, M
- ID: G2-03(`pinOrder.ts`+test), G2-10(`HomeTopCluster` — 왼쪽 열에 언어 알약 아래 출처, 시계 `leading-none`), G2-13·15·17·18·20·21·22(부품), G2-16(팝오버 컴포넌트 — 자리는 H3b 에서 루트), G2-27(시트 내용 — 칸 색 R1), G2-G09·G3-33(`HomeToast`), G1-05(축제 추출: `FestivalSheet` 의 `location`·`onFocus` 선택 prop, `toHttpsImageUrl` 은 `lib/platform/images.ts`).
- 소유: `features/home/{ToolChips,HomeOverlays,HomeTopCluster,HomeToast,FestivalSheet,FestivalBanner}.tsx`, `features/home/{festival,pinOrder,usePlaceSearch}.ts`.
- 확인: 화면 확인은 H3b(G2 `02-top.mjs`·`04-mocks.mjs`·`04b-panels.mjs`).

**H2b 예측 띠·주차장** — Opus, L(D12 '지금'일 때)
- ID: G2-24(`ForecastStrip`, '다른 시간'은 `AssumedTimeSelect`), G2-25(`ParkingPanel`, 주차 GET).
- 소유: `features/home/{ForecastStrip,ParkingPanel}.tsx`, `lib/core/apiClient.ts`.

**H3a 홈 카드 연결·저장 상세** — Opus, L
- ID: G3-01(연결: 홈 아래 스택 `paddingBottom: NAV_GAP`·좌우 안전 영역 + 16·카드는 마지막 자식, 비모달 `Sheet`·`sheetPeek`·`sheetCoverHeight`·`mapBottomInset` 삭제), G3-12(저장 경로), G3-13(`estimateById` 캐스트, 목록 밖에도), G3-14, G3-25·26·27(같은 스택·같은 틀), G3-28·31(자리), G3-33(연결), G3-32(웹 규칙 — §3.3), G4a-13·G3-R02(`sheetSlot` 베일·도크·저장 변형 호출).
- 소유: `features/home/{HomeScreen,sheetModel,homeModel}.ts(x)`(+test), `features/saved/{sheetSlot.tsx,savedList.ts}`, `features/recommendation-card/RecommendationSheet.tsx`(삭제), `components/ui/Sheet.tsx`(비모달 삭제).
- 확인: G3 `01-probe.mjs`(좌우 16·막대 위 15·미리보기 225 ±4)·`02-sections.mjs`·`03-interactions.mjs`·`04-actions.mjs`·`05-reject-keep-drive.mjs`·`06-report.mjs`·`07-variants.mjs`·`08-forecast.mjs`·`10-journey-seeded.mjs`·`11-attraction.mjs`·`12-toasts.mjs`·`14-pin-rank.mjs`, G4a `saved2.mjs`(상세: 사진 띠 없음·자동차 없음·[다시 안볼래요][바로 갈래요]). 폰: 겹침 z, BackHandler.

**H3b 홈 지도 층·카메라** — Opus, L
- ID: G2-01(맨 마지막 — 스택 위끝을 onLayout 으로), 02, 05, 06·07(`padded={false}`), 08, 10(자리 `insets.top + 68`), 11(좌우 className·style 둘 다), 13(줄), 16(루트 팝오버·바깥 닫기), 19, 22, 23, 24(띠는 스택 자식), 25(칩·주차장 탭), 26, 28(저장되는 처리기), 29, 30, 31(연결·`GroupSheet` 삭제), 32(D3 ①), G3-06(조건 칩 해제 = G2-28 처리기), G2-G03(홈 유리), G2-G09(호출 `:283·286·352·414·623·625`), G2-R01(공지가 상단 묶음만 덮는지), `mapPadding`(스택 높이 + 8).
- 소유: `features/home/{HomeScreen.tsx,HomeOverlays.tsx,homeContext.ts,homeModel.ts,useUserLocation.ts,locationPolicy.ts}`, `app/(tabs)/index.tsx`.
- 확인: G2 `01-default.mjs`(검색 16,68,358×58)·`02-top.mjs`·`03-map.mjs`·`04-mocks.mjs`·`04b-panels.mjs`·`04c-panels.mjs`·`06-mapstates.mjs`·`07-location.mjs`·`11-taps.mjs`·`12-synthetic.mjs`(같은 핀 cy ±8px), `overlays/R1/r1-checks.mjs`(공지 아래끝 ≤ 검색 위끝). 폰: 시계, 유리 FPS, 위치 실패 알약, 구글 로고.

**F1 골든타임 알림** — Opus, M, **네이티브 재빌드**(D10 ①)
- ID: G5a-19(버튼, R3 추가 1~5), G3-18·G4a-06(골든 부분 — 같은 배지라 카드·저장에도 자동 반영). '한산해지면 알림' 토글(G4a-06 나머지·G5b-10)은 v1.1.
- 소유: `package.json`·`package-lock.json`·`app.json`(expo-notifications 플러그인), `lib/platform/notify.ts`(새 — 네이티브 expo-notifications · 웹 빌드 Notification), `components/GoldenHourBadge.tsx`.
- 절차: `npx expo install expo-notifications` → EAS development 빌드(안드로이드) → Z Fold7 설치(EAS 무료 월 15회, 폰에는 EAS 빌드만). 로컬 예약만(`getExpoPushTokenAsync` 안 부름), 날짜 트리거(시작이 지났으면 `trigger:null`), 안드로이드 채널 먼저, hitSlop 12.
- 확인: 권한 요청 → '예약됨', 예약 시각에 알림, 웹 빌드 분기.

**F2 ✨ 경주 테마** — Opus, L(D12)
- ID: G2-14(R1 — 새 `DiscoveryPanel` 이 `getRecommendations({ discoveryTheme })`), G3-05(contextBadge 칩).
- 소유: `features/home/DiscoveryPanel.tsx`(새), `features/home/HomeScreen.tsx`, `features/recommendation-card/RecommendationCard.tsx`(배지만).
- 확인: G2 `05-webonly.mjs` 의 `discovery-open-web` 과 Expo 짝.

**F3 작은 후속 둘** — Sonnet, S
- G1-05 랜딩 축제 배너(`festivalTriggerVisible('banner', events)`): `features/onboarding/LandingHero.tsx`(D1·H2a 뒤). 확인 G1 `festival.mjs`.
- G4a-22 대안 혼잡 제보(R2 — `onReported` prop, `markReported` useCallback, `className="min-h-[44px]"`): `features/explore/{AlternativeCard,RecommendScreen}.tsx`·`useAlternatives.ts`(D3·H1 뒤).

**F4 정리** — 메인 + 문구 1, M
- 지울 문구 키(§5.5), 죽은 파일(NowChip·GoldenHourLabel 재수출, 마이 칩 `LanguageSwitcher`, `features/mypage/confirm.ts`, `sheetPeek`, `GroupSheet`, 쓰지 않는 `GuideSections`), `components/ui/index.ts` 정리, PORTING.md(바뀐 원본 + 의도된 차이: 음성·히트맵·알림 토글·AI 동의·위치 약관·사진 신고·게스트 삭제·온보딩 모달·직접 고른 곳 SPOT), 전체 재촬영 + Z Fold7 체크리스트, HANDOVER, `docs/README.md` 색인.

**W1 웹 수정** — Sonnet(웹), M, `apps/web` 만
- §7 에서 '웹 먼저'로 정한 것. 웹 게이트 + CI e2e(스텁도 함께 — §7 1번). 문구 키가 필요하면 A3·F4 에 넣는다. 웹 커밋 본문에 '앱: 반영 필요/불필요'(계획 §9.5). main 반영은 사용자 지시 때.

**L1 개인정보 문안** — 메인 + 문구 1, M(법무 검토 뒤)
- G5b-30: 웹 `/mypage/privacy` 와 앱 화면을 검토된 `MOBILE_PRIVACY_DRAFT.md` 와 하나의 시행일로. 문구는 4로케일 동시, 한 담당. 앱 '웹에서 전체 안내 보기' 버튼은 웹 갱신 뒤 다시 보인다.

### 5.5 문구(i18n) 계획

- **새 키(A3, 4로케일 동시)**: `app.auth.emailRequired`(G1-28) · `app.error.retryHint`(G1-32) · `app.support.required`(G5b-37) · `common.languageSelect`(G1-04·G2-10·G5b-07·32). 조건부: D9 ① 이면 `app.voice.micPermission`, D11 ③ 이면 `app.waiting.emptyBody`, G1-25 에서 이메일 형식 검사를 넣으면 `app.auth.emailInvalid`. 골든타임 알림은 웹 키(`golden.notify*`)를 그대로 쓴다 — 토글용 `app.alert.*`·`app.settings.alertDesc` 는 v1.1 때 만든다.
- **지울 키(F4 — 참조 0 을 `rg` 로 확인한 뒤 4 JSON 에서 함께)**: `app.cardSheet.handle`·`app.cardSheet.state.*`(G3-01) · `app.home.searchLocalTitle`(G2-19) · `app.course.slotLateNight`·`app.course.emptyBody`(D11 ①) · `app.intro.languageLabel`(R1) · `app.home.locationBanner.*`·`app.home.myLocation.*` 중 참조 0 인 것(D3 ① — 네이티브 위치 안내 화면이 쓰는 키는 남김) · 그 밖에 참조 0 이 된 `app.intro.*` 등. 죽은 키는 parity·키 검사가 못 잡는다.

### 5.6 에이전트 지시문 틀

```
너는 NextSpot apps/mobile 의 묶음 <묶음> 담당이다(이 worktree, yunseong 기준).
1. 읽기: AGENTS.md · apps/mobile/AGENTS.md · docs/MOBILE_WEB_PARITY.md §0·§4·§5(<묶음>) · docs/parity/review-<R?>.md 의 해당 정정 · docs/parity/findings-<그룹>.md 의 <ID 목록>.
   우선: 이 문서 > 검토 정정 > 발견.
2. 고칠 수 있는 파일은 §5.3·§5.4 의 '소유'뿐. tokens·i18n JSON·PORTING.md·components/ui/index.ts 는 고치지 않는다(필요하면 보고에 요청).
3. 값은 웹 실측값. 클래스는 덧붙이지 말고 바꿔 끼운다. 바닥 자리는 navMetrics(NAV_GAP·useNavInsets)만. 결정은 §3 답(<답 요약>). 문구는 있는 키만.
4. 게이트: npx tsc --noEmit · npm test · npm run check:shared · npx expo-doctor · npm run export:android · npx expo export --platform web.
5. 확인: 이 worktree 의 apps/mobile/dist 를 PARITY_EXPO_DIST 로 가리키고 <스크립트> 를 다시 찍는다(공용 expo-dist 를 덮지 않는다). 하네스 규칙(scratch/parity/README.md)을 지킨다.
6. 커밋만(푸시 금지). 'fix(mobile): …' + 본문에 왜·ID + Co-Authored-By.
7. 보고: 고친 ID · 다시 찍은 pair 경로 · 남은 차이 · 폰 확인 필요 · 요청(토큰·문구·PORTING).
```

## 6. 화면별 색인

| 화면(웹 ↔ Expo) | 발견·검토 ID |
|---|---|
| 앱 버그(전역) | G2-G07(모달 시트 7곳), G5b-03(Card) |
| 전역 — 하단 탭·하위 화면 탭 | G2-G01, G2-G02, G2-R02, G5b-01 |
| 전역 — 글꼴·줄 높이·줄바꿈·웹 빌드 | G2-G04, G2-G05, G2-G06, G2-G08, G2-R03, G5a-13 |
| 전역 — 유리·시트·토스트·확인 | G2-G03, G2-G09, G3-21, G3-33, G3-34, G4a-12, G5b-35 |
| 전역 — Button·Chip·접근성 상태 | G1-20, G5b-05, G4a-05, G4b-18, G5b-27, G1-34, G5b-06 |
| 전역 — 공지·점검 | G2-33, G2-34, G2-R01 |
| 첫 화면 `/` ↔ `/intro` | G1-01~07, G1-14(동의 단계), G1-15 |
| 서비스 소개 모달·`/guide` | G1-08~13, G2-G01('서비스 소개') |
| `/setup` | G1-15~20, G1-34 |
| `/login` | G1-04, G1-20~25, G1-34 |
| `/forgot-password` | G1-26~28 |
| `/auth/callback` | G1-29, G1-30 |
| 404·렌더 오류·PWA | G1-31, G1-32, G1-33 |
| 홈 `/main` ↔ `/` — 지도 | G2-01~09 |
| 홈 — 상단(언어·출처·시계·검색·날씨·축제·화장실·예측 띠·음성) | G2-10~24, G2-R01 |
| 홈 — 분류 칩·음식·필터·편의 | G2-25~30 |
| 홈 — 묶음 핀·위치 | G2-31, G2-32 |
| 홈 — 추천 카드 | G3-01~27, G3-35, G3-R01 |
| 홈 — 진행 중 여행·상황 변경·방문 확인 | G3-28~32 |
| `/saved` | G4a-01~14, G4a-R01, G4a-R02, G3-03, G3-12, G3-R02(상세) |
| `/explore/recommend` | G4a-15~30, G4a-R03~R05, G3-03, G2-G02 |
| `/explore/map` | G4a-31 |
| `/course` | G4b-01~29, G4b-R01~R05 |
| `/waiting` | G5a-01~25, G4a-03, G4a-09 |
| `/mypage` | G5b-07~19(+ 공통 G5b-01~06) |
| `/mypage/coupons` | G5b-20, G5b-21, G5b-22 |
| `/mypage/impact` | G5b-23, G5b-24 |
| `/mypage/inquiries` | G5b-22, G5b-25, G5b-26, G5b-R02 |
| `/mypage/lab` | G5b-21, G5b-27, G5b-28, G5b-29 |
| `/mypage/privacy` | G5b-30, G5b-31 |
| `/mypage/settings` | G5b-10, G5b-11, G5b-32~36, G5b-R01 |
| `/mypage/support` | G5b-32, G5b-37, G5b-38, G5b-R02 |

## 7. 웹 쪽 버그로 보이는 것

D1 ① 이면 아래 '권장'대로 W1 에서 고친다. 웹 수정은 웹 게이트 + CI e2e 를 통과해야 하고, main 반영은 사용자 지시 때다(웹만 바뀌면 API 의 'KST 밤' 제한은 없다).

| # | 웹 문제 | 근거 ID | 권장 | 앱 쪽 |
|---|---|---|---|---|
| 1 | `lib/navigation.ts` 의 `window.open(url,'_blank','noopener,noreferrer')` 가 늘 `null` 이라 앱 탭까지 카카오맵으로 이동, 수락 직후 진행 카드가 안 뜸. `/main`·`/explore/recommend`·`/course` 모두. e2e 스텁이 `window` 를 돌려줘 가렸다 | G3-23, G4b-25 | 웹 한 건으로: `const w = window.open(url,'_blank'); if (w) w.opener = null; else location.href = url;` + 진행 카드 즉시 표시 + e2e 스텁(`card-facts.spec.ts:195`, `journey-loop.spec.ts:89` 외) 수정. `noreferrer` 를 빼면 카카오가 Referer 를 받는다는 점 기록 | 지금 동작 유지 |
| 2 | 흰 글자 on 금 #c19a3e(2.64:1) 버튼·토글·칩 — 마이 모달 저장·쿠폰 사용·공유·실험실/문의 보내기·완료, 공용 `components/ErrorState.tsx:20`, 코스 토글, 재설정·콜백 | G1-20, G4a-28, G4b-10·21, G5b-05·27 | D2 (a)②: `bg-gold` → `bg-gold-deep`, `contrast.test.ts` 로 잠금 | 토큰 `button-gold` |
| 3 | 금→주칠 그라데이션 + 흰 글자가 검사 밖에 남음(404 CTA 등 — 웹 소스로 확인) | G1-31, G4a-10, G3-31 | D2 (b)②: `cta-primary` 로 | `cta` |
| 4 | sonner 토스트가 앱 글꼴이 아닌 시스템 글꼴 | G3-34 | `ThemeToaster` `toastOptions.className: 'font-sans'` | Freesentation |
| 5 | sonner 토스트가 하단 탭 막대를 덮음 | G3-34, G4a·G5b 넘김 | `mobileOffset` 을 막대 위로 | 막대 위(F9) |
| 6 | 언어 선택 화면 읽기 라벨 '언어 선택' 한국어 하드코딩(`LanguageSwitcher.tsx:16`) | G1-04, G2-10, G5b-07 | `common.languageSelect` 사용 | 같은 키 |
| 7 | 위치 거부·경주 밖에서 가짜 중심에 '내 위치' 점 | G2-04 | 안 그림(D3 d-③) | 지금처럼 안 그림 |
| 8 | 첫 추천 핀이 펼친 카드 높이로 잰 띠 때문에 칩 줄 바로 아래로 | G2-01 | `panToVisible` 띠를 미리보기 높이로 | 같은 규칙 |
| 9 | 심사 계정 안내·소개 '계획' 절·코스 데모 방문자 요청·랜딩 PWA 배너 | G1-12·22·33, G4b-28 | D8: 지움 | 만들지 않음 |
| 10 | `saved_facilities.data` 에 0~1 점수로 저장된 행이 웹 저장 상세에서 'SPOT 1점', 섞인 목록 정렬 깨짐 | G4a-R01 | `saved/page.tsx` 정렬·`spotScore` 입력에 같은 정규화 | A2 에서 정규화 |
| 11 | 쿠폰 날짜 ko-KR 고정·문의 날짜 브라우저 로케일 | G5b-22 | 앱 언어로 | 앱 언어 유지 |
| 12 | 임팩트 요약 카드 aria-label 이 지표를 덮음 · 고객지원 뒤로 라벨 없음 · 내 문의 뒤로 라벨이 '내 문의' | G5b-13, G5b-02 | 웹 접근성 수정 | 앱은 `settings.backAria`(R3) |
| 13 | 개인정보 웹 페이지(스토어 처리방침 URL)가 앱·초안보다 짧음, 실험실 '직접 설명하기' 외부 AI 고지 없음 | G5b-29·30 | L1 — 검토된 초안으로 | 문안 동결, 버튼 숨김 |
| 14 | 앱 전용 설정 줄(위치 동의·외부 AI·게스트 데이터 삭제)이 웹엔 없음 | G5b-33 | 법무 확인 뒤 웹 추가 검토 | 유지 |
| 15 | `/setup` 뒤로가 마이에서 와도 늘 랜딩, 게스트가 재방문자에게 설정을 다시 물음 | G1-15·25 | 선택(웹 개선 후보) | `canGoBack`·지금 목적지 |
| 17 | 위험 버튼(초기화·삭제·코스/대안 제외) 글자 terracotta on terracotta/10 이 3.7~4.0:1(<4.5) — 웹 `course/page.tsx:1749`·`explore/recommend/page.tsx:1533`·마이 설정 | 웨이브 B 접근성 검토 | 웹·앱 함께 더 진한 글자색(결정 필요, `DESIGN_PRINCIPLES` ⑥) | 웹과 같게 유지 — 바꾸면 `buttonSpec.ts` 색 한 줄 |
| 16 | 대기 '다시 시도' 때 자동 재시도 표식을 안 되돌림, 골든 배지가 없어도 빈 8px 줄, 코스 지도가 시트 윗부분을 가림, 저장 상세 베일이 밝음, `/saved` 들어올 때마다 스켈레톤 | G5a-18·23, G4b-01, G4a-11 | 그대로 둠(앱이 지금 웹 렌더를 따른다 — 재진입 스켈레톤만 안 따름) | 웹과 같게 |

## 8. 확인 방법

### 8.1 하네스로 다시 찍기

**촬영 중 EAS Hosting 무료 등급이 `nextspot.expo.app` 에 429 를 냈다. 그래서 하네스는 Expo origin 을 로컬 export(`scratch/parity/expo-dist`)에서 서빙한다 — 다시 찍기 전에 반드시 새로 export 한다.** 그렇지 않으면 옛 번들을 찍는다.

```powershell
# 0) 시작 전 한 번(메인): 기준 그림 보존 — 재촬영이 shots/<그룹> 을 덮어쓴다
Copy-Item -Recurse D:\NextSpot\scratch\parity\shots D:\NextSpot\scratch\parity\shots-1110-baseline
# 1) Expo 웹 빌드 다시 만들기(apps/mobile — .env.local 의 EXPO_PUBLIC_* 사용)
cd D:\NextSpot\apps\mobile
npx expo export --platform web                       # → apps/mobile/dist (git 제외)
robocopy dist ..\..\scratch\parity\expo-dist /MIR    # 종료 코드 0~7 = 성공(공용 dist 는 메인만)
#    병렬 에이전트는 복사 대신: $env:PARITY_EXPO_DIST = '<자기 worktree>\apps\mobile\dist'
# 2) 웹(기준)은 3000 그대로. 웹을 고친 묶음(W1·L1) 뒤에만 apps/web 을 다시 빌드·서빙(메인)
# 3) D:\NextSpot 에서
node scratch/parity/work/main/check-local-expo.mjs   # Expo 가 로컬 export 로 뜨는지(viaNetwork 0)
node scratch/parity/examples/tour.mjs                # 6화면 한 번에 → shots/_tour
node scratch/parity/overlays/R1/r1-checks.mjs        # 시트 열림·공지 vs 검색(A1·H3b)
```

- 하네스는 메인 체크아웃 `D:\NextSpot\scratch\parity` 에만 있다(git 제외). worktree 에서도 절대 경로로 실행한다.
- 판정: pair 그림 + 발견·검토에 적힌 측정값(예: 탭 막대 `0,743,390×101`, 미리보기 225px, 대기 카드 316px). 같은 상태는 한 번만 찍는다. API 429 면 하네스가 공용으로 쉬고, `waitReady` 가 '새 게스트'·'세션 갱신 실패'를 알리면 멈추고 메인에 보고한다.
- 구조가 바뀐 화면(소개 모달·추천 카드·탭 막대 등)은 스크립트의 Expo 쪽 조작을 각 발견·검토의 '확인 방법'대로 고친다.
- 스크립트: G1 `lnd.mjs`·`cns_set.mjs`·`auth.mjs`·`festival.mjs` · G2 `01-default`~`12-synthetic.mjs`·`diag-sheet3.mjs` · G3 `01-probe`~`14-pin-rank.mjs` · G4a `saved1`·`saved2`·`recommend1`·`recommend2`·`probe-back`·`exm.mjs` · G4b `build-overlays.mjs` 뒤 `cap-*.mjs` · G5a `01-baseline`~`04-retry.mjs` · G5b `01-main-guest`~`09-verify-local.mjs` · 검토 `overlays/R1/r1-checks.mjs`·`r1-locale-nav.mjs`·`work/R3/01-inquiries-scroll.mjs`.

### 8.2 Z Fold7 체크리스트(`네이티브 확인 필요` 34건 + 앱 버그)

준비: 폰의 development 빌드(`kr.nextspot.app`)에 `npx expo start --dev-client` 로 JS 를 싣는다(USB 면 `adb reverse tcp:8081 tcp:8081`, Metro 감시가 멈추면 `--clear`). 새 EAS development 빌드는 F1 뒤에만 필요하다. 접은 화면(폰 폭)이 기준, 펼친 화면은 지금의 560dp 열 규칙.

| 영역 | ID | 폰에서 볼 것 | 묶음 |
|---|---|---|---|
| **모달 시트(앱 버그)** | G2-G07, G3-21 | A1 전에 7곳이 정말 안 열리는지 한 번 보고, A1 뒤 필터·편의·날씨·축제·화장실·지금 한산·묶음 핀·혼잡 제보가 열고 닫고 다시 열리는지, 시트 안 문구 | A1·B3·H1 |
| 카드 색 | G5b-03 | 색 카드(R3: 네이티브도 같은 규칙 — 짧게 확인) | A1·D6 |
| 탭 글자 | G2-R02 | en 'My' 꼬리, ja·zh 탭 이름이 잘리지 않는지 | B6 |
| 글자 | G2-G05 | 1.5× 줄 높이가 글자 위로 쏠리지 않는지(includeFontPadding), 한 줄 칩 가운데 | B1 |
| 줄바꿈 | G2-G06, G5a-13, G4b-24 | 한국어가 낱말 단위로(U+2060) — '공유·됨' 같은 음절 끊김 없음 | B1·D4 |
| 입력 | G2-G08 | 포커스 테두리 없음(해당 없음 확인) | B1 |
| 유리 | G2-G03 | `BlurTargetView` 로 흐림이 걸리는지(구글 지도 SurfaceView), FPS·대비 — 안 되면 70%(D14) | B1·H3b |
| 카드 제스처 | G3-01 | 스크롤 영역 끌기 = 스크롤, 손잡이·미리보기·버튼 줄 끌기 = 한 칸, TalkBack '버튼, 펼쳐짐/접힘' | H1·H3a |
| 시계 | G2-10 | Hermes `Intl` `timeZone:'Asia/Seoul'`(홈이 이미 `kstParts` 사용 — 한 번 확인) | H2a |
| 미니맵 | G4a-25 | 기본 핀 크기·기준점 | B5·D3 |
| 코스 지도 | G4b-01 | 지도 끌기 = 지도만(react-native-maps 가 부모 가로채기를 막음), 구글 로고 보임 | D4 |
| 지도 실패 | G4b-05 | 키 없음 때 폴백 판·높이 | B5·D4 |
| 표지 | G4b-12 | `vectorEffect` 선 굵기(358×112·56px 에서 1.4) | B4a |
| 순위 배지 | G4a-18 | 배지 z 가 사진 위 | D3 |
| 접근성 | G1-34, G5b-06, G5a-25 | TalkBack 상태 읽기가 그대로인지, 점 줄 adjustable | B2·D5 |
| 캐러셀 | G5a-20 | `snapToInterval` 정상(웹 빌드만 고침) | D5 |
| 확인 토스트 | G4a-12 | 8초 안에 TalkBack 이 버튼에 닿는지, 뒤로 키 | B3·D2 |
| 모달 위 토스트 | G5b-17 | `profileEdit` 채널이 RN Modal 위에 보이는지 | D6 |
| 멀티라인 | G5b-28, G5b-38 | `maxHeight` 에서 멈추고 스크롤 | D6 |
| 긴 URL | G5b-26 | 문의 카드 줄바꿈 | D6 |
| 밑줄 | G1-18 | '건너뛰기' 밑줄 색 — 다르면 1px View | D1 |
| 소셜 | G1-23, G5b-09 | 구글 버튼 모양·복귀, 게스트 소셜 카드, 카카오 스위치 하나로 두 곳 | D1·D6 |
| 콜백 | G1-30 | `error_code` 딥링크로 '이미 연결된 계정' | (유지) |
| 저장 상세 | G4a-13 | 베일 z, BackHandler 로 닫힘 | H3a |
| 대안 뒤로 | G4a-15 | 하드웨어 뒤로 = 이전 화면(history) | B6·D3 |
| 알림 | G4a-06 | (F1) 안드로이드 13 권한·채널·예약 | F1 |
| 로딩 | G4b-20 | `LoadingReveal` 애니메이션·동작 줄이기 | B4b·D4 |

공통으로 더 본다: 글자 크기 1.0·1.3·1.6, 제스처 내비 inset, 동작 줄이기, 탭 막대 알약·햅틱·활성 탭 누름 무시, 홈 위치 실패 알약(D3).

## 9. 남은 질문·한계

1. **Expo 웹 빌드만 비교했다.** 네이티브는 §8.2 로 본다. 지도는 네이티브가 구글이라 카메라·핀 위치는 화면 px 로만 맞춘다.
2. **로그인 상태는 mock 이다**(`auth/v1/user` + `account/me`). 실제 로그인·OAuth·게스트 병합·로그아웃 뒤 이동은 못 찍었다.
3. **데이터 의존**: fixture 는 11-10(화) 13시대 하나. 코스는 실제 1곳 + 합성 3곳, by-type 5개 상한, 긴 이름 없음, 출처가 붙는 사진이 fixture 에 없어 출처 줄은 코드 대조. 늦은 밤·휴무·축제 기간 일부, LLM 이 필요한 상태(상황 변경 해석 성공·비교 질문·음성)는 못 봤다. G4a-R01 은 시드가 웹 모양이라 쌍이 없다.
4. **검토의 한계**: R2 는 브라우저를 열지 않고 기존 쌍·코드로 판정했다. R3 는 다른 묶음 지시를 digest·코드로만 대조했다. 원인이 '추정'인 것(G4b-R01 카메라 경합)과 미확인 값(G4a-25 카카오 핀 29×42)은 구현 때 잰다.
5. **촬영 못 한 상태**: 표시 15건(§2) + 각 문서 끝 절. 모달 시트 상태 다수는 A1 뒤 처음 찍힌다.
6. **움직임**: CSS 애니메이션을 끄고 찍었다. JS 애니메이션은 중간 프레임일 수 있다. 헤드리스 Windows 글꼴은 폰과 다르다.
7. **큰 화면은 범위 밖**: Z Fold7 펼친 화면에서 웹은 `md:` 데스크톱 배치, 앱은 560dp 열이다.
8. **결정·법무가 범위를 바꾼다**: 위치정보법(M20)·외부 AI 위탁·개인정보 검토가 D3·D4·D18 을, 카카오 비즈 전환이 D5 를 바꿀 수 있다.
9. **웹이 그 사이 바뀔 수 있다.** 발견·검토는 `c6374ab` 기준이다. 웹 관광객 화면 커밋은 '앱: 반영 필요/불필요'를 적고, 이식 원본은 [`PORTING.md`](../apps/mobile/PORTING.md) 의 기준 커밋과 `git log <기준>.. -- <웹 원본>` 으로 본다.
10. 디자이너용 웹 판(`nextspot.expo.app`) 갱신(`npx eas-cli deploy --prod`)은 사람 결정이다 — 무료 등급 429 를 다시 맞을 수 있다.
