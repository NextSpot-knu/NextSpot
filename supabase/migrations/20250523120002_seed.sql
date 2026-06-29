-- =========================================================================
-- 1. 사용자 시드 데이터 (public.users)
-- =========================================================================
-- NOTE: auth.users는 Supabase Auth에서 관리하므로 직접 INSERT 불가.
-- 테스트 사용자는 Supabase Dashboard > Authentication > Users 에서 수동 생성 후
-- 아래 UUID를 생성된 사용자 UUID로 교체하여 public.users에 프로필을 등록합니다.
--
-- 예시 INSERT (사용자 생성 후 실행):
-- INSERT INTO public.users (id, employee_id, company_name, preferred_categories, work_shift, role)
-- VALUES
--   ('<생성된-uuid>', 'IT-WORKER-01', 'InduTech', '["cafeteria","parking"]'::jsonb, 'morning', 'worker')
-- ON CONFLICT (id) DO NOTHING;


-- =========================================================================
-- 2. 공용 인프라 POI 시드 데이터 (facilities)
-- =========================================================================

-- 좌표계: 구미국가산업단지 기준(중심 36.1198, 128.3471). 프런트엔드/지도 기본값 및 라이브 DB(구미)와 정합.
-- 일부 시설은 클램프 중심 150m 이내에 배치되어 fresh seed 에서도 반경 추천이 후보를 산출한다.
INSERT INTO public.facilities (id, name, type, latitude, longitude, capacity, operating_hours, features) VALUES
-- 식당 (cafeteria) - 5개
('f1000000-0000-0000-0000-000000000001', '푸드스퀘어 한식관', 'cafeteria', 36.1198, 128.3471, 150,
 '{"weekday": "11:00-20:00", "weekend": "11:00-14:00"}'::jsonb, '{"has_vegetarian": true, "average_price": 7500}'::jsonb),
('f1000000-0000-0000-0000-000000000002', 'Indu 뷔페 식당', 'cafeteria', 36.1205, 128.3464, 200,
 '{"weekday": "11:30-19:00", "weekend": "closed"}'::jsonb, '{"buffet_style": true, "average_price": 8000}'::jsonb),
('f1000000-0000-0000-0000-000000000003', '단지내 중식당 화성', 'cafeteria', 36.1212, 128.3485, 80,
 '{"weekday": "11:00-21:00", "weekend": "11:00-15:00"}'::jsonb, '{"has_delivery": true, "average_price": 9000}'::jsonb),
('f1000000-0000-0000-0000-000000000004', '밀스밀 간편식 코너', 'cafeteria', 36.1180, 128.3455, 50,
 '{"weekday": "08:00-22:00", "weekend": "09:00-18:00"}'::jsonb, '{"sandwich_bar": true, "average_price": 5500}'::jsonb),
('f1000000-0000-0000-0000-000000000005', '산단 남부 한식뷔페', 'cafeteria', 36.1172, 128.3470, 180,
 '{"weekday": "11:00-18:30", "weekend": "closed"}'::jsonb, '{"buffet_style": true, "average_price": 7000}'::jsonb),

-- 주차장 (parking) - 3개
('f2000000-0000-0000-0000-000000000001', '중앙 주차타워 A동', 'parking', 36.1203, 128.3477, 400,
 '{"24_7": true}'::jsonb, '{"has_ev_charger": true, "indoor": true}'::jsonb),
('f2000000-0000-0000-0000-000000000002', '지상 남부 주차장', 'parking', 36.1189, 128.3463, 250,
 '{"24_7": true}'::jsonb, '{"has_ev_charger": false, "indoor": false}'::jsonb),
('f2000000-0000-0000-0000-000000000003', '서부 복합주차장 B', 'parking', 36.1178, 128.3488, 300,
 '{"24_7": true}'::jsonb, '{"has_ev_charger": true, "indoor": true}'::jsonb),

-- 회의실 (meeting_room) - 4개
('f3000000-0000-0000-0000-000000000001', '본관 1층 컨퍼런스룸 101', 'meeting_room', 36.1193, 128.3466, 30,
 '{"weekday": "09:00-18:00", "weekend": "closed"}'::jsonb, '{"has_beam_projector": true, "has_video_conf": true}'::jsonb),
('f3000000-0000-0000-0000-000000000002', '혁신센터 스마트회의실 B', 'meeting_room', 36.1207, 128.3473, 12,
 '{"weekday": "08:00-20:00", "weekend": "09:00-18:00"}'::jsonb, '{"has_beam_projector": true, "whiteboard": true}'::jsonb),
