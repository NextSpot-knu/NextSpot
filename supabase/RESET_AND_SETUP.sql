-- =====================================================================
-- NextSpot — 기존(팀원) Supabase 프로젝트 재사용: RESET + 관광 스키마 일괄 적용
-- 사용법: Supabase Dashboard > SQL Editor 에 이 파일 전체를 붙여넣고 [Run].
-- ⚠️ 기존 InduSpot(산업) 스키마/데이터를 모두 삭제 후 관광 스키마+경주 시드를 생성합니다(되돌릴 수 없음).
-- DB 비밀번호 공유 없이, 대시보드 SQL Editor 접근만으로 1회 실행하면 됩니다.
-- =====================================================================
DROP TABLE IF EXISTS public.user_feedback CASCADE;
DROP TABLE IF EXISTS public.recommendations CASCADE;
DROP TABLE IF EXISTS public.congestion_logs CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.system_settings CASCADE;
DROP TABLE IF EXISTS public.inquiries CASCADE;
DROP TABLE IF EXISTS public.user_preference_vectors CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_info() CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_role() CASCADE;
DROP FUNCTION IF EXISTS public.handle_updated_at() CASCADE;



-- ============================= migrations/20250523120000_init.sql =============================
-- 0. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- NOTE: auth.users is managed by Supabase and already exists in cloud.

-- 1. users 테이블 (Supabase Auth 확장 · 관광객 프로필)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    nickname VARCHAR(100),                                   -- 관광객 닉네임(선택)
    preferred_categories JSONB DEFAULT '[]'::jsonb,          -- 선호 카테고리(restaurant/cafe/attraction/culture)
    visit_time_pref VARCHAR(20) CHECK (visit_time_pref IN ('morning', 'afternoon', 'evening')),  -- 선호 방문 시간대
    role VARCHAR(20) DEFAULT 'tourist' CHECK (role IN ('tourist', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. facilities 테이블 (관광 POI)
CREATE TABLE IF NOT EXISTS public.facilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('restaurant', 'cafe', 'attraction', 'culture')),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    capacity INT NOT NULL,                                   -- 수용 추정치(좌석/적정 동시 수용 인원)
    operating_hours JSONB DEFAULT '{}'::jsonb,
    features JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. congestion_logs 테이블 (혼잡도 이력)
CREATE TABLE IF NOT EXISTS public.congestion_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    current_count INT NOT NULL,
    congestion_level DOUBLE PRECISION NOT NULL CHECK (congestion_level >= 0.0 AND congestion_level <= 1.0),
    source VARCHAR(50) NOT NULL CHECK (source IN ('traffic_cctv', 'tour_api', 'event', 'user_report'))
);

-- 4. recommendations 테이블 (추천 이력)
CREATE TABLE IF NOT EXISTS public.recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    original_facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE SET NULL,
    recommended_facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE SET NULL,
    tttv_score DOUBLE PRECISION NOT NULL,
    score_breakdown JSONB DEFAULT '{}'::jsonb,
    accepted BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. user_feedback 테이블 (피드백 루프)
CREATE TABLE IF NOT EXISTS public.user_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    recommendation_id UUID NOT NULL REFERENCES public.recommendations(id) ON DELETE CASCADE,
    action VARCHAR(20) NOT NULL CHECK (action IN ('accepted', 'rejected', 'ignored')),
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- --- 인덱스 설정 ---
-- congestion_logs: (facility_id, timestamp DESC) 복합 인덱스
CREATE INDEX IF NOT EXISTS idx_congestion_logs_facility_time
ON public.congestion_logs (facility_id, timestamp DESC);

-- recommendations: user_id 인덱스
CREATE INDEX IF NOT EXISTS idx_recommendations_user_id
ON public.recommendations (user_id);

-- user_feedback: user_id 인덱스
CREATE INDEX IF NOT EXISTS idx_user_feedback_user_id
ON public.user_feedback (user_id);


