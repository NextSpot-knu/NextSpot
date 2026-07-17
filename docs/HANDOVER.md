# 세션 인계 문서 (2026-07-17 갱신)

## -13. 2026-07-17 오후 — 갤러리 부활(detailImage2 원인 확정) + Tier 1 소비 갭 5종

### 갤러리 전건 실패 원인 확정·수정 (`c95f312`) — §-12 의 미해결 1번 해소

실 API 프로브 3변형으로 원인 실측: **KorService2 는 구(KorService1) 파라미터 `subImageYN` 을 받으면
봉투(response.header) 없는 평면 에러 JSON**(`resultCode "10", INVALID_REQUEST_PARAMETER_ERROR(subImageYN)`)을
반환한다 — 그래서 'resultCode 없는 응답'으로 보였다. searchFestival2 의 areaCode 무시와 같은 함정 계열.
제거 후 재적재(폴백 upsert 67/67): **gallery_images 61/85 채워짐**(잔여 = 시드 16 + 목록 미반환 2 +
TourAPI 에 갤러리 없는 6). 회귀 방지 테스트 3건 추가. 활용신청 문제가 아니었다.

**§-12 의 42P10 진단 정정**: "원격 DB 에 contentid UNIQUE 인덱스가 없다"는 추정은 근거 부족.
로컬 스키마의 `uq_facilities_contentid` 는 **부분(partial) 인덱스**라 인덱스가 있어도 PostgREST
`on_conflict` 추론에 잡히지 않는다(§-1 에 이미 '정상 설계(폴백)'로 기록된 사항). 일 85행 배치엔
SELECT→INSERT/UPDATE 폴백으로 충분 — 마이그레이션 불요 판단(전면 인덱스 전환은 상용 단계 검토).

### Tier 1 소비 갭 5종 (`48432a9`) — 소비 경로 감사 결과 반영

Tier 1 데이터(5779d3a 적재 + 9bf1ca4 소비)가 /main 중심으로만 쓰이고 있었다:
① `/infrastructures` 에 gallery_images 필드 누락(→ /main 갤러리 불가) + 오염 행 방어 정제
② RecommendationCard 대표사진 → 갤러리 순차 폴백 ③ explore/recommend 오늘 휴무 배지+대표메뉴
④ waiting 대표 카드 대표메뉴 ⑤ 음성 후보 menu 동봉 + '메뉴 뭐 있어?' 가 실메뉴로 답하게
`_details_spoken` 확장(라우터의 과약속 주석도 정정). 추가: main 스와이프 다음 후보 오늘 휴무 제외 +
소진 원인이 '전부 오늘 휴무'면 빈 상태 문구 구분(`map.noRecClosedBody`, 545키×4로케일 패리티 유지).

Codex 교차 리뷰(읽기 전용) P0 0 · P1 2 · P2 2 — 전건 반영. 게이트 전부 통과(pytest 341 · ruff ·
lint 0 · tsc · 29/29 · build 32p · 파리티 2종).

**Tier 1-1(수용인원 accomcount) 보류 사유**: 원격 실측 `features.accom_count` 적재 **0건**
(TourAPI 가 경주 대상 시설에 값을 안 준다) — 데이터 근거 없이 혼잡 정규화 피처를 만들지 않는다(정직성).
TOURAPI_EXPANSION 의 "심사 전: Tier 0→1-2·1-3·1-4" 는 이로써 완료.

### 프로덕션 실측·주의

- **콜드 스타트 24.3초 실측**(유휴 후 `/api/v1/infrastructures`, 웜 0.34초) — 프런트 타임아웃 10초 초과.
  🟡 `BACKEND_HEALTH_URL` 변수 등록(아래 사람 작업)이 그만큼 시급하다.
- `/waiting`·`/explore` 갤러리는 추천 응답이 원본 dict 통과라 **재적재만으로 프로덕션 즉시 반영**.
  `/main` 갤러리 폴백은 이번 `infrastructures.py` 가 main 배포된 뒤 활성화.

### 사람 작업 (변동 없음 + 검증 항목 추가)

- 🟡 `BACKEND_HEALTH_URL` — GitHub repo → Settings → Secrets and variables → Actions →
  **Variables 탭**에 `https://nextspot-api.onrender.com/health` (콜드 스타트 24s 실측으로 시급 상향).
- 🟢 브라우저 실화면 검증에 추가: /waiting 카드 사진·대표메뉴 → /explore/recommend 휴무 배지·대표메뉴 →
  /main 카드 펼침 사진(갤러리 폴백) → 음성 "메뉴 뭐 있어?" 실메뉴 응답.

## -12. 2026-07-17 — Tier 0 상세 적재 완료 (심사 전 필수 운영 항목)

`ingest_tourapi.py --details` 실행(dry-run 선검증 후 실적재). **67/67 upsert**, showflag 동기화 정상(비표출 0).

| 필드 | 적재 전 | 적재 후 |
|---|---|---|
| overview(소개) | 0/85 | **67/85** |
| phone(전화) | 0/85 | **63/85** |
| homepage | 0/85 | 37/85 (홈페이지 없는 가게 다수 — 정상) |
| operating_hours | 0/85 | **83/85** |

프로덕션 API 서빙 확인(`/api/v1/infrastructures` 실측 67곳 overview). **데모 대본 '소개' 멘트 사용 가능.**
잔여 18곳 = 시드 16 + 이번 조회에 미반환 2(TourAPI 목록 변동).

**⚠️ 알려진 실패 2건(적재 결과에는 무해)**:
- `detailImage2`(갤러리) **전건 실패** — resultCode 없는 응답. images 는 여전히 0/85.
  waiting 카드의 galleryImages 폴백(7059e69)은 빈 배열로 무해 동작하나 갤러리 기능 자체가 죽어 있다.
  엔드포인트 파라미터/상품 포함 여부 확인 필요(활용신청과 별개일 수 있음).
- `on_conflict=contentid` upsert 가 42P10 으로 실패해 SELECT→INSERT/UPDATE 폴백으로 성공.
  원격 DB 에 contentid UNIQUE 인덱스가 없다 — 폴백이 있어 동작엔 문제없으나 배치 성능상
  마이그레이션 추가 검토(후속).

> 현재 상태 스냅샷 + 다음 단계. 브랜치 `feature/jinseok` (origin 동기화).
> 자율 개선 세션 로그·재개 규칙: [`AUTONOMOUS_SESSION.md`](./AUTONOMOUS_SESSION.md) · 전략: [`CONTEST_STRATEGY.md`](./CONTEST_STRATEGY.md)

---

## ✅ 해소 — 마이그레이션 2건 원격 적용 확인 (2026-07-17 실측)

