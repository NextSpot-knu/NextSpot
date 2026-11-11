-- 사용자 행동 기록(action_logs) — 화면 방문·누름·입력·검색·음성·지도 조작 등 웹의 모든 동작을 행 단위로 남긴다.
--
-- 왜(2026-11-12): 부처 조사 뒤 공모전 재심사가 예정돼 있다. 심사위원이 서비스를 실제로 썼는지(언제 · 어느 기기로 ·
--   어느 계정으로 · 무엇을 눌렀는지)를 나중에 행으로 보여 줄 수 있어야 한다. usage_events(20261023090000)는 계정과
--   잇지 않고 추천 카드 이벤트 몇 개만 남겨 이 질문에 답하지 못한다.
--   결정(사용자, 11-12): 모든 방문을 남긴다 · 로그인 상태면 계정과 잇는다 · 원본 IP 를 남기고 1년 보관한다 ·
--   입력 내용은 검색·음성 문장만(브라우저가 가린 뒤) 남긴다.
--
-- 쓰기: 브라우저(apps/web/lib/actionLog.ts)가 공개 anon 키로 직접 INSERT 한다 — usage_events 와 같은 길.
--   · 브라우저가 정하는 칼럼은 9개뿐이다(occurred_at · device_id · session_id · seq · event · page · host · locale · props).
--     칼럼 GRANT 라 다른 칼럼을 보내면 그 INSERT 는 권한 오류로 거절된다.
--   · 나머지(received_at · user_id · is_anonymous · account_role · ip · ip_chain · user_agent)는 BEFORE INSERT 트리거가
--     보낸 값을 무시하고 서버에서 찍는다 — 수신 시각은 now(), 계정은 JWT(auth.uid · is_anonymous 클레임)와
--     public.users.role, IP·UA 는 PostgREST 가 넘기는 요청 헤더. 헤더가 없거나 깨져도 기록은 남긴다(그 칸만 NULL).
--   · 이벤트 이름은 아래 CHECK 목록뿐(lib/actionLog.ts 의 ACTION_LOG_EVENTS 와 같은 순서 — 하나를 더하면 둘 다 고친다).
-- 읽기: 브라우저 역할(anon·authenticated)에는 SELECT 가 없다. service_role(SQL Editor·API)과, users.role = 'developer'
--   만 통과하는 읽기 RPC 둘(action_log_devices · action_log_rows). 심사위원이 관리자 계정을 쓰므로 admin 은 통과하지 않는다.
-- 추가만(위·변조 방지): UPDATE 는 언제나, DELETE 는 365일이 안 된 행이면, TRUNCATE 는 언제나 트리거가 거절한다.
--   service_role 도 SELECT·INSERT 만 갖는다. 테이블 소유자(SQL Editor 의 postgres)는 트리거를 끄거나 표를 지울 수 있다 —
--   이 장치는 앱 역할과 실수로부터 기록을 지키는 것이지 DB 소유자를 막는 것은 아니다.
-- 보관: 1년. 매일 pg_cron 이 365일 지난 행을 지운다(DELETE 가드는 그 행들만 통과시킨다).
-- user_id 에 FK 를 걸지 않는다 — 계정이 지워져도 그 기간의 기록은 남아야 하고, ON DELETE SET NULL 이었다면 UPDATE 가드에
--   막혀 계정 삭제 자체가 실패한다. 이메일은 읽을 때 auth.users 에서 찾는다(지워진 계정이면 NULL).
-- 멱등: 표·인덱스 IF NOT EXISTS, 함수 CREATE OR REPLACE(읽기 RPC 는 DROP IF EXISTS 후 생성), 정책·트리거 DROP IF EXISTS
--   후 생성, cron 은 같은 이름을 먼저 지우고 다시 건다.

