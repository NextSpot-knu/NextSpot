# NextSpot 적응 명세 (InduSpot 베이스 → 관광 도메인)

> 이 문서는 **검증된 InduSpot 로컬 베이스를 2026 관광데이터 활용 공모전용 NextSpot으로 재구성**하기 위한
> 단일 정본 계획서입니다. "무엇을 그대로 쓰고(재사용), 무엇을 어느 파일에서 바꾸는지(개조)"를 정리합니다.
>
> - **출처 베이스:** `NextSpot-knu/Induspot` (로컬 전용, GCP 의존성 제거 완료) 의 `main` HEAD 스냅샷.
> - **공모전 제안서 원본:** 상위 작업폴더 `../Docs/` — 특히
>   `20260505ver_…『2026 관광데이터 활용 공모전』 제안서…수정_2.pdf` (양식1, 5p)가 본 명세의 근거.
> - **상속 아키텍처 상세:** [`../architecture_overview.md`](../architecture_overview.md).

---

## 0. 한 줄 정의

포화한 관광 수요를 실시간으로 **분산·재배치**하는 AI 기반 대안 장소 추천 웹 서비스.
초기 서비스 지역은 **경주 황리단길**. 핵심 알고리즘은 **TTTV_Score**, 필수 데이터는 **TourAPI(한국관광공사 OpenAPI)**.

---

## 1. 재사용(AS-IS) vs 피벗(TO-BE) 매핑

| 축 | InduSpot (상속 베이스) | NextSpot (관광, 목표) | 작업 성격 |
| --- | --- | --- | --- |
| 대상 사용자 | 산업단지 근로자 | 관광객 | 용어/카피 교체 |
| 문제 | 피크타임 사내 인프라 혼잡 | 오버투어리즘·상권 양극화 | 기획/카피 |
| 대상 공간(POI) | 휴게실·회의실·주차장·식당 | 관광지(12)·문화시설(14)·음식점(39) | **데이터/스키마** |
| 혼잡 데이터 | IoT·CCTV(YOLO)·출입 게이트 | 경주시 교통데이터(공공데이터포털) + TourAPI `eventBasedList` | **데이터 소스** |
| POI 메타 | 자체 시드 / 카카오 스크랩 | **TourAPI** areaBased/location/detail | **데이터 소스** |
| 이동시간 | Haversine 직선거리 도보 환산 | **Tmap 도보 경로 API** | **어댑터 교체** |
| 선호 벡터 | 시설 타입/특성 8차원 | TourAPI `contentTypeId` 기반 카테고리 벡터 | 매핑 재정의 |
| 지역 | 구미국가산업단지 | 경주 황리단길 (반경 400m 고밀도) | 좌표/데이터 |
| 사업 모델 | B2B SaaS (사업주) | B2G(경북문화관광공사) + 소상공인 상권 | 대시보드 reframe |
| TTTV 가중치 | 0.45 / 0.25 / 0.30 | **0.40 / 0.40 / 0.20** (제안서) | 상수/정규화 |
| 인센티브 항 | `max(0, 원본혼잡 − 후보혼잡)` (혼잡 분산) | 제안서는 "제휴 쿠폰 0/1" — **정의 확정 필요** | 설계 결정 |

**그대로 재사용(변경 최소):** 모노레포 골격, FastAPI 라우팅/인증 골격, Supabase 접근 계층,
TTTV 산식 구조와 정규화, Next.js 앱 셸·지도·차트, 로컬 예측 모델 파이프라인(`train.py`) 형태.

---

## 2. TTTV_Score (관광 버전)

```
TTTV_Score = w₁ · (취향 일치율) − w₂ · (예측 대기시간[혼잡 반영] + 이동시간) + w₃ · (인센티브)
```

| 변수 | 가중치(제안서) | 계산 방법 | 데이터 |
| --- | --- | --- | --- |
| 취향 일치율 | w₁ = 0.40 | 사용자 선호 카테고리 벡터 × POI 벡터 코사인 유사도 | TourAPI `contentTypeId` |
| 예측 대기시간 | w₂ = 0.40 | 시간대·요일 통계 + 행사 변수 기반 회귀 예측 | 경주 교통데이터, `eventBasedList` |
| 이동시간 | (w₂에 합산) | 실시간 도보 경로 | **Tmap 도보 경로 API** |
| 인센티브 | w₃ = 0.20 | 제휴 가맹점 할인 쿠폰 제공 여부(0/1) | 파트너 |