위에 있던 "🔴 프로덕션 깨짐(마이그레이션 2건 미적용)"은 **해소됐다**. 2026-07-17 원격 PostgREST
읽기 전용 프로브로 `user_feedback.reason_status` ✅ / `user_feedback.learning_applied_at` ✅ /
`recommendations.source` ✅ 전부 HTTP 200 확인 — `20260716140000_rejection_lab.sql` ·
`20260716150000_recommendation_source.sql` 둘 다 적용됨(각 파일은 단일 실행이므로 컬럼 존재 =
파일 전체 실행). 쿠폰 발급·실험실 목록·👍/👎 의 스키마 원인은 제거됐다.

### 남은 사람 작업
- 🟡 `BACKEND_HEALTH_URL` 미설정 — **Secrets 가 아니라 Variables 탭**이다(워크플로가 `vars.` 로 읽음).
  현재 uptime 워크플로는 초록불이지만 실제로는 `⏭ Ping` 을 건너뛰고 `Skip(미설정)` 만 실행 중이다.
  없으면 Render 스핀다운 → 콜드 스타트 9.9초(프런트 타임아웃 10초와 아슬아슬).
  값: `https://nextspot-api.onrender.com/health`
- 🟢 브라우저 실화면 검증(마이그레이션 적용 후): 메인 연속 거절 → 즉시 다음 → 마이탭 카드 건수 →
  실험실 답변 → 목록 제거 / 사장님 콘솔 타임세일 발행 확인 → 만료 배지 → 방송 끄기

## -11. 2026-07-16 — 팀 브랜치 3종 통합 + 게스트 기록 승계

### 통합 결과 (`8b4b5c9` 병합, `ff4cc5a` 승계 수정)

`feature/jinseok` 이 `origin/main` 대비 **14 앞 / 0 뒤** — fast-forward 가능 상태.

- **윤성 `yunseong`**: 구글 OAuth(`5e1e655`) + 이메일/비밀번호 회원(`864139f`) → main 에 이미 머지됨(`1aefe37`).
- **승용 `feature/seungyong`(`69b620c`)**: **이미 main 조상**이다(2026-07-10 머지, 이후 121커밋).
  낡은 브랜치이므로 **병합 대상이 아니다** — 이후 이 브랜치를 다시 머지하려 하지 말 것.
- **진석(Claude)**: 나의 실험실 + 사장님 콘솔 + JWKS 503.

**충돌 5건 해결 방식(재발 시 참고)**:
- `i18n messages ko/en/ja/zh` — 같은 키를 양쪽이 바꾼 건 **0건**. 텍스트 충돌뿐이라 합집합 병합
  (공통 475 + 인증 39 + lab 26 = 540키). ⚠️ **원본이 한 줄 압축 JSON** 이다 — indent 를 넣어 재포맷하면
  전체가 diff 로 뜬다. 형식 유지 필수.
- `supabase/RESET_AND_SETUP.sql` — 생성물이다. **충돌 마커를 편집하지 말고 `node scripts/build_reset.mjs`
  재생성**으로 해결한다(마이그레이션 29개 타임스탬프 순 정렬됨).

**의미 충돌 검토(자동 병합된 파일 — 양쪽 로직 공존 확인)**: `saved/page.tsx`(notifyUnsaved + removeBookmark),
`mypage/page.tsx`(AccountSection + 실험실 카드), `main/page.tsx`(rejectRecommendation + lab.hint).
`SessionBootstrap` 은 익명 세션(signInAnonymously)을 유지 → 실험실 전제 보존.

### 게스트 기록 승계 `ff4cc5a` — 보안 설계 주의

문제: 기존 계정 로그인 시 UID 교체로 게스트 실험실 기록이 조회되지 않았다(DB 에는 남아 있음).
신규 가입·OAuth 연동은 UID 유지라 원래 문제없었고 **기존 계정 로그인만** 해당.

- **증명 = 로그인 직전 익명 access_token 소지.** 클라이언트가 보낸 uid 를 신뢰하면 **남의 게스트 기록을
  훔칠 수 있다** — body 의 uid 는 절대 쓰지 않는다.
- `POST /api/v1/account/merge-guest`: target=current_user(JWT), guest=검증된 guest_token 의 sub.
  **`is_anonymous is not True` → 403** 이 계정 탈취 차단선이다. 실코드 E2E 로 탈취 벡터 4종
  (false / 필드없음 / 문자열 "true" / 숫자 1) 전부 403 확인. 위조 401.
- `lib/userData.ts` 의 `reconcileUserData` 는 **버그가 아니라 프라이버시 기능**이다(기기 공유 시 다음
  사용자에게 로컬 데이터 누수 차단). **무력화하지 말 것.** 서버 데이터만 승계한다.
- `saved_facilities` 는 `(user_id, facility_id)` 복합 PK — 대상이 이미 가진 시설의 게스트 행을 먼저
  제거 후 나머지만 이동(대상 스냅샷 보존).
- 익명 `users` 행은 **삭제하지 않는다** — ON DELETE CASCADE 로 방금 옮긴 기록이 날아간다.

**남은 위험**: 병합은 로그인 시점 1회뿐이다. 익명 토큰 만료(약 1시간) 후 로그인하면 승계되지 않는다.
기기 B 의 게스트 데이터도 병합 대상이 아니다(팀원 설계 그대로).

## -10. 2026-07-16 야간 — Codex 교차 리뷰 P0 2건 수정 + 사장님 콘솔 운영 마감

### 실험실 P0 2건 (리뷰가 잡아낸 것 — 게이트로는 못 잡혔다)

1. **`29ca305` 실험실이 죽어 있었다.** 프런트 어디에도 `rejected` 를 서버로 보내는 경로가 없어
   pending 이 0건이었고 `/mypage/lab` 은 영원히 빈 화면이었다. 그런데 메인은 "이유는 나의 실험실에서
   알려줄 수 있어요" 힌트를 띄워 **기록 없이 거짓 약속**을 했다. **pytest 294 통과 상태에서 제품은 성립하지 않았다.**
   → **§-9 의 판단 1(by-type 서버 미저장)을 철회한다.** 그 결정이 실험실의 유일한 유입 경로를 없앴다.
   지표 코드를 실제로 읽어보니 우려는 부분적으로만 맞았다: `impact.py:69` 는 accepted=true 행만 세므로
   거절 행을 넣어도 **분산 성과 지표는 불변**이고, 수락률 '분모'를 세는 곳만 영향받는다.
   → 채택: `recommendations.source`('spot'|'browse') + `POST /recommendations/reject`(fire-and-forget) +
   분모 집계에서만 browse 제외(merchant '추천 제안', admin `/metrics`·`/metrics/trend`.
   `/impact` 는 accepted=true 만 세므로 필터 미적용).