('f3000000-0000-0000-0000-000000000003', '지원동 소회의실 203', 'meeting_room', 36.1215, 128.3460, 8,
 '{"weekday": "09:00-18:00", "weekend": "closed"}'::jsonb, '{"whiteboard": true}'::jsonb),
('f3000000-0000-0000-0000-000000000004', '테크노타워 다목적홀 C', 'meeting_room', 36.1225, 128.3450, 60,
 '{"weekday": "09:00-22:00", "weekend": "09:00-18:00"}'::jsonb, '{"has_beam_projector": true, "has_audio_system": true}'::jsonb),

-- 휴게실 (rest_area) - 2개
('f4000000-0000-0000-0000-000000000001', '북부 직원 휴게라운지 D-1', 'rest_area', 36.1191, 128.3478, 10,
 '{"24_7": true}'::jsonb, '{"massageChairs": {"total": 3, "inUse": 3}, "sleepCapsules": {"total": 2, "inUse": 2}, "playstation": {"total": 1, "inUse": 1}}'::jsonb),
('f4000000-0000-0000-0000-000000000002', '남부 직원 휴게라운지 E-2', 'rest_area', 36.1220, 128.3490, 6,
 '{"24_7": true}'::jsonb, '{"massageChairs": {"total": 3, "inUse": 0}, "sleepCapsules": {"total": 2, "inUse": 0}, "playstation": {"total": 1, "inUse": 0}}'::jsonb)
ON CONFLICT (id) DO NOTHING;


-- =========================================================================
-- 3. 7일치 혼잡도 이력 데이터 생성 (congestion_logs)
-- =========================================================================