-- --- 트리거 함수: updated_at 자동 업데이트 ---
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_modtime
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();

CREATE TRIGGER update_facilities_modtime
    BEFORE UPDATE ON public.facilities
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();


-- --- Realtime 활성화 ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.congestion_logs;
-- Realtime 활성화 확인 완료


-- ============================= migrations/20250523120001_rls.sql =============================
-- 1. RLS 활성화
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.congestion_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_feedback ENABLE ROW LEVEL SECURITY;

-- 2. 무한 재귀 조회를 방지하기 위한 Security Definer 헬퍼 함수 정의
-- RLS 정책 평가 시 users 테이블을 직접 셀프 조인하면 infinite recursion 에러가 발생합니다.
-- SECURITY DEFINER로 선언된 함수를 통해 auth.uid() 기준의 role을 안전하게 반환합니다.
CREATE OR REPLACE FUNCTION public.get_auth_user_role()
RETURNS VARCHAR
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
    v_role VARCHAR;
BEGIN
    SELECT role INTO v_role FROM users WHERE id = auth.uid();
    RETURN v_role;
END;
$$;


-- =========================================================================
-- [users] RLS 정책
-- =========================================================================

-- service_role은 전체 권한 허용
CREATE POLICY service_role_all_users ON public.users
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 조회 또는 관리자(전체) 조회
CREATE POLICY select_users ON public.users FOR SELECT TO authenticated
    USING (
        id = auth.uid()
        OR public.get_auth_user_role() = 'admin'
    );

-- 본인 정보만 수정 가능
CREATE POLICY update_users ON public.users FOR UPDATE TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());


-- =========================================================================
-- [facilities] RLS 정책
-- =========================================================================

-- service_role 허용
CREATE POLICY service_role_all_facilities ON public.facilities
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 모든 인증된 사용자는 관광 POI 조회 가능
CREATE POLICY select_facilities ON public.facilities FOR SELECT TO authenticated
    USING (true);

-- 관리자(admin)만 POI 등록/수정/삭제 가능
CREATE POLICY admin_all_facilities ON public.facilities FOR ALL TO authenticated
    USING (public.get_auth_user_role() = 'admin')
    WITH CHECK (public.get_auth_user_role() = 'admin');


-- =========================================================================
-- [congestion_logs] RLS 정책
-- =========================================================================

-- service_role 허용 (백엔드 적재용)
CREATE POLICY service_role_all_logs ON public.congestion_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 모든 인증된 사용자는 혼잡도 이력 조회 가능
CREATE POLICY select_logs ON public.congestion_logs FOR SELECT TO authenticated
    USING (true);

-- 관리자(admin)는 수동 이력 적재/관리가 가능하게 허용
CREATE POLICY admin_all_logs ON public.congestion_logs FOR ALL TO authenticated
    USING (public.get_auth_user_role() = 'admin')
    WITH CHECK (public.get_auth_user_role() = 'admin');


-- =========================================================================
-- [recommendations] RLS 정책
-- =========================================================================

-- service_role 허용 (FastAPI 추천 엔진 적재용)
CREATE POLICY service_role_all_recommendations ON public.recommendations
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인의 추천 이력 또는 관리자(전체) 조회 가능
CREATE POLICY select_recommendations ON public.recommendations FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.get_auth_user_role() = 'admin'
    );


-- =========================================================================
-- [user_feedback] RLS 정책
-- =========================================================================

-- service_role 허용
CREATE POLICY service_role_all_feedback ON public.user_feedback
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인의 피드백 또는 관리자(전체) 조회 가능
CREATE POLICY select_feedback ON public.user_feedback FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.get_auth_user_role() = 'admin'
    );

-- 본인 피드백만 작성(INSERT) 가능
CREATE POLICY insert_feedback ON public.user_feedback FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());


-- ============================= migrations/20250523120002_seed.sql =============================
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