2. **`b88cee1` 학습 '정확히 1회' 가 실제로는 깨져 있었다.** `learning_applied_at` 을 로컬 값으로 검사하고
   id 로만 UPDATE 해 동시 요청 둘이 모두 학습했다(계약 10 위반). → 조건부 원자적 UPDATE
   (`WHERE learning_applied_at IS NULL`) + 갱신 행이 있을 때만 학습. 경합 테스트 추가.

**남은 리뷰 지적(미해결)**:
- **P1 claim 후 장애 시 학습 유실** — claim 을 먼저 찍고 벡터 이동은 별도 호출이라, 그 사이 실패하면
  재시도가 '이미 학습됨'으로 판단한다. 현재는 at-most-once 이지 '정확히 1회'가 아니다.
  제대로 하려면 `claimed_at`/`applied_at` 분리 + 오래된 claim 재처리 또는 outbox 가 필요하다(후속 과제).
- **P1 수락 CTA 연타 가드 부재**(explore/recommend:623, :1295) — 결정 행·벡터는 멱등이나 쿠폰 발급
  경로가 반복 호출된다(쿠폰 서비스 자체 멱등성에 의존).
- **P2 마이그레이션의 dedupe DELETE** — 분석 이력이라면 삭제보다 사전 검증 실패/archive 가 안전하다는 지적.
  현재 중복 0건이라 실질 영향 없음.
- **계약 9 부분**: `already_visited` → 재추천 억제의 **실제 억제 로직은 아직 없다**(매핑만 존재).

### 사장님 콘솔 `92d43de`

Codex 감사(읽기 전용) P0/P1 반영. 기능은 이미 실동작했고 '운영 마감'이 admin 수준에 못 미쳤다.
- 정직성: '예측 유입'→'예상 혼잡'(우리가 가진 건 혼잡도 예측이지 유입/매출이 아니다),
  '추천 노출'→'추천 제안'(레코드 수이지 화면 노출 보장이 아님)
- 좌석 상태: 추천은 30분 이내만 반영하는데 콘솔은 만료값을 '현재 상태'로 계속 보여줬다 →
  적용 중/만료됨 배지 + 남은 시간 + '방송 끄기'(백엔드 level=null 해제)
- 실수 방지: 타임세일 발행/취소 인라인 확인, 저장류 전부 성공·실패 토스트
- P1: 성적표 0건 설명, 분모 명시(사용 3/발급 12), 가게 검색 + 음식점·카페 기본 필터, a11y, 12px 이상
- 문서-코드 불일치 정정: `merchant.py` 주석·`COMMERCIAL_PRODUCT_IDEAS.md:43` 의 '추천 랭킹 미연동'
  서술이 코드 실제(merchant_boost → recommendations 반영)와 어긋났다 — 심사 질의 신뢰 직결

**알려진 위험**: 프런트 `SEAT_FRESH_MINUTES=30` 은 백엔드 `merchant_boost.SEAT_STATUS_FRESH_MINUTES`
하드코딩 미러다(서버가 값을 안 내려줌). 한쪽만 바꾸면 표시가 어긋난다.

### 사람 작업 (추가)

- **[필수·선행]** 원격 Supabase SQL Editor 에 마이그레이션 **2개**를 순서대로 실행:
  `20260716140000_rejection_lab.sql` → `20260716150000_recommendation_source.sql`.
  둘 다 멱등·기존 행 무손실. **백엔드 배포보다 먼저** (action VARCHAR(20)→TEXT 가 선행 전제).
- 브라우저 실화면 검증 미실시: 메인 연속 거절 → 즉시 다음 → 마이탭 카드 건수 → 실험실 답변 → 목록 제거,
  그리고 사장님 콘솔 타임세일 발행 확인 → 만료 배지 → 방송 끄기.

## -9. 2026-07-16 — `나의 실험실` MVP 구현 완료 (Claude, 6커밋 · Codex 교차 리뷰 대기)

감사([`REJECTION_LAB_AUDIT.md`](./REJECTION_LAB_AUDIT.md))의 구현 계약 12개를 기준으로 구현.
착수 전 감사 주장을 file:line 으로 전수 재확인 — **전부 현행 코드와 일치**했다(멱등성 부재,
accepted 외 -5% 오학습, main 서버 미저장, UNIQUE 부재).

**커밋**: `9a4a394` DB → `aba9bd8` 서비스 → `c58a3b7` API → `9ee5d10` 클라이언트/i18n →
`2f2e1df` 실험실 UI → `dd4e410` 기존 화면 행동 타입 분리.

**게이트**: ruff clean · pytest **294 passed**(227→+67) · web lint 0 errors(신규 any 없음) ·
typecheck · 29/29 · 스키마 파리티(재생성 동일) · i18n lab 26키 × ko/en/ja/zh 패리티 0 missing.

### ⚠️ 구현 판단과 타협 (Codex 리뷰 시 이 항목들을 우선 검토할 것)

1. **main 지도 `관심 없음`은 서버 저장하지 않기로 했다** — 감사 P0-2 의 미해결 잔여.
   by-type 은 `bytype-{facilityId}` 합성 ID 라 DB 행이 없어 `/feedback` 은 404 다. 서버 저장하려면
   `recommendations` 행을 만들어야 하는데 **그 테이블이 B2G 수락률·분산 성과 지표의 소스**라
   브라우즈 임프레션을 섞으면 심사에서 제시할 지표가 오염된다. 감사도 이 건은 "별도 해결 필요"로
   유보했다. 기존 로컬 세션 제외 유지 = 감사 계약 3("이유 미입력 거절은 세션 후보 제외에만 사용")과 정합.
   **결과: 실험실 목록은 `/recommendations`(추천 상세) 경로의 거절만 담는다.** 가장 흔한 거절 경로가
   빠지므로 목록이 얇을 수 있다 — 대안 설계는 후속 과제.
2. **`action VARCHAR(20)` → `TEXT` 확장이 필수 전제.** `accepted_visit_intent` 가 21자다.
   **마이그레이션이 백엔드 배포보다 먼저 원격 DB 에 적용되어야 한다** — 순서가 뒤바뀌면 INSERT 가
   `value too long for type character varying(20)` 로 500 이 난다.
3. **벡터 학습 위치 분리**: '정확히 1회' 보장은 서비스가 `learning_applied_at` 선점(claim)으로 담당하고,
   실제 벡터 이동은 라우터가 수행한다(CATEGORY_VECTORS 가 라우터 쪽이라 facility 조회 결합을 피함).
   서비스가 claim 후 라우터가 죽으면 **학습이 유실될 수 있다**(중복보다 유실을 택한 설계).
