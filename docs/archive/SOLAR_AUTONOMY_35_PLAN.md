# Solar 자율권 #3·#5 + 편의점 편의 레이어 — 기획 정본 (2026-07-31 PM 승인)

> `SOLAR_AUTONOMY_PLAN.md` 5안 중 **#3(추천 사유의 사실 선택권)**·**#5(거절 이해)**와
> PM 추가 지시 **편의점 편의 레이어**를 한 사이클로 묶은 설계 정본.
> 방향·반영 방식·접근안(A안: 구조화 근거 태그)·설계 전문은 2026-07-30~31 PM 승인.
> 구현 마일스톤·커밋 해시는 별도 implementation plan 문서에 기록한다.

## 0. 컨텍스트·범위

- **#3 사유 사실 선택권**: 추천 카드 사유 생성 시 근거 묶음(혼잡 3단계·거리·대기 절감·메뉴·
  날씨·축제·쿠폰)을 Solar에 통째로 주고 **어떤 근거를 앞세울지 Solar가 선택**해 작문한다.
  랭킹은 SPOT 독점 유지 — Solar는 "왜"의 문장만 만들고 "순서"는 절대 건드리지 않는다.
- **#5 거절 이해**: 거절 실험실 자유텍스트("너무 시끄러워")에서 Solar가 **선호 보정 방향을
  제안** → **사용자 1탭 확인 후에만** 서버 클램프 범위 내 8차원 벡터 속성 차원을 보정한다
  (PM 확정: 자동 반영 아님, 제안 표시만도 아님 — 확인 후 반영).
- **편의점 레이어**: 공중화장실 바텀시트 패턴 복제 — Kakao 실시간 카테고리 검색(`CS2`),
  DB 저장 없음(약관 준수), SPOT 후보·점수와 완전 분리 (PM 확정: 추천 후보 편입 아님).

### 착수 전 정찰 핵심 발견 (2026-07-30 멀티에이전트 정찰, 에이전트 6·토큰 102만)

1. #3은 **LLM 추가 호출 0**으로 가능 — 기존 polish 호출 1회를 "선택+작문"으로 승격.
   라우터는 근거를 이미 다 들고 있으나 context로 안 넘긴다(날씨만 미연결, 30분 캐시).
2. #5의 난제는 **학습 슬롯**: classify는 성공 즉시 -5% 학습 + `learning_applied_at` 슬롯
   선점. 나중에 오는 확인-보정이 같은 슬롯을 쓰면 상호 배제 → **전용 슬롯 컬럼 신설**.
3. `feature/time-weather-ux`(감사 대기)가 `recommendations.py`(+122줄)·`weather_service.py`를
   선점 수정 — #3은 머지 후 rebase 진행, #5·편의점은 겹침 0이라 즉시 착수.
4. `_is_honest_polish`는 숫자·시설명만 검증, "(AI 예측)" 라벨 보존은 미검증 — 근거가
   커지면 predicted를 실측처럼 표현할 표면이 넓어짐(심사 감점 직결) → 검증 확장 필수.

## 1. 팀 불변 규칙 (전 마일스톤 공통)

1. **SPOT 신중 구역**: `apps/api/app/services/spot/score.py` · `packages/shared-types/spot.ts`
   **변경 0줄**. 근거는 breakdown에 이미 있으므로 라우터/서비스 계층에서만 확장.
2. **LLM 3원칙**: 실패는 전부 200 + 무해 폴백(기능 장애 승격 금지) / LLM 출력은 화이트리스트
   enum·태그까지만(8차원 벡터 직접 출력 금지 — 금지 구역 ⑥) / 자유텍스트·LLM 응답 원문
   서버 로그 금지(코드·길이만).
3. **정직성**: 합성 수치 표시 금지, `predicted` 라벨 보존, `none`이면 혼잡 근거 원천 제외.
4. **i18n 4로케일(ko/en/ja/zh) 동시 반영** — 신규 사용자 노출 문자열은 LLM 원문이 아니라
   enum→i18n 키 조립(4로케일 자동 해결 + LLM 텍스트 미노출).
5. **TDD** + 마일스톤별 게이트: web(lint→typecheck→test→build), api(ruff→pytest),
   스키마 파리티, 신규 Playwright spec. 구현 완료 후 Codex 적대 감사(팀 관례).
6. 스키마 변경은 `supabase/migrations/` 신규 파일 + `node scripts/build_reset.mjs` 재생성
   (RESET_AND_SETUP.sql 직접 수정 금지).

