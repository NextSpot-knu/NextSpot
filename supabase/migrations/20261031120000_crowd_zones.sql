-- 구역 혼잡 데이터 계층 — docs/SEOUL_TESTBED_PLAN.md §3 · §6 S1·S2 · §7 Q4.
--
-- 공급원(서울 공공 API 지금 · 경주 통신사 나중)이 무엇이든 추천 엔진은 **정규화된 구역 혼잡 관측** 하나만
-- 보게 한다. 이 파일은 그 저장소 세 개와 서울 구역 9곳의 정의를 만든다:
--
--   zones                 구역 정의(서울 주요 장소 다각형 · 경주 통신사 격자 · 행정 구역)
--   zone_crowd_snapshots  구역 × 10분 버킷 정규화 관측(API 의 seoul_citydata_service 가 이중 저장)
--   facility_zones        시설 → 구역 매핑(S3 에서 채운다 — 지금은 빈 표)
--
-- 기존 seoul_citydata_snapshots 는 **그대로 둔다**(§7 Q4). 그 표는 추정기 검증의 정답 + 같은 버킷의 추정을
-- 한 행에 둔 검증 전용 표이고, 지표·보정·대안 패널이 계속 읽는다. 새 표는 공급원과 무관한 모양이다.
--
-- 서울은 **내부 전용**이다(§7 A1). 세 표 모두 익명·로그인 사용자에게 열지 않고, 읽기·쓰기는 API 가
-- service_role 로만 한다(관리자·개발자 화면은 API 를 거친다).
--
-- 멱등: 표·인덱스는 IF NOT EXISTS, 정책은 DROP 후 CREATE, 시드는 ON CONFLICT DO UPDATE.
-- ⚠️ 사람이 Supabase SQL Editor 에 붙여넣어 적용하고, 이어서 `NOTIFY pgrst, 'reload schema';` 를 실행한다.
--    적용 전에도 수집은 멈추지 않는다 — API 가 이 표가 없으면 이중 저장만 건너뛰고 상태에
--    migration_not_applied 를 남긴다(crowd/store.py).

CREATE TABLE IF NOT EXISTS public.zones (
    -- '<region>:<공급원 구역 코드>' — 서울은 'seoul:POI007' 처럼 서울시 주요 장소 코드를 쓴다.
    zone_id TEXT PRIMARY KEY CHECK (zone_id ~ '^[a-z][a-z0-9_]*:[^[:space:]]+$'),
    region TEXT NOT NULL CHECK (region ~ '^[a-z][a-z0-9_]*$'),
    kind TEXT NOT NULL CHECK (kind IN ('hotspot_polygon', 'grid_cell', 'admin_area')),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    -- 이 구역의 관측을 주는 공급원(zone_crowd_snapshots.source 와 같은 값).
    provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
    provider_zone_code TEXT,
    -- 공급원에 요청할 때 쓰는 이름(서울은 이름으로 호출한다 — SEOUL_CITYDATA_TARGETS 표기와 같다).
    provider_zone_name TEXT,
    -- 분산 평가에서 함께 비교하는 권역(서울: jongno · hongdae · validation).
    cluster TEXT,
    centroid_lat DOUBLE PRECISION NOT NULL CHECK (centroid_lat BETWEEN -90 AND 90),
    centroid_lng DOUBLE PRECISION NOT NULL CHECK (centroid_lng BETWEEN -180 AND 180),
    -- 다각형이 없을 때의 둘레 근사(같은 넓이 원의 반지름, m).
    radius_m INTEGER CHECK (radius_m IS NULL OR radius_m > 0),
    -- GeoJSON Polygon/MultiPolygon(WGS84). 서울 다각형은 S3 시설 매핑 때 적재한다.
    geometry JSONB CHECK (geometry IS NULL OR jsonb_typeof(geometry) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT zones_provider_code_unique UNIQUE (provider, provider_zone_code)
);

CREATE INDEX IF NOT EXISTS idx_zones_region_cluster ON public.zones (region, cluster);

CREATE TABLE IF NOT EXISTS public.zone_crowd_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zone_id TEXT NOT NULL REFERENCES public.zones(zone_id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (btrim(source) <> ''),
    -- 수집 시각(UTC)을 10분으로 내린 값. 같은 (구역, 공급원, 버킷) 재수집은 덮어쓴다(멱등).
    bucket_at TIMESTAMPTZ NOT NULL,
    -- 공급원이 집계한 시각(서울 PPLTN_TIME). 받은 시각은 fetched_at.
    observed_at TIMESTAMPTZ NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    period_seconds INTEGER CHECK (period_seconds IS NULL OR period_seconds > 0),
    population_min INTEGER CHECK (population_min IS NULL OR population_min >= 0),
    population_max INTEGER CHECK (population_max IS NULL OR population_max >= 0),
    population_point DOUBLE PRECISION CHECK (population_point IS NULL OR population_point >= 0),
    -- 0~1 정규화 단계와 공급원의 원래 단계·눈금(서울: 4등급 구간 중앙값, 'seoul_congest_4').
    level DOUBLE PRECISION CHECK (level IS NULL OR level BETWEEN 0 AND 1),
    level_label TEXT,
    level_scale TEXT NOT NULL CHECK (btrim(level_scale) <> ''),
    -- 공급원 예측(대상 시각별). 서울은 FCST_PPLTN 을 정규화해 싣는다.
    forecast JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(forecast) = 'array'),
    -- 품질 플래그(지연·대체값·결측 등).
    quality JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quality) = 'object'),
    CONSTRAINT zone_crowd_snapshots_population_range
        CHECK (population_min IS NULL OR population_max IS NULL OR population_min <= population_max),
    CONSTRAINT zone_crowd_snapshots_bucket_unique UNIQUE (zone_id, source, bucket_at)
);

