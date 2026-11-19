# 모바일 앱 개인정보 처리방침 · 위치기반서비스 이용약관 — 초안 (법무 검토 전)

> **상태: 초안 · 법무 검토 전.** 2026-11-02 작성. 법률 의견이 아니다. 문장은 코드에서 확인한 사실(§1)만 적었고, 확인하지 못한 값은
> `[확정 필요: …]` 로 남겼다. 법무 검토(HANDOVER 10-31c ⑥ · 계획 M13·M20)를 거친 뒤 웹 `/mypage/privacy` 와 앱 화면 문구를 이 문서에 맞춘다.
> 계획·점검표는 [`MOBILE_APP_PLAN.md`](./MOBILE_APP_PLAN.md) §2 · §6.2 · §8.2 · §8.4.

앱 화면에는 이 초안을 줄인 문구가 들어간다(문구 키는 `apps/mobile/i18n-requests/fix-privacy.json` — 통합 때 4로케일 JSON 에 넣는다).

| 앱 화면 | 문구 키 | 이 문서 |
|---|---|---|
| 마이 → 개인정보 및 약관 | `app.privacy.*`(웹 `privacy.*` 중 앱에 맞는 절은 그대로) | §2 |
| 첫 실행 위치기반서비스 이용약관 동의 · 전문 보기 | `app.locationTerms.*` · `app.consent.*`(요약) | §3 |
| 외부 AI 허용 안내 · 설정 | `app.aiConsent.*` · `app.settings.aiConsent*` | §2 제7조 |

약관 문구를 바꾸면 `apps/mobile/features/auth/consentCore.ts` 의 `LOCATION_TERMS_VERSION` 을 올린다(이전 판 동의는 다시 묻는다).
외부 AI 받는 곳·목적이 바뀌면 `apps/mobile/features/aiConsent/aiConsentCore.ts` 의 `AI_CONSENT_VERSION` 을 올린다.

## 1. 사실 근거 — 코드 기준 (2026-11-02, `84a21a7`)

| 항목 | 지금 사실 | 근거 |
|---|---|---|
| 위치 읽기 | 위치 약관 동의 + OS 권한이 있을 때만, 홈·대안 추천·코스·화장실·주차장 화면을 열 때 한 번. 백그라운드 없음 | `apps/mobile/features/auth/consent.ts`, 계획 §6.2 |
| 위치가 남는 곳 ① | 화장실·주차장 조회는 좌표를 GET 쿼리로 보낸다. uvicorn 접속 로그가 켜져 있어 쿼리가 Render 로그에 남는다 | 계획 §2, `apps/api/Dockerfile` |
| 위치가 남는 곳 ② | `recommendations.recommendation_snapshot` 의 후보별 `distance_m` 를 사용자 id 와 함께 저장. 보관 기한 없음(계정 삭제 때 외래 키로 함께 삭제) | 계획 §2 |
| 검색어가 남는 곳 | `/search/places`·`/search/keyword` 는 검색어를 GET 쿼리로 받는다 → 접속 로그. 앱 로그 코드는 길이만 남긴다 | `apps/api/app/routers/search.py` |
| 외부 AI | Upstage Solar(`LLM_BASE_URL`=`https://api.upstage.ai/v1`, `LLM_MODEL`=`solar-pro3`). 전체 스위치 `LLM_ENABLED` 기본 꺼짐. 앱에서 닿는 길: 검색 0건 재작성(`/search/keyword`), `/travel-context/parse`, `/lab/{id}/reason/classify`. 원문은 서버 로그에 남기지 않는다. 실험실 분류는 고른 이유 코드와 요약(`reason_note`)을 저장할 수 있다 | `apps/api/app/core/config.py`, `services/llm_client.py`, `routers/lab.py` |
| 외부 AI 허락 | 앱은 허용 기록(`nextspot_ai_consent`)이 있을 때만 위 세 길을 부른다. API 에는 LLM 만 끄는 옵션이 없어, 허용하지 않으면 `/search/keyword`(관광공사 폴백 포함)를 부르지 않는다 | `apps/mobile/features/aiConsent/` |
| 이용 기록 | `usage_events` — 기기 익명 번호, 365일 뒤 pg_cron 삭제. 앱은 빌드 설정(`EXPO_PUBLIC_USAGE_EVENTS`)이 켜진 운영 빌드에서만 보낸다. 데이터 삭제 때 익명 번호를 새로 만든다 | `supabase/migrations/20261023090000_usage_events.sql`, `apps/mobile/lib/core/userData.ts` |
| 부정 이용 방지 | 게스트 혼잡 답에 네트워크 대역의 되돌릴 수 없는 값, 30일 | 웹 `privacy.abuseBody` |
| 계정 삭제 | 앱 설정 → `DELETE /api/v1/account/me`(게스트도). 관련 행은 외래 키로 함께 삭제 | 계획 §2 · §7.3 |
| 처리자 · 지역 | Supabase(싱가포르) · Render API(싱가포르, 2026-10-09 이전 — 오리건 서비스는 10-22 정지) · Vercel(웹) · Upstage · Expo(빌드). 앱에 `expo-updates`·푸시가 없어 실행 중 Expo 로 보내는 개인정보는 없다 | `docs/HANDOVER.md` 배포 상태, `apps/mobile/package.json` |
| 지도·외부 연결 | 지도 타일: 안드로이드 Google 지도, iOS Apple 지도(react-native-maps 기본). 길안내는 카카오맵 앱·웹을 목적지 좌표로 연다. 장소 검색은 서버가 카카오 로컬·TourAPI 에 질의 | `apps/mobile/features/map/NextSpotMap.tsx`, `services/kakao_place_search_service.py` |

