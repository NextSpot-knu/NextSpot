# 세션 인계 문서 (2026-07-20 갱신)

## -22. 2026-07-19 — 추천 품질 골든 게이트 + 현장 폐루프 + Playwright

### 2026-07-20 후속 완료

- 별도 승인 후 공식 시설 페이지 근거가 있는 국립경주박물관·경주예술의전당 2곳의 원격
  `features.indoor_verified=true`를 기존 JSON 보존 병합으로 반영하고 즉시 재조회 검증했다. 적용 감사는
  `scratch/indoor_evidence_apply.json`에만 저장했다. 인증 라이브 재평가는 활성 장소 **104개**,
  12개 시나리오, 하드 실패 **0건**이며 실내 근거 미확인 culture는 7곳에서 5곳으로 감소했다.
  실내 시나리오의 빈 결과 경고 2건은 평가일이 월요일이고 두 검증 시설 모두 확정 월요 휴무여서
  휴무 필터가 정상 작동한 결과다. 나머지 5곳은 공식 근거 확보 전까지 검증 표식을 보류한다.
- Supabase 익명 세션을 메모리에서만 발급해 배포 추천 API 인증 라이브 스모크를 완료했다. 활성 장소
  **104개**, 12개 시나리오, 하드 실패 **0건**. 토큰·사용자 ID는 보고서에 기록하지 않았고 결과는
  `scratch/recommendation_quality_live_authenticated.json`에만 저장했다. 라이브 CLI는 이제 유형,
  도보 상한, 확정 휴무, 검증 접근성, 실내 자격, 혼잡 근거, SPOT 동점 정렬을 실제 응답에서 검사하며
  인증 없이 실행하면 성공으로 오인하지 않고 실패한다.
- Playwright 상세 흐름 3개 추가: 고정 SPOT 순위→비교 설명 실패 폴백→길안내 상태 저장,
  도착→만족도→완료 화면 유지→쿠폰함 CTA, 재추천 0건→기존 여정 유지. 기존 4로케일/외부
  길안내와 합쳐 Chromium 390×844 **8/8 통과**. CI는 서버를 별도 기동·준비 확인한 뒤 테스트해
  Windows의 Playwright 자식 서버 종료 지연과 무관하게 동작한다.
- 원격 `main@a97c1e0` CI 확인: e2e/API/web/schema 네 잡 모두 성공(run `29720309139`).
  후속으로 SOLAR on/timeout/disabled의 추천 카드 이름·순서 동일성과 ko/en/ja/zh 실제 추천 화면의
  3개 순위 카드·390px 가로 오버플로를 추가해 로컬 Chromium **13/13 통과**. 화면 전환 중 폭을
  즉시 샘플링하지 않고 안정 상태까지 poll해 애니메이션 타이밍 플레이크를 제거했다.
- 원격 `main@411f094` CI도 네 잡 모두 성공(run `29720645883`). 이후 골든 현장 문구 4종을
  결정적 조건 정규화로 연결: 돼지고기→restaurant, 조용한 카페→cafe, 비가 와서 실내→indoor,
  너무 멀어서 가까운 곳→도보 10분 상한. 모호한 `near`는 후보 자격에만 적용하고 SPOT 점수에는
  개입하지 않는다. 방문 E2E는 혼잡도 `한산` 제보 payload까지 검증한다.
- 4로케일 병렬 E2E가 음성 오브의 `animate-ping` 도중 7~10px 문서 폭 증가를 포착했다. 오브 펄스를
  원형 버튼 내부로 클리핑하고 페이지 x축도 paint clip 처리해 수정; Chromium 13/13을 연속 2회 통과.
  최종 게이트: API pytest **624 passed**, ruff, web lint 0 errors/typecheck/unit/build 32 pages,
  스키마 파리티와 `git diff --check` 통과.
- 라이브 데이터 후속 감사(적용 전): culture 7곳 중 실내 근거가 채워진 곳이 0곳이라 `첨성대 실내 문화`와
  `비가 와서 실내`가 빈 결과였다. 라이브 보고서는 이를 하드 실패와 분리한 경고 2건 및 7개 시설 ID
  데이터 공백으로 기록한다. 공식 시설 페이지가 확인된 국립경주박물관·경주예술의전당 2곳만
  `scratch/indoor_evidence_dry_run.json`에 `indoor_verified=true` 제안으로 작성했다. 이후 별도 승인을 받아
  위 2026-07-20 후속 완료 항목대로 원격 반영했다.
- 운영시간 파서는 시드 `weekday/weekend`와 영문 휴무 요일(`monday` 등)을 지원한다. TourAPI `open`
  폴백과 도착 시점 `closing_soon` 규칙은 유지한다.

- 추천 품질 CLI `apps/api/scripts/recommendation_quality.py` 추가(`fixture/live`, `--base-url`,
  `--output`, 인증 라이브용 `--bearer/--user-id`). 공개 관광 거점과 고정 시각을 쓰는 12개 JSON
  시나리오에서 실제 SPOT 함수·도보 상한·영업시간·유형·실내·검증 접근성·방문 제외를 검증한다.
  평가일 2026-07-19, fixture 12개, 하드 실패 **0건**. 커밋 `b73efa4`.
- 무인증 라이브 스모크는 배포 `/api/v1/infrastructures`에서 활성 장소 **104개**를 확인해
  `scratch/recommendation_quality_live.json`에 저장(비커밋). 추천 상세은 JWT 소유권 계약 때문에
  토큰 없이 비워 두었으며, 인증 라이브 실행은 `--bearer/--user-id`를 함께 전달해야 한다.
- 방문 만족도 뒤 완료 화면과 `내 쿠폰함` CTA를 유지하고 완료 닫기가 여정을 복원하지 않게 분리.
  재추천 0건이면 기존 여정을 유지하며 안내하고, 재추천·길안내 재개에 `navigation_started`, 설명
  요청 예외에 `recommendation_explained(llm_failed)`를 기록한다. 원문 분석 필드는 추가하지 않았다.
