# 경주 황리단길 데이터 이관 & InduSpot 잔재 제거 — 실행계획

> 구미(산업단지) 더미 데이터를 경주 황리단길(관광) 데이터로 전면 교체하고, 모의 위치를 수정하며,
> **InduSpot/산업 도메인 잔재를 0으로** 만드는 정비의 단일 실행 체크리스트.
> 검증된 TTTV 엔진·모노레포 아키텍처는 보존한다. 4개 차원 전수 조사(좌표/데이터/도메인/브랜딩) 결과에 근거.

---

## 0. 설계 원칙 & 핵심 리스크

- **카테고리 4종 유지 → 8차원 선호 벡터 불변.** 현재 `[0.0]*8`·`len==8`이 백/프론트 ~10곳에 박혀 있다(load-bearing). 산업 4타입(식당/주차장/회의실/휴게실)을 **관광 4타입으로 1:1 치환**하면 차원 수를 안 건드리고 값/의미만 바꿔 리스크가 최소화된다.
- ⚠️ **ML 재학습 함정.** 타입을 바꾸면 `normalize_facility_type`(predict_service.py + train.py **2벌**, 동기화 필수)과 `model.pkl`이 옛 버킷(`cafeteria/parking/meeting_room/loading_dock`)에 묶여 추론이 조용히 `0.5`로 깨진다. **반드시 재시드 → normalize 갱신 → `train.py` 재학습** 순서.
- ⚠️ **하드코딩 라이브 Supabase URL** `xdwnwrthrgflbzpvkouq.supabase.co`가 JS 시더 4곳에 폴백으로 박힘 → 스크럽.
- **매직 상수 `36.1198, 128.3471`** 이 코드 5파일 + SQL 시드의 기본 중심/지오펜스 폴백. 이걸 황리단길 중심으로 일괄 치환이 좌표 작업의 핵심.
- **storage key `induspot_*` 변경 시** 로컬 북마크/온보딩이 리셋됨 → 실사용자 없으므로 무방(주의만).
- **반경 150m는 유지**(제안서 "반경 150m 내 대안" 과 일치 — 구미 잔재 아님). `_MAX_RECO_DISTANCE_M=1500`만 도심 밀집도에 맞춰 선택적 재튜닝.

---

## 1. 선결 결정사항 — ✅ 확정 (2026-06-30)

> **확정:** D1 **신규 Supabase 프로젝트** · D2 **음식점·카페·관광지·문화시설(4종)** · D3 **수기 큐레이션 황리단길 시드**(TourAPI는 후속 P1) · D4 **`app/worker/`→`app/explore/` 리네임**. 아래 표의 "권장"이 모두 채택됨.

| # | 결정 | 권장(=확정) | 영향 |
|---|---|---|---|
| **D1** | Supabase 프로젝트 | **신규 프로젝트(클린)** | 신규면 `init.sql`/`seed.sql`을 관광-네이티브로 **재작성**(잔재 0). 재사용이면 ALTER 마이그레이션 추가 + 기존 구미 데이터 wipe |
| **D2** | 카테고리 세트 | **음식점·카페·관광지·문화시설** (4종) | 8차원 벡터 불변. TourAPI contentTypeId 39/39/12/14 정렬 |
| **D3** | 경주 데이터 출처 | **수기 큐레이션 황리단길 시드(즉시)** + TourAPI는 후속(P1) | 이번 패스는 더미 제거+경주 시드까지. 라이브 TourAPI 연동은 별도 |
| **D4** | `app/worker/` 라우트 | **`app/explore/`로 리네임** | 참조 4곳만 수정(아래) |

---

## 2. 경주 황리단길 기준값 (실행 시 지도/TourAPI로 좌표 최종 검증)

