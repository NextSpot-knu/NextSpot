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
DROP TABLE IF EXISTS public.role_audit_log CASCADE;
DROP TABLE IF EXISTS public.business_verification_requests CASCADE;
DROP TABLE IF EXISTS public.facility_owners CASCADE;
DROP TABLE IF EXISTS public.user_feedback CASCADE;
DROP TABLE IF EXISTS public.facility_availability_reports CASCADE;
-- users + facilities 를 함께 참조하는 표(부모 둘보다 반드시 먼저).
DROP TABLE IF EXISTS public.user_coupons CASCADE;
DROP TABLE IF EXISTS public.saved_facilities CASCADE;
-- facilities 만 참조하는 표.
DROP TABLE IF EXISTS public.merchant_timesales CASCADE;
DROP TABLE IF EXISTS public.area_demand_snapshot_lots CASCADE;
DROP TABLE IF EXISTS public.area_demand_snapshots CASCADE;
DROP TABLE IF EXISTS public.recommendation_outcomes CASCADE;
DROP TABLE IF EXISTS public.model_registry CASCADE;
DROP TABLE IF EXISTS public.facility_source_refs CASCADE;
DROP TABLE IF EXISTS public.tourism_insight_snapshots CASCADE;
DROP TABLE IF EXISTS public.tourism_concentration_forecasts CASCADE;
DROP TABLE IF EXISTS public.recommendations CASCADE;
DROP TABLE IF EXISTS public.congestion_logs CASCADE;
-- users 만 참조하는 표(부모보다 먼저 — 예전에는 users 아래에 있었다. CASCADE 덕에
-- 동작은 했지만 "자식 먼저" 규칙을 깨서 목록을 읽기 어렵게 만들고 있었다).
DROP TABLE IF EXISTS public.inquiries CASCADE;
DROP TABLE IF EXISTS public.user_preference_vectors CASCADE;
-- 부모 — facilities 를 먼저, users 를 마지막에.
DROP TABLE IF EXISTS public.facilities CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
-- FK 가 없는 독립 표 — 순서 무관. app_events(누적 퍼널 로그)와
-- admin_ingest_requests(운영자 승인 큐)도 전체 리셋 대상이다(상단 ⚠️ 참고).
DROP TABLE IF EXISTS public.system_settings CASCADE;
DROP TABLE IF EXISTS public.app_events CASCADE;
DROP TABLE IF EXISTS public.admin_ingest_requests CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_info() CASCADE;
DROP FUNCTION IF EXISTS public.get_auth_user_role() CASCADE;
DROP FUNCTION IF EXISTS public.is_admin_or_dev() CASCADE;
DROP FUNCTION IF EXISTS public.guard_users_privileged_columns() CASCADE;
DROP FUNCTION IF EXISTS public.latest_congestion_for_facilities(UUID[]) CASCADE;
DROP FUNCTION IF EXISTS public.apply_localdata_sync(JSONB) CASCADE;
DROP FUNCTION IF EXISTS public.promote_recommendation_model(TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.record_recommendation_outcome(UUID, UUID, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.correlate_congestion_report_evidence() CASCADE;
DROP FUNCTION IF EXISTS public.project_outcome_congestion_log() CASCADE;
DROP FUNCTION IF EXISTS public.merge_guest_account_data(UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.record_facility_availability_report(UUID, UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.recompute_facility_availability_evidence(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.refresh_facility_availability_after_delete() CASCADE;
DROP FUNCTION IF EXISTS public.log_facility_owner_deletion() CASCADE;
DROP FUNCTION IF EXISTS public.area_demand_points_near(DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ, DOUBLE PRECISION, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.merge_guest_account_data_without_availability(UUID, UUID) CASCADE;
DO $$
DECLARE
  v_job_id BIGINT;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR v_job_id IN EXECUTE
      'SELECT jobid FROM cron.job WHERE jobname IN (''nextspot-area-demand-primary'', ''nextspot-area-demand-retry'')'
    LOOP
      EXECUTE format('SELECT cron.unschedule(%s)', v_job_id);
    END LOOP;
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.request_area_demand_collection(BOOLEAN) CASCADE;
DROP FUNCTION IF EXISTS public.configure_area_demand_collection(TEXT, TEXT) CASCADE;
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

-- ============================= migrations/20260824120000_area_demand_ten_minute_buckets.sql =============================
-- 주변 주차 수요 수집 주기를 15분에서 10분으로 높인다.
-- 기존 행은 15분 cadence로 명시해 그대로 보존하고, 이후 RPC 기록만 10분 버킷을 사용한다.

ALTER TABLE public.area_demand_snapshots
    DROP CONSTRAINT IF EXISTS area_demand_snapshots_bucket_aligned;

ALTER TABLE public.area_demand_snapshots
    ADD COLUMN IF NOT EXISTS bucket_minutes SMALLINT;

-- 이 migration 전에 존재한 행은 모두 기존 RPC가 만든 15분 정렬 행이다.
UPDATE public.area_demand_snapshots
   SET bucket_minutes = 15
 WHERE bucket_minutes IS NULL;

ALTER TABLE public.area_demand_snapshots
    ALTER COLUMN bucket_minutes SET DEFAULT 10,
    ALTER COLUMN bucket_minutes SET NOT NULL;

ALTER TABLE public.area_demand_snapshots
    DROP CONSTRAINT IF EXISTS area_demand_snapshots_bucket_cadence_valid;
ALTER TABLE public.area_demand_snapshots
    ADD CONSTRAINT area_demand_snapshots_bucket_cadence_valid CHECK (
        (bucket_minutes = 15 AND bucket_at = date_bin(
            INTERVAL '15 minutes', observed_at,
            TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ))
        OR
        (bucket_minutes = 10 AND bucket_at = date_bin(
            INTERVAL '10 minutes', observed_at,
            TIMESTAMPTZ '1970-01-01 00:00:00+00'
        ))
    );

COMMENT ON TABLE public.area_demand_snapshots IS
    '10분 단위 주변 공영주차 실측 집계. 전환 전 15분 원본은 bucket_minutes=15로 보존. 장소 내부 혼잡 또는 예측값이 아님.';
COMMENT ON COLUMN public.area_demand_snapshots.bucket_at IS
    'observed_at을 UTC epoch 기준 bucket_minutes 간격으로 내린 멱등 수집 키.';
COMMENT ON COLUMN public.area_demand_snapshots.bucket_minutes IS
    '수집 버킷 간격. 전환 전 원본은 15, 현재 수집은 10.';

-- 검증과 자식 원본 교체는 기존 RPC와 동일하고, 서버가 보내지 않는 버킷만 10분으로 계산한다.
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
        INTERVAL '10 minutes',
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
            source, observed_at, bucket_at, bucket_minutes,
            total_spaces, available_spaces, live_lot_count
        ) VALUES (
            p_source, p_observed_at, v_bucket_at, 10,
            v_total_spaces::INTEGER, v_available_spaces::INTEGER, v_live_lot_count
        )
        RETURNING * INTO v_snapshot;
    ELSE
        UPDATE public.area_demand_snapshots
           SET observed_at = p_observed_at,
               bucket_minutes = 10,
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

-- ============================= migrations/20260824130000_schedule_area_demand_collection.sql =============================
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

-- ============================= migrations/20260825120000_atomic_account_merge.sql =============================
-- 기존 계정 로그인 시 소유 증명된 익명 계정 데이터를 한 트랜잭션으로 승계한다.
-- target의 기존 취향/프로필/중복 북마크·쿠폰을 우선 보존하고, target에 없는 데이터만 이동한다.

-- 계정 삭제 시 문의의 작성자 연결만 끊고 본문을 남기던 SET NULL을 제거한다. 사용자의 탈퇴 요청은
-- 해당 계정이 작성한 문의까지 함께 삭제해야 하므로 auth.users → public.users 삭제에 연쇄한다.
ALTER TABLE public.inquiries DROP CONSTRAINT IF EXISTS inquiries_user_id_fkey;
ALTER TABLE public.inquiries
    ADD CONSTRAINT inquiries_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.merge_guest_account_data(
    p_guest_user_id UUID,
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    guest_profile public.users%ROWTYPE;
    target_profile public.users%ROWTYPE;
    recommendations_count INTEGER := 0;
    feedback_count INTEGER := 0;
    outcomes_count INTEGER := 0;
    saved_count INTEGER := 0;
    coupons_count INTEGER := 0;
    reports_count INTEGER := 0;
    inquiries_count INTEGER := 0;
    vector_moved BOOLEAN := FALSE;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;
    IF p_guest_user_id IS NULL OR p_target_user_id IS NULL THEN
        RAISE EXCEPTION 'user ids are required' USING ERRCODE = '22023';
    END IF;
    IF p_guest_user_id = p_target_user_id THEN
        RETURN jsonb_build_object(
            'recommendations', 0, 'user_feedback', 0, 'recommendation_outcomes', 0,
            'saved_facilities', 0, 'user_coupons', 0, 'congestion_reports', 0,
            'inquiries', 0, 'preference_vector_moved', FALSE
        );
    END IF;

    -- 두 프로필을 결정적 순서로 잠가 동시 병합에서도 부분 상태가 보이지 않게 한다.
    PERFORM 1
      FROM public.users
     WHERE id IN (p_guest_user_id, p_target_user_id)
     ORDER BY id
     FOR UPDATE;

    SELECT * INTO guest_profile FROM public.users WHERE id = p_guest_user_id;
    SELECT * INTO target_profile FROM public.users WHERE id = p_target_user_id;
    IF guest_profile.id IS NULL OR target_profile.id IS NULL THEN
        RAISE EXCEPTION 'guest or target profile not found' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.recommendations SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS recommendations_count = ROW_COUNT;

    UPDATE public.user_feedback SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS feedback_count = ROW_COUNT;

    UPDATE public.recommendation_outcomes SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS outcomes_count = ROW_COUNT;

    -- 같은 장소를 양쪽 계정이 저장/발급받은 경우 기존 계정 행을 진실로 유지한다.
    DELETE FROM public.saved_facilities AS guest_saved
     USING public.saved_facilities AS target_saved
     WHERE guest_saved.user_id = p_guest_user_id
       AND target_saved.user_id = p_target_user_id
       AND guest_saved.facility_id = target_saved.facility_id;
    UPDATE public.saved_facilities SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS saved_count = ROW_COUNT;

    DELETE FROM public.user_coupons AS guest_coupon
     USING public.user_coupons AS target_coupon
     WHERE guest_coupon.user_id = p_guest_user_id
       AND target_coupon.user_id = p_target_user_id
       AND guest_coupon.facility_id = target_coupon.facility_id;
    UPDATE public.user_coupons SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS coupons_count = ROW_COUNT;

    -- 기존 계정의 학습 벡터가 있으면 보존하고, 없을 때만 게스트 벡터를 승계한다.
    IF EXISTS (SELECT 1 FROM public.user_preference_vectors WHERE user_id = p_target_user_id) THEN
        DELETE FROM public.user_preference_vectors WHERE user_id = p_guest_user_id;
    ELSE
        UPDATE public.user_preference_vectors
           SET user_id = p_target_user_id
         WHERE user_id = p_guest_user_id;
        vector_moved := FOUND;
    END IF;

    UPDATE public.congestion_logs
       SET reporter_user_id = p_target_user_id
     WHERE reporter_user_id = p_guest_user_id;
    GET DIAGNOSTICS reports_count = ROW_COUNT;

    UPDATE public.inquiries SET user_id = p_target_user_id WHERE user_id = p_guest_user_id;
    GET DIAGNOSTICS inquiries_count = ROW_COUNT;

    -- 기존 계정에 값이 없을 때만 게스트 프로필/초기 취향을 채우며 제보 횟수는 합산한다.
    UPDATE public.users
       SET nickname = COALESCE(NULLIF(target_profile.nickname, ''), guest_profile.nickname),
           avatar_url = COALESCE(target_profile.avatar_url, guest_profile.avatar_url),
           visit_time_pref = COALESCE(target_profile.visit_time_pref, guest_profile.visit_time_pref),
           preferred_categories = CASE
               WHEN target_profile.preferred_categories IS NULL
                 OR target_profile.preferred_categories = '[]'::jsonb
               THEN COALESCE(guest_profile.preferred_categories, '[]'::jsonb)
               ELSE target_profile.preferred_categories
           END,
           preference_note = COALESCE(target_profile.preference_note, guest_profile.preference_note),
           report_count = COALESCE(target_profile.report_count, 0) + COALESCE(guest_profile.report_count, 0)
     WHERE id = p_target_user_id;

    -- 재시도 시 제보 횟수가 다시 합산되지 않게 이미 승계한 게스트 프로필을 비운다.
    UPDATE public.users
       SET preferred_categories = '[]'::jsonb,
           preference_note = NULL,
           report_count = 0
     WHERE id = p_guest_user_id;

    RETURN jsonb_build_object(
        'recommendations', recommendations_count,
        'user_feedback', feedback_count,
        'recommendation_outcomes', outcomes_count,
        'saved_facilities', saved_count,
        'user_coupons', coupons_count,
        'congestion_reports', reports_count,
        'inquiries', inquiries_count,
        'preference_vector_moved', vector_moved
    );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_guest_account_data(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_guest_account_data(UUID, UUID) TO service_role;

-- ============================= migrations/20260825190000_add_facility_availability_reports.sql =============================
-- 카카오맵 등 공식 상세에서 사용자가 직접 확인한 단기 영업 상태를 수집한다.
-- 단일 제보는 화면 참고용이며, 서로 다른 사용자 2명의 최근 일치 제보만 추천 자격에 사용한다.

CREATE TABLE IF NOT EXISTS public.facility_availability_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    reporter_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    evidence_tier TEXT NOT NULL DEFAULT 'single_report'
        CHECK (evidence_tier IN ('single_report', 'corroborated')),
    corroborating_count INTEGER NOT NULL DEFAULT 1 CHECK (corroborating_count >= 1),
    reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (facility_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS idx_facility_availability_effective
    ON public.facility_availability_reports (facility_id, status, reported_at DESC)
    WHERE evidence_tier = 'corroborated';
CREATE INDEX IF NOT EXISTS idx_facility_availability_expiry
    ON public.facility_availability_reports (expires_at);

ALTER TABLE public.facility_availability_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all_facility_availability_reports
    ON public.facility_availability_reports;
CREATE POLICY service_role_all_facility_availability_reports
    ON public.facility_availability_reports FOR ALL TO service_role
    USING (TRUE) WITH CHECK (TRUE);
DROP POLICY IF EXISTS select_own_facility_availability_reports
    ON public.facility_availability_reports;
CREATE POLICY select_own_facility_availability_reports
    ON public.facility_availability_reports FOR SELECT TO authenticated
    USING (reporter_user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.record_facility_availability_report(
    p_facility_id UUID,
    p_reporter_user_id UUID,
    p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    server_now TIMESTAMPTZ := clock_timestamp();
    matching_count INTEGER;
    current_row public.facility_availability_reports%ROWTYPE;
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;
    IF p_status NOT IN ('open', 'closed') THEN
        RAISE EXCEPTION 'invalid availability status' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.facilities WHERE id = p_facility_id) THEN
        RAISE EXCEPTION 'facility not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_reporter_user_id) THEN
        RAISE EXCEPTION 'reporter not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_facility_id::TEXT, 0));

    INSERT INTO public.facility_availability_reports (
        facility_id, reporter_user_id, status, evidence_tier,
        corroborating_count, reported_at, expires_at
    ) VALUES (
        p_facility_id, p_reporter_user_id, p_status, 'single_report',
        1, server_now,
        server_now + CASE WHEN p_status = 'open' THEN INTERVAL '30 minutes' ELSE INTERVAL '60 minutes' END
    )
    ON CONFLICT (facility_id, reporter_user_id) DO UPDATE
       SET status = EXCLUDED.status,
           evidence_tier = 'single_report',
           corroborating_count = 1,
           reported_at = EXCLUDED.reported_at,
           expires_at = EXCLUDED.expires_at;

    -- 현재 시설의 두 상태를 모두 다시 계산한다. 사용자가 의견을 바꾼 경우 이전 상태가
    -- corroborated 로 남는 것을 막는다. open/closed 표가 같으면 어느 쪽도 추천 판단에
    -- 사용하지 않는다. 2명 이상이면서 반대 상태보다 많은 쪽만 corroborated 로 승격한다.
    WITH counts AS (
        SELECT status,
               COUNT(DISTINCT reporter_user_id) FILTER (
                   WHERE reported_at >= server_now - INTERVAL '30 minutes'
               )::INTEGER AS user_count
          FROM public.facility_availability_reports
         WHERE facility_id = p_facility_id
         GROUP BY status
    )
    UPDATE public.facility_availability_reports AS report
       SET corroborating_count = counts.user_count,
           evidence_tier = CASE
               WHEN counts.user_count >= 2
                AND counts.user_count > COALESCE((
                    SELECT opposing.user_count
                      FROM counts AS opposing
                     WHERE opposing.status <> report.status
                ), 0)
               THEN 'corroborated'
               ELSE 'single_report'
           END,
           expires_at = CASE
               WHEN counts.user_count >= 2
                AND counts.user_count > COALESCE((
                    SELECT opposing.user_count
                      FROM counts AS opposing
                     WHERE opposing.status <> report.status
                ), 0)
               THEN server_now + CASE
                   WHEN report.status = 'open' THEN INTERVAL '30 minutes'
                   ELSE INTERVAL '60 minutes'
               END
               ELSE report.reported_at + CASE
                   WHEN report.status = 'open' THEN INTERVAL '30 minutes'
                   ELSE INTERVAL '60 minutes'
               END
           END
      FROM counts
     WHERE report.facility_id = p_facility_id
       AND report.status = counts.status;

    SELECT COUNT(DISTINCT reporter_user_id)::INTEGER
      INTO matching_count
      FROM public.facility_availability_reports
     WHERE facility_id = p_facility_id
       AND status = p_status
       AND reported_at >= server_now - INTERVAL '30 minutes';

    SELECT * INTO current_row
      FROM public.facility_availability_reports
     WHERE facility_id = p_facility_id
       AND reporter_user_id = p_reporter_user_id;

    RETURN jsonb_build_object(
        'facility_id', current_row.facility_id,
        'status', current_row.status,
        'evidence_tier', current_row.evidence_tier,
        'corroborating_count', matching_count,
        'reported_at', current_row.reported_at,
        'expires_at', current_row.expires_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_facility_availability_report(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_facility_availability_report(UUID, UUID, TEXT)
    TO service_role;

-- 익명 사용자가 영업 상태를 제보한 뒤 기존 계정으로 로그인해도 같은 사람을 두 명으로 세지 않는다.
-- 직전 migration의 계정 병합 본체를 보존하고, 영업 제보 병합까지 같은 트랜잭션에서 수행하는 래퍼로 확장한다.
ALTER FUNCTION public.merge_guest_account_data(UUID, UUID)
    RENAME TO merge_guest_account_data_without_availability;
REVOKE ALL ON FUNCTION public.merge_guest_account_data_without_availability(UUID, UUID)
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.merge_guest_account_data(
    p_guest_user_id UUID,
    p_target_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    result JSONB;
    affected_facility_ids UUID[];
    moved_count INTEGER := 0;
    server_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF auth.role() <> 'service_role' THEN
        RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
    END IF;

    -- 기존 병합 함수가 사용자 행 잠금과 나머지 데이터 병합을 수행한다. 이 래퍼에서 오류가
    -- 발생하면 같은 호출 트랜잭션 전체가 롤백되어 부분 병합이 남지 않는다.
    result := public.merge_guest_account_data_without_availability(
        p_guest_user_id, p_target_user_id
    );
    IF p_guest_user_id = p_target_user_id THEN
        RETURN result || jsonb_build_object('availability_reports', 0);
    END IF;

    SELECT ARRAY_AGG(DISTINCT facility_id)
      INTO affected_facility_ids
      FROM public.facility_availability_reports
     WHERE reporter_user_id IN (p_guest_user_id, p_target_user_id);

    -- 양쪽 계정이 같은 장소를 이미 확인했다면 target 한 건만 보존한다. 그렇지 않은 게스트
    -- 제보만 target으로 이동하므로 동일인이 corroborating_count를 두 번 올릴 수 없다.
    DELETE FROM public.facility_availability_reports AS guest_report
     USING public.facility_availability_reports AS target_report
     WHERE guest_report.reporter_user_id = p_guest_user_id
       AND target_report.reporter_user_id = p_target_user_id
       AND guest_report.facility_id = target_report.facility_id;

    UPDATE public.facility_availability_reports
       SET reporter_user_id = p_target_user_id
     WHERE reporter_user_id = p_guest_user_id;
    GET DIAGNOSTICS moved_count = ROW_COUNT;

    IF affected_facility_ids IS NOT NULL THEN
        WITH counts AS (
            SELECT facility_id, status,
                   COUNT(DISTINCT reporter_user_id) FILTER (
                       WHERE reported_at >= server_now - INTERVAL '30 minutes'
                   )::INTEGER AS user_count
              FROM public.facility_availability_reports
             WHERE facility_id = ANY(affected_facility_ids)
             GROUP BY facility_id, status
        )
        UPDATE public.facility_availability_reports AS report
           SET corroborating_count = counts.user_count,
               evidence_tier = CASE
                   WHEN counts.user_count >= 2
                    AND counts.user_count > COALESCE((
                        SELECT opposing.user_count
                          FROM counts AS opposing
                         WHERE opposing.facility_id = report.facility_id
                           AND opposing.status <> report.status
                    ), 0)
                   THEN 'corroborated'
                   ELSE 'single_report'
               END
          FROM counts
         WHERE report.facility_id = counts.facility_id
           AND report.status = counts.status;
    END IF;

    RETURN result || jsonb_build_object('availability_reports', moved_count);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_guest_account_data(UUID, UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_guest_account_data(UUID, UUID)
    TO service_role;

-- ============================= migrations/20260825210000_recompute_availability_after_delete.sql =============================
-- 한 사용자의 탈퇴/게스트 병합/관리 정리로 제보가 삭제되면 남은 근거의 인원수와
-- corroborated 상태를 즉시 다시 계산한다. 삭제 전 2명이었던 근거를 1명으로 남겨 두지 않는다.

-- 최근 30분에 속하지 않는 보존 행은 일치 인원이 0일 수 있다. 이 값은 추천에 쓰이지 않으며
-- 다음 정리/덮어쓰기 전까지 사실 그대로 저장할 수 있게 한다.
ALTER TABLE public.facility_availability_reports
    DROP CONSTRAINT IF EXISTS facility_availability_reports_corroborating_count_check;
ALTER TABLE public.facility_availability_reports
    ADD CONSTRAINT facility_availability_reports_corroborating_count_check
    CHECK (corroborating_count >= 0);

CREATE OR REPLACE FUNCTION public.recompute_facility_availability_evidence(
    p_facility_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    server_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    WITH counts AS (
        SELECT status,
               COUNT(DISTINCT reporter_user_id) FILTER (
                   WHERE reported_at >= server_now - INTERVAL '30 minutes'
               )::INTEGER AS user_count
          FROM public.facility_availability_reports
         WHERE facility_id = p_facility_id
         GROUP BY status
    )
    UPDATE public.facility_availability_reports AS report
       SET corroborating_count = counts.user_count,
           evidence_tier = CASE
               WHEN counts.user_count >= 2
                AND counts.user_count > COALESCE((
                    SELECT opposing.user_count
                      FROM counts AS opposing
                     WHERE opposing.status <> report.status
                ), 0)
               THEN 'corroborated'
               ELSE 'single_report'
           END
      FROM counts
     WHERE report.facility_id = p_facility_id
       AND report.status = counts.status;
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_facility_availability_evidence(UUID)
    FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.refresh_facility_availability_after_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM public.recompute_facility_availability_evidence(OLD.facility_id);
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_facility_availability_after_delete()
    FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_refresh_facility_availability_after_delete
    ON public.facility_availability_reports;
CREATE TRIGGER trg_refresh_facility_availability_after_delete
AFTER DELETE ON public.facility_availability_reports
FOR EACH ROW
EXECUTE FUNCTION public.refresh_facility_availability_after_delete();

-- ============================= migrations/20260827140000_rbac_roles_and_ownership.sql =============================
-- 사장님 콘솔 개편 P0 — 4단계 계정 역할(RBAC) + 가게 소유권 스키마.
-- 계획: docs/MERCHANT_CONSOLE_RBAC_PLAN.md (로컬 전용 문서)
--
-- 이 마이그레이션은 **스키마만** 만든다. 기존 동작은 1비트도 바뀌지 않는다 —
-- 아무도 새 역할이 아니고(전원 'tourist'), 새 표는 비어 있으며, 백엔드는 아직 이걸 읽지 않는다.
-- 가드 교체는 P1(백엔드), 화면은 P2 에서 한다.
--
-- 왜 하는가(1순위 동기는 UX 가 아니라 보안):
--   POST /api/v1/merchant/seat-status 와 /merchant/timesale 이 본문의 facility_id 를 그대로
--   신뢰한다. 공유 토큰(프런트 번들에 포함, 기본값 공개)만 있으면 **누구나 아무 가게의**
--   좌석 상태를 방송할 수 있고, 그 방송은 congestion_logs 에 evidence_tier='verified' 로
--   기록된다 — 모델 승격 게이트가 학습에 쓰는 유일한 등급이다(CONGESTION_TRUST_SPEC).
--   즉 외부인이 학습 데이터를 오염시킬 수 있는 경로가 열려 있다. facility_owners 가 그 구멍을 닫는다.
--
-- 멱등: 재실행 가능(IF NOT EXISTS / DROP ... IF EXISTS 후 CREATE).

-- =========================================================================
-- 1. users.role 을 4단계로 확장
-- =========================================================================
-- 기존 CHECK 는 ('tourist','admin') 2종이었다. 제약 이름은 컬럼 정의 시 자동 생성된
-- users_role_check 다(초기 마이그레이션의 인라인 CHECK). 이름이 다른 환경도 있을 수 있어
-- DO 블록으로 실제 이름을 찾아 지운다.
DO $$
DECLARE
    v_constraint TEXT;
BEGIN
    SELECT conname INTO v_constraint
      FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND contype = 'c'
       -- 'tourist' 로 매칭한다: users 에는 visit_time_pref 등 다른 CHECK 도 있어
       -- '%role%' 로 찾으면 엉뚱한 제약을 지울 수 있다. 새로 만드는 제약도 'tourist' 를
       -- 포함하므로 재실행 시 자기 자신을 찾아 지운다 → 멱등.
       AND pg_get_constraintdef(oid) ILIKE '%tourist%'
     LIMIT 1;
    IF v_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', v_constraint);
    END IF;
END $$;

ALTER TABLE public.users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('tourist', 'merchant', 'admin', 'developer'));

-- developer 는 admin 의 상위집합이다. 기존 RLS 8곳의 `get_auth_user_role() = 'admin'` 을
-- 이 헬퍼로 바꿔 developer 도 통과하게 한다(정책 교체는 아래 4절).
CREATE OR REPLACE FUNCTION public.is_admin_or_dev()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.get_auth_user_role() IN ('admin', 'developer');
$$;

-- =========================================================================
-- 2. users 의 민감 컬럼을 클라이언트가 직접 못 바꾸게 (트리거)
-- =========================================================================
-- 기존 update_users 정책은 `id = auth.uid()` 만 본다 → 본인이 role 을 바꿀 수 있다.
-- (RESET_AND_SETUP 후반의 재정의본은 role 을 잠갔지만, 정책은 컬럼 단위 제어가 없어
--  앞으로 추가될 민감 컬럼마다 정책을 고쳐야 한다.) 트리거로 한 곳에 모은다.
--
-- 막을 대상은 **클라이언트 경유 두 롤(authenticated·anon)** 뿐이다. 그 외(service_role =
-- 백엔드, postgres = SQL Editor 부트스트랩)는 통과시킨다.
--
-- ⚠️ SECURITY INVOKER(기본값)여야 한다. SECURITY DEFINER 로 두면 함수 안에서 current_user 가
--    **함수 소유자**로 바뀌어 호출자 롤을 알 수 없다 — service_role 백엔드와 SQL Editor 의
--    최초 developer 지정이 둘 다 막힌다. 이 함수는 OLD/NEW 비교만 하므로 권한 상승이 필요 없다.
CREATE OR REPLACE FUNCTION public.guard_users_privileged_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'role 은 직접 변경할 수 없습니다(백엔드 전용)';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS guard_users_privileged_columns ON public.users;
CREATE TRIGGER guard_users_privileged_columns
    BEFORE UPDATE ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_users_privileged_columns();

-- =========================================================================
-- 3. facility_owners — 가게 소유권 (역할과 별개의 축)
-- =========================================================================
-- 'merchant' 역할은 "콘솔에 들어갈 수 있다"만 뜻한다. **어느 가게를 관리하는가**는 여기서 정한다.
-- 한 사장님이 여러 지점을, 한 가게에 여러 계정(공동창업자)이 붙을 수 있다.
-- 직원(staff) 계정은 만들지 않기로 했으므로 member_role 컬럼은 두지 않는다.
CREATE TABLE IF NOT EXISTS public.facility_owners (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id  UUID NOT NULL REFERENCES public.facilities(id) ON DELETE CASCADE,
    -- ⚠️ CASCADE 아님(의도적): 탈퇴해도 "누가 언제 이 가게를 관리했나" 이력을 남긴다.
    --    좌석 방송이 verified 학습 데이터가 되는 이상 감사 대상이다. 탈퇴 처리는
    --    행 삭제가 아니라 revoked_at 갱신 + users 익명화로 한다(P1).
    user_id      UUID NOT NULL REFERENCES public.users(id),
    granted_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at   TIMESTAMPTZ,
    verification_request_id UUID,
    note         TEXT
);

-- 같은 (가게, 사용자)의 **활성** 행은 하나만. 회수 후 재부여는 가능하다.
CREATE UNIQUE INDEX IF NOT EXISTS facility_owners_active_uq
    ON public.facility_owners (facility_id, user_id) WHERE revoked_at IS NULL;
-- '내 가게 목록' 조회 경로.
CREATE INDEX IF NOT EXISTS facility_owners_user_idx
    ON public.facility_owners (user_id) WHERE revoked_at IS NULL;
-- 소유권 검사(가게 → 소유자) 경로.
CREATE INDEX IF NOT EXISTS facility_owners_facility_idx
    ON public.facility_owners (facility_id) WHERE revoked_at IS NULL;

ALTER TABLE public.facility_owners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS facility_owners_service_all ON public.facility_owners;
CREATE POLICY facility_owners_service_all ON public.facility_owners
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 읽기만 허용한다. 쓰기(부여/회수)는 백엔드 /dev 경로 전용 — 프런트 직접 INSERT 금지.
DROP POLICY IF EXISTS facility_owners_select_own ON public.facility_owners;
CREATE POLICY facility_owners_select_own ON public.facility_owners
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

-- =========================================================================
-- 4. business_verification_requests — 사업자 인증 요청
-- =========================================================================
-- 오프라인 인증(개발자에게 연락 → 실물 증거 확인)은 유지하되, 요청·심사·결과를 시스템이 기록한다.
-- 승인 한 번으로 역할 임명 + 소유권 부여가 원자적으로 처리되고 감사 이력이 남는다.
--
-- ⚠️ 증빙 보관 정책: 인증이 끝나면 보관하지 않는다. 승인·거절·철회 어느 쪽이든 결정과
--    같은 트랜잭션에서 Storage 파일을 지우고 document_path·business_number_last4 를 NULL 로
--    비운다(P1 백엔드). 사업자등록번호 **전체**는 어느 시점에도 저장하지 않는다.
CREATE TABLE IF NOT EXISTS public.business_verification_requests (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES public.users(id),
    -- 기존 POI 선택(권장). 없으면 store_name 자유 입력으로 받고 개발자가 나중에 매핑한다.
    facility_id   UUID REFERENCES public.facilities(id) ON DELETE SET NULL,
    store_name    TEXT NOT NULL,
    -- 연락처는 필수다: 아이디 계정·카카오 계정은 이메일이 없을 수 있다.
    contact       TEXT NOT NULL,
    business_number_last4 TEXT CHECK (business_number_last4 IS NULL OR business_number_last4 ~ '^[0-9]{4}$'),
    document_path TEXT,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    reviewed_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ,
    review_note   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 한 사용자가 같은 가게에 pending 을 여러 개 쌓지 못하게. facility_id 가 NULL 인
-- 자유 입력 요청은 이 인덱스에 걸리지 않으므로 store_name 기준으로 따로 막는다.
CREATE UNIQUE INDEX IF NOT EXISTS bvr_pending_facility_uq
    ON public.business_verification_requests (user_id, facility_id)
    WHERE status = 'pending' AND facility_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bvr_pending_freeform_uq
    ON public.business_verification_requests (user_id, lower(store_name))
    WHERE status = 'pending' AND facility_id IS NULL;
-- 개발자 심사 큐(대기 먼저, 오래된 순).
CREATE INDEX IF NOT EXISTS bvr_status_idx
    ON public.business_verification_requests (status, created_at);

ALTER TABLE public.business_verification_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bvr_service_all ON public.business_verification_requests;
CREATE POLICY bvr_service_all ON public.business_verification_requests
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 본인 요청 조회 + 관리자/개발자는 전체 조회(관리자는 '신청 현황' 읽기 전용).
DROP POLICY IF EXISTS bvr_select_own_or_staff ON public.business_verification_requests;
CREATE POLICY bvr_select_own_or_staff ON public.business_verification_requests
    FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

-- 본인 요청 생성 — pending 으로만. 심사 필드는 손댈 수 없다.
DROP POLICY IF EXISTS bvr_insert_own ON public.business_verification_requests;
CREATE POLICY bvr_insert_own ON public.business_verification_requests
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND status = 'pending'
        AND reviewed_by IS NULL
        AND reviewed_at IS NULL
    );

-- 본인 철회만. 승인/거절은 service_role(개발자 API) 전용이다.
DROP POLICY IF EXISTS bvr_withdraw_own ON public.business_verification_requests;
CREATE POLICY bvr_withdraw_own ON public.business_verification_requests
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid() AND status = 'pending')
    WITH CHECK (user_id = auth.uid() AND status = 'withdrawn');

-- =========================================================================
-- 5. role_audit_log — 권한 변경 감사
-- =========================================================================
-- 모든 임명·회수·심사는 백엔드가 여기 한 줄씩 남긴다. **삭제 API 는 만들지 않는다.**
-- actor_id NULL = 시스템/최초 SQL 부트스트랩(첫 developer 지정).
CREATE TABLE IF NOT EXISTS public.role_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_id    UUID REFERENCES public.users(id) ON DELETE SET NULL,
    target_id   UUID NOT NULL,
    action      TEXT NOT NULL
                CHECK (action IN ('role_change', 'owner_grant', 'owner_revoke', 'verification_review')),
    from_value  TEXT,
    to_value    TEXT,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_audit_log_target_idx
    ON public.role_audit_log (target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS role_audit_log_created_idx
    ON public.role_audit_log (created_at DESC);

ALTER TABLE public.role_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS role_audit_log_service_all ON public.role_audit_log;
CREATE POLICY role_audit_log_service_all ON public.role_audit_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 읽기는 관리자·개발자만. 쓰기 정책은 두지 않는다(service_role 전용).
DROP POLICY IF EXISTS role_audit_log_select_staff ON public.role_audit_log;
CREATE POLICY role_audit_log_select_staff ON public.role_audit_log
    FOR SELECT TO authenticated
    USING (public.is_admin_or_dev());

-- =========================================================================
-- 6. system_settings.merchant_console_enabled — 사고 시 콘솔 즉시 차단 스위치
-- =========================================================================
-- FALSE 면 /merchant/* 전 엔드포인트가 503 을 돌려준다(maintenance_mode 패턴).
ALTER TABLE public.system_settings
    ADD COLUMN IF NOT EXISTS merchant_console_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- =========================================================================
-- 7. 기존 admin 전용 RLS 를 is_admin_or_dev() 로 교체
-- =========================================================================
-- developer 가 admin 의 상위집합이 되도록. 정책 본문은 그대로고 판정 함수만 바꾼다.
DROP POLICY IF EXISTS select_users ON public.users;
CREATE POLICY select_users ON public.users FOR SELECT TO authenticated
    USING (id = auth.uid() OR public.is_admin_or_dev());

DROP POLICY IF EXISTS admin_all_facilities ON public.facilities;
CREATE POLICY admin_all_facilities ON public.facilities FOR ALL TO authenticated
    USING (public.is_admin_or_dev())
    WITH CHECK (public.is_admin_or_dev());

DROP POLICY IF EXISTS select_own_or_admin_inquiries ON public.inquiries;
CREATE POLICY select_own_or_admin_inquiries ON public.inquiries FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

DROP POLICY IF EXISTS admin_update_inquiries ON public.inquiries;
CREATE POLICY admin_update_inquiries ON public.inquiries FOR UPDATE TO authenticated
    USING (public.is_admin_or_dev())
    WITH CHECK (public.is_admin_or_dev());

DROP POLICY IF EXISTS admin_all_logs ON public.congestion_logs;
CREATE POLICY admin_all_logs ON public.congestion_logs FOR ALL TO authenticated
    USING (public.is_admin_or_dev())
    WITH CHECK (public.is_admin_or_dev());

DROP POLICY IF EXISTS select_recommendations ON public.recommendations;
CREATE POLICY select_recommendations ON public.recommendations FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

DROP POLICY IF EXISTS select_feedback ON public.user_feedback;
CREATE POLICY select_feedback ON public.user_feedback FOR SELECT TO authenticated
    USING (user_id = auth.uid() OR public.is_admin_or_dev());

DROP POLICY IF EXISTS admin_update_settings ON public.system_settings;
CREATE POLICY admin_update_settings ON public.system_settings
    FOR UPDATE TO authenticated
    USING (public.is_admin_or_dev())
    WITH CHECK (public.is_admin_or_dev());

-- ============================= migrations/20260902130000_role_change_requests.sql =============================
-- 계정 역할 변경 신청 — business_verification_requests 를 '사업자 전용'에서 '역할 신청' 큐로 넓힌다.
--
-- 왜 새 표를 만들지 않는가:
--   신청 → 개발자 심사 → 역할 임명 + 감사 로그의 파이프라인이 이미 여기 다 있다. 표를 하나 더
--   만들면 심사 화면·승인 로직·RLS·증빙 삭제 정책을 통째로 두 벌 유지해야 하고, 두 큐 중
--   어느 쪽을 봐야 하는지 개발자가 매번 판단해야 한다. 컬럼 하나가 정직하고 싸다.
--
-- 어떤 역할까지 신청 대상인가:
--   merchant — 가게 사장님. 기존 사업자 인증 그대로다(가게 매핑 + 소유권 부여가 따라온다).
--   admin    — 정부기관 관제 담당자. 소속 확인은 오프라인이고, 시스템은 요청·결정만 기록한다.
--   developer 는 **넣지 않는다.** 팀 내부 권한이라 신청 대상이 아니며, 신청으로 얻을 수 있게
--   두면 심사 실수 한 번이 곧 전체 권한 위임이 된다. 개발자 임명은 /dev 콘솔에서 직접 한다.
--
-- 기존 행은 전부 사업자 신청이므로 DEFAULT 'merchant' 가 곧 정확한 백필이다.
--
-- 멱등: 재실행 가능(ADD COLUMN IF NOT EXISTS + 제약은 이름으로 확인 후 추가).

ALTER TABLE public.business_verification_requests
    ADD COLUMN IF NOT EXISTS requested_role TEXT NOT NULL DEFAULT 'merchant';

-- CHECK 은 따로 붙인다. ADD COLUMN IF NOT EXISTS 의 인라인 CHECK 은 컬럼이 이미 있으면
-- 통째로 건너뛰어, 컬럼만 먼저 만들어진 환경에 제약이 영영 안 붙는다.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.business_verification_requests'::regclass
           AND conname = 'bvr_requested_role_check'
    ) THEN
        ALTER TABLE public.business_verification_requests
            ADD CONSTRAINT bvr_requested_role_check
            CHECK (requested_role IN ('merchant', 'admin'));
    END IF;
END $$;

-- 심사 큐는 대기 → 오래된 순으로 본다. 역할별로 나눠 보는 화면이 생겼으므로 인덱스도 맞춘다.
CREATE INDEX IF NOT EXISTS bvr_role_status_idx
    ON public.business_verification_requests (requested_role, status, created_at);

-- 한 사용자가 pending 을 여러 개 쌓지 못하게 막는 기존 부분 유니크 인덱스 2개는
-- (user_id, facility_id) / (user_id, lower(store_name)) 기준이라 그대로 둔다.
-- 관리자 신청은 facility_id 가 NULL 이고 store_name 에 소속 기관명이 들어가므로
-- freeform 인덱스에 걸린다 — 같은 소속으로 두 번 신청하는 것만 막히고, 사업자 신청과는
-- store_name 이 달라 충돌하지 않는다. 의도한 동작이다.

-- INSERT RLS 정책(bvr_insert_own)은 status/reviewed_* 만 검사하므로 새 컬럼의 영향이 없다.
-- 실제 쓰기는 어차피 service_role(백엔드 /api/v1/account)이 한다.

-- ============================= migrations/20260903120000_nickname_source.sql =============================
-- 닉네임 출처 추적 — 프로바이더에서 이름을 바꿔도 앱에는 옛 이름이 굳어 있던 문제.
--
-- 증상(2026-09-02 실측): 카카오 계정으로 로그인했는데 닉네임이 '윤성1' 로 떴다.
--   auth.users.raw_user_meta_data 는 이미 '오윤성' 을 주고 있었는데
--   public.users.nickname 은 첫 가입(2026-07-15) 때 값 그대로였다.
--
-- 원인: 프로필 백필이 **NULL 인 칼럼만** 채운다. 사용자가 마이페이지에서 직접 정한 이름을
--   로그인할 때마다 덮어쓰지 않으려는 의도였는데, 그 대가로 프로바이더 유래 이름도 영영
--   갱신되지 않았다. 둘을 구분할 정보가 없어서 생긴 문제다 — 그 정보를 여기서 만든다.
--
--   'provider' : 소셜 프로바이더가 준 이름. 로그인할 때 최신 값으로 맞춘다.
--   'user'     : 사용자가 직접 지정. **어떤 경우에도 덮어쓰지 않는다.**
--   NULL       : 닉네임이 없거나 출처를 알 수 없다.
--
-- 닉네임에 유일성 제약은 없다(있던 적도 없다). 두 계정이 같은 이름을 써도 무방하며,
-- 닉네임으로 사용자를 찾는 코드도 없다 — 표시용 값이다.
--
-- 멱등: 재실행 가능(ADD COLUMN IF NOT EXISTS · 제약은 이름 확인 후 · 백필은 NULL 만).

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS nickname_source TEXT;

-- CHECK 을 따로 붙이는 이유: ADD COLUMN IF NOT EXISTS 의 인라인 CHECK 은 컬럼이 이미 있으면
-- 통째로 건너뛰어, 컬럼만 먼저 생긴 환경에 제약이 영영 안 붙는다.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.users'::regclass
           AND conname = 'users_nickname_source_check'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_nickname_source_check
            CHECK (nickname_source IS NULL OR nickname_source IN ('provider', 'user'));
    END IF;
END $$;

-- 기존 행 백필 — 지금 프로바이더가 주는 이름과 **같으면** 프로바이더 유래로 본다.
--
-- 다르면 사용자가 바꾼 건지 프로바이더 쪽이 바뀐 건지 알 수 없다. 그때는 'user' 로 둔다:
-- 사용자가 고른 이름이 로그인 한 번에 사라지는 쪽이, 옛 이름이 남아 있는 쪽보다 나쁘다
-- (옛 이름은 마이페이지에서 직접 고칠 수 있지만, 지워진 이름은 되돌릴 방법이 없다).
UPDATE public.users u
   SET nickname_source = CASE
        WHEN u.nickname = COALESCE(
                 a.raw_user_meta_data->>'full_name',
                 a.raw_user_meta_data->>'name'
             ) THEN 'provider'
        ELSE 'user'
       END
  FROM auth.users a
 WHERE a.id = u.id
   AND u.nickname IS NOT NULL
   AND u.nickname_source IS NULL;

-- handle_new_user 확장 — 가입 시점에 출처를 같이 남긴다.
-- 이 트리거로 들어온 닉네임은 정의상 프로바이더 유래다(익명 가입은 메타가 비어 NULL).
-- 나머지 동작은 20260715140000 판과 동일하다.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
    v_nickname TEXT;
BEGIN
    v_nickname := COALESCE(
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'name'
    );
    INSERT INTO public.users (id, preferred_categories, nickname, avatar_url, nickname_source)
    VALUES (
        NEW.id,
        '[]'::jsonb,
        v_nickname,
        NEW.raw_user_meta_data->>'avatar_url',
        CASE WHEN v_nickname IS NOT NULL THEN 'provider' END
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

-- 트리거(on_auth_user_created)는 20260710160000 에서 이미 만들었다 — 함수만 교체하면 된다.
--
-- ⚠️ 익명 세션의 linkIdentity 승격은 auth.users 를 UPDATE 하므로 이 트리거(AFTER INSERT)를
--    타지 않는다. 그 경로와 '로그인할 때마다 갱신'은 프런트가 담당한다
--    (apps/web/lib/auth.ts syncProfileFromProvider → lib/oauthFlow.ts resolveProfileSync).

-- ============================= migrations/20260904090000_account_deletion_fk_fix.sql =============================
-- 계정 삭제가 인증 신청 이력이 있는 계정에서 영구 실패하는 버그 수정.
--
-- 무엇이 깨져 있었나:
--   DELETE /api/v1/account/me (apps/api/app/routers/account.py) 는 auth.users 행을 지운다.
--   auth.users → public.users 는 ON DELETE CASCADE 이므로 public.users 행도 함께 지워진다.
--   그런데 20260827140000_rbac_roles_and_ownership.sql 이 만든 두 FK 가
--     facility_owners.user_id                  → public.users(id)   -- ON DELETE 절 없음
--     business_verification_requests.user_id   → public.users(id)   -- ON DELETE 절 없음
--   ON DELETE 절이 없으면 NO ACTION 이다. 즉 자식 행이 하나라도 남아 있으면 부모 삭제가
--   FK 위반으로 막힌다. 결과: **사업자/관리자 인증을 한 번이라도 신청한 계정은 탈퇴가
--   영원히 실패한다**(500). 신청을 철회(withdrawn)하거나 거절당해도 행은 남으므로 마찬가지다.
--   소유권을 받은 사장님 계정도 같은 이유로 탈퇴할 수 없다.
--
-- 이 마이그레이션의 목표는 단 하나 — **탈퇴가 실제로 성공하게 만드는 것**이다.
--
-- 나머지 users 참조 FK 는 이미 안전하다(전수 확인함):
--   CASCADE  — recommendations, user_feedback, user_preference_vectors, user_coupons,
--              saved_facilities, recommendation_outcomes, facility_availability_reports,
--              inquiries(20260825120000 에서 SET NULL → CASCADE 로 교체됨)
--   SET NULL — congestion_logs.reporter_user_id, facility_owners.granted_by,
--              business_verification_requests.reviewed_by, role_audit_log.actor_id
--   FK 없음  — app_events.user_id, admin_ingest_requests.requested_by (경량 로그 관례),
--              role_audit_log.target_id (⚠️ 의도적 — 아래 3절 참고),
--              facility_owners.verification_request_id
--              (컬럼만 있고 REFERENCES 가 없다. business_verification_requests 를 가리키는
--               FK 는 DB 어디에도 없으므로 이번 삭제 경로를 막지 않는다. 무결성이 느슨한
--               것은 별개 이슈이고, 지금 FK 를 새로 걸면 **없던 삭제 차단이 생기므로**
--               이 마이그레이션에서는 손대지 않는다.)
--
-- 멱등: 제약을 이름으로 추측하지 않고 카탈로그에서 실제 FK 를 찾아 지운 뒤 다시 만든다.
--   (두 FK 모두 CREATE TABLE 안의 인라인 REFERENCES 로 만들어져 마이그레이션 파일에
--    이름이 적혀 있지 않다 — 실제 이름은 PostgreSQL 기본 규칙인 <표>_<컬럼>_fkey 이지만,
--    이름이 다른 환경까지 덮도록 20260827140000 의 users_role_check 처리와 같은 DO 블록을 쓴다.)

-- =========================================================================
-- 1. business_verification_requests.user_id → ON DELETE CASCADE
-- =========================================================================
-- 왜 CASCADE 인가: 계정이 사라진 뒤의 신청 행은 감사 가치가 없다. 심사 결과(승인/거절)는
--   role_audit_log 에 'verification_review' 로 이미 따로 남아 있고(그쪽은 계정 삭제에
--   영향을 받지 않는다 — 3절), 이 표에 남는 것은 contact(연락처)·store_name(상호) 같은
--   **PII 뿐**이다. 탈퇴한 사용자의 연락처를 붙들고 있는 것은 감사가 아니라 유출 위험이다.
--   증빙 파일(document_path)은 심사 종료 시점에 이미 지워지는 정책이라 남을 것이 없다.
DO $$
DECLARE
    v_name TEXT;
BEGIN
    FOR v_name IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'public.business_verification_requests'::regclass
           AND contype = 'f'
           AND confrelid = 'public.users'::regclass
           AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (user_id)%'
    LOOP
        EXECUTE format(
            'ALTER TABLE public.business_verification_requests DROP CONSTRAINT %I', v_name
        );
    END LOOP;
END $$;

ALTER TABLE public.business_verification_requests
    ADD CONSTRAINT business_verification_requests_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- =========================================================================
-- 2. facility_owners.user_id → ON DELETE CASCADE (+ 이력은 role_audit_log 로 옮겨 보존)
-- =========================================================================
-- 여기는 판단이 다르다. 원래 주석("CASCADE 아님(의도적): 탈퇴해도 누가 언제 이 가게를
-- 관리했나 이력을 남긴다")은 옳은 문제의식이었지만, 그 전제였던 "탈퇴 처리는 행 삭제가
-- 아니라 revoked_at 갱신 + users 익명화로 한다(P1)" 가 **구현되지 않았다.** 실제 탈퇴
-- 경로는 auth.users 를 하드 삭제한다. 그래서 지금의 NO ACTION 은 이력을 지키는 게 아니라
-- 그냥 탈퇴를 막고 있을 뿐이다.
--
-- 검토한 대안:
--   (a) ON DELETE SET NULL — user_id 가 NOT NULL 이라 불가. NOT NULL 을 벗기면 가능은
--       하지만, 소유 이력에서 '누가'를 지우면 남는 건 "언제 어떤 가게에 누군지 모를
--       사람이 있었다"뿐이라 감사 가치가 사라진다. 게다가 부분 유니크 인덱스
--       facility_owners_active_uq (facility_id, user_id) WHERE revoked_at IS NULL 은
--       NULL 을 서로 다른 값으로 보므로 익명화된 활성 행이 무한히 쌓일 수 있다.
--   (b) FK 자체를 제거 — 삭제는 통과하지만 존재하지 않는 user_id 를 가리키는 행이
--       남는다. authz.require_facility_owner 는 revoked_at IS NULL 인 행으로 소유권을
--       판정하므로, 죽은 계정의 활성 소유 행을 남겨 두는 것은 권한 판정 경로에 쓰레기를
--       남기는 일이다. 무결성 없이 이력만 남기는 것도 정직하지 않다.
--   (c) ON DELETE RESTRICT / NO ACTION 유지 + 백엔드가 먼저 정리 — 지금 버그의 재생산이다.
--       탈퇴 API 한 곳에 정리 로직을 얹으면, 앞으로 생길 다른 삭제 경로마다 같은 걸
--       빠뜨린다(이번에 놓친 것과 똑같은 종류의 드리프트).
--
-- 결정: **(d) ON DELETE CASCADE + 삭제 직전에 role_audit_log 로 이력을 옮긴다.**
--   감사 기록을 담당하는 표는 원래부터 role_audit_log 다. 그 표의 target_id 는
--   **일부러 FK 가 없는 UUID** 이고 actor_id 는 ON DELETE SET NULL 이라, 계정이 삭제돼도
--   로그 줄은 그대로 남는다 — 즉 계정 수명과 무관하게 살아남도록 설계된 유일한 표다.
--   소유 이력을 그쪽으로 옮기면 "누가 언제 이 가게를 관리했나"는 보존되고, 권한 판정에
--   쓰이는 facility_owners 에는 죽은 행이 남지 않는다.
--   (dev.py 의 정상 회수 경로는 지금도 삭제가 아니라 revoked_at 갱신이므로 이 트리거를
--    타지 않는다. 여기서 잡는 것은 계정 삭제 연쇄 같은 **물리 삭제**뿐이다.)
CREATE OR REPLACE FUNCTION public.log_facility_owner_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER  -- role_audit_log 는 RLS 가 켜져 있고 쓰기 정책이 service_role 전용이다.
                  -- 계정 삭제는 supabase_auth_admin 롤로 들어오므로 호출자 권한으로는
                  -- INSERT 가 막힌다. 표 소유자(postgres) 권한으로 실행해 그 벽을 넘는다.
SET search_path = public
AS $$
BEGIN
    -- ⚠️ 실패해도 삭제를 되돌리지 않는다. 이 마이그레이션의 목적 자체가 "탈퇴가 성공하게
    --    만드는 것"인데, 감사 로그 쓰기 실패로 탈퇴가 다시 막히면 본말전도다.
    --    (authz.log_role_audit 도 같은 원칙 — "실패해도 주 작업을 되돌리지 않되 경고로 남긴다".)
    BEGIN
        INSERT INTO public.role_audit_log (actor_id, target_id, action, from_value, reason)
        -- actor_id NULL = 시스템. from_value 에 facility_id 를 넣는 것은
        -- dev.py revoke_facility_owner 의 owner_revoke 기록 관례와 같다.
        VALUES (NULL, OLD.user_id, 'owner_revoke', OLD.facility_id::TEXT,
                'facility_owners 행 물리 삭제(계정 삭제 연쇄) — granted_at=' ||
                COALESCE(OLD.granted_at::TEXT, 'unknown') ||
                ', revoked_at=' || COALESCE(OLD.revoked_at::TEXT, 'active'));
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'role_audit_log 기록 실패(facility_owners 삭제는 계속 진행): %', SQLERRM;
    END;
    RETURN NULL;  -- AFTER 트리거의 반환값은 무시된다.
END $$;

DROP TRIGGER IF EXISTS log_facility_owner_deletion ON public.facility_owners;
CREATE TRIGGER log_facility_owner_deletion
    AFTER DELETE ON public.facility_owners
    FOR EACH ROW
    EXECUTE FUNCTION public.log_facility_owner_deletion();

DO $$
DECLARE
    v_name TEXT;
BEGIN
    FOR v_name IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'public.facility_owners'::regclass
           AND contype = 'f'
           AND confrelid = 'public.users'::regclass
           AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (user_id)%'
    LOOP
        EXECUTE format('ALTER TABLE public.facility_owners DROP CONSTRAINT %I', v_name);
    END LOOP;
END $$;

ALTER TABLE public.facility_owners
    ADD CONSTRAINT facility_owners_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

-- =========================================================================
-- 3. 왜 role_audit_log 는 손대지 않는가
-- =========================================================================
-- target_id 는 UUID NOT NULL 이면서 FK 가 없다. 실수처럼 보이지만 이 표에서는 그게 맞다 —
-- FK 를 걸면 (1) 계정 삭제가 또 막히거나 (2) CASCADE 로 감사 로그가 지워진다. 둘 다
-- "삭제 API 는 만들지 않는다"(dev.py)는 이 표의 존재 이유와 정면으로 충돌한다.
-- 감사 로그는 계정보다 오래 살아야 한다. 그대로 둔다.

-- ============================= migrations/20260904091000_inquiries_insert_ownership.sql =============================
-- inquiries INSERT 정책의 신원 위조 구멍 차단.
--
-- 무엇이 깨져 있었나:
--   20260531220000_add_inquiries_table.sql 의
--     CREATE POLICY "Allow anonymous or auth inserts on inquiries"
--       ON public.inquiries FOR INSERT WITH CHECK (true);
--   에는 TO 절도, 소유권 조건도 없다. WITH CHECK (true) 는 "무엇이든 통과"라는 뜻이므로
--   anon 키만 있으면(프런트 번들에 들어 있다) **아무나 남의 user_id 로 문의를 넣을 수 있다.**
--   그 문의는 관리자 화면(/admin/support)에 피해자가 보낸 것처럼 뜨고,
--   select_own_or_admin_inquiries 때문에 정작 피해자 본인의 '내 문의' 목록에도 나타난다.
--   또 SELECT/UPDATE 는 20260601120000·20260707120000 에서 이미 조여졌는데 INSERT 만
--   그때 함께 조여지지 않고 남아 있었다 — 하드닝의 누락분이다.
--
-- 익명 문의 경로는 유지해야 한다(로그인 없이도 문의할 수 있어야 한다). 다행히
-- inquiries.user_id 는 처음부터 NULL 허용 컬럼이고(초기 정의에 NOT NULL 이 없고, 이후
-- 어떤 마이그레이션도 NOT NULL 을 붙이지 않았다 — 20260825120000 은 FK 의 ON DELETE 만
-- SET NULL → CASCADE 로 바꿨다), 그래서 "NULL 이거나 본인" 형태를 쓸 수 있다.
--
-- 멱등: DROP POLICY IF EXISTS → CREATE POLICY.

-- 구 정책 제거. 이름에 공백이 있어 큰따옴표가 필요하다.
DROP POLICY IF EXISTS "Allow anonymous or auth inserts on inquiries" ON public.inquiries;

DROP POLICY IF EXISTS inquiries_insert_own_or_anonymous ON public.inquiries;
CREATE POLICY inquiries_insert_own_or_anonymous ON public.inquiries
    FOR INSERT TO anon, authenticated
    -- user_id IS NULL  = 익명 문의(세션 없이 보낸 문의).
    -- user_id = auth.uid() = 로그인/익명세션 사용자의 본인 문의.
    -- 그 외(남의 uid)는 거부된다. 앱은 익명 세션(signInAnonymously)을 쓰므로 대부분
    -- 두 번째 가지를 타고, 익명 세션 부팅이 실패한 경우에만 첫 번째 가지로 떨어진다.
    WITH CHECK (user_id IS NULL OR user_id = auth.uid());

-- service_role(백엔드 admin 라우터)용 명시 정책 — 다른 표들(user_coupons, saved_facilities,
-- facility_owners …)이 모두 갖고 있는 *_service_all 관례를 여기에도 맞춘다.
-- 구 정책은 TO 절이 없어 PUBLIC(=service_role 포함)에 적용됐다. 위에서 TO anon, authenticated
-- 로 좁혔으므로, service_role 의 BYPASSRLS 에만 기대지 않도록 명시적으로 열어 둔다.
DROP POLICY IF EXISTS inquiries_service_all ON public.inquiries;
CREATE POLICY inquiries_service_all ON public.inquiries
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ⚠️ 프런트와 한 세트다. apps/web/app/mypage/support/page.tsx 가 로그아웃 상태에서
--    하드코딩 UUID(a2222222-…)를 보내고 있었다. 이 정책이 적용되면 그 INSERT 는 거부된다.
--    같은 커밋에서 "세션 있으면 실제 uid, 없으면 NULL" 로 고쳤다.

-- ============================= migrations/20260904120000_area_demand_points_rpc.sql =============================
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

-- ============================= migrations/20260904200000_business_documents_bucket.sql =============================
-- 사업자등록증 증빙 업로드 — 비공개 버킷과 그 접근 규칙.
--
-- 배경: business_verification_requests.document_path 칼럼과, 심사가 끝나면 그 파일을 지우는
-- 코드(app/routers/dev.py _clear_evidence)는 예전부터 있었다. 그런데 **버킷 자체가 없었고,
-- 프런트에 업로드 경로도 없었다.** 즉 신청자는 서류를 낼 방법이 없었고, 심사자는 신청서에
-- 적힌 가게 이름과 facility_id 를 대조할 근거가 없었다(그 facility_id 는 신청자가 본문에
-- 적어 보낸 값이라 아무도 검증하지 않는다).
--
-- 보관 정책은 기존 결정을 그대로 따른다: **확인이 끝나면 보관하지 않는다.** 승인이든 반려든
-- 결정과 같은 호출에서 파일과 사업자번호 뒤 4자리를 지운다(dev.py). 그래서 이 버킷은
-- 장기 보관소가 아니라 심사 대기열의 임시 첨부다.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'business-documents',
    'business-documents',
    false,                                   -- 공개 URL 없음. 심사자는 서명 URL 로만 본다.
    5242880,                                 -- 5MB. 휴대폰으로 찍은 등록증 한 장이면 충분하다.
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 업로드는 **자기 폴더에만**. 경로는 '<uid>/<파일명>' 규약이고 첫 세그먼트를 auth.uid() 와
-- 대조한다. 이게 없으면 로그인한 누구나 남의 uid 폴더에 파일을 올려, 그 사람의 신청서에
-- 붙은 증빙인 것처럼 보이게 만들 수 있다.
DROP POLICY IF EXISTS business_documents_insert_own ON storage.objects;
CREATE POLICY business_documents_insert_own ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'business-documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- 자기가 올린 것만 다시 볼 수 있다(업로드가 됐는지 확인하는 용도).
-- 심사자(developer)는 이 정책으로 보지 않는다 — 백엔드가 service_role 로 서명 URL 을 만든다.
-- service_role 은 RLS 를 우회하므로 별도 정책이 필요 없다.
DROP POLICY IF EXISTS business_documents_select_own ON storage.objects;
CREATE POLICY business_documents_select_own ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'business-documents'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- 지우는 것은 서버만 한다(심사 종료 시 _clear_evidence). 신청자가 임의로 지우면 심사자가
-- 보던 근거가 심사 도중 사라진다 — DELETE 정책을 일부러 두지 않는다.
