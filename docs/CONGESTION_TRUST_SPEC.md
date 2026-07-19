# 추천 근거 신뢰성 개선 명세 — 혼잡 3단계 표시 (2026-07-18 확정 · Phase 1 구현 완료)

> HANDOVER §-20 RESUME 산출물. 2026-07-18 PM 결정 4건(§9) 반영 후 Phase 1 구현 완료.
> 근거: 2026-07-18 혼잡 데이터 전 경로 전수 감사(생산→전달→표시, file:line 포함 — 본 문서 §6).

## 1. 문제 정의

혼잡값의 원천은 두 갈래 — `congestion_logs` 최신 실측(실측·제보·시드·시뮬)과 sklearn AI 예측
(`predict_service.predict_congestion`, 미학습 시 0.5) — 인데, 소비 경로별 정직성이 갈린다.

- **지도 경로는 이미 정직하다**: 로그 없는 시설은 `null` 유지 → 회색 마커(`lib/utils.ts:31`),
  히트맵 제외(`main/page.tsx:1467`), 카드 `card.noData`("데이터 없음") pill
  (`RecommendationCard.tsx:382-400`). `source`·`is_stale`·`anchored` 플래그 완비.
- **추천 경로는 정직하지 않다**: 로그 없는 시설의 혼잡을 **0.0으로 폴백**
  (`recommendations.py:257, 429`)하고, 이것이 `current_count = capacity×0.0 = 0`
  (`recommendations.py:261, 431` → 카드 "잔여석 = 정원 전체")과 추천 사유 텍스트
  **"혼잡도 0%, … 여유가 있습니다"**(`reason_service.py:67, 74`)로 흘러 실측 여유처럼 보인다.
  `RecommendItem`(`recommendations.py:43-53`)에는 혼잡 출처 필드 자체가 없다.

신규 20곳(로그 0건)이 노출되면서 실사용 빈도가 올라갔고, 장소 밀도 확충(§8)을 하면 로그 없는
시설이 수백 곳으로 늘어나므로 이 명세가 확충의 **선행 조건**이다.

## 2. 서버 근거 모델 — 혼잡 3단계

추천 응답의 시설별 혼잡 근거를 아래 3단계로 정의한다.

| 단계 | 판정 규칙 | UI 기본 라벨 |
|---|---|---|
| `measured` | `congestion_logs` 최신 로그 존재 | 기존 4단계 pill + 신선도 위계(사장 확인>제보>실시간>과거 패턴) |
| `predicted` | 로그 없음 + `predict_congestion` 모델이 해당 시설 유형 학습됨 | "AI 예측" (기존 `map.forecast` 재사용) + 예측 수치 |
| `none` | 로그 없음 + 모델 미학습(0.5 평탄 폴백 상황) | "데이터 없음" (기존 `card.noData` 재사용) — 수치·잔여석 미표시 |

세부 규칙:

- `measured`의 하위 구분은 **기존 신선도 위계를 그대로 재사용**한다(`is_stale` 24h,
  `card.freshLive/freshReport/freshStale/seatConfirmed`). 신규 위계를 만들지 않는다.
- 로그 `source`가 `seed`/`simulated`인 경우: 지도 경로와 동일하게 measured로 취급하되
  가드레일(합성/실측 UI 구분)에 따라 데모 라벨을 붙일지는 **PM 결정 D-3**.
- `predicted` 판정은 `predict_service.get_model_info()`의 학습 타입 목록으로 한다.
  미학습 유형의 0.5 폴백을 "AI 예측"으로 팔면 안 된다 → 그 경우는 `none`.

## 3. API 변경 (apps/api)

### 3-1. `RecommendItem`에 혼잡 근거 필드 신설

```python
congestion_level: float | None      # measured=실측값, predicted=도착시점 예측값, none=None
congestion_source: Literal["measured", "predicted", "none"]
congestion_log_source: str | None   # measured일 때 원 로그 source(user_report/seed/…)
congestion_is_stale: bool | None    # measured일 때 24h 신선도
congestion_timestamp: str | None    # measured일 때 로그 시각
```

지도 경로의 `CongestionInfo`(`infrastructures.py:207`) 규약을 추천 응답에 이식하는 것.
기존 `reason_source` 필드(사유 텍스트가 llm/template인지)와 혼동 금지 — 별개 필드다.

### 3-2. 0.0 폴백 제거 (None 보존)

