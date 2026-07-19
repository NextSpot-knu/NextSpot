# Kakao Local 장소 밀도 확충(A안) 기획 — 황리단길 회랑 보강 (2026-07-18 초안, PM 검토 대기)

> `docs/CONGESTION_TRUST_SPEC.md` §8 A안·D-4의 후속 기획. **구현은 별도 승인 후**이며,
> 선행 조건은 혼잡 3단계 표시(신규 장소 = 로그 0건 → `none` 단계 "혼잡 정보 준비 중" 정직 표시).
> 배경: TourAPI locationBasedList2 적재 105곳(관광지 12·문화시설 14·음식점 39)은 카카오맵 대비
> 황리단길 실상권(수백 곳)의 일부 — 반경 4km로 늘려도 108곳(`docs/HANDOVER.md:20-21` §-16 실측).

## 0. 핵심 조사 결과 — 원안(영속 적재)은 약관 리스크가 크다

이 문서의 다른 모든 절보다 먼저 읽을 것. **조사 사실**(결정 아님):

- Kakao 데브톡 공식 답변(2026): 로컬 API 응답 데이터를 **자체 DB에 저장(백필)하는 방식은
  정책상 금지** — "API를 통해 제공하는 모든 정보는 사용자에게 제공될 때마다 매번 실시간으로
  호출하여야 한다". 근거: https://devtalk.kakao.com/t/api/150597 ,
  FAQ https://devtalk.kakao.com/t/faq-api/125610 ("실시간 호출만 가능"),
  약관·운영정책 원문 https://developers.kakao.com/terms/latest/ko/site-terms ·
  https://developers.kakao.com/terms/latest/ko/site-policies
- 단, **장소 ID(place id)와 place_url만 저장해 활용하는 방식은 공식 허용**(출처 표기 불요) —
  이름·주소·좌표는 저장하지 않고 필요 시 재호출하는 구조가 인정됨.
  근거: https://devtalk.kakao.com/t/api-id/150653
- 따라서 "Kakao 결과를 facilities 에 TourAPI 처럼 upsert" 하는 원안(이하 **A-1**)은 채택 비권장.
  본 문서는 **A-2(준수형): place_id 영속 + 실시간 프록시 표시**를 기본안으로 설계하고,
  A-1은 42P10 등 기술 논점만 기록해 둔다(§3-4). 최종 채택은 PM 결정(§8 U-1).

## 1. 목표·비목표

**목표(1단계 — 지도 표시 전용)**

- 황리단길 회랑의 음식점(FD6)·카페(CE7)를 지도에 마커로 표시해 "마커 드문드문" 문제 해소.
- 신규 장소는 전부 혼잡 로그 0건 → CONGESTION_TRUST_SPEC §2의 `none` 단계
  **"혼잡 정보 준비 중"**으로만 표시(수치·잔여석 합성 금지).
- 출처 라벨("카카오 제공")로 TourAPI 적재분·합성 데이터와 UI 구분(가드레일: 합성/실측 라벨 구분).

**비목표(1단계에서 하지 않음)**

- SPOT 추천 후보 편입 — 2단계 별도 검토(§7 Phase 4). Kakao 장소는 capacity·혼잡 근거가 없어
  W1/W3 입력이 성립하지 않고, 약관상 상세 필드 영속화도 불가해 배치 스코어링 자체가 어렵다.
- 상세페이지 무장애·운영시간 등 TourAPI 수준 enrich, 4로케일 상호명 번역(§5).
- TourAPI 좌표 정합(기존 `reconcile_kakao_coordinates.py` 경로)의 변경 — 별건.

## 2. 데이터 모델

기본안 **A-2**: facilities 를 확장하지 않고 **경량 참조 테이블**을 신설한다(약관상 저장 가능한
필드만). facilities 확장이 아닌 이유: `facilities.capacity INT NOT NULL`
(`supabase/migrations/20250523120000_init.sql:24`)이라 수용치 없는 Kakao 행은 값을 지어내야
하고, 추천 후보 SELECT 가 facilities 전체를 읽는 현 구조상 제외 플래그 실수 한 번이 곧
추천 오염이다. 구조적으로 분리하는 편이 안전.