CREATE INDEX IF NOT EXISTS idx_zone_crowd_snapshots_zone_bucket
    ON public.zone_crowd_snapshots (zone_id, bucket_at DESC);

CREATE TABLE IF NOT EXISTS public.facility_zones (
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    zone_id TEXT NOT NULL REFERENCES public.zones(zone_id) ON DELETE CASCADE,
    method TEXT NOT NULL CHECK (method IN ('point_in_polygon', 'nearest_grid', 'radius', 'manual')),
    weight DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 1),
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (facility_id, zone_id)
);

CREATE INDEX IF NOT EXISTS idx_facility_zones_zone ON public.facility_zones (zone_id);

-- ── 권한: service_role 만(서울은 내부 전용 — §7 A1) ─────────────────────────────

ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zone_crowd_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facility_zones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zones_service_all ON public.zones;
CREATE POLICY zones_service_all ON public.zones
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS zone_crowd_snapshots_service_all ON public.zone_crowd_snapshots;
CREATE POLICY zone_crowd_snapshots_service_all ON public.zone_crowd_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS facility_zones_service_all ON public.facility_zones;
CREATE POLICY facility_zones_service_all ON public.facility_zones
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2026-10-30부터 새 public 테이블은 Data API 권한을 자동으로 받지 않는다 — service_role 에 명시한다.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zone_crowd_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.facility_zones TO service_role;

-- 익명·로그인 사용자에게는 어떤 경로로도 열지 않는다(정책이 없어 이미 막히지만 두 겹으로).
REVOKE ALL ON TABLE public.zones FROM anon, authenticated;
REVOKE ALL ON TABLE public.zone_crowd_snapshots FROM anon, authenticated;
REVOKE ALL ON TABLE public.facility_zones FROM anon, authenticated;