## 2. 개인정보 처리방침 (앱) — 초안

**제1조 (처리 목적)** NextSpot(이하 '서비스')은 다음 목적으로 개인정보를 처리한다. ① 덜 붐비는 장소 추천과 코스 구성 ② 계정·게스트 세션 관리
③ 저장·방문 확인·제보·거절 이유를 반영한 추천 개선 ④ 고객 문의 응대 ⑤ 부정 이용 방지 ⑥ 서비스 이용 통계.

**제2조 (처리 항목)**
- 필수(게스트 포함): 이용자 번호(Supabase 사용자 id), 취향 설정, 저장한 장소, 추천·방문 기록, 혼잡 제보·방문 확인 답, 거절 이유.
- 가입 시: 이메일, 닉네임. 소셜 로그인 시 그 제공자가 넘겨주는 이메일·이름 `[확정 필요: iOS v1 은 이메일만 — 계획 M3]`.
- 위치정보(동의한 경우): 화면을 열 때 읽은 현재 좌표 → 제3조.
- 직접 입력한 문장(허용한 경우): 제7조.
- 자동 생성: 이용 기록용 기기 익명 번호, 서버 접속 기록(IP, 요청 주소 — 요청 주소에 좌표·검색어가 담길 수 있다).
- 문의: 문의 내용 `[확정 필요: 게스트 '답 받을 이메일(선택)' 칸을 넣으면 추가 — 계획 §2]`.

**제3조 (위치정보)** 위치기반서비스 이용약관(§3)에 동의하고 기기에서 위치 사용을 허용한 경우에만, 홈·대안 추천·코스·화장실·주차장 화면을 열 때
현재 위치를 한 번 읽어 서버로 보낸다. 근처 한산한 장소 추천, 도보 시간 계산, 경주 범위 확인에만 쓴다. 백그라운드에서 읽거나 이동 경로를 추적하지 않는다.
현재 남는 곳: ① 화장실·주차장 조회의 좌표가 서버 접속 기록에 — 호스팅 업체 로그 보관 기간 `[확정 필요: Render 로그 보관 기간(요금제별)]`
② 추천 기록에 후보 장소까지의 거리가 이용자 번호와 함께 — 계정·데이터 삭제 때까지. 이 둘은 계획 M22(좌표 POST 전환·소수 3자리·로그 쿼리 제외·거리 구간화·보관 기한)로 줄인다. 줄인 뒤 이 조를 고친다.

