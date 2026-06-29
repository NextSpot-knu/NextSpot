-- 0. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- NOTE: auth.users is managed by Supabase and already exists in cloud.
-- The local-only mock block has been removed.

-- 1. users 테이블 (Supabase Auth 확장)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    employee_id VARCHAR(50) NOT NULL UNIQUE,
    company_name VARCHAR(100) NOT NULL,
    preferred_categories JSONB DEFAULT '[]'::jsonb,
    work_shift VARCHAR(20) CHECK (work_shift IN ('morning', 'afternoon', 'night')),
    role VARCHAR(20) DEFAULT 'worker' CHECK (role IN ('worker', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. facilities 테이블 (공용 인프라 POI)
CREATE TABLE IF NOT EXISTS public.facilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL CHECK (type IN ('cafeteria', 'parking', 'meeting_room', 'rest_area')),
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    capacity INT NOT NULL,
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
    source VARCHAR(50) NOT NULL CHECK (source IN ('iot_sensor', 'cctv', 'access_card'))
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