-- ── 서울 구역 9곳(S2) ──────────────────────────────────────────────────────────
-- 코드·이름: 서울 열린데이터광장 OA-21285 '서울시 주요 121장소 목록.xlsx'(2026-04-02 판).
-- 중심·반지름: 같은 곳 '서울시 주요 121장소 영역.zip'(WGS84 다각형)의 넓이 중심 · 같은 넓이 원의 반지름.
-- apps/api/app/services/crowd/seoul_provider.py 의 SEOUL_ZONES 와 같은 값이다(테스트가 대조한다).
-- 계획의 '인사동·익선동'은 공식 목록에 한 장소로 없다(인사동 POI078 · 익선동 POI116 이 따로) — 인사동을 넣었다.
INSERT INTO public.zones (
    zone_id, region, kind, name, provider, provider_zone_code, provider_zone_name,
    cluster, centroid_lat, centroid_lng, radius_m
) VALUES
    ('seoul:POI008', 'seoul', 'hotspot_polygon', '경복궁', 'seoul_citydata', 'POI008', '경복궁', 'jongno', 37.579876, 126.976764, 375),
    ('seoul:POI066', 'seoul', 'hotspot_polygon', '북촌한옥마을', 'seoul_citydata', 'POI066', '북촌한옥마을', 'jongno', 37.582236, 126.984001, 597),
    ('seoul:POI078', 'seoul', 'hotspot_polygon', '인사동', 'seoul_citydata', 'POI078', '인사동', 'jongno', 37.573863, 126.986063, 328),
    ('seoul:POI012', 'seoul', 'hotspot_polygon', '창덕궁·종묘', 'seoul_citydata', 'POI012', '창덕궁·종묘', 'jongno', 37.578695, 126.993351, 592),
    ('seoul:POI007', 'seoul', 'hotspot_polygon', '홍대 관광특구', 'seoul_citydata', 'POI007', '홍대 관광특구', 'hongdae', 37.553919, 126.921276, 634),
    ('seoul:POI073', 'seoul', 'hotspot_polygon', '연남동', 'seoul_citydata', 'POI073', '연남동', 'hongdae', 37.561617, 126.922338, 351),
    ('seoul:POI053', 'seoul', 'hotspot_polygon', '합정역', 'seoul_citydata', 'POI053', '합정역', 'hongdae', 37.549376, 126.911733, 392),
    ('seoul:POI003', 'seoul', 'hotspot_polygon', '명동 관광특구', 'seoul_citydata', 'POI003', '명동 관광특구', 'validation', 37.564149, 126.981851, 542),
    ('seoul:POI002', 'seoul', 'hotspot_polygon', '동대문 관광특구', 'seoul_citydata', 'POI002', '동대문 관광특구', 'validation', 37.567311, 127.011023, 440)
ON CONFLICT (zone_id) DO UPDATE SET
    region = EXCLUDED.region,
    kind = EXCLUDED.kind,
    name = EXCLUDED.name,
    provider = EXCLUDED.provider,
    provider_zone_code = EXCLUDED.provider_zone_code,
    provider_zone_name = EXCLUDED.provider_zone_name,
    cluster = EXCLUDED.cluster,
    centroid_lat = EXCLUDED.centroid_lat,
    centroid_lng = EXCLUDED.centroid_lng,
    radius_m = EXCLUDED.radius_m,
    updated_at = now();

COMMENT ON TABLE public.zones IS
    '구역 정의(서울 주요 장소 · 경주 통신사 격자 등). 공급원과 무관한 혼잡 계층의 기준 — SEOUL_TESTBED_PLAN §3.3. service_role 전용.';
COMMENT ON TABLE public.zone_crowd_snapshots IS
    '구역 × 10분 버킷 정규화 혼잡 관측(CrowdObservation). 서울은 seoul_citydata_snapshots 와 이중 저장 — SEOUL_TESTBED_PLAN §3.2. service_role 전용.';
COMMENT ON TABLE public.facility_zones IS
    '시설 → 구역 매핑(점-다각형 포함 · 가장 가까운 격자 등). S3 에서 채운다 — SEOUL_TESTBED_PLAN §3.4. service_role 전용.';

-- 적용 후 SQL Editor 에서 `NOTIFY pgrst, 'reload schema';` 를 따로 실행한다(DEPLOY_AND_ENV §1-1).