4. **부분 UNIQUE 인덱스를 `(recommendation_id)` 단독**으로 걸었다(user_id 미포함). 한 추천은 한 사용자
   소유라 논리적으로 안전하나, 추천 공유 설계가 생기면 과도한 제약이 된다.
5. **RLS 는 백엔드를 막아주지 않는다** — `/lab/*` 은 service_role 로 접근하므로 소유권 검사는
   라우터의 `current_user['id']` 대조가 유일한 방어선이다.
6. **legacy `accepted`/`ignored` 를 결정 액션 UNIQUE 목록에 포함**했다. 과거에 같은 추천에 여러 결정을
   의도적으로 쌓은 이력이 있었다면 dedupe 로 하나만 남는다(현재 1행뿐이라 실질 영향 없음).

### 사람 작업

- **[필수·선행]** 원격 Supabase SQL Editor 에 `supabase/migrations/20260716140000_rejection_lab.sql`
  을 붙여넣어 실행(멱등, 기존 행 보존). **백엔드 배포보다 먼저.** RESET_AND_SETUP.sql 은 전체 리셋이라
  프로덕션에 쓰면 안 된다.
- 적용 전 안전 확인(선택): `SELECT recommendation_id, count(*) FROM user_feedback GROUP BY 1 HAVING count(*)>1;`
  → 0행이어야 dedupe DELETE 가 아무것도 지우지 않는다(2026-07-16 기준 user_feedback 1행, 중복 0).
- 브라우저 검증 미실시(감사 권장 분할 5): 연속 거절 → 즉시 다음 → 실험실 답변 → 목록 제거 흐름을
  실제로 클릭해 확인 필요. 게이트는 전부 통과했으나 실화면 확인은 안 했다.

## -8. 2026-07-16 — `나의 실험실` 구현 전 Codex 감사

- 구현 전 거절 UI→API→DB→선호 벡터→RLS 경로를 읽기 전용 감사하고 결과를
  [`REJECTION_LAB_AUDIT.md`](./REJECTION_LAB_AUDIT.md)에 기록했다.
- **P0**: `/feedback`은 recommendation 기준 멱등성이 없어 재호출마다 `user_feedback` INSERT와
  선호 벡터 -5%가 반복된다. 메인 지도의 `관심 없음`은 sessionStorage만 갱신해 서버 실험실 목록에
  나타나지 않는다.
- **P1**: 만족도 👎, 일괄 새로고침, 음성 다음, 북마크 제거가 서로 다른 의미인데 거절/ignored로
  혼용된다. 👍 accepted도 실제 방문 수락·쿠폰 발급과 섞여 지표가 오염될 수 있다.
- 구현 계약: 거절 순간에는 pending만 저장, 상세 이유 확정 후 의미에 맞는 장기 학습을 정확히 한 번
  적용한다. skip/batch/unsave/helpfulness/visit intent를 분리하고 최근 10건·30일 만료를 적용한다.
- 다음 구현 주체(권장 Claude)는 `COMMERCIAL_PRODUCT_IDEAS.md` §2와 위 감사 문서를 모두 읽고,
  DB/서비스 → API → 기존 행동 정리 → UI/i18n 순으로 작은 커밋을 만든다.

## -7. 2026-07-16 — TourAPI 4차 상용화 기획

- 기존 1~3차 확장안과 코드 현황을 대조한 뒤, 고객 행동 폐루프 중심의 4차 기획을
  [`TOURAPI_EXPANSION.md` §4차 기획](./TOURAPI_EXPANSION.md)에 추가했다.
- 우선순위는 ① 여행 날짜 기반 30일 혼잡 회피 플래너 ② 연관/중심 관광지 기반 분산 그래프
  ③ 공식 다국어 장소 카드 ④ 포토코리아+Odii 이야기형 대안 추천 ⑤ 조건 충족형 안심 코스
  ⑥ B2G 관광 다양성 KPI 순이다.
- `나의 실험실`의 영업 오류·부정확 추천 피드백을 TourAPI 최신값 재조회와 운영 검증 큐로 연결하는
  데이터 품질 폐루프도 기획에 포함했다.
- 공식 공공데이터포털을 2026-07-16 기준 재확인했으며, 상품별 활용신청·경주 커버리지 실측·기능
  플래그를 선행 조건으로 명시했다. **아직 구현 승인이 아닌 제품 제안 상태다.**

## -6. 2026-07-16 — 상용화 제품 논의 및 `나의 실험실` 방향

- PM과 논의한 고객/상인/B2G 상용화 기능 및 우선순위를
  [`COMMERCIAL_PRODUCT_IDEAS.md`](./COMMERCIAL_PRODUCT_IDEAS.md)에 정리했다.
- **제품 방향 확정**: 추천 거절 시마다 이유를 묻지 않는다. 거절은 즉시 처리하고, 마이탭
  `나의 실험실`에서 최근 거절 목록의 이유를 사용자가 선택적으로 나중에 입력한다.
- 모든 거절을 같은 취향 감점으로 해석하지 않는다. 거리·혼잡·가격은 해당 선호를 조정하고,
  휴업은 데이터 오류로, 이미 방문은 재추천 억제로, 상황 불일치는 세션 신호로 분리한다.
- 미응답은 최근 5~10건/30일 만료로 제한하고, 건너뛰기와 제거를 제공해 숙제처럼 쌓이지 않게 한다.
- 후속 구현 전 기존 feedback/recommendations 스키마·RLS, 현재 거절 `-5%` 학습과의 중복 반영을
  먼저 감사해야 한다. **이 기록은 제품 기획 정본이며 아직 구현 지시는 아니다.**

## -5. 2026-07-15 오전 — 상용화 신규 서비스 5종 (PM 지시로 freeze 해제, 6커밋)

- **PM(진석) 지시로 feature 브랜치 freeze 해제** — 상용화 아이디에이션(4페르소나 발산 24건 →
  투자심사 킬테스트) 후 선정 5종을 병렬 구현(파일 소유권 분할, 에이전트 5 + 통합).
- **C(관광객)**: `226df81` 골든타임 알리미(GET /predict/golden-hour, 카드 배지+알림 예약) +
  /waiting 대기 보드('지금 출발하면?' 도착시점 대기 순 리스트) · `46da84b` /mypage/impact
  여행 임팩트 카드(score_breakdown 실저장값 기반 — visit 지표는 서버 근거 없어 정직 제외).
