-- 익명 이용 기록 집계 — 관제 대시보드의 '서비스 이용 현황' 패널(10-24).
--
-- usage_events 는 브라우저가 쓰기만 하고 읽지 못한다(20261023090000). 관리자 화면도 같은 브라우저 클라이언트라
-- 행을 직접 읽을 수 없으므로, 관리자(is_admin_or_dev)에게만 **집계 숫자**를 돌려주는 함수를 둔다 — 행·익명 번호는
-- 밖으로 나가지 않는다. 기간은 1~90일(기본 7일), 날짜는 KST.
--   visitors  기간 안 익명 방문자 수
--   saw_card  /main 에서 추천 카드를 본 방문자
--   went      바로 갈래요(도보·자동차)를 누른 방문자
--   arrived   도착 확인을 한 방문자
--   daily     날짜별 방문자 [{day, visitors}]
--   events    이벤트별 횟수 {event: n}

CREATE OR REPLACE FUNCTION public.usage_summary(p_days INTEGER DEFAULT 7)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_days INTEGER := LEAST(GREATEST(COALESCE(p_days, 7), 1), 90);
    v_since TIMESTAMPTZ;
BEGIN
    IF NOT public.is_admin_or_dev() THEN
        RAISE EXCEPTION 'admin_only' USING ERRCODE = '42501';
    END IF;
    v_since := now() - make_interval(days => v_days);
    RETURN jsonb_build_object(
        'days', v_days,
        'visitors', (SELECT count(DISTINCT anon_id) FROM public.usage_events WHERE created_at >= v_since),
        'saw_card', (SELECT count(DISTINCT anon_id) FROM public.usage_events
                      WHERE created_at >= v_since AND event = 'rec_shown' AND page = '/main'),
        'went', (SELECT count(DISTINCT anon_id) FROM public.usage_events
                  WHERE created_at >= v_since AND event IN ('rec_accept', 'rec_drive')),
        'arrived', (SELECT count(DISTINCT anon_id) FROM public.usage_events
                     WHERE created_at >= v_since AND event = 'visit_arrived'),
        'daily', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('day', d, 'visitors', n) ORDER BY d)
              FROM (
                  SELECT (created_at AT TIME ZONE 'Asia/Seoul')::date AS d, count(DISTINCT anon_id) AS n
                    FROM public.usage_events
                   WHERE created_at >= v_since
                   GROUP BY 1
              ) t
        ), '[]'::jsonb),
        'events', COALESCE((
            SELECT jsonb_object_agg(event, n)
              FROM (
                  SELECT event, count(*) AS n
                    FROM public.usage_events
                   WHERE created_at >= v_since
                   GROUP BY event
              ) e
        ), '{}'::jsonb)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.usage_summary(INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.usage_summary(INTEGER) TO authenticated;

-- 적용 후 `NOTIFY pgrst, 'reload schema';` — PostgREST 가 이 RPC 를 봐야 관제 패널이 부를 수 있다.