-- ============================= migrations/20260531220000_add_inquiries_table.sql =============================
-- 1. Create inquiries table
CREATE TABLE IF NOT EXISTS public.inquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    user_name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'new' CHECK (status IN ('new', 'in_progress', 'resolved')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Enable RLS
ALTER TABLE public.inquiries ENABLE ROW LEVEL SECURITY;

-- 3. Create RLS Policies
-- Allow anyone (anonymous or authenticated) to insert inquiries
CREATE POLICY "Allow anonymous or auth inserts on inquiries" 
ON public.inquiries FOR INSERT 
WITH CHECK (true);

-- Allow everyone to select, update, or delete inquiries for simplified testing and management
CREATE POLICY "Allow all select/update/delete on inquiries" 
ON public.inquiries FOR ALL 
USING (true);

-- 4. Create update trigger for updated_at
CREATE TRIGGER update_inquiries_modtime
    BEFORE UPDATE ON public.inquiries
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();


-- ============================= migrations/20260601120000_tighten_inquiries_rls.sql =============================
-- =========================================================================
-- inquiries RLS 강화
-- =========================================================================
-- 배경: 20260531220000_add_inquiries_table.sql 의 "Allow all select/update/delete"
--   정책이 FOR ALL USING(true) 로 역할 한정 없이 선언돼, anon 키만으로 모든 사용자의 문의
--   (user_name/content 등 PII)를 조회·수정·삭제할 수 있었다(특히 무제한 DELETE = 데이터 유실 위험).
--
-- 조치: 과도한 FOR ALL 정책을 제거하고 SELECT/UPDATE 로만 좁힌다. DELETE 정책은 두지 않아
--   기본 거부(default deny)가 되게 한다 — 현재 어떤 UI 흐름도 inquiries DELETE 를 쓰지 않으므로
--   동작 보존. admin/support·mypage/support 의 조회·상태변경(resolve)·익명 insert 는 그대로 유지된다.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전).

DROP POLICY IF EXISTS "Allow all select/update/delete on inquiries" ON public.inquiries;
DROP POLICY IF EXISTS "Allow select on inquiries" ON public.inquiries;
DROP POLICY IF EXISTS "Allow update on inquiries" ON public.inquiries;

CREATE POLICY "Allow select on inquiries"
ON public.inquiries FOR SELECT
USING (true);

CREATE POLICY "Allow update on inquiries"
ON public.inquiries FOR UPDATE
USING (true) WITH CHECK (true);


-- ============================= migrations/20260602120000_add_system_settings.sql =============================
-- =========================================================================
-- system_settings: 관리자 시스템 설정 (단일 행, id=1 고정)
-- =========================================================================
-- admin/settings 페이지가 점검모드·공지문구·혼잡 임계값·콜드스타트 가중치를 읽고/쓴다.
-- 모든 인증 사용자는 읽기 가능(앱 공지/점검 배너 표시용), 쓰기는 admin 만.
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전).

CREATE TABLE IF NOT EXISTS public.system_settings (
    id INT PRIMARY KEY DEFAULT 1,
    maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
    notice_text TEXT NOT NULL DEFAULT '',
    congestion_threshold INT NOT NULL DEFAULT 80 CHECK (congestion_threshold BETWEEN 0 AND 100),
    coldstart_weight INT NOT NULL DEFAULT 50 CHECK (coldstart_weight BETWEEN 0 AND 100),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    -- 단일 행만 허용(설정 레코드는 항상 id=1 하나)
    CONSTRAINT system_settings_single_row CHECK (id = 1)
);

-- 기본 설정 행 시드 (없을 때만)
INSERT INTO public.system_settings (id, notice_text)
VALUES (1, '경주 황리단길 실시간 혼잡도와 대안 장소 추천을 제공합니다. 축제·행사 기간에는 혼잡도가 평소보다 높을 수 있습니다.')
ON CONFLICT (id) DO NOTHING;