- Chromium Playwright/CI 도입: 390×844, ko/en/ja/zh 가로 오버플로, 고정 여정과 Kakao 외부 이동
  스텁을 검증한다. 로컬 assertion 5/5 통과(Windows 개발 서버 종료 지연은 direct Next 실행으로 보정),
  커밋 `80c0b6e`.
- 검증: API pytest **620 passed**, ruff 통과; web lint 0 errors(기존 warning 178), typecheck,
  단위 테스트(음성 29/29+i18n 636키+travel context), build 32 pages 통과; 스키마 패리티와
  `git diff --check` 통과. SPOT 가중치·산식·정렬은 변경하지 않았다.

## -20. 2026-07-18 — Upstage Solar 확장 기획 확정 (신규 5종) + Kakao 키 사람 작업 완료

- §-19 의 **사람 작업(P0) 완료**: Vercel `NEXT_PUBLIC_KAKAO_MAPS_APP_KEY` JavaScript 키 교체 +
  Kakao Web 도메인 등록 완료(PM 직접 수행). SDK 401 해소 전제 충족.
- **Solar 신규 활용 기획 확정** — 정본: [`SOLAR_LLM_EXPANSION.md`](./SOLAR_LLM_EXPANSION.md).
  방법론은 Codex A안(8후보) ∥ Fable 멀티에이전트 B안(5렌즈 29건→18후보→적대 검증→누락 비평,
  에이전트 30) 병렬 발산+합성. PM 확정: **P0 2종(자연어 선호 백스톱·관제 오늘의 브리핑) +
  P1 3종(검색 0건 재작성·축제 다국어 요약·머천트 실행 브리핑) 구현, 데모 대본은 현행 유지**.
- 검증 핵심 발견: ① `/preferences/parse` 의 `nlAppliedAi` 프런트 분기는 백엔드
  `is_fallback=True` 고정으로 도달 불가한 죽은 코드(P0-1 이 부활시킴) ② 심사 임팩트 변별점은
  데모 대본 노출 여부(머천트·안전·문의·실험실은 대본 grep 0건) ③ 신규 지점은 JUDGE_QA "사전
  배치+캐시" 서사와 정합해야 함(요청 경로 LLM 블로킹 금지). 금지 구역 7종 양안 일치(문서 §4).
- **PM 작업분 커밋**: OptimizationLoader(course/waiting 로딩 최적화 안내 카드 + optimization.* 4로케일
  키) — 게이트(lint 0·tsc·build 32p·음성 29/29) 확인 후 P0 구현 착수 전 선커밋(i18n 한 줄 JSON 이
  P0-1 신규 키와 섞이는 것 방지). `ingest_kakao_places.py`+테스트는 미완 판단으로 미커밋 유지.

### P0 2종 구현 완료 (`7c433d7` P0-1 · `8d342df` P0-2)

- **P0-1 자연어 선호 백스톱**: 키워드 전량 미스일 때만 Solar → `_coerce` 화이트리스트 재검증 →
  기존 `build_preference_vector()` 전용(벡터 직접 출력 무시). LLM 실기여 시 `is_fallback=False` 로
  죽어 있던 `nlAppliedAi` 분기 부활. 요약은 백엔드 summary(하위 호환 유지) 대신 구조화 코드를
  프런트 t() 조립(4로케일 신규 10키). Codex 감사 전 항목 통과.
- **P0-2 관제 브리핑**: Codex 적대 감사 2회가 게이트를 두 번 뚫었다 — ①1차: 자유 문장 숫자
  부분집합 검사는 한글 수사·콤마·부호·필드 바꿔치기로 우회 실증 → **플레이스홀더 치환 설계**
  전환(LLM 은 `{avg}` 류 토큰만, 숫자는 유니코드 N* 전 카테고리 거부, 치환은 서버) ②2차: 의미
  오배치("{anomalies}의 재배치")·원문자 ①·비정량 수량어("여러 건")·추세어 빈틈(웃돌/기록적) →
  토큰 직전 문맥 지표 키워드 게이트 + 목록 확장 + 실패 캐시 TTL 60s 분리. **잔존 리스크(정직)**:
  문맥 게이트는 한국어 표현 변형상 완전 방어가 아님 — 내부 admin 화면 + KPI 타일 병기로 수용,
  완전 방어인 '서버 고정 템플릿 선택'은 LLM 실질 소멸이라 기각(기획 문서 P0-2 에 명시).
- 게이트: pytest **477 passed**(적대 회귀 14종 포함) · ruff · lint 0 · tsc · 29/29 · build ·
  스키마 패리티 · i18n 패리티 0 missing. 오케스트레이션: 구현 Fable 에이전트 2(파일 소유권 분리)
  + Codex 적대 감사 2회(P0-2 재설계 유발) — 감사가 게이트로 못 잡는 결함을 잡는 패턴 재확인.
- 🟢 브라우저 검증(사람): ① /explore/recommend 온보딩 자유문장("조용하고 사람 적은 데") →
  'AI가 선호를 반영했어요' 토스트 + 디버그 배지 '선호 분석: Solar 응답' ② /admin/dashboard 상단
  '오늘의 브리핑' 카드(hasLogs 충족 시) — KPI 타일 수치와 브리핑 문장 수치 일치 확인.
- ⚠️ 프로덕션 발현 전제: Render `UPSTAGE_API_KEY` 등록(§-14 사람 작업, 미등록 시 두 기능 모두
  조용히 비활성 — 무해).
## -21. 2026-07-18 — 혼잡 근거 전수 감사 + 신뢰성 명세 초안 + 장소 밀도 이슈

### §-20 RESUME 실행 — 「추천 근거 신뢰성 개선 명세」 초안 완료 (PM 검토 대기)

