-- 익명 이용 기록(제품 분석) — 어떤 화면을 열고, 추천 카드에서 무엇을 눌렀는지.
--
-- 왜: 방문자 단위 기록이 없어 '첫 카드를 본 사람 중 몇 %가 대안으로 걸어갔나' 같은 실적을 셀 수 없었다
-- (10-21 심사 방문 분석 때 방문자를 구분하지 못했다). 외부 분석 업체 없이 우리 DB 에 쌓는다(10-23 PM 결정).
--
-- 담는 것: 브라우저가 만든 익명 번호(anon_id·session_id), 이벤트 이름, 화면 경로, 작은 속성(장소 종류·id·순위 등).
-- 담지 않는 것: 이름·계정·위치·검색어. user_id 칼럼이 없어 계정과 이어지지 않는다.
-- 쓰기: 브라우저(anon·authenticated — 관광객은 익명 세션이라 authenticated)가 INSERT 만, 칼럼을 골라서.
--   created_at·id 는 서버가 정한다. 이벤트 이름 화이트리스트(lib/usageEvents.ts 와 같은 목록)와 길이 상한을
--   CHECK 로 걸어 행 하나가 ~1.3 KB 를 넘지 않는다.
-- 읽기: service_role(SQL Editor·관리자 API)만. 1년 지난 행은 매일 지운다(개인정보 안내 화면과 같은 약속).

CREATE TABLE IF NOT EXISTS public.usage_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    anon_id TEXT NOT NULL CHECK (char_length(anon_id) BETWEEN 8 AND 64),
    session_id TEXT CHECK (session_id IS NULL OR char_length(session_id) BETWEEN 8 AND 64),
    event TEXT NOT NULL CHECK (event IN (
        'page_view',
        'rec_shown',
        'rec_accept',
        'rec_drive',
        'rec_next',
        'rec_later',
        'visit_arrived',
        'visit_congestion',
        'congestion_report'
    )),
    page TEXT CHECK (page IS NULL OR char_length(page) <= 120),
    locale TEXT CHECK (locale IS NULL OR char_length(locale) <= 8),
    props JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(props) = 'object' AND pg_column_size(props) <= 1024)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_created_at
    ON public.usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_event_created_at
    ON public.usage_events (event, created_at DESC);

ALTER TABLE public.usage_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS usage_events_insert_any ON public.usage_events;
CREATE POLICY usage_events_insert_any ON public.usage_events
    FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS usage_events_service_all ON public.usage_events;
CREATE POLICY usage_events_service_all ON public.usage_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2026-10-30부터 새 public 테이블은 Data API 권한을 자동으로 받지 않는다 — 전부 명시한다.
-- 브라우저는 고른 칼럼에만 INSERT(읽기 없음). supabase-js insert 는 return=minimal 이라 SELECT 가 필요 없다.
REVOKE ALL ON TABLE public.usage_events FROM anon, authenticated;
GRANT INSERT (anon_id, session_id, event, page, locale, props) ON TABLE public.usage_events TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usage_events TO service_role;

COMMENT ON TABLE public.usage_events IS
    '익명 이용 기록(화면·추천 카드 반응). 계정·위치·검색어 없음. 브라우저는 INSERT 만, 읽기는 service_role. 1년 보관.';

-- 1년 보관 — 매일 03:23 KST(18:23 UTC)에 지난 행을 지운다. 재적용해도 같은 이름 예약이 겹치지 않게 먼저 지운다.
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
DECLARE
    v_job_id BIGINT;
BEGIN
    FOR v_job_id IN
        SELECT jobid FROM cron.job WHERE jobname = 'nextspot-usage-events-retention'
    LOOP
        PERFORM cron.unschedule(v_job_id);
    END LOOP;
END;
$$;

SELECT cron.schedule(
    'nextspot-usage-events-retention',
    '23 18 * * *',
    $command$DELETE FROM public.usage_events WHERE created_at < now() - interval '365 days';$command$
);

-- 적용 후 SQL Editor 에서 `NOTIFY pgrst, 'reload schema';` 를 따로 실행한다(DEPLOY_AND_ENV §1-1).
-- 빼먹으면 브라우저 INSERT 가 한동안 404(표 없음)로 실패한다 — 웹은 첫 실패 뒤 그 탭에서 기록을 멈춘다.

-- 집계 예시(읽기 전용 — SQL Editor 에서 필요한 것만 골라 실행):
--
-- 일별 방문자(익명 번호 기준, KST):
--   select (created_at at time zone 'Asia/Seoul')::date as day, count(distinct anon_id) as visitors
--     from public.usage_events group by 1 order by 1 desc limit 30;
--
-- 최근 7일 /main 흐름 — 추천 카드를 본 방문자 → 바로 갈래요(도보·자동차) → 도착 확인:
--   select count(distinct anon_id) filter (where event = 'rec_shown' and page = '/main') as saw_card,
--          count(distinct anon_id) filter (where event in ('rec_accept', 'rec_drive')) as went,
--          count(distinct anon_id) filter (where event = 'visit_arrived') as arrived
--     from public.usage_events where created_at > now() - interval '7 days';
--
-- 버튼별 횟수(최근 7일): select event, count(*) from public.usage_events
--   where created_at > now() - interval '7 days' group by 1 order by 2 desc;