## 2. 작업 순서·브랜치 전략

- 새 워크트리 `NextSpot-feature-solar35`, 브랜치 `feature/solar-autonomy-35`,
  베이스 `feature/jinseok` HEAD — 원본 트리 미커밋 LOCALDATA 작업과 격리.
- 마일스톤 순서 **#5 → 편의점 → #3**:
  - #5·편의점: timeweather와 파일 겹침 0 → 즉시 착수.
  - #3: `feature/time-weather-ux` 감사·머지 완료 후 rebase하여 진행. #3의 날씨 근거는
    timeweather의 시간별 예보·`risk_reasons`를 재사용하고, `depart_offset_min`이 있으면
    **도착 시각 예보**를 근거로 쓴다(+Nh 카드에 "지금 비"를 붙이는 정직성 위반 방지).
- `tracking.py` 이벤트 화이트리스트는 #5가 먼저 커밋(같은 파일을 #3도 수정 — 충돌 회피).

## 3. #5 거절 이해 — 설계

### 3-1. 서버 (classify 확장 + 확인 엔드포인트)

- **classify 현행 유지 + additive**: `POST /lab/{id}/reason/classify`의 즉시 학습(-5%)과
  `resolved`/`llm_status` 계약은 그대로. 응답에 additive 필드 추가:

  ```python
  suggestion: {"attribute": Literal["tasty","instagrammable","barrier_free","quiet"],
               "direction": Literal["+","-"]} | None
  requires_confirmation: bool = True   # travel_context ParseResponse 선례
  ```

  - Solar 프롬프트에 제안 스키마 추가(추가 호출 0 — 기존 chat_json 1회에 동승).
  - 화이트리스트 = ATTR_DIM 4종(dim4~7) × ± 방향 8개 enum. 밖이면 전량 폐기 후
    `suggestion=None`(무해 폴백). 카테고리 차원(dim0~3)은 preferred_categories 경로와
    이원화되므로 1차 범위 제외. 제안은 1건 = 속성 1개 + 방향 1개.
  - 제안은 **무상태**(DB 미기록) — 확인 시 클라이언트가 재전송하고 서버가 재검증.
    JUDGE_QA Q10("개인화는 preferred_categories와 벡터뿐")이 그대로 참.
- **신규 `POST /api/v1/lab/{feedback_id}/adjustment/confirm`** (body: attribute·direction):
  1. `_fetch_own_feedback` 소유권 가드(비UUID/미존재 404, 타인 403)
  2. `is_expired` 30일 만료(409)
  3. attribute·direction 화이트리스트 **서버 재검증**(클라이언트 신뢰 금지)
  4. **전용 슬롯 `adjustment_applied_at`** `.is_(col,'null')` 조건부 UPDATE 원자 선점
     (at-most-once; 기존 `learning_applied_at`과 독립 — 사유 학습과 보정 공존)
  5. 선점 성공 시에만 벡터 보정: 해당 속성 차원 원핫 방향 벡터로 **서버 고정 5% lerp**
     (거절 학습 계열 클램프 관례) 후 L2 정규화. `PreferenceVectorStore`에 신규 메서드
     추가(기존 메서드 시그니처 무변경 관례), 순수 로직은 `feedback_service`에.
  - 선점 실패(이미 적용)는 200 + `applied:false` 멱등 응답.
- **마이그레이션 1개**: `user_feedback.adjustment_applied_at timestamptz NULL` +
  `build_reset.mjs` 재생성(PRELUDE 확인).
- **계측**: `tracking.py` `_EVENT_PROPS`에 제안 노출/확인/거부 퍼널 이벤트 추가.

### 3-2. 프런트 (실험실 인라인 확인)

- `app/mypage/lab/page.tsx`: classify 성공 + `suggestion` 존재 시 낙관적 제거를 보류하고
  카드 안에 **인라인 제안 블록** 렌더 — 문구는 enum→t() 조립(예: "한적함 선호를 높일까요?")
  + [적용]/[괜찮아요]. 적용 → confirm 호출 → 기존 mutate 낙관적 제거 패턴. 거부 →
  기존 흐름대로 제거(학습은 classify분만 유지). `suggestion` 없으면 현행과 동일.
- 적용 성공 시 전역 sonner 토스트("취향에 반영했어요") — main 페이지 로컬 showToast 금지
  (단일 슬롯 덮어씀 이슈). TasteRadar는 기존 `GET /users/me/vector` 재조회로 자연 반영
  (한국어 하드코딩 부채 수리는 범위 밖).