- 혼잡 데이터 생산→전달→표시 전 경로 전수 감사 완료. 핵심: **지도 경로는 이미 정직**
  (로그 없으면 null → 회색 마커·`card.noData`·`source`/`is_stale`/`anchored` 완비),
  **추천 경로만 비정직** — `recommendations.py:257,429`의 `.get(id, 0.0)` 폴백이
  `current_count=0`(잔여석 전체)과 `reason_service.py:67,74`의 "혼잡도 0%, 여유가 있습니다"로
  흘러 실측처럼 노출. `RecommendItem`에 혼잡 출처 필드 자체가 없음. SPOT 랭킹은 0.0을 쓰지
  않고 `predict_congestion`을 쓰므로(`score.py:83-88`) **점수는 오염되지 않음 — 표시만 문제**.
- 명세 초안: **`docs/CONGESTION_TRUST_SPEC.md`** — 3단계(`measured`/`predicted`/`none`) 근거
  모델, API 필드 신설, 사유 문구 규칙, UI 표(수정 대상 file:line 전부 포함), 테스트·완료 조건,
  PM 결정 요청 4건(D-1~D-4). 미학습 모델의 0.5 폴백을 "AI 예측"으로 팔지 않는 규칙 포함.
  대본 충돌 확인 완료: "혼잡도 0%"는 `DEMO_SCENARIO.md`·`JUDGE_QA.md`에 미등장 — 교정 안전.

### PM 제기 — 황리단길 마커 밀도 문제 (2026-07-18)

- PM 관찰: 카카오맵 대비 마커가 드문드문함. 원인은 버그가 아니라 **TourAPI 등록 밀도**
  (§-16 실측: 반경 4km에도 108곳). 대응 A안(Kakao Local FD6/CE7 보강 적재, 표시 전용→추천
  편입 2단계) 권장, 단 **신뢰성 명세가 선행 조건**(신규 장소 전부 로그 0건). 상세는 명세 §8.

### 환경·P0 확인 결과

- 재시작 후 재확인 완료: `py -3.11` = 3.11.9, ruff 0.15.22. §-20의 `search.py`/`test_search.py`
  줄바꿈 의사변경은 내용 diff 없음 확인 — 사용자 변경 아님.
- 🔴 **사람 작업(P0 신규): `apps/api/.env` 소실** — 이 저장소 사본(`Desktop/NEXTSPOT`)에는
  `.env.example`만 존재하고 AGENTS.md의 옛 경로(`Desktop/nextspot/NextSpot`)는 더 이상 없음.
  저장소 이동 시 `.env`가 따라오지 않은 것으로 추정. fail-fast 4종(`SUPABASE_URL`
  `SUPABASE_ANON_KEY` `JWT_SECRET` `ADMIN_API_TOKEN`) + `KAKAO_REST_API_KEY` `GEMINI_API_KEY`
  복원 전까지 로컬 백엔드 구동·원격 DB 조회 불가. (AGENTS.md 경로 문구도 갱신 필요)
- P0 원격 검증 한계: 프로덕션 정적 HTML에서는 Kakao SDK 키 확인 불가, `gh` CLI 미설치로
  Actions 상태 확인 불가. Vercel JavaScript 키 교체·Web 도메인 등록은 여전히 사람 확인 필요.

### PM 결정 + Phase 1 구현 완료 (같은 날 후속)

- PM 결정 4건 확정: D-1 신규 키 "혼잡 정보 준비 중" / D-2 Phase 1 점수 입력 불변 /
  D-3 데모 라벨 표시 / D-4 Kakao 확충 병행 기획. 상세는 `CONGESTION_TRUST_SPEC.md` §9.
- **Phase 1 구현 완료**: 서버 — `RecommendItem`에 `congestion_level/source/log_source/is_stale/
  timestamp` 신설, `fetch_congestion_map` 이 로그 info dict 반환(0.0 합성 제거),
  `resolve_congestion_evidence`(measured/predicted/none 판정 — 미학습 0.5 폴백은 none),
  `predict_congestion_detailed` 신설(래퍼 `predict_congestion` 동작 불변), reason 3단계 문구
  (predicted="예상 혼잡도 N% (AI 예측)", none=혼잡 문구 생략), current_count 는 실측일 때만 합성.
  프런트 — explore/recommend 3단계 배지·원본 중립 헤드라인, RecommendationCard D-1/D-3 라벨,
  bookmark `unknown` 상태(null→'한산' 저장 버그 수정), 음성 후보 congestion null 전송,
  i18n 4로케일 4키 추가. **주의(구현 중 정정)**: `courses.py:153` 기준선은 표시가 아니라 점수
  입력이라 Phase 1 에서 제외(D-2 와 함께 Phase 2) — 명세 §3-2 에 정정 기록.
- 검증: api pytest 455 통과·ruff 클린 / web lint 0 err·typecheck·test 29/29·build 통과 / 파리티 클린.
- **D-4 병행 기획 완료**: `docs/KAKAO_LOCAL_EXPANSION.md` — 조사 결과 Kakao Local 결과의 자체 DB
  영속 저장은 약관상 금지(데브톡 공식 답변) → 기본안을 A-2(준수형: kakao_place_id+url 만 인덱싱,
  표시 데이터는 실시간 프록시)로 재설계. 기존 좌표 정합의 features 저장도 같은 정책 확인 범위(R-2).
  사람 확인: 2026 공모전 요강의 보조 데이터 허용 여부, 데브톡 캐시 TTL 문의.
- `.env`는 사용자가 복원 완료(키 14종 확인). node_modules·pip 의존성도 재설치 완료(이동 여파).

### 화장실 검색 1건 버그 수정 (PM 신고, 같은 날)

- 원인 실측: Kakao 키워드 `공중화장실`은 황리단길 3km 에서 **1건, 그마저 월정교(문화유적) 오탐**.
  카카오는 화장실을 `화장실` 명칭 + `가정,생활 > 화장실` 카테고리로 등록한다(실측 12건+).
- 수정(`restroom_service.py`): 키워드 `화장실` + 카테고리 필터(문화유적류 오탐 차단) +
  최대 3페이지 수집(is_end 조기 종료)·id 중복 제거. 라이브 재검증 1건→12건. 테스트 6건 추가.

### 음성 '삼겹살→화덕피자' 오탐 수정 (PM 신고, 같은 날)