```sql
-- supabase/migrations/2026xxxxxxxxxx_kakao_place_refs.sql (신규 — 승인 후)
CREATE TABLE IF NOT EXISTS public.kakao_place_refs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kakao_place_id VARCHAR(30) NOT NULL,           -- 약관상 저장 허용(devtalk 150653)
    kakao_place_url TEXT,                          -- 〃 (ID와 함께 보관 인정 사례)
    category_group_code VARCHAR(10) NOT NULL,      -- FD6 | CE7 (수집 시점 분류 메모)
    data_source VARCHAR(20) NOT NULL DEFAULT 'kakao',
    matched_facility_id UUID REFERENCES public.facilities(id) ON DELETE SET NULL, -- TourAPI 중복 매칭
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    last_verified_at TIMESTAMPTZ,                  -- 실시간 재호출로 실존 확인한 시각
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_kakao_place_refs_place_id
ON public.kakao_place_refs (kakao_place_id);
```

- **이름·주소·좌표·전화는 컬럼을 만들지 않는다**(저장 금지 대상). 표시 데이터는 §3의
  실시간 프록시가 매 요청 채운다.
- 마이그레이션 가드레일 준수: `supabase/migrations/` 신규 타임스탬프 파일 →
  `node scripts/build_reset.mjs` 재생성 + `scripts/build_reset.mjs` PRELUDE DROP 목록에
  `kakao_place_refs` 추가(멱등성) → 함께 커밋. `RESET_AND_SETUP.sql` 직접 수정 금지.
- **TourAPI 행과 중복 처리**: 기존 엄격 매칭 로직을 그대로 재사용한다 —
  `apps/api/app/services/kakao_coordinate_service.py:35-66` `choose_kakao_match`
  (정규화 이름 포함관계 + 도로명 키 + 150m 근접, 동점 후보 다수면 fail-closed 보류).
  1차 지름길: TourAPI 좌표 정합 배치가 이미 features 에 심어둔 `kakao_place_id`
  (`kakao_coordinate_service.py:101-107`, 72곳 적용 — `docs/HANDOVER.md:82`)와 ID 일치 시
  즉시 `matched_facility_id` 연결·마커 중복 제거. ID 미보유 행(정합 보류 17곳 등)만 유사 매칭.
- **features 보존 관례**(facilities 를 만질 경우 공통): 부분 갱신 시 반드시 `{**기존, **신규}`
  병합 — 통째 교체하면 `overview_i18n`·`image_source` 등 축적 키가 소실된다
  (`apps/api/scripts/ingest_tourapi.py:184-211`, 2026-07-17 P0 실사고 각주 참고).

## 3. 파이프라인 설계

### 3-1. 수집 경계·카테고리 (조사 사실 + 제안)

- 회랑 기준점은 기존 상수 재사용: 위 35.8361 / 경 129.2105, 반경 2,000m
  (`apps/api/scripts/ingest_tourapi.py:65-67`).
- 엔드포인트: `GET https://dapi.kakao.com/v2/local/search/category.json`,
  `category_group_code=FD6`(음식점)·`CE7`(카페), `x/y/radius`(최대 20,000m) 또는 `rect`.
  `page` 1–45, `size` 1–15, `sort` accuracy|distance.
  근거: https://developers.kakao.com/docs/latest/ko/local/dev-guide
- **페이지네이션 함정**: 문서상 `meta.pageable_count` 는 "노출 가능 문서 수(최대 45)"로
  page 1–45×size 15 이론치(675)와 병기돼 있어 쿼리당 실수집 상한은 **실측 확인 필요**.
  어느 쪽이든 단일 반경 쿼리로 회랑 전수 수집은 불가 → **rect 격자 분할**이 표준 대응:
  회랑을 소격자로 나눠 `total_count > 수집 상한`인 격자는 4분할 재귀, `is_end` 까지 페이지 순회.
- TourAPI 페이지 순회 관례(`ingest_tourapi.py:75-101` `fetch_pois`: total_count 대조 + limit
  조기 종료)를 따르되, 호출부는 `kakao_coordinate_service.py:74-93`의 httpx + `KakaoAK` 헤더 +
  `asyncio.Semaphore(5)` 패턴을 재사용한다. 키는 기존 `KAKAO_REST_API_KEY`
  (`apps/api/app/core/config.py:28`) — 신규 시크릿 없음.

