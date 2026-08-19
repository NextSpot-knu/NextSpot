-- 공공 인허가 원본 식별자와 상태를 시설 본문에서 분리해 보존한다.
CREATE TABLE IF NOT EXISTS public.facility_source_refs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('tourapi', 'localdata')),
    external_id TEXT NOT NULL,
    source_status TEXT,
    source_updated_at TIMESTAMP WITH TIME ZONE,
    source_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_facility_source_refs_facility
    ON public.facility_source_refs (facility_id);

CREATE TRIGGER update_facility_source_refs_modtime
    BEFORE UPDATE ON public.facility_source_refs
    FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();

ALTER TABLE public.facility_source_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "facility source refs are publicly readable"
    ON public.facility_source_refs FOR SELECT USING (true);

-- 한 RPC 호출 안에서만 시설과 출처를 함께 변경한다. 예외가 나면 PostgreSQL이 전부 롤백한다.
CREATE OR REPLACE FUNCTION public.apply_localdata_sync(actions JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    action JSONB;
    target_id UUID;
    inserted_count INT := 0;
    merged_count INT := 0;
    deactivated_count INT := 0;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required';
    END IF;

    FOR action IN SELECT value FROM jsonb_array_elements(actions)
    LOOP
        target_id := NULLIF(action->>'facility_id', '')::UUID;
        IF target_id IS NULL THEN
            INSERT INTO public.facilities
                (name, type, latitude, longitude, capacity, operating_hours, features, address, is_active)
            VALUES
                (action->>'name', action->>'type', (action->>'latitude')::double precision,
                 (action->>'longitude')::double precision, (action->>'capacity')::int,
                 COALESCE(action->'operating_hours', '{}'::jsonb), COALESCE(action->'features', '{}'::jsonb),
                 action->>'address', COALESCE((action->>'is_active')::boolean, false))
            RETURNING id INTO target_id;
            inserted_count := inserted_count + 1;
        ELSE
            -- LOCALDATA는 풍부한 TourAPI 필드를 덮지 않는다. 폐업 근거만 즉시 우선한다.
            IF COALESCE((action->>'is_active')::boolean, false) = false THEN
                UPDATE public.facilities SET is_active = false WHERE id = target_id;
                deactivated_count := deactivated_count + 1;
            ELSE
                -- 다른 LOCALDATA 휴업/폐업 근거가 하나라도 있으면 재활성화하지 않는다.
                UPDATE public.facilities f SET is_active = true
                WHERE f.id = target_id
                  AND NOT EXISTS (
                    SELECT 1 FROM public.facility_source_refs r
                    WHERE r.facility_id = f.id AND r.source = 'localdata'
                      AND r.external_id <> action->>'external_id'
                      AND COALESCE(r.source_status, '') <> '01'
                  )
                  AND NOT COALESCE((f.features->>'temporarily_inactive_until')::date >=
                                   (now() AT TIME ZONE 'Asia/Seoul')::date, false);
            END IF;
            merged_count := merged_count + 1;
        END IF;

        INSERT INTO public.facility_source_refs
            (facility_id, source, external_id, source_status, source_updated_at, source_hash)
        VALUES
            (target_id, 'localdata', action->>'external_id', action->>'source_status',
             NULLIF(action->>'source_updated_at', '')::timestamptz, action->>'source_hash')
        ON CONFLICT (source, external_id) DO UPDATE SET
            facility_id = EXCLUDED.facility_id,
            source_status = EXCLUDED.source_status,
            source_updated_at = EXCLUDED.source_updated_at,
            source_hash = EXCLUDED.source_hash;
    END LOOP;
    RETURN jsonb_build_object('inserted', inserted_count, 'merged', merged_count,
                              'deactivated', deactivated_count);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_localdata_sync(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_localdata_sync(JSONB) TO service_role;
