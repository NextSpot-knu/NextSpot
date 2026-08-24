-- GitHub Actions의 best-effort 예약 대신 Supabase 내부 Cron이 10분 수집을 책임진다.
-- 비밀값은 migration/cron command에 넣지 않고 Vault에서 실행 시점에만 읽는다.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- service_role로만 호출하는 설정 RPC. 운영 토큰을 SQL 파일이나 cron.job.command에 남기지 않고
-- 최초 설정과 이후 회전에 같은 경로를 사용한다.
CREATE OR REPLACE FUNCTION public.configure_area_demand_collection(
    p_api_url TEXT,
    p_admin_token TEXT
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
        RAISE EXCEPTION 'area demand collector URL must use HTTPS';
    END IF;
    IF length(COALESCE(p_admin_token, '')) < 16 THEN
        RAISE EXCEPTION 'area demand collector token is invalid';
    END IF;

    SELECT secret.id
      INTO v_secret_id
      FROM vault.secrets AS secret
     WHERE secret.name = 'nextspot_area_demand_api_url'
     ORDER BY secret.created_at DESC
     LIMIT 1;

    IF v_secret_id IS NULL THEN
        PERFORM vault.create_secret(
            btrim(p_api_url),
            'nextspot_area_demand_api_url',
            'NextSpot area-demand collector HTTPS endpoint'
        );
    ELSE
        PERFORM vault.update_secret(
            v_secret_id,
            btrim(p_api_url),
            'nextspot_area_demand_api_url',
            'NextSpot area-demand collector HTTPS endpoint'
        );
    END IF;

    v_secret_id := NULL;
    SELECT secret.id
      INTO v_secret_id
      FROM vault.secrets AS secret
     WHERE secret.name = 'nextspot_area_demand_admin_token'
     ORDER BY secret.created_at DESC
     LIMIT 1;

    IF v_secret_id IS NULL THEN
        PERFORM vault.create_secret(
            p_admin_token,
            'nextspot_area_demand_admin_token',
            'Existing Render ADMIN_API_TOKEN used by the scheduled collector'
        );
    ELSE
        PERFORM vault.update_secret(
            v_secret_id,
            p_admin_token,
            'nextspot_area_demand_admin_token',
            'Existing Render ADMIN_API_TOKEN used by the scheduled collector'
        );
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.configure_area_demand_collection(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_area_demand_collection(TEXT, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.request_area_demand_collection(
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

    -- :06/:16/... 재시도는 현재 10분 버킷이 이미 저장됐다면 외부 호출도 하지 않는다.
    IF p_only_if_missing AND EXISTS (
        SELECT 1
          FROM public.area_demand_snapshots AS snapshot
         WHERE snapshot.source = 'gyeongju_its'
           AND snapshot.bucket_minutes = 10
           AND snapshot.bucket_at = v_bucket_at
    ) THEN
        RETURN NULL;
    END IF;

    SELECT secret.decrypted_secret
      INTO v_api_url
      FROM vault.decrypted_secrets AS secret
     WHERE secret.name = 'nextspot_area_demand_api_url'
     ORDER BY secret.created_at DESC
     LIMIT 1;

    SELECT secret.decrypted_secret
      INTO v_admin_token
      FROM vault.decrypted_secrets AS secret
     WHERE secret.name = 'nextspot_area_demand_admin_token'
     ORDER BY secret.created_at DESC
     LIMIT 1;

    IF NULLIF(btrim(v_api_url), '') IS NULL THEN
        RAISE EXCEPTION 'Vault secret nextspot_area_demand_api_url is missing';
    END IF;
    IF NULLIF(btrim(v_admin_token), '') IS NULL THEN
        RAISE EXCEPTION 'Vault secret nextspot_area_demand_admin_token is missing';
    END IF;
    IF v_api_url !~ '^https://[^[:space:]]+$' THEN
        RAISE EXCEPTION 'area demand collector URL must use HTTPS';
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

COMMENT ON FUNCTION public.request_area_demand_collection(BOOLEAN) IS
    'Vault 인증으로 실측 주차 스냅샷 수집 API를 비동기 호출한다. true이면 현재 10분 버킷 누락 시에만 호출.';

REVOKE ALL ON FUNCTION public.request_area_demand_collection(BOOLEAN)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_area_demand_collection(BOOLEAN)
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
             'nextspot-area-demand-primary',
             'nextspot-area-demand-retry'
         )
    LOOP
        PERFORM cron.unschedule(v_job_id);
    END LOOP;
END;
$$;

-- 정각의 공용 인프라 부하를 피해 각 10분 버킷의 3분 시점에 실행한다.
SELECT cron.schedule(
    'nextspot-area-demand-primary',
    '3,13,23,33,43,53 * * * *',
    $command$SELECT public.request_area_demand_collection(false);$command$
);

-- 3분 뒤에도 해당 버킷이 비어 있을 때만 보충 호출한다.
SELECT cron.schedule(
    'nextspot-area-demand-retry',
    '6,16,26,36,46,56 * * * *',
    $command$SELECT public.request_area_demand_collection(true);$command$
);