### ⚠️ 베이스와의 차이 — 결정 필요 항목
1. **가중치:** 베이스 코드는 `W1=0.45, W2=0.25, W3=0.30` (`apps/api/app/services/tttv/score.py:9-12`).
   제안서는 `0.40/0.40/0.20`. → 상수 변경 + 정규화식(`normalized = (raw + W2)/(W1+W2+W3)`) 재검토 +
   `apps/api/tests/services/test_tttv.py` 기대값 갱신.
2. **인센티브 의미 충돌:** 베이스는 *혼잡 분산 보너스* `max(0, 원본−후보 혼잡)`.
   제안서 w₃은 *제휴 쿠폰 0/1*. 두 개념은 다르다 → **(a) 혼잡분산 유지, (b) 쿠폰으로 교체,
   (c) 둘을 분리 항으로 결합** 중 택1. 발표 일관성을 위해 제안서 기준 정렬 권장하되 실증 효과(수요 분산)는
   혼잡분산 항이 더 강하므로 결합(c) 검토.

---

## 3. 데이터 레이어 설계 (TourAPI 필수)

### 3-1. TourAPI(한국관광공사 OpenAPI) 엔드포인트

| 엔드포인트 | 용도 | TTTV 반영 |
| --- | --- | --- |
| `areaBasedList` | 경주 지역 POI 목록 → 대안 후보 DB 기초 구축 | 후보군 |
| `locationBasedList` | 사용자 현위치 반경 500m POI 실시간 조회 | 후보군(실시간) |
| `detailCommon` / `detailIntro` | 운영시간·카테고리·소개 → 후보 속성 | 취향/필터 |
| `detailInfo` (무장애) | 배리어프리 정보 → 접근성 가중치 | 가중치 |
| `eventBasedList` | 당일 경주 축제·행사 → 혼잡 예측 외부 변수 | 예측 대기 |

### 3-2. 데이터 활용 방식 (레이어 / 소스 / 주기 / 역할)

| 레이어 | 소스 | 주기 | 역할 |
| --- | --- | --- | --- |
| Static | TourAPI 국문관광정보 | 일 1회 캐싱 | 대안 POI DB, 카테고리·위치 기준값 |
| 준실시간 | 경주시 교통 CCTV AI 분석(공공데이터포털) | 일 단위 배치 | 시간대별 유동 패턴 베이스라인 |
| 실시간(행사) | TourAPI `eventBasedList` | 일 1회 + 당일 조회 | 축제·행사 시 혼잡 가중치 상향 |
| 인앱 피드백 | 추천 수락/거부 | 즉시 | 알고리즘 가중치 점진 보정 |
| 경로 | Tmap 도보 경로 API (SKT, 무료) | 호출 시 | 이동 시간(TTTV 핵심 변수) |

---

## 4. 아키텍처 적응 — 파일 단위 매핑

| 베이스 위치 | 현재(InduSpot) | NextSpot 변경 |
| --- | --- | --- |
| `apps/api/app/services/tttv/score.py` | W=0.45/0.25/0.30, 인센티브=혼잡분산 | 가중치 0.40/0.40/0.20, 인센티브 정의 확정 |
| `apps/api/app/services/tttv/preference.py` | 시설 타입/특성 → 8차원 벡터 | TourAPI `contentTypeId` → 카테고리 벡터 매핑 |
| `apps/api/app/services/tttv/travel.py` | Kakao/Haversine 도보 환산 | **Tmap 도보 경로 API 어댑터** |
| `apps/api/app/services/tttv/wait_time.py` | 시설 유형+혼잡+시각 | 관광 POI 유형 + 행사 변수 반영 |
| `apps/api/app/services/predict_service.py` | 로컬 Ridge(`model.pkl`) facility/hour/dow | 경주 교통 베이스라인 + 행사로 재학습 |
| `apps/api/scripts/train.py` | Supabase `congestion_logs` 학습 | 경주 유동/CCTV 시계열로 데이터 소스 교체 |
| `supabase/` 스키마 | `facilities`, `congestion_logs`, `users` | POI(TourAPI 스키마: contentid·contenttypeid·좌표·주소·운영시간·무장애), 거점 혼잡 시계열 |
| `apps/web` 사용자 앱 | worker/recommend·main·saved·mypage·setup | 관광객 앱으로 카피/플로우 reframe |
| `apps/web` 관리자 | 공단 수요 분산 대시보드 | 경북문화관광공사 혼잡 관리 대시보드(B2G) |
| 브랜딩 | `InduSpot` 63건/32파일 | `NextSpot`으로 일괄 교체(UI 카피 포함) |