- `recommendations.py:257, 429`: `.get(id, 0.0)` → `.get(id)` — None 유지 후 하류 분기.
- `recommendations.py:261, 431`: 혼잡 미상이면 `current_count = None` (0 합성 금지).
  프런트 카드는 이미 `currentCount != null` 가드가 있어(`RecommendationCard.tsx:414`) 안전.
- ~~`courses.py:153` 기준선 동일 적용~~ → **Phase 2 로 이동(구현 중 정정)**: 코스의
  `current_congestion`은 표시가 아니라 `calculate_spot_score(original_congestion_level=…)`의
  **점수 입력**임이 확인됨(`courses.py:158-161`) — D-2 원칙(Phase 1 점수 입력 불변)에 따라
  기존 0.0 폴백 유지, Phase 2 에서 원본 혼잡과 함께 재검토.

### 3-3. 사유 텍스트 (`reason_service.py`)

- `measured`: 현행 유지("혼잡도 N%…").
- `predicted`: "예상 혼잡도 N% (AI 예측)" — 예측임을 문구에 명시.
- `none`: 혼잡 문구 **생략**. 거리·인센티브 등 나머지 근거만으로 사유 구성.

### 3-4. SPOT 점수는 건드리지 않는다 (신중 구역 회피)

- 후보 랭킹은 원래 0.0을 쓰지 않고 `predict_congestion`을 쓴다(`score.py:83-88`) — 변경 없음.
- `original_congestion_level` 0.0 폴백(`recommendations.py:248`)은 인센티브 W3 입력이므로
  **Phase 1에서는 현행 유지**(표시만 교정). predicted 대체 여부는 Phase 2에서 점수 영향
  검토 후 결정(**PM 결정 D-2**).

### 3-5. 음성 (voice)

- 프런트 `?? 0` 합성 제거(`main/page.tsx:1210`, `explore/recommend` 동일 패턴) —
  `VoiceCandidate.congestion`은 이미 `float | None`이라 스키마 변경 불필요.
- 혼잡 미상 후보는 음성 안내에서 혼잡 문구 생략(수치 언급 금지).

## 4. UI 표시 규칙 (apps/web)

| 소비 지점 | 현행 | 변경 |
|---|---|---|
| `/explore/recommend` 대안 카드 (`page.tsx:1182-1265`) | reason 문자열 그대로, dataSource 미전달 | 3단계 배지 렌더(`RecommendationCard` pill 규약 이식 또는 컴포넌트 재사용) + `congestion_*` 필드 소비 |
| `/explore/recommend` 원본 헤드라인 (`page.tsx:403`) | `latestLog ? level : 0.0` → 항상 "여유" | 로그 없으면 "현재 혼잡 정보 없음" 계열 중립 헤드라인 |
| `/main` 추천 카드 | 정직(변경 없음) | `predicted` 단계 배지만 추가 검토 |
| 지도 마커·히트맵 | 정직(변경 없음) | 없음 |
| 저장(bookmark) `main/page.tsx:1027` | `null ≥ 0.75 → false` → '한산'으로 저장 | 미상은 별도 `unknown` 상태로 저장, `saved/page.tsx:478` 역매핑에 unknown 분기 |
| 코스 | "예상 혼잡도 N%" (예측 명시, 상대적 정직) | 기준선 None 보존만(§3-2) |

i18n: "AI 예측"(`map.forecast`)·"데이터 없음"(`card.noData`) 키가 4로케일 모두 존재하므로
재사용하면 신규 키는 0~2개("정보 준비 중" 별도 문구 채택 시 — **PM 결정 D-1**). 신규 키 추가 시
ko/en/ja/zh 동시 반영, 패리티 0 missing 유지.

## 5. 공유 타입 (packages/shared-types)

- `congestion_source` enum(`'measured' | 'predicted' | 'none'`)을 shared-types에 정본화.
- 레거시 `CongestionLog` 인터페이스(`index.ts:24-31`, 실 API와 필드명 불일치) 정리는 P2 별건.

## 6. 감사 근거 요약 (수정 대상 좌표)

0.0이 실측처럼 새는 지점: `recommendations.py:248, 257, 261, 429, 431` ·
`reason_service.py:66-74` · `courses.py:153` · `explore/recommend/page.tsx:403, 1182-1265` ·
`main/page.tsx:1027, 1210`. 이미 정직한 지점(재사용): `RecommendationCard.tsx:382-400, 414` ·
`utils.ts:31` · `heatmap.ts:9-17` · `main/page.tsx:240, 311, 702-705` · `predict.py:57-59, 273-275` ·
`admin.py:367, 573` · `infrastructures.py:145, 207`.

