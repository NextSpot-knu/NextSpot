-- =====================================================================
-- NextSpot — RESET + 관광 스키마/시드 일괄 적용 (Supabase SQL Editor 용)
--
-- ⚠️ 자동 생성 파일 — 직접 수정 금지!
--    이 파일은 scripts/build_reset.mjs 가 supabase/migrations/ 에서 자동 생성한다.
--    스키마 변경은 migrations/ 에 새 마이그레이션을 추가한 뒤
--    `node scripts/build_reset.mjs` 를 재실행해 이 파일을 재생성할 것. (D2, docs/IMPROVEMENT_PLAN.md)
--
-- 사용법: Supabase Dashboard > SQL Editor 에 이 파일 전체를 붙여넣고 [Run].
-- ⚠️ 기존 스키마/데이터를 모두 삭제한 뒤 관광 스키마+경주 시드를 생성합니다(되돌릴 수 없음).
--    DB 비밀번호 공유 없이, 대시보드 SQL Editor 접근만으로 1회 실행하면 됩니다.
-- =====================================================================
DROP TABLE IF EXISTS public.user_feedback CASCADE;
DROP TABLE IF EXISTS public.area_demand_snapshot_lots CASCADE;
DROP TABLE IF EXISTS public.area_demand_snapshots CASCADE;
DROP TABLE IF EXISTS public.recommendation_outcomes CASCADE;
DROP TABLE IF EXISTS public.model_registry CASCADE;
DROP TABLE IF EXISTS public.facility_source_refs CASCADE;
DROP TABLE IF EXISTS public.tourism_insight_snapshots CASCADE;
DROP TABLE IF EXISTS public.tourism_concentration_forecasts CASCADE;
DROP TABLE IF EXISTS public.recommendations CASCADE;
DROP TABLE IF EXISTS public.congestion_logs CASCADE;
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.system_settings CASCADE;
DROP TABLE IF EXISTS public.inquiries CASCADE;
DROP TABLE IF EXISTS public.user_preference_vectors CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_info() CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_role() CASCADE;
DROP FUNCTION IF EXISTS public.latest_congestion_for_facilities(UUID[]) CASCADE;
DROP FUNCTION IF EXISTS public.apply_localdata_sync(JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.promote_recommendation_model(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.correlate_congestion_report_evidence() CASCADE;
DROP FUNCTION IF EXISTS public.project_outcome_congestion_log() CASCADE;
DROP FUNCTION IF EXISTS public.record_area_demand_snapshot(TEXT, TIMESTAMPTZ, JSONB) CASCADE;
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
    spot_score DOUBLE PRECISION NOT NULL,
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
-- 백엔드(FastAPI)는 service_role 로 적재/조회하고, 사용자는 본인 벡터만 조회한다.

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

-- ============================= migrations/20260707120000_security_hardening.sql =============================
-- =========================================================================
-- 보안 강화 (2026-07-07 전방위 감사 후속) — docs/IMPROVEMENT_PLAN.md WS-A-1/2
-- =========================================================================
-- 1) [P0] users 자기 role 승격(privilege escalation) 차단
--    기존 update_users 의 WITH CHECK 이 행 소유권만 검증해, 로그인 사용자가
--    `UPDATE users SET role='admin'` 으로 자기 role 을 바꿔 admin 전용 정책
--    (admin_all_facilities / admin_all_logs / admin_update_settings)을 탈취할 수 있었다.
-- 2) [P1] anon 의 recommendations / user_feedback 전체 열람 제거
--    (relax_dashboard_rls 가 열었던 사용자 단위 행위 데이터 노출. 관리자 대시보드의
--     해당 지표는 FastAPI /api/v1/admin/metrics — service_role — 경유로 대체된다.)
-- 3) [P1] inquiries 의 무제한(public) 읽기/수정 제거 — PII(user_name/content) 보호.
--    익명 문의 '접수'(INSERT) 는 유지. 관리자 목록/상태변경은 FastAPI /api/v1/admin/inquiries 경유.
-- 4) [P1] recommendations FK 의 NOT NULL + ON DELETE SET NULL 모순 해소
--    (POI 삭제 시 SET NULL 이 NOT NULL 제약을 위반해 삭제가 런타임 에러로 실패했다.
--     이력 보존 의도에 맞게 NULL 허용으로 변경.)
-- 멱등: 재실행 가능하도록 DROP IF EXISTS 후 CREATE.

-- 1) users: 본인 행만 수정 가능 + role 은 변경 불가(권한 상승 차단)
--    get_auth_user_role() 은 SECURITY DEFINER 라 users 정책 안에서 재귀 없이 기존 role 을 읽는다.
--    (동일 문장 스냅샷 기준이므로 NEW.role = OLD.role 강제와 동치 — role 변경은 service_role 전용.)
DROP POLICY IF EXISTS update_users ON public.users;
CREATE POLICY update_users ON public.users FOR UPDATE TO authenticated
    USING (id = auth.uid())
    WITH CHECK (
        id = auth.uid()
        AND role = public.get_auth_user_role()
    );

-- 2) anon 의 사용자 행위 데이터 열람 제거 (facilities/congestion_logs 공개 읽기는 공용 데이터라 유지)
DROP POLICY IF EXISTS anon_select_recommendations ON public.recommendations;
DROP POLICY IF EXISTS anon_select_feedback ON public.user_feedback;

-- 3) inquiries: 무제한 SELECT/UPDATE 정책 제거 → 본인 또는 admin 만
DROP POLICY IF EXISTS "Allow select on inquiries" ON public.inquiries;
DROP POLICY IF EXISTS "Allow update on inquiries" ON public.inquiries;

CREATE POLICY select_own_or_admin_inquiries ON public.inquiries FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.get_auth_user_role() = 'admin');

CREATE POLICY admin_update_inquiries ON public.inquiries FOR UPDATE TO authenticated
    USING (public.get_auth_user_role() = 'admin')
    WITH CHECK (public.get_auth_user_role() = 'admin');

-- 4) recommendations FK: 이력 보존형 SET NULL 이 실제로 동작하도록 NOT NULL 해제
ALTER TABLE public.recommendations ALTER COLUMN original_facility_id DROP NOT NULL;
ALTER TABLE public.recommendations ALTER COLUMN recommended_facility_id DROP NOT NULL;

-- ============================= migrations/20260707130000_add_tourapi_fields.sql =============================
-- TourAPI 필드 추가 (2026-07-07) — docs/IMPROVEMENT_PLAN.md WS-B-3
-- 한국관광공사 TourAPI 적재(scripts/ingest_tourapi.py)를 위한 **가산적(additive)** 스키마 확장.
--
-- 설계 결정: 테이블명은 `facilities` 를 유지한다. IMPROVEMENT_PLAN 의 facilities→pois 개명은
--   백엔드 .from("facilities")·프론트 참조 전면 수정을 동반하는 침습적 변경이라
--   D2(스키마 소스 오브 트루스) 결정 확정 전까지 보류한다. 본 마이그레이션은 컬럼 추가만 수행.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전 — IF NOT EXISTS).

-- TourAPI 콘텐츠 식별자 (upsert 기준키)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS contentid VARCHAR(20);

-- TourAPI 관광타입 (관광지 12 / 문화시설 14 / 음식점 39)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS contenttypeid INTEGER;

-- 주소(addr1)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS address TEXT;

-- 무장애(barrier-free) 여부 — detailInfo2 기반. NULL = 정보 없음(미상)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS barrier_free BOOLEAN;

-- 대표 이미지(firstimage)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS image_url TEXT;

-- contentid 부분 유니크 인덱스: TourAPI 적재분의 upsert(on_conflict) 기준.
-- 부분(partial) 인덱스로 두어 contentid 가 NULL 인 기존 수동 시드 행들과 공존 가능하게 한다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_facilities_contentid
ON public.facilities (contentid) WHERE contentid IS NOT NULL;

-- ============================= migrations/20260707140000_add_preference_note.sql =============================
-- users.preference_note 추가 (2026-07-07) — docs/IMPROVEMENT_PLAN.md WS-B-6 / §1 D2
-- 원래 apps/api/sql/add_preference_note.sql 로 방치되어 있던 고아 SQL을
-- D2 결정(migrations/ 단일 소스 오브 트루스)에 따라 정식 마이그레이션으로 승격했다.
-- (승격 전에는 신규 셋업에서 이 컬럼이 조용히 누락되어 자연어 선호 기능의 DB 보존이 실패했다.)
--
-- 자연어 선호 기능(선택): 사용자가 말한 원문 + AI 요약을 보관할 컬럼.
-- 없어도 동작한다(서버가 저장 실패를 무시함).
--
--   POST /api/v1/preferences/parse 가 다음 형태로 기록:
--   { "text": "조용한 한옥카페 선호", "summary": "카페 중심으로 조용한 곳 선호로 이해했어요." }

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS preference_note jsonb;

-- ============================= migrations/20260707150000_add_coupon_incentive.sql =============================
-- 인센티브 항(w3) 데이터 — D1 재결정(2026-07-07): '쿠폰 강도 + 수요 재배치 기여' 결합형.
--   incentive = 0.5 × min(1, coupon_rate/0.20) + 0.5 × max(0, 원본혼잡 − 후보 도착시점 예측혼잡)
-- 쿠폰을 0/1 로 두는 대신 제휴 등급(할인율)을 연속값으로 반영하고, InduSpot 에서 검증된
-- 혼잡분산 항을 도착시점 예측 기준으로 유지한다. 산식 구현: apps/api/app/services/spot/score.py,
-- 상수 공유: packages/shared-types/spot.ts (CI 패리티 테스트로 정합 강제).

-- coupon_rate: 제휴 가맹점 할인율 (0.10 = 10%). 0 = 제휴 없음. 상한은 산식에서 20% 캡.
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS coupon_rate DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (coupon_rate >= 0 AND coupon_rate <= 1);

