-- 서울 실시간 도시데이터 10분 수집 예약 — docs/CONGESTION_ENGINE_PLAN.md §5.3-1 · §8.
--
-- ⚠️ 사람이 **순서대로** 적용한다(자동 적용 없음):
--   1. Render 에 SEOUL_OPENDATA_KEY 를 넣고 재배포가 끝날 때까지 기다린다.
--      키 없이 예약부터 켜면 10분마다 503 seoul_key_missing 이 쌓인다(무해하지만 소음이다).
--   2. 20260920120000_seoul_citydata_snapshots.sql 을 먼저 적용하고 `NOTIFY pgrst, 'reload schema';`.
--   3. 이 파일을 적용한다.
--   4. 수집 URL 을 Vault 에 넣는다(값을 이 파일이나 cron 명령에 적지 않는다):
--        select public.configure_seoul_citydata_collection(
--          'https://<Render API 호스트>/api/v1/engine-validation/seoul/collect');
--      토큰은 **새로 만들지 않는다** — 경주 수집기가 이미 쓰는 Vault 비밀
--      nextspot_area_demand_admin_token 을 그대로 읽는다. 토큰 회전은 기존
--      configure_area_demand_collection 한 번으로 두 수집기에 같이 반영된다.
--
-- 모양은 20260824130000_schedule_area_demand_collection.sql 과 같다(Vault 에서 실행 시점에만 읽기,
-- net.http_post 발사 후 잊기, 버킷이 비었을 때만 보충 호출, 같은 이름 예약은 지우고 다시 만들기).
-- 분(minute)은 경주 잡(3·13·…/6·16·…)과 겹치지 않게 4·14·…(주)와 9·19·…(보충)로 둔다 —
-- Render 무료 인스턴스 하나가 두 수집을 같은 순간에 받지 않게 하려는 것이다.
--
-- 호출 예산: 대상지 1곳 기준 주 호출 144회/일(§4 반영 1). 보충 호출은 그 버킷이 **비었을 때만**
-- 나가므로 정상일 때는 0회, 서울 API 가 계속 실패하는 최악에도 288회/일을 넘지 않는다.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- service_role 로만 호출하는 설정 RPC. URL 만 받는다(토큰은 경주 수집기의 Vault 비밀을 공유).
CREATE OR REPLACE FUNCTION public.configure_seoul_citydata_collection(
    p_api_url TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, pg_temp
AS $$
DECLARE
    v_secret_id UUID;
BEGIN
    IF NULLIF(btrim(p_api_url), '') IS NULL
       OR p_api_url !~ '^https://[^[:space:]]+$' THEN
        RAISE EXCEPTION 'seoul citydata collector URL must use HTTPS';
    END IF;

    SELECT secret.id
      INTO v_secret_id
      FROM vault.secrets AS secret
     WHERE secret.name = 'nextspot_seoul_citydata_api_url'
     ORDER BY secret.created_at DESC
     LIMIT 1;

    IF v_secret_id IS NULL THEN
        PERFORM vault.create_secret(
            btrim(p_api_url),
            'nextspot_seoul_citydata_api_url',
            'NextSpot Seoul citydata collector HTTPS endpoint'
        );
    ELSE
        PERFORM vault.update_secret(
            v_secret_id,
            btrim(p_api_url),
            'nextspot_seoul_citydata_api_url',
            'NextSpot Seoul citydata collector HTTPS endpoint'
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.configure_seoul_citydata_collection(TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_seoul_citydata_collection(TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.request_seoul_citydata_collection(
    p_only_if_missing BOOLEAN DEFAULT false
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, net, extensions, pg_temp
AS $$
DECLARE
    v_bucket_at TIMESTAMPTZ;
    v_api_url TEXT;
    v_admin_token TEXT;
    v_request_id BIGINT;
BEGIN
    v_bucket_at := date_bin(
        INTERVAL '10 minutes',
        clock_timestamp(),
        TIMESTAMPTZ '1970-01-01 00:00:00+00'
    );

    -- :09/:19/... 보충 호출은 현재 10분 버킷에 이미 행이 있으면 외부 호출을 하지 않는다.
    -- 대상지가 여럿이면 "한 곳이라도 저장됐으면 건너뛴다" 가 된다 — 나머지 대상지의 실패는
    -- API 의 대상지별 상태(GET /seoul/status)에 남고, 다음 버킷에서 다시 시도된다.
    IF p_only_if_missing AND EXISTS (
        SELECT 1
          FROM public.seoul_citydata_snapshots AS snapshot
         WHERE snapshot.bucket_at = v_bucket_at
    ) THEN
        RETURN NULL;
    END IF;

    SELECT secret.decrypted_secret
      INTO v_api_url
      FROM vault.decrypted_secrets AS secret
     WHERE secret.name = 'nextspot_seoul_citydata_api_url'
     ORDER BY secret.created_at DESC
     LIMIT 1;

    SELECT secret.decrypted_secret
      INTO v_admin_token
      FROM vault.decrypted_secrets AS secret
     WHERE secret.name = 'nextspot_area_demand_admin_token'
     ORDER BY secret.created_at DESC
     LIMIT 1;

    IF NULLIF(btrim(v_api_url), '') IS NULL THEN
        RAISE EXCEPTION 'Vault secret nextspot_seoul_citydata_api_url is missing';
    END IF;
    IF NULLIF(btrim(v_admin_token), '') IS NULL THEN
        RAISE EXCEPTION 'Vault secret nextspot_area_demand_admin_token is missing';
    END IF;
    IF v_api_url !~ '^https://[^[:space:]]+$' THEN
        RAISE EXCEPTION 'seoul citydata collector URL must use HTTPS';
    END IF;

    SELECT net.http_post(
        url := rtrim(v_api_url, '/'),
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Admin-Authorization', 'Bearer ' || v_admin_token,
            'User-Agent', 'NextSpot-Supabase-Cron/1.0'
        ),
        body := jsonb_build_object(
            'scheduler', 'supabase_cron',
            'requested_at', clock_timestamp()
        ),
        timeout_milliseconds := 90000
    )
      INTO v_request_id;

    RETURN v_request_id;
END;
$$;

COMMENT ON FUNCTION public.request_seoul_citydata_collection(BOOLEAN) IS
    'Vault 인증으로 서울 실시간 도시데이터 수집 API를 비동기 호출한다. true이면 현재 10분 버킷 누락 시에만 호출.';

REVOKE ALL ON FUNCTION public.request_seoul_citydata_collection(BOOLEAN)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_seoul_citydata_collection(BOOLEAN)
    TO service_role;

-- RESET/재적용과 migration 재시도 시 동일 이름의 예약을 중복 생성하지 않는다.
DO $$
DECLARE
    v_job_id BIGINT;
BEGIN
    FOR v_job_id IN
        SELECT jobid
          FROM cron.job
         WHERE jobname IN (
             'nextspot-seoul-citydata-primary',
             'nextspot-seoul-citydata-retry'
         )
    LOOP
        PERFORM cron.unschedule(v_job_id);
    END LOOP;
END;
$$;

-- 경주 잡(3·13·…)과 1분 어긋나게 각 10분 버킷의 4분 시점에 실행한다.
SELECT cron.schedule(
    'nextspot-seoul-citydata-primary',
    '4,14,24,34,44,54 * * * *',
    $command$SELECT public.request_seoul_citydata_collection(false);$command$
);

-- 5분 뒤에도 해당 버킷이 비어 있을 때만 보충 호출한다(같은 버킷 안 — 9분 시점).
SELECT cron.schedule(
    'nextspot-seoul-citydata-retry',
    '9,19,29,39,49,59 * * * *',
    $command$SELECT public.request_seoul_citydata_collection(true);$command$
);
