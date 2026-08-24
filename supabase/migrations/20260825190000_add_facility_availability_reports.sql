-- 카카오맵 등 공식 상세에서 사용자가 직접 확인한 단기 영업 상태를 수집한다.
-- 단일 제보는 화면 참고용이며, 서로 다른 사용자 2명의 최근 일치 제보만 추천 자격에 사용한다.

CREATE TABLE IF NOT EXISTS public.facility_availability_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    reporter_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    evidence_tier TEXT NOT NULL DEFAULT 'single_report'
        CHECK (evidence_tier IN ('single_report', 'corroborated')),
    corroborating_count INTEGER NOT NULL DEFAULT 1 CHECK (corroborating_count >= 1),
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (facility_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS idx_facility_availability_effective
    ON public.facility_availability_reports (facility_id, status, reported_at DESC)
    WHERE evidence_tier = 'corroborated';
CREATE INDEX IF NOT EXISTS idx_facility_availability_expiry
    ON public.facility_availability_reports (expires_at);

ALTER TABLE public.facility_availability_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all_facility_availability_reports
    ON public.facility_availability_reports;
CREATE POLICY service_role_all_facility_availability_reports
    ON public.facility_availability_reports FOR ALL TO service_role
    USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS select_own_facility_availability_reports
    ON public.facility_availability_reports;
CREATE POLICY select_own_facility_availability_reports
    ON public.facility_availability_reports FOR SELECT TO authenticated
    USING (reporter_user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.record_facility_availability_report(
    p_facility_id UUID,
    p_reporter_user_id UUID,
    p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    server_now TIMESTAMPTZ := clock_timestamp();
    matching_count INTEGER;
    current_row public.facility_availability_reports%ROWTYPE;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;
    IF p_status NOT IN ('open', 'closed') THEN
        RAISE EXCEPTION 'invalid availability status' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.facilities WHERE id = p_facility_id) THEN
        RAISE EXCEPTION 'facility not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_reporter_user_id) THEN
        RAISE EXCEPTION 'reporter not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_facility_id::TEXT, 0));

    INSERT INTO public.facility_availability_reports (
        facility_id, reporter_user_id, status, evidence_tier,
        corroborating_count, reported_at, expires_at
    ) VALUES (
        p_facility_id, p_reporter_user_id, p_status, 'single_report',
        1, server_now,
        server_now + CASE WHEN p_status = 'open' THEN INTERVAL '30 minutes' ELSE INTERVAL '60 minutes' END
    )
    ON CONFLICT (facility_id, reporter_user_id) DO UPDATE
       SET status = EXCLUDED.status,
           evidence_tier = 'single_report',
           corroborating_count = 1,
           reported_at = EXCLUDED.reported_at,
           expires_at = EXCLUDED.expires_at;

    -- 현재 시설의 두 상태를 모두 다시 계산한다. 사용자가 의견을 바꾼 경우 이전 상태가
    -- corroborated 로 남는 것을 막는다. open/closed 표가 같으면 어느 쪽도 추천 판단에
    -- 사용하지 않는다. 2명 이상이면서 반대 상태보다 많은 쪽만 corroborated 로 승격한다.
    WITH counts AS (
        SELECT status,
               COUNT(DISTINCT reporter_user_id) FILTER (
                   WHERE reported_at >= server_now - INTERVAL '30 minutes'
               )::INTEGER AS user_count
          FROM public.facility_availability_reports
         WHERE facility_id = p_facility_id
         GROUP BY status
    )
    UPDATE public.facility_availability_reports AS report
       SET corroborating_count = counts.user_count,
           evidence_tier = CASE
               WHEN counts.user_count >= 2
                AND counts.user_count > COALESCE((
                    SELECT opposing.user_count
                      FROM counts AS opposing
                     WHERE opposing.status <> report.status
                ), 0)
               THEN 'corroborated'
               ELSE 'single_report'
           END,
           expires_at = CASE
               WHEN counts.user_count >= 2
                AND counts.user_count > COALESCE((
                    SELECT opposing.user_count
                      FROM counts AS opposing
                     WHERE opposing.status <> report.status
                ), 0)
               THEN server_now + CASE
                   WHEN report.status = 'open' THEN INTERVAL '30 minutes'
                   ELSE INTERVAL '60 minutes'
               END
               ELSE report.reported_at + CASE
                   WHEN report.status = 'open' THEN INTERVAL '30 minutes'
                   ELSE INTERVAL '60 minutes'
               END
           END
      FROM counts
     WHERE report.facility_id = p_facility_id
       AND report.status = counts.status;

    SELECT COUNT(DISTINCT reporter_user_id)::INTEGER
      INTO matching_count
      FROM public.facility_availability_reports
     WHERE facility_id = p_facility_id
       AND status = p_status
       AND reported_at >= server_now - INTERVAL '30 minutes';

    SELECT * INTO current_row
      FROM public.facility_availability_reports
     WHERE facility_id = p_facility_id
       AND reporter_user_id = p_reporter_user_id;

    RETURN jsonb_build_object(
        'facility_id', current_row.facility_id,
        'status', current_row.status,
        'evidence_tier', current_row.evidence_tier,
        'corroborating_count', matching_count,
        'reported_at', current_row.reported_at,
        'expires_at', current_row.expires_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_facility_availability_report(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_facility_availability_report(UUID, UUID, TEXT)
    TO service_role;

-- 익명 사용자가 영업 상태를 제보한 뒤 기존 계정으로 로그인해도 같은 사람을 두 명으로 세지 않는다.
-- 직전 migration의 계정 병합 본체를 보존하고, 영업 제보 병합까지 같은 트랜잭션에서 수행하는 래퍼로 확장한다.
ALTER FUNCTION public.merge_guest_account_data(UUID, UUID)
    RENAME TO merge_guest_account_data_without_availability;
REVOKE ALL ON FUNCTION public.merge_guest_account_data_without_availability(UUID, UUID)
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.merge_guest_account_data(
    p_guest_user_id UUID,
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    result JSONB;
    affected_facility_ids UUID[];
    moved_count INTEGER := 0;
    server_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;

    -- 기존 병합 함수가 사용자 행 잠금과 나머지 데이터 병합을 수행한다. 이 래퍼에서 오류가
    -- 발생하면 같은 호출 트랜잭션 전체가 롤백되어 부분 병합이 남지 않는다.
    result := public.merge_guest_account_data_without_availability(
        p_guest_user_id, p_target_user_id
    );
    IF p_guest_user_id = p_target_user_id THEN
        RETURN result || jsonb_build_object('availability_reports', 0);
    END IF;

    SELECT ARRAY_AGG(DISTINCT facility_id)
      INTO affected_facility_ids
      FROM public.facility_availability_reports
     WHERE reporter_user_id IN (p_guest_user_id, p_target_user_id);

    -- 양쪽 계정이 같은 장소를 이미 확인했다면 target 한 건만 보존한다. 그렇지 않은 게스트
    -- 제보만 target으로 이동하므로 동일인이 corroborating_count를 두 번 올릴 수 없다.
    DELETE FROM public.facility_availability_reports AS guest_report
     USING public.facility_availability_reports AS target_report
     WHERE guest_report.reporter_user_id = p_guest_user_id
       AND target_report.reporter_user_id = p_target_user_id
       AND guest_report.facility_id = target_report.facility_id;

    UPDATE public.facility_availability_reports
       SET reporter_user_id = p_target_user_id
     WHERE reporter_user_id = p_guest_user_id;
    GET DIAGNOSTICS moved_count = ROW_COUNT;

    IF affected_facility_ids IS NOT NULL THEN
        WITH counts AS (
            SELECT facility_id, status,
                   COUNT(DISTINCT reporter_user_id) FILTER (
                       WHERE reported_at >= server_now - INTERVAL '30 minutes'
                   )::INTEGER AS user_count
              FROM public.facility_availability_reports
             WHERE facility_id = ANY(affected_facility_ids)
             GROUP BY facility_id, status
        )
        UPDATE public.facility_availability_reports AS report
           SET corroborating_count = counts.user_count,
               evidence_tier = CASE
                   WHEN counts.user_count >= 2
                    AND counts.user_count > COALESCE((
                        SELECT opposing.user_count
                          FROM counts AS opposing
                         WHERE opposing.facility_id = report.facility_id
                           AND opposing.status <> report.status
                    ), 0)
                   THEN 'corroborated'
                   ELSE 'single_report'
               END
          FROM counts
         WHERE report.facility_id = counts.facility_id
           AND report.status = counts.status;
    END IF;

    RETURN result || jsonb_build_object('availability_reports', moved_count);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_guest_account_data(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_guest_account_data(UUID, UUID)
    TO service_role;