-- ── 1. 표 ───────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.action_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 브라우저가 쓰는 칼럼
    occurred_at TIMESTAMPTZ,
    device_id TEXT NOT NULL CHECK (char_length(device_id) BETWEEN 8 AND 64),
    session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 8 AND 64),
    seq INTEGER CHECK (seq IS NULL OR seq >= 0),
    event TEXT NOT NULL CHECK (event IN (
        'session_start',
        'page_view',
        'click',
        'input',
        'submit',
        'search',
        'voice',
        'key',
        'swipe',
        'scroll',
        'map',
        'visibility',
        'heartbeat',
        'api',
        'error',
        'auth'
    )),
    page TEXT CHECK (page IS NULL OR char_length(page) <= 200),
    host TEXT CHECK (host IS NULL OR char_length(host) <= 100),
    locale TEXT CHECK (locale IS NULL OR char_length(locale) <= 16),
    props JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(props) = 'object' AND pg_column_size(props) <= 4096),
    -- 서버가 찍는 칼럼(트리거가 덮어쓴다)
    user_id UUID,
    is_anonymous BOOLEAN,
    account_role TEXT,
    ip TEXT CHECK (ip IS NULL OR char_length(ip) <= 64),
    ip_chain TEXT CHECK (ip_chain IS NULL OR char_length(ip_chain) <= 300),
    user_agent TEXT CHECK (user_agent IS NULL OR char_length(user_agent) <= 400)
);

-- ── 2. 서버 도장(BEFORE INSERT) — 브라우저가 보낸 서버 칼럼 값은 쓰지 않는다 ─────────────────────────────
-- SECURITY DEFINER: anon·authenticated 는 public.users 를 못 읽는다(RLS). auth.uid()·auth.jwt()·request.headers 는
-- 세션 설정이라 소유자 권한으로 돌아도 호출한 요청의 값이다.
CREATE OR REPLACE FUNCTION public.action_logs_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uid UUID := auth.uid();
    v_role TEXT;
    v_raw TEXT;
    v_headers JSONB := '{}'::jsonb;
    v_xff TEXT;
BEGIN
    NEW.received_at := now();
    -- supabase-js 묶음 INSERT 는 한 행에 없는 키를 NULL 로 채운다 — props 하나 때문에 묶음 전체를 잃지 않게 한다.
    NEW.props := COALESCE(NEW.props, '{}'::jsonb);

    -- 계정: 로그인(게스트 익명 세션 포함) 상태면 잇는다. 로그인 전 방문은 user_id·is_anonymous·account_role 이 NULL.
    NEW.user_id := v_uid;
    IF v_uid IS NULL THEN
        NEW.is_anonymous := NULL;
        NEW.account_role := NULL;
    ELSE
        NEW.is_anonymous := COALESCE((auth.jwt() ->> 'is_anonymous')::boolean, false);
        SELECT u.role INTO v_role FROM public.users AS u WHERE u.id = v_uid;
        NEW.account_role := v_role;
    END IF;

    -- 요청 헤더: PostgREST 가 소문자 이름의 JSON 문자열로 넘긴다. SQL Editor·cron 에서는 없다. 없거나 깨져도 '{}'.
    BEGIN
        v_raw := current_setting('request.headers', true);
        IF v_raw IS NOT NULL AND btrim(v_raw) <> '' THEN
            v_headers := v_raw::jsonb;
        END IF;
        IF jsonb_typeof(v_headers) IS DISTINCT FROM 'object' THEN
            v_headers := '{}'::jsonb;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_headers := '{}'::jsonb;
    END;

    -- ip: cf-connecting-ip → x-real-ip → x-forwarded-for 첫 값(앞뒤 공백 제거) 중 처음 비어 있지 않은 것.
    -- ip_chain: x-forwarded-for 원문 — 배포 뒤 어느 헤더가 실제 손님 IP 를 싣는지 사람이 대조한다(파일 끝 확인 쿼리).
    v_xff := NULLIF(v_headers ->> 'x-forwarded-for', '');
    NEW.ip := left(COALESCE(
        NULLIF(btrim(v_headers ->> 'cf-connecting-ip'), ''),
        NULLIF(btrim(v_headers ->> 'x-real-ip'), ''),
        NULLIF(btrim(split_part(v_xff, ',', 1)), '')
    ), 64);
    NEW.ip_chain := left(v_xff, 300);
    NEW.user_agent := left(NULLIF(btrim(v_headers ->> 'user-agent'), ''), 400);
    RETURN NEW;