- 원인 실측: `_FOOD_QUERY_ALIASES` 확장 토큰 `고기`가 반월성화덕피자의 TourAPI 대표메뉴
  **"반월성 불고기"**(피자 이름)에 부분문자열 매칭(`고기`⊂`불고기`). cuisine_tags=None 이라
  분류 게이트도 미작동. 수정: 우산 토큰(`고기`·`육류`)은 자유 텍스트(name/menu) 금지,
  분류 태그(cuisine/category)에만 매칭(`_TAG_ONLY_TOKENS`, embedding_service.py). 테스트 3건 추가.
- DB 실측 참고: 식당 43곳 중 삼겹살 전문점 0(갈비·숯불구이 계열 8곳) — '삼겹살' 발화는 이제
  구이 계열 매칭 또는 정직한 0건 응답. 근본 해소는 장소 밀도 확충(KAKAO_LOCAL_EXPANSION) 몫.
- 운영 방식: 이 수정부터 진단(Fable)→구현·검증(서브에이전트) 분업 적용(PM 지시 — AI_OPS 관례).

### 음성 filter 에 Solar 최종 선택권 부여 (PM "Solar가 이거밖에 안돼?" 후속)

- 구조 원인: Solar 는 후보 name/cuisine/menu 를 프롬프트로 받으면서도 `_llm_interpret` 가
  `match_ids: []` 고정 — 선택 질문 자체를 받지 않았고, 최종 선택은 로컬 부분문자열 매처 몫이었다.
- 개선: 기존 filter LLM 호출(추가 비용 0)에 `match_names` 스키마 추가 — Solar 가 cuisine·menu
  근거로 "실제로 파는 곳"만 선택(글자 겹침 매칭 금지 지시, '불고기 피자' 사고 사례 명시).
  라우터는 `llm_status=="llm"` 턴에서 Solar 선택을 정본으로(로컬 매처와 교집합 우선, 비면 Solar
  단독, Solar 빈 배열=정직한 0건 — 로컬 매처 폴백 없음). LLM 미개입/실패 턴은 기존 동작.
- 라이브 검증(실 Upstage): "삼겹살 먹고싶다" + 반월성화덕피자(메뉴 반월성 불고기)·숯불갈비·칼국수
  후보 → Solar match 0건(피자 거부, 갈비도 삼겹살 미판매라 거부) → "확인된 후보 없음" 정직 응답.
  pytest 468 통과(신규 6)·ruff 클린. 참고: DB에 삼겹살 전문점 0곳 — 진짜 해소는 밀도 확충 몫.

### 음성 유사 대안 제안 2턴 흐름 (PM 요구 — "갈비집은 있는데 추천해드릴까요?")

- Solar 스키마에 `similar_names` 추가(정확 매치 0건일 때만, 같은 계열·cuisine/menu 근거,
  전혀 다른 음식 금지) → `similar_ids` 화이트리스트 검증(`_coerce`, 비-filter/match 존재 시 강제 []).
- 라우터: match 0건 + similar 존재 → `VoiceTurnResponse.suggestion_id` + 서버 템플릿 spoken
  ("…후보가 없어요. 대신 비슷한 곳으로 {이름}이/가 있어요. 안내해드릴까요?" — 받침 기반 조사 확정,
  LLM spoken 미사용 원칙(P1-1) 유지). 프런트 `useVoiceAssistant`에 pendingSuggestion(1턴 한정):
  다음 턴 accept("네/좋아") → 제안 후보 select, reject/기타 → 소멸.
- 라이브 검증(실 Upstage): "삼겹살 먹고싶다" → match 0건 + suggestion=숯불갈비집,
  "…대신 비슷한 곳으로 퇴근길숯불갈비가 있어요. 안내해드릴까요?" 정상. pytest 474·web 4종 게이트 통과.

### Solar 자율권 기획 확정 + 1번(태깅 배치) 구현·적용 완료

- 기획 정본 **`docs/SOLAR_AUTONOMY_PLAN.md`** 신설(PM 지시 — 세션 재시작에도 인수인계).
  대원칙: "Solar는 심사위원이 아니라 통역사" — 적격 판정·설명은 Solar, **랭킹은 SPOT 독점**
  (공모전 방어력·재배치 목적함수·재현성). 5안 우선순위: ①태깅 ②tool-calling ③사유 사실선택
  ④다턴 슬롯필링 ⑤거절 이해. ①은 완료, 다음은 ②.
- ①구현: `apps/api/scripts/tag_cuisines.py` — Solar가 상호+공식메뉴 근거로
  `features.cuisine_tags`·`category` 결손 보충. `_INTENT_CATEGORIES` 화이트리스트 게이트 +
  **상호 조각 태그 차단**(1차 dry-run 실측 '소소밀밀 서악점'→[소소밀밀,서악점] 오태깅 → 게이트
  추가) + dry-run 기본 + `tagging_source` 출처 기록 + fill-missing only. 음성 후보에 `category`
  전달(VoiceCandidate 필드 + main/page.tsx payload) — **분류 게이트 소생**.
- 원격 적용 결과(3패스, 사전 백업 스크래치패드 features_backup_pre_tagging.json):
  **restaurant/cafe 64곳 중 59곳 태깅**(5곳은 메뉴 근거 없어 정직 skip — 십원빵 등).
  반월성화덕피자=양식(고깃집 게이트가 구조적으로 차단), 퇴근길숯불갈비=갈비집, 기존 키 무손실 검증.
- 게이트: api pytest 499 통과·ruff 클린 / web 4종 통과.

### RESUME

다음 후보: ① Phase 2(원본·코스 혼잡 기준선 predicted 대체 — score 영향 검토 필수, 신중 구역),
② KAKAO_LOCAL_EXPANSION 의 사람 확인 2건 후 구현 착수 판단, ③ P1 추천 품질 스냅샷 평가(§-20 3번).
프로덕션 Kakao SDK 키 교체 여부는 여전히 사람 확인 필요.

