-- =========================================================================
-- 1. 사용자 시드 데이터 (public.users)
-- =========================================================================
-- NOTE: auth.users는 Supabase Auth에서 관리하므로 직접 INSERT 불가.
-- 테스트 사용자는 Supabase Dashboard > Authentication > Users 에서 수동 생성 후
-- 아래 UUID를 생성된 사용자 UUID로 교체하여 public.users에 프로필을 등록합니다.
--
-- 예시 INSERT (사용자 생성 후 실행):
-- INSERT INTO public.users (id, nickname, preferred_categories, visit_time_pref, role)
-- VALUES
--   ('<생성된-uuid>', '경주여행자', '["restaurant","cafe","attraction"]'::jsonb, 'afternoon', 'tourist')
-- ON CONFLICT (id) DO NOTHING;


-- =========================================================================
-- 2. 관광 POI 시드 데이터 (facilities) — 경주 황리단길 일대
-- =========================================================================
-- 좌표계: 경주 황리단길/황남동 일대(중심 ≈ 35.836, 129.210). 프런트엔드/지도 기본값과 정합.
-- ⚠️ 수기 큐레이션(interim) 데이터 — 이름/좌표/운영시간은 TourAPI 연동(P1) 시 정합·갱신 예정.
-- 일부 POI는 황리단길 중심 150m 이내에 배치되어 fresh seed 에서도 반경 추천이 후보를 산출한다.
INSERT INTO public.facilities (id, name, type, latitude, longitude, capacity, operating_hours, features) VALUES
-- 음식점 (restaurant) - 4개
('f1000000-0000-0000-0000-000000000001', '황남쌈밥', 'restaurant', 35.8378, 129.2096, 60,
 '{"weekday": "10:30-21:00", "weekend": "10:30-21:00"}'::jsonb, '{"cuisine_tags": ["한식","쌈밥"], "signature_menu": "보리쌈밥정식", "barrier_free": true, "average_price": 13000}'::jsonb),
('f1000000-0000-0000-0000-000000000002', '교리김밥 황리단길점', 'restaurant', 35.8369, 129.2103, 30,
 '{"weekday": "08:00-18:00", "weekend": "08:00-18:00"}'::jsonb, '{"cuisine_tags": ["분식","김밥"], "signature_menu": "교리김밥", "average_price": 6000}'::jsonb),
('f1000000-0000-0000-0000-000000000003', '황리단길 한우국밥', 'restaurant', 35.8362, 129.2091, 50,
 '{"weekday": "09:00-20:00", "weekend": "09:00-20:00"}'::jsonb, '{"cuisine_tags": ["한식","국밥"], "signature_menu": "한우국밥", "barrier_free": false, "average_price": 10000}'::jsonb),
('f1000000-0000-0000-0000-000000000004', '경주 한정식 다온', 'restaurant', 35.8385, 129.2088, 80,
 '{"weekday": "11:00-21:30", "weekend": "11:00-21:30"}'::jsonb, '{"cuisine_tags": ["한식","한정식"], "signature_menu": "다온정식", "barrier_free": true, "average_price": 22000}'::jsonb),

-- 카페 (cafe) - 4개
('f2000000-0000-0000-0000-000000000001', '황리단길 감성카페 봄', 'cafe', 35.8366, 129.2099, 40,
 '{"weekday": "10:00-22:00", "weekend": "10:00-23:00"}'::jsonb, '{"signature_menu": "황남빵라떼", "instagrammable": true, "average_price": 6500}'::jsonb),
('f2000000-0000-0000-0000-000000000002', '한옥카페 다랑', 'cafe', 35.8372, 129.2085, 35,
 '{"weekday": "10:30-21:00", "weekend": "10:00-22:00"}'::jsonb, '{"signature_menu": "쑥라떼", "instagrammable": true, "barrier_free": false, "average_price": 7000}'::jsonb),
('f2000000-0000-0000-0000-000000000003', '첨성대뷰 루프탑카페', 'cafe', 35.8358, 129.2110, 50,
 '{"weekday": "11:00-22:00", "weekend": "11:00-23:00"}'::jsonb, '{"signature_menu": "에이드", "instagrammable": true, "barrier_free": true, "average_price": 7500}'::jsonb),
('f2000000-0000-0000-0000-000000000004', '십원빵 황리단길', 'cafe', 35.8375, 129.2094, 20,
 '{"weekday": "10:00-21:00", "weekend": "10:00-21:30"}'::jsonb, '{"signature_menu": "십원빵", "instagrammable": true, "average_price": 4000}'::jsonb),

-- 관광지 (attraction) - 4개
('f3000000-0000-0000-0000-000000000001', '대릉원(천마총)', 'attraction', 35.8389, 129.2099, 800,
 '{"weekday": "09:00-22:00", "weekend": "09:00-22:00"}'::jsonb, '{"barrier_free": true, "entry_fee": 3000, "category": "고분군"}'::jsonb),
('f3000000-0000-0000-0000-000000000002', '첨성대', 'attraction', 35.8347, 129.2189, 600,
 '{"weekday": "00:00-24:00", "weekend": "00:00-24:00"}'::jsonb, '{"barrier_free": true, "entry_fee": 0, "category": "유적"}'::jsonb),
('f3000000-0000-0000-0000-000000000003', '동궁과 월지', 'attraction', 35.8348, 129.2265, 700,
 '{"weekday": "09:00-22:00", "weekend": "09:00-22:00"}'::jsonb, '{"barrier_free": true, "entry_fee": 3000, "category": "야경"}'::jsonb),
('f3000000-0000-0000-0000-000000000004', '월정교', 'attraction', 35.8316, 129.2167, 400,
 '{"weekday": "00:00-24:00", "weekend": "00:00-24:00"}'::jsonb, '{"barrier_free": true, "entry_fee": 0, "category": "야경"}'::jsonb),