**제4조 (보유 기간과 파기)**
| 항목 | 보유 기간 | 파기 |
|---|---|---|
| 계정·취향·저장·추천·방문 기록 | 계정 삭제 또는 '내 데이터 삭제'까지 | 즉시(외래 키 연쇄 삭제) |
| 이용 기록(`usage_events`) | 1년 | pg_cron 매일 자동 삭제 |
| 게스트 답의 부정 이용 방지 값 | 30일 | 자동 삭제 |
| 서버 접속 기록(좌표·검색어 포함 가능) | `[확정 필요: Render 로그 보관 기간]` | 호스팅 업체가 삭제 |
| 이 기기의 개인 데이터·익명 번호 | 삭제·로그아웃·계정 전환까지 | 앱이 즉시 삭제 |
| 위치정보 이용·제공사실 확인자료 | `[미구현 — §4 체크리스트]` | — |

**제5조 (제3자 제공)** 개인정보를 판매하거나 광고 목적으로 제공하지 않는다. 길안내를 누르면 목적지를 담아 카카오맵이 열리고, 이후는 카카오 약관을 따른다.
장소 검색어는 서버가 카카오 로컬 검색과 한국관광공사 TourAPI 에 보낸다(검색어만, 이용자 식별 정보 없음).

**제6조 (처리 위탁과 국외 이전)**
| 받는 자 | 위탁 업무 | 이전 국가 · 리전 | 항목 | 시기·방법 | 보유 기간 |
|---|---|---|---|---|---|
| Supabase, Inc. | 데이터베이스 · 로그인 · 파일 저장 | 싱가포르 | 제2조 전부(위치 제외 — 거리 값은 포함) | 앱 이용 시 네트워크 전송 | 제4조 |
| Render Services, Inc. | API 서버 운영 | 싱가포르 | 요청 내용(좌표·검색어·입력 문장) · 접속 기록 | 앱 이용 시 네트워크 전송 | 처리 즉시 · 접속 기록은 로그 보관 기간 |
| Vercel Inc. | 웹 페이지·공개 안내 호스팅 | 미국 등 `[확정 필요: 리전]` | 웹을 열 때의 접속 정보 | 웹 이용 시 | `[확정 필요]` |
| Upstage | 입력 문장 해석(허용한 경우만) | `[확정 필요: 처리 국가·데이터 보관·학습 사용 여부(API 약관)]` | 입력 문장·검색어 | 입력 시 | `[확정 필요]` |
| 650 Industries, Inc.(Expo) | 앱 빌드·배포 | 미국 | 실행 중 개인정보 전송 없음(빌드 산출물만) | — | — |
| Google · Apple | 지도 표시(지도 SDK) | 각 사 | 지도 타일 요청(보이는 영역). `showsUserLocation=false` — 내 위치 점은 앱이 직접 그려 기기 위치를 지도 SDK 에 넘기지 않는다 `[법무 확인: 위탁·제3자 중 무엇으로 적을지]` | 지도 표시 시 | 각 사 정책 |

국외 이전을 원하지 않으면 계정·데이터 삭제로 처리를 멈출 수 있다(서비스 핵심 기능이 국외 처리에 의존해 이전 거부 시 이용이 어렵다) `[법무 확인: 개인정보보호법 제28조의8 고지 방식]`.

**제7조 (외부 AI 처리)** 이용자가 허용한 경우에만, 직접 입력한 문장(여행 중 상황 변경, 실험실 '직접 설명하기')과 결과가 없는 검색어를
뜻을 해석하기 위해 서버를 거쳐 Upstage 로 보낸다. 문장만 보내고 계정·위치는 함께 보내지 않는다. 서버 로그에는 원문을 남기지 않는다(길이만).
실험실에서는 AI 가 고른 이유 코드와 짧은 요약이 거절 기록에 저장될 수 있다. 처음 쓸 때 앱이 '허용 · 허용 안 함'으로 묻고, 마이 → 설정에서 언제든 철회한다.
허용하지 않으면 자유 입력 칸이 꺼지고 선택지와 기본 검색(카카오 장소 검색)만 쓴다.

