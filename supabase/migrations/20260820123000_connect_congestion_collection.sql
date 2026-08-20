-- 현장 혼잡 수집 경로 연결
-- 1) 방문 완료 후 체감 혼잡을 recommendation_outcomes 에만 두지 않고 congestion_logs 로 투영한다.
-- 2) 사장 좌석 방송을 별도 출처로 보존하고, 매장 운영자가 직접 확인한 현장값이므로
--    merchant_report/verified 로 즉시 학습 가능한 관측에 포함한다.

ALTER TABLE public.congestion_logs
    DROP CONSTRAINT IF EXISTS congestion_logs_source_check;
ALTER TABLE public.congestion_logs
    ADD CONSTRAINT congestion_logs_source_check
    CHECK (source IN (
        'traffic_cctv', 'tour_api', 'event', 'user_report', 'merchant_report', 'seed', 'simulated'
    ));

ALTER TABLE public.congestion_logs
    ADD COLUMN IF NOT EXISTS origin_outcome_id UUID
    REFERENCES public.recommendation_outcomes(recommendation_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_congestion_logs_origin_outcome
    ON public.congestion_logs(origin_outcome_id)
    WHERE origin_outcome_id IS NOT NULL;

-- 공개 현재 혼잡 조회는 실제 현장 관측만 반환한다. seed/simulated는 개발 이력으로 보존하되
-- 지도·추천의 '지금 혼잡' 후보가 될 수 없다.
CREATE OR REPLACE FUNCTION public.latest_congestion_for_facilities(facility_ids UUID[])
RETURNS TABLE (
    facility_id UUID,
    congestion_level DOUBLE PRECISION,
    current_count INT,
    "timestamp" TIMESTAMPTZ,
    source VARCHAR,
    evidence_tier TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT ON (c.facility_id)
        c.facility_id, c.congestion_level, c.current_count, c.timestamp, c.source, c.evidence_tier
    FROM public.congestion_logs AS c
    WHERE c.facility_id = ANY(facility_ids)
      AND c.evidence_tier IN ('single_report', 'corroborated', 'verified')
      AND c.source NOT IN ('seed', 'simulated')
    ORDER BY c.facility_id, c.timestamp DESC, c.id DESC;
$$;

CREATE OR REPLACE FUNCTION public.project_outcome_congestion_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    target_facility_id UUID;
    target_capacity INTEGER;
    normalized_level DOUBLE PRECISION;
BEGIN
    -- rated 멱등 재요청이나 다른 필드 갱신으로 동일 관측을 중복 적재하지 않는다.
    IF NEW.observed_congestion IS NULL
       OR (TG_OP = 'UPDATE' AND OLD.observed_congestion IS NOT NULL) THEN
        RETURN NEW;
    END IF;

    normalized_level := CASE NEW.observed_congestion
        WHEN 'quiet' THEN 0.2
        WHEN 'normal' THEN 0.5
        WHEN 'busy' THEN 0.8
        ELSE NULL
    END;
    IF normalized_level IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT r.recommended_facility_id, f.capacity
      INTO target_facility_id, target_capacity
      FROM public.recommendations AS r
      JOIN public.facilities AS f ON f.id = r.recommended_facility_id
     WHERE r.id = NEW.recommendation_id;

    IF target_facility_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.congestion_logs (
        facility_id, timestamp, current_count, congestion_level,
        source, evidence_tier, reporter_user_id, origin_outcome_id
    ) VALUES (
        target_facility_id,
        COALESCE(NEW.updated_at, timezone('utc', now())),
        round(COALESCE(target_capacity, 0) * normalized_level),
        normalized_level,
        'user_report',
        'single_report',
        NEW.user_id,
        NEW.recommendation_id
    ) ON CONFLICT (origin_outcome_id) WHERE origin_outcome_id IS NOT NULL DO NOTHING;

    -- congestion_logs 의 correlate_congestion_report_evidence 트리거가 같은 시설·30분 내
    -- 서로 다른 사용자 2명 이상 일치 시 관련 행을 corroborated 로 승격한다.
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_outcome_congestion_log ON public.recommendation_outcomes;
CREATE TRIGGER project_outcome_congestion_log
    AFTER INSERT OR UPDATE OF observed_congestion ON public.recommendation_outcomes
    FOR EACH ROW EXECUTE FUNCTION public.project_outcome_congestion_log();

-- 마이그레이션 전에 이미 받은 체감 혼잡도도 같은 단일 관측으로 한 번만 이관한다.
INSERT INTO public.congestion_logs (
    facility_id, timestamp, current_count, congestion_level,
    source, evidence_tier, reporter_user_id, origin_outcome_id
)
SELECT
    r.recommended_facility_id,
    COALESCE(o.updated_at, o.rated_at, timezone('utc', now())),
    round(COALESCE(f.capacity, 0) * CASE o.observed_congestion
        WHEN 'quiet' THEN 0.2 WHEN 'normal' THEN 0.5 WHEN 'busy' THEN 0.8 END),
    CASE o.observed_congestion
        WHEN 'quiet' THEN 0.2 WHEN 'normal' THEN 0.5 WHEN 'busy' THEN 0.8 END,
    'user_report', 'single_report', o.user_id, o.recommendation_id
FROM public.recommendation_outcomes AS o
JOIN public.recommendations AS r ON r.id = o.recommendation_id
JOIN public.facilities AS f ON f.id = r.recommended_facility_id
WHERE o.observed_congestion IS NOT NULL
ON CONFLICT (origin_outcome_id) WHERE origin_outcome_id IS NOT NULL DO NOTHING;