### 신규 추가가 필요한 모듈
- `apps/api/app/services/tourapi/` — TourAPI 클라이언트(areaBased/location/detail/event), 일배치 캐시.
- `apps/api/app/services/tmap/` — Tmap 도보 경로 호출 + 캐시(`travel.py`가 의존).
- `apps/api/scripts/ingest_tourapi.py` — 경주 POI 일배치 적재(기존 `scripts/seed*.js` 패턴 참고).

---

## 5. 개조 백로그 (체크리스트)

**P0 — 정체성/구동**
- [x] 패키지명·README·아키텍처 배너·에이전트 가이드 NextSpot 전환 (시드 커밋)
- [ ] UI/코드 내 `InduSpot`→`NextSpot` 잔여 브랜딩 일괄 교체 (63건/32파일)
- [ ] `apps/web/app/layout.tsx` 메타데이터(title/description) 교체
- [ ] 환경변수 키 정리(`.env.example`): TourAPI 키, Tmap 키, 경주 좌표 기준값

**P1 — 데이터 파이프라인**
- [ ] TourAPI 클라이언트(`services/tourapi/`) + 일배치 캐시
- [ ] 경주 황리단길 POI 적재 스크립트(`ingest_tourapi.py`) — 관광지12·문화시설14·음식점39
- [ ] Supabase 스키마: `facilities`→`pois`(TourAPI 필드) 마이그레이션
- [ ] 경주시 교통데이터(공공데이터포털) 연동 → 시간대별 유동 베이스라인

**P2 — 알고리즘**
- [ ] TTTV 가중치 0.40/0.40/0.20 적용 + 정규화 재검토 + 테스트 갱신
- [ ] 인센티브 항 정의 확정(혼잡분산 / 쿠폰 / 결합)
- [ ] `preference.py` 카테고리 벡터를 `contentTypeId` 기준으로 재정의
- [ ] `travel.py` → Tmap 도보 경로 어댑터
- [ ] 행사(`eventBasedList`) 변수로 도착시점 혼잡 예측 보정

**P3 — 화면/실증**
- [ ] 사용자 앱 플로우 reframe(온보딩 선호 카테고리 3개+ → 취향 벡터 / 추천 사유 카드)
- [ ] 혼잡도 예측 지도(Predictive Crowd Map) — 황리단길 거점 히트맵
- [ ] 관리자 대시보드를 경북문화관광공사 B2G 관제로 reframe
- [ ] 목표 지표 계측: 추천 수락률 50%+, 온보딩 완료율 80%+

---

## 6. 산업(InduSpot) 잔재 — 제거/교체 대상

> 원본은 `NextSpot-knu/Induspot`에 보존돼 있으므로, NextSpot에서는 안전하게 정리 가능.
> (현 시드 커밋에는 **참고용으로 유지**했으며, 도메인 빌드 시 교체/삭제 권장.)

- `Gumi kakao restaurant.py` (루트) — 구미 식당 카카오 스크래퍼(일회성)
- `samples/gumi_*.csv`, `samples/facility_enrichment.json`, `samples/dummy.csv` — 구미 산업 데이터
- `docs/FACILITY_ENRICHMENT.md` — 산업 시설 정본화 문서
- `scratch/convert_gumi.py`, `scratch/upload_*` — 구미 데이터 업로드 도구
- `scripts/fetch_ev_chargers.py`, `scripts/enrich_facilities.js`, `scripts/update_coords.js` — 산업 POI 도구(TourAPI 적재로 대체)

---

## 7. 차별성 (제안서)

| 항목 | 구글/네이버 지도 | 테이블링 | **NextSpot** |
| --- | --- | --- | --- |
| 정보 유형 | 현재 혼잡/인기도 | 개별 식당 웨이팅 | **미래 도착시점 혼잡 예측 + 대안 제시** |
| 대안 제시 | ✕ | ✕ | **최소 기회비용 대안 추천(핵심 차별점)** |
| 최적화 기준 | 광고·거리·평점 | 대기팀 수 | **TTTV_Score** |
| TourAPI 연동 | ✕ | ✕ | **POI DB 적극 활용** |
| 수요 재배치 | ✕ | ✕ | **O** |

---

## 8. 제약·필수 사항

- **한국관광공사 OpenAPI(TourAPI) 활용은 공모전 필수 요건.**
- 제안서 양식: 5p 이내 / PDF 10MB 미만 (제출물 기준 — 코드와 별개).
- 개인정보: 사용자 위치/이동 데이터 최소수집·익명화(PIPA 준수 방향 유지).

---

_본 문서는 살아있는 계획서입니다. 결정이 확정되면 해당 섹션을 갱신하고, 백로그 체크박스를 진행 상태로 반영하세요._