**제8조 (이용 기록)** 연 화면, 추천 카드 버튼, 도착 확인, 혼잡 제보를 기기에서 만든 익명 번호로 기록한다. 이름·계정·위치·검색어를 담지 않고, 외부 분석 업체에 보내지 않으며, 1년 뒤 지운다.

**제9조 (정보주체의 권리)** 열람·정정·삭제·처리정지를 요구할 수 있다. 삭제는 앱 마이 → 설정의 '계정 삭제'(가입) · '내 데이터 삭제'(게스트)로 바로 할 수 있고,
나머지는 마이 → 고객지원으로 요청한다 `[확정 필요: 공개 연락 이메일 — 계획 M13]`.

**제10조 (만 14세 미만)** 만 14세 미만에게서는 위치정보 이용 동의를 받지 않는다. 법정대리인은 고객지원으로 열람·삭제를 요청할 수 있다
`[법무 확인: 가입 단계 연령 확인이 필요한지]`.

**제11조 (안전성 확보 조치)** 전송 구간 HTTPS, 데이터베이스 행 수준 보안(RLS), 역할 기반 서버 권한 확인, 비밀값 저장소 밖 보관 `[법무·보안 확인]`.

**제12조 (개인정보 보호책임자)** `[확정 필요: 성명 · 직책 · 연락처 — 계획 M13]`.

**제13조 (변경)** 내용이 바뀌면 앱 '개인정보 및 약관' 화면과 웹 `/mypage/privacy` 에 시행일과 함께 알린다.

## 3. 위치기반서비스 이용약관 — 초안

앱 첫 실행 화면은 아래 요약(이용 목적 · 이용 시점 · 기록과 보관 · 동의하지 않으면)과 '전문 보기'를 보여 주고, 약관 동의와 만 14세 이상 확인을 따로 받는다.

- **제1조 (목적)** 이 약관은 `[확정 필요: 사업자 상호]`(이하 '회사')가 제공하는 NextSpot 위치기반서비스의 이용 조건과 절차, 회사와 이용자의 권리·의무를 정한다.
- **제2조 (서비스 내용)** 현재 위치 근처 덜 붐비는 장소 추천, 도보 시간 계산, 경주 범위 확인, 가까운 화장실·주차장 찾기.
- **제3조 (수집 방법과 시점)** 약관 동의와 기기 위치 허용이 있을 때만, 앱 사용 중 해당 화면을 열 때 한 번씩 기기 위치를 읽는다. 백그라운드 수집·이동 경로 추적 없음.
- **제4조 (이용·보관)** 서버로 보내 추천 계산에만 쓴다. 현재 남는 기록은 개인정보 처리방침 제3조와 같다.
- **제5조 (제3자 제공)** 제공하지 않는다. 제공하게 되면 받는 자·목적을 알리고 따로 동의를 받는다. 길안내는 목적지를 담아 카카오맵을 연다.
- **제6조 (동의 철회)** 마이 → 설정에서 언제든 철회한다. 철회하면 위치를 더 읽지 않는다. `[미구현: 철회 시 서버에 남은 개인위치정보·확인자료 파기 — §4]`
- **제7조 (만 14세 미만)** 법정대리인 동의 절차가 없어 만 14세 미만에게서는 동의를 받지 않는다.
- **제8조 (이용자의 권리)** 위치정보 이용·제공사실 확인자료의 열람·고지, 오류 정정을 요구할 수 있다. `[미구현: 확인자료 자동 기록 — §4]`
- **제9조 (위치정보관리책임자)** `[확정 필요: 성명 · 연락처]`
- **제10조 (손해배상 · 면책)** 위치 오차가 있을 수 있고 추천·거리·시간은 참고용이다. `[법무 작성: 위치정보법상 손해배상 조항]`
- **제11조 (분쟁 조정)** `[법무 작성: 방송통신위원회·개인정보 분쟁조정위원회 안내]`
- **제12조 (사업자 정보)** `[확정 필요: 상호 · 대표자 · 주소 · 연락처 · 위치기반서비스사업 신고번호]`
- **부칙** 시행일 `[확정 필요]`. 앱 초안 판 `2026-11-draft2`.

