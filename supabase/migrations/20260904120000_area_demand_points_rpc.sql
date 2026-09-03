-- 후보 지점 주변 2km 주차 수요 시계열을 Postgres 한 번의 GROUP BY 로 집계한다.
--
-- 왜: 추천은 후보 **한 곳마다** 이 시계열을 필요로 하는데, 지금까지는 백엔드가 56일치
-- 주차장 원본(area_demand_snapshot_lots 수십만 행)을 프로세스 메모리에 통째로 올려 두고
-- 후보마다 파이썬 루프로 다시 훑었다. 후보당 0.28~6.4초가 나와 프런트 10초 타임아웃 안에
-- 추천이 끝나지 않았고, 상주 캐시도 52MB 를 차지했다. 집계 자체는 DB 가 한 번의 왕복으로
-- 할 수 있는 일이다.
--
-- ⚠️ 이 함수는 파이썬 aggregate_nearby_points() 와 **같은 값**을 내야 한다. 아래 수식은
--    apps/api/app/services/area_demand_forecast_service.py 의 집계와 spot/travel.py 의
--    calculate_haversine_distance() 를 연산 순서까지 그대로 옮긴 것이다. 바꾸려면 양쪽을
--    같이 바꾸고 test_area_demand_forecast_service.py 의 대조 테스트를 갱신할 것.
--
--    거리 = round(6371000 * (2 * asin(min(1, sqrt(a)))), 1)          -- 데시미터 반올림까지 동일
--      a  = sin((rad(lat2) - rad(lat1)) / 2)^2
--           + cos(rad(lat1)) * cos(rad(lat2)) * sin((rad(lng2) - rad(lng1)) / 2)^2
--    점유율 = 1 - available_spaces / total_spaces
--    가중치 = min(total_spaces, 500) / (1 + 거리 / 500)
--    수요   = clamp(Σ(점유율 * 가중치) / Σ가중치, 0, 1)              -- 스냅샷(=관측 시점)별
--
--    radians 를 먼저 취한 뒤 빼는 순서(rad(a) - rad(b), rad(a-b) 아님)까지 파이썬과 같다.