### 3-2. A-2 기본안: "적재"가 아니라 "인덱싱 + 실시간 프록시"

1. **인덱싱 배치**(신규 `apps/api/scripts/index_kakao_places.py`): 격자 순회 →
   TourAPI 중복 매칭(§2) → `kakao_place_refs` 에 **place_id/url 만** upsert.
   `--dry-run` 기본(기록 없이 격자별 건수·중복 매칭 통계만 출력 — `reconcile_kakao_coordinates.py:18`
   의 dry-run 기본 + `--apply` 관례를 따른다. `ingest_tourapi.py`는 반대로 기록이 기본이니 혼동 주의).
   upsert 배치 크기는 관례대로 100(`ingest_tourapi.py:70` UPSERT_CHUNK). 완료 시 `app_events` 에
   `kakao_index_sync` 마커(freshness 관례 — `ingest_tourapi.py:439-448`).
2. **표시 프록시**(신규 API, 예 `GET /api/v1/map/kakao-places?bbox=…`): 요청 시점에 Kakao
   카테고리 검색을 **실시간 호출**해 뷰포트 내 장소(이름·좌표·place_url)를 반환. 저장하지 않는다.
   구현 선례: `apps/api/app/services/restroom_service.py:28-60`(Kakao 키워드 검색 실시간 프록시,
   키/네트워크 장애 시 빈 목록 무해 폴백) — 이 관례를 그대로 따른다.
   `kakao_place_refs` 는 응답에 조인해 `matched_facility_id`(중복 마커 억제)·`is_active` 만 보강.
3. **단기 서버 캐시(TTL 수 분)**: 뷰포트 이동마다 호출 폭증을 막고 싶지만, 캐시도 "저장"으로
   해석될 여지가 있다 — **데브톡 공식 문의 후 결정**(§8 U-2). 문의 전 기본값은 캐시 없음.

### 3-3. 쿼터 산정 (조사 사실)

- 카테고리/키워드 장소 검색 각 **일 100,000건** 무료(앱당) —
  https://developers.kakao.com/docs/ko/getting-started/quota
- 인덱싱 배치: 회랑 격자 ~50개 × 페이지 수 회 ≈ 수백 콜/일 1회 — 무해.
- 실시간 프록시: DAU × 지도 조작 횟수에 비례. 데모·심사 트래픽 규모에선 여유가 크지만,
  뷰포트 디바운스(예 500ms)와 격자 스냅으로 호출을 묶는다. 폭주 시에도 기존 지도(TourAPI
  마커)는 영향 없이 동작해야 함(프록시 실패 = 빈 목록 폴백).

### 3-4. A-1(영속 적재)을 택할 경우의 기술 논점 — 기록용

채택 비권장(§0)이나, PM이 약관 재확인 후 A-1로 갈 경우:

- facilities 에 `data_source VARCHAR DEFAULT 'tourapi'` + `kakao_place_id` 부분 유니크 인덱스
  추가, `type` CHECK('restaurant','cafe','attraction','culture' — `init.sql:21`)에 FD6→restaurant,
  CE7→cafe 매핑, `capacity` 는 추정 기본값 필요(합성값 라벨 가드레일 위배 소지).
- **42P10**: 원격 DB에서 `on_conflict=contentid` upsert 가 42P10으로 실패해 SELECT→INSERT/개별
  UPDATE 폴백으로 동작 중(`ingest_tourapi.py:176-247`, `docs/HANDOVER.md:344, 291`). 87행에선
  무해하지만 **200행 이상 확장 시 직렬 UPDATE 가 병목 — 전면(비부분) 유니크 인덱스 마이그레이션
  선행 필요**(`docs/HANDOVER.md:148` 예고). Kakao 수백 행이 바로 이 경계를 넘긴다.
- 추천 후보 제외 플래그(`data_source='kakao'` 제외)를 recommendations·courses·search 전 경로에
  강제해야 함 — A-2에선 구조적으로 불필요한 방어를 계속 지고 가는 셈.