## -20. 2026-07-18 — 개발환경 복구 + 다음 사이클 기획 체크포인트

### 재시작 전 상태

- Python **3.11.9**를 winget(`Python.Python.3.11`)으로 시스템 설치했다.
- Python 3.11 환경에 Ruff **0.15.22**를 설치했다. 설치 직후 열린 기존 셸에서는 `py -3.11`의
  런처 캐시가 갱신되지 않았지만 직접 경로
  `C:\Users\hennr\AppData\Local\Programs\Python\Python311\python.exe`로 두 버전을 확인했다.
  **컴퓨터 재시작 후** `py -3.11 --version`과 `py -3.11 -m ruff --version`을 먼저 재확인한다.
- 잠시 시도했던 `search.py` XFF 레이트리밋 수정과 테스트는 모두 되돌렸다. 실제 코드 diff는 없다.
  apply_patch의 줄바꿈 변환 때문에 두 파일이 `git status`에서 수정으로 보일 수 있으나 `git diff`는 비어
  있었다. 재시작 후 상태를 다시 확인하고 내용 차이가 없으면 사용자 변경으로 취급하지 않는다.

### PM 결정 — 지금은 보안 부채 구현보다 기획 우선

다음 개발 사이클은 아래 순서로 기획한다. 구식 `NEXTSPOT_PIVOT.md` 체크박스를 그대로 실행하지 말고,
이 섹션과 최신 인계 섹션을 정본으로 삼는다.

1. **P0 배포 기반 정상화**: Kakao JavaScript 키·Web 도메인·Vercel 재배포를 최우선으로 확인하고,
   Render의 Upstage/KMA 환경변수와 GitHub Actions Kakao REST 키를 점검한다. 프로덕션 지도·음성·날씨·
   TourAPI 일배치 스모크 테스트까지 완료 조건으로 둔다.
2. **P1 추천 데이터 정직성 명세**: 혼잡 정보를 `실측 혼잡 / AI 예측 / 정보 준비 중`으로 구분하는
   데이터 모델·API 근거 필드·카드·지도·음성·코스 표시 규칙을 하나의 명세로 만든다. 카드 일부에는 이미
   `데이터 없음` 처리가 있으므로 중복 구현 전에 전체 소비 경로를 감사한다.
3. **P1 105개 장소 추천 품질 평가**: 대표 출발 좌표와 의도(돼지고기·조용한 카페·비 오는 날 실내 등)의
   상위 5 결과를 스냅샷으로 검증한다. 관련 없는 후보·휴무·도보권 밖·좌표 오류를 실패 사례로 모으고,
   SPOT 산식 변경 전에 후보 생성과 데이터 품질을 먼저 개선한다.
4. **P1 실증 자료 확보**: 추천 노출→수락→방문 의도→쿠폰 발급 폐루프를 검증하고 관리자 지표의 표본
   부족을 정직하게 표시한다. 합성/데모와 실측 라벨을 재점검한 뒤 `DEMO_SCENARIO.md`·`JUDGE_QA.md`를
   실제 결과에 맞춘다.
5. **P2 후보**: 다국어 STT/TTS, 추천 API 실패와 정상 0건 분리, admin 익명 세션 방지, TourAPI client
   lifespan 정리. 경주시 교통데이터와 Tmap 도보 경로는 API 가용성·쿼터·심사 가치 조사 후 결정한다.

### RESUME

재시작 후 첫 작업은 코드를 수정하는 것이 아니라 **「추천 근거 신뢰성 개선 명세」**를 작성하는 것이다.
실측/AI 예측/정보 없음의 서버 근거, UI 표시, 음성 문구, 실패 폴백, 테스트·데모 완료 조건을 확정하고
PM 검토를 받은 뒤 구현 범위를 정한다. 동시에 P0 사람 작업 중 실제 완료/미완료 상태를 짧게 확인한다.

## -19. 2026-07-17 — Kakao 좌표 72곳 적용 + 모바일 지도 우선 UI + Upstage 선호 우선 해석

- Kakao 로컬 API 활성화 후 TourAPI 시설 89곳 전수감사: **72곳 유일 매칭 적용, 17곳 애매하여 보류**.
  원 TourAPI 좌표는 `features.tourapi_coordinates`, 근거는 `coordinate_source=kakao`와 place id/url로 보존.
  내물왕릉은 807m 교정되어 Kakao 교동 14 핀(`35.8325584, 129.2173047`)과 일치하며 석하한정식·
  금산재 칼국수도 적용 후 원격 재검증 완료.
- 모바일 `/main` 상단은 검색+카테고리+`필터·편의`만 유지. 세부 음식·히트맵·배리어프리·주차·대기·
  축제·화장실을 바텀시트로 이동해 390×844 실측 상단 점유를 약 300px→190px로 축소. 데스크톱 유지.
- 음성 선호 발화는 키워드가 잡혀도 Upstage가 우선 구조화하고 실제 후보의 업종·TourAPI 공식메뉴와
  대조한다. 단순 수락/다음/중지는 결정적 규칙 유지. 매칭 0건이면 무관한 다음 식당으로 넘기지 않고
  현재 카드를 유지한다. `돼지고기 먹고 싶어` 실제 Upstage 응답 `llm_status=llm` 확인.
- **사람 작업(P0)**: Vercel의 `NEXT_PUBLIC_KAKAO_MAPS_APP_KEY`는 현재 SDK 요청이 401. REST 키가 아닌
  같은 Kakao 앱의 **JavaScript 키**로 교체 후 재배포하고 Web 도메인에
  `https://nextspot-nu.vercel.app`, `http://localhost:3000` 등록.

## -18. 2026-07-17 — 날씨 맞춤 추천 UI + Kakao 좌표 전수감사 안전장치

- 날씨를 필터 행 뒤의 작은 칩에서 검색창 바로 아래 상시 카드로 이동. 현재 기온·기상 위험을 즉시
  노출하고 펼침 시 향후 6시간 예보와 기상청 기준 시각을 표시한다(ko/en/ja/zh 동시 반영).