-- updated_at 자동 갱신 (init.sql 의 handle_updated_at 재사용)
DROP TRIGGER IF EXISTS update_system_settings_modtime ON public.system_settings;
CREATE TRIGGER update_system_settings_modtime
    BEFORE UPDATE ON public.system_settings
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();

-- --- RLS ---
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- service_role(백엔드) 전체 권한
DROP POLICY IF EXISTS service_role_all_settings ON public.system_settings;
CREATE POLICY service_role_all_settings ON public.system_settings
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 모든 인증 사용자 읽기 (앱이 점검모드/공지 배너를 읽어야 함)
DROP POLICY IF EXISTS select_settings ON public.system_settings;
CREATE POLICY select_settings ON public.system_settings
    FOR SELECT TO authenticated USING (true);

-- 수정은 admin 만 (rls.sql 의 get_auth_user_role 재사용; JWT role 이 아닌 users.role 로 판정)
DROP POLICY IF EXISTS admin_update_settings ON public.system_settings;
CREATE POLICY admin_update_settings ON public.system_settings
    FOR UPDATE TO authenticated
    USING (public.get_auth_user_role() = 'admin')
    WITH CHECK (public.get_auth_user_role() = 'admin');


-- ============================= migrations/20260602130000_relax_dashboard_rls.sql =============================
-- [프로토타입] 관리자 인증을 Firebase(Identity Platform)로 이관하면서, 관리자는 Supabase 세션이 없다.
-- admin 대시보드/리포트가 createPublicClient(anon)로도 실데이터를 읽도록, 대시보드용 '읽기' 테이블을
-- anon SELECT 허용으로 완화한다.
--   · 쓰기 및 기존 admin/authenticated RLS 정책은 그대로 유지(워커=authenticated 도 기존대로 동작).
--   · 주의: congestion_logs/recommendations/user_feedback/facilities 의 '읽기'가 공개된다(프로토타입 허용 결정).
-- 멱등: 재실행 가능하도록 DROP IF EXISTS 후 CREATE.

DROP POLICY IF EXISTS anon_select_facilities ON public.facilities;
CREATE POLICY anon_select_facilities ON public.facilities
    FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS anon_select_logs ON public.congestion_logs;
CREATE POLICY anon_select_logs ON public.congestion_logs
    FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS anon_select_recommendations ON public.recommendations;
CREATE POLICY anon_select_recommendations ON public.recommendations
    FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS anon_select_feedback ON public.user_feedback;
CREATE POLICY anon_select_feedback ON public.user_feedback
    FOR SELECT TO anon USING (true);


-- ============================= migrations/20260608120000_add_user_preference_vectors.sql =============================
-- user_preference_vectors: 사용자 8차원 선호 벡터 저장소.
-- (대회 종료 후 GCP Firestore 선호벡터 저장소를 제거하고 Supabase 테이블로 이전 — 로컬 전용 전환.)
-- 백엔드(FastAPI)는 service_role 로 적재/조회하고, 근로자는 본인 벡터만 조회한다.

CREATE TABLE IF NOT EXISTS public.user_preference_vectors (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    vector JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.user_preference_vectors ENABLE ROW LEVEL SECURITY;

-- service_role 전체 허용 (FastAPI 추천 엔진이 선호벡터 적재/조회/갱신)
CREATE POLICY service_role_all_pref_vectors ON public.user_preference_vectors
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 선호 벡터만 조회 가능 (authenticated). 쓰기는 service_role 백엔드 경유라 별도 정책 없음.
CREATE POLICY select_own_pref_vector ON public.user_preference_vectors FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- updated_at 자동 갱신 (handle_updated_at 은 20250523120000_init.sql 에서 정의됨)
CREATE TRIGGER update_user_pref_vectors_modtime
    BEFORE UPDATE ON public.user_preference_vectors
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();
