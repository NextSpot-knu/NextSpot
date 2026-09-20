-- 서울 실시간 도시데이터(OA-21285) 검증 표본 — docs/CONGESTION_ENGINE_PLAN.md §5.3 Phase 1.
--
-- 왜 새 테이블인가: 서울 대상지는 경주 시설과 무관하고, 이 값은 우리 추정기를 **채점하는 정답**이다.
-- congestion_logs 에 넣으면 source CHECK(정직성 제약)를 넓혀야 하고, 추천·학습 경로가 서울 행을
-- 경주 시설의 관측으로 오인할 여지가 생긴다. 정답과 같은 버킷의 추정(level_est)을 **같은 행**에 두면
-- 지표(등급 일치율·순위 상관·위험 오분류율)가 SQL 한 번이다.
--
-- 서울 API 는 과거 데이터를 주지 않는다 — 표본은 이 표에 쌓인 날부터만 존재한다(§2-6).
-- 적재는 API(service_role)만 한다. 읽기는 관리자 API 가 supabase_admin 으로 한다.
-- 10분 주기 호출 예약은 별도 파일(20260920121000_schedule_seoul_citydata_collection.sql)이다 —
-- 표를 먼저 만들고, Render 에 SEOUL_OPENDATA_KEY 를 넣은 뒤에 예약을 켠다.

CREATE TABLE IF NOT EXISTS public.seoul_citydata_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 응답의 AREA_CD(POI…). 요청은 이름으로 하므로 코드가 비어 올 가능성까지 열어 둔다.
    area_cd TEXT,
    area_nm TEXT NOT NULL CHECK (btrim(area_nm) <> ''),
    -- 수집 시각(UTC)을 10분으로 내린 값. 같은 버킷 재호출은 이 키로 덮어쓴다(멱등).
    bucket_at TIMESTAMPTZ NOT NULL,
    -- PPLTN_TIME(KST, 시간대 표기 없음)을 +09:00 으로 해석한 서울시 인구 집계 시각.
    observed_at TIMESTAMPTZ NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    congest_lvl TEXT NOT NULL CHECK (congest_lvl IN ('여유', '보통', '약간 붐빔', '붐빔')),
    ppltn_min INTEGER CHECK (ppltn_min IS NULL OR ppltn_min >= 0),
    ppltn_max INTEGER CHECK (ppltn_max IS NULL OR ppltn_max >= 0),
    -- 서울시 자체 예측(FCST_PPLTN) 원문. 30분 전망 오차의 비교 기준선으로만 쓴다(§6).
    fcst JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- 추정에 실제로 쓴 실시간 주차장 원문(CUR_PRK_YN='Y' + 면수 검증 통과분만).
    prk JSONB NOT NULL DEFAULT '[]'::jsonb,
    live_lot_count INTEGER NOT NULL DEFAULT 0 CHECK (live_lot_count >= 0),
    parking_level DOUBLE PRECISION CHECK (parking_level IS NULL OR parking_level BETWEEN 0 AND 1),
    tourism_level DOUBLE PRECISION CHECK (tourism_level IS NULL OR tourism_level BETWEEN 0 AND 1),
    -- 우리 추정기(congestion_estimator_service.blend_level)의 값. 실시간 주차장이 없으면 NULL —
    -- 숫자를 지어내지 않는다(§5.1).
    level_est DOUBLE PRECISION CHECK (level_est IS NULL OR level_est BETWEEN 0 AND 1),
    -- 산식이 바뀌면 이 값을 올린다. 지표는 같은 버전끼리만 비교한다.
    estimator_version TEXT NOT NULL,
    CONSTRAINT seoul_citydata_snapshots_ppltn_range
        CHECK (ppltn_min IS NULL OR ppltn_max IS NULL OR ppltn_min <= ppltn_max),
    CONSTRAINT seoul_citydata_snapshots_bucket_unique UNIQUE (area_nm, bucket_at)
);

CREATE INDEX IF NOT EXISTS idx_seoul_citydata_snapshots_area_bucket
    ON public.seoul_citydata_snapshots (area_nm, bucket_at DESC);

ALTER TABLE public.seoul_citydata_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS seoul_citydata_snapshots_service_all ON public.seoul_citydata_snapshots;
CREATE POLICY seoul_citydata_snapshots_service_all ON public.seoul_citydata_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 익명·로그인 사용자에게는 어떤 경로로도 열지 않는다(RLS 정책이 없어 이미 막히지만 두 겹으로).
REVOKE ALL ON TABLE public.seoul_citydata_snapshots FROM anon, authenticated;

COMMENT ON TABLE public.seoul_citydata_snapshots IS
    '서울 실시간 도시데이터 10분 표본(정답: 서울시 인구 등급) + 같은 버킷의 우리 추정(level_est). 엔진 검증 전용 — congestion_logs 와 섞지 않는다.';

-- 적용 후 SQL Editor 에서 `NOTIFY pgrst, 'reload schema';` 를 따로 실행한다(DEPLOY_AND_ENV §1-1).
-- 빼먹으면 API 가 한동안 이 표를 못 보고 수집·상태 엔드포인트가 409 migration_not_applied 를 낸다.