## 4. UI 표시

| 항목 | 규칙 | 근거·재사용 지점 |
|---|---|---|
| 마커 구분 | Kakao 장소는 별도 마커 스타일 + "카카오 제공" 라벨 | 합성/실측 UI 구분 가드레일(AGENTS.md); 혼잡값 없음 → 회색 계열(`apps/web/lib/utils.ts:31` 관례) |
| 혼잡 표시 | 항상 `none` 단계 — "혼잡 정보 준비 중"(D-1 채택 문구). 수치·잔여석·히트맵 기여 금지 | CONGESTION_TRUST_SPEC §2·§4(히트맵은 이미 null 제외 — `main/page.tsx:1467`) |
| 상세 | 자체 상세페이지 없음 — `place_url` 로 Kakao 장소 상세 링크 | 공중화장실 바텀시트 선례(`docs/HANDOVER.md:204-206`) |
| 추천 제외 | 추천·코스·음성 후보에 미편입(A-2는 facilities 밖이라 구조적 보장) | §1 비목표 |
| 중복 억제 | `matched_facility_id` 있는 Kakao 장소는 TourAPI 마커만 표시 | §2 매칭 |

주의: 문구 확정 전 `docs/DEMO_SCENARIO.md`·`docs/JUDGE_QA.md` 대조(발표 대본 충돌 반려 전례).

## 5. 번역 전략 (4로케일)

- **상호명은 원문(한국어) 유지**를 원칙으로 제안: 소상공인 상호는 음역 기준이 없고 오역 리스크가
  크며, 카카오맵·구글맵도 원문 병기가 통례. A-2에선 이름을 저장하지 않으므로 번역 배치 대상
  자체가 아니다(실시간 응답을 그대로 표시).
- 신규 i18n 키는 출처 라벨 계열 1~2개("카카오 제공" 등)뿐 — ko/en/ja/zh **4로케일 동시 반영**,
  패리티 0 missing 유지(가드레일). "혼잡 정보 준비 중"은 CONGESTION_TRUST_SPEC D-1의 키를 재사용.
- TourAPI 개요 번역(`features.overview_i18n`) 파이프라인은 Kakao 장소에 적용하지 않는다.

## 6. 리스크 표 (쿼터·약관·공모전)