END;
$$;
-- 트리거 함수는 직접 부를 수 없고, 트리거 발화는 EXECUTE 권한을 보지 않는다 — 호출 권한은 아무에게도 주지 않는다.
REVOKE ALL ON FUNCTION public.action_logs_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS action_logs_stamp ON public.action_logs;
CREATE TRIGGER action_logs_stamp
    BEFORE INSERT ON public.action_logs
    FOR EACH ROW EXECUTE FUNCTION public.action_logs_stamp();

-- ── 3. 추가만 — UPDATE 언제나 · 365일 안 DELETE · TRUNCATE 거절 ─────────────────────────────────────────
-- SECURITY INVOKER(기본값): OLD 와 now() 만 본다.
CREATE OR REPLACE FUNCTION public.action_logs_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.received_at > now() - interval '365 days' THEN
            RAISE EXCEPTION 'action_logs_retained_365_days' USING ERRCODE = '42501',
                HINT = '365일이 지난 행만 지울 수 있다(보관 cron nextspot-action-logs-retention).';
        END IF;
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'action_logs_append_only' USING ERRCODE = '42501',
        DETAIL = format('%s is not allowed on public.action_logs', TG_OP);
END;
$$;
REVOKE ALL ON FUNCTION public.action_logs_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS action_logs_no_update ON public.action_logs;
CREATE TRIGGER action_logs_no_update
    BEFORE UPDATE ON public.action_logs
    FOR EACH ROW EXECUTE FUNCTION public.action_logs_guard();

DROP TRIGGER IF EXISTS action_logs_no_recent_delete ON public.action_logs;
CREATE TRIGGER action_logs_no_recent_delete
    BEFORE DELETE ON public.action_logs
    FOR EACH ROW EXECUTE FUNCTION public.action_logs_guard();

DROP TRIGGER IF EXISTS action_logs_no_truncate ON public.action_logs;
CREATE TRIGGER action_logs_no_truncate
    BEFORE TRUNCATE ON public.action_logs
    FOR EACH STATEMENT EXECUTE FUNCTION public.action_logs_guard();

-- ── 4. RLS · 권한 ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.action_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS action_logs_insert_any ON public.action_logs;
CREATE POLICY action_logs_insert_any ON public.action_logs
    FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS action_logs_service_select ON public.action_logs;
CREATE POLICY action_logs_service_select ON public.action_logs
    FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS action_logs_service_insert ON public.action_logs;
CREATE POLICY action_logs_service_insert ON public.action_logs
    FOR INSERT TO service_role WITH CHECK (true);

-- 2026-10-30부터 새 public 표는 Data API 권한을 자동으로 받지 않지만, 옛 기본 권한(ALL — UPDATE·DELETE·TRUNCATE 포함)이
-- 남은 DB 에서도 같은 결과가 되도록 service_role 까지 먼저 회수하고 필요한 것만 준다.
-- 브라우저: 고른 9칼럼 INSERT 만(읽기 없음 — supabase-js insert 는 return=minimal 이라 SELECT 가 필요 없다).
REVOKE ALL ON TABLE public.action_logs FROM anon, authenticated;
REVOKE ALL ON TABLE public.action_logs FROM PUBLIC, service_role;
GRANT INSERT (occurred_at, device_id, session_id, seq, event, page, host, locale, props)
    ON TABLE public.action_logs TO anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.action_logs TO service_role;

-- id 는 IDENTITY 라 INSERT 에 시퀀스 권한이 필요 없다(Postgres 가 권한 검사 없이 nextval 한다 — usage_events 도 같다).
-- 옛 기본 권한이 시퀀스에 준 것이 있으면 회수한다(setval 로 번호를 되돌리지 못하게).
DO $$
BEGIN
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM anon, authenticated',
                   pg_get_serial_sequence('public.action_logs', 'id'));
END;
$$;