- **B(소상공인)**: `44035df` /merchant 콘솔(데모 게이트) — 예측 유입 곡선·7일 성적표·셀프
  타임세일(신규 merchant_timesales 테이블)·좌석 상태 방송(features.seat_status).
  ⚠️ **랭킹 연동(타임세일→인센티브항, 좌석→혼잡 보정)은 미구현 2단계** — score.py 무변경.
- **B2G**: `05f707b` /admin/safety 인파 안전 경보(임계값 0.85/0.7, 150m 격자 존 롤업, +1h 예측) ·
  `6b659d9` /admin/report 성과 리포트 원클릭(A4 인쇄, 데모 폴백 없는 제출용 정직 표기).
- **통합**: `94f77f4` 라우터 3종 배선·i18n 461키×4로케일(패리티 0 missing)·관제 메뉴·RESET 재생성.
- **검증**: pytest 152(신규 34) · ruff · tsc · next build(신규 정적 라우트 6종) · voiceIntent 29/29 ·
  실서버 E2E 5기능 스크린샷(골든 배지 12~13시 실발동, 대기 보드 실데이터, 안전 경보 14존).
  익명 세션 부트스트랩 레이스(직행 401)는 waiting/impact 에 2.5초 유예 1회 재시도로 보강.
- **사람 작업(신규)**: ① 원격 Supabase SQL Editor 에서
  [`supabase/migrations/20260715100000_merchant_timesales.sql`](../supabase/migrations/20260715100000_merchant_timesales.sql)
  1회 실행(미적용 시 머천트 타임세일 섹션만 '조회 실패' 폴백) ② Render/배포 env 에
  `MERCHANT_API_TOKEN`(기본 nextspot-merchant-local — 운영 시 반드시 교체) 추가.
- 같은 날 오전 사용자 신고 버그 수정: `2aa416b` 세부 음식 칩 오분류(상호명 구체성·임계값 0.8)
  + 카드 컨테이너 pointer-events 칩 탭 가로채기 해소. 코스 핀 1·2·3 = 실좌표·실순서 3단계 검증.

## -4. 2026-07-15 새벽 — 야간 CX 감사 사이클 (freeze 내 버그픽스 5커밋)

- **감사 방법**: 고객 관점 8차원 멀티에이전트 감사(37건) → 적대 재검증 → 2·3차 표적 감사(로케일
  실화면·관리자 실백엔드·데모 대본 실기기 대조·공유 딥링크 왕복). **주의: 초기 감사의 상위 3건
  ('하이드레이션 정지'·'전 페이지 무한로딩')은 재검증에서 반증** — 에이전트가 127.0.0.1 로 접속해
  로컬 CORS(localhost 만 허용)에 막힌 환경 아티팩트였음(apps/api/.env 에 127.0.0.1 오리진 추가로 해소).
- **freeze 내 수정 5커밋(전부 feature/jinseok 푸시, main 미반영)**:
  `bc9b6f0` 코스 순서 피커 중복 칩 구분선+라벨 · `f331124` mypage 가짜 '이상 혼잡 알림' 스위치 →
  실제 CongestionAlertToggle · `62420f6` STT 에러 토스트(권한/실패 구분)+메인 지도 8초 타임아웃 폴백
  (CourseMap 패턴 미러)+/explore/recommend 무파라미터 가드(공유 전용 경로라 가드가 유일한 탈출구)
  +i18n 5키 4로케일 · `797edc2` 음성 오브 하드코딩 한국어 8곳 → 기존 recommend 키 배선(신설 0)
  +en 'Wait n min' 배지 nowrap+관제 대시보드 콜드 500 재시도 1회 · `5eddd79` DEMO_SCENARIO 교정.
- **정적 export 실검증**: out/ 서빙(3005)에서 지도 폴백·recommend 가드·순서 피커·공유 딥링크
  왕복(5항목 PASS) 확인. 특히 **카카오 도메인 미등록 상황을 실제로 재현** — 예전엔 검은 화면
  무한 대기였을 것이 폴백 칩+추천 카드 정상 동작으로 강등됨(프로덕션 리스크 완화 실증).
- **미재현/반려 기록**: 쿠폰 정책 정렬 버그(REST·DOM 이중 검증 미재현) · 'SPOT 점수' 용어 교체
  (데모 대본이 SPOT 을 정의·설명 — 발표와 충돌) · Kakao SDK beforeInteractive→afterInteractive
  (재현 안 됨 + 회귀면 넓음 → freeze 후 검토).
- **freeze 후 백로그(코드)**: Kakao SDK 페이지별 로드 · 음성(STT/TTS) 언어 로케일 연동(현재 ko-KR
  고정) · 축제명 비-ko 로케일 원문 삽입 · admin infrastructure/reports 모바일 오버플로(관제 데모는
  데스크톱이라 비긴급) · SessionBootstrap 이 /admin 경로에서도 익명가입 POST · 추천 API 실패 vs
  0건 빈 상태 구분(explore/recommend) · /mypage/support i18n 미적용 · freshness 배지 2종 산정 불일치.
- **데이터/운영 관찰(사람 판단 필요)**: facilities.overview 전 시설 미적재(0건) — 대본 '소개' 멘트
  성립 불가, ingest 1회 실행으로 채워질지 확인 필요(TourAPI 쿼터 소모 주의) · 실측 congestion_logs
  표본이 07-06~09 나흘뿐, 추천 표본 11건이 07-14 하루 집중(리포트 '수락 트렌드' 패널 빈 상태 유발) ·
  백엔드 유휴 후 첫 요청 간헐 500(supabase 싱글턴 stale 커넥션 추정 — Render 배포판에서 재발 시
  근본 수정 필요, 프런트 재시도 1회는 적용됨).
- **검증 스냅샷(03:40)**: pytest 118 · ruff clean · tsc · next build(정적 23페이지) · i18n 패리티
  420키×4로케일 0 missing · voiceIntent 29/29.
- **프로덕션 상태(03:40 기준)**: main 프로덕션 배포 READY이나 **Deployment Protection SSO 302 지속
  (외부 접근 불가) — 사람 작업 미완**. main 은 feature/jinseok 대비 5커밋 뒤(위 5커밋 반영 대기).

## -3. 2026-07-15 — main 의미 병합 + Vercel 프로덕션 개통

- **델타 SQL 적용 완료(사람)** — supabase/APPLY_DELTA_20260714.sql 실행됨. E2 백업 영상은 pass 결정.
- **main 병합** (`b6598a0`) — 승용님 리팩터(69b620c, 죽은 코드·타이핑·헬퍼 통합)를 feature/jinseok 에
  의미 병합(충돌 20파일: 기능=ours, 리팩터 의도 중 유효분만 재적용). main 은 fast-forward 로 동기화
  (`git push origin feature/jinseok:main`) — **이후 main 이 프로덕션 정본, D1 cron 발화 조건 충족**.