-- 문화시설 (culture) - 4개
('f4000000-0000-0000-0000-000000000001', '국립경주박물관', 'culture', 35.8297, 129.2278, 500,
 '{"weekday": "10:00-18:00", "weekend": "10:00-19:00", "closed": "monday"}'::jsonb, '{"barrier_free": true, "entry_fee": 0, "category": "박물관"}'::jsonb),
('f4000000-0000-0000-0000-000000000002', '경주 교촌마을', 'culture', 35.8296, 129.2156, 300,
 '{"weekday": "09:00-18:00", "weekend": "09:00-18:00"}'::jsonb, '{"barrier_free": false, "entry_fee": 0, "category": "한옥마을"}'::jsonb),
('f4000000-0000-0000-0000-000000000003', '경주 최부자댁', 'culture', 35.8302, 129.2161, 150,
 '{"weekday": "09:00-18:00", "weekend": "09:00-18:00", "closed": "monday"}'::jsonb, '{"barrier_free": false, "entry_fee": 0, "category": "고택"}'::jsonb),
('f4000000-0000-0000-0000-000000000004', '황리단길 공예공방거리', 'culture', 35.8360, 129.2085, 100,
 '{"weekday": "10:00-19:00", "weekend": "10:00-20:00"}'::jsonb, '{"barrier_free": true, "entry_fee": 0, "category": "공예"}'::jsonb)
ON CONFLICT (id) DO NOTHING;


-- =========================================================================
-- 3. 7일치 혼잡도 이력 데이터 생성 (congestion_logs)
-- =========================================================================
-- generate_series로 각 POI별 지난 7일(168시간)간 시간대별 관광 혼잡 패턴을 생성한다.
-- 산업(평일 점심·교대) 패턴이 아니라 관광 패턴: 주말·낮 시간대 포화, 카페 오후 피크, 박물관 월요일 휴관.
-- 혼잡도(lvl)를 LATERAL 로 1회 계산해 current_count(=capacity*lvl)와 congestion_level 에 일관 적용.
INSERT INTO public.congestion_logs (facility_id, timestamp, current_count, congestion_level, source)
SELECT
    f.id AS facility_id,
    t AS timestamp,
    ROUND(f.capacity * g.lvl) AS current_count,
    g.lvl AS congestion_level,
    CASE
        WHEN f.type IN ('attraction', 'culture') THEN 'traffic_cctv'
        WHEN f.type IN ('restaurant', 'cafe') THEN 'user_report'
        ELSE 'tour_api'
    END AS source
FROM
    public.facilities f
CROSS JOIN
    generate_series(
        timezone('utc'::text, date_trunc('hour', now()) - interval '7 days'),
        timezone('utc'::text, date_trunc('hour', now())),
        interval '1 hour'
    ) AS t
CROSS JOIN LATERAL (
    SELECT GREATEST(0.0, LEAST(1.0,
        CASE
            -- 음식점: 점심·저녁 피크, 주말 식사시간 포화
            WHEN f.type = 'restaurant' THEN
                CASE
                    WHEN EXTRACT(ISODOW FROM t) IN (6, 7) AND EXTRACT(HOUR FROM t) BETWEEN 11 AND 20 THEN 0.70 + random() * 0.28
                    WHEN EXTRACT(HOUR FROM t) BETWEEN 11 AND 13 THEN 0.60 + random() * 0.25
                    WHEN EXTRACT(HOUR FROM t) BETWEEN 17 AND 19 THEN 0.50 + random() * 0.25
                    WHEN EXTRACT(HOUR FROM t) BETWEEN 9 AND 21 THEN 0.15 + random() * 0.20
                    ELSE 0.02 + random() * 0.05
                END
            -- 카페: 오후 피크, 주말 종일 붐빔
            WHEN f.type = 'cafe' THEN
                CASE
                    WHEN EXTRACT(ISODOW FROM t) IN (6, 7) AND EXTRACT(HOUR FROM t) BETWEEN 11 AND 19 THEN 0.65 + random() * 0.30
                    WHEN EXTRACT(HOUR FROM t) BETWEEN 13 AND 18 THEN 0.50 + random() * 0.25
                    WHEN EXTRACT(HOUR FROM t) BETWEEN 9 AND 21 THEN 0.15 + random() * 0.20
                    ELSE 0.02 + random() * 0.05
                END
            -- 관광지: 낮 시간 피크, 주말 포화
            WHEN f.type = 'attraction' THEN
                CASE
                    WHEN EXTRACT(ISODOW FROM t) IN (6, 7) AND EXTRACT(HOUR FROM t) BETWEEN 10 AND 17 THEN 0.75 + random() * 0.23
                    WHEN EXTRACT(HOUR FROM t) BETWEEN 10 AND 17 THEN 0.45 + random() * 0.25
                    WHEN EXTRACT(HOUR FROM t) BETWEEN 9 AND 18 THEN 0.20 + random() * 0.20
                    ELSE 0.02 + random() * 0.05
                END
            -- 문화시설: 낮 시간 관람, 월요일 휴관, 주말 붐빔
            WHEN f.type = 'culture' THEN
                CASE
                    WHEN EXTRACT(ISODOW FROM t) = 1 THEN 0.0
                    WHEN EXTRACT(ISODOW FROM t) IN (6, 7) AND EXTRACT(HOUR FROM t) BETWEEN 10 AND 17 THEN 0.60 + random() * 0.30
                    WHEN EXTRACT(HOUR FROM t) BETWEEN 10 AND 17 THEN 0.35 + random() * 0.25
                    ELSE 0.03 + random() * 0.05
                END
            ELSE 0.10 + random() * 0.10
        END
    )) AS lvl
) AS g;