- 악천후일 때 사용자가 `날씨 맞춤 추천`을 명시적으로 켤 수 있다. 문화시설로 전환하고 명확한 실내
  유형(문화시설·카페·음식점)을 우선하되 기존 SPOT 점수는 변경하지 않으며 카드에 기상 조정 근거를 표시한다.
- 좌표 교정은 기존 좌표 반경 2km 검색뿐 아니라 `경주 + 장소명` 전역 검색을 병행한다. 경주시 밖은
  거절하고, 같은 근거 점수의 복수 후보는 변경하지 않는 fail-closed 정책이다.
- `reconcile_kakao_coordinates.py`는 기본 dry-run으로 바꾸고 JSON 감사 보고서를 남긴다. 실제 DB 반영은
  `--apply`를 명시해야 한다. 로컬 `KAKAO_REST_API_KEY` 값이 비어 있어 105곳 전수 실행은 아직 미실행.

## -17. 2026-07-17 — Gemini 선택적 읽기 전용 교차 검토 도입

- `apps/api/.env`의 `GEMINI_API_KEY` 설정을 확인했다(값은 출력·커밋하지 않음).
- `scripts/gemini_review.ps1` 추가: 프로세스 환경 또는 Git 제외 `.env`에서 키를 로드하고,
  Gemini CLI를 `--approval-mode plan`으로 고정해 파일 변경 없는 교차 검토만 수행한다.
- 상시 호출하지 않고 대규모 변경·데이터 신뢰성·다국어·이미지 검토 등 고위험 작업에 선택 적용한다.
  결과는 severity + file:line + 근거 형식으로 받고 Codex가 실제 코드·테스트로 재검증한다.

## -16. 2026-07-17 심야 — 장소 DB 확장 실행: 85→105곳 (황리단길 도보 회랑 3km)

PM 확정("황리단길에서 걸어서 갈 수 있는 주변까지만") 후 **원격 적재 실행 완료** — §-15 의
"적재 미실행" 문구는 이 섹션으로 대체된다.

### 실측 근거 → 3km 결정

반경별 TourAPI(12/14/39) dry-run 커브: 2.0km ≈ 69 · 2.5km 71 · **3.0km 87** · 4.0km 108.
병목은 반경이 아니라 **TourAPI 등록 밀도**다. 4km 증분은 도보권 밖 원거리 관광지뿐이라 제외.
3km 가 회랑(첨성대~동궁과월지~국립경주박물관) 전체를 덮고, 추천은 어차피 사용자 위치 기준
150m/1,500m 컷(`recommendations.py`)이라 "걸어서 갈 수 있는 것만 추천"은 코드가 보장한다.

### 실행 결과 (전부 원격 검증 완료)

- 목록 87/87 upsert(42P10 폴백 정상) + showflag 동기화 87건 · 상세 4콜/장소 전건 · 신규 순증
  **+20**(한적 관광지 10 — 왕릉·고분군·사지 계열, 카페 4, 식당 5, 문화 1) → **facilities 105행**.
- features 병합 수정(`ed690df`) 실증: 재적재 후 기존 번역 67곳 무손실 확인.
- 신규 20곳 번역: 기본→fill-missing→via-en 체인으로 **en 20/20 · ja 20/20 · zh 17/20**.
  전체 번역: **87곳 — en 87 · ja 87 · zh 86**(zh 1곳 한국어 폴백), 한글 잔존 **0**.
- 시드 중복 1쌍 해소: 시드 '동궁과 월지'(f3000000-…0003) **is_active=false**(삭제 아님, 복구 가능)
  — TourAPI 행(contentid 128526, 사진·번역 보유)만 노출. 신규 20곳은 시드 충돌 0(프로브 실측).
- 사전 백업: 적재 직전 85행 전체 덤프(스크래치패드 facilities_backup_pre_expansion.json, 세션 한정).

### 기획 이력 — Codex vs Claude 블라인드 A/B 1차(§-15 예고분 완료)

동일 브리프 병렬 기획 → Fable 합성. Codex 강점 = 운영 실행력(단계 게이트·배치 분할·쿼터 수치화·
회귀 리허설), Claude 강점 = 코드 근거 리스크 발굴(시드 중복·cron 반경 불일치·features 통째 교체
P0 는 실행 직전 Fable 검증에서 확정). 결론: 기획은 병렬 발산+합성이 기본값(AI_OPS 참고).

### 남은 리스크·백로그

- 🟠 **신규 20곳 혼잡 0.0 폴백 표시**: 로그 없는 시설을 추천 경로가 혼잡 0.0 으로 폴백해
  카드에 "여유 0%"처럼 보일 수 있다(기존 동작, 신규 유입으로 실노출 가능성 상승) —
  '혼잡 정보 준비중/AI 예측' 배지 후속 작업 필요.
- 42P10 폴백 직렬 UPDATE: 87행은 무해. 200행 이상 확장 시 전면 유니크 인덱스 마이그레이션 검토.
- 데모 회귀: 확장 후 데모 좌표 발화로 상위 5 추천·코스가 대본과 여전히 정합한지 브라우저 확인(사람).

## -15. 2026-07-17 밤 — 번역 한글 잔존 정화(57곳→0) + LLM 동작 디버그 인디케이터

### 번역 정화 (`9cfc377`) — §-14 배치의 "무해" 오판 정정

§-14 에서 "일부 고유명사 한글 잔존 무해"로 넘겼으나 PM 지적 후 전수 스캔 결과 **67곳 중 57곳
잔존**(문장 통째 미번역 다수) — 원인은 프롬프트의 '원문 괄호 병기' 허용. 조치:
① 한글 0자 지시 + 로케일별 표기 규칙(병기 금지) ② **한글 잔존 검증 게이트** — 잔존 검출 시
교정 재시도 1회, 최종 실패면 기존 오염 번역 **삭제(정화)** → 프런트 한국어 원문 폴백(정직).
LLM 자체 실패(타임아웃)와 구분해 후자는 보존 ③ `--fill-missing`(결손 로케일만 재시도, churn 0)
④ `--via-en`(en 번역을 소스로 우회 — zh 창작 상호명 잔존의 구조적 차단) ⑤ 종료 코드
0/2/1(전성공/부분실패/무갱신). Codex 감사 2회 전건 반영(P0: 정화 없인 배치 목적 미달성,
P1: 정규식 범위·성공 위장 종료코드, P2: 저장 후 카운터).