-- 데모용 제휴 가맹점 시드: 핫스팟(첨성대·대릉원 등)이 아닌 '분산 목적지' 위주로 등급을 달리 지정해
-- 쿠폰 강도가 수요 재배치 방향으로 차등 작동하는 모습을 시연한다.
-- (TourAPI 적재 행은 contentid 기준이라 name 매칭 무해 — 기본 0 유지.)
UPDATE public.facilities SET coupon_rate = 0.20 WHERE name IN ('황리단길 한우국밥', '황리단길 공예공방거리');
UPDATE public.facilities SET coupon_rate = 0.15 WHERE name IN ('경주 한정식 다온', '한옥카페 다랑');
UPDATE public.facilities SET coupon_rate = 0.10 WHERE name IN ('월정교', '경주 최부자댁');

-- ============================= migrations/20260710120000_add_congestion_timestamp_index.sql =============================
-- congestion_logs: timestamp 단독 인덱스 — 관리자 대시보드 timestamp 범위조회 최적화.
-- 대시보드는 facility_id 없이 timestamp 범위로만 조회한다(.gte/.lte/.order('timestamp')).
-- 기존 (facility_id, timestamp DESC) 복합 인덱스는 선두 컬럼이 facility_id 라
-- timestamp 단독 필터를 타지 못해 seq scan + sort 가 발생 → timestamp 단일 btree 로 해소.
CREATE INDEX IF NOT EXISTS idx_congestion_logs_timestamp
ON public.congestion_logs (timestamp DESC);

-- ============================= migrations/20260710130000_add_user_coupons.sql =============================
-- user_coupons: 사용자 인센티브 지갑('내 쿠폰함').
-- 배경: SPOT 점수의 w3 인센티브 항은 이미 facilities.coupon_rate(제휴 할인율)을 소비하지만
--   (20260707150000_add_coupon_incentive.sql), 그 값이 고객에게는 보이지 않았다.
--   분산 추천을 '수락'하면 실제 쿠폰이 지갑에 발급되도록 이 테이블로 노출한다.
-- 쓰기 경로: FastAPI /api/v1/coupons/issue (service_role) 만 발급/갱신한다.
--   사용자는 본인 쿠폰만 조회한다(20260707120000_security_hardening.sql 의 하드닝 스타일 미러).

CREATE TABLE IF NOT EXISTS public.user_coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    -- 발급 시점의 제휴 할인율 스냅샷(0.10 = 10%). facilities.coupon_rate 와 동일한 0~1 CHECK.
    coupon_rate DOUBLE PRECISION NOT NULL CHECK (coupon_rate >= 0 AND coupon_rate <= 1),
    status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'used')),
    issued_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    used_at TIMESTAMP WITH TIME ZONE,
    -- 한 시설당 사용자 1장 — 재발급은 upsert(on conflict)로 할인율/상태를 갱신한다.
    UNIQUE (user_id, facility_id)
);

-- 본인 쿠폰 목록 조회용 인덱스(내 쿠폰함 = user_id 필터).
CREATE INDEX IF NOT EXISTS idx_user_coupons_user_id ON public.user_coupons (user_id);

-- RLS: 하드닝 스타일 — 읽기는 본인 행만, 쓰기(INSERT/UPDATE)는 service_role(FastAPI) 전용.
--   (anon/authenticated 쓰기 정책 없음 → 발급은 반드시 신뢰 경로를 거친다.)
ALTER TABLE public.user_coupons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_coupons_select_own ON public.user_coupons;
CREATE POLICY user_coupons_select_own ON public.user_coupons FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

-- service_role 전체 허용(발급/사용 처리). RLS 우회는 이 신뢰 경로 안에서만 일어난다.
DROP POLICY IF EXISTS user_coupons_service_all ON public.user_coupons;
CREATE POLICY user_coupons_service_all ON public.user_coupons
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================= migrations/20260710160000_handle_new_user.sql =============================
-- =========================================================================
-- auth.users INSERT → public.users 자동 프로비저닝 (익명/신규 인증 사용자 대응)
-- =========================================================================
-- 배경: 관광객 무마찰 익명 로그인(supabase.auth.signInAnonymously — apps/web SessionBootstrap) 도입으로
--   모든 방문자가 실제 auth.users 행을 갖게 된다. 그러나 백엔드 recommendations.fetch_user 는 매칭되는
--   public.users 행이 없으면 404("사용자 정보를 찾을 수 없습니다.")를 던져 추천/코스/쿠폰 흐름을 막는다.
--   따라서 신규 auth 사용자(익명 포함)마다 대응하는 public.users 행이 즉시 존재해야 한다.
--   이 트리거가 그 간극을 메운다 — Supabase 표준 handle_new_user 패턴.
--
-- 동작: auth.users 에 행이 INSERT 될 때(익명 포함) 같은 id 로 public.users 행을 만든다.
--   - SECURITY DEFINER + SET search_path=public: auth 스키마 트리거가 함수 소유자(RLS 우회) 권한으로
--     public.users(RLS 적용 테이블)에 안전하게 INSERT 한다. (기존 get_auth_user_role 과 동일 관용구.)
--   - preferred_categories 는 스키마 기본값('[]'::jsonb)과 동일하게 명시 — 콜드스타트 선호벡터의 안전한 기본.
--     (role='tourist', created_at/updated_at 은 컬럼 DEFAULT, nickname/visit_time_pref 는 NULL 허용.)
--   - ON CONFLICT (id) DO NOTHING: 이미 존재하는 행을 덮어쓰지 않는다 → 기존 사용자 보존 + 재실행 안전.
-- 멱등: 함수는 CREATE OR REPLACE, 트리거는 DROP IF EXISTS 후 재생성.
--
-- ⚠️ 이 마이그레이션만으로 익명 로그인이 켜지지는 않는다(트리거는 '가입 후 프로비저닝'만 담당).
--    실제 활성화하려면 Supabase 대시보드에서
--    Authentication → Sign In / Providers → "Allow anonymous sign-ins" 를 켜야 한다.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO public.users (id, preferred_categories)
    VALUES (NEW.id, '[]'::jsonb)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- ============================= migrations/20260710170000_add_coupon_expiry.sql =============================
-- user_coupons.expires_at: 쿠폰 만료(발급 시각 + 7일).
-- 배경: 발급된 쿠폰이 영구 유효라 인센티브의 '지금 분산하면 이득' 긴급성이 사라졌다.
--   발급 시 만료시각을 못박고, /api/v1/coupons/mine 은 만료를 파생 status('expired')로 노출,
--   /api/v1/coupons/{id}/use 는 만료 쿠폰이면 409 로 거부한다.
-- DB status CHECK 는 issued/used 불변(만료는 애플리케이션 파생) — 이력/제약 단순성 유지.

ALTER TABLE public.user_coupons ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;

-- 기존 발급분 백필: issued_at + 7일. (NULL 인 행만 갱신 — 재실행 안전.)
UPDATE public.user_coupons
   SET expires_at = issued_at + interval '7 days'
 WHERE expires_at IS NULL;

-- ============================= migrations/20260710171000_add_user_report_count.sql =============================
-- users.report_count: 혼잡 제보 누적 횟수(제보 보상 게이팅용).
-- 배경: 크라우드소싱 혼잡 제보(POST /api/v1/reports/congestion) 참여를 현물 보상으로 유도한다.
--   제보 3건마다 해당 시설이 제휴(coupon_rate>0)면 쿠폰을 발급(reports 라우터)한다.
-- NOT NULL DEFAULT 0: 기존 사용자도 0 에서 시작(백필 불필요).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS report_count INT NOT NULL DEFAULT 0;

-- ============================= migrations/20260710172000_congestion_source_honesty.sql =============================
-- congestion_logs.source 정직화 — 실 CCTV/TourAPI 인제스트가 아직 없다(현재 데이터는 전부 합성).
-- 1) source CHECK 제약에 'seed'(시드 합성)·'simulated'(관리자 피크 시뮬)을 추가한다.
-- 2) 데이터 정직화 UPDATE: 실측처럼 보이던 'traffic_cctv'/'tour_api' 라벨(실제로는 전부 시드 합성)을
--    'seed' 로 교정한다. (사용자 제보 'user_report'·관리자 수동 'event' 는 실제 출처라 그대로 둔다.)
--    infrastructures.simulate_peak 는 이제 'simulated' 로 기록한다(코드측 반영).
-- 재실행 안전: DROP CONSTRAINT IF EXISTS 후 재생성. UPDATE 는 제약 해제 상태에서 수행해 순서 무관.

ALTER TABLE public.congestion_logs DROP CONSTRAINT IF EXISTS congestion_logs_source_check;

UPDATE public.congestion_logs
   SET source = 'seed'
 WHERE source IN ('traffic_cctv', 'tour_api');

ALTER TABLE public.congestion_logs
    ADD CONSTRAINT congestion_logs_source_check
    CHECK (source IN ('traffic_cctv', 'tour_api', 'event', 'user_report', 'seed', 'simulated'));

-- ============================= migrations/20260710173000_add_app_events.sql =============================
-- app_events: 경량 제품 분석 이벤트(무인증 POST /api/v1/events/track 적재).
-- 배경: 리텐션/퍼널 계측(랜딩 조회·추천 수락·쿠폰 사용 등)을 남길 곳이 없었다.
--   민감정보가 아닌 익명 이벤트만 기록하며 user_id 는 선택(익명 세션 허용, FK 없음 — 경량 로그).
-- 쓰기/읽기 모두 service_role(FastAPI) 전용 — anon/authenticated 정책 부재로 직접 접근을 차단한다.

CREATE TABLE IF NOT EXISTS public.app_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,                                   -- 선택(무인증 트래킹은 NULL). FK 미설정(경량 로그).
    event TEXT NOT NULL,                            -- 이벤트명(<=64자, 애플리케이션에서 상한 검증)
    props JSONB NOT NULL DEFAULT '{}'::jsonb,       -- 부가 속성(<=1KB, 애플리케이션에서 상한 검증)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 최근 이벤트 조회(퍼널/리텐션 분석) 인덱스.
CREATE INDEX IF NOT EXISTS idx_app_events_created_at ON public.app_events (created_at DESC);