- **Vercel 배포 원인 2건 해소**: ① 프로덕션 브랜치(main)가 70+커밋 뒤라 프로덕션 배포 0건 → main 동기화로 해소.
  ② env 부재 → `NEXT_PUBLIC_SUPABASE_URL`·`SUPABASE_ANON_KEY`·`KAKAO_MAPS_APP_KEY` 3종을 production+preview 에 등록(CLI).
  `NEXT_PUBLIC_FASTAPI_URL` 은 Render 미배포로 보류 — Render Blueprint 적용(§6-1) 후 추가할 것.
- **남은 사람 작업**: Kakao 개발자콘솔 Web 도메인에 Vercel 프로덕션 도메인 등록(미등록 시 지도 미렌더),
  Render Blueprint + FASTAPI_URL env, GitHub Actions Secrets(D1 cron 용).

## -2. 2026-07-14 사이클 — A2·D1·D5·A4 + 발표 산출물

- **A2 상세카드 확장** (`5d0e51f`) — detailCommon 상세 필드(개요·홈페이지·주소·전화) 마이그레이션
  (`20260713090000_add_detail_common_fields.sql`, **Supabase 미적용 — 사람 작업**) + 추천 카드 상세 표시 + i18n.
- **D1 TourAPI 일배치 인제스트** (`5d0e51f`) — `.github/workflows/ingest.yml`, 매일 KST 04:00 upsert.
  ⚠️ schedule 은 main 브랜치에서만 발화 — 머지 전엔 workflow_dispatch 수동 실행.
  **사람 작업**: GitHub Actions Secrets 4종(TOURAPI_KEY·SUPABASE_URL·SUPABASE_ANON_KEY·SERVICE_ROLE_KEY) 등록.
- **D5 데이터 신선도** (`5d0e51f`) — `GET /api/v1/freshness`(app_events `tourapi_sync` 마커 정본 →
  updated_at 추정 폴백) + 관리자 DataFreshnessBadge.
- **A4 행사 혼잡 보정** (`06fd55a`) — `services/event_boost.py`: 당일 진행 축제 거리감쇠 가중
  (MAX_BOOST 0.15 × (1−거리/1.5km), 성공 1h·실패 10분 캐시). score.py 도착시점 예측 + `/predict/batch`
  양쪽 반영, breakdown `event_boost`/`event_title`, 추천 카드 🎪 배지(4로케일).
  테스트 격리: tests/conftest.py autouse 픽스처가 TourAPI 조회 차단(로컬 실키 오염 방지).
- **발표 산출물** (`cb9cf07`) — [`DEMO_SCENARIO.md`](./DEMO_SCENARIO.md)(E1, 관광객/관리자 각 3분 대본+체크리스트+폴백),
  [`JUDGE_QA.md`](./JUDGE_QA.md)(E4, 예상 질문 10문+답변), [`TIMELINESS.md`](./TIMELINESS.md)(C2, 검증 보도 8건).
- **E3 지표 리얼리티** — 대시보드 '③ 분산 효과' 30일 차트를 실측 전환: 신규 `GET /api/v1/admin/metrics/trend`
  (congestion_logs 일평균 혼잡도 + recommendations 일별 수락률, KST 일 단위·결측일 null 센티넬·20k 캡 truncated 플래그).
  프런트는 혼잡 표본일 ≥3이면 '실측 집계(30일)' 모드(반사실 '도입 전' 계열 제거), 미만이면 기존 데모 폴백
  — 어느 쪽인지 차트 라벨로 구분(정직성 원칙). 로컬 실데이터 기준 표본 4일 → 실측 모드 동작 확인.
- **E1/E4 기술 리허설 반영** — 로컬 실서버·실DB로 데모 대본 전 구간 자동 검증(DEMO_SCENARIO §4 로그).
  ✅ 페이지 8종·익명 인증 ON·추천 5건·A4 축제 배지 실발동(진행 중 실축제, ~08-17)·모델 재학습
  (MAE 0.0802 vs 기준선 0.2159, R²=0.73 — model-info 배지 라이브)·분산 추이 실측 모드.
  ❌ **데모 블로커 2건 실증**: simulate-peak 500 + 쿠폰 무음 미발급 — 원인은 미적용 마이그레이션 5종.
  **사람 작업(최우선·1회 붙여넣기)**: [`supabase/APPLY_DELTA_20260714.sql`](../supabase/APPLY_DELTA_20260714.sql)
  을 SQL Editor에서 Run → simulate-peak·쿠폰 발급 재검증. JUDGE_QA Q2(실측 MAE)·Q9(E3 완료) 갱신됨.
- **freeze 전 최종 버그 스윕(2026-07-14 오후)** — 6차원 병렬 감사(백엔드/프런트 최근 커밋·에러 상태 B8·데모 대본 추적·PWA sw 스테일·관리자 전수) + 발견별 회의적 검증. 5차원 발견 0건, **확정 demo-blocker 1건 수정**(`42e47e0`): 축제 🎪 배지가 explore/recommend 에만 렌더되고 관광객 데모 화면(/main RecommendationCard)엔 부재 → recToSpot 이 breakdown.eventBoost/eventTitle 보존, 카드에 동일 배지 블록(기존 4로케일 키 재사용). i18n 패리티 스크립트 점검 4로케일 414키 일치. 랜딩 능선 실루엣 SVG 커밋(`747fdcd`).
- **검증 스냅샷**: pytest 118 passed · ruff clean · tsc/next build(정적 export) · RESET 패리티 일치 (스윕 후 재확인).
- **다음 큐**: **코드 freeze 발효(버그픽스만)**. 잔여는 전부 사람 작업 — ① supabase/APPLY_DELTA_20260714.sql 적용 후 블로커 2건(simulate-peak·쿠폰) 재검증 ② E2 백업 영상 녹화.

## -1. TourAPI 실연동 (2026-07-10 · 키 검증 완료)
- **TOURAPI_KEY 발급·검증 완료** — `apps/api/.env`(gitignore)에 Decoding 키 저장. dry-run(목록+`--details` 상세)으로
  실 경주 POI·영업시간·배리어프리 수신 확인. ⚠️ 백엔드 스크립트는 반드시 `py -3.11`(시스템 Python 3.14의
  `websockets` 12.0에는 realtime 2.31.0이 요구하는 `websockets.asyncio`가 없어 앱 import 실패).