-- generate_series를 이용하여 각 시설별로 지난 7일(168시간)간의 시간대별 패턴을 생성해 적재합니다.
INSERT INTO public.congestion_logs (facility_id, timestamp, current_count, congestion_level, source)
SELECT 
    f.id AS facility_id,
    t AS timestamp,
    -- current_count 계산 (capacity * congestion_level)
    ROUND(f.capacity * 
      CASE
        -- 1) 식당 (cafeteria) 패턴
        WHEN f.type = 'cafeteria' THEN
          CASE
            -- 주말 패턴: 거의 이용하지 않음
            WHEN EXTRACT(ISODOW FROM t) IN (6, 7) THEN 0.02 + random() * 0.08
            -- 점심 피크 (11:30 ~ 13:30)
            WHEN EXTRACT(HOUR FROM t) BETWEEN 11 AND 13 THEN 0.70 + random() * 0.25
            -- 저녁 피크 (17:30 ~ 19:30)
            WHEN EXTRACT(HOUR FROM t) BETWEEN 17 AND 19 THEN 0.50 + random() * 0.25
            -- 기타 일과 시간대
            WHEN EXTRACT(HOUR FROM t) BETWEEN 9 AND 20 THEN 0.10 + random() * 0.20
            -- 야간/새벽
            ELSE 0.0 + random() * 0.03
          END
        
        -- 2) 주차장 (parking) 패턴
        WHEN f.type = 'parking' THEN
          CASE
            -- 주말 패턴: 한산함
            WHEN EXTRACT(ISODOW FROM t) IN (6, 7) THEN 0.10 + random() * 0.15
            -- 평일 출근 피크 (08:00 ~ 09:30)
            WHEN EXTRACT(HOUR FROM t) BETWEEN 8 AND 9 THEN 0.75 + random() * 0.20
            -- 평일 근무 시간대 유지 (10:00 ~ 17:00)
            WHEN EXTRACT(HOUR FROM t) BETWEEN 10 AND 16 THEN 0.65 + random() * 0.15
            -- 평일 퇴근 시간대 및 감소 (17:00 ~ 20:00)
            WHEN EXTRACT(HOUR FROM t) BETWEEN 17 AND 19 THEN 0.40 + random() * 0.20
            -- 평일 야간/새벽 (21:00 ~ 07:00)
            ELSE 0.15 + random() * 0.10
          END

        -- 3) 회의실 (meeting_room) 패턴
        WHEN f.type = 'meeting_room' THEN
          CASE
            -- 주말: 닫음
            WHEN EXTRACT(ISODOW FROM t) IN (6, 7) THEN 0.0
            -- 평일 일과 시간 회의 (09:00 ~ 18:00)
            WHEN EXTRACT(HOUR FROM t) BETWEEN 9 AND 17 THEN 0.20 + random() * 0.60
            -- 야간 예약 회의
            WHEN EXTRACT(HOUR FROM t) BETWEEN 18 AND 21 THEN 0.05 + random() * 0.25
            ELSE 0.0
          END

        -- 4) 휴게실 (rest_area) 패턴
        WHEN f.type = 'rest_area' THEN
          CASE
            -- 주말 패턴: 한산
            WHEN EXTRACT(ISODOW FROM t) IN (6, 7) THEN 0.05 + random() * 0.10
            -- 평일 오전 휴식 피크 (08:00 ~ 11:30)
            WHEN EXTRACT(HOUR FROM t) BETWEEN 8 AND 11 THEN 0.60 + random() * 0.35
            -- 평일 점심 직후 휴식 피크 (13:30 ~ 16:30)
            WHEN EXTRACT(HOUR FROM t) BETWEEN 13 AND 16 THEN 0.55 + random() * 0.35
            -- 평일 야간 교대 휴식
            WHEN EXTRACT(HOUR FROM t) BETWEEN 21 AND 23 THEN 0.20 + random() * 0.30
            ELSE 0.05 + random() * 0.15
          END
      END
    ) AS current_count,

    -- congestion_level 계산 (위 CASE 수식을 그대로 차용하되 0~1 바운드 처리)
    GREATEST(0.0, LEAST(1.0, 
      CASE
        WHEN f.type = 'cafeteria' THEN
          CASE
            WHEN EXTRACT(ISODOW FROM t) IN (6, 7) THEN 0.02 + random() * 0.08
            WHEN EXTRACT(HOUR FROM t) BETWEEN 11 AND 13 THEN 0.70 + random() * 0.25
            WHEN EXTRACT(HOUR FROM t) BETWEEN 17 AND 19 THEN 0.50 + random() * 0.25
            WHEN EXTRACT(HOUR FROM t) BETWEEN 9 AND 20 THEN 0.10 + random() * 0.20
            ELSE 0.0 + random() * 0.03
          END
        WHEN f.type = 'parking' THEN
          CASE
            WHEN EXTRACT(ISODOW FROM t) IN (6, 7) THEN 0.10 + random() * 0.15
            WHEN EXTRACT(HOUR FROM t) BETWEEN 8 AND 9 THEN 0.75 + random() * 0.20
            WHEN EXTRACT(HOUR FROM t) BETWEEN 10 AND 16 THEN 0.65 + random() * 0.15
            WHEN EXTRACT(HOUR FROM t) BETWEEN 17 AND 19 THEN 0.40 + random() * 0.20
            ELSE 0.15 + random() * 0.10
          END
        WHEN f.type = 'meeting_room' THEN
          CASE
            WHEN EXTRACT(ISODOW FROM t) IN (6, 7) THEN 0.0
            WHEN EXTRACT(HOUR FROM t) BETWEEN 9 AND 17 THEN 0.20 + random() * 0.60
            WHEN EXTRACT(HOUR FROM t) BETWEEN 18 AND 21 THEN 0.05 + random() * 0.25
            ELSE 0.0
          END
        WHEN f.type = 'rest_area' THEN
          CASE
            WHEN EXTRACT(ISODOW FROM t) IN (6, 7) THEN 0.05 + random() * 0.10
            WHEN EXTRACT(HOUR FROM t) BETWEEN 8 AND 11 THEN 0.60 + random() * 0.35
            WHEN EXTRACT(HOUR FROM t) BETWEEN 13 AND 16 THEN 0.55 + random() * 0.35
            WHEN EXTRACT(HOUR FROM t) BETWEEN 21 AND 23 THEN 0.20 + random() * 0.30
            ELSE 0.05 + random() * 0.15
          END
      END
    )) AS congestion_level,
    
    -- 로그 소스 지정
    CASE 
      WHEN f.type = 'parking' THEN 'iot_sensor'
      WHEN f.type = 'cafeteria' THEN 'cctv'
      WHEN f.type = 'meeting_room' THEN 'access_card'
      ELSE 'iot_sensor'
    END AS source

FROM 
    public.facilities f
CROSS JOIN 
    generate_series(
        timezone('utc'::text, date_trunc('hour', now()) - interval '7 days'), 
        timezone('utc'::text, date_trunc('hour', now())), 
        interval '1 hour'
    ) AS t;
