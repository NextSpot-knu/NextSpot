-- 구역 '평소와 비교' 기준선 — 화면 문구 전용(docs/SEOUL_TESTBED_PLAN.md §6 S3).
--
-- 추천 순위는 **절대 혼잡 단계**(서울시 4등급 → 0~1)로 정한다. 이 함수는 순위에 들어가지 않고, 내부 서울 화면의
-- '평소보다 붐빔 · 평소 수준 · 평소보다 한산' 한 줄만 만든다(엔진 score 는 읽지 않는다).
--
-- 기준선 = 같은 구역 · 같은 KST 시(hour) · 같은 요일 구분(평일 / 주말)의 지난 p_days 일 인구 중간값 분포.
--   · 인구 = 서울시 실시간 인구 구간의 가운데 (population_min + population_max) / 2.
--   · 먼저 겹친 관측을 하나로 합친다 — DISTINCT ON (zone_id, observed_at). 서울시 PPLTN_TIME 은 10분 버킷 여러 개에
--     같은 값으로 반복되고, 홍대는 10분마다 · 나머지는 30분마다 모은다. 합치지 않으면 자주 모은 구역·시각이
--     기준선을 끌고 간다. 같은 관측이 여러 번이면 가장 늦게 받은(fetched_at) 행을 쓴다.
--   · 서울시가 실측 대신 대체값을 넣은 관측(quality.replaced = true)과 인구 구간이 빈 관측은 뺀다.
--   · p_at 에서 1시간 안쪽의 관측은 뺀다 — '지금'이 자기 기준선에 섞이지 않게.
--   · samples = 합친 뒤의 서로 다른 관측 수. 표본이 몇 개면 문구를 띄울지는 API 가 정한다.
--   · 표본이 0인 구역은 행이 없다.
--
-- 권한: service_role 전용(서울은 내부 전용 — §7 A1). SECURITY INVOKER 라 호출자의 RLS 를 그대로 따른다
--   (zone_crowd_snapshots 는 service_role 정책만 있다).
-- 의존: 20261031120000_crowd_zones.sql(zone_crowd_snapshots).
-- 멱등: CREATE OR REPLACE. 적용 후 `NOTIFY pgrst, 'reload schema';` 를 따로 실행한다(DEPLOY_AND_ENV §1-1).

CREATE OR REPLACE FUNCTION public.zone_population_baseline(
    p_zone_ids TEXT[],
    p_at TIMESTAMPTZ,
    p_days INTEGER DEFAULT 28
)
RETURNS TABLE (
    zone_id TEXT,
    samples INTEGER,
    p25 DOUBLE PRECISION,
    p50 DOUBLE PRECISION,
    p75 DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH target AS (
        SELECT (p_at AT TIME ZONE 'Asia/Seoul') AS local_at,
               LEAST(GREATEST(COALESCE(p_days, 28), 1), 90) AS days
    ),
    deduped AS (
        SELECT DISTINCT ON (s.zone_id, s.observed_at)
               s.zone_id AS zone_id,
               s.observed_at AS observed_at,
               (s.population_min::DOUBLE PRECISION + s.population_max::DOUBLE PRECISION) / 2 AS population_mid
          FROM public.zone_crowd_snapshots AS s, target AS t
         WHERE s.zone_id = ANY (p_zone_ids)
           AND s.observed_at >= p_at - make_interval(days => t.days)
           AND s.observed_at < p_at - interval '1 hour'
           AND s.population_min IS NOT NULL
           AND s.population_max IS NOT NULL
           AND (s.quality ->> 'replaced') IS DISTINCT FROM 'true'
         ORDER BY s.zone_id, s.observed_at, s.fetched_at DESC, s.id
    ),
    matched AS (
        SELECT d.zone_id AS zone_id, d.population_mid AS population_mid
          FROM deduped AS d, target AS t
         WHERE extract(hour FROM (d.observed_at AT TIME ZONE 'Asia/Seoul')) = extract(hour FROM t.local_at)
           AND (extract(isodow FROM (d.observed_at AT TIME ZONE 'Asia/Seoul')) IN (6, 7))
               = (extract(isodow FROM t.local_at) IN (6, 7))
    )
    SELECT m.zone_id,
           count(*)::INTEGER,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY m.population_mid),
           percentile_cont(0.50) WITHIN GROUP (ORDER BY m.population_mid),
           percentile_cont(0.75) WITHIN GROUP (ORDER BY m.population_mid)
      FROM matched AS m
     GROUP BY m.zone_id
     ORDER BY m.zone_id;
$$;

REVOKE ALL ON FUNCTION public.zone_population_baseline(TEXT[], TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zone_population_baseline(TEXT[], TIMESTAMPTZ, INTEGER) TO service_role;

COMMENT ON FUNCTION public.zone_population_baseline(TEXT[], TIMESTAMPTZ, INTEGER) IS
    '구역 인구의 평소 분포(같은 KST 시 · 평일/주말, 관측 중복 제거) — 화면의 ''평소와 비교'' 문구 전용, 추천 순위에 쓰지 않는다. service_role 전용.';