- **중심좌표(매직 상수 대체):** 황남동 황리단길 ≈ **35.838, 129.210** *(검증 필요)*
- **도보권 bbox(≈400m, isWithinGyeongju):** lat **35.832–35.844**, lng **129.203–129.217** *(검증 필요)*
- **6개 데모 프리셋 위치**(main/page.tsx:1205-1210 대체): 황리단길 입구 / 대릉원 정문 / 첨성대 / 동궁과 월지 / 황남빵 본점 / 교촌마을 *(좌표 검증)*
- **랜드마크 9개**(landmarks.ts 대체): 대릉원·첨성대·동궁과 월지·월정교·황리단길·황남빵본점·교촌마을·경주역·국립경주박물관 *(좌표 검증)*
- **시드 POI(구미 14개 대체):** 황리단길 반경 ~15–25곳, 4카테고리 분포 *(이름·좌표·운영시간 검증)*
  - 음식점(restaurant, contentTypeId 39): 국밥·한식·고기 등
  - 카페(cafe): 황리단길 감성 카페 다수
  - 관광지(attraction, 12): 대릉원·첨성대·동궁과 월지·월정교
  - 문화시설(culture, 14): 국립경주박물관·경주 문화시설

> 좌표는 **사실로 단정하지 말고** 실행 시 카카오/TourAPI로 확정한다.

---

## 3. 카테고리·벡터 리맵 (D2 권장안)

| 구(舊) 산업 타입 | 신(新) 관광 타입 | TourAPI | 비고 |
|---|---|---|---|
| cafeteria 식당 | `restaurant` 음식점 | 39 | cuisine/메뉴 로직 재사용 |
| parking 주차장 | `cafe` 카페 | 39 | 황리단길 핵심 |
| meeting_room 회의실 | `attraction` 관광지 | 12 | 예약 UI 제거 |
| rest_area 휴게실 | `culture` 문화시설 | 14 | 안마의자/수면캡슐 features 제거 |

**8차원 벡터(권장 재정의):** dim0–3 = 4타입 원핫. dim4–7 = 관광 편의축:
- dim4 **맛/평점**(restaurant·cafe), dim5 **감성/인스타**(cafe), dim6 **접근성/무장애**(TourAPI detailInfo 무장애 → 제안서 배리어프리 가중치), dim7 **한적함**(오버투어리즘 분산 축).
- `preference.py:71-74` feature boost 재정의: `has_ev_charger&&parking` / `has_vegetarian&&cafeteria` → 예: `barrier_free&&*`(dim6), `high_rating&&restaurant/cafe`(dim4).

---

## 4. Phase 1 — 데이터 정비 (더미 제거 + 경주 재시드)

**즉시 삭제(로더 없는 고아 / 산업 일회성):**
- `samples/dummy.csv`, `samples/gumi_facilities.csv` *(활성 로더 없음)*
- `samples/gumi_parking.csv`, `samples/gumi_parking_private.csv`, `samples/gumi_restaurants_grouped.csv`, `samples/facility_enrichment.json`
- `Gumi kakao restaurant.py`(루트), `scripts/update_coords.js`, `scripts/fetch_ev_chargers.py`
- `scratch/` 전체(convert_gumi·upload_restaurants·upload_parking·generate_logs·shrink_restaurants·check_db·query_db) — 산업 일회성 throwaway
- `apps/web/scripts/seed.js` — 낡은 중복(gym/office + 대기업 mock 유저)
- `docs/FACILITY_ENRICHMENT.md` — 구미 시설 정본화 문서

**유지·재타깃(로직 재사용):**
- `scripts/seed.js` — 혼잡로그/추천/피드백 생성기. 산업 피크 패턴 → 관광 패턴(점심·오후·주말 피크)으로 교체. **하드코딩 URL 제거.**
- `scripts/seed_parking.js`, `scripts/enrich_facilities.js` — 경주 입력으로 재타깃 또는 통합. **하드코딩 URL 제거.**
- `apps/api/scripts/train.py` — 소비자(재시드 후 재학습).

**신규:**
- `samples/gyeongju_pois.(csv|json)` — 큐레이션 황리단길 POI(§2).
- DB 시드: §6 참조.

