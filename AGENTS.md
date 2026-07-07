# NextSpot — 관광 수요 재배치 플랫폼

2026 관광데이터 활용 공모전(① 웹·앱 개발 부문) 출품작. 경주 황리단길의 오버투어리즘을
SPOT(Smart Place Optimization for Tourism) 알고리즘으로 분산·재배치하는 AI 대안 장소 추천 웹 서비스.

- **베이스:** InduSpot(산업단지 공용 인프라 혼잡 분산)의 로컬 전용 모노레포를 시드로 재사용.
  아키텍처(Next.js 웹 + FastAPI + Supabase + 로컬 sklearn)와 SPOT 엔진은 동일, 도메인만 관광으로 피벗.
- **필수 데이터:** 한국관광공사 OpenAPI(TourAPI). 적응 명세·개조 백로그는 `docs/NEXTSPOT_PIVOT.md`.
- **현재 상태(중요):** 시드 직후 — 코드/문서 다수에 InduSpot·산업(근로자·공단·구미·시설) 도메인 잔재가
  남아 있습니다. 작업 전 `docs/NEXTSPOT_PIVOT.md`의 매핑·백로그를 먼저 확인하세요.