| # | 리스크 | 수준 | 내용·근거 | 대응 |
|---|---|---|---|---|
| R-1 | **약관: 결과 영속 저장 금지** | 높음 | 공식 답변 "매번 실시간 호출" — https://devtalk.kakao.com/t/api/150597 · https://developers.kakao.com/terms/latest/ko/site-policies | A-2 채택(place_id만 영속 — 150653 공식 허용). 캐시 TTL은 데브톡 문의(U-2) |
| R-2 | 약관: 기존 좌표 정합분의 좌표 저장 | 중간 | `reconcile_row_coordinate` 가 Kakao 좌표·place_id·url 을 features 에 저장 중(`kakao_coordinate_service.py:99-108`) — "좌표 저장"이 금지 범위에 드는지 미확인 | U-2 문의에 포함해 함께 확인(사람 작업). 확인 전 확대 금지 |
| R-3 | 공모전 규정: 보조 데이터 병행 | 낮음~중간 | 2025 요강은 "공사 TourAPI(★활용 필수), **카카오 OpenAPI** 및 기타 공공데이터API 활용" 명시(https://www.wevity.com/index_university.php?c=find&s=_university&gub=1&cidx=20&gbn=viewok&gp=2&ix=106145 등) — 카카오 병행은 관례상 허용으로 보임. **단 2026 요강 원문 미확인 → 사람 확인 필요** | 2026 요강(https://api.visitkorea.or.kr/) 해당 조항 확인 후 착수(U-3). TourAPI가 주 데이터임이 흐려지지 않게 표시 비중 유지 |
| R-4 | 쿼터 | 낮음 | 장소 검색 일 100,000건(https://developers.kakao.com/docs/ko/getting-started/quota) | §3-3 디바운스·빈 목록 폴백 |
| R-5 | 페이지네이션 상한으로 수집 누락 | 중간 | pageable_count 상한 표기(§3-1) | rect 격자 재귀 분할 + dry-run 실측으로 상한 확정 |
| R-6 | 신규 장소 "여유 0%" 오표시 | 차단됨(선행 조건) | CONGESTION_TRUST_SPEC §8 — 3단계 표시 미구현 상태로 확충 시 오표시 수백 곳 | 3단계 표시 Phase 1 완료를 착수 게이트로 |
| R-7 | 폐업 장소 잔존 | 낮음 | Kakao엔 showflag 동기화 대응물 없음 | `last_verified_at` 재검증 배치 + 실시간 프록시 특성상 검색 미노출 시 자연 소멸 |

## 7. 단계별 실행 계획·완료 조건

| Phase | 내용 | 완료 조건 |
|---|---|---|
| 0 (게이트) | CONGESTION_TRUST_SPEC Phase 1(혼잡 3단계) 구현·배포 + D-1 문구 확정 | 로그 0건 시설이 추천·지도에서 `none` 단계로 표시(테스트 통과) |
| 1 (사람 작업) | U-2 데브톡 공식 문의(캐시 TTL·좌표 저장 범위) · U-3 2026 요강 확인 · 결과를 HANDOVER '사람 작업'에 기록 | 두 답변 확보, A-1/A-2 확정(U-1) |
| 2 | 인덱싱 스크립트 dry-run: 격자 분할 실측(회랑 FD6/CE7 총량·pageable_count 상한·TourAPI 중복률) — **DB 기록 없음** | dry-run 리포트(건수·중복 통계) 산출, 상한 확정 |
| 3 | 마이그레이션(`kakao_place_refs`) + 인덱싱 `--apply` + 표시 프록시 API + 지도 마커·라벨 + i18n 키 | 검증 게이트 4종(web/api pytest/ruff/스키마 파리티) 통과 · 마커에 "카카오 제공"+"혼잡 정보 준비 중" 표시 · 추천 응답에 Kakao 장소 0건(테스트) · 데모 대본 충돌 없음 |
| 4 (2단계, 별도 승인) | 추천 편입 검토 — 약관상 배치 스코어링 불가 제약 하에서 실시간 후보 주입이 SPOT 산식(신중 구역 `score.py`)에 미치는 영향 분석 문서 선행 | 별도 명세 승인 |

## 8. 미결정 사항 (PM 결정 필요)

| # | 결정 사항 | 기본안 |
|---|---|---|
| U-1 | A-1(영속 적재) vs **A-2(place_id 인덱싱 + 실시간 프록시)** | A-2 — 약관 공식 답변(§0) 근거. A-1은 카카오 공식 서면 허용 확보 시에만 |
| U-2 | 서버 단기 캐시 TTL 허용 여부·기존 좌표 정합 저장분의 적법 범위 | 데브톡 공식 문의(사람 작업) 후 결정. 문의 전 캐시 없음·정합 확대 중단 |
| U-3 | 2026 공모전 요강의 보조 데이터 조항 원문 확인 | 사람 확인 필요 — 2025 요강 관례상 허용 추정(R-3) |
| U-4 | 표시 범위: FD6+CE7만 vs 관광 편의 카테고리 추가(AT4 관광명소 등) | 1단계는 FD6+CE7만(PM 지적의 원인 범위) |
| U-5 | 출처 라벨 문구("카카오 제공" 등)와 마커 디자인 | 데모 대본 대조 후 확정(§4 주의) |
| U-6 | 회랑 rect 경계 좌표(반경 2km 원 vs 상권 다각형 근사 rect) | 기준점+2km 외접 rect에서 시작, dry-run 실측으로 조정 |

---
*작성 근거: 저장소 조사(`ingest_tourapi.py`, `kakao_coordinate_service.py`,
`reconcile_kakao_coordinates.py`, `restroom_service.py`, `supabase/migrations/*`,
`docs/HANDOVER.md` §-16/-19, `docs/CONGESTION_TRUST_SPEC.md`) + Kakao Developers 문서·데브톡
공식 답변·공모전 공고 웹 조사(2026-07-18). 조사 사실과 제안(결정 대기)을 본문에서 구분 표기.*