**최종 실측: 한글 잔존 0곳, en 67/67 · ja 67/67 · zh 66/67**(경주 쌈밥거리 1곳 zh 표기 불가
→ 한국어 폴백). zh 는 직번역 실패분을 en 경유로 회복(8/9) — 향후 DB 확장 시 신규 번역도
`--fill-missing --via-en` 패턴 재사용.

### LLM 동작 디버그 인디케이터 (`d388b09`) — PM 요청(개발 단계 가시성)

기능 사용 시마다 'AI(Solar) 실동작 vs 폴백'을 좌하단 토스트로 표시(4초 소멸):
- 백엔드 관찰 필드(동작 불변): 음성 `llm_status`(keyword/llm/llm_failed/gated/disabled),
  추천 항목 `reason_source`(llm/template, 캐시에 출처 저장), 실험실 `llm_status`
- 웹: `components/LlmDebugToast.tsx` + api-client 중앙 CustomEvent. 개인정보 0(상태 문자열만)
- **숨김 2법**: `LlmDebugToast.tsx` 상단 `LLM_DEBUG_DEFAULT=false` 전환(심사·공개 시, 사람 작업)
  또는 localStorage `nextspot_llm_debug='0'`(배포 없이 즉시)
- 디버그 문구는 개발용 도구라 한국어 하드코딩(4로케일 i18n 의도적 제외, 주석 명시)

게이트: pytest 429 · ruff · lint 0 에러 · tsc · 29/29 · build 32p · 스키마 파리티.
오케스트레이션: 구현 에이전트 2(백/프런트 병렬, 파일 소유권 분리) + Codex 적대 감사 2회.
참고: `225a521`(FestivalBanner 개행 표시·festival.* 4로케일 키)은 PM 직접 커밋(이 세션 산출물 아님).

### 사람 작업 (갱신)

- 🔴 **심사/공개 전**: `apps/web/components/LlmDebugToast.tsx` 의 `LLM_DEBUG_DEFAULT` → `false`.
- 🟢 브라우저 검증 추가: 기능 사용 시 좌하단 디버그 배지("🤖 Solar 응답"/"⚙️ 폴백" 등) 표시 확인,
  en/ja/zh 로케일 소개문에 한글 미노출 확인.

### TourAPI 일배치 features 보존 P0 수정 (2026-07-17 밤)

- `upsert_facilities`가 기존 행의 `features`를 통째로 교체해, 번역 배치가 쌓은
  `overview_i18n`과 Wikimedia `image_source` 등이 다음 cron에 사라질 수 있던 문제를 수정했다.
  쓰기 전 기존 `contentid, features`를 읽어 `{**기존, **신규}`로 병합하며, 기존 features 조회가
  실패하면 데이터 소실 방지를 위해 **fail-closed(0건 기록)** 한다. 신규 TourAPI 값은 기존 키보다 우선한다.
- 회귀 테스트 2건: 외부 축적 키 보존+신규 키 우선, 기존 features 조회 실패 시 쓰기 0건.
- 일배치도 확장 후보를 다시 상세화하도록 `--radius 3000`으로 맞췄다(원격 대량 적재 자체는 미실행).
- 검증: API pytest **431 passed**, Ruff 전체 clean.

### 날씨 + 인근 공중화장실 관광 편의 레이어 (2026-07-17 밤)

- **TourAPI에는 일반 지역 기상예보가 없음**을 공식 데이터 상품 기준으로 확인. 별도 기상청 단기예보
  `getVilageFcst`를 결합해 경주 황리단길의 현재 기온·강수확률을 메인 칩에 표시한다. 강수·폭염
  (33℃+)·한파(-5℃ 이하)·강풍(9m/s+)이면 `실내 추천` 신호를 함께 표시한다. 성공 30분/실패 5분
  캐시, 키 미설정·장애 시 `source=unavailable`로 칩만 숨는 무해 폴백.
- **공중화장실**은 현재 위치 3km 내 최대 15곳을 거리순 바텀시트로 제공하고 Kakao 장소 상세로
  연결한다. 행정안전부 전국 공중화장실 API는 2025-02부터 위경도 제공을 중단해 위치 기반 검색에
  직접 쓸 수 없으므로, 좌표는 기존 Kakao REST 앱 키의 장소검색을 사용한다. SPOT 추천 후보·점수와는
  분리된 편의 레이어라 추천 품질을 왜곡하지 않는다.
- 4로케일(ko/en/ja/zh) 동시 반영. 검증: API pytest **436 passed**, Ruff clean, 웹 lint 0 errors,
  typecheck, 음성 29/29, 정적 build 32페이지.
- **사람 작업**: 공공데이터포털에서 `기상청_단기예보 조회서비스(15084084)` 자동승인 활용신청 후
  Render `KMA_API_KEY` 등록. Render `KAKAO_REST_API_KEY`에도 Kakao 개발자 앱 REST API 키 등록.

### 장소 좌표 Kakao 정합화 (2026-07-17 밤)

- 사용자 신고(석하한정식·금산재 칼국수 등): TourAPI `mapx/mapy` 순서 오류는 아니나, 원본 좌표가
  Kakao의 실제 장소 핀과 어긋날 수 있음. 지도 UX의 좌표 정본을 Kakao로 확정했다.
- 이름 일치 + 도로명주소 일치 또는 150m 이내 근접 조건을 통과한 경우에만 Kakao 좌표로 교체한다.
  동점 후보가 모호하면 변경하지 않는 fail-closed 방식이다. 원래 좌표는
  `features.tourapi_coordinates`, 근거는 `coordinate_source=kakao`, `kakao_place_id/url`로 보존한다.