- i18n: `lab.suggestion.*` 신규 키 4로케일 동시(속성 4종 × 방향 문구 + 버튼 2종 + 토스트).
- `api-client.ts`: `classifyLabReason` 반환 확장(additive) + `confirmLabAdjustment` 신설.

## 4. 편의점 편의 레이어 — 설계

- 서버: `restroom_service.py` 패턴 복제 — Kakao Local **카테고리 `CS2`** 검색(키워드 불필요),
  현재 위치 3km 최대 15곳 거리순, 최대 3페이지 수집·id 중복 제거, 실시간 프록시(DB 저장
  없음 = Kakao 약관 준수). 신규 라우터 엔드포인트는 화장실과 동일 셰이프.
- 프런트: `/main` 편의 바텀시트에 편의점 항목 추가(화장실과 동일 UX — 거리순 목록 +
  Kakao 장소 상세 링크). i18n 4로케일.
- SPOT 추천 후보·점수와 완전 분리(편의 레이어) — 추천 품질 왜곡 0.

## 5. #3 사유 사실 선택권 — 설계

### 5-1. 근거 묶음·LLM 계약

- 라우터 `_reason_for` context 확장(메인·by-type 두 경로): 기존 6키 + 쿠폰(`coupon_rate`,
  by-type는 `apply_merchant_boosts` 이후 값 = 타임세일 반영), 축제(`event_title`·
  `event_boost`), 메뉴(`first_menu`/`treat_menu`, 음식점만), 대기 절감분
  (`original_wait_time`, 메인 경로만 — 경로 비대칭 명시), 날씨(§5-3), 혼잡 3단계.
- **`chat_text` → `chat_json` 전환**: 응답 `{"reason": str, "used_evidence": [태그]}`.
  근거는 태그+수치 조각으로 직렬화하며 수치 표기는 템플릿과 동일 반올림(문자열 집합
  비교 오탐 방지). 프롬프트는 "근거 중 1~2개를 앞세워 2문장 이내" 지시.
  타임아웃 1.5s·max_tokens 상수는 입력 증가분 실측 후 재검토.
- **폴백 = 현행 템플릿 그대로(회귀 0)**: LLM 비활성·실패·검증 탈락 시 기존 3사실 결정적
  문장. `generate_reason(context)->str` 공개 시그니처·`reason_source` 어휘 불변.

### 5-2. 정직성 3중 검증 (`_is_honest_polish` 확장)

1. 숫자 ⊆ **제공한 근거 조각 전체의 숫자 합집합**(기존: 템플릿 숫자만) — 일부 근거만
   선택(부분집합)은 자동 허용.
2. 시설명 원문 포함(기존 유지).
3. **신규**: `used_evidence` ⊆ 제공 태그 / `congestion_source=predicted`면 출력에
   "(AI 예측)" 라벨 문자열 보존 강제 / `none`이면 혼잡 근거를 묶음에서 원천 제외
   (`_build_template`의 "0%를 실측처럼 팔지 않기" 게이트와 동일).
- 캐시 키를 (facility_id, **근거 묶음 정규 직렬화**)로 교체 — 타임세일 종료·날씨 변화 시
  낡은 사유 재사용 자동 차단. TTL 600s 유지.

### 5-3. 날씨 근거 (비차단)

- `get_gyeongju_weather()` 30분 프로세스 **캐시 히트일 때만** 근거에 포함, 미스면
  백그라운드 워밍 후 이번 요청은 날씨 근거 생략 — 미캐시 첫 호출 5초 타임아웃이 추천
  지연에 끼는 것 방지("요청 경로 LLM 블로킹 금지" 서사·실측 보호).
- `depart_offset_min>0`이면 시간별 예보에서 **도착 시각** 항목 사용(timeweather 머지 후).

### 5-4. 노출·감사

- `RecommendItem.reason_evidence: list[str] | None` additive 추가(태그만) +
  `recommendation_snapshot`에 저장 → 기존 `/recommendations/{id}/explain` 답변과 카드
  사유 불일치 방지. by-type 합성 id(`bytype-*`)는 기존과 동일하게 스냅샷 미저장(스코프 노트).
- UI 신규 배지 없음(기존 혼잡·축제·메뉴 배지와 중복 회피 — 문장 자체가 결과물).
  `LlmDebugToast`·`reason_source` 배지 현행 유지.
