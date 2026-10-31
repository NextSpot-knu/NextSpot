# 서울 구역 데이터 (`crowd/data`)

서울 테스트베드 S3에서 서울 적재와 시설↔구역 매핑이 함께 쓰는 구역 경계 파일을 두는 자리다.

## `seoul_zone_polygons.geojson` (아직 없음)

- **무엇** — `SEOUL_ZONES` 9곳(경복궁 · 북촌한옥마을 · 인사동 · 창덕궁·종묘 · 홍대 관광특구 · 연남동 · 합정역 ·
  명동 관광특구 · 동대문 관광특구)의 다각형. `properties.zone_id` 는 `seoul:POI…` 형식이다.
- **출처** — 서울 열린데이터광장 OA-21285 「서울시 주요 121장소 영역」. 공공누리 제1유형(출처 표시).
  파일의 `provenance` 에 출처·이용 조건·단순화 허용 오차(약 2 m)를 함께 적는다.
- **만드는 법** — 사람이 zip 을 내려받아 **빈 폴더 하나에만** 둔 뒤 격리 모드로 돌린다(내려받은 파일은 믿지 않는다).

  ```bash
  python -I apps/api/scripts/build_seoul_zone_polygons.py <빈 폴더>/<영역 zip>
  ```

  만든 파일을 커밋하고, `ingest-seoul.yml` 을 `map_zones=true` 로 돌리면 `--sync-geometry` 가 `zones.geometry` 를 맞춘다.
- **없을 때** — 적재와 매핑 모두 원 발자국(같은 넓이 원의 반지름 × 1.5)을 쓴다. 파일이 생기면 다각형을 200 m 넓힌
  범위를 쓴다. 규칙은 [`zone_footprint.py`](../zone_footprint.py) 한 곳에만 있다.
- **검사** — `tests/scripts/test_zone_footprint.py` 가 파일이 있으면 9곳과 정확히 맞는지 확인하고, 없으면 건너뛴다.

## 지키는 것

- 이 폴더의 좌표는 **서버 전용**이다. 웹 번들로 내보내지 않는다(서울은 개발자 전용 지역 — 지리 정보도
  `GET /api/v1/internal/regions` 로 개발자 세션에만 간다).
- 구역을 바꾸려면 `seoul_provider.SEOUL_ZONES`, 마이그레이션 시드(`20261031120000_crowd_zones.sql`),
  `scripts/build_seoul_zone_polygons.py` 의 코드 목록을 함께 고친다(테스트가 셋을 대조한다).