**하드코딩 Supabase URL 스크럽:** `scripts/seed.js`, `scripts/seed_parking.js`, `scripts/enrich_facilities.js`, `apps/web/scripts/seed.js`(삭제로 해소).

---

## 5. Phase 2 — 좌표 & 모의 위치 (매직 상수 일괄 치환)

| 파일 | 라인 | 현재 → 변경 |
|---|---|---|
| `apps/web/components/map/CongestionMap.tsx` | 74-77 | 시뮬 bbox(구미) → 황리단길 bbox |
| | 92, 188-189, 399 | mock/폴백 user loc `36.1198,128.3471` → 황리단길 중심 |
| | 144, 149, 160 | Kakao 기본 중심/줌(level 4)/clusterer minLevel — 황리단길 중심 + 줌 재검토 |
| | 186 | `isWithinGumi` geofence → `isWithinGyeongju` + bbox |
| | 451 | 라벨 "GUMI INDUSTRIAL COMPLEX SEED CLUSTER" → 경주 |
| `apps/web/app/main/page.tsx` | 141-142 | `companyLat/Lng 36.109031/128.388471` → 황리단길 거점 |
| | 276, 307-311 | 기본 user loc + geofence + 폴백 |
| | 857-859 | 지도 init 중심/줌 |
| | 862-864, 894 | sessionStorage `induspot_map_*` → `nextspot_map_*`(중심 stale 방지 위해 키 변경) |
| | 1205-1210 | 6개 데모 프리셋(구미) → 황리단길 6곳(§2) |
| `apps/web/app/worker/recommend/page.tsx` | 162-163, 326-330 | 기본 lat/lng + geofence + 폴백 |
| | 343-477 | `MOCK_SEED_FACILITIES`(구미 12) → 황리단길 mock |
| `apps/web/app/worker/map/page.tsx` | 21-154 | `MOCK_SEED_FACILITIES`(구미 12) → 황리단길 mock |
| `apps/web/lib/landmarks.ts` | 12-22 | 구미 랜드마크 9 → 경주 랜드마크(§2) |
| `apps/web/components/RecommendationCard.tsx` | 93,126 / 106-124 | 폴백 주소 `경상북도 구미시 산단로` → 경주 / Kakao geocode `'구미'` 필터 → `'경주'` |
| `apps/web/components/admin/FacilityTable.tsx` | 106 | 신규 시설 기본 좌표(구미) → 황리단길 |
| `apps/api/tests/services/test_tttv.py` | 41,45,59-60,72-73 | 테스트 좌표(구미) → 경주 |
| (선택) `apps/api/app/routers/recommendations.py` | 255 | `_MAX_RECO_DISTANCE_M=1500` 재튜닝 — **150m(L124/136/139)는 유지** |
| (선택) `apps/web/lib/recommender.ts` | 107 | `MAX_RECO_DISTANCE_M=1500` 재튜닝 |

---

## 6. Phase 3 — 도메인 리모델 (타입 / 벡터 / 스키마 / ML)

**DB 스키마 (D1=신규면 `init.sql` 재작성, 재사용이면 ALTER 마이그레이션):**
- `facilities.type` CHECK `('cafeteria','parking','meeting_room','rest_area')` → `('restaurant','cafe','attraction','culture')` *(init.sql:23)*
- `congestion_logs.source` CHECK `('iot_sensor','cctv','access_card')` → 관광 소스 `('traffic_cctv','tour_api','event','user_report')` *(init.sql:40)*
- `users` *(init.sql:10-14)*: `employee_id`·`company_name` NOT NULL 완화(nullable/옵션), `work_shift CHECK(morning/afternoon/night)` → 방문 시간대 선호로 교체 또는 제거, `role CHECK('worker','admin')` → `('tourist','admin')`
- `facilities.capacity NOT NULL` **유지**(수용 추정치로 재해석 — current_count 산식 보존)
- `supabase/migrations/20250523120002_seed.sql` 재작성: 구미 14시설+산업 패턴 → 황리단길 POI + 관광 혼잡 패턴(점심/오후/주말·축제)
- `supabase/migrations/20250523130000_rename_loading_dock_to_rest_area.sql` 제거(또는 신규에선 미생성)

