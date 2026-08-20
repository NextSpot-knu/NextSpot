-- 추천 신뢰도 폐루프: 비공개 모델 레지스트리, 방문 결과, 혼잡 근거 등급.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'recommendation-models',
    'recommendation-models',
    false,
    52428800,
    ARRAY['application/octet-stream']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.model_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL UNIQUE,
    storage_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    feature_schema_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'active', 'rejected', 'rolled_back')),
    training_started_at TIMESTAMPTZ NOT NULL,
    training_ended_at TIMESTAMPTZ NOT NULL,
    real_data_count INTEGER NOT NULL CHECK (real_data_count >= 0),
    source_composition JSONB NOT NULL DEFAULT '{}'::jsonb,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    approved_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    CHECK (training_ended_at >= training_started_at)
);

-- 활성 모델은 언제나 하나뿐이다. 교체는 아래 promote 함수의 한 트랜잭션에서 수행한다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_registry_one_active
    ON public.model_registry ((status)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_model_registry_created_at
    ON public.model_registry (created_at DESC);

ALTER TABLE public.model_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all_model_registry ON public.model_registry;
CREATE POLICY service_role_all_model_registry ON public.model_registry
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Storage 객체는 공개 정책을 만들지 않는다. service_role만 RLS 우회로 읽고 쓴다.

CREATE OR REPLACE FUNCTION public.promote_recommendation_model(p_version TEXT)
RETURNS public.model_registry
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    promoted public.model_registry;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.model_registry
       SET status = 'rolled_back'
     WHERE status = 'active' AND version <> p_version;

    UPDATE public.model_registry
       SET status = 'active',
           approved_at = COALESCE(approved_at, timezone('utc', now())),
           activated_at = timezone('utc', now())
     WHERE version = p_version AND status IN ('candidate', 'rolled_back', 'active')
     RETURNING * INTO promoted;

    IF promoted.id IS NULL THEN
        RAISE EXCEPTION 'promotable model not found: %', p_version USING ERRCODE = 'P0002';
    END IF;

    RETURN promoted;
END;
$$;
REVOKE ALL ON FUNCTION public.promote_recommendation_model(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_recommendation_model(TEXT) TO service_role;

ALTER TABLE public.congestion_logs
    ADD COLUMN IF NOT EXISTS evidence_tier TEXT NOT NULL DEFAULT 'synthetic',
    ADD COLUMN IF NOT EXISTS reporter_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.congestion_logs
    DROP CONSTRAINT IF EXISTS congestion_logs_evidence_tier_check;
ALTER TABLE public.congestion_logs
    ADD CONSTRAINT congestion_logs_evidence_tier_check
    CHECK (evidence_tier IN ('synthetic', 'single_report', 'corroborated', 'verified'));

-- 기존 seed/simulated 데이터는 항상 synthetic. 운영 검증 소스만 verified로 명시 승격한다.
UPDATE public.congestion_logs
   SET evidence_tier = CASE
       WHEN source IN ('traffic_cctv', 'tour_api', 'event') THEN 'verified'
       WHEN source = 'user_report' THEN 'single_report'
       ELSE 'synthetic'
   END;

CREATE INDEX IF NOT EXISTS idx_congestion_logs_training_evidence
    ON public.congestion_logs (evidence_tier, timestamp DESC, facility_id);

DROP FUNCTION IF EXISTS public.latest_congestion_for_facilities(UUID[]);
CREATE FUNCTION public.latest_congestion_for_facilities(facility_ids UUID[])
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
    ORDER BY c.facility_id, c.timestamp DESC, c.id DESC;
$$;
GRANT EXECUTE ON FUNCTION public.latest_congestion_for_facilities(UUID[])
    TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.correlate_congestion_report_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    matching_users INTEGER;
BEGIN
    IF NEW.source <> 'user_report' OR NEW.reporter_user_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT count(DISTINCT reporter_user_id) INTO matching_users
      FROM public.congestion_logs
     WHERE facility_id = NEW.facility_id
       AND source = 'user_report'
       AND reporter_user_id IS NOT NULL
       AND timestamp BETWEEN NEW.timestamp - interval '30 minutes' AND NEW.timestamp + interval '30 minutes'
       AND abs(congestion_level - NEW.congestion_level) <= 0.05;
    IF matching_users >= 2 THEN
        UPDATE public.congestion_logs
           SET evidence_tier = 'corroborated'
         WHERE facility_id = NEW.facility_id
           AND source = 'user_report'
           AND timestamp BETWEEN NEW.timestamp - interval '30 minutes' AND NEW.timestamp + interval '30 minutes'
           AND abs(congestion_level - NEW.congestion_level) <= 0.05;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS correlate_congestion_report_evidence ON public.congestion_logs;
CREATE TRIGGER correlate_congestion_report_evidence
    AFTER INSERT ON public.congestion_logs
    FOR EACH ROW EXECUTE FUNCTION public.correlate_congestion_report_evidence();

CREATE TABLE IF NOT EXISTS public.recommendation_outcomes (
    recommendation_id UUID PRIMARY KEY REFERENCES public.recommendations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    navigation_started_at TIMESTAMPTZ NOT NULL,
    arrival_confirmed_at TIMESTAMPTZ,
    rated_at TIMESTAMPTZ,
    rating TEXT CHECK (rating IN ('up', 'down')),
    observed_congestion TEXT CHECK (observed_congestion IN ('quiet', 'normal', 'busy')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    CHECK (arrival_confirmed_at IS NULL OR arrival_confirmed_at >= navigation_started_at),
    CHECK (rated_at IS NULL OR (arrival_confirmed_at IS NOT NULL AND rated_at >= arrival_confirmed_at)),
    CHECK ((rated_at IS NULL AND rating IS NULL) OR (rated_at IS NOT NULL AND rating IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_user
    ON public.recommendation_outcomes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_training
    ON public.recommendation_outcomes (arrival_confirmed_at DESC)
    WHERE observed_congestion IS NOT NULL;

ALTER TABLE public.recommendation_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all_recommendation_outcomes ON public.recommendation_outcomes;
CREATE POLICY service_role_all_recommendation_outcomes ON public.recommendation_outcomes
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS select_own_recommendation_outcomes ON public.recommendation_outcomes;
CREATE POLICY select_own_recommendation_outcomes ON public.recommendation_outcomes
    FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.record_recommendation_outcome(
    p_recommendation_id UUID,
    p_user_id UUID,
    p_stage TEXT,
    p_rating TEXT DEFAULT NULL,
    p_observed_congestion TEXT DEFAULT NULL
)
RETURNS public.recommendation_outcomes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    rec_owner UUID;
    current_row public.recommendation_outcomes;
    server_now TIMESTAMPTZ := timezone('utc', now());
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;
    IF p_stage NOT IN ('navigation_started', 'arrival_confirmed', 'rated') THEN
        RAISE EXCEPTION 'invalid outcome stage' USING ERRCODE = '22023';
    END IF;
    IF p_stage = 'rated' AND p_rating NOT IN ('up', 'down') THEN
        RAISE EXCEPTION 'rating required for rated stage' USING ERRCODE = '22023';
    END IF;
    IF p_stage <> 'rated' AND p_rating IS NOT NULL THEN
        RAISE EXCEPTION 'rating is only valid for rated stage' USING ERRCODE = '22023';
    END IF;
    IF p_observed_congestion IS NOT NULL
       AND p_observed_congestion NOT IN ('quiet', 'normal', 'busy') THEN
        RAISE EXCEPTION 'invalid observed congestion' USING ERRCODE = '22023';
    END IF;

    SELECT user_id INTO rec_owner
      FROM public.recommendations
     WHERE id = p_recommendation_id;
    IF rec_owner IS NULL THEN
        RAISE EXCEPTION 'recommendation not found' USING ERRCODE = 'P0002';
    END IF;
    IF rec_owner <> p_user_id THEN
        RAISE EXCEPTION 'recommendation owner mismatch' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO current_row
      FROM public.recommendation_outcomes
     WHERE recommendation_id = p_recommendation_id
     FOR UPDATE;

    IF current_row.recommendation_id IS NULL THEN
        IF p_stage <> 'navigation_started' THEN
            RAISE EXCEPTION 'navigation_started must be recorded first' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.recommendation_outcomes (
            recommendation_id, user_id, navigation_started_at
        ) VALUES (p_recommendation_id, p_user_id, server_now)
        RETURNING * INTO current_row;
        RETURN current_row;
    END IF;

    IF p_stage = 'arrival_confirmed' AND current_row.arrival_confirmed_at IS NULL THEN
        UPDATE public.recommendation_outcomes
           SET arrival_confirmed_at = server_now, updated_at = server_now
         WHERE recommendation_id = p_recommendation_id
         RETURNING * INTO current_row;
    ELSIF p_stage = 'rated' THEN
        IF current_row.arrival_confirmed_at IS NULL THEN
            RAISE EXCEPTION 'arrival_confirmed must be recorded first' USING ERRCODE = '22023';
        END IF;
        IF current_row.rated_at IS NULL THEN
            UPDATE public.recommendation_outcomes
               SET rated_at = server_now,
                   rating = p_rating,
                   observed_congestion = p_observed_congestion,
                   updated_at = server_now
             WHERE recommendation_id = p_recommendation_id
             RETURNING * INTO current_row;
        ELSIF current_row.rating = p_rating
              AND current_row.observed_congestion IS NULL
              AND p_observed_congestion IS NOT NULL THEN
            UPDATE public.recommendation_outcomes
               SET observed_congestion = p_observed_congestion, updated_at = server_now
             WHERE recommendation_id = p_recommendation_id
             RETURNING * INTO current_row;
        ELSIF current_row.rating <> p_rating THEN
            RAISE EXCEPTION 'rating cannot be changed' USING ERRCODE = '22023';
        END IF;
    END IF;

    RETURN current_row;
END;
$$;
REVOKE ALL ON FUNCTION public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT)
    TO service_role;