## 7. 테스트·완료 조건

- **api**: 로그 0건 시설 추천 응답 = `congestion_source='none'` · `congestion_level=None` ·
  `current_count=None` · reason에 혼잡 수치 없음. 로그 있는 시설 = `measured` + 기존 값 유지.
  모델 학습 유형 + 로그 없음 = `predicted` + 예측값. (`tests/routers/test_recommendations.py` 확장)
- **web**: 대안 카드 3단계 렌더 분기 테스트, i18n 4로케일 패리티 0 missing.
- **회귀**: SPOT 점수·순위 불변(점수 입력 무변경 확인), 데모 대본 문구 충돌 없음
  (2026-07-18 확인: "혼잡도 0%"는 `DEMO_SCENARIO.md`·`JUDGE_QA.md`에 미등장 — 교정 안전).
- **데모**: 첨성대(로그 있음) 시나리오는 기존과 동일하게 동작해야 함.

## 8. 장소 밀도 확충과의 관계 (2026-07-18 PM 제기)

PM 관찰: 황리단길 실제 상권 대비 마커가 드문드문함. 원인은 TourAPI 등록 밀도
(반경 4km까지 늘려도 108곳 — §-16 실측). 대응 후보:

- **A안(권장): Kakao Local API 보강 적재** — 카테고리 검색(FD6 음식점·CE7 카페)으로 회랑 상권
  수백 곳 확보. 2단계: ① 지도 마커 표시 전용(추천 제외, 출처 라벨) → ② 품질 검증 후 추천 편입.
  리스크: 공모전 필수 데이터(TourAPI) 보조 소스 병기 규정 확인, 4로케일 번역 비용,
  200행 이상 시 42P10 유니크 인덱스 마이그레이션(§-16 예고).
- B안: TourAPI contentType 확장 — 증분 소폭. C안: 현행 유지 + 정직 표기.

**본 명세(3단계 표시)가 A안의 선행 조건이다** — 신규 장소는 전부 로그 0건이므로, 이 명세 없이
확충하면 "여유 0%" 오표시가 수백 곳으로 확대된다. (**PM 결정 D-4**)

## 9. PM 결정 (2026-07-18 확정)

| # | 결정 사항 | 확정 내용 |
|---|---|---|
| D-1 | `none` 단계 문구 | **신규 키 채택** — `card.congestionPreparing`("혼잡 정보 준비 중"), 4로케일 동시 추가. `card.noData`는 waiting 페이지 별건 용도로 유지 |
| D-2 | 원본 시설 혼잡 0.0 폴백의 W3 입력 처리 | **Phase 1 유지, Phase 2 검토** — 코스 기준선(`courses.py:153`)도 같은 사유로 Phase 2 |
| D-3 | `seed`/`simulated` 로그의 데모 라벨 | **표시** — `card.demoData`("데모 데이터") 라벨을 카드 혼잡 pill 옆에 병기 |
| D-4 | Kakao Local 밀도 확충 | **지금 병행 기획** — `docs/KAKAO_LOCAL_EXPANSION.md` 작성 완료(약관상 영속 저장 금지 확인 → 준수형 A-2 설계). 구현은 별도 승인 후 |

## 10. 구현 현황

- **Phase 1 — 완료(2026-07-18)**: §3-1~3-3, 3-5 서버(`recommendations.py` `reason_service.py`
  `predict_service.py:predict_congestion_detailed` 신설) + §4 프런트(explore/recommend 3단계 배지·
  중립 헤드라인, RecommendationCard D-1/D-3, bookmark `unknown`, 음성 후보 null 전송,
  `buildFallbackReason` 혼잡 미상 시 '여유' 미주장). SPOT 점수 입력 불변.
  검증: api pytest 455+ 전체 통과 · ruff 클린 · web lint/typecheck/test 29/29/build 통과 · 파리티 클린.
- **Phase 2 (미착수)**: D-2(원본·코스 혼잡 기준선 predicted 대체 — 점수 영향 검토),
  shared-types source enum 정본화·레거시 `CongestionLog` 정리, `lib/recommender.ts` 폴백 미러의
  `?? 0` 정리(WS-D 단계적 제거와 함께).
- **Phase 3 (기획 완료·구현 대기)**: D-4 — `docs/KAKAO_LOCAL_EXPANSION.md` 참조(사람 확인
  항목: 공모전 2026 요강의 보조 데이터 허용, 카카오 데브톡 캐시 정책 문의).
