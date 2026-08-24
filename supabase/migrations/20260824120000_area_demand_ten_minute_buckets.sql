-- 주변 주차 수요 수집 주기를 15분에서 10분으로 높인다.
-- 기존 행은 15분 cadence로 명시해 그대로 보존하고, 이후 RPC 기록만 10분 버킷을 사용한다.

ALTER TABLE public.area_demand_snapshots
    DROP CONSTRAINT IF EXISTS area_demand_snapshots_bucket_aligned;

ALTER TABLE public.area_demand_snapshots
    ADD COLUMN IF NOT EXISTS bucket_minutes SMALLINT;

-- 이 migration 전에 존재한 행은 모두 기존 RPC가 만든 15분 정렬 행이다.
UPDATE public.area_demand_snapshots
   SET bucket_minutes = 15
 WHERE bucket_minutes IS NULL;

ALTER TABLE public.area_demand_snapshots
    ALTER COLUMN bucket_minutes SET DEFAULT 10,
    ALTER COLUMN bucket_minutes SET NOT NULL;

ALTER TABLE public.area_demand_snapshots
    DROP CONSTRAINT IF EXISTS area_demand_snapshots_bucket_cadence_valid;
ALTER TABLE public.area_demand_snapshots
    ADD CONSTRAINT area_demand_snapshots_bucket_cadence_valid CHECK (
        (bucket_minutes = 15 AND bucket_at = date_bin(
            INTERVAL '15 minutes', observed_at,
            TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ))
        OR
        (bucket_minutes = 10 AND bucket_at = date_bin(
            INTERVAL '10 minutes', observed_at,
            TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ))
    );

COMMENT ON TABLE public.area_demand_snapshots IS
    '10분 단위 주변 공영주차 실측 집계. 전환 전 15분 원본은 bucket_minutes=15로 보존. 장소 내부 혼잡 또는 예측값이 아님.';
COMMENT ON COLUMN public.area_demand_snapshots.bucket_at IS
    'observed_at을 UTC epoch 기준 bucket_minutes 간격으로 내린 멱등 수집 키.';
COMMENT ON COLUMN public.area_demand_snapshots.bucket_minutes IS
    '수집 버킷 간격. 전환 전 원본은 15, 현재 수집은 10.';

