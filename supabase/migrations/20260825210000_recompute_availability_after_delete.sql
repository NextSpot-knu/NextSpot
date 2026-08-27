-- 한 사용자의 탈퇴/게스트 병합/관리 정리로 제보가 삭제되면 남은 근거의 인원수와
-- corroborated 상태를 즉시 다시 계산한다. 삭제 전 2명이었던 근거를 1명으로 남겨 두지 않는다.

-- 최근 30분에 속하지 않는 보존 행은 일치 인원이 0일 수 있다. 이 값은 추천에 쓰이지 않으며
-- 다음 정리/덮어쓰기 전까지 사실 그대로 저장할 수 있게 한다.
ALTER TABLE public.facility_availability_reports
    DROP CONSTRAINT IF EXISTS facility_availability_reports_corroborating_count_check;
ALTER TABLE public.facility_availability_reports
    ADD CONSTRAINT facility_availability_reports_corroborating_count_check
    CHECK (corroborating_count >= 0);

CREATE OR REPLACE FUNCTION public.recompute_facility_availability_evidence(
    p_facility_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    server_now TIMESTAMPTZ := clock_timestamp();
BEGIN
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
           END
      FROM counts
     WHERE report.facility_id = p_facility_id
       AND report.status = counts.status;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_facility_availability_evidence(UUID)
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_facility_availability_after_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM public.recompute_facility_availability_evidence(OLD.facility_id);
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_facility_availability_after_delete()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_refresh_facility_availability_after_delete
    ON public.facility_availability_reports;
CREATE TRIGGER trg_refresh_facility_availability_after_delete
AFTER DELETE ON public.facility_availability_reports
FOR EACH ROW
EXECUTE FUNCTION public.refresh_facility_availability_after_delete();