ALTER TABLE public.app_events ENABLE ROW LEVEL SECURITY;

-- service_role 전용(insert/select 포함 전체). anon/authenticated 정책 부재 → 직접 접근 거부.
DROP POLICY IF EXISTS app_events_service_all ON public.app_events;
CREATE POLICY app_events_service_all ON public.app_events
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================= migrations/20260713090000_add_detail_common_fields.sql =============================
-- 상세 공통 필드 추가 (2026-07-13) — POI 상세 카드(A2)용 TourAPI detailCommon2 확장.
-- scripts/ingest_tourapi.py --details 가 detailCommon2 응답에서 채우는 **가산적(additive)** 스키마 확장.
--
-- 설계 결정: 전부 nullable TEXT — 실데이터가 있을 때만 저장한다('지어내지 않기' 원칙).
--   detailCommon2 미조회/미제공 행은 NULL 로 남고, 프런트는 값이 있을 때만 조건부 렌더한다.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전 — IF NOT EXISTS).

-- 전화번호(tel)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS phone TEXT;

-- 홈페이지 URL(homepage — anchor HTML 로 오면 href 만 추출해 저장)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS homepage TEXT;

-- 개요/소개 텍스트(overview)
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS overview TEXT;

-- ============================= migrations/20260715100000_merchant_timesales.sql =============================
-- merchant_timesales: 소상공인 '내 가게 대시보드'(머천트 콘솔) 셀프 타임세일.
-- 배경: 사장님이 직접 15/20/30% 할인율 × 1/2/3시간 지속시간의 한시적 타임세일을 발행/취소할 수 있게 한다.
--   (apps/api/app/routers/merchant.py POST/GET /api/v1/merchant/timesale, /timesale/cancel 이 유일한 쓰기 경로.)
-- ⚠️ 발행이 추천 랭킹(score.py)에 즉시 반영되지는 않는다 — 랭킹 인센티브 연동은 2단계 예정(이번 스코프 아님).
-- 쓰기 경로: FastAPI merchant 라우터(service_role, X-Merchant-Token 가드)만 INSERT/UPDATE(취소) 한다.
--   사장님 프런트(apps/web/app/merchant/*)는 anon 으로 활성 목록만 읽는다(user_coupons 하드닝 스타일 미러).

CREATE TABLE IF NOT EXISTS public.merchant_timesales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    -- 타임세일 할인율(0 초과 ~ 0.5 이하). facilities.coupon_rate(0~1)보다 좁은 상한 —
    -- 셀프서비스 타임세일은 사장님이 직접 발행하므로 남용 방지 캡을 둔다.
    rate NUMERIC NOT NULL CHECK (rate > 0 AND rate <= 0.5),
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    ends_at TIMESTAMP WITH TIME ZONE NOT NULL,
    canceled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- 활성 타임세일 조회(facility_id + 미취소 + 미만료)용 인덱스.
CREATE INDEX IF NOT EXISTS idx_merchant_timesales_facility ON public.merchant_timesales (facility_id);

-- RLS: user_coupons(20260710130000) 하드닝 스타일 미러 — 읽기는 anon 허용(대시보드/지도 노출용),
--   쓰기(INSERT/UPDATE)는 service_role(FastAPI merchant 라우터) 전용.
ALTER TABLE public.merchant_timesales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS merchant_timesales_select_anon ON public.merchant_timesales;
CREATE POLICY merchant_timesales_select_anon ON public.merchant_timesales
    FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS merchant_timesales_select_authenticated ON public.merchant_timesales;
CREATE POLICY merchant_timesales_select_authenticated ON public.merchant_timesales
    FOR SELECT TO authenticated USING (true);

-- service_role 전체 허용(발행/취소). RLS 우회는 이 신뢰 경로 안에서만 일어난다.
DROP POLICY IF EXISTS merchant_timesales_service_all ON public.merchant_timesales;
CREATE POLICY merchant_timesales_service_all ON public.merchant_timesales
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================= migrations/20260715110000_facility_is_active.sql =============================
-- 폐업·표출중단 자동 감지(2차 기획 1위) — facilities.is_active.
-- scripts/ingest_tourapi.py 의 --sync 스텝이 TourAPI areaBasedSyncList2 의 showflag 를 실측
-- 대조해 이 컬럼을 갱신한다(showflag='0' → false, showflag='1' → true 복구).
--
-- 실측(2026-07-15, areaCode=35+sigunguCode=2=경주, 587건 전수 스캔): showflag 는 문자열
-- '1'(표출)/'0'(비표출) 두 값만 관측됨(제3값 없음) — 판정 로직은 이 두 값 기준으로 확정 구현한다.
--
-- 설계 결정: NOT NULL DEFAULT true. 컬럼 추가 시 기존 행 전부가 DEFAULT 로 자동 backfill 되므로
--   (Postgres ADD COLUMN ... NOT NULL DEFAULT 관례 — coupon_rate 컬럼과 동일 패턴) 별도 UPDATE 문이
--   필요 없고, 백엔드 필터도 null 분기 없이 단순 `.eq('is_active', true)` 로 충분하다.
--
-- 적용: Supabase SQL Editor 또는 `supabase db push` 로 1회 실행(재실행해도 안전 — IF NOT EXISTS).
-- ⚠️ 사람 작업 — 원격 DB 적용 전까지 백엔드 필터/ingest 동기화 스텝은 컬럼 부재(42703)를 감지해
--   필터 없이(또는 갱신 생략) 폴백하도록 구현되어 있다(오탐/500 방지, 정직한 저하).
ALTER TABLE public.facilities ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 비표출(폐업 추정) 시설 조회/집계용 부분 인덱스 — 활성 다수 대비 비활성은 소수라
-- uq_facilities_contentid 와 동일한 부분 인덱스 관례를 따른다.
CREATE INDEX IF NOT EXISTS idx_facilities_is_active_false
ON public.facilities (is_active) WHERE is_active = false;

-- ============================= migrations/20260715110001_ingest_requests.sql =============================
-- admin_ingest_requests: TourAPI 실시간 키워드 검색 결과의 적재 요청(대기 큐).
-- 배경(2위 실시간 키워드 게이트웨이): 관광객이 지도 검색에서 0건(적재 85곳 밖 POI)을 만나면
--   TourAPI 키워드 검색(searchKeyword2)으로 폴백해 결과를 보여주되, 그 자리에서 즉시
--   facilities 에 적재하지 않고 "다음 배치 추가 요청"만 큐잉한다(운영자 검수 게이트 — 무단 대량
--   적재/오탐 방지). 관리자(admin/infrastructure)가 승인하면 백엔드가 detailCommon2/Intro2 로
--   단건 인제스트한 뒤 이 행을 status='approved' 로 갱신한다.
--   (apps/api/app/routers/search.py 가 유일한 쓰기/갱신 경로.)
--
-- 쓰기는 전부 FastAPI(service_role) 경유:
--   - POST /api/v1/search/ingest-request 는 무인증이지만 service_role 로 INSERT/upsert 한다
--     (라우터 자체의 IP 레이트리밋이 1차 방어선).
--   - GET /api/v1/search/ingest-requests, POST /api/v1/search/ingest-requests/approve 는
--     require_admin(X-Admin-Authorization) 가드 뒤에서 service_role 로 조회/갱신한다.
-- anon/authenticated 직접 접근 정책은 두지 않는다(security_hardening.sql 의 보수적 기본 거부 관례).

CREATE TABLE IF NOT EXISTS public.admin_ingest_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- TourAPI contentid. UNIQUE 제약은 라우터의 upsert(on_conflict='contentid', ignore_duplicates=True)가
    -- "이미 요청된 곳 재요청은 무시"를 DB 레벨에서 보장하는 데 필요하다(중복 요청 방지).
    contentid TEXT NOT NULL UNIQUE,
    name TEXT,
    content_type_id INT,
    -- 익명 요청 허용(무인증 엔드포인트) — FK 미설정(app_events.user_id 와 동일한 경량 로그 관례).
    requested_by UUID,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    approved_at TIMESTAMP WITH TIME ZONE
);

-- 관리자 대기 목록 조회(status='pending' 최신순) 인덱스.
CREATE INDEX IF NOT EXISTS idx_admin_ingest_requests_status_created
    ON public.admin_ingest_requests (status, created_at DESC);

ALTER TABLE public.admin_ingest_requests ENABLE ROW LEVEL SECURITY;

-- service_role 전용(app_events/merchant_timesales 쓰기 정책과 동일 관례).
-- anon/authenticated 정책 부재 → 직접 접근은 기본 거부된다(백엔드 신뢰 경로만 허용).
DROP POLICY IF EXISTS admin_ingest_requests_service_all ON public.admin_ingest_requests;
CREATE POLICY admin_ingest_requests_service_all ON public.admin_ingest_requests
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================= migrations/20260715120000_tourism_insights.sql =============================
-- 관광공사 관광지 집중률 30일 전망. POI 실시간 혼잡과 의미가 다르므로 congestion_logs에 섞지 않는다.
CREATE TABLE IF NOT EXISTS public.tourism_concentration_forecasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tourist_attraction_code TEXT,
    tourist_attraction_name TEXT NOT NULL,
    forecast_date DATE NOT NULL,
    concentration_rate NUMERIC NOT NULL CHECK (concentration_rate BETWEEN 0 AND 100),
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tourist_attraction_name, forecast_date)
);

CREATE INDEX IF NOT EXISTS idx_tourism_concentration_date
    ON public.tourism_concentration_forecasts (forecast_date, tourist_attraction_name);

ALTER TABLE public.tourism_concentration_forecasts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tourism_concentration_service_all ON public.tourism_concentration_forecasts;
CREATE POLICY tourism_concentration_service_all ON public.tourism_concentration_forecasts
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Tmap 이동 기반 연관 관광지와 지역 수요 API는 제공 스키마 변경에 대비해 원문도 보존한다.
CREATE TABLE IF NOT EXISTS public.tourism_insight_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    insight_type TEXT NOT NULL CHECK (insight_type IN ('related_attraction', 'regional_stay', 'regional_spend')),
    reference_period TEXT NOT NULL,
    region_code TEXT NOT NULL DEFAULT '47130',
    payload JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (insight_type, reference_period, region_code)
);

ALTER TABLE public.tourism_insight_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tourism_insights_service_all ON public.tourism_insight_snapshots;
CREATE POLICY tourism_insights_service_all ON public.tourism_insight_snapshots
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- detailImage2 서브 이미지. firstimage 대표 URL과 구분해 순서를 보존한다.
ALTER TABLE public.facilities
    ADD COLUMN IF NOT EXISTS gallery_images JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ============================= migrations/20260715130000_latest_congestion_rpc.sql =============================
-- 시설별 최신 혼잡을 한 번의 DB 왕복으로 반환한다. DISTINCT ON은 기존
-- (facility_id, timestamp DESC) 인덱스를 사용하며 동일 timestamp는 id DESC로 결정한다.
CREATE OR REPLACE FUNCTION public.latest_congestion_for_facilities(facility_ids UUID[])
RETURNS TABLE (
    facility_id UUID,
    congestion_level DOUBLE PRECISION,
    current_count INT,
    "timestamp" TIMESTAMPTZ,
    source VARCHAR
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT ON (c.facility_id)
        c.facility_id, c.congestion_level, c.current_count, c.timestamp, c.source
    FROM public.congestion_logs AS c
    WHERE c.facility_id = ANY(facility_ids)
    ORDER BY c.facility_id, c.timestamp DESC, c.id DESC;
$$;

GRANT EXECUTE ON FUNCTION public.latest_congestion_for_facilities(UUID[])
    TO anon, authenticated, service_role;

-- ============================= migrations/20260715140000_oauth_profile_fields.sql =============================
-- OAuth 프로필 필드 + handle_new_user 확장 (2026-07-15) — docs/OAUTH_PLAN.md M1
-- 배경: 익명(무마찰) 세션 위에 카카오·구글 OAuth 연동을 얹는다(linkIdentity 승격).
--   OAuth 가입/연동 시 프로바이더가 주는 닉네임·프로필 이미지를 public.users 에 보존해
--   마이페이지가 실제 이름/아바타를 표시할 수 있게 한다.
--
-- 1) users.avatar_url: OAuth 프로바이더 프로필 이미지 URL(nullable). 익명/이메일 미제공 시 NULL.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- 2) handle_new_user() 확장 — auth.users INSERT 시 raw_user_meta_data 에서 프로필을 채운다.
--    · 익명 가입: raw_user_meta_data 가 비어 있어 nickname/avatar_url 은 NULL → 기존 동작과 동일.
--    · OAuth '신규' 가입(기기 B 등 익명 세션 없이 바로 로그인): full_name/name/avatar_url 을 복사.
--    ⚠️ 익명 사용자의 linkIdentity 승격은 auth.users 를 UPDATE 하므로 이 트리거(AFTER INSERT)를
--       타지 않는다. 그 경로의 프로필 백필은 프런트(lib/auth.ts)가 승격 직후 users 를 UPDATE 로 채운다.
--    COALESCE(full_name, name): 프로바이더마다 키가 달라(구글=name, 카카오=full_name/name 혼재) 폴백한다.
--    ON CONFLICT (id) DO NOTHING: 승격 전 익명 INSERT 로 이미 행이 있으면 보존(재실행 안전).
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO public.users (id, preferred_categories, nickname, avatar_url)
    VALUES (
        NEW.id,
        '[]'::jsonb,
        COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
        NEW.raw_user_meta_data->>'avatar_url'
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- 트리거는 20260710160000 에서 이미 생성됨(on_auth_user_created) — 함수만 교체하면 되므로 재생성 불필요.

-- ============================= migrations/20260715150000_saved_facilities.sql =============================
-- saved_facilities: 사용자가 저장한 장소(북마크) — 계정(user_id) 기준 DB 영속화.
-- 배경: 저장 장소가 localStorage(기기 단위)에만 있어 ① 기기 변경 시 유실 ② 로그아웃/전환 시 다음
--   사용자에게 유출됐다. 이제 사용자별로 DB 에 저장해 기기가 바뀌어도 따라오고, RLS 로 사용자 간 격리한다.
-- 스냅샷 보존: 저장 시점의 이름·카테고리·SPOT 점수·사유·좌표를 data(jsonb)에 그대로 담는다(프런트 구조 유지).
-- 익명 세션도 authenticated 역할이라 본인 uid 로 저장 가능 — linkIdentity(승격) 시 uid 유지로 그대로 승계된다.

CREATE TABLE IF NOT EXISTS public.saved_facilities (
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- 북마크 식별자(대개 facilities.id UUID; 스냅샷 저장이라 FK/UUID 를 강제하지 않는다).
    facility_id TEXT NOT NULL,
    data JSONB NOT NULL,  -- 저장 시점 북마크 스냅샷(id/name/category/spot/reason/좌표)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, facility_id)
);

-- 본인 저장 목록 조회 인덱스(PK 선두가 user_id 라 대개 충분하지만 명시).
CREATE INDEX IF NOT EXISTS idx_saved_facilities_user ON public.saved_facilities (user_id);

ALTER TABLE public.saved_facilities ENABLE ROW LEVEL SECURITY;

-- 개인 데이터 — 클라이언트가 본인 행만 직접 CRUD(user_feedback insert 정책과 동일한 auth.uid() 격리).
DROP POLICY IF EXISTS saved_facilities_select_own ON public.saved_facilities;
CREATE POLICY saved_facilities_select_own ON public.saved_facilities FOR SELECT TO authenticated
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS saved_facilities_insert_own ON public.saved_facilities;
CREATE POLICY saved_facilities_insert_own ON public.saved_facilities FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS saved_facilities_update_own ON public.saved_facilities;
CREATE POLICY saved_facilities_update_own ON public.saved_facilities FOR UPDATE TO authenticated
    USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS saved_facilities_delete_own ON public.saved_facilities;
CREATE POLICY saved_facilities_delete_own ON public.saved_facilities FOR DELETE TO authenticated
    USING (auth.uid() = user_id);

-- service_role 전체 허용(백엔드 필요 시).
DROP POLICY IF EXISTS saved_facilities_service_all ON public.saved_facilities;
CREATE POLICY saved_facilities_service_all ON public.saved_facilities
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- updated_at 자동 갱신(20250523120000_init.sql 의 handle_updated_at 재사용).
DROP TRIGGER IF EXISTS update_saved_facilities_modtime ON public.saved_facilities;
CREATE TRIGGER update_saved_facilities_modtime
    BEFORE UPDATE ON public.saved_facilities
    FOR EACH ROW
    EXECUTE PROCEDURE public.handle_updated_at();

-- ============================= migrations/20260716140000_rejection_lab.sql =============================
-- 거절 실험실(Rejection Lab) — user_feedback 확장.
-- 배경: 기존 피드백은 accepted|rejected|ignored 3종뿐이라 "왜 거절했는지"를 알 수 없었고,
--   preference_vector_service 가 accepted 외 모든 액션을 일괄 -5% 로 학습해
--   단순 '다음' 스와이프·'다른 대안 보기'까지 취향 벡터를 깎는 오학습이 있었다
--   (docs/REJECTION_LAB_AUDIT.md, docs/COMMERCIAL_PRODUCT_IDEAS.md §2).
-- 의도:
--   1) 액션 어휘를 의도별로 분리한다. 결정 액션(accepted_visit_intent/rejected/skipped/
--      dismissed_batch/unsaved)과 품질 신호(helpful/not_helpful)를 구분해, 학습은 명시적
--      거절 이유가 확보된 경우에만 정확히 1회 적용한다.
--   2) 거절은 즉시 학습하지 않고 reason_status='pending' 으로 적재한다. 나중에 실험실 화면에서
--      사용자가 이유(reason_code)를 답하면 learning_scope 에 따라 장기 학습 여부를 결정한다.
--   3) learning_applied_at/learning_version 으로 중복 학습을 차단한다(멱등).
-- 데이터 보존: 기존 행(현재 action='accepted' 1행)을 지우지 않기 위해 legacy 어휘
--   (accepted, rejected, ignored)를 CHECK 에 남긴다. API 입력 Literal 에서만 제외한다.
-- ⚠️ action 은 원래 VARCHAR(20) 이었는데 신규 값 'accepted_visit_intent' 가 21자라 들어가지 않는다.
--   → TEXT 로 확장한다(길이 상한은 CHECK 목록이 대신한다).
-- 재실행 안전: DROP ... IF EXISTS / ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
--   새 테이블·함수를 만들지 않으므로 scripts/build_reset.mjs 의 PRELUDE DROP 목록은 수정 불필요
--   (user_feedback 은 이미 DROP 대상에 포함되어 있다).

-- ---------------------------------------------------------------------------
-- 1) action: 길이 확장 + 신규/legacy 어휘로 CHECK 교체
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_action_check;

ALTER TABLE public.user_feedback ALTER COLUMN action TYPE TEXT;

ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_action_check
    CHECK (action IN (
        -- 신규 어휘
        'accepted_visit_intent',  -- 실제 방문 수락(길안내/수락) — 쿠폰·성과지표·벡터 +10%
        'rejected',               -- 명시 거절 — reason_status='pending', 장기 학습은 이유 응답 후
        'skipped',                -- 음성 '다음'/나중에 — 학습 없음
        'dismissed_batch',        -- '다른 대안 보기' — 학습 없음
        'unsaved',                -- 저장 해제 — 학습 없음
        'helpful',                -- 만족도 👍 — 품질 신호만, 벡터 학습 없음
        'not_helpful',            -- 만족도 👎 — 품질 신호만, 벡터 학습 없음
        -- legacy(기존 행 보존용. API 입력에선 제외. 'rejected' 는 신규와 어휘 공유)
        'accepted',
        'ignored'
    ));

-- ---------------------------------------------------------------------------
-- 2) 상세 이유 / 학습 상태 컬럼
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS reason_note TEXT;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS reason_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS reason_answered_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS learning_scope TEXT NOT NULL DEFAULT 'none';
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS learning_applied_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.user_feedback ADD COLUMN IF NOT EXISTS learning_version INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.user_feedback.reason_code IS '거절 상세 이유(실험실 응답). NULL=미응답.';
COMMENT ON COLUMN public.user_feedback.reason_note IS '자유 서술 이유(<=200자).';
COMMENT ON COLUMN public.user_feedback.reason_status IS 'none|pending|answered|skipped|expired — pending 만 실험실 목록에 뜬다.';
COMMENT ON COLUMN public.user_feedback.hidden_at IS '사용자가 실험실 목록에서 숨긴 시각. NOT NULL 이면 목록 제외.';
COMMENT ON COLUMN public.user_feedback.learning_scope IS 'none|session|long_term|data_quality — reason_code 로부터 결정. long_term 만 취향 벡터를 움직인다.';
COMMENT ON COLUMN public.user_feedback.learning_applied_at IS '학습 적용 시각. NOT NULL 이면 재적용 금지(멱등 가드).';
COMMENT ON COLUMN public.user_feedback.learning_version IS '적용된 학습 로직 버전. 0=미적용.';

-- CHECK 제약 (재실행 안전을 위해 DROP 후 재생성)
ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_reason_code_check;
ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_reason_code_check
    CHECK (reason_code IS NULL OR reason_code IN (
        'too_far',          -- long_term
        'too_crowded',      -- long_term
        'not_my_taste',     -- long_term
        'too_expensive',    -- long_term
        'closed',           -- data_quality (취향 학습 금지)
        'inaccurate',       -- data_quality (취향 학습 금지)
        'already_visited',  -- none (재추천 억제만)
        'bad_timing',       -- session
        'other'             -- none
    ));

ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_reason_note_check;
ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_reason_note_check
    CHECK (reason_note IS NULL OR char_length(reason_note) <= 200);

ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_reason_status_check;
ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_reason_status_check
    CHECK (reason_status IN ('none', 'pending', 'answered', 'skipped', 'expired'));

ALTER TABLE public.user_feedback DROP CONSTRAINT IF EXISTS user_feedback_learning_scope_check;
ALTER TABLE public.user_feedback
    ADD CONSTRAINT user_feedback_learning_scope_check
    CHECK (learning_scope IN ('none', 'session', 'long_term', 'data_quality'));

-- ---------------------------------------------------------------------------
-- 3) 결정 액션 멱등성 — 방어적 dedupe 후 부분 UNIQUE 인덱스
--    한 추천(recommendation_id)에 결정 액션 행은 하나만 존재해야 중복 학습이 불가능해진다.
--    (helpful/not_helpful 은 결정이 아닌 품질 신호라 제외 — 수락 후에도 남길 수 있어야 한다.)
--    ⚠️ dedupe 는 인덱스 생성 **직전**에 수행해야 한다. 현재 중복은 0건이지만(감사 확인),
--       원격 DB 가 그 사이 앞서갔을 수 있으므로 방어적으로 둔다.
--       가장 이른 행(timestamp ASC)만 남기고, 동률이면 id ASC 로 tiebreak — 결정적 결과.
-- ---------------------------------------------------------------------------
DELETE FROM public.user_feedback f
 WHERE f.action IN ('accepted_visit_intent', 'rejected', 'skipped',
                    'dismissed_batch', 'unsaved', 'accepted', 'ignored')
   AND EXISTS (
       SELECT 1
         FROM public.user_feedback keep
        WHERE keep.recommendation_id = f.recommendation_id
          AND keep.action IN ('accepted_visit_intent', 'rejected', 'skipped',
                              'dismissed_batch', 'unsaved', 'accepted', 'ignored')
          AND (keep.timestamp, keep.id) < (f.timestamp, f.id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_feedback_decision_recommendation
    ON public.user_feedback (recommendation_id)
    WHERE action IN ('accepted_visit_intent', 'rejected', 'skipped',
                     'dismissed_batch', 'unsaved', 'accepted', 'ignored');

-- ---------------------------------------------------------------------------
-- 4) 실험실 목록 조회 인덱스 — GET /api/v1/lab/pending (본인·미숨김·최신순 10건)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_user_feedback_lab_pending
    ON public.user_feedback (user_id, timestamp DESC)
    WHERE reason_status = 'pending' AND hidden_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5) RLS — 본인 행 UPDATE 허용(실험실에서 이유 응답/스킵/숨김).
--    service_role_all_feedback(FOR ALL)·select_feedback·insert_feedback 은 20250523120001_rls.sql 에 이미 있다.
--    USING 과 WITH CHECK 를 모두 user_id = auth.uid() 로 묶어 타인 소유로의 이전(user_id 변조)을 막는다.
--    ⚠️ 백엔드는 service_role 로 접근하므로 이 정책을 우회한다 — 소유권 검사는 라우터에서 명시적으로 한다.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS update_feedback ON public.user_feedback;
CREATE POLICY update_feedback ON public.user_feedback FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ============================= migrations/20260716150000_recommendation_source.sql =============================
-- 메인 브라우즈의 '관심 없음'도 나의 실험실로 보내되, SPOT 추천 노출과 섞지 않는다.
-- source='browse' 행은 B2G 수락률·머천트 추천 제안 분모에서 제외해 성과 지표를 보존한다.
ALTER TABLE public.recommendations
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'spot';

ALTER TABLE public.recommendations
    DROP CONSTRAINT IF EXISTS recommendations_source_check;

ALTER TABLE public.recommendations
    ADD CONSTRAINT recommendations_source_check
    CHECK (source IN ('spot', 'browse'));

COMMENT ON COLUMN public.recommendations.source IS
    '추천 유입 경로: spot=성과 집계 대상, browse=메인 탐색 거절의 실험실 유입 전용(성과 집계 제외)';

-- ============================= migrations/20260719120000_recommendation_snapshot.sql =============================
-- 생성 당시 추천 수치와 검증된 시설 사실을 고정해, 이후 데이터 변경이 설명을 왜곡하지 않게 한다.
ALTER TABLE public.recommendations
    ADD COLUMN IF NOT EXISTS recommendation_snapshot JSONB;

COMMENT ON COLUMN public.recommendations.recommendation_snapshot IS
    '추천 생성 당시 시설 사실·SPOT 점수·순위·도착 상태 스냅샷. 설명 API는 이 값만 사용한다.';

-- ============================= migrations/20260721120000_localdata_sources.sql =============================
-- 공공 인허가 원본 식별자와 상태를 시설 본문에서 분리해 보존한다.
CREATE TABLE IF NOT EXISTS public.facility_source_refs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('tourapi', 'localdata')),
    external_id TEXT NOT NULL,
    source_status TEXT,
    source_updated_at TIMESTAMP WITH TIME ZONE,
    source_hash TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_facility_source_refs_facility
    ON public.facility_source_refs (facility_id);

CREATE TRIGGER update_facility_source_refs_modtime
    BEFORE UPDATE ON public.facility_source_refs
    FOR EACH ROW EXECUTE PROCEDURE public.handle_updated_at();

ALTER TABLE public.facility_source_refs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "facility source refs are publicly readable"
    ON public.facility_source_refs FOR SELECT USING (true);

-- 한 RPC 호출 안에서만 시설과 출처를 함께 변경한다. 예외가 나면 PostgreSQL이 전부 롤백한다.
CREATE OR REPLACE FUNCTION public.apply_localdata_sync(actions JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    action JSONB;
    target_id UUID;
    inserted_count INT := 0;
    merged_count INT := 0;
    deactivated_count INT := 0;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required';
    END IF;

    FOR action IN SELECT value FROM jsonb_array_elements(actions)
    LOOP
        target_id := NULLIF(action->>'facility_id', '')::UUID;
        IF target_id IS NULL THEN
            INSERT INTO public.facilities
                (name, type, latitude, longitude, capacity, operating_hours, features, address, is_active)
            VALUES
                (action->>'name', action->>'type', (action->>'latitude')::double precision,
                 (action->>'longitude')::double precision, (action->>'capacity')::int,
                 COALESCE(action->'operating_hours', '{}'::jsonb), COALESCE(action->'features', '{}'::jsonb),
                 action->>'address', COALESCE((action->>'is_active')::boolean, false))
            RETURNING id INTO target_id;
            inserted_count := inserted_count + 1;
        ELSE
            -- LOCALDATA는 풍부한 TourAPI 필드를 덮지 않는다. 폐업 근거만 즉시 우선한다.
            IF COALESCE((action->>'is_active')::boolean, false) = false THEN
                UPDATE public.facilities SET is_active = false WHERE id = target_id;
                deactivated_count := deactivated_count + 1;
            ELSE
                -- 다른 LOCALDATA 휴업/폐업 근거가 하나라도 있으면 재활성화하지 않는다.
                UPDATE public.facilities f SET is_active = true
                WHERE f.id = target_id
                  AND NOT EXISTS (
                    SELECT 1 FROM public.facility_source_refs r
                    WHERE r.facility_id = f.id AND r.source = 'localdata'
                      AND r.external_id <> action->>'external_id'
                      AND COALESCE(r.source_status, '') <> '01'
                  )
                  AND NOT COALESCE((f.features->>'temporarily_inactive_until')::date >=
                                   (now() AT TIME ZONE 'Asia/Seoul')::date, false);
            END IF;
            merged_count := merged_count + 1;
        END IF;

        INSERT INTO public.facility_source_refs
            (facility_id, source, external_id, source_status, source_updated_at, source_hash)
        VALUES
            (target_id, 'localdata', action->>'external_id', action->>'source_status',
             NULLIF(action->>'source_updated_at', '')::timestamptz, action->>'source_hash')
        ON CONFLICT (source, external_id) DO UPDATE SET
            facility_id = EXCLUDED.facility_id,
            source_status = EXCLUDED.source_status,
            source_updated_at = EXCLUDED.source_updated_at,
            source_hash = EXCLUDED.source_hash;
    END LOOP;
    RETURN jsonb_build_object('inserted', inserted_count, 'merged', merged_count,
                              'deactivated', deactivated_count);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_localdata_sync(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_localdata_sync(JSONB) TO service_role;

-- ============================= migrations/20260819120000_recommendation_trust_loop.sql =============================
-- 추천 신뢰도 폐루프: 비공개 모델 레지스트리, 방문 결과, 혼잡 근거 등급.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'recommendation-models',
    'recommendation-models',
    false,
    52428800,
    ARRAY['application/octet-stream']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.model_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version TEXT NOT NULL UNIQUE,
    storage_path TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    feature_schema_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'candidate'
        CHECK (status IN ('candidate', 'active', 'rejected', 'rolled_back')),
    training_started_at TIMESTAMPTZ NOT NULL,
    training_ended_at TIMESTAMPTZ NOT NULL,
    real_data_count INTEGER NOT NULL CHECK (real_data_count >= 0),
    source_composition JSONB NOT NULL DEFAULT '{}'::jsonb,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    approved_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    CHECK (training_ended_at >= training_started_at)
);

-- 활성 모델은 언제나 하나뿐이다. 교체는 아래 promote 함수의 한 트랜잭션에서 수행한다.
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_registry_one_active
    ON public.model_registry ((status)) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_model_registry_created_at
    ON public.model_registry (created_at DESC);

ALTER TABLE public.model_registry ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all_model_registry ON public.model_registry;
CREATE POLICY service_role_all_model_registry ON public.model_registry
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Storage 객체는 공개 정책을 만들지 않는다. service_role만 RLS 우회로 읽고 쓴다.

CREATE OR REPLACE FUNCTION public.promote_recommendation_model(p_version TEXT)
RETURNS public.model_registry
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    promoted public.model_registry;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;

    UPDATE public.model_registry
       SET status = 'rolled_back'
     WHERE status = 'active' AND version <> p_version;

    UPDATE public.model_registry
       SET status = 'active',
           approved_at = COALESCE(approved_at, timezone('utc', now())),
           activated_at = timezone('utc', now())
     WHERE version = p_version AND status IN ('candidate', 'rolled_back', 'active')
     RETURNING * INTO promoted;

    IF promoted.id IS NULL THEN
        RAISE EXCEPTION 'promotable model not found: %', p_version USING ERRCODE = 'P0002';
    END IF;

    RETURN promoted;
END;
$$;
REVOKE ALL ON FUNCTION public.promote_recommendation_model(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_recommendation_model(TEXT) TO service_role;

ALTER TABLE public.congestion_logs
    ADD COLUMN IF NOT EXISTS evidence_tier TEXT NOT NULL DEFAULT 'synthetic',
    ADD COLUMN IF NOT EXISTS reporter_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.congestion_logs
    DROP CONSTRAINT IF EXISTS congestion_logs_evidence_tier_check;
ALTER TABLE public.congestion_logs
    ADD CONSTRAINT congestion_logs_evidence_tier_check
    CHECK (evidence_tier IN ('synthetic', 'single_report', 'corroborated', 'verified'));

-- 기존 seed/simulated 데이터는 항상 synthetic. 운영 검증 소스만 verified로 명시 승격한다.
UPDATE public.congestion_logs
   SET evidence_tier = CASE
       WHEN source IN ('traffic_cctv', 'tour_api', 'event') THEN 'verified'
       WHEN source = 'user_report' THEN 'single_report'
       ELSE 'synthetic'
   END;

CREATE INDEX IF NOT EXISTS idx_congestion_logs_training_evidence
    ON public.congestion_logs (evidence_tier, timestamp DESC, facility_id);

DROP FUNCTION IF EXISTS public.latest_congestion_for_facilities(UUID[]);
CREATE FUNCTION public.latest_congestion_for_facilities(facility_ids UUID[])
RETURNS TABLE (
    facility_id UUID,
    congestion_level DOUBLE PRECISION,
    current_count INT,
    "timestamp" TIMESTAMPTZ,
    source VARCHAR,
    evidence_tier TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT ON (c.facility_id)
        c.facility_id, c.congestion_level, c.current_count, c.timestamp, c.source, c.evidence_tier
    FROM public.congestion_logs AS c
    WHERE c.facility_id = ANY(facility_ids)
    ORDER BY c.facility_id, c.timestamp DESC, c.id DESC;
$$;
GRANT EXECUTE ON FUNCTION public.latest_congestion_for_facilities(UUID[])
    TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.correlate_congestion_report_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    matching_users INTEGER;
BEGIN
    IF NEW.source <> 'user_report' OR NEW.reporter_user_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT count(DISTINCT reporter_user_id) INTO matching_users
      FROM public.congestion_logs
     WHERE facility_id = NEW.facility_id
       AND source = 'user_report'
       AND reporter_user_id IS NOT NULL
       AND timestamp BETWEEN NEW.timestamp - interval '30 minutes' AND NEW.timestamp + interval '30 minutes'
       AND abs(congestion_level - NEW.congestion_level) <= 0.05;
    IF matching_users >= 2 THEN
        UPDATE public.congestion_logs
           SET evidence_tier = 'corroborated'
         WHERE facility_id = NEW.facility_id
           AND source = 'user_report'
           AND timestamp BETWEEN NEW.timestamp - interval '30 minutes' AND NEW.timestamp + interval '30 minutes'
           AND abs(congestion_level - NEW.congestion_level) <= 0.05;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS correlate_congestion_report_evidence ON public.congestion_logs;
CREATE TRIGGER correlate_congestion_report_evidence
    AFTER INSERT ON public.congestion_logs
    FOR EACH ROW EXECUTE FUNCTION public.correlate_congestion_report_evidence();

CREATE TABLE IF NOT EXISTS public.recommendation_outcomes (
    recommendation_id UUID PRIMARY KEY REFERENCES public.recommendations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    navigation_started_at TIMESTAMPTZ NOT NULL,
    arrival_confirmed_at TIMESTAMPTZ,
    rated_at TIMESTAMPTZ,
    rating TEXT CHECK (rating IN ('up', 'down')),
    observed_congestion TEXT CHECK (observed_congestion IN ('quiet', 'normal', 'busy')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    CHECK (arrival_confirmed_at IS NULL OR arrival_confirmed_at >= navigation_started_at),
    CHECK (rated_at IS NULL OR (arrival_confirmed_at IS NOT NULL AND rated_at >= arrival_confirmed_at)),
    CHECK ((rated_at IS NULL AND rating IS NULL) OR (rated_at IS NOT NULL AND rating IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_user
    ON public.recommendation_outcomes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recommendation_outcomes_training
    ON public.recommendation_outcomes (arrival_confirmed_at DESC)
    WHERE observed_congestion IS NOT NULL;

ALTER TABLE public.recommendation_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all_recommendation_outcomes ON public.recommendation_outcomes;
CREATE POLICY service_role_all_recommendation_outcomes ON public.recommendation_outcomes
    FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS select_own_recommendation_outcomes ON public.recommendation_outcomes;
CREATE POLICY select_own_recommendation_outcomes ON public.recommendation_outcomes
    FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.record_recommendation_outcome(
    p_recommendation_id UUID,
    p_user_id UUID,
    p_stage TEXT,
    p_rating TEXT DEFAULT NULL,
    p_observed_congestion TEXT DEFAULT NULL
)
RETURNS public.recommendation_outcomes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    rec_owner UUID;
    current_row public.recommendation_outcomes;
    server_now TIMESTAMPTZ := timezone('utc', now());
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;
    IF p_stage NOT IN ('navigation_started', 'arrival_confirmed', 'rated') THEN
        RAISE EXCEPTION 'invalid outcome stage' USING ERRCODE = '22023';
    END IF;
    IF p_stage = 'rated' AND p_rating NOT IN ('up', 'down') THEN
        RAISE EXCEPTION 'rating required for rated stage' USING ERRCODE = '22023';
    END IF;
    IF p_stage <> 'rated' AND p_rating IS NOT NULL THEN
        RAISE EXCEPTION 'rating is only valid for rated stage' USING ERRCODE = '22023';
    END IF;
    IF p_observed_congestion IS NOT NULL
       AND p_observed_congestion NOT IN ('quiet', 'normal', 'busy') THEN
        RAISE EXCEPTION 'invalid observed congestion' USING ERRCODE = '22023';
    END IF;

    SELECT user_id INTO rec_owner
      FROM public.recommendations
     WHERE id = p_recommendation_id;
    IF rec_owner IS NULL THEN
        RAISE EXCEPTION 'recommendation not found' USING ERRCODE = 'P0002';
    END IF;
    IF rec_owner <> p_user_id THEN
        RAISE EXCEPTION 'recommendation owner mismatch' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO current_row
      FROM public.recommendation_outcomes
     WHERE recommendation_id = p_recommendation_id
     FOR UPDATE;

    IF current_row.recommendation_id IS NULL THEN
        IF p_stage <> 'navigation_started' THEN
            RAISE EXCEPTION 'navigation_started must be recorded first' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.recommendation_outcomes (
            recommendation_id, user_id, navigation_started_at
        ) VALUES (p_recommendation_id, p_user_id, server_now)
        RETURNING * INTO current_row;
        RETURN current_row;
    END IF;

    IF p_stage = 'arrival_confirmed' AND current_row.arrival_confirmed_at IS NULL THEN
        UPDATE public.recommendation_outcomes
           SET arrival_confirmed_at = server_now, updated_at = server_now
         WHERE recommendation_id = p_recommendation_id
         RETURNING * INTO current_row;
    ELSIF p_stage = 'rated' THEN
        IF current_row.arrival_confirmed_at IS NULL THEN
            RAISE EXCEPTION 'arrival_confirmed must be recorded first' USING ERRCODE = '22023';
        END IF;
        IF current_row.rated_at IS NULL THEN
            UPDATE public.recommendation_outcomes
               SET rated_at = server_now,
                   rating = p_rating,
                   observed_congestion = p_observed_congestion,
                   updated_at = server_now
             WHERE recommendation_id = p_recommendation_id
             RETURNING * INTO current_row;
        ELSIF current_row.rating = p_rating
              AND current_row.observed_congestion IS NULL
              AND p_observed_congestion IS NOT NULL THEN
            UPDATE public.recommendation_outcomes
               SET observed_congestion = p_observed_congestion, updated_at = server_now
             WHERE recommendation_id = p_recommendation_id
             RETURNING * INTO current_row;
        ELSIF current_row.rating <> p_rating THEN
            RAISE EXCEPTION 'rating cannot be changed' USING ERRCODE = '22023';
        END IF;
    END IF;

    RETURN current_row;
END;
$$;
REVOKE ALL ON FUNCTION public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT)
    TO service_role;

-- ============================= migrations/20260820123000_connect_congestion_collection.sql =============================
-- 현장 혼잡 수집 경로 연결
-- 1) 방문 완료 후 체감 혼잡을 recommendation_outcomes 에만 두지 않고 congestion_logs 로 투영한다.
-- 2) 사장 좌석 방송을 별도 출처로 보존하고, 매장 운영자가 직접 확인한 현장값이므로
--    merchant_report/verified 로 즉시 학습 가능한 관측에 포함한다.

ALTER TABLE public.congestion_logs
    DROP CONSTRAINT IF EXISTS congestion_logs_source_check;
ALTER TABLE public.congestion_logs
    ADD CONSTRAINT congestion_logs_source_check
    CHECK (source IN (
        'traffic_cctv', 'tour_api', 'event', 'user_report', 'merchant_report', 'seed', 'simulated'
    ));

ALTER TABLE public.congestion_logs
    ADD COLUMN IF NOT EXISTS origin_outcome_id UUID
    REFERENCES public.recommendation_outcomes(recommendation_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_congestion_logs_origin_outcome
    ON public.congestion_logs(origin_outcome_id)
    WHERE origin_outcome_id IS NOT NULL;

-- 공개 현재 혼잡 조회는 실제 현장 관측만 반환한다. seed/simulated는 개발 이력으로 보존하되
-- 지도·추천의 '지금 혼잡' 후보가 될 수 없다.
CREATE OR REPLACE FUNCTION public.latest_congestion_for_facilities(facility_ids UUID[])
RETURNS TABLE (
    facility_id UUID,
    congestion_level DOUBLE PRECISION,
    current_count INT,
    "timestamp" TIMESTAMPTZ,
    source VARCHAR,
    evidence_tier TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT ON (c.facility_id)
        c.facility_id, c.congestion_level, c.current_count, c.timestamp, c.source, c.evidence_tier
    FROM public.congestion_logs AS c
    WHERE c.facility_id = ANY(facility_ids)
      AND c.evidence_tier IN ('single_report', 'corroborated', 'verified')
      AND c.source NOT IN ('seed', 'simulated')
    ORDER BY c.facility_id, c.timestamp DESC, c.id DESC;
$$;

CREATE OR REPLACE FUNCTION public.project_outcome_congestion_log()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    target_facility_id UUID;
    target_capacity INTEGER;
    normalized_level DOUBLE PRECISION;
BEGIN
    -- rated 멱등 재요청이나 다른 필드 갱신으로 동일 관측을 중복 적재하지 않는다.
    IF NEW.observed_congestion IS NULL
       OR (TG_OP = 'UPDATE' AND OLD.observed_congestion IS NOT NULL) THEN
        RETURN NEW;
    END IF;

    normalized_level := CASE NEW.observed_congestion
        WHEN 'quiet' THEN 0.2
        WHEN 'normal' THEN 0.5
        WHEN 'busy' THEN 0.8
        ELSE NULL
    END;
    IF normalized_level IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT r.recommended_facility_id, f.capacity
      INTO target_facility_id, target_capacity
      FROM public.recommendations AS r
      JOIN public.facilities AS f ON f.id = r.recommended_facility_id
     WHERE r.id = NEW.recommendation_id;

    IF target_facility_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.congestion_logs (
        facility_id, timestamp, current_count, congestion_level,
        source, evidence_tier, reporter_user_id, origin_outcome_id
    ) VALUES (
        target_facility_id,
        COALESCE(NEW.updated_at, timezone('utc', now())),
        round(COALESCE(target_capacity, 0) * normalized_level),
        normalized_level,
        'user_report',
        'single_report',
        NEW.user_id,
        NEW.recommendation_id
    ) ON CONFLICT (origin_outcome_id) WHERE origin_outcome_id IS NOT NULL DO NOTHING;

    -- congestion_logs 의 correlate_congestion_report_evidence 트리거가 같은 시설·30분 내
    -- 서로 다른 사용자 2명 이상 일치 시 관련 행을 corroborated 로 승격한다.
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_outcome_congestion_log ON public.recommendation_outcomes;
CREATE TRIGGER project_outcome_congestion_log
    AFTER INSERT OR UPDATE OF observed_congestion ON public.recommendation_outcomes
    FOR EACH ROW EXECUTE FUNCTION public.project_outcome_congestion_log();

-- 마이그레이션 전에 이미 받은 체감 혼잡도도 같은 단일 관측으로 한 번만 이관한다.
INSERT INTO public.congestion_logs (
    facility_id, timestamp, current_count, congestion_level,
    source, evidence_tier, reporter_user_id, origin_outcome_id
)
SELECT
    r.recommended_facility_id,
    COALESCE(o.updated_at, o.rated_at, timezone('utc', now())),
    round(COALESCE(f.capacity, 0) * CASE o.observed_congestion
        WHEN 'quiet' THEN 0.2 WHEN 'normal' THEN 0.5 WHEN 'busy' THEN 0.8 END),
    CASE o.observed_congestion
        WHEN 'quiet' THEN 0.2 WHEN 'normal' THEN 0.5 WHEN 'busy' THEN 0.8 END,
    'user_report', 'single_report', o.user_id, o.recommendation_id
FROM public.recommendation_outcomes AS o
JOIN public.recommendations AS r ON r.id = o.recommendation_id
JOIN public.facilities AS f ON f.id = r.recommended_facility_id
WHERE o.observed_congestion IS NOT NULL
ON CONFLICT (origin_outcome_id) WHERE origin_outcome_id IS NOT NULL DO NOTHING;

-- ============================= migrations/20260820220000_add_area_demand_snapshots.sql =============================
-- 경주시 ITS 실측 주차 현황을 15분 단위로 보존한다.
-- 이 테이블은 장소 내부 혼잡이나 예상 대기시간이 아니라, 주변 공영주차 수요의 원본 관측만 저장한다.

CREATE TABLE public.area_demand_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL
        CHECK (source IN ('gyeongju_its', 'national_parking_api')),
    observed_at TIMESTAMPTZ NOT NULL,
    bucket_at TIMESTAMPTZ NOT NULL,
    total_spaces INTEGER NOT NULL CHECK (total_spaces > 0),
    available_spaces INTEGER NOT NULL
        CHECK (available_spaces >= 0 AND available_spaces <= total_spaces),
    occupancy DOUBLE PRECISION GENERATED ALWAYS AS (
        1.0 - available_spaces::DOUBLE PRECISION / total_spaces::DOUBLE PRECISION
    ) STORED,
    live_lot_count INTEGER NOT NULL CHECK (live_lot_count > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
    CONSTRAINT area_demand_snapshots_bucket_aligned CHECK (
        bucket_at = date_bin(
            INTERVAL '15 minutes',
            observed_at,
            TIMESTAMPTZ '1970-01-01 00:00:00+00'
        )
    ),
    CONSTRAINT area_demand_snapshots_source_bucket_key UNIQUE (source, bucket_at)
);

CREATE TABLE public.area_demand_snapshot_lots (
    snapshot_id UUID NOT NULL
        REFERENCES public.area_demand_snapshots(id) ON DELETE CASCADE,
    source_lot_id TEXT NOT NULL CHECK (btrim(source_lot_id) <> ''),
    name TEXT NOT NULL CHECK (btrim(name) <> ''),
    latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90.0 AND 90.0),
    longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180.0 AND 180.0),
    total_spaces INTEGER NOT NULL CHECK (total_spaces > 0),
    available_spaces INTEGER NOT NULL
        CHECK (available_spaces >= 0 AND available_spaces <= total_spaces),
    occupancy DOUBLE PRECISION GENERATED ALWAYS AS (
        1.0 - available_spaces::DOUBLE PRECISION / total_spaces::DOUBLE PRECISION
    ) STORED,
    PRIMARY KEY (snapshot_id, source_lot_id)
);

CREATE INDEX idx_area_demand_snapshots_source_observed
    ON public.area_demand_snapshots(source, observed_at DESC);

ALTER TABLE public.area_demand_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.area_demand_snapshot_lots ENABLE ROW LEVEL SECURITY;

-- 정책을 만들지 않아 브라우저 anon/authenticated 역할은 직접 읽거나 쓸 수 없다.
-- 수집 및 향후 검증된 통계 조회는 서버 service_role 경로에서만 수행한다.

COMMENT ON TABLE public.area_demand_snapshots IS
    '15분 단위 주변 공영주차 실측 집계. 장소 내부 혼잡 또는 예측값이 아님.';
COMMENT ON TABLE public.area_demand_snapshot_lots IS
    'area_demand_snapshots 수집 시점의 주차장별 전체면·잔여면 원본 관측.';
COMMENT ON COLUMN public.area_demand_snapshots.bucket_at IS
    'observed_at을 UTC epoch 기준 15분으로 내린 멱등 수집 키.';
COMMENT ON COLUMN public.area_demand_snapshots.occupancy IS
    '1 - available_spaces / total_spaces로 DB가 계산한 주변 주차 점유율.';

-- 부모 집계와 주차장별 원본을 한 트랜잭션에서 교체한다. 호출자는 집계값이나 버킷을 보내지 않는다.
-- 같은 15분 버킷의 재시도는 한 행을 갱신하며, 늦게 도착한 오래된 관측은 최신 행을 되돌리지 않는다.
CREATE OR REPLACE FUNCTION public.record_area_demand_snapshot(
    p_source TEXT,
    p_observed_at TIMESTAMPTZ,
    p_lots JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    v_bucket_at TIMESTAMPTZ;
    v_lot JSONB;
    v_source_lot_id TEXT;
    v_name TEXT;
    v_latitude DOUBLE PRECISION;
    v_longitude DOUBLE PRECISION;
    v_total INTEGER;
    v_available INTEGER;
    v_total_spaces BIGINT := 0;
    v_available_spaces BIGINT := 0;
    v_live_lot_count INTEGER;
    v_existing public.area_demand_snapshots%ROWTYPE;
    v_snapshot public.area_demand_snapshots%ROWTYPE;
BEGIN
    IF p_source IS NULL
       OR p_source NOT IN ('gyeongju_its', 'national_parking_api') THEN
        RAISE EXCEPTION 'unsupported area demand source'
            USING ERRCODE = '22023';
    END IF;
    IF p_observed_at IS NULL OR NOT isfinite(p_observed_at) THEN
        RAISE EXCEPTION 'observed_at must be a finite timestamp'
            USING ERRCODE = '22023';
    END IF;
    IF p_lots IS NULL
       OR jsonb_typeof(p_lots) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_lots) = 0
       OR jsonb_array_length(p_lots) > 500 THEN
        RAISE EXCEPTION 'lots must be a non-empty array with at most 500 items'
            USING ERRCODE = '22023';
    END IF;

    v_live_lot_count := jsonb_array_length(p_lots);
    FOR v_lot IN
        SELECT item FROM jsonb_array_elements(p_lots) AS entries(item)
    LOOP
        IF jsonb_typeof(v_lot) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'every lot must be an object'
                USING ERRCODE = '22023';
        END IF;

        v_source_lot_id := btrim(COALESCE(v_lot->>'source_lot_id', ''));
        v_name := btrim(COALESCE(v_lot->>'name', ''));
        IF v_source_lot_id = '' OR v_name = '' THEN
            RAISE EXCEPTION 'lot source_lot_id and name are required'
                USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(v_lot->'latitude') IS DISTINCT FROM 'number'
           OR jsonb_typeof(v_lot->'longitude') IS DISTINCT FROM 'number'
           OR jsonb_typeof(v_lot->'total_spaces') IS DISTINCT FROM 'number'
           OR jsonb_typeof(v_lot->'available_spaces') IS DISTINCT FROM 'number'
           OR (v_lot->>'total_spaces') !~ '^[0-9]+$'
           OR (v_lot->>'available_spaces') !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'lot coordinates and space counts must be numeric'
                USING ERRCODE = '22023';
        END IF;

        BEGIN
            v_latitude := (v_lot->>'latitude')::DOUBLE PRECISION;
            v_longitude := (v_lot->>'longitude')::DOUBLE PRECISION;
            v_total := (v_lot->>'total_spaces')::INTEGER;
            v_available := (v_lot->>'available_spaces')::INTEGER;
        EXCEPTION
            WHEN numeric_value_out_of_range OR invalid_text_representation THEN
                RAISE EXCEPTION 'lot numeric value is out of range'
                    USING ERRCODE = '22023';
        END;

        IF v_latitude NOT BETWEEN -90.0 AND 90.0
           OR v_longitude NOT BETWEEN -180.0 AND 180.0
           OR v_total <= 0
           OR v_available < 0
           OR v_available > v_total THEN
            RAISE EXCEPTION 'lot coordinates or space counts are invalid'
                USING ERRCODE = '22023';
        END IF;
        v_total_spaces := v_total_spaces + v_total;
        v_available_spaces := v_available_spaces + v_available;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_lots) AS entries(item)
        GROUP BY btrim(item->>'source_lot_id')
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'duplicate source_lot_id in lots'
            USING ERRCODE = '22023';
    END IF;
    IF v_total_spaces > 2147483647 OR v_available_spaces > 2147483647 THEN
        RAISE EXCEPTION 'aggregate space count is out of range'
            USING ERRCODE = '22023';
    END IF;

    v_bucket_at := date_bin(
        INTERVAL '15 minutes',
        p_observed_at,
        TIMESTAMPTZ '1970-01-01 00:00:00+00'
    );
    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_source || ':' || extract(epoch FROM v_bucket_at)::BIGINT::TEXT, 0)
    );

    SELECT snapshot.*
      INTO v_existing
      FROM public.area_demand_snapshots AS snapshot
     WHERE snapshot.source = p_source
       AND snapshot.bucket_at = v_bucket_at
     FOR UPDATE;

    IF FOUND AND v_existing.observed_at > p_observed_at THEN
        RETURN to_jsonb(v_existing) || jsonb_build_object('stored', false);
    END IF;

    IF v_existing.id IS NULL THEN
        INSERT INTO public.area_demand_snapshots (
            source, observed_at, bucket_at, total_spaces, available_spaces, live_lot_count
        ) VALUES (
            p_source, p_observed_at, v_bucket_at,
            v_total_spaces::INTEGER, v_available_spaces::INTEGER, v_live_lot_count
        )
        RETURNING * INTO v_snapshot;
    ELSE
        UPDATE public.area_demand_snapshots
           SET observed_at = p_observed_at,
               total_spaces = v_total_spaces::INTEGER,
               available_spaces = v_available_spaces::INTEGER,
               live_lot_count = v_live_lot_count
         WHERE id = v_existing.id
        RETURNING * INTO v_snapshot;
    END IF;

    DELETE FROM public.area_demand_snapshot_lots
     WHERE snapshot_id = v_snapshot.id;

    FOR v_lot IN
        SELECT item FROM jsonb_array_elements(p_lots) AS entries(item)
    LOOP
        INSERT INTO public.area_demand_snapshot_lots (
            snapshot_id, source_lot_id, name, latitude, longitude,
            total_spaces, available_spaces
        ) VALUES (
            v_snapshot.id,
            btrim(v_lot->>'source_lot_id'),
            btrim(v_lot->>'name'),
            (v_lot->>'latitude')::DOUBLE PRECISION,
            (v_lot->>'longitude')::DOUBLE PRECISION,
            (v_lot->>'total_spaces')::INTEGER,
            (v_lot->>'available_spaces')::INTEGER
        );
    END LOOP;

    RETURN to_jsonb(v_snapshot) || jsonb_build_object('stored', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_area_demand_snapshot(TEXT, TIMESTAMPTZ, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_area_demand_snapshot(TEXT, TIMESTAMPTZ, JSONB)
    TO service_role;

-- ============================= migrations/20260821130000_correct_verified_facility_coordinates.sql =============================
-- Kakao Local의 유일한 엄격 동명 후보로 확인된 교촌마을 좌표를 교정한다.
-- 월정교·발명체험교육관은 동명/명칭변경 가능성이 있어 자동 수정하지 않는다.
UPDATE public.facilities
SET latitude = 35.8300213535354,
    longitude = 129.217092468907,
    features = COALESCE(features, '{}'::jsonb) || jsonb_build_object(
        'coordinate_source', 'kakao',
        'kakao_place_id', '25182534',
        'kakao_place_url', 'https://place.map.kakao.com/25182534',
        'coordinate_verified_at', '2026-08-21T00:00:00+09:00'
    ),
    updated_at = now()
WHERE id = 'f4000000-0000-0000-0000-000000000002';

-- ============================= migrations/20260821140000_deactivate_unverified_demo_facilities.sql =============================
-- 초기 화면 검증용으로 수기 배치했던 장소는 주소와 외부 장소 ID가 없어 운영 추천에 쓸 수 없다.
-- 삭제하지 않고 비활성화해 기존 추천/로그 FK는 보존한다. Kakao/TourAPI로 검증된 장소는 별도 행을 쓴다.
UPDATE public.facilities
SET is_active = false,
    features = COALESCE(features, '{}'::jsonb) || jsonb_build_object(
        'production_eligible', false,
        'deactivation_reason', 'unverified_demo_seed',
        'deactivated_at', '2026-08-21T00:00:00+09:00'
    ),
    updated_at = now()
WHERE id IN (
    'f1000000-0000-0000-0000-000000000001',
    'f1000000-0000-0000-0000-000000000002',
    'f1000000-0000-0000-0000-000000000003',
    'f1000000-0000-0000-0000-000000000004',
    'f2000000-0000-0000-0000-000000000001',
    'f2000000-0000-0000-0000-000000000002',
    'f2000000-0000-0000-0000-000000000003',
    'f2000000-0000-0000-0000-000000000004',
    'f3000000-0000-0000-0000-000000000001',
    'f3000000-0000-0000-0000-000000000002',
    'f3000000-0000-0000-0000-000000000003',
    'f3000000-0000-0000-0000-000000000004',
    'f4000000-0000-0000-0000-000000000001',
    'f4000000-0000-0000-0000-000000000003',
    'f4000000-0000-0000-0000-000000000004'
);

-- ============================= migrations/20260821150000_verify_woljeonggyo.sql =============================
-- 월정교는 초기 데모 좌표가 실제 교량에서 약 286m 벗어나 있었다.
-- 경주시·한국관광공사가 안내하는 주소(경주시 교동 274)와 일치하는
-- Kakao Local의 유일한 경주 월정교 장소를 수동 검증해 운영 장소로 승격한다.
UPDATE public.facilities
SET latitude = 35.82929954620109,
    longitude = 129.21812129691938,
    address = '경북 경주시 교동 274',
    operating_hours = '{"weekday":"09:00-22:00","weekend":"09:00-22:00"}'::jsonb,
    is_active = true,
    features = (
        COALESCE(features, '{}'::jsonb)
        - 'deactivation_reason'
        - 'deactivated_at'
    ) || jsonb_build_object(
        'production_eligible', true,
        'coordinate_source', 'kakao_manual_verified',
        'kakao_place_id', '1839209698',
        'kakao_place_url', 'https://place.map.kakao.com/1839209698',
        'coordinate_verified_at', '2026-08-21T15:00:00+09:00',
        'address_source', 'gyeongju_visitkorea',
        'opening_hours_source', 'visitkorea'
    ),
    updated_at = now()
WHERE id = 'f3000000-0000-0000-0000-000000000004'
  AND name = '월정교';
