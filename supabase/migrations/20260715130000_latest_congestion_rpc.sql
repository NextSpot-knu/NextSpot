-- 시설별 최신 혼잡을 한 번의 DB 왕복으로 반환한다. DISTINCT ON은 기존
-- (facility_id, timestamp DESC) 인덱스를 사용하며 동일 timestamp는 id DESC로 결정한다.
CREATE OR REPLACE FUNCTION public.latest_congestion_for_facilities(facility_ids UUID[])
RETURNS TABLE (
    facility_id UUID,
    congestion_level DOUBLE PRECISION,
    current_count INT,
    "timestamp" TIMESTAMPTZ,
    source VARCHAR
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT ON (c.facility_id)
        c.facility_id, c.congestion_level, c.current_count, c.timestamp, c.source
    FROM public.congestion_logs AS c
    WHERE c.facility_id = ANY(facility_ids)
    ORDER BY c.facility_id, c.timestamp DESC, c.id DESC;
$$;

GRANT EXECUTE ON FUNCTION public.latest_congestion_for_facilities(UUID[])
    TO anon, authenticated, service_role;