-- ── 5. 인덱스 ────────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_action_logs_received_at
    ON public.action_logs (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_logs_device_received_at
    ON public.action_logs (device_id, received_at);
CREATE INDEX IF NOT EXISTS idx_action_logs_user_received_at
    ON public.action_logs (user_id, received_at)
    WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_action_logs_event_received_at
    ON public.action_logs (event, received_at DESC);

COMMENT ON TABLE public.action_logs IS
    '사용자 행동 기록(20261112090000) — 방문자(심사위원 포함)가 서비스를 실제로 썼는지 행 단위로 확인하는 용도. '
    '저장: 기기·세션 번호(브라우저가 만든 무작위 값), 이벤트·순번·브라우저 시각, 화면 경로·호스트·언어, 작은 속성(props 4 KB 이하 — '
    '입력 내용은 검색·음성 문장만, 브라우저가 가린 뒤), 서버가 찍는 수신 시각 · 로그인 상태일 때 계정(user_id·게스트 여부·역할) · '
    '원본 IP · x-forwarded-for 원문 · User-Agent. '
    '저장 안 함: 비밀번호, 검색·음성 밖의 입력 내용, 인증 토큰·apikey·쿠키 등 나머지 요청 헤더. '
    '추가만 가능(UPDATE · 365일 안 DELETE · TRUNCATE 는 트리거가 거절). 읽기는 service_role 과 developer 전용 RPC. 1년 보관(pg_cron).';
COMMENT ON COLUMN public.action_logs.ip IS
    '서버가 찍는 손님 IP — 요청 헤더 cf-connecting-ip → x-real-ip → x-forwarded-for 첫 값 순서로 처음 있는 값.';
COMMENT ON COLUMN public.action_logs.ip_chain IS
    '서버가 찍는 x-forwarded-for 원문(300자까지) — ip 가 어느 홉에서 왔는지 사람이 대조하는 용도.';

-- ── 6. 1년 보관 — 매일 03:37 KST(18:37 UTC) ──────────────────────────────────────────────────────────
-- 재적용해도 같은 이름 예약이 겹치지 않게 먼저 지운다. cron 은 소유자(postgres)로 돌아 칼럼 권한이 필요 없고,
-- 지우는 행은 모두 365일이 지나 DELETE 가드를 통과한다.
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
DECLARE
    v_job_id BIGINT;
BEGIN
    FOR v_job_id IN
        SELECT jobid FROM cron.job WHERE jobname = 'nextspot-action-logs-retention'
    LOOP
        PERFORM cron.unschedule(v_job_id);
    END LOOP;
END;
$$;

SELECT cron.schedule(
    'nextspot-action-logs-retention',
    '37 18 * * *',
    $command$DELETE FROM public.action_logs WHERE received_at < now() - interval '365 days';$command$
);

-- ── 7. 개발자 전용 읽기 RPC ───────────────────────────────────────────────────────────────────────
-- users.role = 'developer' 만 통과한다(get_auth_user_role — 20250523120001). is_admin_or_dev 를 쓰지 않는다:
-- 심사위원이 admin 계정을 쓰므로 admin 이 자기 기록을 볼 수 있으면 안 된다.
-- 기간은 received_at(서버 시각) 기준 [p_from, p_to). NULL 이면 그쪽 끝을 열어 둔다.

-- 기기별 요약 — 마지막 활동이 최근인 기기부터. limit 1..1000(기본 300).
--   accounts  게스트가 아닌 계정 행의 {user_id, email, role} 중복 없이(role 은 그 행을 찍을 때의 역할)
--   ips       서로 다른 IP 최대 10개(최근에 쓴 것부터)
--   user_agent 가장 최근 값 · landing/referrer 기간 안 첫 session_start 의 page 와 props.referrer
DROP FUNCTION IF EXISTS public.action_log_devices(TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INTEGER);
CREATE OR REPLACE FUNCTION public.action_log_devices(
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ,
    p_accounts_only BOOLEAN DEFAULT false,
    p_limit INTEGER DEFAULT 300
)
RETURNS TABLE (
    device_id TEXT,
    first_at TIMESTAMPTZ,
    last_at TIMESTAMPTZ,
    sessions INTEGER,
    events INTEGER,
    page_views INTEGER,
    clicks INTEGER,
    heartbeats INTEGER,
    accounts JSONB,
    ips TEXT[],
    user_agent TEXT,
    landing TEXT,
    referrer TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    v_from TIMESTAMPTZ;
    v_to TIMESTAMPTZ;
    v_accounts_only BOOLEAN;
    v_limit INTEGER;
BEGIN
    IF public.get_auth_user_role() IS DISTINCT FROM 'developer' THEN
        RAISE EXCEPTION 'developer_only' USING ERRCODE = '42501';
    END IF;
    v_from := COALESCE(p_from, '-infinity'::timestamptz);
    v_to := COALESCE(p_to, 'infinity'::timestamptz);
    v_accounts_only := COALESCE(p_accounts_only, false);
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 300), 1), 1000);

    RETURN QUERY
    WITH per_device AS (
        SELECT l.device_id AS dev,
               min(l.received_at) AS first_seen,
               max(l.received_at) AS last_seen,
               count(DISTINCT l.session_id)::integer AS n_sessions,
               count(*)::integer AS n_events,
               (count(*) FILTER (WHERE l.event = 'page_view'))::integer AS n_page_views,
               (count(*) FILTER (WHERE l.event = 'click'))::integer AS n_clicks,
               (count(*) FILTER (WHERE l.event = 'heartbeat'))::integer AS n_heartbeats,
               COALESCE(bool_or(l.is_anonymous = false), false) AS has_account
          FROM public.action_logs AS l
         WHERE l.received_at >= v_from AND l.received_at < v_to
         GROUP BY l.device_id
    ),
    picked AS (
        SELECT pd.*
          FROM per_device AS pd
         WHERE NOT v_accounts_only OR pd.has_account
         ORDER BY pd.last_seen DESC, pd.dev
         LIMIT v_limit
    )
    SELECT p.dev,
           p.first_seen,
           p.last_seen,
           p.n_sessions,
           p.n_events,
           p.n_page_views,
           p.n_clicks,
           p.n_heartbeats,
           COALESCE(acc.accounts_json, '[]'::jsonb),
           COALESCE(ipl.ip_list, ARRAY[]::text[]),
           ua.last_ua,
           land.landing_page,
           land.landing_referrer
      FROM picked AS p
      LEFT JOIN LATERAL (
          SELECT jsonb_agg(
                     jsonb_build_object('user_id', a.user_id, 'email', au.email, 'role', a.account_role)
                     ORDER BY a.first_seen, a.user_id
                 ) AS accounts_json
            FROM (
                SELECT l.user_id, l.account_role, min(l.received_at) AS first_seen
                  FROM public.action_logs AS l
                 WHERE l.device_id = p.dev
                   AND l.received_at >= v_from AND l.received_at < v_to
                   AND l.is_anonymous = false
                 GROUP BY l.user_id, l.account_role
            ) AS a
            LEFT JOIN auth.users AS au ON au.id = a.user_id
      ) AS acc ON true
      LEFT JOIN LATERAL (
          SELECT (array_agg(i.ip ORDER BY i.last_used DESC, i.ip))[1:10] AS ip_list
            FROM (
                SELECT l.ip, max(l.received_at) AS last_used
                  FROM public.action_logs AS l
                 WHERE l.device_id = p.dev
                   AND l.received_at >= v_from AND l.received_at < v_to
                   AND l.ip IS NOT NULL
                 GROUP BY l.ip
            ) AS i
      ) AS ipl ON true
      LEFT JOIN LATERAL (
          SELECT l.user_agent AS last_ua
            FROM public.action_logs AS l
           WHERE l.device_id = p.dev
             AND l.received_at >= v_from AND l.received_at < v_to
             AND l.user_agent IS NOT NULL
           ORDER BY l.received_at DESC, l.id DESC
           LIMIT 1
      ) AS ua ON true
      LEFT JOIN LATERAL (
          SELECT l.page AS landing_page, l.props ->> 'referrer' AS landing_referrer
            FROM public.action_logs AS l
           WHERE l.device_id = p.dev
             AND l.received_at >= v_from AND l.received_at < v_to
             AND l.event = 'session_start'
           ORDER BY l.received_at, l.id
           LIMIT 1
      ) AS land ON true
     ORDER BY p.last_seen DESC, p.dev;