-- 반환 타입은 SETOF 가 아니라 JSONB 단일 값이다. PostgREST 는 단일 응답 행수를 캡하는데
-- (Supabase 기본 1000, apps/api/app/core/supabase.py 의 fetch_all_rows 주석 참조) 56일치
-- 시계열은 10분 간격 기준 8,064 포인트라 SETOF 로 돌려주면 **조용히 잘린다**. 잘린 시계열은
-- 백테스트 품질 게이트를 통과할 수도 있어(표본만 줄어듦) 눈에 띄지 않는 오염이 된다.
-- 한 행짜리 JSONB 는 그 캡에 걸리지 않고 왕복도 한 번이다.
CREATE OR REPLACE FUNCTION public.area_demand_points_near(
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_since TIMESTAMPTZ,
    p_radius_m DOUBLE PRECISION DEFAULT 2000.0,
    p_source TEXT DEFAULT 'gyeongju_its'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_earth_m CONSTANT DOUBLE PRECISION := 6371000.0;
    v_sigma DOUBLE PRECISION;
    v_lat_delta DOUBLE PRECISION;
    v_lng_delta DOUBLE PRECISION;
    v_lat_min DOUBLE PRECISION;
    v_lat_max DOUBLE PRECISION;
    v_lng_min DOUBLE PRECISION;
    v_lng_max DOUBLE PRECISION;
    v_far_lat DOUBLE PRECISION;
    v_cos_product DOUBLE PRECISION;
    v_points JSONB;
BEGIN
    IF p_latitude IS NULL OR p_longitude IS NULL OR p_since IS NULL THEN
        RAISE EXCEPTION 'latitude, longitude and since are required'
            USING ERRCODE = '22023';
    END IF;
    IF p_latitude NOT BETWEEN -90.0 AND 90.0
       OR p_longitude NOT BETWEEN -180.0 AND 180.0 THEN
        RAISE EXCEPTION 'latitude or longitude is out of range'
            USING ERRCODE = '22023';
    END IF;
    IF p_radius_m IS NULL OR p_radius_m <= 0.0 OR p_radius_m > 50000.0 THEN
        RAISE EXCEPTION 'radius_m must be greater than 0 and at most 50000'
            USING ERRCODE = '22023';
    END IF;
    IF p_source IS NULL
       OR p_source NOT IN ('gyeongju_its', 'national_parking_api') THEN
        RAISE EXCEPTION 'unsupported area demand source'
            USING ERRCODE = '22023';
    END IF;

    -- 경계 상자 — 삼각함수를 돌리기 전에 값싼 BETWEEN 으로 후보 주차장을 걸러낸다.
    -- **반드시 반경 원의 상위집합**이어야 한다(하나라도 덜 걸러지는 건 괜찮지만, 반경 안
    -- 주차장을 하나라도 빠뜨리면 추천 품질이 조용히 나빠진다). 그래서 근사치가 아니라
    -- 구면 삼각법에서 유도한 상한을 쓴다. σ 는 중심각(= 거리 / 지구반지름).
    --
    --   위도: cos σ = sinφ0·sinφ + cosφ0·cosφ·cosΔλ ≤ cos(φ0-φ) 이므로 σ ≥ |φ0-φ|.
    --         따라서 |Δφ| ≤ degrees(σ) 가 정확한 상한이다.
    --   경도: 위 항등식을 정리하면
    --         2·cosφ0·cosφ·sin²(Δλ/2) = cos(φ0-φ) - cos σ ≤ 1 - cos σ = 2·sin²(σ/2)
    --         ⇒ |Δλ| ≤ 2·asin( sin(σ/2) / sqrt(cosφ0·cosφ) ).
    --         cosφ 는 위도 상한에서 가장 작아지므로(|φ| ≤ |φ0| + Δφ) 그 값을 대입하면
    --         모든 φ 에 대해 안전한 상한이 된다.
    --
    -- 거리 자체를 데시미터로 반올림하기 때문에 반경 경계에서 2000.04m 가 2000.0m 로 내려와
    -- 통과할 수 있다. 반올림 폭과 libm 오차를 덮으려고 반경에 1m 를 더해 상자를 잡는다.
    v_sigma := (p_radius_m + 1.0) / v_earth_m;
    v_lat_delta := degrees(v_sigma);
    v_lat_min := greatest(-90.0, p_latitude - v_lat_delta);
    v_lat_max := least(90.0, p_latitude + v_lat_delta);

    v_far_lat := least(90.0, abs(p_latitude) + v_lat_delta);
    v_cos_product := cos(radians(p_latitude)) * cos(radians(v_far_lat));
    IF v_cos_product <= 0.0 THEN
        -- 극점을 포함하면 경도는 아무 의미가 없다. 경도 필터를 포기한다.
        v_lng_delta := 180.0;
    ELSE
        v_lng_delta := degrees(
            2.0 * asin(least(1.0, sin(v_sigma / 2.0) / sqrt(v_cos_product)))
        );
    END IF;
    IF v_lng_delta >= 180.0
       OR p_longitude - v_lng_delta < -180.0
       OR p_longitude + v_lng_delta > 180.0 THEN
        -- 날짜변경선을 걸치면 BETWEEN 한 구간으로 표현되지 않는다. 속도보다 정확도.
        v_lng_min := -180.0;
        v_lng_max := 180.0;
    ELSE
        v_lng_min := p_longitude - v_lng_delta;
        v_lng_max := p_longitude + v_lng_delta;
    END IF;

    SELECT jsonb_agg(
               -- 객체가 아니라 배열([관측시각, 수요, 주차장수])로 담는다. 한 지점당 최대
               -- 8천 포인트라 키 이름을 8천 번 반복해 보내는 비용이 무시할 수 없다.
               jsonb_build_array(
                   -- 세션 timezone 설정에 좌우되지 않도록 UTC ISO-8601 을 명시적으로 만든다.
                   to_char(grouped.observed_at AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00',
                   grouped.demand_level,
                   grouped.lot_count
               )
               ORDER BY grouped.observed_at
           )
      INTO v_points
      FROM (
            SELECT
                weighted.snapshot_id,
                weighted.observed_at,
                least(1.0, greatest(0.0,
                    sum(weighted.lot_occupancy * weighted.lot_weight)
                    / sum(weighted.lot_weight)
                )) AS demand_level,
                count(*)::INTEGER AS lot_count
            FROM (
                    SELECT
                        scanned.snapshot_id,
                        scanned.observed_at,
                        scanned.lot_occupancy,
                        scanned.lot_capacity
                            / (1.0 + scanned.distance_m / 500.0) AS lot_weight
                    FROM (
                            SELECT
                                snap.id AS snapshot_id,
                                snap.observed_at AS observed_at,
                                1.0 - lot.available_spaces::DOUBLE PRECISION
                                      / lot.total_spaces::DOUBLE PRECISION AS lot_occupancy,
                                least(lot.total_spaces, 500)::DOUBLE PRECISION AS lot_capacity,
                                round(
                                    (v_earth_m * (2.0 * asin(least(1.0, sqrt(
                                        power(sin((radians(lot.latitude)
                                                   - radians(p_latitude)) / 2.0), 2)
                                        + cos(radians(p_latitude)) * cos(radians(lot.latitude))
                                          * power(sin((radians(lot.longitude)
                                                       - radians(p_longitude)) / 2.0), 2)
                                    )))))::NUMERIC,
                                    1
                                )::DOUBLE PRECISION AS distance_m
                            FROM public.area_demand_snapshots AS snap
                            JOIN public.area_demand_snapshot_lots AS lot
                              ON lot.snapshot_id = snap.id
                            WHERE snap.source = p_source
                              AND snap.observed_at >= p_since
                              AND lot.latitude BETWEEN v_lat_min AND v_lat_max
                              AND lot.longitude BETWEEN v_lng_min AND v_lng_max
                              -- 스키마 CHECK 가 보장하지만 파이썬 집계도 같은 방어를 한다.
                              AND lot.total_spaces > 0
                              AND lot.available_spaces >= 0
                              AND lot.available_spaces <= lot.total_spaces
                            -- OFFSET 0 은 최적화 방벽이다. 없으면 플래너가 서브쿼리를 끌어올려
                            -- 값비싼 거리식을 경계 상자 필터보다 먼저(=모든 행에) 계산할 수 있다.
                            OFFSET 0
                         ) AS scanned
                    WHERE scanned.distance_m <= p_radius_m
                 ) AS weighted
            GROUP BY weighted.snapshot_id, weighted.observed_at
            HAVING sum(weighted.lot_weight) > 0.0
           ) AS grouped;

    RETURN jsonb_build_object(
        'source', p_source,
        'radius_m', p_radius_m,
        'since', to_char(p_since AT TIME ZONE 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00',
        'point_count', jsonb_array_length(COALESCE(v_points, '[]'::JSONB)),
        'points', COALESCE(v_points, '[]'::JSONB)
    );
END;
$$;

COMMENT ON FUNCTION public.area_demand_points_near(
    DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, DOUBLE PRECISION, TEXT
) IS
    '지정 좌표 반경 내 주차장 원본을 관측 시점별 거리·규모 가중 점유율로 집계한다. '
    'aggregate_nearby_points(파이썬)와 같은 값을 내야 한다.';

-- area_demand_* 테이블은 RLS 가 켜져 있고 정책이 없다(브라우저 역할은 읽을 수 없다).
-- 기존 record_area_demand_snapshot 과 같은 경계를 유지한다 — 서버 service_role 전용.
REVOKE ALL ON FUNCTION public.area_demand_points_near(
    DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, DOUBLE PRECISION, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.area_demand_points_near(
    DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, DOUBLE PRECISION, TEXT
) TO service_role;
