# NextSpot

> **2026 관광데이터 활용 공모전 · ① 웹·앱 개발 부문 출품작.** 경주 황리단길의 **오버투어리즘을 실시간으로 분산·재배치**하는 AI 기반 대안 장소 추천 웹 서비스입니다.

포화한 인기 관광지 대신, 사용자의 취향·예상 대기·도보 거리를 종합한 **TTTV(Total Time to Value)** 점수로 **반경 150m 내 한산한 대안 장소**를 추천하여 도심 전체의 관광 수요를 고르게 분산합니다.

---

## 🧭 이 저장소에 대하여 (중요)

이 저장소는 산업단지 혼잡 분산 플랫폼 **InduSpot**의 검증된 로컬 전용 베이스를 **시드(seed)로 복제한 뒤, 관광 도메인으로 재구성**하는 중입니다.

- ✅ **그대로 재사용:** 모노레포 아키텍처(Next.js 웹 + FastAPI + Supabase + 로컬 sklearn)와 **TTTV 추천 엔진**.
- 🔄 **관광용으로 교체 중:** 데이터 소스(IoT/CCTV → **TourAPI**·경주 교통데이터), 대상(근로자 → 관광객), 지역(구미국가산단 → **경주 황리단길**), 브랜딩.
- 📋 **적응 명세·개조 백로그:** [`docs/NEXTSPOT_PIVOT.md`](./docs/NEXTSPOT_PIVOT.md) — 무엇을 어떤 파일에서 바꿔야 하는지 정리.
- ⚠️ 시드 직후라 코드/문서에 **InduSpot·산업 도메인 잔재**가 남아 있습니다(백로그로 추적). 작업 전 위 문서를 먼저 확인하세요.

---

## 핵심 알고리즘 — TTTV_Score

```
TTTV_Score = w₁ · 취향 일치율 − w₂ · (예측 대기시간 + 이동시간) + w₃ · 인센티브
           (제안서 기준  w₁ = 0.40,  w₂ = 0.40,  w₃ = 0.20)
```

| 변수 | 계산 | 데이터 소스 |
| --- | --- | --- |
| 취향 일치율 (w₁) | 사용자 선호 카테고리 벡터 × POI 코사인 유사도 | TourAPI `contentTypeId` |
| 예측 대기 (w₂) | 시간대·요일 통계 + 행사 변수 회귀 예측 | 경주 교통데이터, TourAPI `eventBasedList` |
| 이동시간 (w₂) | 실시간 도보 경로 | Tmap 도보 경로 API |
| 인센티브 (w₃) | 혼잡 분산 보너스 / 제휴 쿠폰 (설계 확정 필요) | — |

> ℹ️ 상속한 베이스 코드의 현재 가중치는 **0.45/0.25/0.30**이며, 인센티브는 "혼잡 분산 보너스"로 구현돼 있습니다. 제안서 기준 **0.40/0.40/0.20** 및 인센티브 정의 확정은 개조 백로그 항목입니다([`docs/NEXTSPOT_PIVOT.md`](./docs/NEXTSPOT_PIVOT.md)).

## 주요 기능

1. **혼잡도 예측 지도 (Predictive Crowd Map)** — 경주 교통데이터 + TourAPI 위치로 황리단길 거점 혼잡 히트맵. 요일·시간·행사 기반 도착 예상 시각(±30분) 혼잡 예측.
2. **대안 장소 추천 엔진 (Alternative Suggestion Engine)** — 목적지 혼잡 임계 초과 시 반경 150m TourAPI POI를 TTTV로 정렬. '취향 일치율 00% · 예상 대기 0분 · 도보 0분' 형태로 추천 사유 투명 제공.
3. **온보딩 Cold Start 해결** — 선호 카테고리 3개+ 선택으로 취향 벡터 초기화, 방문 이력 누적으로 정교화.
4. **관리자 대시보드 (B2G)** — 경북문화관광공사 대상 혼잡 시각화·수요 분산 관제.

## 모노레포 구조 (상속 베이스)

```
NextSpot/
├── apps/
│   ├── web/            # Next.js 16 — 사용자 앱 + 관리자 대시보드
│   └── api/            # FastAPI — TTTV 추천 / 혼잡 예측 백엔드
│       └── app/services/tttv/   # ★ 재사용 핵심: score·preference·travel·wait_time
├── packages/shared-types/       # web ↔ api 공유 타입
├── supabase/                    # DB 스키마 / 마이그레이션
├── docs/NEXTSPOT_PIVOT.md       # ★ 관광 적응 명세 · 개조 백로그
├── docker-compose.yml
└── run_local.ps1
```

## 실행법 (상속 베이스 그대로)

자세한 절차·환경변수·스모크 테스트는 [`LOCAL_RUN.md`](./LOCAL_RUN.md) 참조.

```powershell
.\run_local.ps1            # 백엔드(8000) + 프론트(3000) 새 창으로 기동
```

```bash
# 백엔드 (FastAPI)
cd apps/api && pip install -r requirements.txt && uvicorn app.main:app --reload --port 8000
# 프론트 (Next.js)
cd apps/web && npm install && npm run dev      # http://localhost:3000
```

## 기술 스택

| 영역 | 기술 |
| --- | --- |
| 프론트 | Next.js 16, React 19, TypeScript, Tailwind CSS |
| 백엔드 | FastAPI (Python 3.11), uvicorn |
| 데이터 | Supabase (PostgreSQL) |
| 추천 | TTTV 엔진 (자체 구현) |
| 혼잡 예측 | 로컬 scikit-learn (Ridge + OneHotEncoder) |
| 외부 데이터(예정) | **TourAPI(한국관광공사 OpenAPI, 필수)**, 경주시 교통데이터(공공데이터포털), Tmap 도보 경로 API |
| 지도 | Kakao Maps SDK |

## 지역 특화 — 경주 황리단길

도보권 반경 400m 내 고밀도 POI(관광지 `12` · 문화시설 `14` · 음식점 `39`, 황리단길 반경 50건+) 분포로 '5분 거리 대안 제안'에 최적. 상시 오버투어리즘으로 서비스 실효성이 높고, 경북문화관광공사(RTO) 협력으로 B2G 확장 가능. 문체부·한국관광공사 스마트관광도시 지정지(2022).

## 로드맵

| 단계 | 기간 | 목표 |
| --- | --- | --- |
| MVP | 2026.05 ~ 2026.09 | 경주 황리단길 웹앱, TourAPI 연동, TTTV 추천 엔진, 혼잡 지도, 앱 래핑 |
| 확장 1 | 2026 ~ 2028 | 경북 5개 관광 밀집 구역 확대, 경북문화관광공사 MOU |
| 확장 2 | 2029 ~ | 전국 오버투어리즘 핫스팟 30개소, B2G 지자체 대시보드 |

## 기대 효과

- **관광객** — 도착 전 혼잡 확인 + 즉시 실행 가능한 대안 → 대기 시간(기회비용) 절감
- **소상공인** — 골목 유휴 업소로 수요 유입 → 상권 균형화
- **지자체(경북문화관광공사)** — 데이터 기반 혼잡 관리 → 규제 없는 수요 분산, 스마트 관광도시 KPI 연계
- **지역 주민** — 오버투어리즘 완화 → 생활 편의 보호

---

**팀 Next Spot** · 서진석(PM/기획) · 오윤성(AI/Backend) · 정동기(Frontend) · 김승용(Data/Infra)