**loading_dock 완전 퇴역(ML 버킷 포함):** `predict_service.py:37-50`, `train.py:21-33`(2벌 동기), `preference.py:11-12`, `wait_time.py:9`, `preference_nlp_service.py:20`, `infrastructures.py:163`, `recommender.ts:19,176`, `utils.ts:53`, `main/page.tsx:262`, `admin/dashboard:74,89`, `admin/infrastructure:98`, `CongestionMap:27,365`, `worker/recommend:527`.

**타입 딕셔너리·소비자(4타입 동시 정렬):**
- Python: `CATEGORY_VECTORS`(preference.py:6-13), `DEFAULT_PROCESSING_TIMES`(wait_time.py:4-10), `normalize_facility_type`(predict_service.py:37-50 + train.py:21-33), `VALID_CATEGORIES`/`CATEGORY_KO`/키워드(preference_nlp_service.py:21-53), `_VOICE_TYPE_KO`(recommendations.py:384)
- TS: `CATEGORY_VECTORS`+`defaultTimes`(recommender.ts:14-20,171-177), `types.ts`, inline union(worker/map:10), `packages/shared-types/index.ts`(死 코드 — 갱신 또는 삭제)
- `wait_time.py:36-41`(+score.py·recommender.ts:184): **7시/15시 "교대" 피크 제거** → 관광 피크(점심·오후)

**선호 벡터:** dim4-7 의미 재정의 + feature boost 재작성(§3).

**ML:** 재시드 후 `python apps/api/scripts/train.py` 재학습 → `model.pkl` 갱신. *(존재하지 않는 `seed_facility_embeddings.py` 참조는 무시)*

**타입 특화 UI(산업 개념 제거):**
- `RecommendationCard.tsx`: `meeting_room` 예약 패널(299-313,504,575) 제거, `rest_area` 안마의자/수면캡슐/PS 패널(394-419) → 관광 정보(시그니처 메뉴/관광 소개)로 교체
- `main/page.tsx:787-805`: parking EV/사내/공개 로직 → 관광 features
- `utils.ts:3-55`: 마커 아이콘 타입 분기 갱신
- admin 타입 리스트/라벨: `FacilityTable.tsx:20-28`, `DashboardCharts.tsx:82-90`, `admin/infrastructure:16,93-100`, `admin/dashboard:89-94`, `admin/reports:19-22,43`

---

## 7. Phase 4 — 브랜딩 & 산업 카피 잔재 제거

**InduSpot → NextSpot (사용자 노출):** `layout.tsx:14`(title), `page.tsx:41`, `mypage:104`, `mypage:42`(@induspot.global), `saved:129`, `VoiceAssistantOrb:60`, `AdminSidebar:30`, `admin/login:65`, `CongestionMap:503`, `RecommendationCard:279`, `TTTVSimulator:205`, `worker/recommend:1271,1499,1595`.

**산업 카피 → 관광 (사용자 노출):** `page.tsx:44`·`layout:15`("공단 생활"→관광), `setup:148-176`(주간조/야간조·주차구역 → 관광 온보딩: 선호 카테고리 3개+·방문 시간대), `admin/login:68`(공단), `admin/simulator:18`(관제소), `DashboardCharts:22`(수요 분산), `TTTVSimulator:137`, `FacilityTable:89`, `admin/reports:303,19,43`, `admin/infrastructure:241,295,467`, `admin/settings:212`, `admin/dashboard:90-94`(하역장 mock), `mypage/support:115`, `mypage:43`(Senior Operator), `worker/recommend:756`.