-- 검증과 자식 원본 교체는 기존 RPC와 동일하고, 서버가 보내지 않는 버킷만 10분으로 계산한다.
CREATE OR REPLACE FUNCTION public.record_area_demand_snapshot(
    p_source TEXT,
    p_observed_at TIMESTAMPTZ,
    p_lots JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_bucket_at TIMESTAMPTZ;
    v_lot JSONB;
    v_source_lot_id TEXT;
    v_name TEXT;
    v_latitude DOUBLE PRECISION;
    v_longitude DOUBLE PRECISION;
    v_total INTEGER;
    v_available INTEGER;
    v_total_spaces BIGINT := 0;
    v_available_spaces BIGINT := 0;
    v_live_lot_count INTEGER;
    v_existing public.area_demand_snapshots%ROWTYPE;
    v_snapshot public.area_demand_snapshots%ROWTYPE;
BEGIN
    IF p_source IS NULL
       OR p_source NOT IN ('gyeongju_its', 'national_parking_api') THEN
        RAISE EXCEPTION 'unsupported area demand source'
            USING ERRCODE = '22023';
    END IF;
    IF p_observed_at IS NULL OR NOT isfinite(p_observed_at) THEN
        RAISE EXCEPTION 'observed_at must be a finite timestamp'
            USING ERRCODE = '22023';
    END IF;
    IF p_lots IS NULL
       OR jsonb_typeof(p_lots) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_lots) = 0
       OR jsonb_array_length(p_lots) > 500 THEN
        RAISE EXCEPTION 'lots must be a non-empty array with at most 500 items'
            USING ERRCODE = '22023';
    END IF;

    v_live_lot_count := jsonb_array_length(p_lots);
    FOR v_lot IN
        SELECT item FROM jsonb_array_elements(p_lots) AS entries(item)
    LOOP
        IF jsonb_typeof(v_lot) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'every lot must be an object'
                USING ERRCODE = '22023';
        END IF;

        v_source_lot_id := btrim(COALESCE(v_lot->>'source_lot_id', ''));
        v_name := btrim(COALESCE(v_lot->>'name', ''));
        IF v_source_lot_id = '' OR v_name = '' THEN
            RAISE EXCEPTION 'lot source_lot_id and name are required'
                USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(v_lot->'latitude') IS DISTINCT FROM 'number'
           OR jsonb_typeof(v_lot->'longitude') IS DISTINCT FROM 'number'
           OR jsonb_typeof(v_lot->'total_spaces') IS DISTINCT FROM 'number'
           OR jsonb_typeof(v_lot->'available_spaces') IS DISTINCT FROM 'number'
           OR (v_lot->>'total_spaces') !~ '^[0-9]+$'
           OR (v_lot->>'available_spaces') !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'lot coordinates and space counts must be numeric'
                USING ERRCODE = '22023';
        END IF;

        BEGIN
            v_latitude := (v_lot->>'latitude')::DOUBLE PRECISION;
            v_longitude := (v_lot->>'longitude')::DOUBLE PRECISION;
            v_total := (v_lot->>'total_spaces')::INTEGER;
            v_available := (v_lot->>'available_spaces')::INTEGER;
        EXCEPTION
            WHEN numeric_value_out_of_range OR invalid_text_representation THEN
                RAISE EXCEPTION 'lot numeric value is out of range'
                    USING ERRCODE = '22023';
        END;

        IF v_latitude NOT BETWEEN -90.0 AND 90.0
           OR v_longitude NOT BETWEEN -180.0 AND 180.0
           OR v_total <= 0
           OR v_available < 0
           OR v_available > v_total THEN
            RAISE EXCEPTION 'lot coordinates or space counts are invalid'
                USING ERRCODE = '22023';
        END IF;
        v_total_spaces := v_total_spaces + v_total;
        v_available_spaces := v_available_spaces + v_available;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_lots) AS entries(item)
        GROUP BY btrim(item->>'source_lot_id')
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'duplicate source_lot_id in lots'
            USING ERRCODE = '22023';
    END IF;
    IF v_total_spaces > 2147483647 OR v_available_spaces > 2147483647 THEN
        RAISE EXCEPTION 'aggregate space count is out of range'
            USING ERRCODE = '22023';
    END IF;

    v_bucket_at := date_bin(
        INTERVAL '10 minutes',
        p_observed_at,
        TIMESTAMPTZ '1970-01-01 00:00:00+00'
    );
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_source || ':' || extract(epoch FROM v_bucket_at)::BIGINT::TEXT, 0)
    );

    SELECT snapshot.*
      INTO v_existing
      FROM public.area_demand_snapshots AS snapshot
     WHERE snapshot.source = p_source
       AND snapshot.bucket_at = v_bucket_at
     FOR UPDATE;

    IF FOUND AND v_existing.observed_at > p_observed_at THEN
        RETURN to_jsonb(v_existing) || jsonb_build_object('stored', false);
    END IF;

    IF v_existing.id IS NULL THEN
        INSERT INTO public.area_demand_snapshots (
            source, observed_at, bucket_at, bucket_minutes,
            total_spaces, available_spaces, live_lot_count
        ) VALUES (
            p_source, p_observed_at, v_bucket_at, 10,
            v_total_spaces::INTEGER, v_available_spaces::INTEGER, v_live_lot_count
        )
        RETURNING * INTO v_snapshot;
    ELSE
        UPDATE public.area_demand_snapshots
           SET observed_at = p_observed_at,
               bucket_minutes = 10,
               total_spaces = v_total_spaces::INTEGER,
               available_spaces = v_available_spaces::INTEGER,
               live_lot_count = v_live_lot_count
         WHERE id = v_existing.id
        RETURNING * INTO v_snapshot;
    END IF;

    DELETE FROM public.area_demand_snapshot_lots
     WHERE snapshot_id = v_snapshot.id;

    FOR v_lot IN
        SELECT item FROM jsonb_array_elements(p_lots) AS entries(item)
    LOOP
        INSERT INTO public.area_demand_snapshot_lots (
            snapshot_id, source_lot_id, name, latitude, longitude,
            total_spaces, available_spaces
        ) VALUES (
            v_snapshot.id,
            btrim(v_lot->>'source_lot_id'),
            btrim(v_lot->>'name'),
            (v_lot->>'latitude')::DOUBLE PRECISION,
            (v_lot->>'longitude')::DOUBLE PRECISION,
            (v_lot->>'total_spaces')::INTEGER,
            (v_lot->>'available_spaces')::INTEGER
        );
    END LOOP;

    RETURN to_jsonb(v_snapshot) || jsonb_build_object('stored', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_area_demand_snapshot(TEXT, TIMESTAMPTZ, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_area_demand_snapshot(TEXT, TIMESTAMPTZ, JSONB)
    TO service_role;