- `scripts/reconcile_kakao_coordinates.py`로 기존 contentid 시설을 일괄 교정하며, 이후 일배치도
  `KAKAO_REST_API_KEY`가 있으면 동일 교정을 upsert 전에 적용해 TourAPI 좌표로 되돌아가지 않는다.
- **사람 작업**: GitHub Actions Secrets에 `KAKAO_REST_API_KEY` 등록 후 TourAPI Ingest를 수동 실행.
  Render에만 등록된 시크릿은 GitHub Actions가 읽을 수 없다.

### 진행 중 — 장소 DB 확장 기획(PM 질문 "장소 부족, DB 끌어모을까?")

Codex vs Claude 블라인드 A/B 기획 진행(약속했던 방식 첫 적용). Codex A안 도착:
85→1차 150(도보권 100+)→최종 180~220 상한, 전역 570곳 일괄 비권고, 상세 호출 실측
4콜/장소(쿼터 재계산), 합성 capacity·무실측 혼잡 정직 라벨. Claude B안 대기 → 심판·종합 후
PM 확정받고 실행 예정(원격 대량 뮤테이션이므로 사전 확정 필수).

## -14. 2026-07-17 저녁 — LLM 도입(국산 Upstage Solar Pro 3) 4개 적용 지점 + 보안 하드닝

### 결정 근거 (PM 확정)

국산 LLM 우선(공모전 가점) + 비용 최소화 → **Upstage solar-pro3** (가입 $10 크레딧,
$0.15/$0.60 per MTok, 실측 지연 0.8~1.1초). solar-mini 는 JSON 신뢰성 미달로 기각.
2026 관광데이터 공모전 규정 직접 확인: 외부 AI API 제한 없음(TourAPI 필수 활용 조건은 별도 충족 중).
1차·최종 심사 10월, 시상 11월.

### 구현 (`1769f64` 어댑터+음성, `af01b4a` 적용 3종+하드닝)

**설계 원칙 = 무해 폴백**: `UPSTAGE_API_KEY` 미설정 → 전 기능 자동 비활성(네트워크 0),
어떤 실패(타임아웃/HTTP/파싱)도 None → 기존 결정적 경로 그대로. LLM 장애가 기능 장애로 승격되지 않는다.

| 적용 지점 | 파일 | 동작 |
|---|---|---|
| ① 음성 자유발화 | `voice_intent_service.py` | 키워드 분류기 **주 경로** 유지, `unknown`+후보 존재+레이트리밋 통과 시에만 LLM. 출력은 `_coerce` 재검증(action enum·후보 id 화이트리스트) |
| ② 실험실 자유텍스트 | `routers/lab.py` | `POST /lab/{id}/reason/classify` — 자유 거절 사유 → REASON_CODES 화이트리스트 분류 → 기존 `apply_reason` 재사용(학습 exactly-once). 실패 시 `{"resolved": false}` |
| ③ overview 번역 | `scripts/translate_overviews.py` | 배치로 `features.overview_i18n{en,ja,zh}` 적재. 웹 카드/waiting 이 로케일별 표시 |
| ④ 추천 사유 다듬기 | `reason_service.py` | 템플릿=사실 원천, LLM 은 문체만. `_is_honest_polish`(숫자 부분집합+시설명 보존) 실패 시 템플릿 폴백. (facility_id, 템플릿) 키 10분 캐시 |

**Codex 적대 감사 2회(음성 경로 P1×4·P2×5 / 최종 통합 P1×4·P2×1) 전건 반영 또는 근거 반박**:
LLM `spoken` 전면 폐기→서버 템플릿(TTS 인젝션 방어), 프롬프트 json.dumps 데이터 경계,
제어·bidi 문자 새니타이즈, `VoiceCandidate` 타입 강제(id 필수·길이 절단), IP 슬라이딩 윈도우
레이트리밋 5/min(XFF **마지막** 값 — 첫 값은 위조 가능), `extract_json` 단일 객체 엄격 파싱,
lifespan `aclose`, 실험실 원문·LLM 응답 본문 **로그 금지**(길이만). 게이트: pytest 401 · ruff ·
lint 0 · tsc · 29/29 · build 32p · 스키마 파리티 · i18n 550키×4.

### 번역 배치 실행 결과 (원격 실측 검증 완료)

65/65 시설 × en·ja·zh 전 성공 + ja 프롬프트 보강판(제목 줄 아티팩트 수정)으로 기존 프로브 2곳
재번역 2/2. 원격 카운트: **overview_i18n 보유 67/85**(en=ja=zh=67, overview 있는 시설 전부).
ja 샘플 검증 — 개행 없는 단일 문단, 제목 반복 없음. 소소한 잔여: 일부 고유명사가 한글로
남는 사례(예: '경상북도교육청 발명체험교육館') — 무해, 필요시 `--force --limit` 재번역.

### 사람 작업 (신규)

- 🔴 **Render 에 `UPSTAGE_API_KEY` 등록** — dashboard.render.com → nextspot-api → Environment.
  미등록이어도 무해(LLM 만 조용히 꺼짐)이나 프로덕션에서 ①②④ 가 비활성 상태.
- 🟢 브라우저 검증 추가: 음성 복합 발화("조용한 분위기면 좋겠어" → 카테고리 추천),
  실험실 자유 텍스트 입력 → 분류 확인, en/ja/zh 로케일에서 카드·waiting overview 번역 표시.

### 남은 리스크 (백로그)

- `search.py` `_client_ip` 는 여전히 XFF **첫 값**(위조 가능) — 음성 경로만 수정됨. 후속 통일 필요.
- 레이트리밋·사유 캐시는 인메모리(단일 프로세스 데모 서버 전제) — 다중 워커 전환 시 재설계.
- tourapi client 도 lifespan aclose 미적용(기존 부채, llm_client 만 정리됨).
- 실험실 학습은 at-most-once(클레임 후 적용 실패 시 유실) — 기존 리스크, 이번에 변경 없음.

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