END;
$$;
REVOKE ALL ON FUNCTION public.action_log_devices(TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.action_log_devices(TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN, INTEGER) TO authenticated;

-- 행 그대로 — id 오름차순 키셋(p_after_id 다음부터). 기기 하나로 좁힐 수 있다. limit 1..5000(기본 2000).
-- email 은 게스트가 아닌 계정 행에만 채운다.
DROP FUNCTION IF EXISTS public.action_log_rows(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, INTEGER);
CREATE OR REPLACE FUNCTION public.action_log_rows(
    p_from TIMESTAMPTZ,
    p_to TIMESTAMPTZ,
    p_device_id TEXT DEFAULT NULL,
    p_after_id BIGINT DEFAULT 0,
    p_limit INTEGER DEFAULT 2000
)
RETURNS TABLE (
    id BIGINT,
    received_at TIMESTAMPTZ,
    occurred_at TIMESTAMPTZ,
    device_id TEXT,
    session_id TEXT,
    seq INTEGER,
    event TEXT,
    page TEXT,
    host TEXT,
    locale TEXT,
    props JSONB,
    user_id UUID,
    email TEXT,
    is_anonymous BOOLEAN,
    account_role TEXT,
    ip TEXT,
    ip_chain TEXT,
    user_agent TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    v_device TEXT;
    v_limit INTEGER;
BEGIN
    IF public.get_auth_user_role() IS DISTINCT FROM 'developer' THEN
        RAISE EXCEPTION 'developer_only' USING ERRCODE = '42501';
    END IF;
    v_device := NULLIF(p_device_id, '');
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 5000);

    RETURN QUERY
    SELECT l.id,
           l.received_at,
           l.occurred_at,
           l.device_id,
           l.session_id,
           l.seq,
           l.event,
           l.page,
           l.host,
           l.locale,
           l.props,
           l.user_id,
           CASE WHEN l.is_anonymous = false THEN au.email::text END,
           l.is_anonymous,
           l.account_role,
           l.ip,
           l.ip_chain,
           l.user_agent
      FROM public.action_logs AS l
      LEFT JOIN auth.users AS au ON l.is_anonymous = false AND au.id = l.user_id
     WHERE l.received_at >= COALESCE(p_from, '-infinity'::timestamptz)
       AND l.received_at < COALESCE(p_to, 'infinity'::timestamptz)
       AND (v_device IS NULL OR l.device_id = v_device)
       AND l.id > COALESCE(p_after_id, 0)
     ORDER BY l.id
     LIMIT v_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.action_log_rows(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.action_log_rows(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, BIGINT, INTEGER) TO authenticated;

-- ── 적용 후(사람 작업) ────────────────────────────────────────────────────────────────────────────
-- 1) SQL Editor 에서 이 파일 전체를 실행한 뒤 `NOTIFY pgrst, 'reload schema';` 를 따로 실행한다(DEPLOY_AND_ENV §1-1).
--    빼먹으면 브라우저 INSERT 와 개발자 RPC 가 한동안 404(표·함수 없음)로 실패한다.
-- 2) 운영 주소에서 한두 번 눌러 본 뒤 확인(읽기 전용 — SQL Editor):
--    -- 최근 행과 IP 헤더 대조. ip 는 cf-connecting-ip → x-real-ip → x-forwarded-for 첫 값 순서로 고른 값이고
--    -- ip_chain 은 x-forwarded-for 원문이다. 그 시각 내 공인 IP(브라우저로 '내 IP' 확인)와 ip 가 같아야 한다.
--    -- ip_is_first_forwarded 가 false 면 x-forwarded-for 첫 값이 손님 IP 가 아니다(cf-connecting-ip·x-real-ip 쪽이 맞다).
--    select id, received_at, event, page, user_id, is_anonymous, account_role, ip, ip_chain,
--           ip = btrim(split_part(ip_chain, ',', 1)) as ip_is_first_forwarded, left(user_agent, 60) as ua
--      from public.action_logs order by id desc limit 20;
--    -- 1년 보관 예약이 하나 있는가:
--    select jobid, jobname, schedule, command from cron.job where jobname = 'nextspot-action-logs-retention';
--    -- 가드 트리거 넷(action_logs_stamp · action_logs_no_update · action_logs_no_recent_delete · action_logs_no_truncate):
--    select tgname from pg_trigger where tgrelid = 'public.action_logs'::regclass and not tgisinternal order by 1;