- **축제 기능 신설** — `GET /api/v1/events`(routers/events.py) + 메인 지도 축제 칩·바텀시트(components/FestivalBanner.tsx).
  키 미설정/장애 시 `source="unavailable"` 빈 목록 → 프런트 칩 자동 숨김(무해 폴백). 실데이터: 신라문화제 등 2건 확인.
- **⚠️ KorService2 함정(실측)**: `searchFestival2` 는 구 `areaCode` 를 **조용히 무시**(0건) — 법정동 코드
  `lDongRegnCd=47`(경북)+`lDongSignguCd=130`(경주) 를 써야 한다. `areaBasedList2` 는 legacy 도 동작(둘 다 유지).
- **Supabase 연결 + 실적재 완료(2026-07-10)** — 프로젝트 ref `epqdxkipwyy…` 아님 주의: `epqdxkydhptlivecwfwu`(ACTIVE).
  URL/anon/service_role 키는 `apps/api/.env` + `apps/web/.env.local` 에 기록됨(CLI 로 조회, 채팅 미노출).
  **실적재 결과: facilities 85행 = TourAPI 실데이터 69(음식점34·카페13+α·관광지·문화) + 시드 16.**
  운영시간 67건·이미지 63건(전부 https)·배리어프리 2건(천마총·김유신묘). contentid 부분 유니크 인덱스는
  PostgREST on_conflict 미지원 → 스크립트가 SELECT 후 INSERT/UPDATE 폴백으로 처리(정상 설계).
- **남은 사람 작업**: ① 최신 3개 마이그레이션 적용 — 대시보드 SQL Editor 에 리포 루트 `supabase_delta.sql`(임시,
  미커밋) 붙여넣기 실행(user_coupons·timestamp 인덱스·handle_new_user 트리거, 전부 멱등) 또는 `supabase link`+`db push`.
  ② 대시보드 JWT Secret → `apps/api/.env` `JWT_SECRET=`. ③ Authentication → "Allow anonymous sign-ins" ON.

## 0. 미완성 기능 완성 (실배포 관점 · tip `148bff0`)
- **관광객 인증 완성** — Supabase 익명 세션 무마찰 자동 로그인(로그인 UI 없이 per-device 세션) + 신규 유저 `public.users` 자동생성 트리거(`20260710160000_handle_new_user.sql`) + 세션 지속. 개인화(추천·코스·쿠폰·저장·제보) 401 블로커 해소.
- **마이페이지 스텁 실동작화** — 설정(`/mypage/settings`: 언어·알림·저장초기화·앱정보)·개인정보(`/mypage/privacy`)·프로필 수정(로컬 저장)·헤더 메뉴/벨.
- **메인 음성 검색(STT)** — 검색바 마이크 실동작(ko-KR, 미지원 폴백).
- **관리자 인프라 3종** — 수동 혼잡도 Override(신규 `POST /api/v1/admin/facilities/{id}/congestion`)·시설 검색·이상 알림 벨.

### ⚠️ 활성화에 필요한 사람 작업 (안 하면 무해하게 목업 폴백)
1. **인증:** Supabase Dashboard → Authentication → "Allow anonymous sign-ins" 켜기 + `supabase db push`(트리거 마이그레이션 적용).
2. **실데이터(TourAPI):** ① 국문 관광정보 서비스(data.go.kr `15101578`) → `apps/api/.env`의 `TOURAPI_KEY` → 기존 POI·축제 즉시 동작. ② 관광지별 혼잡도(방문자 집중률, `api.visitkorea.or.kr`) → 실혼잡 데이터(`congestion_logs.source='tour_api'`)로 SPOT/코스 격상(승인 후 client.py 연동 예정). 선택: 무장애(15101897)·연관 관광지(15128560).

## 1. 이번 사이클에 추가/개선된 것 (전부 커밋·푸시됨)

**성능/UX 최적화**
- 관리자 대시보드: 병렬 슬라이스 로딩 + 섹션 스켈레톤(전면 스피너 제거), 서버측 집계 `GET /api/v1/admin/dashboard/today`(12k행 클라 집계 제거)
- `congestion_logs(timestamp DESC)` 인덱스 — timestamp 범위조회 최적화
- 로그인 첫 페인트 개선(불필요 isMounted 게이트 제거)
- 메인 지도 초기 로딩: `/api/v1/infrastructures` 단일 호출(시설별 최신 혼잡 서버 조인) + supabase 폴백 병렬화
- 주 내비게이션 반응형: PC 왼쪽 세로 레일 / 모바일 하단 바
- 예측 시점 **슬라이더 바**(지금·+1~3h, 드래그 놓을 때 커밋)

**신규 관광객 기능**
- 최적 방문 시각: `GET /predict/day` + 추천 카드 24시간 미니 막대(최한산 시각 하이라이트)
- 분산 코스(멀티스톱 동선): `POST /api/v1/courses/recommend` + `/course` 페이지(타임라인) + 공유 버튼
- 혼잡 제보(크라우드소싱): `POST /api/v1/reports/congestion`(service_role 기록, 5분 쿨다운 레이트리밋) + 카드 제보 버튼(portal 모달)
- 내 쿠폰함(인센티브 지갑): `user_coupons` 테이블 + `GET /coupons/mine`·`POST /coupons/issue`·`POST /coupons/{id}/use`. **수락 시 서버측 자동 발급** → 지갑에서 사용까지 폐루프
- 배리어프리 필터(♿): 지도에서 무장애 시설만 표시(top-level 컬럼 + features 둘 다 인식)
- 인앱 한산 알림(옵트인): 저장한 곳이 한산해지면 로컬 Notification(visibility-aware 폴링)
- 공유(Share): Web Share API + 클립보드 폴백
- 다국어(i18n): 클라이언트 사전(ko/en/ja/zh), `useT()`, 랜딩·마이 언어 스위처 — 핵심 관광객 UI 전면 치환

## 2. 신규 엔드포인트 (전부 FastAPI, main.py 등록됨)
`/predict/day` · `POST /api/v1/courses/recommend` · `POST /api/v1/reports/congestion` ·
`GET /api/v1/coupons/mine` · `POST /api/v1/coupons/issue` · `POST /api/v1/coupons/{id}/use` ·
`GET /api/v1/admin/dashboard/today` (관리자)

## 3. 스키마
- 신규 마이그레이션 `20260710120000_add_congestion_timestamp_index.sql`, `20260710130000_add_user_coupons.sql`
- RESET_AND_SETUP.sql 은 자동 생성(직접 수정 금지 — 변경 시 `node scripts/build_reset.mjs` 후 파리티 확인)
- 사람이 할 일: `supabase db push`(신규 마이그레이션 적용) — user_coupons·index 반영 전까지 쿠폰/최적화 미적용

