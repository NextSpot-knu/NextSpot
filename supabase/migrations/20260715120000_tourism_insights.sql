-- 관광공사 관광지 집중률 30일 전망. POI 실시간 혼잡과 의미가 다르므로 congestion_logs에 섞지 않는다.
CREATE TABLE IF NOT EXISTS public.tourism_concentration_forecasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tourist_attraction_code TEXT,
    tourist_attraction_name TEXT NOT NULL,
    forecast_date DATE NOT NULL,
    concentration_rate NUMERIC NOT NULL CHECK (concentration_rate BETWEEN 0 AND 100),
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tourist_attraction_name, forecast_date)
);

CREATE INDEX IF NOT EXISTS idx_tourism_concentration_date
    ON public.tourism_concentration_forecasts (forecast_date, tourist_attraction_name);

ALTER TABLE public.tourism_concentration_forecasts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tourism_concentration_service_all ON public.tourism_concentration_forecasts;
CREATE POLICY tourism_concentration_service_all ON public.tourism_concentration_forecasts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Tmap 이동 기반 연관 관광지와 지역 수요 API는 제공 스키마 변경에 대비해 원문도 보존한다.
CREATE TABLE IF NOT EXISTS public.tourism_insight_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_type TEXT NOT NULL CHECK (insight_type IN ('related_attraction', 'regional_stay', 'regional_spend')),
    reference_period TEXT NOT NULL,
    region_code TEXT NOT NULL DEFAULT '47130',
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (insight_type, reference_period, region_code)
);

ALTER TABLE public.tourism_insight_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tourism_insights_service_all ON public.tourism_insight_snapshots;
CREATE POLICY tourism_insights_service_all ON public.tourism_insight_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- detailImage2 서브 이미지. firstimage 대표 URL과 구분해 순서를 보존한다.
ALTER TABLE public.facilities
    ADD COLUMN IF NOT EXISTS gallery_images JSONB NOT NULL DEFAULT '[]'::jsonb;