**config/build/deploy (내부):** `docker-compose.yml:7,20`(container `induspot-api`→`nextspot-api`, token), `run_local.ps1:1`, `LOCAL_RUN.md:3,19,89`, `apps/api/.env.example`, `apps/web/.env.example`, `config.py:9,23`(PROJECT_NAME, ADMIN_API_TOKEN), `main.py:13`(OpenAPI desc), `Dockerfile:1`, `requirements.txt:1`, `apps/api/README.md:1`, `apps/web/README.md:1,3,15`.

**storage key `induspot_*` → `nextspot_*` (프론트+백+compose+docs 동시):** `admin-auth.ts:12,14`(+token `induspot-admin-local`→`nextspot-admin-local`), `main/page.tsx`(다수 키), `saved:61,93,103,306`, `setup:30`, CSV명 `admin/dashboard:448`·`admin/reports:220`, `voiceIntent.ts:65`(주석).

**worker 식별자/라우트:**
- `app/worker/` → `app/explore/` 리네임. 참조 4곳: `CongestionMap.tsx:7`(import), `CongestionMap.tsx:374`(`/worker/recommend` 링크), `worker/recommend:1266`(`router.push("/worker/map")`), 컴포넌트명 `WorkerMapPage`(worker/map:156).
- mock `IT-WORKER-01`: `worker/recommend:286-287`, `api-client.ts:150,186` → 관광 mock(예: `GYEONGJU-VISITOR-01`).
- `users.role 'worker'` → `'tourist'`(seed.sql:11 샘플 포함).

**근로자/회의실 주석·문구(내부):** `setup:14,19,156,160`, `api-client:211,173`, `recommender.ts:4`, `preferences.py:4,32,38`, `preference_nlp_service.py:4,19,25,43`, `add_preference_note.sql:1,5`, `RecommendationCard:393`, `scripts/seed.js:59,78`, `preference.py:5`, RLS 주석(`rls.sql:33,85`, `add_user_preference_vectors.sql:3`).

**유지(의도된 heritage / 정당):** `README.md`·`AGENTS.md`·`architecture_overview.md`·`docs/NEXTSPOT_PIVOT.md`의 "베이스: InduSpot" 계승 서술(사실), `fetch_ev_chargers.py`의 "한국환경공단"(API 출처명 — 단 파일 자체는 삭제). 단, 이 문서들이 NextSpot을 산업 제품으로 *서술*하는 부분은 정리.

---

## 8. Phase 5 — 검증 (적대적)

1. `apps/api/tests/services/test_tttv.py` 갱신 후 `pytest apps/api`.
2. `npm run build --workspace=apps/web` (정적 빌드 통과).
3. `run_local.ps1` 구동 스모크: 지도가 황리단길 중심 / 추천이 경주 POI 산출 / 음성·관리자 정상.
4. **잔재 0 grep 스위프**(heritage 문서 제외): `induspot|InduSpot|구미|Gumi|근로자|worker(식별자)|공단|산업단지|회의실|휴게실|하역장|loading_dock|work_shift|주간조|야간조` = 0.
5. 좌표 grep: `36\.1\d|128\.3\d` 잔존 0(경주 35.8x/129.2x만).
6. ML: `model.pkl` 재학습 확인(신규 타입 버킷 추론 정상, 0.5 폴백 아님).

---

## 9. 실행 순서 (의존성)

```
D1~D4 확정
  └─ Phase 1 데이터 정비(삭제·URL 스크럽·경주 시드 작성)
       └─ Phase 3 스키마/타입/벡터 리모델  ─┐
       └─ Phase 2 좌표·모의위치              │(병행 가능)
                                             └─ ML 재학습(train.py) ← 재시드+normalize 갱신 후
  └─ Phase 4 브랜딩·카피(전 구간 병행 가능)
       └─ Phase 5 검증(잔재 0 grep + 빌드 + 스모크 + 재학습 확인)
```

---

_본 계획은 실행 체크리스트다. 단계 완료 시 항목을 갱신하고, 결정(D1~D4) 확정값을 §1에 반영한다._
