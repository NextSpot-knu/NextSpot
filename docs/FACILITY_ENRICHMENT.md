# 시설 대표메뉴·주소 정본(facility_enrichment) 런북

## 배경: 무엇이 문제였나
- **대표메뉴가 식당별이 아니라 카테고리별**이었다. `apps/api/scripts/seed_facility_embeddings.py` 의
  `_resolve_category()` 가 분류(양식/일식/중식…)마다 메뉴 한 줄을 부여 → **같은 분류 식당은 전부 동일 메뉴**.
  그래서 `피자헛 구미시청점`(양식)과 `제이미버거하우스`(양식)가 **똑같은 대표메뉴**를 보였고, 구버전 시드에선
  `일식` 기본값(`초밥 사시미 라멘 돈까스 우동 회`)의 **"돈까스"** 가 엉뚱한 식당에 표시되기도 했다.
- **주소가 전부 "구미시 산단로"** 로 보였다. `apps/web/components/RecommendationCard.tsx` 가
  `features.address` 가 없으면 하드코딩 `'경상북도 구미시 산단로'` 로 폴백했기 때문(+ Kakao 키 미설정 시 폴백 고정).

## 정본 데이터: `samples/facility_enrichment.json`
카카오 수집 식당 103개 + 일반시설 40개 = **143곳**에 대해, 식당별 **실제 대표메뉴 + 실제 도로명주소 + 전화**를
웹검색(카카오맵/네이버/다이닝코드/식신 등) + 적대적 검증으로 채운 정본. 각 레코드:

```json
{ "name", "source", "type",
  "signature_menu",      // 그 가게 고유 대표메뉴(공백 구분). parking/meeting_room/rest_area 는 null
  "menu_source",         // web | inferred | none
  "address",             // 실제 도로명주소(web) 또는 좌표+상호접미사 기반 동(洞) 추정(inferred)
  "address_source",      // web | inferred
  "phone", "dong", "confidence" }
```

원칙: **번지 날조 금지**. 웹으로 못 찾은 곳은 좌표·상호접미사(상모점/송정점/공단점…)로 **동 단위까지만** 추정하고
`address_source:"inferred"`, `confidence:"low/medium"` 로 정직하게 표기. (현황: 도로명 web 72곳 / 동단위 inferred 71곳,
대표메뉴 web 65곳, high confidence 49곳.)

두 시드 CSV(`samples/gumi_restaurants_grouped.csv`, `samples/gumi_facilities.csv`)의 `features` 에도 동일하게
`address/phone/signature_menu/address_source/menu_source` 가 병합돼 있다(기존 `cuisine_tags` 등은 보존).

## 라이브 반영 절차
이 환경엔 `.env`/gcloud 가 없어 직접 실행 불가 → **사용자가 레포 루트에서 실행**한다.

### 1) Supabase facilities.features 갱신 (주소가 즉시 카드에 반영됨)
```bash
node --env-file=.env.local scripts/enrich_facilities.js --dry-run   # 미리보기(매칭/미매칭 확인)
node --env-file=.env.local scripts/enrich_facilities.js             # 실제 병합
```
- 매칭은 **상호명(name) 정확 일치**(카카오 CSV 의 id 는 null 이라). 미매칭이 있으면 콘솔에 나열된다(라이브 표기 차이).
- `features` 의 기존 키는 보존하고 `address/phone/signature_menu` 만 set/갱신(멱등 — 여러 번 돌려도 안전).
- **재배포 불필요**: `RecommendationCard` 가 `features.address` 를 바로 읽는다(Kakao 키가 있으면 Kakao 실주소가 우선).

### 2) 음성비서 대표메뉴 반영 (선택 — 음성 상세답변/필터용)
```bash
# apps/api 에서 (ADC + Supabase 키 필요, EMBEDDING_ENABLED=true 인 환경)
.venv/Scripts/python.exe scripts/seed_facility_embeddings.py
```
- 시드 스크립트가 이제 **`features.signature_menu`(식당별)를 카테고리 기본 메뉴보다 우선**해서 Firestore
  `facility_embeddings.menu` 에 기록한다 → `enrich_voice_candidates` 가 음성비서에 그 메뉴를 공급.
- 반영은 백엔드 재배포(또는 인스턴스 교체) 후. `--dry-run` 으로 프로필만 미리보기 가능.

## 데이터 재생성(필요 시)
`samples/facility_enrichment.json` 은 2단계 멀티에이전트 워크플로(웹검색 보강 → 적대적 검증 → 식당간 동일메뉴 충돌
제거)로 생성됐다. 입력은 두 시드 CSV(143곳). 재생성 시 동일 절차로 갱신하면 된다(식당간 동일-메뉴 충돌 0 확인).