- **TTS 판정**: `speakCard`가 이 사유를 읽는 것은 정직성 검증 통과분이므로 **허용**
  (서버 템플릿 전용 원칙의 예외로 명문화 — 검증 게이트가 서버에 있으므로 원칙 취지 유지).
- 사유 문장은 한국어 전용(기존 부채) — 4로케일 사유는 이번 범위 밖으로 명시.

## 6. 검증 (Verification)

- **pytest(#5)**: 제안 화이트리스트 밖 폐기·suggestion=None 폴백 / confirm 소유권 403·
  만료 409·화이트리스트 재검증 422 / `adjustment_applied_at` exactly-once(AsyncMock 1회·
  재호출 applied:false) / 기존 -5% 학습과 이중 적용 없음(두 슬롯 독립) / classify 기존
  테스트 무회귀. FakeSupabase `_Query`에 신규 연산 추가.
- **pytest(#3)**: 근거 태그 위반·라벨 탈락 시 템플릿 폴백 / predicted 라벨 보존 /
  none 혼잡 제외 / 캐시 키에 근거 직렬화 반영(타임세일 변화 시 미스) / **근거 묶음이
  기존과 동일할 때 응답 완전 동일(회귀 0)** / by-type 쿠폰 오버레이 반영.
- **pytest(편의점)**: CS2 카테고리 호출·3페이지·중복 제거·거리순(화장실 테스트 패턴 복제).
- **web**: 실험실 제안 블록 단위테스트(제안 렌더·적용·거부·suggestion 없음 현행 동일),
  i18n parity 0 missing, Playwright 390×844 — ① 실험실 자유텍스트→제안→적용→토스트
  ② 편의점 시트 열기→목록. 기존 스펙 무회귀.
- 최종: Codex 적대 감사(별도 세션, 팀 관례) 후 머지 판단.

## 7. 리스크 요약

- **이중 학습** — 전용 슬롯 분리 + AsyncMock 1회 테스트로 고정.
- **라벨 탈락(predicted→실측 위장)** — 검증 3중화 + pytest 고정. 잔존: 라벨 문자열 검사는
  표현 변형 완전 방어가 아님(P0-2 관제 브리핑과 동일한 정직한 한계 — 태그 화이트리스트
  + 숫자 합집합이 1차 방어).
- **REASON_CODES 어휘 확장 없음** — 이번 사이클은 기존 9코드 유지(4곳 패리티 리스크 회피).
- **timeweather 머지 지연 시** — #5·편의점만으로 사이클 종결 가능(마일스톤 독립),
  #3은 머지 후 착수라 블로킹 없음.
- **Kakao 쿼터** — 편의점은 화장실과 동일 REST 키·쿼터 풀 공유. 바텀시트 열 때만 호출.
- **suggestion 위변조** — 무상태 설계라 confirm 시 서버 화이트리스트 재검증이 전부
  (클램프·방향·속성 enum 모두 서버 통제라 위조해도 5% lerp 1회가 상한).

## 8. 데모·심사 문서 정합

- `DEMO_SCENARIO.md` 0:50–1:30(TTS 사유 구간): #3 도입 후 **리허설은 실키 켠 상태로
  실문장 확정** 절차를 대본 운영 메모에 추가. 축제 근거는 배지와 이중 언급 방지 정책
  + 8/17 이후 축제 종료 null 강건성 확인.
- `JUDGE_QA.md` Q4(취향 가시화)·Q10(개인화 데이터) 답변 갱신 — #5는 "확인 후에만
  반영하는 보정"으로 서사 강화. 실험실은 데모 센터피스가 아니라 **Q&A 방어 소재**
  (SOLAR_LLM_EXPANSION 전제 1의 기존 PM 확정 관례).
- `SOLAR_AUTONOMY_PLAN.md` 5안 표의 #3·#5 상태 갱신(구현 착수) + #2 부분 구현
  (음성 앱 제어 v1) 반영.

## 9. 범위 밖 (이 사이클 미포함)

- 음성 유사 대안 SPOT 정렬 백로그(클라 미러 점수 동봉 트레이드오프 — WS-D와 조화 필요).
- explore/recommend 👎 직후 인라인 제안(실험실 한정이 1차).
- TasteRadar i18n 전환·보정 전/후 레이더 비교, 사유 문장 4로케일화.
- REASON_CODES 어휘 확장, 카테고리 차원(dim0~3) 보정, 음수 델타 상한 논의 외 클램프 변경.
- `CONGESTION_TRUST_SPEC` Phase 2(혼잡 기준선 predicted 대체).