## 4. 검증 (CI 게이트)
```
cd apps/web && npx tsc --noEmit && npm run build            # 21 static routes
PYTHONUTF8=1 py -3.11 -m pytest apps/api -q                 # 118 passed
(cd apps/api && py -3.11 -m ruff check .)                   # clean
node scripts/build_reset.mjs && git diff --exit-code supabase/RESET_AND_SETUP.sql  # parity
```

## 5. 알려진 한계 / 다음 작업
- 코스 SPOT 점수 하위항이 단일 leg 시간 사용(누적 도착 미반영) — 응답 predicted_congestion 은 정직. score.py 시그니처 리팩터 필요(위험도 있어 검토 후).
- 로그아웃 방문자는 인증 필요 엔드포인트(추천/코스/제보/쿠폰) 401 → 폴백 상태로 강등(기존과 동일). 게스트 온보딩 개선 여지.
- 날씨·행사(TourAPI festival) 연동은 TOURAPI_KEY + 외부 날씨 API 필요로 보류.
- 프로덕션 품질 2차 감사 진행 중(전체 앱 a11y/모바일/엣지 상태) — 발견 사항 순차 수정 예정.

## 6. 배포 (FastAPI → Render, 웹 → Vercel)

코드/설정은 준비되어 있으나 아래는 **외부 계정 접근이 필요해 사람이 직접 해야 하는 작업**이다.

### 6-1. FastAPI 백엔드 — Render Blueprint 적용
1. https://dashboard.render.com 로그인 → **New → Blueprint** → GitHub 리포(`NextSpot-knu/NextSpot`) 연결
2. Render 가 루트 `render.yaml` 을 자동 인식(type web · runtime docker · `apps/api/Dockerfile`, 컨텍스트 `apps/api`) → 서비스 `nextspot-api` 생성 제안
3. `render.yaml` 은 아래 env 값을 전부 `sync: false` 로 선언해뒀다 — Render 가 값을 자동으로 채우지 않으므로 **Blueprint 적용 화면(또는 서비스 생성 후 Environment 탭)에서 직접 입력**해야 배포가 정상 기동한다. 값 자체는 아래 "출처" 열의 로컬 파일에서 그대로 복사(여기 문서에는 키 이름만 남기고 값은 적지 않는다):

| Render env var | 값 출처 |
|---|---|
| `SUPABASE_URL` | `apps/api/.env` 의 동일 키 |
| `SUPABASE_SERVICE_ROLE_KEY` | `apps/api/.env` 의 동일 키 |
| `SUPABASE_ANON_KEY` | `apps/api/.env` 의 동일 키 |
| `JWT_SECRET` | `apps/api/.env` 의 동일 키(Supabase Dashboard → Project Settings → API → JWT Secret) |
| `ADMIN_API_TOKEN` | 로컬 데모값(`nextspot-admin-local`) 재사용 금지 — `openssl rand -hex 32` 로 새 값 발급 후 `apps/web`(Vercel) `NEXT_PUBLIC_ADMIN_API_TOKEN` 과 동일하게 맞출 것 |
| `ALLOWED_ORIGINS` | Vercel 배포 도메인(6-3 참고) |
| `TOURAPI_KEY` | `apps/api/.env` 의 동일 키 |

4. Deploy 완료 후 `https://<서비스>.onrender.com/health` 가 200 을 반환하는지 확인(`render.yaml` 의 `healthCheckPath`, `apps/api/app/main.py` 의 `/health` 라우트 기준).
5. (선택) `.github/workflows/uptime.yml` 이 10분마다 `/health` 를 핑한다. GitHub repo → **Settings → Secrets and variables → Actions → Variables** 에 `BACKEND_HEALTH_URL`(예: `https://<서비스>.onrender.com/health`)을 등록하면 활성화되고, 미등록이면 워크플로가 무해하게 skip 된다.

### 6-2. 웹(Next.js) — Vercel 환경변수 추가
Vercel 프로젝트(Root Directory `apps/web`) → Settings → Environment Variables 에 아래 4개가 있어야 백엔드/지도가 붙는다:

| Vercel env var | 값 출처 |
|---|---|
| `NEXT_PUBLIC_FASTAPI_URL` | Render 서비스 URL(예: `https://nextspot-api.onrender.com`) |
| `NEXT_PUBLIC_SUPABASE_URL` | `apps/web/.env.local` 의 동일 키 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `apps/web/.env.local` 의 동일 키 |
| `NEXT_PUBLIC_KAKAO_MAPS_APP_KEY` | `apps/web/.env.local` 의 동일 키 |

Kakao Maps JS SDK 는 도메인 화이트리스트 방식이므로, **Kakao 개발자콘솔 → 내 애플리케이션 → 플랫폼 → Web 플랫폼 도메인**에 Vercel 배포 도메인(예: `https://nextspot-xxx.vercel.app`, 커스텀 도메인이 있으면 그것도 함께)을 등록해야 지도가 렌더링된다.

### 6-3. CORS — ALLOWED_ORIGINS 지정 시 엄격 모드 자동 전환
`apps/api/app/main.py` 는 `ALLOWED_ORIGINS` 에 `*` 가 포함되거나 미설정이면 모든 오리진을 허용하되 `allow_credentials=False`(느슨 모드)로 동작하고, 실제 도메인 목록이 들어오면 해당 오리진만 허용 + `allow_credentials=True`(엄격 모드)로 자동 전환한다. Render 의 `ALLOWED_ORIGINS` 를 Vercel 배포 도메인으로 지정(콤마 구분, 예: `https://nextspot-xxx.vercel.app,https://your-custom-domain.com`)하면 배포와 동시에 엄격 모드가 켜진다 — 운영 전 반드시 지정할 것(방치 시 와일드카드로 열려 있음).

### 6-4. 미적용 DB 마이그레이션 4개
아래 4개는 아직 Supabase 에 적용되지 않은 상태다(기존 DB 유지 경로 — `DEPLOY_AND_ENV.md` 1-1 절 "기존 DB를 유지" 참고):
- `supabase/migrations/20260710170000_add_coupon_expiry.sql`
- `supabase/migrations/20260710171000_add_user_report_count.sql`
- `supabase/migrations/20260710172000_congestion_source_honesty.sql`
- `supabase/migrations/20260710173000_add_app_events.sql`

적용 방법: Supabase 대시보드 → **SQL Editor** → 위 4개 파일을 **파일명 오름차순(타임스탬프 순)** 으로 하나씩 전체 복사 → 붙여넣기 → Run(전부 멱등이라 재실행해도 안전). 또는 `supabase link` 후 `supabase db push` 로 일괄 적용해도 된다.