앱 전문(`app.locationTerms.*`)에는 제9·10(손해배상)·11·12조가 아직 없다 — 위 확정값이 나오면 키를 더하고 판을 올린다.

## 4. 위치정보법 — 서버 쪽에 아직 없는 것 (체크리스트, 구현하지 않음)

조문 번호는 검토 에이전트가 확인한 것(계획 §8.2)과 법령 구조 기준이다 — 법무가 확정한다.

- [ ] **신고** — 개인위치정보를 다루는 위치기반서비스사업 신고(제9조①, 소상공인 등은 개시 1개월 안 — 제9조의2). 신고 주체를 스토어 판매자와 맞춘다. 미신고 영업은 처벌 조항(제40조).
- [ ] **동의·철회 기록 API** — 지금 동의는 기기에만 있다(`nextspot_location_consent`). 사용자 id · 약관 판 · 동의/철회 · 시각을 서버에 남기는 엔드포인트와 표(마이그레이션)가 필요하다.
- [ ] **이용·제공사실 확인자료 자동 기록·보존**(제16조②, 보존 기간 `[법무 확인: 시행령 6개월 이상]`) — 위치를 받은 요청마다 누가·언제·어떤 서비스로 썼는지.
- [ ] **철회 시 파기** — 철회하면 그 사용자의 개인위치정보와 확인자료를 지체 없이 파기(제24조 `[법무 확인]`). 지금은 철회해도 추천 기록의 `distance_m` 와 접속 로그가 남는다.
- [ ] **목적 달성 후 파기**(제23조 `[법무 확인]`) — 추천 기록 거리 값의 보관 기한(M22).
- [ ] **접속 로그의 좌표·검색어** — uvicorn 접속 로그에서 쿼리 빼기 또는 좌표 POST 전환(M22). Render 로그 보관 기간 확인.
- [ ] **14세 미만** — 서버에도 '14세 이상 확인' 값을 동의 기록과 함께 남긴다(제25조①).
- [ ] **위치정보관리책임자 지정**과 약관 게시.
- [ ] **외부 AI 서버 옵트아웃** — 앱 요청 표시 헤더(`X-NextSpot-Client`, 계획 §7.5) 또는 파라미터로 LLM 재작성만 끄면, 허용하지 않은 사용자도 관광공사 키워드 검색은 쓸 수 있다.
- [ ] **웹 문안 맞추기** — 웹 `/mypage/privacy`(스토어 개인정보 처리방침 URL)를 이 초안과 같은 사실로 고친다(웹 전용 문장 — 브라우저 저장소·Do Not Track·Turnstile — 은 웹에만).
- [ ] **App Store 개인정보 라벨 · Play 데이터 보안** — 계획 §8.4 표에 '사용자 콘텐츠(입력 문장) → 외부 AI(허용 시)'를 더한다.

## 5. App Review note (English) — Korean legal consent screen

> **About the first-launch "Location-Based Service Terms" screen.** Korea's Act on the Protection, Use, etc. of Location Information
> requires a location-based service provider to show its location terms and obtain the user's agreement to them before using personal
> location information (Article 19), and to accept that agreement only from users aged 14 or older unless a legal guardian consents
> (Article 25). The first-launch screen is this legal terms agreement, not a permission pre-prompt: it shows a summary and the full
> terms, has two checkboxes (agree to the terms; I am 14 or older), and offers "Agree and continue" or "Continue without agreeing".
> Either choice continues into the app; without agreement the app never requests location and recommends places around
> Hwangnidan-gil. The system location permission is requested later and separately, from a one-button explanation screen
> ("Continue") shown the first time the user reaches Home, and only if the user agreed to the terms. Users can withdraw agreement
> in My Page → Settings. Text typed into free-text fields is sent to an external AI service (Upstage) only after the user taps
> "Allow" in an in-app prompt that names the service; this can also be withdrawn in Settings.
